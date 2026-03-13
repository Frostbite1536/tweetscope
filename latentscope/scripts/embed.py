# Usage: ls-embed <dataset_id> <text_column> <model_id>
import os
import re
import sys
import json
import time
import math
import argparse
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

try:
    # Check if the runtime environment is a Jupyter notebook
    if 'ipykernel' in sys.modules and 'IPython' in sys.modules:
        from tqdm.notebook import tqdm
    else:
        from tqdm import tqdm
except ImportError as e:
    # Fallback to the standard console version if import fails
    from tqdm import tqdm

from collections import defaultdict, deque
from latentscope.models import get_embedding_model
from latentscope.util import get_data_dir
from latentscope.util.text_enrichment import (
    normalize_tweet_id,
    build_reference_text_map,
)


def _prepare_text(text, prefix):
    """Prepare a single text for embedding: handle null/empty, apply prefix."""
    if text is None or text == "":
        text = " "
    return prefix + str(text)


# ---------------------------------------------------------------------------
# Thread grouping for contextual embeddings
# ---------------------------------------------------------------------------

VALID_CONTEXT_TWEET_TYPES = {"tweet", "note_tweet"}


def build_self_thread_groups(df, text_column, prefix="", enriched_text=None):
    """Build thread groups from parquet data for contextual embedding.

    Groups tweets by self-reply threads (user replying to themselves).
    Standalone tweets become single-element groups.

    Args:
        df: DataFrame with tweet data
        text_column: name of the text column
        prefix: optional prefix to prepend to each text
        enriched_text: optional dict[int, str] mapping row_index → enriched text
            (from build_reference_text_map). When provided, uses enriched text
            instead of the raw text column for tweets that have resolvable
            references (quote tweets, linked tweets).

    Returns:
        groups: list of dicts, each with:
            - row_indices: list[int] — DataFrame integer indices for real chunks
            - texts: list[str] — ordered chunk texts (context-only + real)
            - context_count: int — number of leading context-only chunks
        thread_stats: dict with summary statistics
    """
    if enriched_text is None:
        enriched_text = {}

    def _get_text(idx):
        """Get text for a row, using enriched version if available."""
        if idx in enriched_text:
            return _prepare_text(enriched_text[idx], prefix)
        return _prepare_text(df.iloc[idx][text_column], prefix)

    has_thread_cols = (
        "in_reply_to_status_id" in df.columns
        and "username" in df.columns
    )
    if not has_thread_cols:
        # No thread columns — treat every row as standalone
        groups = []
        for idx in range(len(df)):
            text = _get_text(idx)
            groups.append({
                "row_indices": [idx],
                "texts": [text],
                "context_count": 0,
            })
        stats = {
            "total_groups": len(groups),
            "standalone_count": len(groups),
            "multi_tweet_thread_count": 0,
            "threads_with_context_parent": 0,
            "avg_thread_length": 1.0,
            "max_thread_length": 1,
        }
        return groups, stats

    has_tweet_type = "tweet_type" in df.columns
    has_created_at = "created_at" in df.columns

    # 1. Build normalized ID → row index map
    norm_id_to_idx = {}
    for idx in range(len(df)):
        row = df.iloc[idx]
        norm_id = normalize_tweet_id(row.get("id"))
        if norm_id:
            norm_id_to_idx[norm_id] = idx

    # 2. Build self-reply parent map (child_norm_id → parent_norm_id)
    #    Only where the parent's username matches the child's username
    self_reply_parent = {}  # child_norm_id → parent_norm_id
    for idx in range(len(df)):
        row = df.iloc[idx]
        parent_raw = row.get("in_reply_to_status_id")
        parent_norm = normalize_tweet_id(parent_raw)
        if not parent_norm:
            continue
        if parent_norm not in norm_id_to_idx:
            continue
        # Check if same user (case-insensitive)
        child_username = str(row.get("username", "")).strip().lower()
        parent_idx = norm_id_to_idx[parent_norm]
        parent_username = str(df.iloc[parent_idx].get("username", "")).strip().lower()
        if child_username and child_username == parent_username:
            child_norm = normalize_tweet_id(row.get("id"))
            if child_norm:
                self_reply_parent[child_norm] = parent_norm

    # 3. Build children map (parent_norm_id → [child_norm_ids])
    children_map = defaultdict(list)
    for child, parent in self_reply_parent.items():
        children_map[parent].append(child)

    # 4. Find thread roots: tweets that appear as parents but are not children
    #    in the self-reply map, OR tweets that have children
    all_children = set(self_reply_parent.keys())
    all_parents = set(self_reply_parent.values())
    thread_roots = all_parents - all_children  # parents that are not children of anyone

    # 5. Walk from each root, collecting thread members
    assigned = set()  # norm_ids already assigned to a thread
    threads = []  # list of (norm_ids_in_order, root_norm_id)

    def _walk_thread(root_norm_id):
        """DFS walk collecting all descendants via self-reply edges."""
        members = [root_norm_id]
        stack = [root_norm_id]
        while stack:
            current = stack.pop()
            for child in children_map.get(current, []):
                if child not in assigned:
                    members.append(child)
                    stack.append(child)
        return members

    for root in sorted(thread_roots):  # sorted for determinism
        if root in assigned:
            continue
        members = _walk_thread(root)
        for m in members:
            assigned.add(m)
        threads.append((members, root))

    # 6. Build groups
    groups = []
    standalone_count = 0
    context_parent_count = 0
    thread_lengths = []

    for members, root_norm_id in threads:
        # Get row indices and sort by created_at
        member_indices = []
        for m in members:
            if m in norm_id_to_idx:
                member_indices.append((m, norm_id_to_idx[m]))
        if not member_indices:
            continue

        # Sort by created_at if available, otherwise by row index
        if has_created_at:
            member_indices.sort(key=lambda x: (
                str(df.iloc[x[1]].get("created_at", "")), x[1]
            ))
        else:
            member_indices.sort(key=lambda x: x[1])

        row_indices = [idx for _, idx in member_indices]
        texts = [_get_text(idx) for idx in row_indices]
        context_count = 0

        # Check if thread root is a reply to someone else's tweet in dataset
        root_idx = norm_id_to_idx.get(root_norm_id)
        if root_idx is not None:
            root_row = df.iloc[root_idx]
            root_parent_norm = normalize_tweet_id(root_row.get("in_reply_to_status_id"))
            if root_parent_norm and root_parent_norm not in self_reply_parent.get(root_norm_id, ""):
                # Root is a reply to someone else
                if root_parent_norm in norm_id_to_idx:
                    ctx_idx = norm_id_to_idx[root_parent_norm]
                    ctx_row = df.iloc[ctx_idx]
                    # Only use as context if it's a real tweet (not a like)
                    ctx_type = str(ctx_row.get("tweet_type", "tweet")).lower() if has_tweet_type else "tweet"
                    if ctx_type in VALID_CONTEXT_TWEET_TYPES:
                        ctx_text = _prepare_text(ctx_row[text_column], prefix)
                        texts.insert(0, ctx_text)
                        context_count = 1
                        context_parent_count += 1

        groups.append({
            "row_indices": row_indices,
            "texts": texts,
            "context_count": context_count,
        })
        thread_lengths.append(len(row_indices))

    # 7. Add standalone tweets (not in any thread)
    for idx in range(len(df)):
        norm_id = normalize_tweet_id(df.iloc[idx].get("id"))
        if norm_id and norm_id not in assigned:
            text = _get_text(idx)
            groups.append({
                "row_indices": [idx],
                "texts": [text],
                "context_count": 0,
            })
            standalone_count += 1
            thread_lengths.append(1)

    stats = {
        "total_groups": len(groups),
        "standalone_count": standalone_count,
        "multi_tweet_thread_count": sum(1 for l in thread_lengths if l > 1),
        "threads_with_context_parent": context_parent_count,
        "avg_thread_length": round(sum(thread_lengths) / max(len(thread_lengths), 1), 2),
        "max_thread_length": max(thread_lengths) if thread_lengths else 0,
    }

    return groups, stats


