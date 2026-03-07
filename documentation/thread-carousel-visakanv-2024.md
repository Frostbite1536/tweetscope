# Thread Carousel — visakanv-2024 Import & Performance Work

**Date**: 2026-02-17
**Branch**: `feat/thread-carousel`
**Dataset**: `visakanv-2024` (14,989 tweets from community archive)

---

## Goal

Import ~1 year of visakanv tweets and get the thread carousel working without running the full embed/UMAP/cluster pipeline. The carousel should display self-reply threads as scrollable columns, with a TOC for navigation.

## What We Did

### 1. Imported visakanv 2024 tweets

```bash
uv run python3 latentscope/scripts/twitter_import.py visakanv-2024 \
  --source community --username visakanv --year 2024 \
  --build_links --exclude_likes
```

**Output:**
- 14,989 tweets → `visakanv-2024/input.parquet`
- 33,695 edges (reply + quote) → `visakanv-2024/links/edges.parquet`
- 14,989 node stats → `visakanv-2024/links/node_link_stats.parquet`
- LanceDB tables: `visakanv-2024__edges`, `visakanv-2024__node_stats`
- Dataset registered in `_catalog/lancedb/system__datasets`

### 2. Created stub scope (`tools/create_stub_scope.py`)

The carousel requires a scope (LanceDB table with serving columns) to function. Normally this requires embeddings → UMAP → clustering → labels → export. We bypass all of that.

```bash
uv run python3 tools/create_stub_scope.py --dataset visakanv-2024
```

**What it does:**
- Reads `input.parquet` + `meta.json`
- Builds scope DataFrame with **random x/y** coordinates, single cluster `"0"`, label `"all"`
- Copies all optional tweet columns (created_at, username, engagement, urls_json, etc.)
- Normalizes types via `scope_input` contract (same validation as real scopes)
- Writes `scopes/scopes-001-input.parquet` + `scopes/scopes-001.json`
- Creates LanceDB table (no vector column — API already excludes `vector` from queries)
- Registers via `catalog_registry.upsert_scope_meta()` + `upsert_dataset_meta()`

### 3. Fixed URL resolution (quoted tweet embeds)

The TS API (`api/src/routes/resolve-url.ts`) was migrated from Flask but lost URL **type classification**. Fixed:

| Before (broken) | After (fixed) |
|---|---|
| Returns `{ urls: [{original, resolved}] }` | Returns `{ results: [{original, final, type, media_url}] }` |
| No type classification | Classifies: `quote`, `image`, `video`, `external` |
| Frontend `urlResolver.js` reads `data.results` → gets `undefined` | Matches Flask response shape exactly |

**Classification rules** (in `classifyUrl()`):
- `pbs.twimg.com/media` → `image`
- `video.twimg.com` → `video`
- `x.com/*/status/\d+` or `twitter.com/*/status/\d+` → `quote` (extracts tweet ID)
- `.jpg/.png/.gif/.webp` extensions → `image`
- Everything else → `external`

### 4. Removed `clusterHierarchy` gate on carousel buttons

Both the sidebar expand button and "Browse All Topics" banner were gated on `{clusterHierarchy && ...}`. Stub scopes have flat clusters (no hierarchy), so these were hidden. Removed the gates — carousel buttons always show.

**Files**: `web/src/pages/V2/FullScreenExplore.jsx` (lines ~1224, ~1257)

### 5. Enabled TOC in thread mode

`FeedCarousel.jsx` had `hasTOC = !isThreadMode` — TOC was explicitly hidden for threads. Changed to `hasTOC = true`. The CarouselTOC works generically with any `{label, count, description}` objects.

### 6. Performance fixes

#### Problem: cascade re-renders on column data load

Every time a thread column's data arrived (`setColumnData`), these computations fired:
1. `threadsAsClusters` useMemo recomputed 1,782 objects (depended on `columnData`)
2. `columnRowsMap` useMemo rebuilt entire map
3. New array/object refs cascaded through FeedCarousel → re-rendered all children
4. `scrollX` state caused full re-render on every scroll frame
5. O(N) closest-column loop ran 1,782 iterations per frame
6. 1,782 placeholder `<div>`s rendered for offscreen columns

#### Fixes applied:

