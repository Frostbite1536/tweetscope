from __future__ import annotations

import json
import sys
import types

import numpy as np
import pandas as pd
import pytest

from latentscope.pipeline.hierarchy import (
    PrecomputedClusterer,
    compute_target_leaf_topics_from_input_df,
    deserialize_cluster_tree,
    load_hierarchy_artifact,
    save_hierarchy_artifact,
    serialize_cluster_tree,
)
from latentscope.scripts.twitter_import import (
    _find_matching_hierarchy_id,
    _find_matching_toponymy_labels_id,
    _try_enable_hierarchical_scope,
)


class FakeLayer:
    def __init__(self, cluster_labels, centroids, layer_id, **kwargs):
        self.cluster_labels = np.asarray(cluster_labels)
        self.centroids = np.asarray(centroids)
        self.layer_id = layer_id
        self.kwargs = kwargs


def test_cluster_tree_round_trip() -> None:
    cluster_tree = {
        (1, 0): [(0, 0), (0, 1)],
        (2, 0): [(1, 0)],
    }

    payload = serialize_cluster_tree(cluster_tree)
    restored = deserialize_cluster_tree(payload)

    assert restored == cluster_tree


def test_save_and_load_hierarchy_artifact(tmp_path) -> None:
    dataset_path = str(tmp_path / "dataset")
    cluster_layers = [
        np.array([0, 0, 1, 1], dtype=np.int32),
        np.array([0, 0, 0, 0], dtype=np.int32),
    ]
    cluster_tree = {
        (1, 0): [(0, 0), (0, 1)],
    }
    membership_strength_layers = [
        np.array([0.9, 0.8, 0.7, 0.6], dtype=np.float32),
        np.array([1.0, 1.0, 1.0, 1.0], dtype=np.float32),
    ]

    save_hierarchy_artifact(
        dataset_path=dataset_path,
        hierarchy_id="hierarchy-001",
        meta={
            "dataset_id": "dataset",
            "builder": "plscan",
        },
        cluster_label_layers=cluster_layers,
        cluster_tree=cluster_tree,
        membership_strength_layers=membership_strength_layers,
        layer_persistence_scores=np.array([0.25, 0.5], dtype=np.float32),
        min_cluster_sizes=np.array([2, 4], dtype=np.int32),
    )

    artifact = load_hierarchy_artifact(dataset_path, "hierarchy-001")

    assert artifact.meta["id"] == "hierarchy-001"
    assert artifact.meta["builder"] == "plscan"
    assert artifact.cluster_tree == cluster_tree
    assert len(artifact.cluster_label_layers) == 2
    assert np.array_equal(artifact.cluster_label_layers[0], cluster_layers[0])
    assert np.array_equal(artifact.membership_strength_layers[1], membership_strength_layers[1])
    assert np.array_equal(artifact.layer_persistence_scores, np.array([0.25, 0.5], dtype=np.float32))
    assert np.array_equal(artifact.min_cluster_sizes, np.array([2, 4], dtype=np.int32))


def test_precomputed_clusterer_reconstructs_layers(tmp_path) -> None:
    dataset_path = str(tmp_path / "dataset")
    embedding_vectors = np.array(
        [
            [1.0, 0.0],
            [0.5, 0.0],
            [0.0, 1.0],
            [0.0, 0.5],
        ],
        dtype=np.float32,
    )
    cluster_layers = [
        np.array([0, 0, 1, 1], dtype=np.int32),
        np.array([0, 0, 0, 0], dtype=np.int32),
    ]
    cluster_tree = {
        (1, 0): [(0, 0), (0, 1)],
    }

    save_hierarchy_artifact(
        dataset_path=dataset_path,
        hierarchy_id="hierarchy-001",
        meta={"dataset_id": "dataset", "builder": "plscan"},
        cluster_label_layers=cluster_layers,
        cluster_tree=cluster_tree,
    )

    clusterer = PrecomputedClusterer.from_artifact(
        dataset_path=dataset_path,
        hierarchy_id="hierarchy-001",
        embedding_vectors=embedding_vectors,
        layer_class=FakeLayer,
        adaptive_exemplars=True,
    )

    assert clusterer.meta_["builder"] == "plscan"
    assert clusterer.cluster_tree_ == cluster_tree
    assert len(clusterer.cluster_layers_) == 2
    assert np.array_equal(clusterer.cluster_layers_[0].cluster_labels, cluster_layers[0])
    assert clusterer.cluster_layers_[0].centroids.shape == (2, 2)
    assert clusterer.cluster_layers_[1].centroids.shape == (1, 2)
    assert clusterer.cluster_layers_[0].kwargs["adaptive_exemplars"] is True