def batch_thread_groups(groups, tokenizer, params):
    """Pack thread groups into API-call-sized batches respecting Voyage limits.

    Returns:
        list of list of ThreadGroup dicts (each inner list = one API call)
    """
    def _int_env_override(name, default):
        raw = os.getenv(name)
        if raw in (None, ""):
            return int(default)
        try:
            return int(raw)
        except (TypeError, ValueError):
            print(f"Warning: invalid env override {name}={raw}, falling back")
            return int(default)

    max_groups = _int_env_override(
        "LS_EMBED_MAX_INPUTS_PER_BATCH",
        params.get("max_inputs_per_batch", 1000),
    )
    max_tokens = _int_env_override(
        "LS_EMBED_MAX_TOTAL_TOKENS",
        params.get("max_total_tokens", 120000),
    )
    max_chunks = _int_env_override(
        "LS_EMBED_MAX_TOTAL_CHUNKS",
        params.get("max_total_chunks", 16000),
    )
    max_tokens_per_group = _int_env_override(
        "LS_EMBED_MAX_TOKENS_PER_GROUP",
        params.get("max_tokens_per_group", 32000),
    )

    # Pre-compute token counts for each group
    for g in groups:
        group_tokens = 0
        for text in g["texts"]:
            group_tokens += len(tokenizer.encode(text).ids)
        g["_total_tokens"] = group_tokens
        g["_chunk_count"] = len(g["texts"])

        # Handle oversized groups: truncate context-only prefix if needed
        if g["_total_tokens"] > max_tokens_per_group and g["context_count"] > 0:
            # Drop context-only chunks to fit
            while g["context_count"] > 0 and g["_total_tokens"] > max_tokens_per_group:
                dropped_text = g["texts"].pop(0)
                dropped_tokens = len(tokenizer.encode(dropped_text).ids)
                g["_total_tokens"] -= dropped_tokens
                g["_chunk_count"] -= 1
                g["context_count"] -= 1
                print(f"  Warning: dropped context chunk ({dropped_tokens} tokens) from oversized group")

        # If still oversized after dropping context, log warning
        # (extremely rare — would need a single thread >100 tweets)
        if g["_total_tokens"] > max_tokens_per_group:
            print(f"  Warning: group with {g['_chunk_count']} chunks has {g['_total_tokens']} tokens (limit {max_tokens_per_group})")

    # Greedy bin-packing
    batches = []
    current_batch = []
    batch_tokens = 0
    batch_chunks = 0

    for g in groups:
        would_exceed = (
            len(current_batch) >= max_groups
            or batch_tokens + g["_total_tokens"] > max_tokens
            or batch_chunks + g["_chunk_count"] > max_chunks
        )
        if would_exceed and current_batch:
            batches.append(current_batch)
            current_batch = []
            batch_tokens = 0
            batch_chunks = 0

        current_batch.append(g)
        batch_tokens += g["_total_tokens"]
        batch_chunks += g["_chunk_count"]

    if current_batch:
        batches.append(current_batch)

    return batches


