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

```bash
# Community archive sample
uv run python3 -m latentscope.scripts.twitter_import visakanv-tweets \
  --source community --username visakanv \
  --top_n 1000 --sort recent --run_pipeline

# Native X archive zip
uv run python3 -m latentscope.scripts.twitter_import sheik-tweets \
  --source zip --zip_path archives/my-twitter-archive.zip --run_pipeline
```

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

See [documentation/vercel-deployment.md](documentation/vercel-deployment.md) for Vercel deployment with four projects from a single branch.

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
