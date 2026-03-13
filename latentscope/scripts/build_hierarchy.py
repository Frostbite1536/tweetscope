"""
Build a canonical structural hierarchy artifact from the clustering manifold.

Usage:
    uv run python3 -m latentscope.scripts.build_hierarchy my-dataset embedding-001 umap-002 \
        --display-umap-id umap-001
"""

from __future__ import annotations

import argparse
import json
import os

import h5py
import numpy as np
import pandas as pd

from latentscope.pipeline.hierarchy import (
    build_plscan_hierarchy,
    next_hierarchy_id,
    save_hierarchy_artifact,
)
from latentscope.util import get_data_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a canonical hierarchy artifact")
    parser.add_argument("dataset_id", type=str, help="Dataset id")
    parser.add_argument("embedding_id", type=str, help="Embedding id")
    parser.add_argument("clustering_umap_id", type=str, help="Clustering UMAP/manifold id")
    parser.add_argument(
        "--display-umap-id",
        type=str,
        default=None,
        help="Display UMAP id for lineage metadata",
    )
    parser.add_argument("--output-id", type=str, default=None, help="Hierarchy artifact id")
    parser.add_argument("--min-samples", type=int, default=5)
    parser.add_argument("--max-layers", type=int, default=10)
    parser.add_argument("--base-min-cluster-size", type=int, default=10)
    parser.add_argument("--base-n-clusters", type=int, default=None)
    parser.add_argument("--layer-similarity-threshold", type=float, default=0.2)
    parser.add_argument("--reproducible", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    build_hierarchy(**vars(args))


def build_hierarchy(
    dataset_id: str,
    embedding_id: str,
    clustering_umap_id: str,
    display_umap_id: str | None = None,
    output_id: str | None = None,
    min_samples: int = 5,
    max_layers: int = 10,
    base_min_cluster_size: int = 10,
    base_n_clusters: int | None = None,
    layer_similarity_threshold: float = 0.2,
    reproducible: bool = False,
    quiet: bool = False,
) -> str:
    data_dir = get_data_dir()
    dataset_path = os.path.join(data_dir, dataset_id)
    output_id = output_id or next_hierarchy_id(dataset_path)

    if not quiet:
        print(f"Building hierarchy {output_id} for {dataset_id}")
        print(f"  embedding_id={embedding_id}")
        print(f"  clustering_umap_id={clustering_umap_id}")

    with h5py.File(os.path.join(dataset_path, "embeddings", f"{embedding_id}.h5"), "r") as f:
        n_points = int(f["embeddings"].shape[0])

    clustering_df = pd.read_parquet(
        os.path.join(dataset_path, "umaps", f"{clustering_umap_id}.parquet")
    )
    dim_cols = [col for col in clustering_df.columns if col.startswith("dim_")]
    if not dim_cols:
        raise ValueError(
            f"{clustering_umap_id} does not contain dim_* columns required for hierarchy building"
        )
    clusterable_vectors = np.ascontiguousarray(clustering_df[dim_cols].to_numpy())

    result = build_plscan_hierarchy(
        clusterable_vectors=clusterable_vectors,
        min_samples=min_samples,
        max_layers=max_layers,
        base_min_cluster_size=base_min_cluster_size,
        base_n_clusters=base_n_clusters,
        layer_similarity_threshold=layer_similarity_threshold,
        reproducible=reproducible,
        verbose=not quiet,
    )

    meta = {
        "dataset_id": dataset_id,
        "embedding_id": embedding_id,
        "clustering_umap_id": clustering_umap_id,
        "display_umap_id": display_umap_id,
        "builder": "plscan",
        "params": {
            "min_samples": int(min_samples),
            "max_layers": int(max_layers),
            "base_min_cluster_size": int(base_min_cluster_size),
            "base_n_clusters": int(base_n_clusters) if base_n_clusters is not None else None,
            "layer_similarity_threshold": float(layer_similarity_threshold),
            "reproducible": bool(reproducible),
        },
        "num_points": n_points,
        "vector_dimensions": int(clusterable_vectors.shape[1]),
        "best_layer": int(result["best_layer"]),
    }

    save_hierarchy_artifact(
        dataset_path=dataset_path,
        hierarchy_id=output_id,
        meta=meta,
        cluster_label_layers=result["cluster_label_layers"],
        cluster_tree=result["cluster_tree"],
        membership_strength_layers=result["membership_strength_layers"],
        layer_persistence_scores=result["layer_persistence_scores"],
        min_cluster_sizes=result["min_cluster_sizes"],
    )

    if not quiet:
        print(
            json.dumps(
                {
                    "hierarchy_id": output_id,
                    "num_layers": len(result["cluster_label_layers"]),
                    "best_layer": int(result["best_layer"]),
                    "layer_counts": [
                        int(labels[labels >= 0].max() + 1) if (labels >= 0).any() else 0
                        for labels in result["cluster_label_layers"]
                    ],
                },
                indent=2,
            )
        )

    return output_id


if __name__ == "__main__":
    main()