def _param_with_env_override(params, param_key, env_key, default, cast):
    raw_env = os.getenv(env_key)
    if raw_env not in (None, ""):
        try:
            return cast(raw_env)
        except (TypeError, ValueError):
            print(f"Warning: invalid env override {env_key}={raw_env}, falling back")
    raw_param = params.get(param_key, default)
    try:
        return cast(raw_param)
    except (TypeError, ValueError):
        return default


def _contextual_batch_token_count(batch_groups):
    total = 0
    for group in batch_groups:
        total += max(1, int(group.get("_total_tokens", 0) or 0))
    return total


class SlidingWindowRateLimiter:
    """Shared 60-second window limiter for request and token budgets."""

    def __init__(self, requests_per_minute=0, tokens_per_minute=0, headroom=0.9):
        factor = max(0.1, min(1.0, float(headroom)))
        self.requests_per_minute = int(max(0, requests_per_minute) * factor)
        self.tokens_per_minute = int(max(0, tokens_per_minute) * factor)
        self.request_times = deque()
        self.token_events = deque()
        self.token_sum = 0
        self._warned_oversized = False

    def _evict(self, now):
        cutoff = now - 60.0
        while self.request_times and self.request_times[0] <= cutoff:
            self.request_times.popleft()
        while self.token_events and self.token_events[0][0] <= cutoff:
            _, tok = self.token_events.popleft()
            self.token_sum -= tok

    def acquire(self, token_cost):
        token_cost = max(1, int(token_cost or 1))
        if self.tokens_per_minute > 0 and token_cost > self.tokens_per_minute:
            if not self._warned_oversized:
                print(
                    f"Warning: single request token estimate {token_cost} exceeds "
                    f"effective TPM window {self.tokens_per_minute}; allowing request."
                )
                self._warned_oversized = True
            token_cost = self.tokens_per_minute

        while True:
            now = time.monotonic()
            self._evict(now)

            req_ok = (
                self.requests_per_minute <= 0
                or len(self.request_times) < self.requests_per_minute
            )
            tok_ok = (
                self.tokens_per_minute <= 0
                or (self.token_sum + token_cost) <= self.tokens_per_minute
            )

            if req_ok and tok_ok:
                if self.requests_per_minute > 0:
                    self.request_times.append(now)
                if self.tokens_per_minute > 0:
                    self.token_events.append((now, token_cost))
                    self.token_sum += token_cost
                return

            waits = []
            if self.requests_per_minute > 0 and not req_ok and self.request_times:
                waits.append((self.request_times[0] + 60.0) - now)
            if self.tokens_per_minute > 0 and not tok_ok and self.token_events:
                overflow = (self.token_sum + token_cost) - self.tokens_per_minute
                running = 0
                for ts, tok in self.token_events:
                    running += tok
                    if running >= overflow:
                        waits.append((ts + 60.0) - now)
                        break
            sleep_s = max(0.01, min(1.0, max(waits) if waits else 0.05))
            time.sleep(sleep_s)


def _scatter_contextual_batch_embeddings(batch_groups, batch_results, all_embeddings, filled):
    if len(batch_groups) != len(batch_results):
        raise ValueError(
            f"Contextual batch result count mismatch: "
            f"{len(batch_results)} != {len(batch_groups)}"
        )
    for group, group_embeddings in zip(batch_groups, batch_results):
        cc = int(group["context_count"])
        real_embeddings = group_embeddings[cc:]
        if len(real_embeddings) != len(group["row_indices"]):
            raise ValueError(
                f"Contextual scatter mismatch for group: "
                f"{len(real_embeddings)} embeddings vs {len(group['row_indices'])} rows"
            )
        for emb, row_idx in zip(real_embeddings, group["row_indices"]):
            all_embeddings[row_idx] = emb
            filled[row_idx] = True


def _write_partial_contextual_checkpoint(path, all_embeddings, filled):
    import h5py
    with h5py.File(path, "w") as f:
        f.create_dataset("embeddings", data=all_embeddings)
        f.create_dataset("filled", data=filled)


def _save_contextual_progress(progress_path, batch_idx, config_hash):
    """Save checkpoint for contextual embedding progress."""
    with open(progress_path, 'w') as f:
        json.dump({
            "last_completed_batch": batch_idx,
            "config_hash": config_hash,
        }, f)


