"""
Generate hierarchical cluster labels using Toponymy naming on a precomputed hierarchy.

Usage:
    python -m latentscope.scripts.toponymy_labels dataset_id scope_id \
        --llm-provider openai --llm-model gpt-5-mini
"""

import os
import sys
import json
import argparse
import pandas as pd
import numpy as np
import h5py
from datetime import datetime
from typing import Any

# Use local toponymy (with GPT-5 support) instead of installed package
# Resolve to absolute path for robust path comparison and to work with uv/different CWDs
_script_dir = os.path.dirname(os.path.abspath(__file__))
_local_toponymy = os.path.normpath(os.path.join(_script_dir, '..', '..', 'toponymy'))
_sys_paths_normalized = [os.path.normpath(p) for p in sys.path]
if os.path.exists(_local_toponymy) and _local_toponymy not in _sys_paths_normalized:
    sys.path.insert(0, _local_toponymy)
    print(f"Using local toponymy from: {_local_toponymy}")

from latentscope.util import get_data_dir
from latentscope.pipeline.hierarchy import PrecomputedClusterer
from latentscope.util.text_enrichment import get_labeling_texts
from latentscope.__version__ import __version__

LABELING_METHODOLOGY_VERSION = 2
THREAD_WINDOW_POLICY = {
    "enabled": True,
    "min_thread_size": 3,
    "max_descendants": 2,
    "max_total_chars": 900,
    "max_segment_chars": 280,
}
EXEMPLAR_POLICY = {
    "diversify_by_thread_root": True,
    "soft_target_unique_ratio": 0.5,
    "min_group_count_for_diversification": 3,
}


def main():
    parser = argparse.ArgumentParser(description='Generate hierarchical cluster labels using Toponymy')
    parser.add_argument('dataset_id', type=str, help='Dataset id (directory name in data folder)')
    parser.add_argument('scope_id', type=str, help='Scope id to generate labels for')
    parser.add_argument('--llm-provider', type=str, default='openai',
                        choices=['openai', 'anthropic', 'cohere', 'google'],
                        help='LLM provider for topic naming')
    parser.add_argument('--llm-model', type=str, default='gpt-5-mini',
                        help='LLM model name')
    parser.add_argument('--hierarchy-id', type=str, default=None,
                        help='Precomputed hierarchy artifact id to use for naming')
    parser.add_argument('--output-id', type=str, default=None,
                        help='Output cluster labels id (default: auto-generated)')
    parser.add_argument('--context', type=str, default=None,
                        help='Context description for LLM (e.g., "tweets from a tech founder")')
    parser.add_argument('--sync-llm', action='store_true',
                        help='Force synchronous LLM wrapper (default: async for OpenAI/Anthropic)')
    parser.add_argument('--adaptive-exemplars', action=argparse.BooleanOptionalAction, default=True,
                        help='Enable adaptive exemplar/keyphrase counts by cluster size (default: enabled)')
    parser.add_argument('--max-concurrent-requests', type=int, default=25,
                        help='Max concurrent LLM requests for async wrappers (default: 25)')

    args = parser.parse_args()
    run_toponymy_labeling(**vars(args))


