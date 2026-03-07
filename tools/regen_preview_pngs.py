#!/usr/bin/env python3
"""Regenerate UMAP and cluster preview PNGs with transparent backgrounds.

Walks existing dataset directories and re-plots from saved parquet data.
Usage: uv run python3 tools/regen_preview_pngs.py [DATA_DIR]
"""
import os
import sys
import json
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy.spatial import ConvexHull


def calculate_point_size(n_points):
    if n_points < 100:
        return 8
    elif n_points < 1000:
        return 4
    elif n_points < 10000:
        return 2
    else:
        return 1


def regen_umap_png(parquet_path, png_path):
    df = pd.read_parquet(parquet_path)
    if 'x' not in df.columns or 'y' not in df.columns:
        print(f"  skip {parquet_path} (no x/y columns)")
        return
    embeddings = df[['x', 'y']].values
    fig, ax = plt.subplots(figsize=(14.22, 14.22), facecolor='none')
    ax.set_facecolor('none')
    point_size = calculate_point_size(len(embeddings))
    plt.scatter(embeddings[:, 0], embeddings[:, 1], s=point_size, alpha=0.5)
    plt.axis('off')
    plt.gca().set_position([0, 0, 1, 1])
    plt.savefig(png_path, transparent=True)
    plt.close(fig)
    print(f"  regen {png_path}")


def regen_cluster_png(parquet_path, png_path, umap_parquet_path):
    cluster_df = pd.read_parquet(parquet_path)
    if 'cluster' not in cluster_df.columns:
        print(f"  skip {parquet_path} (no cluster column)")
        return
    if not os.path.exists(umap_parquet_path):
        print(f"  skip {parquet_path} (no umap parquet at {umap_parquet_path})")
        return
    umap_df = pd.read_parquet(umap_parquet_path)
    if 'x' not in umap_df.columns or 'y' not in umap_df.columns:
        print(f"  skip (umap has no x/y)")
        return
    embeddings = umap_df[['x', 'y']].values
    cluster_labels = cluster_df['cluster'].values

    fig, ax = plt.subplots(figsize=(14.22, 14.22), facecolor='none')
    ax.set_facecolor('none')
    point_size = calculate_point_size(len(embeddings))
    plt.scatter(embeddings[:, 0], embeddings[:, 1], s=point_size, alpha=0.5,
                c=cluster_labels, cmap='Spectral')

    non_noise = [l for l in set(cluster_labels) if l >= 0]
    for label in non_noise:
        indices = np.where(cluster_labels == label)[0]
        if len(indices) < 3:
            continue
        points = embeddings[indices]
        try:
            hull = ConvexHull(points)
            for simplex in hull.simplices:
                plt.plot(points[simplex, 0], points[simplex, 1], 'k-', alpha=0.3)
        except Exception:
            pass

    plt.axis('off')
    plt.gca().set_position([0, 0, 1, 1])
    plt.savefig(png_path, transparent=True)
    plt.close(fig)
    print(f"  regen {png_path}")


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/latent-scope-data")
    if not os.path.isdir(data_dir):
        print(f"Data dir not found: {data_dir}")
        sys.exit(1)

    for dataset_id in sorted(os.listdir(data_dir)):
        dataset_dir = os.path.join(data_dir, dataset_id)
        umap_dir = os.path.join(dataset_dir, "umaps")
        cluster_dir = os.path.join(dataset_dir, "clusters")

        if not os.path.isdir(dataset_dir):
            continue

        print(f"\n{dataset_id}")

        # Regen UMAP PNGs
        if os.path.isdir(umap_dir):
            for f in sorted(os.listdir(umap_dir)):
                if f.endswith('.png'):
                    umap_id = f.replace('.png', '')
                    parquet = os.path.join(umap_dir, f"{umap_id}.parquet")
                    if os.path.exists(parquet):
                        regen_umap_png(parquet, os.path.join(umap_dir, f))

        # Regen cluster PNGs
        if os.path.isdir(cluster_dir):
            for f in sorted(os.listdir(cluster_dir)):
                if f.endswith('.png'):
                    cluster_id = f.replace('.png', '')
                    parquet = os.path.join(cluster_dir, f"{cluster_id}.parquet")
                    meta_path = os.path.join(cluster_dir, f"{cluster_id}.json")
                    if not os.path.exists(parquet) or not os.path.exists(meta_path):
                        continue
                    with open(meta_path) as mf:
                        meta = json.load(mf)
                    umap_id = meta.get("umap_id", "")
                    umap_parquet = os.path.join(umap_dir, f"{umap_id}.parquet")
                    regen_cluster_png(parquet, os.path.join(cluster_dir, f), umap_parquet)


if __name__ == "__main__":
    main()