def _load_contextual_progress(progress_path, config_hash):
    """Load checkpoint. Returns starting_batch or 0 if no valid checkpoint."""
    if not os.path.exists(progress_path):
        return 0
    try:
        with open(progress_path, 'r') as f:
            data = json.load(f)
        if data.get("config_hash") != config_hash:
            print("  Config changed since last checkpoint, starting from scratch")
            return 0
        return data.get("last_completed_batch", 0)
    except (json.JSONDecodeError, KeyError):
        return 0


def _compute_config_hash(model_id, text_column, n_rows, n_groups):
    """Deterministic hash of embedding config for checkpoint validation."""
    import hashlib
    key = f"{model_id}|{text_column}|{n_rows}|{n_groups}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def _embed_contextual_batches_parallel(
    *,
    batches,
    model,
    dimensions,
    starting_batch,
    all_embeddings,
    filled,
    progress_path,
    config_hash,
    partial_path,
):
    total_batches = len(batches)
    if starting_batch >= total_batches:
        return

    max_parallel = _param_with_env_override(
        model.params,
        "max_parallel_requests",
        "LS_EMBED_MAX_PARALLEL_REQUESTS",
        1,
        int,
    )
    checkpoint_every = _param_with_env_override(
        model.params,
        "checkpoint_every_batches",
        "LS_EMBED_CHECKPOINT_EVERY_BATCHES",
        8,
        int,
    )
    target_rpm = _param_with_env_override(
        model.params,
        "target_rpm",
        "LS_EMBED_TARGET_RPM",
        0,
        int,
    )
    target_tpm = _param_with_env_override(
        model.params,
        "target_tpm",
        "LS_EMBED_TARGET_TPM",
        0,
        int,
    )
    headroom = _param_with_env_override(
        model.params,
        "rate_limit_headroom",
        "LS_EMBED_RATE_LIMIT_HEADROOM",
        0.9,
        float,
    )
    max_parallel = max(1, max_parallel)
    checkpoint_every = max(1, checkpoint_every)

    limiter = SlidingWindowRateLimiter(
        requests_per_minute=target_rpm,
        tokens_per_minute=target_tpm,
        headroom=headroom,
    )
    batch_token_estimates = [_contextual_batch_token_count(b) for b in batches]

    if target_rpm > 0 or target_tpm > 0:
        print(
            "  Contextual parallelism:",
            f"workers={max_parallel}, rpm={target_rpm}, tpm={target_tpm}, headroom={headroom}",
        )
    else:
        print(f"  Contextual parallelism: workers={max_parallel}, no explicit rpm/tpm caps")

    completed = [i < starting_batch for i in range(total_batches)]
    contiguous_completed = starting_batch
    completed_since_checkpoint = 0
    remaining = total_batches - starting_batch

    def _submit(executor, batch_idx):
        limiter.acquire(batch_token_estimates[batch_idx])
        api_inputs = [g["texts"] for g in batches[batch_idx]]
        return executor.submit(model.embed_contextual, api_inputs, dimensions=dimensions)

    with ThreadPoolExecutor(max_workers=max_parallel) as executor:
        inflight = {}
        next_batch_idx = starting_batch

        with tqdm(total=remaining) as progress:
            while next_batch_idx < total_batches and len(inflight) < max_parallel:
                fut = _submit(executor, next_batch_idx)
                inflight[fut] = next_batch_idx
                next_batch_idx += 1

            while inflight:
                done, _ = wait(list(inflight.keys()), return_when=FIRST_COMPLETED)
                for fut in done:
                    batch_idx = inflight.pop(fut)
                    results = fut.result()
                    _scatter_contextual_batch_embeddings(
                        batches[batch_idx],
                        results,
                        all_embeddings,
                        filled,
                    )
                    completed[batch_idx] = True
                    completed_since_checkpoint += 1
                    progress.update(1)

                    while (
                        contiguous_completed < total_batches
                        and completed[contiguous_completed]
                    ):
                        contiguous_completed += 1

                    if (
                        completed_since_checkpoint >= checkpoint_every
                        or contiguous_completed == total_batches
                    ):
                        _save_contextual_progress(
                            progress_path,
                            contiguous_completed,
                            config_hash,
                        )
                        _write_partial_contextual_checkpoint(
                            partial_path,
                            all_embeddings,
                            filled,
                        )
                        completed_since_checkpoint = 0

                while next_batch_idx < total_batches and len(inflight) < max_parallel:
                    fut = _submit(executor, next_batch_idx)
                    inflight[fut] = next_batch_idx
                    next_batch_idx += 1


def chunked_iterable(iterable, size):
    """Yield successive chunks from an iterable."""
    for i in range(0, len(iterable), size):
        yield iterable[i:i + size]

def append_to_hdf5(file_path, new_data):
    import h5py
    dataset_name = "embeddings"
    with h5py.File(file_path, 'a') as f:
        if dataset_name in f:
            dataset = f[dataset_name]
            dataset.resize((dataset.shape[0] + new_data.shape[0],) + dataset.shape[1:])
            dataset[-new_data.shape[0]:] = new_data
        else:
            maxshape = (None,) + new_data.shape[1:]
            dataset = f.create_dataset(dataset_name, data=new_data, maxshape=maxshape, chunks=True)