def run_toponymy_labeling(
    dataset_id: str,
    scope_id: str | None = None,
    llm_provider: str = "openai",
    llm_model: str = "gpt-5-mini",
    hierarchy_id: str = None,
    embedding_id: str | None = None,
    umap_id: str | None = None,
    clustering_umap_id: str | None = None,
    cluster_id: str | None = None,
    text_column: str = "text",
    output_id: str = None,
    context: str = None,
    sync_llm: bool = False,
    adaptive_exemplars: bool = True,
    max_concurrent_requests: int = 25,
):
    """
    Generate hierarchical cluster labels using Toponymy naming on a precomputed hierarchy.

    Args:
        dataset_id: Dataset directory name
        scope_id: Scope to generate labels for
        llm_provider: LLM provider (openai, anthropic, cohere)
        llm_model: Model name for the provider
        hierarchy_id: Precomputed hierarchy artifact id to reuse for naming
        embedding_id: Embedding id when generating labels without a pre-existing scope
        umap_id: Display UMAP id when generating labels without a pre-existing scope
        clustering_umap_id: Clustering manifold id when generating labels without a pre-existing scope
        cluster_id: Optional cluster lineage id for metadata when generating labels without a pre-existing scope
        text_column: Input text column when generating labels without a pre-existing scope
        output_id: Output cluster labels id (auto-generated if None)
        context: Context description for LLM prompts
        sync_llm: If True, force synchronous LLM wrapper
        adaptive_exemplars: If True, adapt exemplar/keyphrase counts to cluster sizes
    """
    # Merge stderr into stdout so tqdm progress bars and warnings are captured
    # in log files and background task output (tqdm writes to stderr by default).
    sys.stderr = sys.stdout

    from toponymy import Toponymy
    from toponymy.embedding_wrappers import VoyageAIEmbedder

    DATA_DIR = get_data_dir()
    dataset_path = os.path.join(DATA_DIR, dataset_id)

    scope_meta: dict[str, Any]
    if scope_id is not None:
        print(f"Loading scope {scope_id} from {dataset_path}")
        scope_file = os.path.join(dataset_path, "scopes", f"{scope_id}.json")
        with open(scope_file) as f:
            scope_meta = json.load(f)
        embedding_id = scope_meta["embedding_id"]
        umap_id = scope_meta["umap_id"]
        text_column = scope_meta.get("dataset", {}).get("text_column", "text")
        hierarchy_id = hierarchy_id or scope_meta.get("hierarchy_id")
        if cluster_id is None:
            cluster_id = scope_meta.get("cluster_id")
    else:
        if not embedding_id or not umap_id:
            raise ValueError(
                "embedding_id and umap_id are required when scope_id is not provided"
            )
        scope_meta = {
            "id": None,
            "embedding_id": embedding_id,
            "umap_id": umap_id,
            "cluster_id": cluster_id,
            "dataset": {
                "text_column": text_column,
            },
        }
        print(f"Generating labels directly from dataset lineage in {dataset_path}")
    if hierarchy_id is None:
        raise ValueError(
            "hierarchy_id is required. Toponymy labeling now runs in naming-only mode on a precomputed hierarchy."
        )

    # Load texts from input with reference + thread-window enrichment.
    print("Loading texts...")
    input_df = pd.read_parquet(os.path.join(dataset_path, "input.parquet"))
    print(f"  Loaded {len(input_df)} rows")

    print("Building labeling texts with reference and thread context...")
    texts, enrich_stats, thread_metadata = get_labeling_texts(
        input_df,
        text_column,
        enable_thread_windows=THREAD_WINDOW_POLICY["enabled"],
        min_thread_size=THREAD_WINDOW_POLICY["min_thread_size"],
        max_descendants=THREAD_WINDOW_POLICY["max_descendants"],
        max_total_chars=THREAD_WINDOW_POLICY["max_total_chars"],
        max_segment_chars=THREAD_WINDOW_POLICY["max_segment_chars"],
    )
    if enrich_stats["enriched_count"] > 0:
        print(f"  {enrich_stats['enriched_count']} texts enriched with "
              f"{enrich_stats['total_references_resolved']} resolved references")
    else:
        print("  No resolvable tweet references found")
    if enrich_stats.get("thread_window_count", 0) > 0:
        print(
            f"  {enrich_stats['thread_window_count']} texts enriched with thread windows "
            f"across {enrich_stats.get('thread_window_thread_count', 0)} self-threads"
        )

    # Load embeddings
    print(f"Loading embeddings from {embedding_id}...")
    with h5py.File(os.path.join(dataset_path, "embeddings", f"{embedding_id}.h5"), "r") as f:
        embedding_vectors = f["embeddings"][:]
    print(f"  Loaded embeddings: {embedding_vectors.shape}")

    # Load UMAP coordinates for clustering
    # Check if a dedicated clustering manifold exists (kD)
    resolved_clustering_umap_id = clustering_umap_id
    if resolved_clustering_umap_id is None and cluster_id:
        cluster_meta_file = os.path.join(dataset_path, "clusters", f"{cluster_id}.json")
        if os.path.exists(cluster_meta_file):
            with open(cluster_meta_file) as f:
                cluster_meta = json.load(f)
            resolved_clustering_umap_id = cluster_meta.get("clustering_umap_id")

    if resolved_clustering_umap_id:
        print(f"Loading clustering manifold from {resolved_clustering_umap_id}...")
        clustering_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{resolved_clustering_umap_id}.parquet"))
        dim_cols = [c for c in clustering_df.columns if c.startswith("dim_")]
        if dim_cols:
            clusterable_vectors = clustering_df[dim_cols].values
            print(f"  Loaded {len(dim_cols)}D clustering manifold: {clusterable_vectors.shape}")
        else:
            print(f"  WARNING: {resolved_clustering_umap_id} has no dim_* columns, falling back to display UMAP")
            umap_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{umap_id}.parquet"))
            clusterable_vectors = umap_df[["x", "y"]].values
    else:
        print(f"Loading UMAP coordinates from {umap_id}...")
        umap_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{umap_id}.parquet"))
        clusterable_vectors = umap_df[["x", "y"]].values
    print(f"  Clusterable vectors shape: {clusterable_vectors.shape}")

    # Always load display UMAP for hull/centroid calculations
    print(f"Loading display UMAP from {umap_id}...")
    display_umap_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{umap_id}.parquet"))
    display_vectors = display_umap_df[["x", "y"]].values
    print(f"  Display vectors shape: {display_vectors.shape}")

    # Configure LLM wrapper
    print(f"Configuring LLM: {llm_provider}/{llm_model}")
    use_async_llm = (not sync_llm) and (llm_provider in {"openai", "anthropic"})
    print(f"  LLM mode: {'async' if use_async_llm else 'sync'} (max_concurrent={max_concurrent_requests})")
    llm = get_llm_wrapper(llm_provider, llm_model, async_mode=use_async_llm,
                          max_concurrent_requests=max_concurrent_requests)

    print(f"Loading precomputed hierarchy {hierarchy_id}...")
    clusterer = PrecomputedClusterer.from_artifact(
        dataset_path=dataset_path,
        hierarchy_id=hierarchy_id,
        embedding_vectors=embedding_vectors,
        verbose=True,
        show_progress_bar=True,
        adaptive_exemplars=adaptive_exemplars,
        exemplar_group_ids=thread_metadata["exemplar_group_ids"],
        soft_exemplar_group_diversity=EXEMPLAR_POLICY["diversify_by_thread_root"],
        exemplar_group_diversity_ratio=EXEMPLAR_POLICY["soft_target_unique_ratio"],
        min_exemplar_group_count_for_diversification=EXEMPLAR_POLICY[
            "min_group_count_for_diversification"
        ],
    )
    hierarchy_meta = clusterer.meta_
    print(
        f"  Loaded {len(clusterer.cluster_layers_)} layers "
        f"from builder={hierarchy_meta.get('builder')}"
    )

    # Load text embedding model for keyphrase extraction (Voyage API)
    voyage_api_key = os.environ.get("VOYAGE_API_KEY")
    if not voyage_api_key:
        raise ValueError("VOYAGE_API_KEY environment variable is required for keyphrase embedding")
    print("Loading Voyage embedder for keyphrase extraction...")
    text_embedder = VoyageAIEmbedder(api_key=voyage_api_key, model="voyage-4-lite")

    # Determine context
    if context is None:
        context = f"documents from the {dataset_id} dataset"

    print("Creating Toponymy model...")
    topic_model = Toponymy(
        llm_wrapper=llm,
        text_embedding_model=text_embedder,
        clusterer=clusterer,
        object_description=context,
        corpus_description=f"A collection of {len(texts)} {context}"
    )

    # Fit the model
    print("\nFitting Toponymy model (this may take a while)...")
    topic_model.fit(
        texts,
        embedding_vectors,
        clusterable_vectors,
        adaptive_exemplars=adaptive_exemplars,
    )

    # Audit-driven relabel loop (Phase 5)
    from toponymy.audit import flag_clusters_for_relabel, run_relabel_pass

    audit_info = {"flagged_before": 0, "flagged_after": 0, "relabeled": 0, "passes_run": 0}
    # Disable keyphrase_alignment check: it uses substring matching (do verbatim
    # n-gram keyphrases from tweets appear in the label?) which fundamentally
    # mismatches abstractive LLM labels.  topic_specificity is the meaningful
    # quality signal.  threshold=-1 prevents any keyphrase-alignment flags.
    flagged = flag_clusters_for_relabel(topic_model, keyphrase_alignment_threshold=-1.0)
    audit_info["flagged_before"] = len(flagged)
    if flagged:
        print(f"\nAudit: {len(flagged)} clusters flagged for relabeling")
        for layer_idx, cluster_idx, reasons in flagged[:10]:
            print(f"  Layer {layer_idx} cluster {cluster_idx}: {', '.join(reasons)}")
        if len(flagged) > 10:
            print(f"  ... and {len(flagged) - 10} more")

        relabel_stats = run_relabel_pass(topic_model, flagged, llm, max_passes=2)
        audit_info["relabeled"] = relabel_stats["relabeled"]
        audit_info["passes_run"] = relabel_stats["passes_run"]
        print(f"  Relabel results: {relabel_stats['relabeled']} relabeled, {relabel_stats['passes_run']} passes")

        # Re-audit after relabeling
        remaining = flag_clusters_for_relabel(topic_model, keyphrase_alignment_threshold=-1.0)
        audit_info["flagged_after"] = len(remaining)
        print(f"  After relabel: {len(remaining)} clusters still flagged")
    else:
        print("\nAudit: all cluster labels passed quality checks")

    # Extract hierarchical structure
    # Use display vectors (2D) for hull/centroid calculations
    print("\nExtracting hierarchical cluster structure...")
    hierarchical_labels, collapse_info = build_hierarchical_labels(
        topic_model,
        display_vectors,
        texts
    )
    collapsed_count = int(collapse_info.get("collapsed_count", 0))
    if collapsed_count > 0:
        print(f"  Collapsed {collapsed_count} single-child hierarchy nodes")

    post_layers = collapse_info.get("post_collapse_layer_counts", {})
    num_post = collapse_info.get("post_collapse_num_layers", len(topic_model.topic_names_))
    print(f"\nGenerated {len(hierarchical_labels)} cluster labels across {num_post} layers (pre-collapse: {len(topic_model.topic_names_)}):")
    for layer_num in sorted(post_layers.keys()):
        print(f"  Layer {layer_num}: {post_layers[layer_num]} topics")

    # Save results
    output_id = output_id or generate_output_id(dataset_path)
    save_hierarchical_labels(
        dataset_path,
        output_id,
        hierarchical_labels,
        topic_model,
        scope_meta,
        llm_provider=llm_provider,
        llm_model=llm_model,
        max_concurrent_requests=max_concurrent_requests,
        hierarchy_id=hierarchy_id,
        hierarchy_meta=hierarchy_meta,
        context=context,
        adaptive_exemplars=adaptive_exemplars,
        audit_info=audit_info,
        enrichment_stats=enrich_stats,
        collapse_info=collapse_info,
        methodology_version=LABELING_METHODOLOGY_VERSION,
        labeling_text_policy=THREAD_WINDOW_POLICY,
        exemplar_policy=EXEMPLAR_POLICY,
    )

    print(f"\nSaved hierarchical labels to: clusters/{output_id}.parquet")
    print(f"Metadata saved to: clusters/{output_id}.json")

    return output_id