| Fix | File | Impact |
|---|---|---|
| Decoupled `threadsAsClusters` from `columnData` | `useThreadCarouselData.js` | Eliminates 1,782-object recomputation per column fetch |
| Removed `columnRowsMap` in thread mode | `useThreadCarouselData.js` | Eliminates intermediate object churn |
| FeedColumn reads root text from `tweets[0]` | `FeedColumn.jsx` | Thread labels derived locally, not from unstable cluster objects |
| Killed `scrollX` state → imperative TabHeader transform via ref | `FeedCarousel.jsx` | Scroll no longer triggers React re-render tree |
| O(1) closest-column math | `FeedCarousel.jsx` | `Math.round(...)` replaces O(1782) loop |
| 2 spacer divs replace 1,782 placeholders | `FeedCarousel.jsx` | Only `slice(visibleStart, visibleEnd+1)` columns rendered (~7) |
| TabHeader converted to `forwardRef` | `TabHeader.jsx` | Supports imperative transform updates |

---

## Data Shape

### Scope table schema (LanceDB + parquet)

All 24 serving columns from `contracts/scope_input.schema.json`:

| Column | Type | Source |
|---|---|---|
| `id` | string | Tweet ID |
| `ls_index` | int | 0-indexed row position |
| `x`, `y` | float | Random uniform [-10, 10] (stub) |
| `cluster` | string | `"0"` (single cluster) |
| `raw_cluster` | string | `"0"` |
| `label` | string | `"all"` |
| `deleted` | bool | `false` |
| `tile_index_64`, `tile_index_128` | int | Computed from x/y |
| `text` | string | Tweet text |
| `created_at` | string | ISO timestamp |
| `username`, `display_name` | string | `"visakanv"`, `"Visakan Veerasamy"` |
| `tweet_type` | string | `"tweet"` |
| `favorites`, `retweets`, `replies` | int | Engagement counts |
| `is_reply`, `is_retweet`, `is_like` | bool | Tweet flags |
| `urls_json`, `media_urls_json` | json_string | Serialized URL arrays |
| `archive_source` | string | `"community_archive"` |

### Thread discovery output (`/api/datasets/:id/links/threads`)

```json
{
  "threads": [
    {
      "root_ls_index": 42,
      "root_tweet_id": "1234567890",
      "size": 15,
      "member_indices": [42, 43, 44, ...],
      "member_depths": [0, 1, 2, ...]
    }
  ],
  "total": 1782
}
```

### Thread stats for visakanv-2024

| Metric | Value |
|---|---|
| Total threads | 1,782 |
| Threads >= 3 tweets | 802 |
| Threads >= 10 tweets | 66 |
| Threads >= 50 tweets | 1 |
| Largest thread | 79 tweets |
| Average thread size | 3.5 tweets |
| Total tweets in threads | 6,161 / 14,989 |

### API response sizes

| Endpoint | Size | Latency |
|---|---|---|
| `/views/scopes-001/rows` | 9.7 MB | 525ms |
| `/links/node-stats` | 886 KB | 65ms |
| `/links/threads` | 236 KB | 95ms |

---

## Data Location

All under `$LATENT_SCOPE_DATA` (`~/latent-scope-data`):

```
visakanv-2024/
  input.parquet              # 14,989 tweets
  meta.json                  # Dataset metadata (columns, text_column, etc.)
  links/
    edges.parquet            # 33,695 reply+quote edges
    node_link_stats.parquet  # 14,989 node stats (thread_root_id, thread_depth, etc.)
    meta.json                # Links metadata
  scopes/
    scopes-001.json          # Scope metadata (lancedb_table_id, cluster_labels_lookup, etc.)
    scopes-001-input.parquet # 14,989 rows × 24 serving columns
  lancedb/
    visakanv-2024__<uuid>.lance     # Scope LanceDB table
    visakanv-2024__edges.lance      # Edges LanceDB table
    visakanv-2024__node_stats.lance # Node stats LanceDB table

_catalog/lancedb/
  system__datasets   # Dataset registry (dataset_id, active_scope_id, visibility, etc.)
  system__scopes     # Scope registry (scope_pk, lancedb_table_id, is_active, etc.)
```

---

## Key File References

### Data pipeline
| File | Purpose |
|---|---|
| `tools/create_stub_scope.py` | **New** — stub scope generator |
| `latentscope/scripts/twitter_import.py` | Tweet import (community archive + link building) |
| `latentscope/pipeline/catalog_registry.py` | `upsert_dataset_meta()`, `upsert_scope_meta()` |
| `latentscope/pipeline/contracts/scope_input.py` | `SERVING_COLUMNS`, `normalize_serving_types()`, `validate_scope_input_df()` |
| `contracts/scope_input.schema.json` | Column type/nullable contract |