def get_last_batch(file_path):
    import h5py
    try:
        with h5py.File(file_path, 'r') as f:
            dataset = f["embeddings"]
            return dataset.shape[0]
    except FileNotFoundError:
        return 0


def get_hdf5_embedding_stats(file_path):
    """Compute shape/min/max across the full embeddings dataset (chunked)."""
    import h5py
    import numpy as np

    with h5py.File(file_path, "r") as f:
        ds = f["embeddings"]
        n_rows, n_dims = ds.shape
        if n_rows == 0:
            raise ValueError(f"Embeddings dataset is empty in {file_path}")

        chunk_rows = max(1, min(8192, n_rows))
        min_values = None
        max_values = None
        for start in range(0, n_rows, chunk_rows):
            chunk = np.asarray(ds[start:start + chunk_rows], dtype=np.float32)
            chunk_min = np.min(chunk, axis=0)
            chunk_max = np.max(chunk, axis=0)
            if min_values is None:
                min_values = chunk_min
                max_values = chunk_max
            else:
                min_values = np.minimum(min_values, chunk_min)
                max_values = np.maximum(max_values, chunk_max)

    return (n_rows, n_dims), min_values, max_values


def main():
    parser = argparse.ArgumentParser(description='Embed a dataset')
    parser.add_argument('dataset_id', type=str, help='Dataset id (directory name in data/)')
    parser.add_argument('text_column', type=str, help='Output file', default='text')
    parser.add_argument('model_id', type=str, help='ID of embedding model to use', default="voyage-context-3")
    parser.add_argument('--prefix', type=str, help='Prefix to prepend to text before embedding', default="")
    parser.add_argument('--dimensions', type=int, help='Truncate embeddings to dimensions a la Matroyshka embeddings')
    parser.add_argument('--rerun', type=str, help='Rerun the given embedding from last completed batch')
    parser.add_argument('--batch_size', type=int, help='Set the batch size (number of sentences to embed in one call)', default=100)
    parser.add_argument('--max_seq_length', type=int, help='Set the max sequence length for the model', default=None)

    # Parse arguments
    args = parser.parse_args()
    embed(args.dataset_id, args.text_column, args.model_id, args.prefix, args.rerun, args.dimensions, args.batch_size, args.max_seq_length)

