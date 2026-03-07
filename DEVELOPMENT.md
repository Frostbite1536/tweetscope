# Development

Guide for contributors working on tweetscope. For the product overview and quickstart, see [README.md](README.md).

## System Snapshot

Tweetscope currently has four important pieces:

- `web/`: React 18 + Vite frontend with three live routed screens: dashboard, import/new collection, and explore.
- `api/`: Hono TypeScript API that serves app config, catalog metadata, scope rows, search, graph data, and import jobs.
- `latentscope/`: Python import and pipeline code, with `twitter_import.py` as the real orchestrator for Twitter/X flows.
- `LATENT_SCOPE_DATA`: flat-file artifacts plus local LanceDB tables. The API serves from LanceDB first; files remain the pipeline artifact source of truth.

The old Flask server in `latentscope/server/` is deprecated and is only retained for `ls-serve` debugging.

<picture>
  <img src="documentation/system-architecture.svg" alt="System architecture showing routed React app, Hono API, Python pipeline, dataset LanceDB tables, catalog LanceDB tables, raw artifacts, and VoyageAI">
</picture>

Diagram source: `documentation/diagrams/system-architecture.mmd`

## Runtime Modes

| Control | Value | Current behavior |
| --- | --- | --- |
| `LATENT_SCOPE_APP_MODE` | `studio` | Local authoring shell with dashboard, imports, jobs, and full explore UI |
| `LATENT_SCOPE_APP_MODE` | `hosted` | Explore/import shell with feature gating from `/api/app-config` |
| `LATENT_SCOPE_APP_MODE` | `single_profile` | Redirects `/` to one fixed public dataset/scope and treats the API as read-only |
| Vite build mode | `read_only` | Replaces the app with a docs iframe build (`npm run read_only`) |

Notes:

- The frontend fetches `/api/app-config` up front and uses it mainly for route mode, `twitter_import`, and upload-limit gating.
- The routed frontend today is still compact: dashboard, new collection, and explore. There are no separate routed settings/export/admin pages yet.

## Repository Structure

```text
.
├── api/
│   ├── src/index.ts                 # Hono entrypoint, app mode parsing, route mounting
│   ├── src/routes/                  # catalog, views, query, graph, jobs, search, resolve-url
│   └── src/lib/                     # LanceDB access, catalog repo, jobs runtime, graph repo
├── web/
│   ├── src/pages/                   # Dashboard, NewCollection, V2/FullScreenExplore
│   ├── src/contexts/                # ScopeContext, FilterContext, hover/color providers
│   ├── src/hooks/                   # search, topic directory, carousel, thread, timeline hooks
│   ├── src/components/Explore/V2/   # scatter, feed, topic directory, carousel, thread/quote panels
│   └── src/lib/apiService.ts        # app-facing API wrapper layer
├── latentscope/
│   ├── scripts/                     # twitter_import, embed, umapper, build_hierarchy, scope, ...
│   ├── pipeline/                    # scope materialization, contracts, catalog registry, hierarchy helpers
│   ├── importers/                   # native X zip / community archive loading and normalization
│   ├── models/                      # embedding/chat provider registries and adapters
│   └── util/                        # data-dir and env helpers
├── toponymy/                        # submodule used by hierarchical labeling
├── documentation/                   # screenshots, rendered diagrams, deployment docs, notes
├── contracts/                       # shared contracts used by serving/materialization
└── tools/                           # operational scripts and evaluation helpers
```

## Local Setup

### Prerequisites

- Python 3.11+
- `uv`
- Node.js 22+
- npm
- `VOYAGE_API_KEY`
- `OPENAI_API_KEY`

### Install JavaScript dependencies

```bash
cd api && npm install && cd ..
cd web && npm install && cd ..
```

### Python runtime note

The repo root does not currently ship a checked-in `pyproject.toml` or `setup.py`. In practice, the Python commands here assume you already have the required Python dependencies installed in the active environment.

### Configure `.env`

```bash
cp .env.example .env
```

Minimum local values:

```bash
LATENT_SCOPE_DATA=~/latent-scope-data
LATENT_SCOPE_APP_MODE=studio
VOYAGE_API_KEY=your-key
OPENAI_API_KEY=your-key
PORT=3000
```

Important details:

- The API dev server loads `../.env` because `api/package.json` runs `tsx watch --env-file=../.env src/index.ts`.
- `api/.env.example` is useful as a variable reference, but it is not the file `npm run dev` reads.
- Optional serving vars:
  - `LANCEDB_URI` / `LANCEDB_API_KEY` for cloud serving/export
  - `LANCEDB_CATALOG_URI` / `LANCEDB_CATALOG_API_KEY` for a separate cloud catalog
  - `DATA_URL` for raw file fallback
  - `LATENT_SCOPE_PUBLIC_DATASET` / `LATENT_SCOPE_PUBLIC_SCOPE` in `single_profile`