def get_llm_wrapper(provider: str, model: str, async_mode: bool = False,
                    max_concurrent_requests: int = 25):
    """Get the appropriate LLM wrapper based on provider.

    Args:
        provider: LLM provider name (openai, anthropic, cohere, google)
        model: Model name for the provider
        async_mode: If True, return an async wrapper when available. Defaults to False.
        max_concurrent_requests: Max concurrent requests for async wrappers. Defaults to 25.
    """
    # Google uses GOOGLE_API_KEY not GOOGLE_API_KEY
    env_key = "GOOGLE_API_KEY" if provider == "google" else f"{provider.upper()}_API_KEY"
    api_key = os.environ.get(env_key)

    if not api_key:
        raise ValueError(f"{env_key} environment variable is required")

    if provider == "openai":
        if async_mode:
            from toponymy.llm_wrappers import AsyncOpenAINamer
            return AsyncOpenAINamer(api_key=api_key, model=model,
                                    max_concurrent_requests=max_concurrent_requests)
        from toponymy.llm_wrappers import OpenAINamer
        return OpenAINamer(api_key=api_key, model=model)
    elif provider == "anthropic":
        if async_mode:
            from toponymy.llm_wrappers import AsyncAnthropicNamer
            return AsyncAnthropicNamer(api_key=api_key, model=model,
                                       max_concurrent_requests=max_concurrent_requests)
        from toponymy.llm_wrappers import AnthropicNamer
        return AnthropicNamer(api_key=api_key, model=model)
    elif provider == "cohere":
        from toponymy.llm_wrappers import CohereNamer
        return CohereNamer(api_key=api_key, model=model)
    elif provider == "google":
        from toponymy.llm_wrappers import GoogleGeminiNamer
        return GoogleGeminiNamer(api_key=api_key, model=model)
    else:
        raise ValueError(f"Unknown LLM provider: {provider}")