def embed(dataset_id, text_column, model_id, prefix, rerun, dimensions, batch_size=100, max_seq_length=None):
    import pandas as pd
    import numpy as np
    DATA_DIR = get_data_dir()
    df = pd.read_parquet(os.path.join(DATA_DIR, dataset_id, "input.parquet"))
    
    embedding_dir = os.path.join(DATA_DIR, dataset_id, "embeddings")
    if not os.path.exists(embedding_dir):
        os.makedirs(embedding_dir)
    # determine the embedding id
    if rerun is not None:
        embedding_id = rerun
        starting_batch = get_last_batch(os.path.join(embedding_dir, f"{embedding_id}.h5")) // batch_size
    else:
        # determine the index of the last umap run by looking in the dataset directory
        # for files named umap-<number>.json
        embedding_files = [f for f in os.listdir(embedding_dir) if re.match(r"embedding-\d+\.h5", f)]
        if len(embedding_files) > 0:
            last_umap = sorted(embedding_files)[-1]
            last_embedding_number = int(last_umap.split("-")[1].split(".")[0])
            next_embedding_number = last_embedding_number + 1
        else:
            next_embedding_number = 1
        # make the umap name from the number, zero padded to 3 digits
        embedding_id = f"embedding-{next_embedding_number:03d}"
        starting_batch = 0

    print("RUNNING:", embedding_id)
    print("MODEL ID", model_id)
    model = get_embedding_model(model_id)
    resolved_model_id = getattr(model, "model_id", model_id)
    if resolved_model_id != model_id:
        print(f"Resolved model alias '{model_id}' -> '{resolved_model_id}'")
    print("MODEL", model)
    print("loading", model.name)
    model.load_model()

    if max_seq_length is not None and hasattr(model, 'model') and hasattr(model.model, 'max_seq_length'):
        try:
            model.model.max_seq_length = max_seq_length
        except AttributeError:
            print("Warning: This model does not support setting max_seq_length. Continuing with default length.")
        # else:
        #     print("Warning: max_seq_length is not a settable property, setting may not work")
        #     model.model.max_seq_length = max_seq_length

    if prefix is None:
        prefix = ""

    embedding_path = os.path.join(embedding_dir, f"{embedding_id}.h5")

    # --- CONTEXTUAL PATH: group tweets by thread ---
    if hasattr(model, 'embed_contextual'):
        # Build reference text enrichment (quote tweets, linked tweets)
        print("Building reference text enrichment map...")
        enriched_text, enrich_stats = build_reference_text_map(df, text_column)
        if enrich_stats["enriched_count"] > 0:
            print(f"  {enrich_stats['enriched_count']} tweets enriched with "
                  f"{enrich_stats['total_references_resolved']} resolved references")
        else:
            print("  No resolvable tweet references found")

        print("Building self-thread groups for contextual embedding...")
        groups, thread_stats = build_self_thread_groups(df, text_column, prefix, enriched_text=enriched_text)
        print(f"  {thread_stats['total_groups']} groups: "
              f"{thread_stats['multi_tweet_thread_count']} threads, "
              f"{thread_stats['standalone_count']} standalone, "
              f"avg len {thread_stats['avg_thread_length']}, "
              f"max len {thread_stats['max_thread_length']}")
        if thread_stats['threads_with_context_parent'] > 0:
            print(f"  {thread_stats['threads_with_context_parent']} threads with external parent context")

        print("Batching groups for API calls...")
        batches = batch_thread_groups(groups, model.encoder, model.params)
        total_batches = len(batches)
        print(f"  {total_batches} API batches")

        # Resume support for contextual path
        dim = dimensions or model.params.get("default_output_dimension", 1024)
        config_hash = _compute_config_hash(resolved_model_id, text_column, len(df), len(groups))
        progress_path = os.path.join(embedding_dir, f"{embedding_id}-progress.json")
        partial_path = os.path.join(embedding_dir, f"{embedding_id}-partial.h5")

        if rerun is not None:
            starting_batch = _load_contextual_progress(progress_path, config_hash)
            print(f"  Resuming from batch {starting_batch}/{total_batches}")

        # Pre-allocate or load partial results
        import h5py
        if starting_batch > 0 and os.path.exists(partial_path):
            with h5py.File(partial_path, 'r') as f:
                all_embeddings = np.array(f["embeddings"], dtype=np.float32)
                filled = np.array(f["filled"], dtype=bool)
            print(f"  Loaded {np.sum(filled)} partial embeddings from checkpoint")
        else:
            all_embeddings = np.zeros((len(df), dim), dtype=np.float32)
            filled = np.zeros(len(df), dtype=bool)

        print(f"Embedding {len(df)} rows in {total_batches} contextual batches...")
        try:
            _embed_contextual_batches_parallel(
                batches=batches,
                model=model,
                dimensions=dimensions,
                starting_batch=starting_batch,
                all_embeddings=all_embeddings,
                filled=filled,
                progress_path=progress_path,
                config_hash=config_hash,
                partial_path=partial_path,
            )
        except Exception as e:
            try:
                _write_partial_contextual_checkpoint(partial_path, all_embeddings, filled)
                completed_rows = int(np.sum(filled))
                print(f"  Saved partial checkpoint ({completed_rows}/{len(df)} rows)")
            except Exception:
                pass
            print(f"Error in contextual embedding: {e}")
            print(f"  Rerun with --rerun {embedding_id}")
            sys.exit(1)

        # Verify all rows filled
        unfilled_count = int(np.sum(~filled))
        if unfilled_count > 0:
            print(f"WARNING: {unfilled_count} rows have no embedding!")

        # Write final HDF5
        append_to_hdf5(embedding_path, all_embeddings)

        # Cleanup checkpoint files
        for tmp in [progress_path, partial_path]:
            if os.path.exists(tmp):
                os.remove(tmp)

        # Write metadata with thread stats
        (n_rows, n_dims), min_values, max_values = get_hdf5_embedding_stats(embedding_path)
        with open(os.path.join(embedding_dir, f"{embedding_id}.json"), 'w') as f:
            json.dump({
                "id": embedding_id,
                "model_id": resolved_model_id,
                "dataset_id": dataset_id,
                "text_column": text_column,
                "rows": n_rows,
                "dimensions": n_dims,
                "max_seq_length": max_seq_length,
                "prefix": prefix,
                "contextual": True,
                "thread_stats": thread_stats,
                "enrichment_stats": enrich_stats,
                "min_values": min_values.tolist(),
                "max_values": max_values.tolist(),
            }, f, indent=2)

    else:
        # --- FLAT PATH ---
        # Build reference text enrichment (quote tweets, linked tweets)
        print("Building reference text enrichment map...")
        enriched_text, enrich_stats = build_reference_text_map(df, text_column)
        if enrich_stats["enriched_count"] > 0:
            print(f"  {enrich_stats['enriched_count']} tweets enriched with "
                  f"{enrich_stats['total_references_resolved']} resolved references")

        print("Checking for empty inputs")
        sentences = df[text_column].tolist()
        prefixed = []
        for i, s in enumerate(sentences):
            # Use enriched text if available for this row
            if i in enriched_text:
                s = enriched_text[i]
            if s is None or s == "":
                print(i, s, "text is empty, adding a [space]")
                s = " "
            prefixed.append(prefix + s)
        sentences = prefixed

        total_batches = math.ceil(len(sentences) / batch_size) if batch_size > 0 else 0

        print("embedding", len(sentences), "sentences", "in", total_batches, "batches")
        if starting_batch > 0:
            print("Rerunning starting at batch", starting_batch)

        for i, batch in enumerate(tqdm(chunked_iterable(sentences, batch_size), total=total_batches)):
            if i < starting_batch:
                print(f"skipping batch {i}/{total_batches}", flush=True)
                continue
            try:
                embeddings = np.array(model.embed(batch, dimensions=dimensions), dtype=np.float32)
                append_to_hdf5(embedding_path, embeddings)
            except Exception as e:
                print(batch)
                print("error embedding batch", i, e)
                print("exiting prematurely", embedding_id)
                df_batch = df.iloc[i*batch_size:(i+1)*batch_size].copy()
                df_batch["_ls_text_"] = batch
                batch_path = os.path.join(embedding_dir, f"{embedding_id}-batch-{i}.parquet")
                df_batch.to_parquet(batch_path)
                print("wrote original data for batch along with processed inputs in _ls_sentences_ column to\n", batch_path)
                print("debug with command:")
                print("ls-embed-debug", batch_path, model_id)
                sys.exit(1)

        # Write metadata
        (n_rows, n_dims), min_values, max_values = get_hdf5_embedding_stats(embedding_path)
        with open(os.path.join(embedding_dir, f"{embedding_id}.json"), 'w') as f:
            json.dump({
                "id": embedding_id,
                "model_id": resolved_model_id,
                "dataset_id": dataset_id,
                "text_column": text_column,
                "rows": n_rows,
                "dimensions": n_dims,
                "max_seq_length": max_seq_length,
                "prefix": prefix,
                "min_values": min_values.tolist(),
                "max_values": max_values.tolist(),
            }, f, indent=2)

    # Track history of model_id used
    history_file_path = os.path.join(DATA_DIR, "embedding_model_history.csv")
    try:
        with open(history_file_path, 'a') as history_file:
            history_file.write(f"{datetime.now().isoformat()},{resolved_model_id}\n")
    except FileNotFoundError:
        with open(history_file_path, 'w') as history_file:
            history_file.write(f"{datetime.now().isoformat()},{resolved_model_id}\n")

    print("done with", embedding_id)

