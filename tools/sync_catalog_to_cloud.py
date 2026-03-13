#!/usr/bin/env python3
"""Sync local catalog tables (system__datasets, system__scopes) to LanceDB Cloud.

Reads from local catalog at ${LATENT_SCOPE_DATA}/_catalog/lancedb and
creates/replaces tables in LanceDB Cloud using:
  - LANCEDB_CATALOG_URI / LANCEDB_CATALOG_API_KEY when set
  - otherwise LANCEDB_URI / LANCEDB_API_KEY

Usage:
    uv run --env-file .env python3 tools/sync_catalog_to_cloud.py          # dry-run
    uv run --env-file .env python3 tools/sync_catalog_to_cloud.py --execute # upload
"""

from __future__ import annotations

import argparse
import os

import lancedb


TABLE_NAMES = ("system__datasets", "system__scopes")


def resolve_catalog_cloud_target() -> tuple[str, str | None]:
    """Match runtime catalog resolution: catalog-specific env first, main env as fallback."""
    uri = os.environ.get("LANCEDB_CATALOG_URI") or os.environ.get("LANCEDB_URI")
    api_key = os.environ.get("LANCEDB_CATALOG_API_KEY") or os.environ.get("LANCEDB_API_KEY")
    if not uri:
        raise ValueError("LANCEDB_CATALOG_URI or LANCEDB_URI must be set")
    return uri, api_key


def resolve_local_catalog_path(data_dir: str | None) -> str:
    if not data_dir:
        raise ValueError("Missing --data-dir and LATENT_SCOPE_DATA is not set")
    return os.path.join(os.path.expanduser(data_dir), "_catalog", "lancedb")


def summarize_catalog(local: lancedb.DBConnection) -> None:
    for name in TABLE_NAMES:
        t = local.open_table(name)
        data = t.to_pandas()
        print(f"\n--- {name} ({len(data)} rows) ---")

        if name == "system__datasets":
            for _, row in data.iterrows():
                print(f"  {row['dataset_id']} ({row['visibility']}, {row['row_count']} rows)")
        elif name == "system__scopes":
            for _, row in data.iterrows():
                print(f"  {row['scope_pk']} -> {row['lancedb_table_id']}")


def sync_catalog(*, data_dir: str, execute: bool) -> None:
    catalog_path = resolve_local_catalog_path(data_dir)
    uri, api_key = resolve_catalog_cloud_target()

    local = lancedb.connect(catalog_path)
    summarize_catalog(local)

    if not execute:
        print("\nDry-run complete. Re-run with --execute to sync to cloud.")
        return

    print(f"\nConnecting to LanceDB Cloud: {uri}")
    cloud = lancedb.connect(uri, api_key=api_key) if api_key else lancedb.connect(uri)

    for name in TABLE_NAMES:
        t = local.open_table(name)
        data = t.to_pandas()
        try:
            cloud.drop_table(name)
            print(f"Dropped existing cloud table: {name}")
        except Exception:
            pass
        cloud.create_table(name, data)
        print(f"Created cloud table: {name} ({len(data)} rows)")

    print("\nSync complete.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync local catalog to LanceDB Cloud")
    parser.add_argument("--execute", action="store_true", help="Actually sync (default: dry-run)")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("LATENT_SCOPE_DATA"),
        help="Root data directory",
    )
    args = parser.parse_args()

    sync_catalog(data_dir=args.data_dir, execute=args.execute)


if __name__ == "__main__":
    main()
