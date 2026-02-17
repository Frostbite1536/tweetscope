"""Catalog registry: scope and dataset metadata in LanceDB.

Provides ensure/upsert operations for the system__datasets and system__scopes
registry tables.  Used by the pipeline (scope_runner, twitter_import) and the
backfill migration script.

Tables live in a dedicated catalog DB:
  - Local:  ${LATENT_SCOPE_DATA}/_catalog/lancedb
  - Cloud:  LANCEDB_CATALOG_URI (falls back to LANCEDB_URI)
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from typing import Any

import pandas as pd

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

_REQUIRED_DATASET_FIELDS = {"dataset_id", "visibility", "meta_json"}
_REQUIRED_SCOPE_FIELDS = {"scope_pk", "dataset_id", "scope_id", "meta_json"}


def _validate_no_nan(obj: Any, path: str = "") -> None:
    """Raise ValueError if any float value is NaN or Inf."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            raise ValueError(f"NaN/Inf float at {path!r}: {obj}")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            _validate_no_nan(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            _validate_no_nan(v, f"{path}[{i}]")


def _scrub_nan(obj: Any) -> Any:
    """Replace NaN/Inf floats with None so JSON serialization succeeds."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _scrub_nan(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_scrub_nan(v) for v in obj]
    return obj


def _safe_json_dumps(meta: dict) -> str:
    """Serialize metadata to JSON, converting NaN/Inf to null."""
    clean = _scrub_nan(meta)
    return json.dumps(clean, allow_nan=False)


def _sql_literal(raw: str) -> str:
    return "'" + raw.replace("'", "''") + "'"


def _get_existing_row(table, where: str) -> dict[str, Any] | None:
    try:
        rows = table.search().where(where).limit(1).to_list()
    except Exception:
        return None
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------


def _get_catalog_db_uri(data_dir: str | None = None) -> str:
    """Return the local catalog DB path."""
    if data_dir is None:
        data_dir = os.environ.get("LATENT_SCOPE_DATA")
    if not data_dir:
        raise RuntimeError("LATENT_SCOPE_DATA must be set for local catalog")
    data_dir = os.path.expanduser(data_dir)
    catalog_subdir = os.environ.get(
        "LATENT_SCOPE_CATALOG_LOCAL_PATH", "_catalog/lancedb"
    )
    return os.path.join(data_dir, catalog_subdir)


def get_catalog_db(data_dir: str | None = None, *, cloud: bool = False):
    """Open or create the catalog LanceDB connection.

    Returns a lancedb.Connection (local or cloud).
    """
    import lancedb

    if cloud:
        uri = os.environ.get("LANCEDB_CATALOG_URI") or os.environ.get("LANCEDB_URI")
        api_key = os.environ.get("LANCEDB_CATALOG_API_KEY") or os.environ.get(
            "LANCEDB_API_KEY"
        )
        if not uri:
            raise RuntimeError(
                "LANCEDB_CATALOG_URI or LANCEDB_URI must be set for cloud catalog"
            )
        return lancedb.connect(uri, api_key=api_key) if api_key else lancedb.connect(uri)

    db_uri = _get_catalog_db_uri(data_dir)
    os.makedirs(db_uri, exist_ok=True)
    return lancedb.connect(db_uri)


# ---------------------------------------------------------------------------
# Table schemas
# ---------------------------------------------------------------------------

_DATASETS_TABLE = "system__datasets"
_SCOPES_TABLE = "system__scopes"

_DATASETS_SCHEMA = {
    "dataset_id": [""],
    "owner_id": [""],
    "visibility": ["private"],
    "active_scope_id": [""],
    "row_count": [0],
    "updated_at": [""],
    "meta_json": [""],
}

_SCOPES_SCHEMA = {
    "scope_pk": [""],
    "dataset_id": [""],
    "scope_id": [""],
    "lancedb_table_id": [""],
    "is_active": [False],
    "hierarchical_labels": [False],
    "unknown_count": [0],
    "embedding_model_id": [""],
    "updated_at": [""],
    "meta_json": [""],
}


def _open_or_create(db, table_name: str, schema: dict) -> Any:
    """Open a table if it exists, otherwise create it with indexes."""
    existing_tables = set(db.table_names(limit=1000))
    if table_name in existing_tables:
        return db.open_table(table_name)

    # Create with a seed row that we immediately delete
    seed_df = pd.DataFrame(schema)
    tbl = db.create_table(table_name, seed_df)
    # Remove the seed row
    if table_name == _DATASETS_TABLE:
        tbl.delete("dataset_id = ''")
    else:
        tbl.delete("scope_pk = ''")

    # Create indexes
    if table_name == _DATASETS_TABLE:
        tbl.create_scalar_index("dataset_id", index_type="BTREE")
        tbl.create_scalar_index("visibility", index_type="BITMAP")
    elif table_name == _SCOPES_TABLE:
        tbl.create_scalar_index("scope_pk", index_type="BTREE")
        tbl.create_scalar_index("dataset_id", index_type="BTREE")
        tbl.create_scalar_index("lancedb_table_id", index_type="BTREE")

    return tbl


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def ensure_catalog_tables(data_dir: str | None = None, *, cloud: bool = False):
    """Open or create both registry tables. Returns (datasets_table, scopes_table)."""
    db = get_catalog_db(data_dir, cloud=cloud)
    ds_tbl = _open_or_create(db, _DATASETS_TABLE, _DATASETS_SCHEMA)
    sc_tbl = _open_or_create(db, _SCOPES_TABLE, _SCOPES_SCHEMA)
    return ds_tbl, sc_tbl


def upsert_dataset_meta(
    data_dir: str | None = None,
    *,
    dataset_id: str,
    meta: dict,
    visibility: str | None = None,
    owner_id: str | None = None,
    active_scope_id: str | None = None,
    cloud: bool = False,
) -> None:
    """Upsert a dataset row in the system__datasets registry."""
    meta_json = _safe_json_dumps(meta)
    db = get_catalog_db(data_dir, cloud=cloud)
    tbl = _open_or_create(db, _DATASETS_TABLE, _DATASETS_SCHEMA)

    existing = _get_existing_row(
        tbl, f"dataset_id = {_sql_literal(dataset_id)}"
    )
    resolved_visibility = (
        visibility
        if visibility is not None
        else str((existing or {}).get("visibility", "private"))
    )
    resolved_owner = (
        owner_id
        if owner_id is not None
        else str((existing or {}).get("owner_id", ""))
    )
    resolved_active_scope = (
        active_scope_id
        if active_scope_id is not None
        else str((existing or {}).get("active_scope_id", ""))
    )

    row_count = meta.get("length")
    if row_count is None:
        row_count = (existing or {}).get("row_count", 0)
    row_count = int(row_count or 0)

    row = pd.DataFrame(
        [
            {
                "dataset_id": dataset_id,
                "owner_id": resolved_owner,
                "visibility": resolved_visibility,
                "active_scope_id": resolved_active_scope,
                "row_count": row_count,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "meta_json": meta_json,
            }
        ]
    )

    for field in _REQUIRED_DATASET_FIELDS:
        if field not in row.columns or row[field].iloc[0] in (None, ""):
            if field == "meta_json":
                raise ValueError(f"Missing required field: {field}")

    result = (
        tbl.merge_insert("dataset_id")
        .when_matched_update_all()
        .when_not_matched_insert_all()
        .execute(row)
    )
    if result:
        print(
            f"upsert_dataset_meta({dataset_id}): "
            f"inserted={result.num_inserted_rows}, updated={result.num_updated_rows}"
        )
    else:
        print(f"upsert_dataset_meta({dataset_id}): done")


def upsert_scope_meta(
    data_dir: str | None = None,
    *,
    dataset_id: str,
    scope_id: str,
    scope_meta: dict,
    is_active: bool = False,
    cloud: bool = False,
) -> None:
    """Upsert a scope row in the system__scopes registry."""
    meta_json = _safe_json_dumps(scope_meta)
    scope_pk = f"{dataset_id}:{scope_id}"

    embedding_model_id = ""
    emb = scope_meta.get("embedding")
    if isinstance(emb, dict):
        embedding_model_id = emb.get("model_id", "")

    db = get_catalog_db(data_dir, cloud=cloud)
    tbl = _open_or_create(db, _SCOPES_TABLE, _SCOPES_SCHEMA)
    lancedb_table_id = scope_meta.get("lancedb_table_id")
    if not lancedb_table_id:
        raise ValueError(
            f"Scope {dataset_id}:{scope_id} is missing required lancedb_table_id"
        )

    row = pd.DataFrame(
        [
            {
                "scope_pk": scope_pk,
                "dataset_id": dataset_id,
                "scope_id": scope_id,
                "lancedb_table_id": lancedb_table_id,
                "is_active": is_active,
                "hierarchical_labels": bool(
                    scope_meta.get("hierarchical_labels", False)
                ),
                "unknown_count": int(scope_meta.get("unknown_count", 0)),
                "embedding_model_id": embedding_model_id,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "meta_json": meta_json,
            }
        ]
    )

    for field in _REQUIRED_SCOPE_FIELDS:
        if field not in row.columns:
            raise ValueError(f"Missing required field: {field}")

    if is_active:
        tbl.update(
            where=(
                f"dataset_id = {_sql_literal(dataset_id)} "
                f"AND scope_pk != {_sql_literal(scope_pk)}"
            ),
            values={"is_active": False},
        )

    result = (
        tbl.merge_insert("scope_pk")
        .when_matched_update_all()
        .when_not_matched_insert_all()
        .execute(row)
    )
    if result:
        print(
            f"upsert_scope_meta({scope_pk}): "
            f"inserted={result.num_inserted_rows}, updated={result.num_updated_rows}"
        )
    else:
        print(f"upsert_scope_meta({scope_pk}): done")