### Start services

```bash
# Terminal 1
cd api && npm run dev

# Terminal 2
cd web && npm run dev
```

The frontend runs on `http://localhost:5174` and proxies `/api` to the Hono server on port `3000`.

## Frontend Architecture

The real frontend architecture is provider-driven around one large explore surface.

### Route model

- `/` -> dashboard
- `/new` -> new collection / import flow
- `/datasets/:dataset/explore/:scope` -> main explore UI
- `single_profile` mode redirects `/` to a fixed public scope
- `read_only` Vite builds replace the app with a docs iframe

### Main screens

- `web/src/pages/Dashboard.jsx`
  - Lists datasets and scopes
  - Merges `*-likes` datasets into their parent collection card
  - Generates thumbnails from served scope points
- `web/src/pages/NewCollection.jsx`
  - Parses native X archives locally in the browser before upload
  - Starts import jobs through `/api/jobs/import_twitter`
  - Polls job progress and redirects into the new scope
- `web/src/pages/V2/FullScreenExplore.jsx`
  - Deck.GL scatter view + feed
  - Topic directory and carousel
  - Thread and quote side panels
  - Timeline playback, edge overlays, semantic/keyword search, thread-only filtering

### Providers and hooks that matter

- `web/src/contexts/ScopeContext.tsx`
  - Loads scope metadata, scope rows, embeddings, scopes, tags, and cluster hierarchy data
- `web/src/contexts/FilterContext.jsx`
  - Owns cluster, semantic, keyword, column, time-range, engagement, and thread-only filters
- `web/src/hooks/useSidebarState.js`
  - Switches between normal, expanded, thread, and quote modes
- Data-shaping hooks:
  - `useCarouselData.js`
  - `useTopicDirectoryData.js`
  - `useTimelineData.js`
  - `useNodeStats.ts`
  - `useThreadData.js`

### API wrapper location

The app-facing client wrappers live in `web/src/lib/apiService.ts`. The `web/src/api/` directory mostly holds the Hono RPC client and shared types, not the higher-level client surface used by the pages.

## API Architecture

`api/src/index.ts` is the whole server entrypoint. It parses app mode, feature flags, CORS, and mounts every route group.

### Route groups in use

- Core:
  - `GET /api/health`
  - `GET /api/app-config`
  - `GET /api/version`
- Catalog and serving:
  - `GET /api/datasets`
  - `GET /api/datasets/:dataset/meta`
  - `GET /api/datasets/:dataset/scopes`
  - `GET /api/datasets/:dataset/scopes/:scope`
  - `GET /api/datasets/:dataset/views/:view/meta`
  - `GET /api/datasets/:dataset/views/:view/points`
  - `GET /api/datasets/:dataset/views/:view/rows`
  - `POST /api/indexed`
  - `POST /api/query`
  - `POST /api/column-filter`
- Search:
  - `GET /api/search/nn`
  - `GET /api/search/fts`
- Links graph:
  - `GET /api/datasets/:dataset/links/meta`
  - `GET /api/datasets/:dataset/links/node-stats`
  - `POST /api/datasets/:dataset/links/by-indices`
  - `GET /api/datasets/:dataset/links/thread/:tweetId`
  - `GET /api/datasets/:dataset/links/quotes/:tweetId`
- Jobs:
  - `GET /api/jobs/job`
  - `GET /api/jobs/all`
  - `GET /api/jobs/kill`
  - `POST /api/jobs/import_twitter`
- Utility:
  - `POST /api/resolve-url`
  - `POST /api/resolve-urls`
  - `GET /api/files/:filePath`

### Actual serving model

- Catalog metadata is registry-backed through LanceDB `system__datasets` and `system__scopes`.
- Scope rows and points are served from LanceDB tables, not directly from parquet files.
- Search and graph routes are also LanceDB-backed.
- Raw files are still available through `/api/files/:filePath`, reading local `LATENT_SCOPE_DATA` first and `DATA_URL` second.
- `/api/datasets/:dataset/scopes/:scope/parquet` is now a deprecated compatibility path that still returns JSON rows.

### Job model

- Jobs are subprocess-only and currently centered on `POST /api/jobs/import_twitter`.
- The API spawns Python from the repo root using `LATENT_SCOPE_PYTHON`, `PYTHON`, or `uv run python3`.
- Job state is written to `LATENT_SCOPE_DATA/<dataset>/jobs/<job_id>.json`.
- Structured markers in stdout update job metadata:
  - `RUNNING:`
  - `FINAL_SCOPE:`
  - `IMPORTED_ROWS:`
  - `LIKES_DATASET_ID:`

### Current write-path caveat

The API upload route no longer accepts raw zip uploads. The browser import flow extracts native archives locally and uploads validated extracted JSON instead. The Python CLI still supports direct zip imports.