def _build_child_to_parent_map(cluster_tree, num_layers):
    """
    Build a deterministic child→parent mapping from the cluster tree.

    The cluster_tree dict maps parent (layer, idx) → list of child (layer, idx).
    We invert it in one pass and validate invariants:
      - Each child has exactly one parent
      - Parent layer == child layer + 1
      - Parent node must exist in the tree or be a valid top-layer node

    Returns:
        child_to_parent: dict mapping (child_layer, child_idx) → (parent_layer, parent_idx)
        violations: list of warning strings (empty if tree is valid)
    """
    child_to_parent = {}
    violations = []

    for parent_node, children_list in cluster_tree.items():
        parent_layer, parent_idx = parent_node
        for child_node in children_list:
            child_layer, child_idx = child_node

            # Invariant: parent layer must be strictly above child layer
            if parent_layer <= child_layer:
                violations.append(
                    f"({child_layer}_{child_idx}): parent ({parent_layer}_{parent_idx}) "
                    f"layer {parent_layer} is not above child layer {child_layer}"
                )
                continue

            # Invariant: no duplicate assignment
            if child_node in child_to_parent:
                existing = child_to_parent[child_node]
                violations.append(
                    f"({child_layer}_{child_idx}): duplicate parent - "
                    f"already assigned to ({existing[0]}_{existing[1]}), "
                    f"also claimed by ({parent_layer}_{parent_idx})"
                )
                continue

            child_to_parent[child_node] = parent_node

    return child_to_parent, violations


