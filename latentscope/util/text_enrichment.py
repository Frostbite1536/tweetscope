"""Shared text enrichment utilities for tweet reference resolution and thread context.

Used by both the embedding pipeline (embed.py) and the labeling pipeline
(toponymy_labels.py) to enrich tweet text with referenced tweet content
(quote tweets, linked tweets) found via status URLs in the urls_json column.

Import-time enrichment (t.co expansion, HTML entity decoding) happens
earlier in twitter.py and is already baked into input.parquet.
"""

import re
import json
from collections import defaultdict

VALID_CONTEXT_TWEET_TYPES = frozenset({"tweet", "note_tweet"})

_NULL_SENTINELS = frozenset({"none", "null", "nan", "<na>", ""})

_STATUS_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:x\.com|twitter\.com)/(?:i/web/)?(?:[A-Za-z0-9_]+/)?status/(?P<tweet_id>\d+)",
    re.IGNORECASE,
)


def normalize_tweet_id(value):
    """Normalize tweet ID: strip trailing .0, handle null sentinels."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in _NULL_SENTINELS:
        return None
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text


def _parse_urls_json(value):
    """Parse urls_json column into list of URL strings."""
    if value is None:
        return []
    raw = value
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return []
    else:
        parsed = raw
    if not isinstance(parsed, list):
        return []
    urls = []
    for item in parsed:
        if isinstance(item, str):
            urls.append(item)
        elif isinstance(item, dict):
            url = item.get("expanded_url") or item.get("url") or ""
            if url:
                urls.append(str(url))
    return urls


def _extract_status_id(url):
    """Extract tweet ID from a twitter.com/x.com status URL."""
    match = _STATUS_URL_RE.search(str(url))
    if not match:
        return None
    return match.group("tweet_id")


def build_reference_text_map(df, text_column):
    """Build a map from row index to enriched text with referenced tweet content.

    For each tweet, finds referenced tweets (via urls_json status URLs) that exist
    in the dataset, and prepends their text. This gives downstream consumers context
    about what a quote tweet or link-reference is commenting on.

    The original text column in the DataFrame is NOT modified.

    Returns:
        enriched_text: dict[int, str] — row_index → enriched text (only for rows
            that have resolvable references; rows without references are absent)
        stats: dict with enrichment statistics
    """
    has_urls = "urls_json" in df.columns
    if not has_urls:
        return {}, {"enriched_count": 0, "total_references_resolved": 0}

    # Build normalized ID → (row_index, text) lookup
    id_to_text = {}
    for idx in range(len(df)):
        row = df.iloc[idx]
        norm_id = normalize_tweet_id(row.get("id"))
        if norm_id:
            id_to_text[norm_id] = str(row.get(text_column) or "")

    enriched_text = {}
    total_resolved = 0

    for idx in range(len(df)):
        row = df.iloc[idx]
        own_id = normalize_tweet_id(row.get("id"))

        # Collect referenced tweet IDs from URL entities
        ref_texts = []
        seen_ref_ids = set()
        for url in _parse_urls_json(row.get("urls_json")):
            ref_id = _extract_status_id(url)
            if not ref_id or ref_id == own_id or ref_id in seen_ref_ids:
                continue
            seen_ref_ids.add(ref_id)
            ref_text = id_to_text.get(ref_id)
            if ref_text:
                ref_texts.append(ref_text)

        if ref_texts:
            # Concatenate: referenced text(s) first, then the tweet's own text
            own_text = str(row.get(text_column) or "")
            combined = "\n\n".join(ref_texts) + "\n\n" + own_text
            enriched_text[idx] = combined
            total_resolved += len(ref_texts)

    stats = {
        "enriched_count": len(enriched_text),
        "total_references_resolved": total_resolved,
    }
    return enriched_text, stats


def _sort_thread_member_indices(df, member_indices):
    if "created_at" in df.columns:
        return sorted(
            member_indices,
            key=lambda idx: (str(df.iloc[idx].get("created_at", "")), int(idx)),
        )
    return sorted(member_indices)


def build_self_thread_metadata(df):
    """Build row-level metadata for self-reply threads.

    Returns a dict with:
        exemplar_group_ids: list[str] where rows from the same self-thread share a root id.
            Standalone rows use their own tweet id (or a stable row fallback) so exemplar
            diversification can still treat them as independent groups.
        thread_sizes: list[int] giving the size of the self-thread for each row.
        thread_positions: list[int] giving the chronological position inside the thread.
        thread_rows_by_root: dict[str, list[int]] of ordered row indices per self-thread root.
    """
    n_rows = len(df)
    exemplar_group_ids = [None] * n_rows
    thread_sizes = [1] * n_rows
    thread_positions = [0] * n_rows
    thread_rows_by_root = {}

    # Always build a stable row-local fallback id so every row belongs to some exemplar group.
    row_group_ids = [
        normalize_tweet_id(df.iloc[idx].get("id")) or f"row-{idx}" for idx in range(n_rows)
    ]

    has_thread_cols = "in_reply_to_status_id" in df.columns and "username" in df.columns
    if not has_thread_cols:
        return {
            "exemplar_group_ids": row_group_ids,
            "thread_sizes": thread_sizes,
            "thread_positions": thread_positions,
            "thread_rows_by_root": {},
            "stats": {
                "self_thread_count": 0,
                "self_thread_rows": 0,
                "max_self_thread_size": 1,
            },
        }

    def _is_context_tweet(idx):
        if "tweet_type" not in df.columns:
            return True
        tweet_type = str(df.iloc[idx].get("tweet_type", "tweet")).strip().lower()
        return tweet_type in VALID_CONTEXT_TWEET_TYPES

    norm_id_to_idx = {}
    for idx in range(n_rows):
        norm_id = normalize_tweet_id(df.iloc[idx].get("id"))
        if norm_id:
            norm_id_to_idx[norm_id] = idx

    self_reply_parent = {}
    for idx in range(n_rows):
        if not _is_context_tweet(idx):
            continue
        row = df.iloc[idx]
        child_norm = normalize_tweet_id(row.get("id"))
        parent_norm = normalize_tweet_id(row.get("in_reply_to_status_id"))
        if not child_norm or not parent_norm:
            continue
        parent_idx = norm_id_to_idx.get(parent_norm)
        if parent_idx is None or not _is_context_tweet(parent_idx):
            continue
        child_username = str(row.get("username", "")).strip().lower()
        parent_username = str(df.iloc[parent_idx].get("username", "")).strip().lower()
        if child_username and child_username == parent_username:
            self_reply_parent[child_norm] = parent_norm

    children_map = defaultdict(list)
    for child_norm, parent_norm in self_reply_parent.items():
        children_map[parent_norm].append(child_norm)

    all_children = set(self_reply_parent.keys())
    all_parents = set(self_reply_parent.values())
    thread_roots = sorted(all_parents - all_children)
    assigned = set()

    def _walk_thread(root_norm_id):
        members = [root_norm_id]
        stack = [root_norm_id]
        seen = {root_norm_id}
        while stack:
            current = stack.pop()
            for child_norm in children_map.get(current, []):
                if child_norm in seen:
                    continue
                seen.add(child_norm)
                members.append(child_norm)
                stack.append(child_norm)
        return members

    for root_norm in thread_roots:
        if root_norm in assigned:
            continue
        member_norms = _walk_thread(root_norm)
        for member_norm in member_norms:
            assigned.add(member_norm)
        member_indices = [
            norm_id_to_idx[member_norm]
            for member_norm in member_norms
            if member_norm in norm_id_to_idx
        ]
        member_indices = _sort_thread_member_indices(df, member_indices)
        if not member_indices:
            continue

        root_idx = norm_id_to_idx.get(root_norm, member_indices[0])
        root_group_id = normalize_tweet_id(df.iloc[root_idx].get("id")) or f"row-{root_idx}"
        thread_rows_by_root[root_group_id] = member_indices
        for position, row_idx in enumerate(member_indices):
            exemplar_group_ids[row_idx] = root_group_id
            thread_sizes[row_idx] = len(member_indices)
            thread_positions[row_idx] = position

    for idx in range(n_rows):
        if exemplar_group_ids[idx] is None:
            exemplar_group_ids[idx] = row_group_ids[idx]

    max_thread_size = max(thread_sizes) if thread_sizes else 1
    self_thread_rows = sum(1 for size in thread_sizes if size > 1)
    return {
        "exemplar_group_ids": exemplar_group_ids,
        "thread_sizes": thread_sizes,
        "thread_positions": thread_positions,
        "thread_rows_by_root": thread_rows_by_root,
        "stats": {
            "self_thread_count": int(len(thread_rows_by_root)),
            "self_thread_rows": int(self_thread_rows),
            "max_self_thread_size": int(max_thread_size),
        },
    }


def _truncate_context_text(text, max_chars):
    clean = str(text or "").strip()
    if len(clean) <= max_chars:
        return clean
    return clean[: max(0, max_chars - 3)].rstrip() + "..."


def build_thread_window_text_map(
    df,
    text_column,
    *,
    base_text_map=None,
    thread_metadata=None,
    min_thread_size=3,
    max_descendants=2,
    max_total_chars=900,
    max_segment_chars=280,
):
    """Build per-row thread-window texts for long-ish self-reply threads.

    The current row remains the anchor. We add a compact amount of nearby context:
    - thread root if distinct
    - one immediate previous post if present
    - up to two immediate following posts
    """
    if thread_metadata is None:
        thread_metadata = build_self_thread_metadata(df)
    base_text_map = base_text_map or {}

    def _row_text(idx):
        if idx in base_text_map:
            return str(base_text_map[idx] or "")
        return str(df.iloc[idx].get(text_column) or "")

    window_map = {}
    truncated_count = 0
    thread_count = 0

    for row_indices in thread_metadata["thread_rows_by_root"].values():
        if len(row_indices) < int(min_thread_size):
            continue
        thread_count += 1
        root_idx = row_indices[0]

        for position, row_idx in enumerate(row_indices):
            parts = []
            total_chars = 0

            def _append_part(title, idx):
                nonlocal total_chars, truncated_count
                segment = f"{title}:\n{_truncate_context_text(_row_text(idx), max_segment_chars)}"
                projected = total_chars + len(segment) + (2 if parts else 0)
                if parts and projected > max_total_chars:
                    truncated_count += 1
                    return False
                if not parts and len(segment) > max_total_chars:
                    segment = _truncate_context_text(segment, max_total_chars)
                    truncated_count += 1
                parts.append(segment)
                total_chars += len(segment) + (2 if len(parts) > 1 else 0)
                return True

            if row_idx != root_idx:
                _append_part("Thread root", root_idx)
            if position > 0:
                prev_idx = row_indices[position - 1]
                if prev_idx != root_idx:
                    _append_part("Previous post", prev_idx)

            # Always include the current post.
            current_text = f"Current post:\n{_truncate_context_text(_row_text(row_idx), max_segment_chars)}"
            if len(current_text) + (2 if parts else 0) > max_total_chars:
                current_text = _truncate_context_text(current_text, max_total_chars)
                truncated_count += 1
                parts = [current_text]
                total_chars = len(current_text)
            else:
                parts.append(current_text)
                total_chars += len(current_text) + (2 if len(parts) > 1 else 0)

            for next_offset, next_idx in enumerate(
                row_indices[position + 1 : position + 1 + int(max_descendants)],
                start=1,
            ):
                if not _append_part(f"Next post {next_offset}", next_idx):
                    break

            window_map[row_idx] = "\n\n".join(parts)

    stats = {
        "thread_window_count": int(len(window_map)),
        "thread_window_thread_count": int(thread_count),
        "thread_window_min_size": int(min_thread_size),
        "thread_window_max_descendants": int(max_descendants),
        "thread_window_truncated_count": int(truncated_count),
    }
    return window_map, stats


def get_enriched_texts(df, text_column):
    """Return list[str] with enriched versions where references resolve.

    For tweets that reference other tweets in the dataset (via status URLs
    in urls_json), returns the referenced text concatenated with the tweet's
    own text. For all other tweets, returns the raw text.

    Returns:
        texts: list[str] — one text per row, enriched where possible
        stats: dict with enrichment statistics
    """
    enriched_map, stats = build_reference_text_map(df, text_column)
    texts = df[text_column].tolist()
    for idx, enriched in enriched_map.items():
        texts[idx] = enriched
    return texts, stats


def get_labeling_texts(
    df,
    text_column,
    *,
    enable_thread_windows=True,
    min_thread_size=3,
    max_descendants=2,
    max_total_chars=900,
    max_segment_chars=280,
):
    """Return naming texts plus thread metadata for Toponymy labeling."""
    reference_map, reference_stats = build_reference_text_map(df, text_column)
    thread_metadata = build_self_thread_metadata(df)

    texts = df[text_column].tolist()
    for idx, enriched in reference_map.items():
        texts[idx] = enriched

    merged_stats = dict(reference_stats)
    merged_stats.update(thread_metadata.get("stats", {}))

    if enable_thread_windows:
        thread_window_map, thread_window_stats = build_thread_window_text_map(
            df,
            text_column,
            base_text_map=reference_map,
            thread_metadata=thread_metadata,
            min_thread_size=min_thread_size,
            max_descendants=max_descendants,
            max_total_chars=max_total_chars,
            max_segment_chars=max_segment_chars,
        )
        for idx, enriched in thread_window_map.items():
            texts[idx] = enriched
        merged_stats.update(thread_window_stats)
    else:
        merged_stats.update(
            {
                "thread_window_count": 0,
                "thread_window_thread_count": 0,
                "thread_window_min_size": int(min_thread_size),
                "thread_window_max_descendants": int(max_descendants),
                "thread_window_truncated_count": 0,
            }
        )

    return texts, merged_stats, thread_metadata
