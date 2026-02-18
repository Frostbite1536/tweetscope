"""Dataset ingest utilities used by the import pipeline."""

from __future__ import annotations

import argparse
import json
import os
from typing import Any

import numpy as np
import pandas as pd

from latentscope.__version__ import __version__
from latentscope.util import get_data_dir


def _read_input_file(file_path: str) -> pd.DataFrame:
    file_type = file_path.rsplit(".", 1)[-1].lower()
    if file_type == "csv":
        return pd.read_csv(file_path)
    if file_type == "parquet":
        return pd.read_parquet(file_path)
    if file_type == "jsonl":
        return pd.read_json(file_path, lines=True, convert_dates=False)
    if file_type == "json":
        return pd.read_json(file_path, convert_dates=False)
    if file_type == "xlsx":
        return pd.read_excel(file_path)
    raise ValueError(f"Unsupported file type: {file_type}")


def _ensure_ls_index(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if "ls_index" in out.columns:
        ls_index = pd.to_numeric(out["ls_index"], errors="coerce")
    elif "index" in out.columns:
        ls_index = pd.to_numeric(out["index"], errors="coerce")
    else:
        out["ls_index"] = np.arange(len(out), dtype=np.int64)
        return out

    if ls_index.isna().any():
        raise ValueError("Column 'ls_index' contains null/non-numeric values")
    ls_index = ls_index.astype(np.int64)
    if ls_index.duplicated().any():
        raise ValueError("Column 'ls_index' contains duplicate values")
    out["ls_index"] = ls_index
    return out


def _is_numeric_list(value: Any) -> bool:
    if isinstance(value, np.ndarray):
        return True
    if not isinstance(value, list):
        return False
    return all(isinstance(item, (int, float, np.integer, np.floating)) for item in value)


def _infer_column_type(series: pd.Series) -> str:
    non_null = series.dropna()
    if non_null.empty:
        return "string"
    if pd.api.types.is_datetime64_any_dtype(non_null):
        return "date"
    if pd.api.types.is_numeric_dtype(non_null):
        return "number"
    sample = non_null.iloc[0]
    if _is_numeric_list(sample):
        return "array"
    return "string"


def _column_metadata(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    meta: dict[str, dict[str, Any]] = {}
    for col in df.columns:
        col_type = _infer_column_type(df[col])
        col_meta: dict[str, Any] = {"type": col_type}

        try:
            if col_type == "array":
                values = df[col].dropna().apply(
                    lambda v: tuple(v.tolist()) if isinstance(v, np.ndarray) else tuple(v)
                )
                unique_values_count = int(values.nunique())
            else:
                unique_values_count = int(df[col].nunique(dropna=True))
        except Exception:
            unique_values_count = -1
        col_meta["unique_values_count"] = unique_values_count

        if col_type == "string" and unique_values_count >= 0 and unique_values_count <= 100:
            counts = df[col].value_counts(dropna=True)
            col_meta["categories"] = counts.index.astype(str).tolist()
            col_meta["counts"] = {str(k): int(v) for k, v in counts.items()}

        if col_type == "number":
            extent = df[col].agg(["min", "max"]).replace([np.inf, -np.inf], np.nan).tolist()
            col_meta["extent"] = [None if pd.isna(v) else float(v) for v in extent]
        if col_type == "date":
            extent = df[col].agg(["min", "max"]).tolist()
            col_meta["extent"] = [v.isoformat() if pd.notna(v) else None for v in extent]

        meta[col] = col_meta
    return meta


def ingest_file(dataset_id: str, file_path: str | None, text_column: str | None = None) -> None:
    data_dir = get_data_dir()
    dataset_dir = os.path.join(data_dir, dataset_id)
    os.makedirs(dataset_dir, exist_ok=True)
    target_path = file_path or os.path.join(dataset_dir, "input.csv")
    df = _read_input_file(target_path)
    ingest(dataset_id, df, text_column=text_column)


def ingest(dataset_id: str, df: pd.DataFrame, text_column: str | None = None) -> None:
    data_dir = get_data_dir()
    dataset_dir = os.path.join(data_dir, dataset_id)
    os.makedirs(dataset_dir, exist_ok=True)

    out = df.copy().reset_index(drop=True)
    if "id" in out.columns:
        out["id"] = out["id"].astype(str)
    out = _ensure_ls_index(out)

    metadata = _column_metadata(out)
    if text_column is None:
        text_column = "text" if "text" in out.columns else None
    if text_column is None:
        text_column = next(
            (col for col, col_meta in metadata.items() if col_meta["type"] == "string"),
            None,
        )

    potential_embeddings = [
        col for col, col_meta in metadata.items() if col_meta["type"] == "array"
    ]

    # Columns with nullable IDs that should preserve nulls (not coerce None → "None").
    _nullable_id_cols = frozenset({
        "in_reply_to_status_id", "quoted_status_id", "conversation_id",
    })

    # Coerce remaining object-dtype columns to string to prevent parquet
    # serialization failures on mixed dict/list/object values.
    for col in out.columns:
        if out[col].dtype == "object" and metadata.get(col, {}).get("type") != "array":
            if col in _nullable_id_cols:
                # Preserve nulls: only stringify non-null values
                out[col] = out[col].where(out[col].isna(), out[col].astype(str))
            else:
                out[col] = out[col].astype(str)

    out.to_parquet(os.path.join(dataset_dir, "input.parquet"), index=False)
    with open(os.path.join(dataset_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "id": dataset_id,
                "length": int(len(out)),
                "columns": out.columns.tolist(),
                "text_column": text_column,
                "column_metadata": metadata,
                "potential_embeddings": potential_embeddings,
                "ls_version": __version__,
            },
            f,
            indent=2,
        )

    for dirname in ("embeddings", "umaps", "clusters", "scopes", "tags"):
        os.makedirs(os.path.join(dataset_dir, dirname), exist_ok=True)

    for tag_name in ("thumbs-up.indices", "thumbs-down.indices"):
        tag_path = os.path.join(dataset_dir, "tags", tag_name)
        if not os.path.exists(tag_path):
            with open(tag_path, "w", encoding="utf-8") as f:
                f.write("")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest a dataset input file")
    parser.add_argument("id", type=str, help="Dataset id")
    parser.add_argument("--path", type=str, help="Path to csv/parquet/json/jsonl/xlsx file")
    parser.add_argument("--text_column", type=str, help="Text column to use")
    args = parser.parse_args()
    ingest_file(args.id, args.path, args.text_column)


if __name__ == "__main__":
    main()