## Python Import And Pipeline

`latentscope/scripts/twitter_import.py` is the real orchestrator for Twitter/X flows. It imports source data, preserves stable `ls_index` values on upsert, writes import manifests, and optionally runs the full downstream pipeline.

<picture>
  <img src="documentation/pipeline-flow.svg" alt="Pipeline flow showing import, contextual embeddings, dual UMAPs, hierarchy build, Toponymy labels, scope export, LanceDB tables, catalog updates, and links graph artifacts">
</picture>

Diagram source: `documentation/diagrams/pipeline-flow.mmd`

### Default Twitter pipeline

With `--run_pipeline`, the current default path is:

1. `twitter_import.py`
   - load native X zip, extracted JSON, or community archive
   - normalize note tweets and URLs
   - split likes into a sibling dataset when enabled
   - upsert `input.parquet` and write `imports/<batch>.json`
2. `embed.py`
   - contextual tweet embeddings, including reference resolution and thread-aware enrichment
3. `umapper.py`
   - once for the display UMAP (`x`, `y`)
   - once for the clustering manifold (`dim_*`, default 10D)
4. `build_hierarchy.py`
   - current default hierarchy builder (PLSCAN path)
5. `toponymy_labels.py`
   - names the hierarchy and can run audit/relabel passes
6. `scope_runner.run_scope()`
   - materializes the serving parquet
   - validates it against the scope-input contract
   - exports a LanceDB serving table
   - updates the catalog registry
7. `build_links_graph.py`
   - writes reply/quote graph artifacts used by thread and quote views

Flat clustering with `cluster.py` is still present, but it is no longer the default Twitter path. It is only used when hierarchical labels are disabled.

### Toponymy submodule

`toponymy/` is a runtime dependency for hierarchical labeling, not just an optional reference submodule. `toponymy_labels.py` imports it directly.

### Progressive import for large archives

For very large archives, run ingest-only passes first and a single final pipeline run at the end:

```bash
for year in 2018 2019 2020 2021 2022 2023 2024; do
  uv run python3 -m latentscope.scripts.twitter_import visakanv-tweets \
    --source zip \
    --zip_path archives/archive.zip \
    --year "$year"
done

uv run python3 -m latentscope.scripts.twitter_import visakanv-tweets \
  --source zip \
  --zip_path archives/archive.zip \
  --run_pipeline \
  --import_batch_id visakanv-final
```

## Data Layout

This is the current local layout under `LATENT_SCOPE_DATA`:

```text
LATENT_SCOPE_DATA/
├── _catalog/
│   └── lancedb/                       # local catalog registry
├── <dataset>/
│   ├── input.parquet
│   ├── meta.json
│   ├── imports/
│   │   └── *.json
│   ├── embeddings/
│   │   ├── embedding-###.h5
│   │   └── embedding-###.json
│   ├── umaps/
│   │   ├── umap-###.parquet
│   │   ├── umap-###.json
│   │   └── *.png
│   ├── hierarchies/
│   │   ├── hierarchy-###.json
│   │   └── *.npz
│   ├── clusters/
│   │   ├── toponymy-###.parquet
│   │   └── *.json
│   ├── scopes/
│   │   ├── scopes-###.json
│   │   └── scopes-###-input.parquet
│   ├── links/
│   │   ├── edges.parquet
│   │   ├── node_link_stats.parquet
│   │   └── meta.json
│   ├── lancedb/
│   ├── jobs/
│   └── tags/
└── <dataset>-likes/                   # optional sibling likes dataset
```

### Serving/storage split

- The pipeline still writes flat artifacts to the dataset directory.
- The API serves the active scope primarily from LanceDB.
- Catalog rows live in the local catalog DB by default, or in cloud catalog tables if `LANCEDB_CATALOG_URI` is set.
- Cloud export is optional and only happens when `LANCEDB_URI` and `LANCEDB_API_KEY` are configured.

## Useful Commands

```bash
# API dev
cd api && npm run dev

# API typecheck + tests
cd api && npm run typecheck
cd api && npm test

# Frontend dev
cd web && npm run dev

# Frontend typecheck + lint
cd web && npm run typecheck
cd web && npm run lint

# Run a Twitter import
uv run python3 -m latentscope.scripts.twitter_import my-tweets \
  --source zip \
  --zip_path archives/twitter-archive.zip \
  --run_pipeline

# Python tests (assumes the active environment is prepared)
uv run python3 -m pytest latentscope/tests
```

## Related Docs

- [README.md](README.md)
- [documentation/vercel-deployment.md](documentation/vercel-deployment.md)
- [documentation/cloudflare-r2-cdn.md](documentation/cloudflare-r2-cdn.md)
- [documentation/cluster-labeling-and-toponymy-design.md](documentation/cluster-labeling-and-toponymy-design.md)
