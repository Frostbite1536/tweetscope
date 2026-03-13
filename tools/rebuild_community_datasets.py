#!/usr/bin/env python3
"""Reset and rebuild Community Archive datasets with less manual cleanup.

This script is intentionally orchestration-only: it purges local/cloud state,
runs the existing `latentscope.scripts.twitter_import` pipeline, and then syncs
the resulting local catalog to the configured cloud catalog.

Examples:
    # Preview a full local reset + targeted cloud purge for three usernames.
    uv run --env-file .env python3 tools/rebuild_community_datasets.py \
      cube_flipper defenderofbasic ivanvendrov \
      --wipe-non-target-local

    # Execute the reset/rebuild using the default dataset id = sanitized username.
    uv run --env-file .env python3 tools/rebuild_community_datasets.py \
      cube_flipper defenderofbasic ivanvendrov \
      --wipe-non-target-local \
      --purge-all-cloud \
      --execute

    # Rebuild from cached extracted payloads instead of direct Community Archive fetches.
    uv run --env-file .env python3 tools/rebuild_community_datasets.py \
      cube_flipper defenderofbasic \
      --community-json-dir ./archives/extracted \
      --execute
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import lancedb


REPO_ROOT = Path(__file__).resolve().parents[1]
SYNC_CATALOG_SCRIPT = REPO_ROOT / "tools" / "sync_catalog_to_cloud.py"
CATALOG_TABLES = ("system__datasets", "system__scopes")
RESERVED_DATA_DIR_NAMES = {"_catalog"}


@dataclass(frozen=True)
class TargetDataset:
    username: str
    dataset_id: str


def sanitize_dataset_id(value: str) -> str:
    lowered = value.strip().lower()
    lowered = re.sub(r"[^a-z0-9_-]+", "-", lowered)
    lowered = re.sub(r"-{2,}", "-", lowered).strip("-")
    if not lowered:
        raise ValueError(f"Invalid dataset id derived from {value!r}")
    return lowered


def parse_target(spec: str) -> TargetDataset:
    if "=" in spec:
        username_part, dataset_part = spec.split("=", 1)
    else:
        username_part, dataset_part = spec, ""
    username = username_part.strip()
    if not username:
        raise ValueError(f"Invalid target spec: {spec!r}")
    dataset_id = sanitize_dataset_id(dataset_part or username)
    return TargetDataset(username=username, dataset_id=dataset_id)


def sql_literal(raw: str) -> str:
    return "'" + raw.replace("'", "''") + "'"


def dataset_where_clause(dataset_ids: Iterable[str]) -> str:
    ordered = sorted({dataset_id for dataset_id in dataset_ids if dataset_id})
    if not ordered:
        raise ValueError("At least one dataset id is required")
    if len(ordered) == 1:
        return f"dataset_id = {sql_literal(ordered[0])}"
    joined = ", ".join(sql_literal(dataset_id) for dataset_id in ordered)
    return f"dataset_id IN ({joined})"


def expand_data_dir(data_dir: str | None) -> Path:
    if not data_dir:
        raise ValueError("Missing --data-dir and LATENT_SCOPE_DATA is not set")
    return Path(os.path.expanduser(data_dir))


def list_table_names(db) -> list[str]:
    try:
        return sorted(db.table_names(limit=10_000))
    except TypeError:
        return sorted(db.table_names())


def connect_cloud(uri: str, api_key: str | None):
    return lancedb.connect(uri, api_key=api_key) if api_key else lancedb.connect(uri)


def resolve_cloud_tables_target() -> tuple[str, str | None]:
    uri = os.environ.get("LANCEDB_URI")
    api_key = os.environ.get("LANCEDB_API_KEY")
    if not uri:
        raise ValueError("LANCEDB_URI must be set for cloud table purge/export")
    return uri, api_key


def resolve_cloud_catalog_target() -> tuple[str, str | None]:
    uri = os.environ.get("LANCEDB_CATALOG_URI") or os.environ.get("LANCEDB_URI")
    api_key = os.environ.get("LANCEDB_CATALOG_API_KEY") or os.environ.get("LANCEDB_API_KEY")
    if not uri:
        raise ValueError("LANCEDB_CATALOG_URI or LANCEDB_URI must be set for cloud catalog sync")
    return uri, api_key


def list_local_dataset_dirs(data_dir: Path) -> list[Path]:
    if not data_dir.exists():
        return []

    def is_dataset_dir(path: Path) -> bool:
        markers = (
            path / "meta.json",
            path / "input.parquet",
            path / "imports",
            path / "scopes",
        )
        return any(marker.exists() for marker in markers)

    return sorted(
        [
            child
            for child in data_dir.iterdir()
            if child.is_dir()
            and child.name not in RESERVED_DATA_DIR_NAMES
            and not child.name.startswith(".")
            and is_dataset_dir(child)
        ],
        key=lambda child: child.name,
    )


def print_header(title: str) -> None:
    print(f"\n=== {title} ===")


def remove_path(path: Path, *, execute: bool) -> None:
    print(f"{'DELETE' if execute else 'WOULD DELETE'} {path}")
    if execute and path.exists():
        shutil.rmtree(path)


def prune_catalog_rows(catalog_path: Path, dataset_ids: set[str], *, execute: bool, label: str) -> None:
    if not dataset_ids:
        return
    if not catalog_path.exists():
        print(f"{label}: no catalog at {catalog_path}")
        return

    db = lancedb.connect(str(catalog_path))
    existing = set(list_table_names(db))
    where = dataset_where_clause(dataset_ids)

    for table_name in CATALOG_TABLES:
        if table_name not in existing:
            continue
        table = db.open_table(table_name)
        df = table.to_pandas()
        if "dataset_id" not in df.columns:
            continue
        match_count = int(df["dataset_id"].astype(str).isin(dataset_ids).sum())
        print(f"{label}: {table_name} matching rows={match_count}")
        if execute and match_count:
            table.delete(where)


def purge_local_state(
    *,
    data_dir: Path,
    target_dataset_ids: set[str],
    purge_dataset_ids: set[str],
    wipe_non_target_local: bool,
    execute: bool,
) -> None:
    print_header("Local Purge")
    local_dirs = list_local_dataset_dirs(data_dir)
    print(f"local dataset dirs: {[path.name for path in local_dirs]}")

    dirs_to_remove: list[Path] = []
    if wipe_non_target_local:
        dirs_to_remove = local_dirs
    else:
        dirs_to_remove = [path for path in local_dirs if path.name in purge_dataset_ids]

    for path in dirs_to_remove:
        remove_path(path, execute=execute)

    catalog_path = data_dir / "_catalog" / "lancedb"
    if wipe_non_target_local:
        remove_path(catalog_path, execute=execute)
    else:
        prune_catalog_rows(
            catalog_path,
            purge_dataset_ids,
            execute=execute,
            label="local catalog",
        )

    if execute:
        data_dir.mkdir(parents=True, exist_ok=True)

    untouched = sorted(path.name for path in local_dirs if path.name not in {item.name for item in dirs_to_remove})
    if wipe_non_target_local:
        print(f"kept local datasets: {sorted(target_dataset_ids)} will be rebuilt from scratch")
    else:
        print(f"kept local datasets: {untouched}")


def purge_cloud_state(
    *,
    purge_dataset_ids: set[str],
    purge_all_cloud: bool,
    execute: bool,
) -> None:
    print_header("Cloud Purge")

    tables_uri, tables_api_key = resolve_cloud_tables_target()
    tables_db = connect_cloud(tables_uri, tables_api_key)
    all_tables = list_table_names(tables_db)

    if purge_all_cloud:
        tables_to_drop = [name for name in all_tables if not name.startswith("system__")]
    else:
        prefixes = tuple(f"{dataset_id}__" for dataset_id in sorted(purge_dataset_ids))
        tables_to_drop = [name for name in all_tables if prefixes and name.startswith(prefixes)]

    print(f"cloud table target: {tables_uri}")
    print(f"cloud tables to drop: {tables_to_drop}")
    if execute:
        for table_name in tables_to_drop:
            tables_db.drop_table(table_name)
            print(f"dropped cloud table: {table_name}")

    catalog_uri, catalog_api_key = resolve_cloud_catalog_target()
    catalog_db = connect_cloud(catalog_uri, catalog_api_key)
    catalog_tables = set(list_table_names(catalog_db))
    print(f"cloud catalog target: {catalog_uri}")

    if purge_all_cloud:
        for table_name in CATALOG_TABLES:
            if table_name not in catalog_tables:
                continue
            print(f"{'DROP' if execute else 'WOULD DROP'} cloud catalog table {table_name}")
            if execute:
                catalog_db.drop_table(table_name)
        return

    where = dataset_where_clause(purge_dataset_ids)
    for table_name in CATALOG_TABLES:
        if table_name not in catalog_tables:
            continue
        table = catalog_db.open_table(table_name)
        df = table.to_pandas()
        if "dataset_id" not in df.columns:
            continue
        match_count = int(df["dataset_id"].astype(str).isin(purge_dataset_ids).sum())
        print(f"cloud catalog: {table_name} matching rows={match_count}")
        if execute and match_count:
            table.delete(where)


def resolve_import_input(target: TargetDataset, community_json_dir: Path | None) -> tuple[str, list[str]]:
    if community_json_dir is None:
        return "community", ["--username", target.username]

    candidates = [
        community_json_dir / f"{target.username}.json",
        community_json_dir / f"{sanitize_dataset_id(target.username)}.json",
        community_json_dir / f"{target.dataset_id}.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return "community_json", ["--input_path", str(candidate)]
    raise FileNotFoundError(
        f"No extracted Community Archive payload found for {target.username!r} in {community_json_dir}"
    )


def run_command(command: list[str], *, execute: bool) -> None:
    print("$", shlex.join(command))
    if execute:
        subprocess.run(command, cwd=str(REPO_ROOT), check=True)


def rebuild_targets(
    *,
    targets: list[TargetDataset],
    community_json_dir: Path | None,
    import_args: list[str],
    python_executable: str,
    execute: bool,
) -> None:
    print_header("Rebuild")
    for target in targets:
        source, source_args = resolve_import_input(target, community_json_dir)
        command = [
            python_executable,
            "-m",
            "latentscope.scripts.twitter_import",
            target.dataset_id,
            "--source",
            source,
            "--run_pipeline",
            *source_args,
            *import_args,
        ]
        print(f"rebuilding {target.username} -> {target.dataset_id}")
        run_command(command, execute=execute)


def sync_catalog(*, data_dir: Path, python_executable: str, execute: bool) -> None:
    print_header("Catalog Sync")
    command = [
        python_executable,
        str(SYNC_CATALOG_SCRIPT),
        "--data-dir",
        str(data_dir),
    ]
    if execute:
        command.append("--execute")
    run_command(command, execute=execute)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Delete and rebuild one or more username-based datasets from Community Archive. "
            "Dry-run by default."
        )
    )
    parser.add_argument(
        "targets",
        nargs="+",
        help=(
            "Community Archive usernames to rebuild. "
            "Use 'username=dataset_id' to override the default dataset id."
        ),
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply deletes/imports/syncs. Without this flag the script only prints the plan.",
    )
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("LATENT_SCOPE_DATA", os.path.expanduser("~/latent-scope-data")),
        help="Local data root (defaults to LATENT_SCOPE_DATA, else ~/latent-scope-data).",
    )
    parser.add_argument(
        "--community-json-dir",
        type=str,
        help=(
            "Optional directory of extracted Community Archive payloads "
            "('{username}.json' or '{dataset_id}.json'). If omitted, imports use --source community."
        ),
    )
    parser.add_argument(
        "--wipe-non-target-local",
        action="store_true",
        help=(
            "Also delete every other local dataset directory and the local catalog before rebuilding "
            "the requested targets."
        ),
    )
    parser.add_argument(
        "--purge-cloud",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Delete matching cloud tables/catalog rows before rebuilding (default: enabled).",
    )
    parser.add_argument(
        "--purge-all-cloud",
        action="store_true",
        help=(
            "Drop all dataset-scoped cloud tables and both cloud catalog tables. "
            "Use this with care; it is broader than target-only purge."
        ),
    )
    parser.add_argument(
        "--purge-likes-siblings",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Also purge '{dataset}-likes' siblings so posted-tweets-only rebuilds do not leave stale likes datasets "
            "behind (default: enabled)."
        ),
    )
    parser.add_argument(
        "--sync-catalog",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Sync the resulting local catalog to cloud at the end (default: enabled).",
    )
    parser.add_argument(
        "--python-executable",
        default=sys.executable,
        help="Python executable to use for subprocess calls (default: current interpreter).",
    )
    parser.add_argument(
        "--import-arg",
        action="append",
        default=[],
        help=(
            "Extra raw argument to forward to latentscope.scripts.twitter_import. "
            "Repeat for multiple flags, e.g. --import-arg=--toponymy-model=gpt-5-mini."
        ),
    )
    return parser.parse_args()


def validate_targets(targets: list[TargetDataset]) -> None:
    dataset_ids = [target.dataset_id for target in targets]
    if len(dataset_ids) != len(set(dataset_ids)):
        raise ValueError(f"Duplicate dataset ids requested: {dataset_ids}")


def main() -> None:
    args = parse_args()
    data_dir = expand_data_dir(args.data_dir)
    community_json_dir = (
        Path(os.path.expanduser(args.community_json_dir)) if args.community_json_dir else None
    )
    targets = [parse_target(spec) for spec in args.targets]
    validate_targets(targets)

    target_dataset_ids = {target.dataset_id for target in targets}
    purge_dataset_ids = set(target_dataset_ids)
    if args.purge_likes_siblings:
        purge_dataset_ids.update(f"{dataset_id}-likes" for dataset_id in target_dataset_ids)

    print_header("Targets")
    for target in targets:
        print(f"{target.username} -> {target.dataset_id}")
    print(f"purge dataset ids: {sorted(purge_dataset_ids)}")
    print(f"data dir: {data_dir}")
    if community_json_dir:
        print(f"community json dir: {community_json_dir}")

    purge_local_state(
        data_dir=data_dir,
        target_dataset_ids=target_dataset_ids,
        purge_dataset_ids=purge_dataset_ids,
        wipe_non_target_local=args.wipe_non_target_local,
        execute=args.execute,
    )

    if args.purge_cloud:
        purge_cloud_state(
            purge_dataset_ids=purge_dataset_ids,
            purge_all_cloud=args.purge_all_cloud,
            execute=args.execute,
        )

    rebuild_targets(
        targets=targets,
        community_json_dir=community_json_dir,
        import_args=args.import_arg,
        python_executable=args.python_executable,
        execute=args.execute,
    )

    if args.sync_catalog:
        sync_catalog(
            data_dir=data_dir,
            python_executable=args.python_executable,
            execute=args.execute,
        )


if __name__ == "__main__":
    main()
