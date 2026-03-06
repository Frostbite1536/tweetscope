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

    # Compute assigned indices from deepest surviving clusters (not just layer 0).
    # After collapse + renumbering, branches may have uneven depth.
    assigned_indices: set[int] = set()
    if "indices" in full_df.columns:
        # Sort by layer ascending (deepest first) so first-write-wins
        for indices in full_df.sort_values("layer")["indices"]:
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

    # Collapse already happened in toponymy_labels.py and was saved to parquet.
    # Do NOT collapse again here — a second pass breaks parent references.
    labels_list = df.to_dict(orient="records")
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


def build_deepest_point_mappings(
    cluster_labels_df: pd.DataFrame,
) -> tuple[dict[int, str], dict[int, str]]:
    """
    Map each point index to its deepest surviving cluster and label.

    After collapse + layer renumbering, branches may have uneven depth —
    the deepest surviving cluster for a point is not always at layer 0.
    We sort clusters by layer ascending (deepest first) and use first-write-wins
    so each point gets assigned to its deepest surviving cluster.
    """
    sorted_df = cluster_labels_df.sort_values("layer").copy()
    point_to_cluster: dict[int, str] = {}
    point_to_label: dict[int, str] = {}

    for _, row in sorted_df.iterrows():
        cluster_id_str = row["cluster"]
        label = row["label"]
        indices = row["indices"]
        if indices is None:
            continue
        for idx in indices:
            idx_int = int(idx)
            if idx_int not in point_to_cluster:
                point_to_cluster[idx_int] = cluster_id_str
                point_to_label[idx_int] = label

    return point_to_cluster, point_to_label


# Backward compatibility alias
build_layer0_point_mappings = build_deepest_point_mappings
