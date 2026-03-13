"""Import Twitter/X archive data and optionally run a full Latent Scope pipeline."""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from latentscope.importers.twitter import (
    apply_filters,
    fetch_community_archive,
    load_community_archive_raw,
    load_community_extracted_json,
    load_native_x_archive_zip,
    sanitize_dataset_id,
    split_tweets_and_likes,
)
from latentscope.scripts.cluster import clusterer
from latentscope.scripts.build_links_graph import build_links_graph
from latentscope.scripts.build_hierarchy import build_hierarchy
from latentscope.scripts.embed import embed
from latentscope.scripts.ingest import ingest
from latentscope.scripts.scope import scope
from latentscope.scripts.umapper import umapper
from latentscope.util import get_data_dir
from latentscope.scripts.toponymy_labels import LABELING_METHODOLOGY_VERSION as TOPONYMY_LABELING_METHODOLOGY_VERSION


def _latest_id(directory: str, pattern: str) -> str:
    matches = [name for name in os.listdir(directory) if re.match(pattern, name)]
    if not matches:
        raise ValueError(f"No matching files in {directory} for pattern {pattern}")
    matches.sort()
    latest = matches[-1]
    return latest.rsplit(".", 1)[0]


def _build_df(rows: list[dict[str, Any]]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    # Drop rows that do not have required id/text fields.
    df = df[df["id"].astype(str).str.len() > 0]
    df = df[df["text"].astype(str).str.len() > 0]
    df = df.reset_index(drop=True)
    return df


def _normalize_id_column(df: pd.DataFrame) -> pd.DataFrame:
    if "id" not in df.columns:
        raise ValueError("Import dataframe must contain an 'id' column")
    out = df.copy()
    out["id"] = out["id"].astype(str).str.strip()
    out = out[out["id"].str.len() > 0].copy()
    return out


def _normalize_tweet_type_for_dedupe(value: Any) -> str:
    if value is None:
        return "tweet"
    try:
        if pd.isna(value):
            return "tweet"
    except Exception:
        pass
    text = str(value).strip().lower()
    return text or "tweet"


def _tweet_type_dedupe_rank(value: Any) -> int:
    normalized = _normalize_tweet_type_for_dedupe(value)
    if normalized in {"tweet", "note_tweet"}:
        return 2
    if normalized == "like":
        return 1
    return 0


def _dedupe_rows_by_id(df: pd.DataFrame) -> pd.DataFrame:
    out = _normalize_id_column(df)
    if out.empty:
        return out

    out["_ls_import_order"] = range(len(out))
    if "created_at" in out.columns:
        out["_ls_created_sort"] = pd.to_datetime(out["created_at"], errors="coerce", utc=True)
    else:
        out["_ls_created_sort"] = pd.NaT

    if "tweet_type" in out.columns:
        out["_ls_tweet_type_rank"] = out["tweet_type"].map(_tweet_type_dedupe_rank)
    else:
        out["_ls_tweet_type_rank"] = _tweet_type_dedupe_rank("tweet")

    out = out.sort_values(
        ["id", "_ls_tweet_type_rank", "_ls_created_sort", "_ls_import_order"],
        kind="stable",
    )
    out = out.drop_duplicates(subset=["id"], keep="last")
    out = out.sort_values("_ls_import_order", kind="stable")
    out = out.drop(columns=["_ls_import_order", "_ls_created_sort", "_ls_tweet_type_rank"]).reset_index(drop=True)
    return out


def _normalize_existing_records_df(df: pd.DataFrame) -> pd.DataFrame:
    out = _normalize_id_column(df)
    if "ls_index" in out.columns:
        out["ls_index"] = pd.to_numeric(out["ls_index"], errors="coerce")
    else:
        out["ls_index"] = range(len(out))

    missing_mask = out["ls_index"].isna()
    if missing_mask.any():
        current = out["ls_index"].dropna()
        start = int(current.max()) + 1 if not current.empty else 0
        out.loc[missing_mask, "ls_index"] = range(start, start + int(missing_mask.sum()))

    out["ls_index"] = out["ls_index"].astype(int)
    if "tweet_type" in out.columns:
        out["_ls_tweet_type_rank"] = out["tweet_type"].map(_tweet_type_dedupe_rank)
    else:
        out["_ls_tweet_type_rank"] = _tweet_type_dedupe_rank("tweet")

    out = out.sort_values(["id", "_ls_tweet_type_rank", "ls_index"], kind="stable").drop_duplicates(subset=["id"], keep="last")
    out = out.drop(columns=["_ls_tweet_type_rank"])
    out = out.sort_values("ls_index", kind="stable").reset_index(drop=True)
    return out


def _next_import_batch_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"batch-{ts}-{uuid.uuid4().hex[:8]}"


def _write_import_batch_manifest(
    dataset_dir: str,
    batch_id: str,
    payload: dict[str, Any],
) -> str:
    imports_dir = os.path.join(dataset_dir, "imports")
    os.makedirs(imports_dir, exist_ok=True)
    out_path = os.path.join(imports_dir, f"{batch_id}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return out_path


def _upsert_import_rows(
    *,
    dataset_id: str,
    incoming_df: pd.DataFrame,
    text_column: str,
    data_dir: str,
    import_batch_id: str | None = None,
    manifest_extra: dict[str, Any] | None = None,
    profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    dataset_dir = os.path.join(data_dir, dataset_id)
    input_path = os.path.join(dataset_dir, "input.parquet")

    incoming = _dedupe_rows_by_id(incoming_df)
    if incoming.empty:
        raise ValueError("No rows available for upsert after id de-duplication")

    batch_id = import_batch_id.strip() if import_batch_id else _next_import_batch_id()
    if not batch_id:
        batch_id = _next_import_batch_id()

    if os.path.exists(input_path):
        existing = pd.read_parquet(input_path)
        existing = _normalize_existing_records_df(existing)
    else:
        existing = pd.DataFrame(columns=[*incoming.columns.tolist(), "ls_index"])

    existing_cols = existing.columns.tolist()
    incoming_cols = incoming.columns.tolist()
    all_columns: list[str] = []
    for col in existing_cols + incoming_cols + ["ls_index"]:
        if col not in all_columns:
            all_columns.append(col)

    if "id" in all_columns:
        all_columns = ["id", *[col for col in all_columns if col != "id"]]

    existing = existing.reindex(columns=all_columns)
    incoming = incoming.reindex(columns=all_columns)

    existing_by_id = existing.set_index("id", drop=False)
    incoming_by_id = incoming.set_index("id", drop=False)

    incoming_ids = incoming_by_id.index.tolist()
    existing_ids = set(existing_by_id.index.tolist())
    inserted_ids = [tweet_id for tweet_id in incoming_ids if tweet_id not in existing_ids]
    updated_ids = [tweet_id for tweet_id in incoming_ids if tweet_id in existing_ids]

    if not existing_by_id.empty:
        existing_by_id.update(incoming_by_id)

    if inserted_ids:
        start_idx = int(existing_by_id["ls_index"].max()) + 1 if not existing_by_id.empty else 0
        new_rows = incoming_by_id.loc[inserted_ids].copy()
        new_rows["ls_index"] = list(range(start_idx, start_idx + len(inserted_ids)))
        merged = pd.concat([existing_by_id, new_rows], axis=0)
    else:
        merged = existing_by_id

    merged["ls_index"] = pd.to_numeric(merged["ls_index"], errors="coerce")
    if merged["ls_index"].isna().any():
        current = merged["ls_index"].dropna()
        start = int(current.max()) + 1 if not current.empty else 0
        missing = merged["ls_index"].isna()
        merged.loc[missing, "ls_index"] = range(start, start + int(missing.sum()))
    merged["ls_index"] = merged["ls_index"].astype(int)
    merged_df = merged.sort_values("ls_index", kind="stable").reset_index(drop=True)

    if merged_df["id"].duplicated().any():
        duplicate_ids = (
            merged_df.loc[merged_df["id"].duplicated(), "id"]
            .astype(str)
            .head(10)
            .tolist()
        )
        raise ValueError(
            f"Duplicate ids detected after import merge (sample: {duplicate_ids})"
        )
    if merged_df["ls_index"].duplicated().any():
        duplicate_indices = (
            merged_df.loc[merged_df["ls_index"].duplicated(), "ls_index"]
            .astype(int)
            .head(10)
            .tolist()
        )
        raise ValueError(
            f"Duplicate ls_index values detected after import merge (sample: {duplicate_indices})"
        )
    if merged_df["ls_index"].isna().any():
        raise ValueError("Null ls_index values detected after import merge")

    ingest(dataset_id, merged_df, text_column=text_column, profile=profile)

    manifest_payload = {
        "id": batch_id,
        "dataset_id": dataset_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "batch_rows": int(len(incoming_ids)),
        "inserted_rows": int(len(inserted_ids)),
        "updated_rows": int(len(updated_ids)),
        "dataset_rows": int(len(merged_df)),
        "changed_tweet_ids_count": int(len(incoming_ids)),
    }
    if manifest_extra:
        manifest_payload.update(manifest_extra)
    manifest_path = _write_import_batch_manifest(dataset_dir, batch_id, manifest_payload)

    return {
        "import_batch_id": batch_id,
        "batch_rows": int(len(incoming_ids)),
        "dataset_rows": int(len(merged_df)),
        "inserted_rows": int(len(inserted_ids)),
        "updated_rows": int(len(updated_ids)),
        "changed_tweet_ids": incoming_ids,
        "manifest_path": manifest_path,
    }


def _find_matching_toponymy_labels_id(
    dataset_dir: str,
    *,
    embedding_id: str,
    umap_id: str,
    cluster_id: str | None,
    hierarchy_id: str,
    llm_provider: str,
    llm_model: str,
    context: str | None,
    adaptive_exemplars: bool,
) -> str | None:
    """Find latest Toponymy labels generated for the exact pipeline lineage."""
    clusters_dir = os.path.join(dataset_dir, "clusters")
    if not os.path.isdir(clusters_dir):
        return None

    candidates: list[str] = []
    for meta_path in glob.glob(os.path.join(clusters_dir, "toponymy-*.json")):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            continue

        if meta.get("type") != "toponymy":
            continue
        if meta.get("embedding_id") != embedding_id:
            continue
        if meta.get("umap_id") != umap_id:
            continue
        if cluster_id is not None and meta.get("cluster_id") != cluster_id:
            continue
        if meta.get("llm_provider") != llm_provider:
            continue
        if meta.get("llm_model") != llm_model:
            continue
        if (meta.get("context") or None) != (context or None):
            continue
        if bool(meta.get("adaptive_exemplars", True)) != bool(adaptive_exemplars):
            continue
        if meta.get("hierarchy_id") != hierarchy_id:
            continue
        if int(meta.get("labeling_methodology_version", -1)) != TOPONYMY_LABELING_METHODOLOGY_VERSION:
            continue

        label_id = meta.get("id")
        if isinstance(label_id, str) and label_id:
            candidates.append(label_id)

    if not candidates:
        return None
    return sorted(candidates)[-1]


def _find_matching_hierarchy_id(
    dataset_dir: str,
    *,
    embedding_id: str,
    clustering_umap_id: str,
    min_samples: int,
    max_layers: int,
    base_min_cluster_size: int,
    base_n_clusters: int | None,
    layer_similarity_threshold: float,
    reproducible: bool,
) -> str | None:
    hierarchies_dir = os.path.join(dataset_dir, "hierarchies")
    if not os.path.isdir(hierarchies_dir):
        return None

    candidates: list[str] = []
    for meta_path in glob.glob(os.path.join(hierarchies_dir, "hierarchy-*.json")):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            continue

        if meta.get("type") != "hierarchy":
            continue
        if meta.get("builder") != "plscan":
            continue
        if meta.get("embedding_id") != embedding_id:
            continue
        if meta.get("clustering_umap_id") != clustering_umap_id:
            continue
        params = meta.get("params") or {}
        if int(params.get("min_samples", -1)) != int(min_samples):
            continue
        if int(params.get("max_layers", -1)) != int(max_layers):
            continue
        if int(params.get("base_min_cluster_size", -1)) != int(base_min_cluster_size):
            continue

        saved_base_n_clusters = params.get("base_n_clusters")
        if saved_base_n_clusters is None and base_n_clusters is not None:
            continue
        if saved_base_n_clusters is not None and base_n_clusters is None:
            continue
        if saved_base_n_clusters is not None and int(saved_base_n_clusters) != int(base_n_clusters):
            continue

        if float(params.get("layer_similarity_threshold", -1.0)) != float(layer_similarity_threshold):
            continue
        if bool(params.get("reproducible")) != bool(reproducible):
            continue

        hierarchy_id = meta.get("id")
        if isinstance(hierarchy_id, str) and hierarchy_id:
            candidates.append(hierarchy_id)

    if not candidates:
        return None
    return sorted(candidates)[-1]


def _try_enable_hierarchical_scope(
    *,
    dataset_id: str,
    dataset_dir: str,
    scope_id: str | None,
    embedding_id: str,
    umap_id: str,
    clustering_umap_id: str | None,
    cluster_id: str | None,
    hierarchy_id: str | None,
    text_column: str,
    label: str,
    description: str,
    toponymy_provider: str,
    toponymy_model: str,
    toponymy_context: str | None,
    toponymy_adaptive_exemplars: bool,
    max_concurrent_requests: int = 25,
) -> dict[str, Any]:
    """
    Ensure hierarchical labels exist for the given pipeline lineage.
    Preference order:
      1) Reuse existing matching Toponymy labels for same embedding+umap
      2) Generate new Toponymy labels from the canonical hierarchy
    """
    existing_labels_id = _find_matching_toponymy_labels_id(
        dataset_dir,
        embedding_id=embedding_id,
        umap_id=umap_id,
        cluster_id=cluster_id,
        hierarchy_id=hierarchy_id,
        llm_provider=toponymy_provider,
        llm_model=toponymy_model,
        context=toponymy_context,
        adaptive_exemplars=toponymy_adaptive_exemplars,
    )
    if existing_labels_id:
        return {
            "cluster_labels_id": existing_labels_id,
            "hierarchical_labels": True,
            "toponymy_generated": False,
        }

    from latentscope.scripts.toponymy_labels import run_toponymy_labeling
    generated_labels_id = run_toponymy_labeling(
        dataset_id=dataset_id,
        scope_id=scope_id,
        llm_provider=toponymy_provider,
        llm_model=toponymy_model,
        hierarchy_id=hierarchy_id,
        embedding_id=embedding_id,
        umap_id=umap_id,
        clustering_umap_id=clustering_umap_id,
        cluster_id=cluster_id,
        text_column=text_column,
        context=toponymy_context,
        adaptive_exemplars=toponymy_adaptive_exemplars,
        max_concurrent_requests=max_concurrent_requests,
    )
    return {
        "cluster_labels_id": generated_labels_id,
        "hierarchical_labels": True,
        "toponymy_generated": True,
    }


def _register_catalog(
    data_dir: str,
    dataset_id: str,
    active_scope_id: str | None = None,
) -> None:
    """Register or update a dataset in the LanceDB catalog."""
    from latentscope.pipeline.catalog_registry import upsert_dataset_meta

    meta_path = os.path.join(data_dir, dataset_id, "meta.json")
    with open(meta_path) as _mf:
        dataset_meta = json.load(_mf)
    upsert_dataset_meta(
        data_dir,
        dataset_id=dataset_id,
        meta=dataset_meta,
        active_scope_id=active_scope_id,
    )


def _run_pipeline_for_dataset(
    *,
    dataset_id: str,
    data_dir: str,
    text_column: str,
    source_label: str,
    embedding_model: str,
    umap_neighbors: int,
    umap_min_dist: float,
    cluster_samples: int,
    cluster_min_samples: int,
    cluster_selection_epsilon: float,
    hierarchical_labels: bool,
    hierarchy_min_samples: int,
    hierarchy_max_layers: int,
    hierarchy_base_min_cluster_size: int,
    hierarchy_base_n_clusters: int | None,
    hierarchy_layer_similarity_threshold: float,
    hierarchy_reproducible: bool,
    toponymy_provider: str,
    toponymy_model: str,
    toponymy_context: str | None,
    toponymy_adaptive_exemplars: bool,
    max_concurrent_requests: int = 25,
    do_build_links: bool,
    incremental_links: bool,
    changed_tweet_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Run embed → UMAP → cluster → scope → labels → links for one dataset.

    Returns a dict with pipeline artifact IDs and optional links summary.
    """
    result: dict[str, Any] = {}

    # 1) Embedding
    embed(
        dataset_id=dataset_id,
        text_column=text_column,
        model_id=embedding_model,
        prefix="",
        rerun=None,
        dimensions=None,
        batch_size=100,
        max_seq_length=None,
    )

    dataset_dir = os.path.join(data_dir, dataset_id)
    embedding_id = _latest_id(os.path.join(dataset_dir, "embeddings"), r"embedding-\d+\.json")

    # 2a) Display UMAP (2D for visualization)
    umapper(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        neighbors=umap_neighbors,
        min_dist=umap_min_dist,
        save=False,
        init=None,
        align=None,
        seed=None,
        purpose='display',
        n_components=2,
    )
    umap_id = _latest_id(os.path.join(dataset_dir, "umaps"), r"umap-\d+\.json")

    # 2b) Clustering UMAP (kD for HDBSCAN)
    umapper(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        neighbors=umap_neighbors,
        min_dist=0.0,  # tighter manifold for clustering
        save=False,
        init=None,
        align=None,
        seed=None,
        purpose='cluster',
        n_components=10,
    )
    clustering_umap_id = _latest_id(os.path.join(dataset_dir, "umaps"), r"umap-\d+\.json")

    hierarchy_id: str | None = None
    if hierarchical_labels:
        hierarchy_id = _find_matching_hierarchy_id(
            dataset_dir,
            embedding_id=embedding_id,
            clustering_umap_id=clustering_umap_id,
            min_samples=hierarchy_min_samples,
            max_layers=hierarchy_max_layers,
            base_min_cluster_size=hierarchy_base_min_cluster_size,
            base_n_clusters=hierarchy_base_n_clusters,
            layer_similarity_threshold=hierarchy_layer_similarity_threshold,
            reproducible=hierarchy_reproducible,
        )
        if hierarchy_id is None:
            hierarchy_id = build_hierarchy(
                dataset_id=dataset_id,
                embedding_id=embedding_id,
                clustering_umap_id=clustering_umap_id,
                display_umap_id=umap_id,
                min_samples=hierarchy_min_samples,
                max_layers=hierarchy_max_layers,
                base_min_cluster_size=hierarchy_base_min_cluster_size,
                base_n_clusters=hierarchy_base_n_clusters,
                layer_similarity_threshold=hierarchy_layer_similarity_threshold,
                reproducible=hierarchy_reproducible,
                quiet=False,
            )

    scope_label = f"{dataset_id} Twitter"
    scope_description = f"Imported from {source_label} and auto-processed."
    cluster_id: str | None = None
    cluster_labels_id: str
    hierarchical_enabled = False

    if hierarchical_labels:
        hier = _try_enable_hierarchical_scope(
            dataset_id=dataset_id,
            dataset_dir=dataset_dir,
            scope_id=None,
            embedding_id=embedding_id,
            umap_id=umap_id,
            clustering_umap_id=clustering_umap_id,
            cluster_id=cluster_id,
            hierarchy_id=hierarchy_id,
            text_column=text_column,
            label=scope_label,
            description=scope_description,
            toponymy_provider=toponymy_provider,
            toponymy_model=toponymy_model,
            toponymy_context=toponymy_context,
            toponymy_adaptive_exemplars=toponymy_adaptive_exemplars,
            max_concurrent_requests=max_concurrent_requests,
        )
        cluster_labels_id = hier["cluster_labels_id"]
        hierarchical_enabled = bool(hier.get("hierarchical_labels"))
        if "toponymy_generated" in hier:
            result["toponymy_generated"] = bool(hier["toponymy_generated"])
    else:
        clusterer(
            dataset_id=dataset_id,
            umap_id=umap_id,
            samples=cluster_samples,
            min_samples=cluster_min_samples,
            cluster_selection_epsilon=cluster_selection_epsilon,
            column=None,
            clustering_umap_id=clustering_umap_id,
        )
        cluster_id = _latest_id(os.path.join(dataset_dir, "clusters"), r"cluster-\d+\.json")
        cluster_labels_id = "default"

    scope(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        umap_id=umap_id,
        cluster_id=cluster_id,
        cluster_labels_id=cluster_labels_id,
        label=scope_label,
        description=scope_description,
        scope_id=None,
    )
    scope_id = _latest_id(os.path.join(dataset_dir, "scopes"), r"scopes-\d+\.json")

    result.update(
        {
            "embedding_id": embedding_id,
            "umap_id": umap_id,
            "cluster_id": cluster_id,
            "hierarchy_id": hierarchy_id,
            "cluster_labels_id": cluster_labels_id,
            "scope_id": scope_id,
            "hierarchical_labels": hierarchical_enabled,
        }
    )

    _register_catalog(data_dir, dataset_id, active_scope_id=scope_id)

    if do_build_links:
        links_summary = build_links_graph(
            dataset_id,
            incremental=incremental_links,
            changed_tweet_ids=changed_tweet_ids,
        )
        result["links"] = {
            "nodes": links_summary["nodes"],
            "edges": links_summary["edges"],
            "edge_kind_counts": links_summary["edge_kind_counts"],
            "incremental": bool(links_summary.get("incremental")),
        }

    return result


def run_import(
    dataset_id: str,
    source: str,
    *,
    zip_path: str | None = None,
    input_path: str | None = None,
    username: str | None = None,
    include_likes: bool = False,
    year: int | None = None,
    lang: str | None = None,
    min_favorites: int = 0,
    min_text_length: int = 0,
    exclude_replies: bool = False,
    exclude_retweets: bool = False,
    top_n: int | None = None,
    sort: str = "recent",
    text_column: str = "text",
    run_pipeline: bool = False,
    embedding_model: str = "voyage-context-3",
    umap_neighbors: int = 25,
    umap_min_dist: float = 0.1,
    cluster_samples: int = 5,
    cluster_min_samples: int = 5,
    cluster_selection_epsilon: float = 0.0,
    hierarchical_labels: bool = True,
    hierarchy_min_samples: int = 5,
    hierarchy_max_layers: int = 10,
    hierarchy_base_min_cluster_size: int = 10,
    hierarchy_base_n_clusters: int | None = None,
    hierarchy_layer_similarity_threshold: float = 0.2,
    hierarchy_reproducible: bool = False,
    toponymy_provider: str = "openai",
    toponymy_model: str = "gpt-5-mini",
    toponymy_context: str | None = None,
    toponymy_adaptive_exemplars: bool = True,
    max_concurrent_requests: int = 25,
    build_links: bool = True,
    import_batch_id: str | None = None,
    incremental_links: bool = True,
) -> dict[str, Any]:
    dataset_id = sanitize_dataset_id(dataset_id)

    if source == "zip":
        if not zip_path:
            raise ValueError("--zip_path is required for --source zip")
        imported = load_native_x_archive_zip(zip_path)
    elif source == "community":
        if not username:
            raise ValueError("--username is required for --source community")
        raw = fetch_community_archive(username)
        imported = load_community_archive_raw(raw, username=username)
    elif source == "community_json":
        if not input_path:
            raise ValueError("--input_path is required for --source community_json")
        imported = load_community_extracted_json(input_path)
    else:
        raise ValueError(f"Unsupported source: {source}")

    # ------------------------------------------------------------------
    # Filter all rows (always include likes; skip top_n — applied to tweets only)
    # ------------------------------------------------------------------
    filtered = apply_filters(
        imported.rows,
        include_likes=True,
        year=year,
        lang=lang,
        min_favorites=min_favorites,
        min_text_length=min_text_length,
        exclude_replies=exclude_replies,
        exclude_retweets=exclude_retweets,
        top_n=None,
        sort=sort,
    )
    if not filtered:
        raise ValueError("No rows available after filtering")

    # Split into tweets and likes
    tweet_rows, like_rows = split_tweets_and_likes(filtered)

    # Apply top_n only to tweets
    if top_n is not None and top_n > 0:
        tweet_rows = tweet_rows[:top_n]

    # Discard likes if the user opted out
    if not include_likes:
        like_rows = []

    if not tweet_rows and not like_rows:
        raise ValueError("No rows available after filtering (neither tweets nor likes)")

    data_dir = get_data_dir()
    manifest_base = {
        "source": imported.source,
        "year": year,
        "lang": lang,
        "top_n": top_n,
        "sort": sort,
        "include_likes": include_likes,
        "exclude_replies": exclude_replies,
        "exclude_retweets": exclude_retweets,
    }

    pipeline_params = dict(
        data_dir=data_dir,
        text_column=text_column,
        source_label=imported.source,
        embedding_model=embedding_model,
        umap_neighbors=umap_neighbors,
        umap_min_dist=umap_min_dist,
        cluster_samples=cluster_samples,
        cluster_min_samples=cluster_min_samples,
        cluster_selection_epsilon=cluster_selection_epsilon,
        hierarchical_labels=hierarchical_labels,
        hierarchy_min_samples=hierarchy_min_samples,
        hierarchy_max_layers=hierarchy_max_layers,
        hierarchy_base_min_cluster_size=hierarchy_base_min_cluster_size,
        hierarchy_base_n_clusters=hierarchy_base_n_clusters,
        hierarchy_layer_similarity_threshold=hierarchy_layer_similarity_threshold,
        hierarchy_reproducible=hierarchy_reproducible,
        toponymy_provider=toponymy_provider,
        toponymy_model=toponymy_model,
        toponymy_context=toponymy_context,
        toponymy_adaptive_exemplars=toponymy_adaptive_exemplars,
        max_concurrent_requests=max_concurrent_requests,
    )

    summary: dict[str, Any] = {
        "dataset_id": dataset_id,
        "rows": 0,
        "dataset_rows": 0,
        "inserted_rows": 0,
        "updated_rows": 0,
        "profile": imported.profile,
        "source": imported.source,
    }

    # ------------------------------------------------------------------
    # Process tweets dataset (skip if no tweets after filtering)
    # ------------------------------------------------------------------
    if tweet_rows:
        tweets_df = _build_df(tweet_rows)
        upsert_summary = _upsert_import_rows(
            dataset_id=dataset_id,
            incoming_df=tweets_df,
            text_column=text_column,
            data_dir=data_dir,
            import_batch_id=import_batch_id,
            manifest_extra=manifest_base,
            profile=imported.profile,
        )

        summary.update({
            "rows": int(upsert_summary["batch_rows"]),
            "dataset_rows": int(upsert_summary["dataset_rows"]),
            "inserted_rows": int(upsert_summary["inserted_rows"]),
            "updated_rows": int(upsert_summary["updated_rows"]),
            "import_batch_id": upsert_summary["import_batch_id"],
            "import_manifest_path": upsert_summary["manifest_path"],
        })

        _register_catalog(data_dir, dataset_id)

        if not run_pipeline:
            if build_links:
                links_summary = build_links_graph(
                    dataset_id,
                    incremental=incremental_links,
                    changed_tweet_ids=upsert_summary["changed_tweet_ids"],
                )
                summary["links"] = {
                    "nodes": links_summary["nodes"],
                    "edges": links_summary["edges"],
                    "edge_kind_counts": links_summary["edge_kind_counts"],
                    "incremental": bool(links_summary.get("incremental")),
                }
        else:
            pipeline_result = _run_pipeline_for_dataset(
                dataset_id=dataset_id,
                do_build_links=build_links,
                incremental_links=incremental_links,
                changed_tweet_ids=upsert_summary["changed_tweet_ids"],
                **pipeline_params,
            )
            summary.update(pipeline_result)

    # ------------------------------------------------------------------
    # Process likes dataset (separate, independent dataset)
    # ------------------------------------------------------------------
    if like_rows:
        likes_dataset_id = f"{dataset_id}-likes"
        likes_df = _build_df(like_rows)
        likes_upsert = _upsert_import_rows(
            dataset_id=likes_dataset_id,
            incoming_df=likes_df,
            text_column=text_column,
            data_dir=data_dir,
            import_batch_id=import_batch_id,
            manifest_extra={**manifest_base, "dataset_type": "likes", "parent_dataset_id": dataset_id},
            profile=imported.profile,
        )

        likes_summary: dict[str, Any] = {
            "dataset_id": likes_dataset_id,
            "rows": int(likes_upsert["batch_rows"]),
            "dataset_rows": int(likes_upsert["dataset_rows"]),
            "inserted_rows": int(likes_upsert["inserted_rows"]),
            "updated_rows": int(likes_upsert["updated_rows"]),
        }

        _register_catalog(data_dir, likes_dataset_id)

        if run_pipeline:
            likes_pipeline = _run_pipeline_for_dataset(
                dataset_id=likes_dataset_id,
                do_build_links=False,  # no links graph for likes
                incremental_links=False,
                **pipeline_params,
            )
            likes_summary.update(likes_pipeline)

        summary["likes_dataset"] = likes_summary

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Import Twitter/X archives into Latent Scope")
    parser.add_argument("dataset_id", type=str, help="Dataset identifier")
    parser.add_argument(
        "--source",
        type=str,
        choices=["zip", "community", "community_json"],
        required=True,
        help="Import source format",
    )
    parser.add_argument("--zip_path", type=str, help="Path to native X archive zip")
    parser.add_argument("--input_path", type=str, help="Path to extracted community JSON")
    parser.add_argument("--username", type=str, help="Community archive username")
    parser.add_argument(
        "--include_likes",
        action="store_true",
        help="Include likes as a separate dataset (default: off)",
    )
    parser.add_argument("--year", type=int, help="Filter tweets to a specific year")
    parser.add_argument("--lang", type=str, help="Language filter (e.g. en)")
    parser.add_argument("--min_favorites", type=int, default=0, help="Minimum favorites")
    parser.add_argument("--min_text_length", type=int, default=0, help="Minimum text length")
    parser.add_argument("--exclude_replies", action="store_true", help="Drop reply tweets")
    parser.add_argument("--exclude_retweets", action="store_true", help="Drop retweets")
    parser.add_argument("--top_n", type=int, help="Take top N rows after sorting")
    parser.add_argument(
        "--sort",
        type=str,
        choices=["recent", "engagement"],
        default="recent",
        help="Sort strategy",
    )
    parser.add_argument("--text_column", type=str, default="text", help="Text column name")
    parser.add_argument("--run_pipeline", action="store_true", help="Run embed/umap/cluster/scope")

    parser.add_argument(
        "--embedding_model",
        type=str,
        default="voyage-context-3",
        help="Embedding model id for --run_pipeline",
    )
    parser.add_argument("--umap_neighbors", type=int, default=25)
    parser.add_argument("--umap_min_dist", type=float, default=0.1)
    parser.add_argument("--cluster_samples", type=int, default=5)
    parser.add_argument("--cluster_min_samples", type=int, default=5)
    parser.add_argument("--cluster_selection_epsilon", type=float, default=0.0)
    parser.add_argument(
        "--hierarchical-labels",
        "--hierarchical_labels",
        dest="hierarchical_labels",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Use hierarchical Toponymy labels for the final scope (default: enabled)",
    )
    parser.add_argument(
        "--hierarchy-min-samples",
        "--hierarchy_min_samples",
        type=int,
        default=5,
        help="PLSCAN min_samples for canonical hierarchy building",
    )
    parser.add_argument(
        "--hierarchy-max-layers",
        "--hierarchy_max_layers",
        type=int,
        default=10,
        help="PLSCAN max_layers for canonical hierarchy building",
    )
    parser.add_argument(
        "--hierarchy-base-min-cluster-size",
        "--hierarchy_base_min_cluster_size",
        type=int,
        default=10,
        help="PLSCAN base minimum cluster size for the finest hierarchy layer",
    )
    parser.add_argument(
        "--hierarchy-base-n-clusters",
        "--hierarchy_base_n_clusters",
        type=int,
        default=None,
        help="Optional PLSCAN target cluster count for the finest hierarchy layer",
    )
    parser.add_argument(
        "--hierarchy-layer-similarity-threshold",
        "--hierarchy_layer_similarity_threshold",
        type=float,
        default=0.2,
        help="PLSCAN layer similarity threshold",
    )
    parser.add_argument(
        "--hierarchy-reproducible",
        "--hierarchy_reproducible",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Use reproducible PLSCAN mode (default: disabled)",
    )
    parser.add_argument(
        "--toponymy-provider",
        "--toponymy_provider",
        type=str,
        default="openai",
        choices=["openai", "anthropic", "cohere", "google"],
        help="LLM provider for Toponymy label generation",
    )
    parser.add_argument(
        "--toponymy-model",
        "--toponymy_model",
        type=str,
        default="gpt-5-mini",
        help="LLM model for Toponymy label generation",
    )
    parser.add_argument(
        "--toponymy-context",
        "--toponymy_context",
        type=str,
        default=None,
        help="Optional Toponymy context string for topic naming",
    )
    parser.add_argument(
        "--toponymy-adaptive-exemplars",
        "--toponymy_adaptive_exemplars",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable adaptive exemplar/keyphrase budgets during Toponymy naming",
    )
    parser.add_argument(
        "--max-concurrent-requests",
        "--max_concurrent_requests",
        type=int,
        default=25,
        help="Max concurrent LLM requests for async toponymy labeling (default: 25)",
    )
    parser.add_argument(
        "--build_links",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Build reply/quote link graph artifacts after import (default: True)",
    )
    parser.add_argument(
        "--import-batch-id",
        "--import_batch_id",
        type=str,
        default=None,
        help="Optional stable import batch id for progressive imports",
    )
    parser.add_argument(
        "--incremental-links",
        dest="incremental_links",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable incremental links rebuild using changed tweet ids (default: enabled)",
    )

    args = parser.parse_args()
    args_dict = vars(args).copy()
    args_dict["include_likes"] = args_dict.pop("include_likes", False)
    result = run_import(**args_dict)
    tweet_rows = result["rows"]
    likes_rows = result.get("likes_dataset", {}).get("rows", 0)
    total_rows = tweet_rows + likes_rows
    print(f"IMPORTED_ROWS: {total_rows}")
    print(f"IMPORTED_TWEET_ROWS: {tweet_rows}")
    print(f"DATASET_ID: {result['dataset_id']}")
    if result.get("scope_id"):
        print(f"FINAL_SCOPE: {result['scope_id']}")
    if result.get("likes_dataset"):
        likes = result["likes_dataset"]
        print(f"LIKES_DATASET_ID: {likes['dataset_id']}")
        print(f"LIKES_IMPORTED_ROWS: {likes.get('rows', 0)}")
        if likes.get("scope_id"):
            print(f"LIKES_FINAL_SCOPE: {likes['scope_id']}")


if __name__ == "__main__":
    main()
