# Development

Guide for contributing to tweetscope. For end-user setup, see the [Getting Started](README.md#getting-started) section of the README.

## Architecture overview

Three layers, two servers:

```
React frontend (Vite :5174)  →  Hono TypeScript API (:3000)  →  Python pipeline (subprocesses)
         ↕                              ↕                              ↕
   DeckGL, SASS, hyparquet      LanceDB, VoyageAI, Zod        Parquet, HDF5, JSON
```

- **Frontend** (`web/`): React 18 + Vite + Deck.GL 9. Proxies `/api/*` to the Hono API in dev.
- **Hono API** (`api/`): TypeScript, serves all frontend requests. Reads data from local filesystem (studio) or R2/CDN (production). Spawns Python pipeline jobs via `uv run python3` subprocesses.
- **Python pipeline** (`latentscope/`): CLI scripts for ingest, embed, UMAP, cluster, label, scope. Writes flat files (Parquet, HDF5, JSON) + LanceDB tables.

The Flask server (`ls-serve`) is **deprecated** — kept only for `ls-serve` CLI debugging of raw data files. The frontend never talks to it.

<picture>
  <img src="documentation/system-architecture.svg" alt="System architecture: React frontend, typed API clients, Hono production, Python pipeline, flat file storage">
</picture>

### Runtime modes

| Mode | `LATENT_SCOPE_APP_MODE` | Purpose |
|------|------------------------|---------|
| **Studio** | `studio` | Local dev: full pipeline UI, settings, jobs, export |
| **Hosted** | `hosted` | Multi-user: explore + Twitter import, no admin |
| **Single Profile** | `single_profile` | Read-only: one public scope, no import |

Mode is set via environment variable. One frontend build adapts to all modes via feature flags from `/api/app-config`.

### Repository structure

```
.
├── api/                   # Production serving API (Hono + TypeScript)
│   ├── src/routes/        #   search, data, catalog, graph, resolve-url
│   └── src/lib/           #   lancedb, voyageai, graphRepo
├── web/                   # React frontend (Vite + Deck.GL)
│   ├── src/api/           #   Typed API clients (catalog, view, graph, query)
│   ├── src/contexts/      #   ScopeContext, FilterContext
│   ├── src/hooks/         #   useSidebarState, useCarouselData, useClusterFilter, ...
│   ├── src/components/    #   Explore/V2 (DeckGLScatter, TopicTree, Carousel, ThreadView)
│   ├── src/lib/           #   apiService, DuckDB, twitterArchiveParser, colors
│   └── src/pages/V2/      #   FullScreenExplore (main page)
├── latentscope/           # Python package
│   ├── server/            #   Flask app (deprecated — kept for ls-serve debugging only)
│   ├── pipeline/          #   Scope runner, catalog registry, LanceDB export stages
│   ├── scripts/           #   Pipeline CLI (ingest, embed, umap, cluster, label, scope, ...)
│   ├── models/            #   Embedding + chat model providers
│   ├── importers/         #   Twitter archive parser
│   └── util/              #   Config, data directory management
├── toponymy/              # Git submodule: hierarchical cluster labeling
│   └── toponymy/          #   cluster_layer, llm_wrappers, prompt_construction, audit
├── archives/              # Twitter archive zips (gitignored)
├── contracts/             # JSON schemas (scope_input, links)
├── tools/                 # Operational scripts (eval, backfill, validate, sync)
├── documentation/         # Diagrams, deploy guides, notes
├── experiments/           # Prototypes
└── reports/               # Eval output artifacts
```

## Prerequisites

- Python 3.11+
- Node.js 22+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- npm

## Running locally

```bash
# 1. Install Python package in editable mode
uv pip install -e .

# 2. Configure environment
cp .env.example .env          # set LATENT_SCOPE_DATA, API keys, LATENT_SCOPE_APP_MODE=studio
cp api/.env.example api/.env  # set LATENT_SCOPE_DATA, VOYAGE_API_KEY, PORT=3000

# 3. Start Hono API (terminal 1)
cd api && npm install && npm run dev   # tsx watch on :3000

# 4. Start frontend (terminal 2)
cd web && npm install && npm run dev   # Vite on :5174, proxies /api to :3000
```

Open http://localhost:5174.

### Importing test data

Three datasets are used for development and testing. Archive zips live in `archives/` (gitignored).

| Dataset | Source | Size | Pipeline | Purpose |
|---------|--------|------|----------|---------|
| **visakanv-tweets** | Community archive (1k sample) | ~1,000 tweets | Current | Dev test corpus; full 200k+ archive will power the public demo |
| **sheik-tweets** | Native X export (`archives/my-twitter-archive.zip`) | ~10k tweets | Current | Primary dev corpus |
| **patrick-tweets** | Native X export | 50 tweets | Outdated — needs re-import | Future read-only public dataset |

"Current pipeline" means: voyage-context-3 embeddings, split UMAP (2D display + 10D clustering), HDBSCAN on kD manifold, hierarchical toponymy labels with audit loop.

To set up from scratch:

```bash
# Copy masky's archive into the repo (gitignored)
cp ~/Downloads/my-twitter-archive.zip archives/

# Import visakanv: 1k sample from the community archive
uv run python3 -m latentscope.scripts.twitter_import visakanv-tweets \
  --source community --username visakanv \
  --top_n 1000 --sort recent --run_pipeline

# Import masky's archive
uv run python3 -m latentscope.scripts.twitter_import sheik-tweets \
  --source zip --zip_path archives/my-twitter-archive.zip --run_pipeline
```

### Progressive import for large archives

For large archives (100k+ tweets), import year by year. Each run ingests only — no pipeline — deduplicating by tweet ID and appending new rows while preserving existing `ls_index` values. A batch manifest is written to `imports/` after each run. Once all years are imported, run the pipeline once on the full dataset.

```bash
# Step 1: Ingest year by year (no --run_pipeline, ingest only)
for year in 2018 2019 2020 2021 2022 2023 2024; do
  uv run python3 -m latentscope.scripts.twitter_import visakanv-tweets \
    --source zip --zip_path archives/archive.zip \
    --year $year --import_batch_id "visakanv-$year"
done

# Step 2: Run pipeline once on the full dataset
uv run python3 -m latentscope.scripts.twitter_import visakanv-tweets \
  --source zip --zip_path archives/archive.zip \
  --run_pipeline --import_batch_id "visakanv-final"
```

Additional filters can be combined with `--year`:

| Flag | Purpose | Example |
|------|---------|---------|
| `--lang` | Filter by language | `--lang en` |
| `--min_favorites` | Minimum engagement | `--min_favorites 10` |
| `--min_text_length` | Skip short tweets | `--min_text_length 50` |
| `--exclude_replies` | Drop replies | |
| `--exclude_retweets` | Drop retweets | |
| `--exclude_likes` | Skip likes | |
| `--top_n` | Limit row count | `--top_n 5000` |
| `--sort` | Order by `recent` or `engagement` | `--sort engagement` |

## Python package (`latentscope/`)

### `scripts/` — pipeline CLI

Each script is a standalone pipeline step. Registered `ls-*` entry points call these directly. Scripts not registered as entry points are invoked via `uv run python3 -m`:

| Script | Entry point | Purpose |
|--------|-------------|---------|
| `ingest.py` | `ls-ingest` | CSV/Parquet/JSON/XLSX → `input.parquet` + `meta.json` |
| `embed.py` | `ls-embed` | Text → HDF5 vectors. Supports VoyageAI (contextual), OpenAI, HF, Cohere |
| `umapper.py` | `ls-umap` | UMAP: 2D display or kD clustering manifold |
| `cluster.py` | `ls-cluster` | HDBSCAN clustering, supports separate clustering UMAP |
| `label_clusters.py` | `ls-label` | Flat LLM cluster labeling (not used in twitter pipeline) |
| `scope.py` | `ls-scope` | Create named scope tying artifacts together |
| `twitter_import.py` | `python3 -m ...` | Full Twitter archive import + optional pipeline |
| `build_links_graph.py` | `python3 -m ...` | Reply/quote edge extraction → `edges.parquet`, `node_stats.parquet` |
| `toponymy_labels.py` | `python3 -m ...` | Hierarchical cluster labeling via Toponymy submodule |
| `export_lance.py` | `python3 -m ...` | Export scope to LanceDB (local + cloud) |

### CLI reference

#### Registered entry points (`ls-*`)

| Command | Purpose |
|---------|---------|
| `ls-init <data_dir>` | Initialise data directory + .env |
| `ls-serve [data_dir]` | Start legacy Flask server (:5001, deprecated — use Hono API) |
| `ls-ingest <dataset_id> [path]` | Ingest CSV/Parquet/JSON/XLSX into dataset |
| `ls-embed <id> <text_col> <model>` | Generate embeddings |
| `ls-umap <id> <emb_id> [neighbors] [min_dist]` | UMAP projection |
| `ls-cluster <id> <umap_id> <samples> <min_samples>` | HDBSCAN clustering |
| `ls-label <id> <text_col> <cluster_id> <model>` | LLM cluster labeling (flat) |
| `ls-scope <id> <labels_id> <label> <desc>` | Create scope |
| `ls-sae <id>` | Sparse autoencoder features |
| `ls-export-plot <id>` | Export static scatter plot |
| `ls-list-models` | List available models |
| `ls-download-dataset <id>` | Download public dataset |
| `ls-upload-dataset <id>` | Upload to remote storage |

#### Module scripts (`uv run python3 -m ...`)

These are not registered as `ls-*` entry points — invoke via `uv run python3 -m`:

| Module | Purpose |
|--------|---------|
| `latentscope.scripts.twitter_import` | Twitter/X archive import + optional full pipeline |
| `latentscope.scripts.build_links_graph` | Build reply/quote edge graph |
| `latentscope.scripts.toponymy_labels` | Hierarchical cluster labeling via Toponymy |
| `latentscope.scripts.export_lance` | Export scope to LanceDB (local + cloud) |

### CLI pipeline (step by step)

```bash
ls-ingest my-dataset ~/data.csv
ls-embed my-dataset "text" voyage-context-3
ls-umap my-dataset embedding-001 25 0.1                           # 2D display
ls-umap my-dataset embedding-001 25 0.1 --purpose cluster --n_components 10  # kD for clustering
ls-cluster my-dataset umap-001 50 5 --clustering_umap_id umap-002
ls-scope my-dataset cluster-001-labels-default "My scope" "Description"

# Hierarchical labels via Toponymy (the default for twitter imports)
uv run python3 -m latentscope.scripts.toponymy_labels my-dataset scopes-001 \
    --llm-provider openai --llm-model gpt-5-mini

# Reply/quote edge graph
uv run python3 -m latentscope.scripts.build_links_graph my-dataset
```

### Python interface

```python
import latentscope as ls
import pandas as pd

ls.init("~/latent-scope-data", openai_key="XXX")
df = pd.read_parquet("my_data.parquet")
ls.ingest("my-dataset", df, text_column="text")
ls.embed("my-dataset", "text", "voyage-context-3")
ls.umap("my-dataset", "embedding-001", 25, 0.1)
ls.cluster("my-dataset", "umap-001", 50, 5)
ls.scope("my-dataset", "cluster-001-labels-default", "My scope", "Description")
# Then run toponymy_labels.py for hierarchical labels
# Serve via: cd api && npm run dev
```

### `pipeline/` — scope runner and catalog

- `scope_runner.py` — orchestrates scope creation: load metadata → build points DF → materialize → export to LanceDB
- `catalog_registry.py` — LanceDB-backed dataset/scope registry (`system__datasets`, `system__scopes` tables)
- `stages/` — scope_ids, scope_labels, scope_materialize, scope_meta, tiles
- `contracts/scope_input.py` — Python-side scope input contract

### `models/` — embedding and chat providers

- `embedding_models.json` — model registry (OpenAI, VoyageAI, including `voyage-context-3`)
- `chat_models.json` — LLM registry (OpenAI GPT-5 series, GPT-4 series, Ollama)
- `providers/` — `openai.py`, `voyageai.py`, `base.py`

### `importers/` — Twitter archive parser

- `twitter.py` — handles native X zip, community archive, community JSON; note-tweet merging, t.co URL expansion, deduplication, filter logic

### `server/` — deprecated Flask app

- `app.py`, `datasets.py`, `search.py` — kept for `ls-serve` CLI only

### `util/` — configuration

- `configuration.py` — `get_data_dir()`, `update_data_dir()`, API key management via dotenv
- `text_enrichment.py` — tweet reference resolution for embedding context

## Data pipeline deep dive

### 0. Ingest

Converts CSV/Parquet/JSON/XLSX into `input.parquet` + `meta.json`. For Twitter archives, `latentscope.scripts.twitter_import` handles zip extraction, deduplication, and optional full-pipeline execution.

### 1. Embed

Encodes the text column into high-dimensional vectors stored as HDF5. Supports local models (HuggingFace sentence-transformers) and API providers (VoyageAI, OpenAI, Cohere, Mistral, Together). Default: `voyage-context-3`.

Resumable — if interrupted, re-running picks up from the last completed batch.

### 2. UMAP

Reduces embeddings to lower dimensions. Two purposes:

- **Display** (`--purpose display`, default): 2D x,y coordinates for the scatter plot
- **Cluster** (`--purpose cluster --n_components 10`): kD manifold for better HDBSCAN clustering

### 3. Cluster

HDBSCAN clustering on the UMAP output. When a clustering UMAP is available, use `--clustering_umap_id` to cluster on the kD manifold while plotting on the 2D display UMAP.

### 4. Label (Toponymy hierarchical)

The twitter pipeline uses **hierarchical Toponymy labeling** exclusively (enabled by default in `twitter_import --hierarchical-labels`). Multi-layer cluster naming with:

- Adaptive exemplar counts by cluster size
- Keyphrase extraction via VoyageAI embeddings
- Sibling context in prompts for disambiguation
- Post-fit audit loop (flag vague labels → relabel → re-audit)
- Async LLM wrappers for OpenAI and Anthropic

Flat `ls-label` exists as an upstream CLI command but is not used in the tweetscope pipeline.

### 5. Scope

A scope is a named combination of embedding + UMAP + clusters + labels. Switching between scopes in the UI is instant. The scope JSON ties together all artifact IDs and includes the full cluster label lookup.

### 5b. Links graph

`latentscope.scripts.build_links_graph` extracts reply and quote edges from the dataset, producing `edges.parquet` and `node_stats.parquet` conforming to the `contracts/links.schema.json` contract. Powers the ThreadView and ConnectionBadges in the UI.

### 6. Serve + Explore

The Hono TypeScript API serves the artifacts (local filesystem in studio mode, R2/CDN in production). The React frontend loads scope rows, builds the cluster hierarchy, and renders the interactive scatter + sidebar.

## Hono API (`api/src/`)

### Routes

| File | Mount | Endpoints |
|------|-------|-----------|
| `search.ts` | `/api/search` | `GET /nn` (LanceDB + VoyageAI vector search), `GET /fts` (full-text) |
| `catalog.ts` | via `data.ts` | Dataset/scope metadata from LanceDB catalog |
| `views.ts` | via `data.ts` | Scope row serving with contract validation |
| `graph.ts` | via `data.ts` | Thread/quote edges, node stats |
| `query.ts` | via `data.ts` | Row fetch by indices, filter/sort/paginate |
| `jobs.ts` | `/api/jobs` | Spawn Python subprocesses, job status polling |
| `resolve-url.ts` | `/api` | t.co URL resolution (SSRF-safe) |
| inline | `/api` | `GET /health`, `GET /app-config`, `GET /version` |

### Libraries (`api/src/lib/`)

- `lancedb.ts` — LanceDB Cloud connection, vector search, FTS
- `voyageai.ts` — VoyageAI REST embedding client
- `catalogRepo.ts` — reads from `system__datasets` / `system__scopes` LanceDB tables
- `graphRepo.ts` — LanceDB-backed graph queries
- `jobsRuntime.ts` — subprocess spawning (`uv run python3`), job status tracking

### Adding a new route

1. Create `api/src/routes/my-route.ts`
2. Chain routes for RPC type safety: `const app = new Hono().get('/endpoint', ...)`
3. Use `zValidator` for request validation
4. Always return `c.json()`, never `new Response()`
5. Export the route type and compose in `api/src/index.ts`
6. The frontend gets end-to-end types via `AppType` and `hc<AppType>` client

## Frontend (`web/`)

### Pages

| Page | Path | Purpose |
|------|------|---------|
| `Dashboard.jsx` | `/` | Dataset list, scope thumbnails |
| `NewCollection.jsx` | `/new` | Twitter archive import flow |
| `V2/FullScreenExplore.jsx` | `/datasets/:dataset/explore/:scope` | Main 3-panel explore page |

### Contexts

- **ScopeContext** (`contexts/ScopeContext.tsx`): loads scope metadata, builds `clusterMap`, `clusterHierarchy`, provides `scopeRows`
- **FilterContext** (`contexts/FilterContext.jsx`): manages active filters (cluster, search, feature, column), `filteredIndices`, pagination
- **HoverContext** (`contexts/HoverContext.jsx`): hover state

### Key hooks (`hooks/`)

`useSidebarState`, `useCarouselData`, `useTopicDirectoryData`, `useClusterColors`, `useClusterFilter`, `useColumnFilter`, `useKeywordSearch`, `useNearestNeighborsSearch`, `useNodeStats`, `useThreadData`, `useTimelineData`

### Explore UI components

<picture>
  <img src="documentation/explore-ui.svg" alt="Explore UI: ScopeContext + FilterContext feed into VisualizationPane, TopicTree, TweetFeed, FeedCarousel, ThreadView">
</picture>

| Concept | Where | What it does |
|---------|-------|--------------|
| **ScopeContext** | `web/src/contexts/ScopeContext.tsx` | Loads scope metadata, builds `clusterMap`, `clusterHierarchy`, provides `scopeRows` |
| **FilterContext** | `web/src/contexts/FilterContext.jsx` | Manages active filter (cluster, search, feature, column), `filteredIndices`, pagination |
| **DeckGLScatter** | `web/src/components/Explore/V2/DeckGLScatter.jsx` | Deck.GL ScatterplotLayer + TextLayer, categorical hue per cluster |
| **TopicTree** | `web/src/components/Explore/V2/TopicTree.jsx` | Hierarchical cluster tree, sorted by cumulative engagement |
| **FeedCarousel** | `web/src/components/Explore/V2/Carousel/` | Multi-column expanded view with per-column data from `useCarouselData` |
| **ThreadView** | `web/src/components/Explore/V2/ThreadView/` | Reply chain visualisation via graph edges |

### API clients (`api/`)

- `client.ts` — Hono RPC client via `hc<AppType>`
- `types.ts` — shared TypeScript types
- `lib/apiService.ts` — domain-split wrappers: `catalogClient`, `viewClient`, `graphClient`, `queryClient`

### Styling rules

- **Never hardcode hex colors** — use CSS variables from `web/src/latentscope--brand-theme.scss`
- **Never write dark mode blocks** — the theme file handles dark mode automatically
- Glass UI variables: `--glass-bg`, `--glass-blur`, `--glass-shadow`, `--glass-glow`
- Text: `--text-color-text-main`, `--text-color-text-subtle`
- Accent: `--semantic-color-semantic-info` / `-active` / `-hover`
- Spacing: `--space-1` (4px) through `--space-12` (48px)
- Fonts: Golos Text (body), Instrument Sans (UI labels)
- Only hardcoded color: Twitter blue `#1d9bf0` for platform links

## Environment variables

### Root `.env`

| Variable | Required | Purpose |
|----------|----------|---------|
| `LATENT_SCOPE_DATA` | Yes | Root data directory path |
| `OPENAI_API_KEY` | Yes | OpenAI API key (embeddings + labeling) |
| `VOYAGE_API_KEY` | Yes | VoyageAI API key (embeddings) |
| `LATENT_SCOPE_APP_MODE` | Yes | `studio` / `hosted` / `single_profile` |
| `ANTHROPIC_API_KEY` | No | For Toponymy labeling with Claude |
| `TOGETHER_API_KEY` | No | Together AI embeddings |
| `COHERE_API_KEY` | No | Cohere embeddings |
| `MISTRAL_API_KEY` | No | Mistral embeddings |

### `api/.env`

| Variable | Required | Purpose |
|----------|----------|---------|
| `LATENT_SCOPE_APP_MODE` | Yes | Must match root .env |
| `LATENT_SCOPE_DATA` | Yes | Same data directory |
| `VOYAGE_API_KEY` | Yes | For vector search |
| `PORT` | No | API port (default 3000) |
| `LANCEDB_URI` | No | LanceDB Cloud URI |
| `LANCEDB_API_KEY` | No | LanceDB Cloud key |
| `CORS_ORIGIN` | No | CORS allowlist |
| `DATA_URL` | No | Remote data root (R2/CDN) |
| `DISABLE_NEW_COLLECTION` | No | Disable Twitter import |

## Building for production

```bash
# API
cd api && npm run build && npm start

# Frontend
cd web && npx vite build --mode production
```

See [documentation/vercel-deployment.md](documentation/vercel-deployment.md) for Vercel deployment with four projects (web-demo, api-demo, web-app, api-app) from a single branch.

## Data contracts

### `contracts/scope_input.schema.json`

Required columns: `id`, `ls_index`, `x`, `y`, `cluster`, `label`, `deleted`, `text`

Optional: `raw_cluster`, `created_at`, `username`, `display_name`, `tweet_type`, `favorites`, `retweets`, `replies`, `is_reply`, `is_retweet`, `is_like`, `urls_json`, `media_urls_json`, `archive_source`

### `contracts/links.schema.json`

Edges: `edge_id`, `edge_kind`, `src_tweet_id`, `dst_tweet_id`, `src_ls_index`, `dst_ls_index`, `internal_target`, `provenance`

Node stats: `tweet_id`, `ls_index`, `thread_root_id`, `thread_depth`, `thread_size`, `reply_child_count`, `quote_in_count`, `quote_out_count`

## Dataset directory structure

```
data/
└── my-dataset/
    ├── input.parquet                          # Source data
    ├── meta.json                              # Dataset metadata
    ├── embeddings/
    │   ├── embedding-001.h5                   # Vectors (HDF5)
    │   └── embedding-001.json                 # Model + params
    ├── umaps/
    │   ├── umap-001.parquet                   # 2D display coordinates
    │   ├── umap-001.json                      # UMAP params
    │   ├── umap-002.parquet                   # kD clustering manifold
    │   └── umap-002.json
    ├── clusters/
    │   ├── cluster-001.parquet                # Cluster assignments
    │   ├── cluster-001.json                   # HDBSCAN params
    │   ├── cluster-001-labels-001.parquet     # LLM-generated labels
    │   └── cluster-001-labels-001.json
    ├── scopes/
    │   └── scopes-001.json                    # Scope config (ties everything together)
    ├── links/
    │   ├── edges.parquet                      # Reply/quote edges
    │   └── node_stats.parquet                 # Thread metrics per node
    ├── tags/
    │   └── ❤️.indices                          # User-tagged indices
    └── jobs/
        └── <job-id>.json                      # Job status + progress
```

## Toponymy submodule

The `toponymy/` git submodule (branch: `latent-scope-mods`) provides hierarchical cluster labeling. Key files:

- `toponymy.py` — core Toponymy class
- `cluster_layer.py` — multi-layer naming, adaptive exemplars, sibling context
- `llm_wrappers.py` — `AsyncOpenAINamer`, `AsyncAnthropicNamer`
- `audit.py` — post-fit flag/relabel/re-audit cycle
- `prompt_construction.py` + `templates.py` — prompt building
- `embedding_wrappers.py` — VoyageAI keyphrase embedder

Update the submodule:
```bash
cd toponymy && git pull origin latent-scope-mods && cd ..
```

## Operational tools

```bash
# Evaluate label quality with bakeoff comparison
uv run python3 tools/eval_hierarchy_labels.py --dataset <id> [--compare <labels-id>]

# Validate scope artifact integrity
uv run python3 tools/validate_scope_artifacts.py <dataset_path>

# Backfill LanceDB table IDs
uv run python3 tools/backfill_lancedb_table_id.py <dataset_path>

# Sync to Cloudflare R2 CDN
uv run python3 tools/sync_cdn_r2.py <dataset_id>
```

## Design principles

1. **Multiscale topic hierarchy** — Toponymy builds a tree of topics at multiple granularities. The UI reflects this everywhere: the TopicTree lets you navigate broad themes down to fine subtopics, the FeedCarousel shows per-cluster columns, and the scatter plot colours by hierarchy level.

2. **Twitter-native pipeline** — Archive import (native zip + community archive), thread/reply graph extraction, engagement metrics (likes, retweets) used for cluster ranking and UI sorting. The pipeline understands tweets, threads, quotes, and likes as first-class concepts.

3. **Reproducible artifacts** — Pipeline outputs are Parquet, HDF5, and JSON. Every parameter choice is recorded in metadata JSON alongside its output. LanceDB stores vector indices (cloud in production, local for graph tables). DuckDB WASM handles client-side Parquet queries in the browser.

4. **Scopes for comparison** — A scope ties together one embedding + UMAP + cluster + label combination. You can create multiple scopes with different settings and switch between them instantly in the UI.

5. **Contract-driven data flow** — JSON schemas in `contracts/` define column names, types, and nullability for data flowing between pipeline, API, and frontend. The pipeline normalises types on write; typed API clients enforce shapes on read.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Python pipeline | Pandas, NumPy, UMAP-learn, HDBSCAN, HuggingFace Transformers, VoyageAI, OpenAI |
| Production API | Hono (TypeScript), LanceDB Cloud, VoyageAI, Zod, hyparquet |
| Frontend | React 18, Vite, Deck.GL 9, Framer Motion, TanStack Table, D3, SASS |
| Storage | Parquet (Apache Arrow), HDF5, JSON, LanceDB (vector search + graph), DuckDB WASM (client-side) |
| Deploy | Vercel (web + API), Cloudflare R2 (data artifacts) |
