# Visakanv-Tweets Dataset: Completion Plan

Date: 2026-03-14

## Current State

**Dataset ID:** `visakanv-tweets`
**Tweet count:** 259,083 (community archive, all years, no filters)
**Profile:** Visakan Veerasamy (@visakanv)

### Pipeline Status

| # | Stage | Artifact | Status | Notes |
|---|-------|----------|--------|-------|
| 1 | Ingest | `input.parquet`, `meta.json` | DONE (Mar 13) | 259,083 rows, 31 columns |
| 2 | Embed | `embedding-001.h5` (1.0 GB) | DONE (Mar 14 13:14) | `voyageai-voyage-context-3`, 1024d, thread-aware (25,945 threads), 34,490 reference-enriched |
| 3a | Display UMAP | `umap-001.parquet` (3 MB) | DONE (Mar 14 13:22) | 2D, neighbors=25, min_dist=0.1 |
| 3b | Clustering UMAP | `umap-002.parquet` (15 MB) | DONE (Mar 14 13:28) | 10D, neighbors=25, min_dist=0.0 |
| 4 | Hierarchy | `hierarchy-001.json` + `.npz` | DONE (Mar 14 13:29) | PLSCAN, 7 layers, 5,801 total clusters across [4865, 3355, 628, 208, 58, 22, 7] |
| 5 | **Toponymy Labels** | `clusters/toponymy-001.*` | **NOT STARTED** | Needs LLM (gpt-5-mini) |
| 6 | **Scope Creation** | `scopes/scopes-001.*` | **NOT STARTED** | Depends on step 5 |
| 7 | **LanceDB Export** | local + cloud lance tables | **NOT STARTED** | Automatic with step 6 |
| 8 | **Links Graph** | edges + node_stats tables | **NOT STARTED** | Independent of 5-7 |
| 9 | **Catalog Sync** | cloud catalog tables | **NOT STARTED** | Depends on step 6 |
| 10 | **CDN/R2 Sync** | serving artifacts | **NOT STARTED** | Depends on step 6 |

### Existing Cloud/Catalog State

- **Local catalog:** `visakanv-tweets` registered with `active_scope_id=""`, `row_count=259083`
- **Cloud LanceDB:** No `visakanv-tweets__*` tables exist
- **Cloud catalog:** No cloud catalog tables (catalog is local only, separate sync needed)

### Reference: Completed Datasets

| Dataset | Tweets | Clusters | Status |
|---------|--------|----------|--------|
| defenderofbasic | 23,295 | 646 | Fully deployed |
| patio11-tweets | 62,058 | 1,639 | Fully deployed |
| cube_flipper | 6,649 | — | Fully deployed |
| ivanvendrov | 1,349 | — | Fully deployed |
| **visakanv-tweets** | **259,083** | **5,801** | **Stuck at labeling** |

---

## GPT-5-Mini Rate Limits

| Limit Type | Value |
|------------|-------|
| Tokens per minute (TPM) | 2,000,000 |
| Requests per minute (RPM) | 5,000 |
| Tokens per day (TPD) | 20,000,000 |

### Estimated Usage for Toponymy Labeling

- **5,801 clusters** across 7 hierarchy layers
- Each cluster needs: 1 naming call + 1 audit call + ~10% relabel calls
- Estimated total LLM calls: **~13,000** (5,801 × ~2.2 avg)
- Each call: ~500-2,000 tokens (prompt with exemplars + keyphrases + sibling context)
- Estimated total tokens: **~10-20M tokens**

### Rate Limit Analysis

| Constraint | Limit | Est. Usage | Headroom |
|------------|-------|------------|----------|
| RPM (5,000) | 5,000 req/min | ~13,000 total | OK at 25 concurrent — ~3-5 min total |
| TPM (2,000,000) | 2M tok/min | Variable per batch | Likely fine with 25 concurrency |
| **TPD (20,000,000)** | 20M tok/day | **10-20M total** | **Tight — may consume 50-100% of daily budget** |

**Recommendation:** Run with default `--max-concurrent-requests 25`. If rate-limited, reduce to 10-15. The TPD limit is the binding constraint — if the run needs ~20M tokens, it will exhaust the daily budget. Run once per day.

---

## Incremental Execution Plan

All commands run from `/Users/sheikmeeran/latent-scope`.

### Step 1: Preflight Check

Verify all prerequisites exist before spending API credits.