### API (Hono TS)
| File | Purpose |
|---|---|
| `api/src/routes/graph.ts` | `/links/threads`, `/links/thread/:tweetId`, `/links/by-indices` |
| `api/src/lib/graphRepo.ts` | `discoverThreads()` — server-side thread discovery from edges |
| `api/src/routes/resolve-url.ts` | **Fixed** — URL resolution with type classification |
| `api/src/routes/views.ts` | `/views/:view/rows` — scope row serving |
| `api/src/lib/lancedb.ts` | LanceDB connection management, table caching |
| `api/src/lib/catalogRepo.ts` | Registry queries with visibility filtering |

### Frontend (React)
| File | Purpose |
|---|---|
| `web/src/hooks/useThreadCarouselData.js` | Thread carousel data hook |
| `web/src/components/Explore/V2/Carousel/FeedCarousel.jsx` | Main carousel container (virtualized columns) |
| `web/src/components/Explore/V2/Carousel/FeedColumn.jsx` | Individual column (thread header + tweet list) |
| `web/src/components/Explore/V2/Carousel/CarouselTOC.jsx` | Table of contents sidebar |
| `web/src/components/Explore/V2/Carousel/TabHeader.jsx` | Scrolling tab bar (forwardRef, imperative transform) |
| `web/src/components/Explore/V2/TweetFeed/TweetCard.jsx` | Tweet card (lazy URL resolution via IntersectionObserver) |
| `web/src/components/Explore/V2/TweetFeed/TwitterEmbed.jsx` | Twitter widget embed |
| `web/src/lib/urlResolver.js` | Batched URL resolution with caching |
| `web/src/pages/V2/FullScreenExplore.jsx` | Main explore page (3-panel layout, carousel mode toggle) |

---

## Constraints & Assumptions

1. **No vector column** — stub scope has no embeddings, so nearest-neighbor search is unavailable. The API already excludes `vector` from serving queries, so this is safe.

2. **Random scatter layout** — x/y are uniform random. The scatter plot shows noise. Acceptable for thread-only browsing; upgrade by running the full pipeline later.

3. **Single cluster** — all tweets in cluster `"0"` with label `"all"`. Topics mode shows one big group. Thread mode is unaffected.

4. **Flat labels only** — `hierarchical_labels: false`. No topic hierarchy tree. The `clusterHierarchy` guard was removed from carousel buttons so they still appear.

5. **Community archive source** — tweets come from the public community archive API, not a native X export. Some fields (conversation_id, quoted_status_id) may be empty.

6. **Thread discovery is edge-based** — `discoverThreads()` uses internal reply edges (both src and dst in dataset). Threads to/from tweets outside the dataset are excluded.

7. **No rate limiting on Twitter embeds** — each TweetCard independently resolves t.co URLs when visible (IntersectionObserver + 100px margin). With ~7 visible columns × ~3.5 tweets avg, only ~25 cards are in the viewport at once. URL resolution is batched (5 per request, 3 concurrent).

8. **Dataset visibility** — registered as `public` in the catalog to work without `LATENT_SCOPE_APP_MODE=studio`. The `.env` already has `LATENT_SCOPE_APP_MODE=studio` for `npm run dev`.

9. **TabHeader still renders all 1,782 tabs** — only the transform is imperative now. Full virtualization of tabs is a future optimization if needed (low priority since tabs are lightweight DOM elements).

---

## How to Run

```bash
# API (port 3000)
cd api && npm run dev

# Frontend (port 5174 if 5173 is taken)
cd web && npm run dev

# Navigate to
open http://localhost:5174/datasets/visakanv-2024/explore/scopes-001
# Expand sidebar → Toggle to "Threads"
```

## Future Upgrades

- Run full pipeline (embed → UMAP → cluster → labels) for proper scatter layout and topic grouping
- Virtualize TabHeader tabs (1,782 lightweight buttons, low priority)
- Virtualize CarouselTOC list (1,782 items, medium priority if scroll perf is an issue)
- Server-side engagement scoring in `/links/threads` response to avoid iterating scopeRows client-side
- Use reducer for `columnData` state to avoid object spread copies
