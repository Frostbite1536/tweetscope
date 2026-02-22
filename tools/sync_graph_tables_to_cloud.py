#!/usr/bin/env python3
"""Export graph LanceDB tables (edges + node_stats) to LanceDB Cloud.

Usage:
    uv run --env-file .env python3 tools/sync_graph_tables_to_cloud.py --execute
    uv run --env-file .env python3 tools/sync_graph_tables_to_cloud.py --dataset patio11-tweets --execute
"""

import argparse
import os

import lancedb


def sync_graph_tables(data_dir: str, dataset_id: str, cloud_db: lancedb.DBConnection, dry_run: bool = True):
    """Copy edges and node_stats tables from local to cloud."""
    local_db_path = os.path.join(data_dir, dataset_id, "lancedb")
    if not os.path.isdir(local_db_path):
        print(f"  SKIP {dataset_id}: no local lancedb dir")
        return

    local_db = lancedb.connect(local_db_path)
    local_tables = local_db.table_names()

    for suffix in ("edges", "node_stats"):
        table_name = f"{dataset_id}__{suffix}"
        if table_name not in local_tables:
            print(f"  SKIP {table_name}: not in local DB")
            continue

        local_tbl = local_db.open_table(table_name)
        row_count = local_tbl.count_rows()
        print(f"  {table_name}: {row_count} rows", end="")

        if row_count == 0:
            print(" (empty, skipping)")
            continue

        if dry_run:
            print(" (dry run)")
            continue

        # Write to cloud
        df = local_tbl.to_pandas()
        cloud_tbl = cloud_db.create_table(table_name, df, mode="overwrite")

        # Recreate scalar indexes
        if suffix == "edges":
            for col in ("src_tweet_id", "dst_tweet_id", "edge_kind", "internal_target"):
                if col in df.columns:
                    cloud_tbl.create_scalar_index(col, index_type="BTREE")
        elif suffix == "node_stats":
            for col in ("tweet_id", "ls_index", "thread_root_id"):
                if col in df.columns:
                    cloud_tbl.create_scalar_index(col, index_type="BTREE")

        print(f" -> synced to cloud with indexes")


def main():
    parser = argparse.ArgumentParser(description="Sync graph tables to LanceDB Cloud")
    parser.add_argument("--execute", action="store_true", help="Actually write to cloud (default: dry run)")
    parser.add_argument("--dataset", type=str, help="Sync a single dataset (default: all from catalog)")
    parser.add_argument("--data-dir", default=os.environ.get("LATENT_SCOPE_DATA", os.path.expanduser("~/latent-scope-data")))
    args = parser.parse_args()

    data_dir = os.path.expanduser(args.data_dir)

    cloud_uri = os.environ.get("LANCEDB_URI")
    cloud_key = os.environ.get("LANCEDB_API_KEY")
    if not cloud_uri or not cloud_key:
        raise ValueError("LANCEDB_URI and LANCEDB_API_KEY env vars required")

    cloud_db = lancedb.connect(cloud_uri, api_key=cloud_key)

    if args.dataset:
        datasets = [args.dataset]
    else:
        # Get all public datasets from catalog
        catalog_path = os.path.join(data_dir, "_catalog", "lancedb")
        catalog_db = lancedb.connect(catalog_path)
        ds_tbl = catalog_db.open_table("system__datasets")
        ds_df = ds_tbl.search().where("visibility = 'public'").to_pandas()
        datasets = ds_df["dataset_id"].tolist()

    mode = "DRY RUN" if not args.execute else "EXECUTE"
    print(f"[{mode}] Syncing graph tables for {len(datasets)} dataset(s) to {cloud_uri}\n")

    for ds in datasets:
        print(f"=== {ds} ===")
        sync_graph_tables(data_dir, ds, cloud_db, dry_run=not args.execute)
        print()

    if not args.execute:
        print("Pass --execute to actually write to cloud.")


if __name__ == "__main__":
    main()