```bash
uv run --env-file .env python3 - <<'PY'
import os, json
from pathlib import Path

data_dir = Path(os.environ["LATENT_SCOPE_DATA"]).expanduser()
d = data_dir / "visakanv-tweets"

checks = {
    "dataset_dir": d.exists(),
    "input.parquet": (d / "input.parquet").exists(),
    "meta.json": (d / "meta.json").exists(),
    "embedding-001.h5": (d / "embeddings" / "embedding-001.h5").exists(),
    "embedding-001.json": (d / "embeddings" / "embedding-001.json").exists(),
    "umap-001 (display)": (d / "umaps" / "umap-001.parquet").exists(),
    "umap-002 (cluster)": (d / "umaps" / "umap-002.parquet").exists(),
    "hierarchy-001": (d / "hierarchies" / "hierarchy-001.json").exists(),
    "hierarchy-001.npz": (d / "hierarchies" / "hierarchy-001.npz").exists(),
    "OPENAI_API_KEY set": bool(os.environ.get("OPENAI_API_KEY")),
    "VOYAGE_API_KEY set": bool(os.environ.get("VOYAGE_API_KEY")),
    "LANCEDB_URI set": bool(os.environ.get("LANCEDB_URI")),
    "LANCEDB_API_KEY set": bool(os.environ.get("LANCEDB_API_KEY")),
}

all_ok = True
for k, v in checks.items():
    status = "OK" if v else "MISSING"
    print(f"  [{status}] {k}")
    if not v:
        all_ok = False

# Check no existing toponymy labels (avoid re-run)
existing = list((d / "clusters").glob("toponymy-*.json"))
if existing:
    print(f"\n  WARNING: Existing toponymy labels found: {[x.name for x in existing]}")
    print("  These will be reused if they match the current lineage.")

print(f"\n{'ALL CHECKS PASSED' if all_ok else 'SOME CHECKS FAILED — fix before proceeding'}")
PY
```

### Step 2: Toponymy Labeling (the expensive step)

This is the only step that costs API credits. It calls gpt-5-mini for cluster naming + audit.

```bash
uv run --env-file .env python3 -m latentscope.scripts.toponymy_labels \
  visakanv-tweets \
  --hierarchy-id hierarchy-001 \
  --llm-provider openai \
  --llm-model gpt-5-mini \
  --context "tweets from Visakan Veerasamy (@visakanv), a prolific writer on creativity, self-improvement, internet culture, Singapore, and human potential" \
  --adaptive-exemplars \
  --max-concurrent-requests 25
```

**Note:** The `scope_id` argument is positional but can be omitted when `--hierarchy-id` + `embedding_id`/`umap_id` are inferred from the hierarchy metadata. The script accepts `scope_id=None` when `embedding_id` and `umap_id` are provided — but our hierarchy-001.json has `embedding_id` and `display_umap_id` baked in. Check if the CLI requires a dummy scope_id or if it can be blank.

**Fallback if scope_id is required positionally:**
```bash
uv run --env-file .env python3 -c "
from latentscope.scripts.toponymy_labels import run_toponymy_labeling
run_toponymy_labeling(
    dataset_id='visakanv-tweets',
    scope_id=None,
    llm_provider='openai',
    llm_model='gpt-5-mini',
    hierarchy_id='hierarchy-001',
    embedding_id='embedding-001',
    umap_id='umap-001',
    clustering_umap_id='umap-002',
    context='tweets from Visakan Veerasamy (@visakanv), a prolific writer on creativity, self-improvement, internet culture, Singapore, and human potential',
    adaptive_exemplars=True,
    max_concurrent_requests=25,
)
"
```

**Expected output:** `clusters/toponymy-001.parquet` + `clusters/toponymy-001.json`
**Expected duration:** 10-30 minutes (depends on rate limiting)
**Expected cost:** ~$1-5 (gpt-5-mini is cheap per token)

### Step 3: Verify Labels

```bash
uv run --env-file .env python3 - <<'PY'
import os, json
import pandas as pd
from pathlib import Path

data_dir = Path(os.environ["LATENT_SCOPE_DATA"]).expanduser()
d = data_dir / "visakanv-tweets" / "clusters"

labels_json = list(d.glob("toponymy-*.json"))
if not labels_json:
    print("ERROR: No toponymy labels found!")
    exit(1)

for lj in labels_json:
    meta = json.load(open(lj))
    print(f"\n=== {lj.name} ===")
    print(f"  clusters: {meta.get('num_clusters')}")
    print(f"  layers: {meta.get('num_layers')}")
    print(f"  model: {meta.get('llm_provider')}/{meta.get('llm_model')}")
    print(f"  adaptive: {meta.get('adaptive_exemplars')}")

    pq = lj.with_suffix('.parquet')
    if pq.exists():
        df = pd.read_parquet(pq)
        print(f"  parquet rows: {len(df)}")
        print(f"  columns: {list(df.columns)}")
        print(f"  sample labels:")
        if 'label' in df.columns:
            for _, row in df.head(10).iterrows():
                print(f"    [{row.get('layer','')}:{row.get('cluster','')}] {row.get('label','')}")
PY
```

