from __future__ import annotations

import numpy as np
import pandas as pd

from latentscope.pipeline.hierarchy import save_hierarchy_artifact
from latentscope.pipeline.stages.scope_materialize import build_scope_points_df


def test_build_scope_points_df_hierarchical_without_cluster_artifact(tmp_path) -> None:
    data_dir = tmp_path
    dataset_id = "dataset"
    dataset_path = data_dir / dataset_id
    dataset_path.mkdir(parents=True)

    save_hierarchy_artifact(
        dataset_path=str(dataset_path),
        hierarchy_id="hierarchy-001",
        meta={"dataset_id": dataset_id, "builder": "plscan"},
        cluster_label_layers=[
            np.array([0, 0, -1], dtype=np.int32),
            np.array([0, 0, 0], dtype=np.int32),
        ],
        cluster_tree={(1, 0): [(0, 0)]},
    )

    umap_df = pd.DataFrame(
        {
            "x": [0.0, 1.0, 2.0],
            "y": [0.0, 1.0, 2.0],
        }
    )
    cluster_labels_df = pd.DataFrame(
        {
            "cluster": ["0_0", "1_0"],
            "layer": [0, 1],
            "label": ["Leaf", "Parent"],
            "indices": [[0, 1], [0, 1, 2]],
        }
    )

    scope_points_df = build_scope_points_df(
        umap_df=umap_df,
        data_dir=str(data_dir),
        dataset_id=dataset_id,
        cluster_id=None,
        cluster_labels_df=cluster_labels_df,
        hierarchical=True,
        hierarchy_id="hierarchy-001",
        scope_id="scopes-001",
        overwrite_scope_id=None,
    )

    assert scope_points_df["cluster"].tolist() == ["0_0", "0_0", "1_0"]
    assert scope_points_df["label"].tolist() == ["Leaf", "Leaf", "Parent"]
    assert scope_points_df["raw_cluster"].tolist() == ["0_0", "0_0", "1_0"]