def truncate():
    parser = argparse.ArgumentParser(description='Make a copy of an existing embedding truncated to a smaller number of dimensions')
    parser.add_argument('dataset_id', type=str, help='Dataset id (directory name in data/)')
    parser.add_argument('embedding_id', type=str, help='ID of embedding to use') 
    parser.add_argument('dimensions', type=int, help='Number of dimensions to truncate to') 
    args = parser.parse_args()
    embed_truncate(args.dataset_id, args.embedding_id, args.dimensions)

def embed_truncate(dataset_id, embedding_id, dimensions):
    import numpy as np
    import h5py

    DATA_DIR = get_data_dir()
    embedding_dir = os.path.join(DATA_DIR, dataset_id, "embeddings")

    embedding_meta_path = os.path.join(embedding_dir, f"{embedding_id}.json")
    with open(embedding_meta_path, 'r') as f:
        embedding_meta = json.load(f)
    # Load the embedding model
    # model_id = embedding_meta["model_id"]
    # model = get_embedding_model_dict(model_id)
    # print("model params", model["params"])
    # Check if the model has the attribute 'dimensions'
    # try:
    #     dims = model["params"]['dimensions']
    # except KeyError:
    #     raise KeyError(f"The model {model_id} does not have the 'dimensions' parameter meaning it cannot be truncated.")

    # determine the index of the last umap run by looking in the dataset directory
    # for files named umap-<number>.json
    embedding_files = [f for f in os.listdir(embedding_dir) if re.match(r"embedding-\d+\.h5", f)]
    if len(embedding_files) > 0:
        last_umap = sorted(embedding_files)[-1]
        last_embedding_number = int(last_umap.split("-")[1].split(".")[0])
        next_embedding_number = last_embedding_number + 1
    else:
        next_embedding_number = 1
    # make the umap name from the number, zero padded to 3 digits
    new_embedding_id = f"embedding-{next_embedding_number:03d}"
    print("RUNNING:", new_embedding_id)

    # read in the embeddings from embedding_id
    embedding_path = os.path.join(embedding_dir, f"{embedding_id}.h5")
    with h5py.File(embedding_path, 'r') as f:
        dataset = f["embeddings"]
        embeddings = np.array(dataset)
   

    print("truncating to", dimensions, "dimensions")
    matroyshka = embeddings[:, :dimensions].astype(np.float32)
    # Normalize the truncated embeddings
    matroyshka = matroyshka / np.linalg.norm(matroyshka, axis=1, keepdims=True)
    append_to_hdf5(os.path.join(embedding_dir, f"{new_embedding_id}.h5"), matroyshka)


    # Calculate min and max values for each index
    min_values = np.min(matroyshka, axis=0)
    max_values = np.max(matroyshka, axis=0)
    
    with open(os.path.join(embedding_dir, f"{new_embedding_id}.json"), 'w') as f:
        json.dump({
            "id": new_embedding_id,
            "model_id": embedding_meta["model_id"],
            "dataset_id": dataset_id,
            "text_column": embedding_meta["text_column"],
            "max_seq_length": embedding_meta.get("max_seq_length"),
            "dimensions": matroyshka.shape[1],
            "prefix": embedding_meta["prefix"],
            # "min_values": min_values.tolist(),
            # "max_values": max_values.tolist(),
            }, f, indent=2)

    print("wrote", os.path.join(embedding_dir, f"{new_embedding_id}.h5"))
    print("done")


