"""Backfill the LanceDB catalog registry from existing JSON sidecar files.

Reads meta.json (dataset) and scopes/*.json (scope) from the data directory,
then upserts each into the system__datasets / system__scopes registry tables.

Usage:
    # Dry-run (default) — shows what would be written, writes nothing
    uv run python3 tools/backfill_catalog_registry.py

    # Execute the backfill
    uv run python3 tools/backfill_catalog_registry.py --execute

    # Mark specific datasets as public
    uv run python3 tools/backfill_catalog_registry.py --execute \
        --public-datasets visakanv-tweets,patrick-tweets

    # Set explicit active scope for a dataset
    uv run python3 tools/backfill_catalog_registry.py --execute \
        --set-active-scope visakanv-tweets:scopes-002

    # Verify registry vs JSON parity
    uv run python3 tools/backfill_catalog_registry.py --verify
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from typing import Any


def _load_json_safe(path: str) -> dict[str, Any] | None:
    """Load a JSON file, sanitizing NaN/Inf values. Returns None on failure."""
    try:
        with open(path) as f:
            text = f.read()
        # Replace NaN/Infinity literals that Python's json rejects
        text = re.sub(r"\bNaN\b", "null", text)
        text = re.sub(r"\bInfinity\b", "null", text)
        text = re.sub(r"\b-Infinity\b", "null", text)
        return json.loads(text)
    except Exception as e:
        print(f"  WARNING: failed to load {path}: {e}")
        return None


def _scrub_nan(obj: Any) -> Any:
    """Recursively replace NaN/Inf floats with None."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    elif isinstance(obj, dict):
        return {k: _scrub_nan(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_scrub_nan(v) for v in obj]
    return obj


def discover_datasets(data_dir: str) -> list[str]:
    """Find all dataset directories that contain a meta.json."""
    datasets = []
    for entry in sorted(os.listdir(data_dir)):
        if entry.startswith("_") or entry.startswith("."):
            continue
        meta_path = os.path.join(data_dir, entry, "meta.json")
        if os.path.isfile(meta_path):
            datasets.append(entry)
    return datasets


def discover_scopes(data_dir: str, dataset_id: str) -> list[str]:
    """Find all scope JSON files for a dataset."""
    scopes_dir = os.path.join(data_dir, dataset_id, "scopes")
    if not os.path.isdir(scopes_dir):
        return []
    scopes = []
    for fname in sorted(os.listdir(scopes_dir)):
        if fname.endswith(".json") and not fname.endswith("-input.json"):
            scopes.append(fname[:-5])  # strip .json
    return scopes


def run_backfill(
    data_dir: str,
    *,
    execute: bool = False,
    public_datasets: set[str] | None = None,
    active_scope_overrides: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Backfill registry from JSON sidecars.

    Returns a summary dict with counts.
    """
    from latentscope.pipeline.catalog_registry import (
        upsert_dataset_meta,
        upsert_scope_meta,
    )

    public_datasets = public_datasets or set()
    active_scope_overrides = active_scope_overrides or {}

    datasets = discover_datasets(data_dir)
    summary = {
        "datasets_found": len(datasets),
        "datasets_upserted": 0,
        "scopes_found": 0,
        "scopes_upserted": 0,
        "errors": [],
    }

    for dataset_id in datasets:
        meta_path = os.path.join(data_dir, dataset_id, "meta.json")
        meta = _load_json_safe(meta_path)
        if meta is None:
            summary["errors"].append(f"dataset:{dataset_id}:meta.json load failed")
            continue

        meta = _scrub_nan(meta)
        visibility = "public" if dataset_id in public_datasets else "private"

        # Discover scopes to find the latest for active_scope_id
        scope_ids = discover_scopes(data_dir, dataset_id)
        summary["scopes_found"] += len(scope_ids)

        # Determine active_scope_id
        active_scope_id = active_scope_overrides.get(dataset_id, "")
        if not active_scope_id and scope_ids:
            # Default to the latest scope
            active_scope_id = scope_ids[-1]

        print(f"\nDataset: {dataset_id}")
        print(f"  visibility: {visibility}")
        print(f"  active_scope_id: {active_scope_id or '(none)'}")
        print(f"  scopes: {len(scope_ids)}")

        if execute:
            try:
                upsert_dataset_meta(
                    data_dir,
                    dataset_id=dataset_id,
                    meta=meta,
                    visibility=visibility,
                    active_scope_id=active_scope_id,
                )
                summary["datasets_upserted"] += 1
            except Exception as e:
                msg = f"dataset:{dataset_id}:upsert failed: {e}"
                print(f"  ERROR: {msg}")
                summary["errors"].append(msg)
                continue
        else:
            summary["datasets_upserted"] += 1

        # Upsert each scope
        for scope_id in scope_ids:
            scope_path = os.path.join(data_dir, dataset_id, "scopes", f"{scope_id}.json")
            scope_meta = _load_json_safe(scope_path)
            if scope_meta is None:
                msg = f"scope:{dataset_id}/{scope_id}:json load failed"
                print(f"  WARNING: {msg}")
                summary["errors"].append(msg)
                continue

            scope_meta = _scrub_nan(scope_meta)
            is_active = scope_id == active_scope_id

            print(f"  Scope: {scope_id} (active={is_active})")

            if execute:
                try:
                    upsert_scope_meta(
                        data_dir,
                        dataset_id=dataset_id,
                        scope_id=scope_id,
                        scope_meta=scope_meta,
                        is_active=is_active,
                    )
                    summary["scopes_upserted"] += 1
                except Exception as e:
                    msg = f"scope:{dataset_id}/{scope_id}:upsert failed: {e}"
                    print(f"  ERROR: {msg}")
                    summary["errors"].append(msg)
            else:
                summary["scopes_upserted"] += 1

    return summary


def run_verify(data_dir: str) -> bool:
    """Verify registry parity with JSON sidecars. Returns True if all match."""
    from latentscope.pipeline.catalog_registry import (
        ensure_catalog_tables,
    )

    ds_tbl, sc_tbl = ensure_catalog_tables(data_dir)

    datasets = discover_datasets(data_dir)
    all_ok = True

    # Check datasets
    for dataset_id in datasets:
        try:
            rows = ds_tbl.search().where(
                f"dataset_id = '{dataset_id}'"
            ).limit(1).to_list()
        except Exception:
            rows = []

        if not rows:
            print(f"MISSING dataset in registry: {dataset_id}")
            all_ok = False
            continue

        row = rows[0]
        print(f"OK dataset: {dataset_id} (visibility={row.get('visibility')}, "
              f"active_scope={row.get('active_scope_id')})")

        # Check scopes
        scope_ids = discover_scopes(data_dir, dataset_id)
        for scope_id in scope_ids:
            scope_pk = f"{dataset_id}:{scope_id}"
            try:
                scope_rows = sc_tbl.search().where(
                    f"scope_pk = '{scope_pk}'"
                ).limit(1).to_list()
            except Exception:
                scope_rows = []

            if not scope_rows:
                print(f"  MISSING scope in registry: {scope_id}")
                all_ok = False
            else:
                sr = scope_rows[0]
                print(f"  OK scope: {scope_id} (active={sr.get('is_active')}, "
                      f"table={sr.get('lancedb_table_id')})")

    if all_ok:
        print("\nAll JSON sidecars have matching registry entries.")
    else:
        print("\nSome entries are missing from the registry. Run with --execute to backfill.")

    return all_ok


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill LanceDB catalog registry from JSON sidecar files."
    )
    parser.add_argument(
        "--data-dir",
        type=str,
        default=None,
        help="Data directory (defaults to LATENT_SCOPE_DATA env var)",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually write to the registry (default is dry-run)",
    )
    parser.add_argument(
        "--public-datasets",
        type=str,
        default="",
        help="Comma-separated list of dataset IDs to mark as public",
    )
    parser.add_argument(
        "--set-active-scope",
        type=str,
        action="append",
        default=[],
        help="Set active scope: DATASET_ID:SCOPE_ID (can be repeated)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify registry parity with JSON sidecars (no writes)",
    )
    args = parser.parse_args()

    data_dir = args.data_dir or os.environ.get("LATENT_SCOPE_DATA")
    if not data_dir:
        print("ERROR: --data-dir or LATENT_SCOPE_DATA must be set", file=sys.stderr)
        sys.exit(1)
    data_dir = os.path.expanduser(data_dir)

    if args.verify:
        ok = run_verify(data_dir)
        sys.exit(0 if ok else 1)

    public_datasets = set()
    if args.public_datasets:
        public_datasets = {d.strip() for d in args.public_datasets.split(",") if d.strip()}

    active_scope_overrides: dict[str, str] = {}
    for pair in args.set_active_scope:
        if ":" not in pair:
            print(f"ERROR: --set-active-scope requires DATASET_ID:SCOPE_ID, got: {pair}", file=sys.stderr)
            sys.exit(1)
        ds, sc = pair.split(":", 1)
        active_scope_overrides[ds.strip()] = sc.strip()

    mode = "EXECUTE" if args.execute else "DRY-RUN"
    print(f"=== Catalog Registry Backfill ({mode}) ===")
    print(f"Data dir: {data_dir}")
    if public_datasets:
        print(f"Public datasets: {', '.join(sorted(public_datasets))}")
    if active_scope_overrides:
        for ds, sc in active_scope_overrides.items():
            print(f"Active scope override: {ds} -> {sc}")
    print()

    summary = run_backfill(
        data_dir,
        execute=args.execute,
        public_datasets=public_datasets,
        active_scope_overrides=active_scope_overrides,
    )

    print(f"\n=== Summary ===")
    print(f"Datasets found: {summary['datasets_found']}")
    print(f"Datasets upserted: {summary['datasets_upserted']}")
    print(f"Scopes found: {summary['scopes_found']}")
    print(f"Scopes upserted: {summary['scopes_upserted']}")
    if summary["errors"]:
        print(f"Errors ({len(summary['errors'])}):")
        for err in summary["errors"]:
            print(f"  - {err}")

    if not args.execute:
        print("\nThis was a DRY-RUN. Use --execute to write to the registry.")


if __name__ == "__main__":
    main()
