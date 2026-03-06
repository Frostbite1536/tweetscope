import numpy as np
import pandas as pd

from latentscope.pipeline.stages.scope_labels import (
    build_cluster_labels_lookup,
    build_deepest_point_mappings,
)


def test_build_cluster_labels_lookup_flat_drops_indices_and_sets_cluster() -> None:
    df = pd.DataFrame(
        {
            "label": ["A", "B"],
            "hull": [np.array([[0, 0], [1, 0]]), np.array([[0, 1], [1, 1]])],
            "indices": [[0, 1], [2, 3]],
        }
    )

    lookup, unknown = build_cluster_labels_lookup(
        cluster_labels_df=df,
        hierarchical=False,
        umap_row_count=0,
    )
    assert unknown == 0
    clusters = {row["cluster"] for row in lookup}
    assert clusters == {0, 1}
    assert all("indices" not in row for row in lookup)
    assert isinstance(lookup[0]["hull"], list)


def test_build_cluster_labels_lookup_hierarchical_adds_unknown_and_converts_lists() -> None:
    df = pd.DataFrame(
        {
            "cluster": ["0_0", "0_1"],
            "layer": [0, 0],
            "label": ["Foo", "Bar"],
            "description": ["", ""],
            "hull": [np.array([[0, 0], [1, 0]]), np.array([[0, 1], [1, 1]])],
            "count": [2, 1],
            "parent_cluster": [None, None],
            "children": [np.array([], dtype=int), np.array([], dtype=int)],
            "centroid_x": [0.0, 0.0],
            "centroid_y": [0.0, 0.0],
            "indices": [[0, 1], [2]],
        }
    )

    lookup, unknown = build_cluster_labels_lookup(
        cluster_labels_df=df,
        hierarchical=True,
        umap_row_count=5,
    )
    assert unknown == 2
    unknown_rows = [row for row in lookup if row.get("cluster") == "unknown"]
    assert len(unknown_rows) == 1
    assert unknown_rows[0]["count"] == 2
    assert all("indices" not in row for row in lookup)
    assert isinstance(lookup[0]["hull"], list)
    assert isinstance(lookup[0]["children"], list)


def test_build_cluster_labels_lookup_hierarchical_no_double_collapse() -> None:
    """Scope labels should NOT collapse single-child parents — that's done upstream."""
    df = pd.DataFrame(
        {
            "cluster": ["0_0", "1_0"],
            "layer": [0, 1],
            "label": ["Child", "Parent"],
            "description": ["", ""],
            "hull": [np.array([[0, 0], [1, 0]]), np.array([[0, 0], [1, 1]])],
            "count": [3, 3],
            "parent_cluster": ["1_0", None],
            "children": [np.array([], dtype=object), np.array(["0_0"], dtype=object)],
            "centroid_x": [0.0, 0.0],
            "centroid_y": [0.0, 0.0],
            "indices": [[0, 1, 2], [0, 1, 2]],
        }
    )

    lookup, unknown = build_cluster_labels_lookup(
        cluster_labels_df=df,
        hierarchical=True,
        umap_row_count=3,
    )

    assert unknown == 0
    labels_by_cluster = {row["cluster"]: row for row in lookup if row["cluster"] != "unknown"}
    # Both nodes should survive (no second collapse)
    assert "0_0" in labels_by_cluster
    assert "1_0" in labels_by_cluster
    assert labels_by_cluster["0_0"]["parent_cluster"] == "1_0"


def test_deepest_point_mappings_assigns_to_deepest_cluster() -> None:
    """Points should be assigned to their deepest surviving cluster, not just layer 0."""
    df = pd.DataFrame(
        {
            "cluster": ["0_0", "0_1", "1_0"],
            "layer": [0, 0, 1],
            "label": ["Leaf A", "Leaf B", "Parent"],
            "indices": [[0, 1], [2, 3], [0, 1, 2, 3, 4]],
        }
    )

    point_to_cluster, point_to_label = build_deepest_point_mappings(df)

    # Points 0,1 → 0_0 (layer 0, deepest)
    assert point_to_cluster[0] == "0_0"
    assert point_to_cluster[1] == "0_0"
    # Points 2,3 → 0_1 (layer 0, deepest)
    assert point_to_cluster[2] == "0_1"
    assert point_to_cluster[3] == "0_1"
    # Point 4 → 1_0 (only in layer 1, which is its deepest)
    assert point_to_cluster[4] == "1_0"
    assert point_to_label[4] == "Parent"


def test_deepest_point_mappings_uneven_branches() -> None:
    """Uneven branch depths: some points have deepest at layer 0, others at layer 1."""
    df = pd.DataFrame(
        {
            "cluster": ["deep_leaf", "shallow_leaf", "root"],
            "layer": [0, 1, 2],
            "label": ["Deep", "Shallow", "Root"],
            "indices": [[0, 1], [2, 3], [0, 1, 2, 3, 4, 5]],
        }
    )

    point_to_cluster, point_to_label = build_deepest_point_mappings(df)

    assert point_to_cluster[0] == "deep_leaf"
    assert point_to_cluster[1] == "deep_leaf"
    assert point_to_cluster[2] == "shallow_leaf"
    assert point_to_cluster[3] == "shallow_leaf"
    # Points 4,5 only in root (layer 2)
    assert point_to_cluster[4] == "root"
    assert point_to_cluster[5] == "root"
