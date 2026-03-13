from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd

from latentscope.__version__ import __version__


def _ensure_local_toponymy_on_path() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    local_toponymy = os.path.normpath(os.path.join(here, "..", "..", "toponymy"))
    normalized_paths = {os.path.normpath(path) for path in sys.path}
    if os.path.exists(local_toponymy) and local_toponymy not in normalized_paths:
        sys.path.insert(0, local_toponymy)


def get_hierarchies_dir(dataset_path: str) -> str:
    path = os.path.join(dataset_path, "hierarchies")
    os.makedirs(path, exist_ok=True)
    return path


def next_hierarchy_id(dataset_path: str) -> str:
    hierarchies_dir = get_hierarchies_dir(dataset_path)
    existing: list[int] = []
    for name in os.listdir(hierarchies_dir):
        match = re.match(r"hierarchy-(\d+)\.json", name)
        if not match:
            continue
        try:
            existing.append(int(match.group(1)))
        except ValueError:
            continue
    next_num = max(existing) + 1 if existing else 1
    return f"hierarchy-{next_num:03d}"


def serialize_cluster_tree(
    cluster_tree: dict[tuple[int, int], list[tuple[int, int]]],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for parent in sorted(cluster_tree.keys()):
        children = sorted(cluster_tree[parent])
        records.append(
            {
                "parent": [int(parent[0]), int(parent[1])],
                "children": [[int(child[0]), int(child[1])] for child in children],
            }
        )
    return records


def deserialize_cluster_tree(
    payload: list[dict[str, Any]] | None,
) -> dict[tuple[int, int], list[tuple[int, int]]]:
    result: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for row in payload or []:
        parent_raw = row.get("parent")
        if not isinstance(parent_raw, list) or len(parent_raw) != 2:
            continue
        parent = (int(parent_raw[0]), int(parent_raw[1]))
        children: list[tuple[int, int]] = []
        for child_raw in row.get("children", []):
            if not isinstance(child_raw, list) or len(child_raw) != 2:
                continue
            children.append((int(child_raw[0]), int(child_raw[1])))
        result[parent] = children
    return result


def build_deepest_cluster_assignments(
    cluster_label_layers: list[np.ndarray],
) -> np.ndarray:
    if not cluster_label_layers:
        return np.array([], dtype=object)

    n_points = int(cluster_label_layers[0].shape[0])
    assignments = np.empty(n_points, dtype=object)
    assignments[:] = None

    for layer_idx, labels in enumerate(cluster_label_layers):
        for point_idx, cluster_idx in enumerate(labels):
            if assignments[point_idx] is not None:
                continue
            cluster_num = int(cluster_idx)
            if cluster_num < 0:
                continue
            assignments[point_idx] = f"{layer_idx}_{cluster_num}"

    return assignments


@dataclass
class HierarchyArtifact:
    meta: dict[str, Any]
    cluster_label_layers: list[np.ndarray]
    cluster_tree: dict[tuple[int, int], list[tuple[int, int]]]
    membership_strength_layers: list[np.ndarray]
    layer_persistence_scores: np.ndarray | None
    min_cluster_sizes: np.ndarray | None


def save_hierarchy_artifact(
    *,
    dataset_path: str,
    hierarchy_id: str,
    meta: dict[str, Any],
    cluster_label_layers: list[np.ndarray],
    cluster_tree: dict[tuple[int, int], list[tuple[int, int]]],
    membership_strength_layers: list[np.ndarray] | None = None,
    layer_persistence_scores: np.ndarray | None = None,
    min_cluster_sizes: np.ndarray | None = None,
) -> dict[str, str]:
    hierarchies_dir = get_hierarchies_dir(dataset_path)
    json_path = os.path.join(hierarchies_dir, f"{hierarchy_id}.json")
    npz_path = os.path.join(hierarchies_dir, f"{hierarchy_id}.npz")

    layer_counts = [int(np.max(labels) + 1) if np.any(labels >= 0) else 0 for labels in cluster_label_layers]
    meta_payload = dict(meta)
    meta_payload.update(
        {
            "id": hierarchy_id,
            "type": "hierarchy",
            "ls_version": __version__,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "num_layers": len(cluster_label_layers),
            "layer_counts": layer_counts,
            "cluster_tree": serialize_cluster_tree(cluster_tree),
        }
    )

    arrays: dict[str, np.ndarray] = {}
    for idx, labels in enumerate(cluster_label_layers):
        arrays[f"labels_layer_{idx}"] = np.asarray(labels)
    for idx, strengths in enumerate(membership_strength_layers or []):
        arrays[f"membership_strength_layer_{idx}"] = np.asarray(strengths)
    if layer_persistence_scores is not None:
        arrays["layer_persistence_scores"] = np.asarray(layer_persistence_scores)
    if min_cluster_sizes is not None:
        arrays["min_cluster_sizes"] = np.asarray(min_cluster_sizes)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(meta_payload, f, indent=2)
    np.savez_compressed(npz_path, **arrays)
    return {"json_path": json_path, "npz_path": npz_path}


def load_hierarchy_artifact(dataset_path: str, hierarchy_id: str) -> HierarchyArtifact:
    hierarchies_dir = get_hierarchies_dir(dataset_path)
    json_path = os.path.join(hierarchies_dir, f"{hierarchy_id}.json")
    npz_path = os.path.join(hierarchies_dir, f"{hierarchy_id}.npz")

    with open(json_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    with np.load(npz_path, allow_pickle=False) as data:
        label_keys = sorted(
            [key for key in data.files if key.startswith("labels_layer_")],
            key=lambda key: int(key.rsplit("_", 1)[-1]),
        )
        membership_keys = sorted(
            [key for key in data.files if key.startswith("membership_strength_layer_")],
            key=lambda key: int(key.rsplit("_", 1)[-1]),
        )
        cluster_label_layers = [np.asarray(data[key]) for key in label_keys]
        membership_strength_layers = [np.asarray(data[key]) for key in membership_keys]
        layer_persistence_scores = (
            np.asarray(data["layer_persistence_scores"])
            if "layer_persistence_scores" in data.files
            else None
        )
        min_cluster_sizes = (
            np.asarray(data["min_cluster_sizes"])
            if "min_cluster_sizes" in data.files
            else None
        )

    return HierarchyArtifact(
        meta=meta,
        cluster_label_layers=cluster_label_layers,
        cluster_tree=deserialize_cluster_tree(meta.get("cluster_tree")),
        membership_strength_layers=membership_strength_layers,
        layer_persistence_scores=layer_persistence_scores,
        min_cluster_sizes=min_cluster_sizes,
    )


def _normalize_cluster_tree(
    cluster_tree: dict[tuple[int, int], list[tuple[int, int]]],
    num_layers: int,
) -> dict[tuple[int, int], list[tuple[int, int]]]:
    """Filter cluster tree to only include nodes within the actual layer range.

    PLSCAN can produce parent references to virtual layers beyond the output
    (e.g., a layer-3 super-root when only 3 layers [0,1,2] exist).
    This removes those edges and keeps valid cross-layer edges intact.
    """
    valid_range = set(range(num_layers))
    normalized: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for parent, children in cluster_tree.items():
        if parent[0] not in valid_range:
            continue
        valid_children = [c for c in children if c[0] in valid_range]
        if valid_children:
            normalized[parent] = valid_children
    return normalized


def build_plscan_hierarchy(
    *,
    clusterable_vectors: np.ndarray,
    min_samples: int = 5,
    max_layers: int = 10,
    base_min_cluster_size: int = 10,
    base_n_clusters: int | None = None,
    layer_similarity_threshold: float = 0.2,
    reproducible: bool = False,
    verbose: bool = False,
) -> dict[str, Any]:
    from fast_hdbscan import PLSCAN

    clusterer = PLSCAN(
        min_samples=min_samples,
        max_layers=max_layers,
        base_min_cluster_size=base_min_cluster_size,
        base_n_clusters=base_n_clusters,
        layer_similarity_threshold=layer_similarity_threshold,
        reproducible=reproducible,
        verbose=verbose,
    )
    clusterer.fit(clusterable_vectors)
    num_layers = len(clusterer.cluster_layers_)
    raw_tree = clusterer.cluster_tree_
    normalized_tree = _normalize_cluster_tree(raw_tree, num_layers)
    return {
        "clusterer": clusterer,
        "cluster_label_layers": [np.asarray(labels) for labels in clusterer.cluster_layers_],
        "cluster_tree": normalized_tree,
        "membership_strength_layers": [
            np.asarray(strengths) for strengths in clusterer.membership_strength_layers_
        ],
        "layer_persistence_scores": np.asarray(clusterer.layer_persistence_scores_),
        "min_cluster_sizes": np.asarray(clusterer.min_cluster_sizes_),
        "best_layer": int(np.argmax(clusterer.layer_persistence_scores_))
        if len(clusterer.layer_persistence_scores_) > 0
        else 0,
    }


class PrecomputedClusterer:
    def __init__(
        self,
        *,
        cluster_layers: list[Any],
        cluster_tree: dict[tuple[int, int], list[tuple[int, int]]],
        meta: dict[str, Any] | None = None,
        cluster_label_layers: list[np.ndarray] | None = None,
        membership_strength_layers: list[np.ndarray] | None = None,
        layer_persistence_scores: np.ndarray | None = None,
        min_cluster_sizes: np.ndarray | None = None,
    ) -> None:
        self.cluster_layers_ = cluster_layers
        self.cluster_tree_ = cluster_tree
        self.meta_ = meta or {}
        self.cluster_label_layers_ = cluster_label_layers or []
        self.membership_strength_layers_ = membership_strength_layers or []
        self.layer_persistence_scores_ = layer_persistence_scores
        self.min_cluster_sizes_ = min_cluster_sizes

    @classmethod
    def from_artifact(
        cls,
        *,
        dataset_path: str,
        hierarchy_id: str,
        embedding_vectors: np.ndarray,
        layer_class: Any = None,
        verbose: bool | None = None,
        show_progress_bar: bool | None = None,
        **layer_kwargs: Any,
    ) -> "PrecomputedClusterer":
        _ensure_local_toponymy_on_path()
        if layer_class is None:
            from toponymy.cluster_layer import ClusterLayerText

            layer_class = ClusterLayerText

        from toponymy.clustering import centroids_from_labels

        artifact = load_hierarchy_artifact(dataset_path, hierarchy_id)
        cluster_layers = [
            layer_class(
                labels,
                centroids_from_labels(labels, embedding_vectors),
                layer_id=i,
                verbose=verbose,
                show_progress_bar=show_progress_bar,
                **layer_kwargs,
            )
            for i, labels in enumerate(artifact.cluster_label_layers)
        ]
        return cls(
            cluster_layers=cluster_layers,
            cluster_tree=artifact.cluster_tree,
            meta=artifact.meta,
            cluster_label_layers=artifact.cluster_label_layers,
            membership_strength_layers=artifact.membership_strength_layers,
            layer_persistence_scores=artifact.layer_persistence_scores,
            min_cluster_sizes=artifact.min_cluster_sizes,
        )

    def fit(self, *args: Any, **kwargs: Any) -> "PrecomputedClusterer":
        return self

    def fit_predict(self, *args: Any, **kwargs: Any) -> tuple[list[Any], dict[tuple[int, int], list[tuple[int, int]]]]:
        return self.cluster_layers_, self.cluster_tree_
