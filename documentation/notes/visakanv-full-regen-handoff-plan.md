# Visakanv Full Dataset Regeneration Handoff Plan

## Goal
- Rebuild the full `visakanv` dataset from the community archive (all available years/content).
- Use default pipeline params from `latentscope.scripts.twitter_import`.
- Publish the rebuilt dataset to cloud/catalog/CDN and verify UI/API serving.

## Key Files to Read First
- Pipeline orchestration:
  - `latentscope/scripts/twitter_import.py`
  - `latentscope/importers/twitter.py`
  - `latentscope/pipeline/scope_runner.py`
  - `latentscope/scripts/export_lance.py`
  - `latentscope/scripts/build_links_graph.py`
- Deployment/sync tooling:
  - `tools/sync_catalog_to_cloud.py`
  - `tools/sync_cdn_r2.py`
- API serving path:
  - `api/src/lib/catalogRepo.ts`
  - `api/src/lib/lancedb.ts`
  - `api/src/routes/catalog.ts`
  - `api/src/routes/search.ts`
- Deployment docs and env templates:
  - `documentation/vercel-deployment.md`
  - `api/.env.vercel.demo.example`
  - `api/.env.example`

## Local vs Deployment Details
- Local build artifacts:
  - Written under `${LATENT_SCOPE_DATA}/{dataset}/...`
  - Local catalog at `${LATENT_SCOPE_DATA}/_catalog/lancedb` (`system__datasets`, `system__scopes`)
- Cloud serving primitives:
  - LanceDB Cloud (`LANCEDB_URI`) stores vector/search tables and cloud catalog tables
  - R2/CDN (`https://data.maskys.com`) stores D1 serving allowlist artifacts (`meta.json`, scope JSON/input parquet, labels parquet/json, links files)
- API behavior:
  - TS API reads dataset/scope discovery from cloud catalog tables (not local JSON sidecars)
  - Search/query endpoints use `lancedb_table_id` resolved from catalog/scope metadata
- Frontend behavior (observed in deployed bundle during this handoff):
  - `https://tweetscope.maskys.com` frontend bundle points API calls at `https://api-app-gold.vercel.app/api`
  - This means same-domain `/api` is not necessarily the live source of truth; verify current `VITE_API_URL` wiring before debugging
- Operational implication:
  - Successful local pipeline run alone is insufficient for production visibility
  - You must:
    1. sync catalog to cloud (`tools/sync_catalog_to_cloud.py --execute`)
    2. upload CDN artifacts (`tools/sync_cdn_r2.py --execute`)

## Current Baseline (Verified)
- Local datasets absent: `visakanv`, `visakanv-2024`, `visakanv-tweets`.
- Local catalog rows absent for those dataset IDs in:
  - `system__datasets`
  - `system__scopes`
- Cloud catalog rows absent for those dataset IDs in:
  - `system__datasets`
  - `system__scopes`
- Cloud Lance tables absent for prefixes:
  - `visakanv__*`
  - `visakanv-2024__*`
  - `visakanv-tweets__*`
- R2/CDN objects absent for prefixes:
  - `visakanv/`
  - `visakanv-2024/`
  - `visakanv-tweets/`
- Full raw archive already downloaded locally:
  - `/tmp/visakanv-archive.json` (raw community payload)
- Extracted-format payload already prepared:
  - `/tmp/visakanv-extracted.json`
  - Counts at creation time:
    - `tweet_count=259083`
    - `likes_count=533890`
    - `total_count=792973`

## Why This Path
- `--source community` can block for a long time during remote fetch.
- Using local `community_json` input avoids repeated network fetch timeouts.
- Default `include_likes` is off, so one dataset is created (no `-likes` sibling unless explicitly requested).

## Important Constraints
- Full run is large and expensive.
- Embedding/UMAP/clustering/labeling are not truly incremental in current pipeline.
- If interrupted mid-run, safest recovery is usually:
  - remove partial dataset,
  - rerun cleanly.
- Catalog cloud sync is not automatic from `run_scope`; explicit sync step is required.

## Execution Steps

### 1) Preflight
Run from repo root:

```bash
cd /Users/sheikmeeran/latent-scope
uv run --env-file .env python - <<'PY'
import os
from pathlib import Path
p=Path('/tmp/visakanv-extracted.json')
print("extracted_exists", p.exists(), "bytes", p.stat().st_size if p.exists() else 0)
print("LATENT_SCOPE_DATA", os.environ.get("LATENT_SCOPE_DATA"))
print("LANCEDB_URI set", bool(os.environ.get("LANCEDB_URI")))
print("R2_ENDPOINT_URL set", bool(os.environ.get("R2_ENDPOINT_URL")))
PY
```

Expected:
- extracted file exists.
- env vars set from `.env`.

### 2) Run full import + full pipeline (single dataset: `visakanv`)

```bash
cd /Users/sheikmeeran/latent-scope
uv run --env-file .env python3 -m latentscope.scripts.twitter_import \
  visakanv \
  --source community_json \
  --input_path /tmp/visakanv-extracted.json \
  --run_pipeline
```

Notes:
- Do not pass `--year`.
- Do not pass `--top_n`.
- Do not pass `--include_likes`.

Expected high-level stages:
- upsert ingest to `visakanv/input.parquet`
- embedding generation
- display UMAP + clustering UMAP
- clustering
- scope build and Lance export
- hierarchical labeling (Toponymy, default on)
- links graph build

### 3) Sync catalog to cloud
`twitter_import` writes local catalog rows. API serving depends on cloud catalog rows.

```bash
cd /Users/sheikmeeran/latent-scope
uv run --env-file .env python3 tools/sync_catalog_to_cloud.py --execute
```