### Step 4: Scope Creation + LanceDB Export

This materializes the scope, exports to local+cloud LanceDB, and updates the catalog.

```bash
uv run --env-file .env python3 -m latentscope.scripts.scope \
  visakanv-tweets \
  embedding-001 \
  umap-001 \
  toponymy-001 \
  "Posted Tweets" \
  "Imported from Community Archive and auto-processed."
```

**Expected output:**
- `scopes/scopes-001-input.parquet` (materialized scope with all columns)
- `scopes/scopes-001.json` (metadata with `lancedb_table_id`)
- Local LanceDB table created
- Cloud LanceDB table created (if cloud enabled)
- Local catalog updated

### Step 5: Build Links Graph

```bash
uv run --env-file .env python3 -m latentscope.scripts.build_links_graph \
  visakanv-tweets
```

### Step 6: Sync Catalog to Cloud

```bash
uv run --env-file .env python3 tools/sync_catalog_to_cloud.py --execute
```

### Step 7: Upload CDN Artifacts to R2

```bash
SCOPE_ID=$(ls ~/latent-scope-data/visakanv-tweets/scopes/scopes-*.json \
  | grep -v '\-input' | sort | tail -n1 | xargs basename | sed 's/.json$//')
echo "Scope ID: $SCOPE_ID"

uv run --env-file .env python3 tools/sync_cdn_r2.py \
  --dataset visakanv-tweets \
  --scope "$SCOPE_ID" \
  --bucket tweetscope-data \
  --execute
```

### Step 8: Post-Run Verification

```bash
# Local check
uv run --env-file .env python3 - <<'PY'
import os, json, glob
from pathlib import Path
import lancedb

data_dir = Path(os.environ["LATENT_SCOPE_DATA"]).expanduser()
d = data_dir / "visakanv-tweets"

print("=== LOCAL ===")
scopes = sorted([x for x in glob.glob(str(d / "scopes" / "scopes-*.json")) if "-input" not in x])
if scopes:
    m = json.load(open(scopes[-1]))
    print(f"  scope_id: {m['id']}")
    print(f"  lancedb_table_id: {m.get('lancedb_table_id')}")
    print(f"  cluster_labels_id: {m.get('cluster_labels_id')}")
    print(f"  hierarchical: {m.get('hierarchical_labels')}")
else:
    print("  ERROR: No scope files found!")

# Local lance
ldb = lancedb.connect(str(d / "lancedb"))
print(f"  local lance tables: {ldb.table_names(limit=100)}")

# Catalog
cat = lancedb.connect(str(data_dir / "_catalog" / "lancedb"))
ds = cat.open_table("system__datasets")
rows = ds.to_pandas()
visa = rows[rows["dataset_id"] == "visakanv-tweets"]
print(f"  catalog dataset row: {len(visa)} entries, active_scope={visa.iloc[0]['active_scope_id'] if len(visa) else 'MISSING'}")
PY

# Cloud check
uv run --env-file .env python3 - <<'PY'
import os
import lancedb
cloud = lancedb.connect(os.environ["LANCEDB_URI"], api_key=os.environ.get("LANCEDB_API_KEY"))
visa_tables = [n for n in cloud.table_names(limit=5000) if n.startswith("visakanv-tweets__")]
print(f"\n=== CLOUD ===")
print(f"  visakanv-tweets tables: {visa_tables}")
PY
```

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| TPD budget exhausted mid-run | Monitor token usage; re-run next day if interrupted |
| Rate limiting (429 errors) | Reduce `--max-concurrent-requests` to 10-15 |
| Toponymy labeling fails partway | Re-run the same command; it will overwrite partial output |
| Scope creation fails | Fix issue, re-run scope command (safe to repeat) |
| Cloud LanceDB write fails | Check `LATENT_SCOPE_DISABLE_CLOUD_LANCEDB`; retry |
| Missing Voyage API key | Required for keyphrase embedding in toponymy; set in `.env` |

## Cost Estimate

| Service | Est. Usage | Est. Cost |
|---------|-----------|-----------|
| OpenAI gpt-5-mini (toponymy) | ~10-20M tokens | ~$1-5 |
| Voyage AI (keyphrase embedding) | ~5,801 cluster batches | ~$0.50-2 |
| LanceDB Cloud | ~259K row table | Included in plan |
| **Total** | | **~$2-7** |