def _cluster_key(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text


def _layer_value(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _collapse_single_child_nodes(
    hierarchical_labels: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """
    Collapse non-leaf hierarchy nodes that have exactly one child.

    The child is promoted to the removed node's parent. This is repeated until
    no eligible single-child parents remain (covers transitive chains).
    """
    by_id: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    order_index: dict[str, int] = {}

    for row in hierarchical_labels:
        cluster_id = _cluster_key(row.get("cluster"))
        if cluster_id is None:
            continue
        normalized = dict(row)
        normalized["cluster"] = cluster_id
        normalized["parent_cluster"] = _cluster_key(normalized.get("parent_cluster"))
        by_id[cluster_id] = normalized
        order_index[cluster_id] = len(order)
        order.append(cluster_id)

    collapsed_clusters: list[str] = []

    while True:
        children_by_parent: dict[str, list[str]] = {}
        for cluster_id, row in by_id.items():
            parent_id = _cluster_key(row.get("parent_cluster"))
            if parent_id is None:
                row["parent_cluster"] = None
                continue
            if parent_id not in by_id:
                row["parent_cluster"] = None
                continue
            children_by_parent.setdefault(parent_id, []).append(cluster_id)

        candidates = [
            parent_id
            for parent_id, children in children_by_parent.items()
            if len(children) == 1 and _layer_value(by_id[parent_id].get("layer")) > 0
        ]
        if not candidates:
            break

        candidates.sort(
            key=lambda parent_id: (
                _layer_value(by_id[parent_id].get("layer")),
                -order_index.get(parent_id, 0),
            ),
            reverse=True,
        )
        parent_id = candidates[0]
        child_id = children_by_parent[parent_id][0]
        grandparent_id = _cluster_key(by_id[parent_id].get("parent_cluster"))

        by_id[child_id]["parent_cluster"] = grandparent_id
        collapsed_clusters.append(parent_id)
        del by_id[parent_id]
        order = [cluster_id for cluster_id in order if cluster_id != parent_id]

    children_by_parent: dict[str, list[str]] = {}
    for cluster_id, row in by_id.items():
        parent_id = _cluster_key(row.get("parent_cluster"))
        if parent_id is None:
            row["parent_cluster"] = None
            continue
        if parent_id not in by_id:
            row["parent_cluster"] = None
            continue
        children_by_parent.setdefault(parent_id, []).append(cluster_id)

    for cluster_id, row in by_id.items():
        row["children"] = children_by_parent.get(cluster_id, [])

    collapsed = [by_id[cluster_id] for cluster_id in order if cluster_id in by_id]
    info = {
        "collapsed_count": len(collapsed_clusters),
        "collapsed_clusters": collapsed_clusters,
    }
    return collapsed, info


def _renumber_layers(
    labels: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Renumber layers top-down, preserving original depth gaps for cross-layer edges.

    After single-child collapse and PLSCAN cross-layer parents, a child at
    original layer 0 might point to a parent at original layer 2 (skipping 1).
    This function preserves the relative depth: a cross-layer edge that spanned
    2 original layers still spans 2 renumbered layers. Orphan roots that started
    below another root keep that relative depth, but any negative layers are
    shifted upward so all persisted layers remain non-negative.

    Mutates ``labels`` in place and returns a summary dict.
    """
    by_id: dict[str, dict[str, Any]] = {
        str(row["cluster"]): row for row in labels
    }

    # Snapshot original layers before renumbering.
    original_layer: dict[str, int] = {
        str(row["cluster"]): _layer_value(row.get("layer")) for row in labels
    }

    # Build parent→children adjacency from surviving nodes.
    children_map: dict[str, list[str]] = {}
    roots: list[str] = []
    for row in labels:
        cid = str(row["cluster"])
        pid = row.get("parent_cluster")
        if pid is None or str(pid) not in by_id:
            roots.append(cid)
        else:
            children_map.setdefault(str(pid), []).append(cid)

    # Compute max depth from each root via DFS, respecting original layer gaps.
    def _max_depth(node_id: str) -> int:
        children = children_map.get(node_id, [])
        if not children:
            return 0
        depths = []
        for c in children:
            gap = original_layer[node_id] - original_layer[c]
            depths.append(gap + _max_depth(c))
        return max(depths)

    global_max_depth = max((_max_depth(r) for r in roots), default=0)

    # BFS from roots, assigning layers top-down preserving original gaps.
    # Orphan nodes (parentless at lower original layers) keep their relative
    # depth rather than all being promoted to the top layer.
    from collections import deque

    max_original_layer = max(original_layer.values(), default=0)
    queue: deque[tuple[str, int]] = deque()
    for r in roots:
        offset = max_original_layer - original_layer[r]
        assigned_layer = global_max_depth - offset
        by_id[r]["layer"] = assigned_layer
        queue.append((r, assigned_layer))

    while queue:
        node_id, node_layer = queue.popleft()
        for child_id in children_map.get(node_id, []):
            gap = original_layer[node_id] - original_layer[child_id]
            by_id[child_id]["layer"] = node_layer - gap
            queue.append((child_id, node_layer - gap))

    min_assigned_layer = min((int(row["layer"]) for row in labels), default=0)
    if min_assigned_layer < 0:
        shift = -min_assigned_layer
        for row in labels:
            row["layer"] = int(row["layer"]) + shift

    # Compute post-collapse layer counts.
    layer_counts: dict[int, int] = {}
    for row in labels:
        layer = int(row["layer"])
        layer_counts[layer] = layer_counts.get(layer, 0) + 1

    return {
        "num_layers": (max(layer_counts.keys(), default=-1) + 1) if layer_counts else 0,
        "layer_counts": layer_counts,
    }


def _compute_layer_semantic_orders(topic_model) -> dict[tuple[int, int], float]:
    """
    Compute a lightweight 1D semantic ordering for each cluster within a layer.

    The order is derived from the layer's semantic centroid vectors in embedding
    space and normalized to [0, 1]. It is intended for compact UI semantics such
    as hue ordering, not for full-fidelity semantic search.
    """
    semantic_orders: dict[tuple[int, int], float] = {}

    for layer_idx, layer in enumerate(topic_model.cluster_layers_):
        labels = np.asarray(layer.cluster_labels)
        unique_clusters = np.unique(labels[labels >= 0]).astype(int)
        if unique_clusters.size == 0:
            continue

        centroids = getattr(layer, "centroid_vectors", None)
        ordered_clusters: np.ndarray
        if centroids is None:
            ordered_clusters = np.sort(unique_clusters)
        else:
            centroids = np.asarray(centroids, dtype=np.float32)
            valid_clusters = unique_clusters[unique_clusters < len(centroids)]
            if valid_clusters.size == 0:
                ordered_clusters = np.sort(unique_clusters)
            else:
                vectors = centroids[valid_clusters]
                if vectors.shape[0] == 1:
                    ordered_clusters = valid_clusters
                else:
                    # Normalize first so the ordering is driven by direction / semantics
                    # rather than centroid magnitude.
                    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
                    norms = np.where(norms > 0, norms, 1.0)
                    normalized = vectors / norms
                    centered = normalized - normalized.mean(axis=0, keepdims=True)

                    if np.allclose(centered, 0):
                        ordered_clusters = np.sort(valid_clusters)
                    else:
                        try:
                            _u, _s, vh = np.linalg.svd(centered, full_matrices=False)
                            axis = vh[0]
                            dominant_idx = int(np.argmax(np.abs(axis)))
                            if axis[dominant_idx] < 0:
                                axis = -axis
                            projections = centered @ axis
                            order = np.argsort(projections, kind="mergesort")
                            ordered_clusters = valid_clusters[order]
                        except np.linalg.LinAlgError:
                            ordered_clusters = np.sort(valid_clusters)

                # Keep deterministic placement for any clusters whose centroid vector
                # was unavailable for some reason, but normalize within this layer.
                ordered_set = {int(cluster_idx) for cluster_idx in ordered_clusters.tolist()}
                missing = [int(cluster_idx) for cluster_idx in unique_clusters if int(cluster_idx) not in ordered_set]
                if missing:
                    ordered_clusters = np.concatenate(
                        [ordered_clusters, np.asarray(sorted(missing), dtype=ordered_clusters.dtype)]
                    )

        denominator = max(len(ordered_clusters) - 1, 1)
        for rank, cluster_idx in enumerate(ordered_clusters):
            semantic_orders[(layer_idx, int(cluster_idx))] = float(rank / denominator)

    return semantic_orders


def build_hierarchical_labels(topic_model, display_vectors, texts):
    """
    Build hierarchical cluster labels from Toponymy results.

    Returns:
        hierarchical_labels: list of dicts with:
        - cluster: unique cluster id (layer_clusteridx format)
        - layer: layer number (0 = finest)
        - label: topic name
        - description: topic description (if available)
        - hull: list of point indices forming the convex hull
        - count: number of points in cluster
        - parent_cluster: parent cluster id (None for top layer)
        - children: list of child cluster ids
        - display_centroid_x, display_centroid_y: cluster center coordinates in display space
        - semantic_centroid: centroid vector in raw embedding space
        - centroid_x, centroid_y: legacy aliases for display centroid coordinates
        - indices: list of point indices in this cluster
        collapse_info: metadata about collapsed single-child nodes
    """
    from scipy.spatial import ConvexHull
    import numpy as np

    hierarchical_labels = []
    cluster_tree = topic_model.clusterer.cluster_tree_
    num_layers = len(topic_model.cluster_layers_)
    max_layer = num_layers - 1
    semantic_orders = _compute_layer_semantic_orders(topic_model)

    # Build deterministic child→parent map in one pass
    child_to_parent, violations = _build_child_to_parent_map(cluster_tree, num_layers)
    if violations:
        print(f"WARNING: {len(violations)} hierarchy violations found:")
        for v in violations:
            print(f"  - {v}")

    # Collect all valid node keys so we can detect orphans
    valid_nodes = set()

    # Process each layer
    for layer_idx, layer in enumerate(topic_model.cluster_layers_):
        topic_names = topic_model.topic_names_[layer_idx]
        cluster_labels = layer.cluster_labels

        # Get unique clusters in this layer
        unique_clusters = np.unique(cluster_labels[cluster_labels >= 0])

        for cluster_idx in unique_clusters:
            # Get point indices for this cluster
            point_mask = cluster_labels == cluster_idx
            indices = np.where(point_mask)[0].tolist()

            if len(indices) == 0:
                continue

            node_key = (layer_idx, int(cluster_idx))
            valid_nodes.add(node_key)

            # Get cluster points for hull and centroid
            cluster_points = display_vectors[point_mask]

            # Compute centroid in display space for label placement and hull geometry.
            display_centroid_x = float(np.mean(cluster_points[:, 0]))
            display_centroid_y = float(np.mean(cluster_points[:, 1]))

            # Cluster layers already carry semantic centroids in the original
            # embedding space; keep those distinct from display coordinates.
            semantic_centroid = None
            if (
                hasattr(layer, "centroid_vectors")
                and layer.centroid_vectors is not None
                and int(cluster_idx) < len(layer.centroid_vectors)
            ):
                semantic_centroid = (
                    np.asarray(layer.centroid_vectors[int(cluster_idx)], dtype=np.float32)
                    .tolist()
                )

            # Compute convex hull
            hull_indices = []
            if len(cluster_points) >= 3:
                try:
                    hull = ConvexHull(cluster_points)
                    # Convert hull vertices to original point indices
                    hull_indices = [indices[v] for v in hull.vertices]
                except Exception:
                    # Fall back to all points if hull fails
                    hull_indices = indices[:min(10, len(indices))]
            else:
                hull_indices = indices

            # Get topic name
            label = topic_names[cluster_idx] if cluster_idx < len(topic_names) else f"Topic {cluster_idx}"

            # Get topic specificity if available (from audit relabel pass)
            topic_specificity = None
            if hasattr(layer, "topic_specificities") and layer.topic_specificities:
                topic_specificity = layer.topic_specificities.get(int(cluster_idx))
            semantic_order = semantic_orders.get((layer_idx, int(cluster_idx)))

            # Build cluster id
            cluster_id = f"{layer_idx}_{cluster_idx}"

            # Find parent using pre-built map (deterministic, O(1))
            parent_cluster = None
            if layer_idx < max_layer:
                parent_node = child_to_parent.get(node_key)
                if parent_node is not None:
                    parent_cluster = f"{parent_node[0]}_{parent_node[1]}"
                else:
                    print(f"WARNING: orphan node {cluster_id} (layer {layer_idx}) has no parent")

            # Find children clusters
            children = []
            if node_key in cluster_tree:
                for child_layer, child_idx in cluster_tree[node_key]:
                    children.append(f"{child_layer}_{child_idx}")

            hierarchical_labels.append({
                "cluster": cluster_id,
                "layer": layer_idx,
                "label": label,
                "description": "",
                "hull": hull_indices,
                "count": len(indices),
                "parent_cluster": parent_cluster,
                "children": children,
                "display_centroid_x": display_centroid_x,
                "display_centroid_y": display_centroid_y,
                # Backward-compatible aliases for older consumers.
                "centroid_x": display_centroid_x,
                "centroid_y": display_centroid_y,
                "semantic_centroid": semantic_centroid,
                "semantic_order": semantic_order,
                "indices": indices,
                "topic_specificity": topic_specificity,
            })

    # Post-validation: check all parent refs point to valid nodes
    cluster_lookup = {entry["cluster"]: entry for entry in hierarchical_labels}
    for entry in hierarchical_labels:
        parent = entry["parent_cluster"]
        if parent is not None and parent not in cluster_lookup:
            print(f"WARNING: {entry['cluster']} references parent {parent} which is not in output")
            entry["parent_cluster"] = None  # Fix dangling ref

    collapsed_labels, collapse_info = _collapse_single_child_nodes(hierarchical_labels)

    # Renumber layers so every parent-child edge spans exactly one layer.
    renumber_info = _renumber_layers(collapsed_labels)
    collapse_info["post_collapse_num_layers"] = renumber_info["num_layers"]
    collapse_info["post_collapse_layer_counts"] = renumber_info["layer_counts"]

    return collapsed_labels, collapse_info


def generate_output_id(dataset_path):
    """Generate the next cluster labels id."""
    import re
    clusters_dir = os.path.join(dataset_path, "clusters")

    # Find existing toponymy labels
    existing = [f for f in os.listdir(clusters_dir)
                if re.match(r"toponymy-\d+\.json", f)]

    if existing:
        last_num = max(int(f.split("-")[1].split(".")[0]) for f in existing)
        next_num = last_num + 1
    else:
        next_num = 1

    return f"toponymy-{next_num:03d}"


def save_hierarchical_labels(
    dataset_path,
    output_id,
    hierarchical_labels,
    topic_model,
    scope_meta,
    llm_provider=None,
    llm_model=None,
    max_concurrent_requests=None,
    hierarchy_id=None,
    hierarchy_meta=None,
    context=None,
    adaptive_exemplars=None,
    audit_info=None,
    enrichment_stats=None,
    collapse_info=None,
    methodology_version=None,
    labeling_text_policy=None,
    exemplar_policy=None,
):
    """Save hierarchical labels to parquet and JSON files."""
    clusters_dir = os.path.join(dataset_path, "clusters")

    # Create DataFrame
    df = pd.DataFrame(hierarchical_labels)

    # Save parquet
    parquet_path = os.path.join(clusters_dir, f"{output_id}.parquet")
    df.to_parquet(parquet_path)

    # Save metadata
    meta = {
        "id": output_id,
        "type": "toponymy",
        "ls_version": __version__,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "scope_id": scope_meta.get("id"),
        "embedding_id": scope_meta["embedding_id"],
        "umap_id": scope_meta["umap_id"],
        "cluster_id": scope_meta.get("cluster_id"),
        "hierarchy_id": hierarchy_id,
        "hierarchy_builder": hierarchy_meta.get("builder") if hierarchy_meta else None,
        "structure_source": "precomputed_hierarchy",
        "llm_provider": llm_provider,
        "llm_model": llm_model,
        "context": context,
        "adaptive_exemplars": adaptive_exemplars,
        "max_concurrent_requests": max_concurrent_requests,
        "labeling_methodology_version": methodology_version,
        "labeling_text_policy": labeling_text_policy,
        "exemplar_policy": exemplar_policy,
        "num_layers_pre_collapse": len(topic_model.topic_names_),
        "layer_counts_pre_collapse": [len(names) for names in topic_model.topic_names_],
        "num_layers": (
            collapse_info.get("post_collapse_num_layers", len(topic_model.topic_names_))
            if collapse_info
            else len(topic_model.topic_names_)
        ),
        "num_clusters": len(hierarchical_labels),
        "layer_counts": (
            collapse_info.get("post_collapse_layer_counts", {})
            if collapse_info
            else {}
        ),
    }
    if audit_info:
        meta["audit"] = audit_info
    if enrichment_stats:
        meta["enrichment_stats"] = enrichment_stats
    if collapse_info:
        meta["single_child_collapses"] = int(collapse_info.get("collapsed_count", 0))

    json_path = os.path.join(clusters_dir, f"{output_id}.json")
    with open(json_path, "w") as f:
        json.dump(meta, f, indent=2)


if __name__ == "__main__":
    main()
