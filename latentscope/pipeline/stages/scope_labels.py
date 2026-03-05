from __future__ import annotations

from typing import Any

import pandas as pd


def is_hierarchical_labels(cluster_labels_df: pd.DataFrame) -> bool:
    return "layer" in cluster_labels_df.columns


def build_cluster_labels_lookup(
    *,
    cluster_labels_df: pd.DataFrame,
    hierarchical: bool,
    umap_row_count: int,
) -> tuple[list[dict[str, Any]], int]:
    if hierarchical:
        return _build_hierarchical_lookup(cluster_labels_df, umap_row_count)
    return _build_flat_lookup(cluster_labels_df), 0


def _build_hierarchical_lookup(
    cluster_labels_df: pd.DataFrame, umap_row_count: int
) -> tuple[list[dict[str, Any]], int]:
    full_df = cluster_labels_df.copy()

    assigned_indices: set[int] = set()
    if "indices" in full_df.columns:
        layer0 = full_df[full_df["layer"] == 0]
        for indices in layer0["indices"]:
            if indices is None:
                continue
            if hasattr(indices, "tolist"):
                indices = indices.tolist()
            assigned_indices.update(indices)

    unknown_count = max(0, int(umap_row_count) - len(assigned_indices))

    df = full_df.drop(columns=[col for col in ["indices"] if col in full_df.columns])

    if "hull" in df.columns:
        df["hull"] = df["hull"].apply(lambda x: x.tolist() if hasattr(x, "tolist") else x)
    if "children" in df.columns:
        df["children"] = df["children"].apply(
            lambda x: x.tolist() if hasattr(x, "tolist") else x
        )

    labels_list = _collapse_single_child_parents(df.to_dict(orient="records"))
    labels_list.append(
        {
            "cluster": "unknown",
            "layer": 0,
            "label": "Unclustered",
            "description": "Points not assigned to any cluster",
            "hull": [],
            "count": unknown_count,
            "parent_cluster": None,
            "children": [],
            "centroid_x": 0,
            "centroid_y": 0,
        }
    )
    return labels_list, unknown_count


def _cluster_key(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text == "unknown":
        return None
    return text


def _layer_value(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _collapse_single_child_parents(
    labels_list: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Collapse degenerate hierarchy branches where a non-leaf node has exactly one child.

    These one-child branches produce duplicate/unhelpful "subcluster" UI states.
    We promote the only child to the removed node's parent and then rebuild
    children arrays from normalized parent links.
    """
    by_id: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    order_index: dict[str, int] = {}

    for row in labels_list:
        cluster_id = _cluster_key(row.get("cluster"))
        if cluster_id is None:
            continue
        normalized = dict(row)
        normalized["cluster"] = cluster_id
        normalized["parent_cluster"] = _cluster_key(normalized.get("parent_cluster"))
        by_id[cluster_id] = normalized
        order_index[cluster_id] = len(order)
        order.append(cluster_id)

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

        # Collapse deepest branches first for stable deterministic output.
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

    return [by_id[cluster_id] for cluster_id in order if cluster_id in by_id]


def _build_flat_lookup(cluster_labels_df: pd.DataFrame) -> list[dict[str, Any]]:
    df = cluster_labels_df.drop(
        columns=[
            col
            for col in ["indices", "labeled", "label_raw"]
            if col in cluster_labels_df.columns
        ]
    )
    df = df.copy()
    df["hull"] = df["hull"].apply(lambda x: x.tolist())
    df["cluster"] = df.index
    return df.to_dict(orient="records")


def build_layer0_point_mappings(
    cluster_labels_df: pd.DataFrame,
) -> tuple[dict[int, str], dict[int, str]]:
    """
    For hierarchical labels: map point index -> (cluster_id_str, label).
    """
    layer0 = cluster_labels_df[cluster_labels_df["layer"] == 0].copy()
    point_to_cluster: dict[int, str] = {}
    point_to_label: dict[int, str] = {}

    for _, row in layer0.iterrows():
        cluster_id_str = row["cluster"]
        label = row["label"]
        indices = row["indices"]
        for idx in indices:
            point_to_cluster[int(idx)] = cluster_id_str
            point_to_label[int(idx)] = label

    return point_to_cluster, point_to_label