### 4) Upload serving artifacts to R2/CDN
Resolve scope ID from local dataset dir first:

```bash
cd /Users/sheikmeeran/latent-scope
SCOPE_ID=$(ls /Users/sheikmeeran/latent-scope-data/visakanv/scopes/scopes-*.json | rg -v -- '-input' | sort | tail -n1 | xargs -n1 basename | sed 's/.json$//')
echo "$SCOPE_ID"
```

Then sync:

```bash
cd /Users/sheikmeeran/latent-scope
uv run --env-file .env python3 tools/sync_cdn_r2.py \
  --dataset visakanv \
  --scope "$SCOPE_ID" \
  --bucket tweetscope-data \
  --execute
```

### 5) Post-run verification

#### Local verification
```bash
cd /Users/sheikmeeran/latent-scope
uv run --env-file .env python - <<'PY'
import os, json, glob
from pathlib import Path
import lancedb

data_dir=Path(os.environ["LATENT_SCOPE_DATA"]).expanduser()
d=data_dir/"visakanv"
print("dataset_exists", d.exists())
print("input_exists", (d/"input.parquet").exists())
print("links_meta_exists", (d/"links"/"meta.json").exists())
scopes=sorted([x for x in glob.glob(str(d/"scopes"/"scopes-*.json")) if "-input" not in x])
print("scope_jsons", [Path(x).name for x in scopes])
if scopes:
    m=json.load(open(scopes[-1]))
    print("scope_id", m["id"])
    print("table_id", m.get("lancedb_table_id"))
ldb=lancedb.connect(str(d/"lancedb"))
print("local_tables", ldb.table_names(limit=1000))
PY
```

#### Cloud verification
```bash
cd /Users/sheikmeeran/latent-scope
uv run --env-file .env python - <<'PY'
import os
import lancedb
cloud=lancedb.connect(os.environ["LANCEDB_URI"], api_key=os.environ.get("LANCEDB_API_KEY"))
ds=cloud.open_table("system__datasets").search().where("dataset_id = 'visakanv'").to_list()
sc=cloud.open_table("system__scopes").search().where("dataset_id = 'visakanv'").to_list()
print("cloud datasets rows", len(ds))
print("cloud scopes rows", len(sc))
print("cloud visakanv tables", [n for n in cloud.table_names(limit=5000) if n.startswith("visakanv__")])
PY
```

#### API verification
```bash
curl -sS https://api-app-gold.vercel.app/api/datasets | jq '.[] | select(.id=="visakanv")'
curl -sS https://api-app-gold.vercel.app/api/datasets/visakanv/scopes | jq '.'
```

Expected:
- dataset appears with active scope.
- scopes endpoint returns at least one scope with `lancedb_table_id`.

#### CDN verification
```bash
curl -sSI https://data.maskys.com/visakanv/meta.json | head -n 5
curl -sSI https://data.maskys.com/visakanv/scopes/$SCOPE_ID.json | head -n 5
```

Expected:
- HTTP 200 for uploaded files.

## Edge Cases and Recovery

### A) Process interruption during long run
- Symptom: partial artifacts in `LATENT_SCOPE_DATA/visakanv`.
- Recovery:
  1. Remove partial local dir.
  2. Remove partial cloud `visakanv__*` tables.
  3. Remove partial local/cloud catalog rows for `visakanv`.
  4. Re-run from step 2.

Cleanup command:

```bash
cd /Users/sheikmeeran/latent-scope
uv run --env-file .env python - <<'PY'
import os, shutil
from pathlib import Path
import lancedb

data_dir=Path(os.environ["LATENT_SCOPE_DATA"]).expanduser()
target=data_dir/"visakanv"
if target.exists():
    shutil.rmtree(target)
cat=lancedb.connect(str(data_dir/"_catalog"/"lancedb"))
cat.open_table("system__scopes").delete("dataset_id = 'visakanv'")
cat.open_table("system__datasets").delete("dataset_id = 'visakanv'")
cloud=lancedb.connect(os.environ["LANCEDB_URI"], api_key=os.environ.get("LANCEDB_API_KEY"))
for n in [x for x in cloud.table_names(limit=5000) if x.startswith("visakanv__")]:
    cloud.drop_table(n)
cloud.open_table("system__scopes").delete("dataset_id = 'visakanv'")
cloud.open_table("system__datasets").delete("dataset_id = 'visakanv'")
print("cleanup complete")
PY
```

### B) Catalog mismatch (dataset files exist, API does not show dataset)
- Cause: forgot cloud catalog sync.
- Fix: rerun `tools/sync_catalog_to_cloud.py --execute`.

### C) CDN mismatch (API has dataset, web fails to load artifacts)
- Cause: missing R2 upload of serving allowlist.
- Fix: rerun `tools/sync_cdn_r2.py --execute` with correct scope id.

### D) Accidental likes dataset creation
- Cause: `--include_likes` set.
- Fix: delete `visakanv-likes` local/cloud/catalog/CDN and rerun without `--include_likes`.

## Things to Watch During Run
- Embedding stage duration and API rate-limit behavior.
- Toponymy labeling duration (can be long for large cluster trees).
- Cloud table creation success in `export_lance`.
- Links graph write to cloud (`visakanv__edges`, `visakanv__node_stats`).

## Final Acceptance Checklist
- One dataset only: `visakanv`.
- No `visakanv-tweets`, no `visakanv-2024` entries in local/cloud catalogs.
- `visakanv` has:
  - active scope in cloud catalog,
  - cloud Lance scope table + edges/node_stats tables,
  - R2 serving artifacts (`meta`, `scope json`, `scope input parquet`, labels, links files),
  - API endpoints returning dataset and scope metadata,
  - web route loads explore page for active scope.
