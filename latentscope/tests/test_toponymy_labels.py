from latentscope.scripts.toponymy_labels import (
    _collapse_single_child_nodes,
    _renumber_layers,
)


def test_collapse_single_child_nodes_collapses_transitive_chain() -> None:
    labels = [
        {
            "cluster": "0_0",
            "layer": 0,
            "label": "leaf",
            "parent_cluster": "1_0",
            "children": [],
        },
        {
            "cluster": "1_0",
            "layer": 1,
            "label": "middle",
            "parent_cluster": "2_0",
            "children": ["0_0"],
        },
        {
            "cluster": "2_0",
            "layer": 2,
            "label": "top",
            "parent_cluster": None,
            "children": ["1_0"],
        },
    ]

    collapsed, info = _collapse_single_child_nodes(labels)

    assert info["collapsed_count"] == 2
    assert info["collapsed_clusters"] == ["2_0", "1_0"]
    assert len(collapsed) == 1
    assert collapsed[0]["cluster"] == "0_0"
    assert collapsed[0]["parent_cluster"] is None
    assert collapsed[0]["children"] == []


def test_renumber_layers_fixes_gaps_after_collapse() -> None:
    """After collapse removes layers 1 and 2, renumber so edges are contiguous."""
    # Simulate: 4-layer hierarchy where layers 1 and 2 got collapsed.
    # Node at layer 0 now points to parent at layer 3.
    labels = [
        {
            "cluster": "0_0",
            "layer": 0,
            "label": "leaf A",
            "parent_cluster": "3_0",
            "children": [],
        },
        {
            "cluster": "0_1",
            "layer": 0,
            "label": "leaf B",
            "parent_cluster": "3_0",
            "children": [],
        },
        {
            "cluster": "3_0",
            "layer": 3,
            "label": "root",
            "parent_cluster": None,
            "children": ["0_0", "0_1"],
        },
    ]

    info = _renumber_layers(labels)

    # Root should be at layer 1, leaves at layer 0
    by_id = {row["cluster"]: row for row in labels}
    assert by_id["3_0"]["layer"] == 1  # root
    assert by_id["0_0"]["layer"] == 0  # leaf
    assert by_id["0_1"]["layer"] == 0  # leaf
    assert info["num_layers"] == 2
    assert info["layer_counts"] == {0: 2, 1: 1}


def test_renumber_layers_handles_uneven_branches() -> None:
    """Branches with different depths get correct layer numbers."""
    # Root at layer 4, one branch goes root→mid→leaf, other goes root→leaf
    labels = [
        {
            "cluster": "leaf_a",
            "layer": 0,
            "label": "deep leaf",
            "parent_cluster": "mid",
            "children": [],
        },
        {
            "cluster": "mid",
            "layer": 2,
            "label": "middle",
            "parent_cluster": "root",
            "children": ["leaf_a"],
        },
        {
            "cluster": "leaf_b",
            "layer": 3,
            "label": "shallow leaf",
            "parent_cluster": "root",
            "children": [],
        },
        {
            "cluster": "root",
            "layer": 4,
            "label": "top",
            "parent_cluster": None,
            "children": ["mid", "leaf_b"],
        },
    ]

    info = _renumber_layers(labels)
    by_id = {row["cluster"]: row for row in labels}

    # Max depth is 2 (root→mid→leaf_a), so root=2
    assert by_id["root"]["layer"] == 2
    assert by_id["mid"]["layer"] == 1
    assert by_id["leaf_a"]["layer"] == 0
    # shallow branch: root(2)→leaf_b(1)
    assert by_id["leaf_b"]["layer"] == 1

    # Every parent-child edge spans exactly one layer
    for row in labels:
        if row["parent_cluster"] is not None:
            parent = by_id[row["parent_cluster"]]
            assert parent["layer"] == row["layer"] + 1, (
                f"{row['cluster']} layer {row['layer']} has parent "
                f"{row['parent_cluster']} at layer {parent['layer']}"
            )


def test_no_orphans_after_collapse_and_renumber() -> None:
    """After collapse + renumber, no non-root node should have null parent."""
    labels = [
        {
            "cluster": "0_0",
            "layer": 0,
            "label": "leaf",
            "parent_cluster": "1_0",
            "children": [],
        },
        {
            "cluster": "1_0",
            "layer": 1,
            "label": "single-child",
            "parent_cluster": "2_0",
            "children": ["0_0"],
        },
        {
            "cluster": "0_1",
            "layer": 0,
            "label": "other leaf",
            "parent_cluster": "2_0",
            "children": [],
        },
        {
            "cluster": "2_0",
            "layer": 2,
            "label": "root",
            "parent_cluster": None,
            "children": ["1_0", "0_1"],
        },
    ]

    collapsed, _info = _collapse_single_child_nodes(labels)
    _renumber_layers(collapsed)

    by_id = {row["cluster"]: row for row in collapsed}
    max_layer = max(row["layer"] for row in collapsed)

    for row in collapsed:
        if row["layer"] == max_layer:
            assert row["parent_cluster"] is None
        else:
            assert row["parent_cluster"] is not None, (
                f"{row['cluster']} at layer {row['layer']} is orphaned"
            )
            assert row["parent_cluster"] in by_id, (
                f"{row['cluster']} references non-existent parent {row['parent_cluster']}"
            )


def test_collapse_and_renumber_full_pipeline() -> None:
    """End-to-end: collapse removes single-child, renumber fixes layer gaps."""
    # 5-layer hierarchy: 0→1→2→3→4 but layers 1,2,3 are single-child chains
    # plus a second branch from layer 4 to layer 0
    labels = [
        {"cluster": "0_0", "layer": 0, "label": "A", "parent_cluster": "1_0", "children": []},
        {"cluster": "1_0", "layer": 1, "label": "B", "parent_cluster": "2_0", "children": ["0_0"]},
        {"cluster": "2_0", "layer": 2, "label": "C", "parent_cluster": "3_0", "children": ["1_0"]},
        {"cluster": "3_0", "layer": 3, "label": "D", "parent_cluster": "4_0", "children": ["2_0"]},
        {"cluster": "0_1", "layer": 0, "label": "E", "parent_cluster": "4_0", "children": []},
        {"cluster": "4_0", "layer": 4, "label": "root", "parent_cluster": None, "children": ["3_0", "0_1"]},
    ]

    collapsed, collapse_info = _collapse_single_child_nodes(labels)
    renumber_info = _renumber_layers(collapsed)

    by_id = {row["cluster"]: row for row in collapsed}

    # Single-child chain 1_0, 2_0, 3_0 should be collapsed
    assert "1_0" not in by_id
    assert "2_0" not in by_id
    assert "3_0" not in by_id

    # 0_0, 0_1, 4_0 should survive
    assert "0_0" in by_id
    assert "0_1" in by_id
    assert "4_0" in by_id

    # After renumber: root=1, leaves=0
    assert by_id["4_0"]["layer"] == 1
    assert by_id["0_0"]["layer"] == 0
    assert by_id["0_1"]["layer"] == 0

    # Both leaves point to root
    assert by_id["0_0"]["parent_cluster"] == "4_0"
    assert by_id["0_1"]["parent_cluster"] == "4_0"
    assert by_id["4_0"]["parent_cluster"] is None