def test_find_matching_hierarchy_id_uses_lineage_and_params(tmp_path) -> None:
    dataset_dir = tmp_path / "dataset"
    hierarchies_dir = dataset_dir / "hierarchies"
    hierarchies_dir.mkdir(parents=True)

    matching = {
        "id": "hierarchy-002",
        "type": "hierarchy",
        "builder": "plscan",
        "embedding_id": "embedding-001",
        "clustering_umap_id": "umap-002",
        "display_umap_id": "umap-display-a",
        "params": {
            "min_samples": 5,
            "max_layers": 10,
            "base_min_cluster_size": 10,
            "base_n_clusters": None,
            "layer_similarity_threshold": 0.2,
            "reproducible": False,
        },
    }
    non_matching = {
        **matching,
        "id": "hierarchy-003",
        "params": {
            **matching["params"],
            "min_samples": 7,
        },
    }

    (hierarchies_dir / "hierarchy-002.json").write_text(json.dumps(matching))
    (hierarchies_dir / "hierarchy-003.json").write_text(json.dumps(non_matching))

    found = _find_matching_hierarchy_id(
        str(dataset_dir),
        embedding_id="embedding-001",
        clustering_umap_id="umap-002",
        min_samples=5,
        max_layers=10,
        base_min_cluster_size=10,
        base_n_clusters=None,
        layer_similarity_threshold=0.2,
        reproducible=False,
    )

    assert found == "hierarchy-002"


def test_find_matching_toponymy_labels_id_keys_on_hierarchy_and_naming_method(tmp_path) -> None:
    dataset_dir = tmp_path / "dataset"
    clusters_dir = dataset_dir / "clusters"
    clusters_dir.mkdir(parents=True)

    matching = {
        "id": "toponymy-002",
        "type": "toponymy",
        "embedding_id": "embedding-001",
        "umap_id": "umap-001",
        "cluster_id": None,
        "hierarchy_id": "hierarchy-001",
        "llm_provider": "openai",
        "llm_model": "gpt-5-mini",
        "context": "tweets from a founder",
        "adaptive_exemplars": True,
        "labeling_methodology_version": 2,
    }
    wrong_context = {
        **matching,
        "id": "toponymy-003",
        "context": "different context",
    }

    (clusters_dir / "toponymy-002.json").write_text(json.dumps(matching))
    (clusters_dir / "toponymy-003.json").write_text(json.dumps(wrong_context))

    found = _find_matching_toponymy_labels_id(
        str(dataset_dir),
        embedding_id="embedding-001",
        umap_id="umap-001",
        cluster_id=None,
        hierarchy_id="hierarchy-001",
        llm_provider="openai",
        llm_model="gpt-5-mini",
        context="tweets from a founder",
        adaptive_exemplars=True,
    )

    assert found == "toponymy-002"


def test_compute_target_leaf_topics_uses_configured_text_column() -> None:
    df = pd.DataFrame(
        {
            "body": ["a much longer body of text", "tiny", "medium length text"],
            "is_reply": [True, False, True],
        }
    )

    target, median_chars, reply_ratio = compute_target_leaf_topics_from_input_df(
        df,
        text_column="body",
        n_rows=len(df),
    )

    assert target > 0
    assert median_chars == float(df["body"].astype(str).str.len().median())
    assert reply_ratio == pytest.approx(2 / 3)


def test_compute_target_leaf_topics_missing_text_column_raises() -> None:
    df = pd.DataFrame({"text": ["hello"]})

    with pytest.raises(KeyError, match="Configured text column 'body'"):
        compute_target_leaf_topics_from_input_df(df, text_column="body")


def test_try_enable_hierarchical_scope_passes_text_column(tmp_path, monkeypatch) -> None:
    calls: dict[str, object] = {}

    fake_module = types.ModuleType("latentscope.scripts.toponymy_labels")

    def _fake_run_toponymy_labeling(**kwargs):
        calls.update(kwargs)
        return "toponymy-999"

    fake_module.run_toponymy_labeling = _fake_run_toponymy_labeling
    monkeypatch.setitem(sys.modules, "latentscope.scripts.toponymy_labels", fake_module)

    result = _try_enable_hierarchical_scope(
        dataset_id="dataset",
        dataset_dir=str(tmp_path / "dataset"),
        scope_id=None,
        embedding_id="embedding-001",
        umap_id="umap-001",
        clustering_umap_id="umap-002",
        cluster_id=None,
        hierarchy_id="hierarchy-001",
        text_column="body",
        label="Dataset",
        description="desc",
        toponymy_provider="openai",
        toponymy_model="gpt-5-mini",
        toponymy_context=None,
        toponymy_adaptive_exemplars=True,
        max_concurrent_requests=3,
    )

    assert result["cluster_labels_id"] == "toponymy-999"
    assert calls["text_column"] == "body"