def update_embedding_stats():
    parser = argparse.ArgumentParser(description='Update embedding stats') 
    parser.add_argument('dataset_id', type=str, help='Dataset id (directory name in data/)')
    parser.add_argument('embedding_id', type=str, help='ID of embedding to use') 
    args = parser.parse_args()
    embedding_stats(args.dataset_id, args.embedding_id)

def embedding_stats(dataset_id, embedding_id):
    import os
    import h5py
    import numpy as np
    # from latentscope.utils import get_data_dir

    DATA_DIR = get_data_dir()
    embedding_dir = os.path.join(DATA_DIR, dataset_id, "embeddings")
    embedding_path = os.path.join(embedding_dir, f"{embedding_id}.h5")

    # Read the embeddings
    with h5py.File(embedding_path, 'r') as f:
        embeddings = np.array(f["embeddings"])

    # Calculate min and max values for each index
    min_values = np.min(embeddings, axis=0)
    max_values = np.max(embeddings, axis=0)

    metadata_path = os.path.join(embedding_dir, f"{embedding_id}.json")
    # Read existing metadata
    with open(metadata_path, 'r') as f:
        metadata = json.load(f)

    # Add min and max values to metadata
    metadata['min_values'] = min_values.tolist()
    metadata['max_values'] = max_values.tolist()

    # Write updated metadata back to file
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"Updated metadata for {embedding_id} with min and max values")


def debug():
    parser = argparse.ArgumentParser(description='Debug embedding a batch')
    parser.add_argument('parquet_file', type=str, help='Parquet file output by embed process')
    parser.add_argument('model_id', type=str, help='ID of embedding model to use')
    parser.add_argument('--text_column', type=str, help='Column name for text data', default="_ls_text_")
    args = parser.parse_args()
    embed_debug(args.parquet_file, args.model_id, args.text_column)

def embed_debug(parquet_file, model_id, text_column):
    import pandas as pd
    df = pd.read_parquet(parquet_file)
    model = get_embedding_model(model_id)
    print("loading", model.name)
    model.load_model()

    for i,row in enumerate(df.iterrows()):
        print("batch index:", i)
        print("original index:", row[0])
        text = row[1][text_column]
        print("text:", text)
        # print("tokens:", len(model.tokenizer.encode(text)))
        # print("batch index:", i, "DataFrame index:", row[0], "Text:", row[1][text_column])
        embedding = model.embed([text])
        print("embedding", embedding)
        
def importer():
    import pandas as pd
    import numpy as np

    parser = argparse.ArgumentParser(description='Import embeddings from an input dataset column to a standard HDF5 file')
    parser.add_argument('dataset_id', type=str, help='Dataset id (directory name in data/)')
    parser.add_argument('embedding_column', type=str, help='Column to use as embedding input')
    parser.add_argument('model_id', type=str, help='ID of embedding to use')
    parser.add_argument('text_column', type=str, help='Column used to create embeddings')
    args = parser.parse_args()

    DATA_DIR = get_data_dir()
    # read the input parquet
    df = pd.read_parquet(os.path.join(DATA_DIR, args.dataset_id, "input.parquet"))
    # extract the column 
    embeddings = df[args.embedding_column].to_numpy()
    # Ensure embeddings is an ndarray with shape [N, M]
    if not isinstance(embeddings, np.ndarray):
        embeddings = np.array(list(embeddings))
    if embeddings.ndim == 1:
        embeddings = np.stack(embeddings)
    embeddings = embeddings.astype(np.float32)
    

    import_embeddings(args.dataset_id, embeddings, args.model_id, args.text_column)

def import_embeddings(dataset_id, embeddings, model_id="", text_column="", prefix=""):
    import numpy as np
    DATA_DIR = get_data_dir()
    embedding_dir = os.path.join(DATA_DIR, dataset_id, "embeddings")
    # determine the index of the last umap run by looking in the dataset directory
    # for files named umap-<number>.json
    embedding_files = [f for f in os.listdir(embedding_dir) if re.match(r"embedding-\d+\.h5", f)]
    if len(embedding_files) > 0:
        last_umap = sorted(embedding_files)[-1]
        last_embedding_number = int(last_umap.split("-")[1].split(".")[0])
        next_embedding_number = last_embedding_number + 1
    else:
        next_embedding_number = 1
    # make the umap name from the number, zero padded to 3 digits
    embedding_id = f"embedding-{next_embedding_number:03d}"

    print("importing embeddings with shape", embeddings.shape, "to", os.path.join(embedding_dir, f"{embedding_id}.h5"))
    append_to_hdf5(os.path.join(embedding_dir, f"{embedding_id}.h5"), embeddings)

    # Calculate min and max values for each index
    min_values = np.min(embeddings, axis=0)
    max_values = np.max(embeddings, axis=0)

    with open(os.path.join(embedding_dir, f"{embedding_id}.json"), 'w') as f:
        json.dump({
            "id": embedding_id,
            "model_id": model_id,
            "dataset_id": dataset_id,
            "dimensions": embeddings.shape[1],
            "text_column": text_column,
            "prefix": prefix,
            "min_values": min_values.tolist(),
            "max_values": max_values.tolist(),
        }, f, indent=2)
    print("done with", embedding_id)

if __name__ == "__main__":
   main() 
