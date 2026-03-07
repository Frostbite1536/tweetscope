# Explore Search + Filter Design (Implementation Handoff)

Date: 2026-02-20
Status: Phase 0-5 complete; search dropdown column suggestions removed; Phase 6+ pending
Scope: `web/` Explore V2

## 1) Task At Hand

We need to wire the Explore search/filter UI into the live app without breaking map, feed, timeline playback, or thread/quotes views.

Today, filter logic is spread across multiple components. That makes behavior hard to reason about and risky to change.  
Goal: one clear filter system that all UI parts share.

We also want Discord-style filter chips in the search bar (not just cluster handling), and chips must show up in suggestions/autocomplete so users can discover filter syntax.

## 2) Who This Doc Is For

1. Engineers implementing the refactor.
2. Engineers reviewing behavior and tradeoffs.
3. Agents loading context fresh and executing step-by-step.

## 3) Plain-English Terms

1. **Filter**: any rule that limits visible tweets/nodes.
2. **Filter type**: cluster, keyword search (FTS/BM25), semantic search (vector NN), column/value, time range.
3. **Composable filters**: multiple filters can be active at once; result is intersection (AND).
4. **Intent state**: what the user asked for (for example `cluster=12`, `search="ai"`, time range).
5. **Derived state**: computed result from intent (for example final visible `ls_index` list).
6. **Canonical source of truth**: one place in code that owns filter intent + derivation.
7. **`ls_index`**: the row identity used across Explore UI. It is the ID we should use for selection, filtering, map/feed sync, and graph lookups.

## 4) Product Decisions (Already Confirmed)

### 4.1 Filter Composition

Filters are composable (AND).

### 4.2 Timeline Behavior

Timeline is a real filter type, including playback mode (nodes appear over time automatically).

### 4.3 Thread/Quotes Panels

Keep active filters when entering thread/quotes.

1. Thread/quotes data is conversation-centric and may include nodes outside current filter.
2. Closing panel returns to the exact same filtered map/feed state.

### 4.4 URL Behavior

URL should represent full user filter intent (shareable view), not computed/cache data.

### 4.5 Search Bar UX

Search bar should support Discord-style chips for active filters (cluster, keyword/semantic query, time).

1. Chips are visible tokens in the input area.
2. Chips can be removed inline.
3. Suggestion dropdown includes search-intent + cluster suggestions (not plain text only).
4. Cluster is not a special one-off; chip model is generic across filter types.

## 5) Data Model + Where To Read It

This section is for fresh implementers who need data-shape truth before touching UI logic.

## 5.1 Frontend Types (Primary Reference)

Read first:

1. `web/src/api/types.ts`

Important interfaces:

1. `ScopeRow` (`ls_index`, `cluster`, `deleted`, engagement fields).
2. `ScopeData` (`dataset`, `cluster_labels_lookup`, `hierarchical_labels`).
3. `NodeStatsResponse` and `NodeStatsEntry` (thread/quote metadata keyed by `ls_index`).

## 5.2 Runtime Data Load Path

1. `ScopeContext` loads `scope` + `scopeRows` and normalizes `ls_index`:  
   `web/src/contexts/ScopeContext.tsx`
2. `FilterContext` builds base indices from non-deleted `scopeRows`:  
   `web/src/contexts/FilterContext.jsx`
3. Map rendering consumes filtered visibility via `VisualizationPane`:  
   `web/src/components/Explore/V2/VisualizationPane.jsx`

## 5.3 Backend Contract References (If Needed)

1. Scope rows endpoint shape: `api/src/routes/views.ts`
2. Indexed/query row fetch shape: `api/src/routes/query.ts`

Notes for implementers:

1. Row fetch paths may return `index`; UI must consistently reconcile to `ls_index`.
2. Do not assume array position equals `ls_index`.

## 5.4 Code Hotspots (Start Here)

These are the exact places to inspect before editing behavior:

1. `web/src/components/Explore/V2/TopicTree.jsx` (`handleSelectCluster`, `handleClearFilter`)
2. `web/src/pages/V2/FullScreenExplore.jsx` (`handleFilterToCluster`, `handlePointSelect`)
3. `web/src/components/Explore/V2/Search/Container.jsx` (`handleSelect`, `handleClear`)
4. `web/src/contexts/FilterContext.jsx` (URL hydration + serialization effects)
5. `web/src/pages/V2/FullScreenExplore.jsx` (playback `requestAnimationFrame` loop + 300ms debounced time commit)
6. `web/src/components/Explore/V2/VisualizationPane.jsx` (consume canonical `visibleIndexSet`)
7. `web/src/hooks/useThreadData.js` (`parent_chain` copy-before-reverse fix area)

## 6) Current System (Updated Through Phase 4)

Key files:

1. `web/src/contexts/ScopeContext.tsx`
   Loads scope rows and cluster metadata.
2. `web/src/contexts/FilterContext.jsx`
   Owns URL parse/serialize for filter params, holds `filterConfig`, computes filtered indices, paginates/fetches rows. Supports 5 filter types: `CLUSTER`, `SEARCH` (semantic), `KEYWORD_SEARCH` (FTS), `COLUMN`, `TIME_RANGE`.
3. `web/src/pages/V2/FullScreenExplore.jsx`
   Owns timeline/playback local state and dispatches filter state (no direct filter URL writes).
4. `web/src/components/Explore/V2/TopicTree.jsx`
   Dispatches filter state only (no direct filter URL writes).
5. `web/src/components/Explore/V2/Search/Container.jsx`
   Search bar with keyword/semantic mode toggle. Dispatches `applyKeywordSearch`/`applySearch` based on active mode.
6. `web/src/components/Explore/V2/VisualizationPane.jsx`
   Uses filter result to dim/select map points.
7. `api/src/routes/search.ts`
   Provides semantic nearest-neighbor search (`/api/search/nn`) and keyword FTS search (`/api/search/fts`).
8. `api/src/lib/lancedb.ts`
   `vectorSearch()` for semantic, `ftsSearch()` + `ensureFtsIndex()` for keyword.
9. `web/src/hooks/useKeywordSearch.js`
   FTS/BM25 search hook (mirrors `useNearestNeighborsSearch`).

Historical issue (resolved in Phase 2): there were multiple writers for filter + URL state.

Pre-Phase-2 duplication pattern (historical context):

1. `TopicTree.handleSelectCluster` builds a multi-step mutation sequence.
2. `FullScreenExplore.handleFilterToCluster` repeats effectively the same sequence.
3. `Search/Container.handleSelect` repeats a partial version of the same sequence.

The repeated ceremony includes combinations of:

1. update filter config
2. update active filter type/state
3. update query text/state
4. update cluster-local state
5. write URL params

This was the main reason for silent desync risk and is why reducer + centralized URL ownership were added.

## 7) Known Incomplete / Problematic Code (Important Context)

These are real code conditions a new implementer must know.

1. URL ownership for filters is centralized in `FilterContext` (Phase 2 complete).
2. All consumers now use canonical dispatchers only (Phase 3 complete):
   - `TopicTree`, `Search/Container`, `FullScreenExplore` use `applyCluster`/`applySearch`/`applyColumn`/`applyTimeRange`/`clearFilter`.
   - ~~`setFilterConfig` and `setFilterActive` shims~~ — removed in Phase 5.
   - `setFilterQuery` is still used by `Search/Container` for input field text only.
3. Current filter model is effectively single-mode:
   - `filterConfig` uses one active type branch in `FilterContext`.
4. Timeline dual-track behavior is preserved and clean:
   - local frame-rate playback range in `FullScreenExplore` for smooth map animation
   - debounced/committed `applyTimeRange()` calls for feed/query/URL behavior
5. Search UI paths are fully wired:
   - ~~`Search/Container` and `Search/SearchResults` exist but are cluster/NN only.~~ — Now support keyword + semantic mode toggle.
   - ~~`Search/NearestNeighbor.jsx` and `Search/Filters.jsx`~~ — removed in Phase 5.
   - Search dropdown suggestions are limited to keyword/semantic actions and clusters (column suggestions removed).
6. Known correctness items (resolved):
   - ~~Falsy cluster ID checks (`0` can be mishandled)~~ — fixed in Phase 0.
   - ~~`useThreadData` mutation risk~~ — fixed in Phase 0 (`[...parent_chain].reverse()`).
   - `DeckGLScatter` has a missing dependency warning around `pointScale` (pre-existing, not filter-related).
   - ~~Dark mode violations in `SearchResults.module.scss`~~ — fixed in Phase 4 (removed hardcoded hex colors and `@media prefers-color-scheme` blocks).
7. ~~Search capability mismatch~~ — resolved in Phase 4:
   - ~~Product wording says "search", but backend currently exposes semantic nearest-neighbor only.~~ — Now has both `/api/search/nn` (semantic) and `/api/search/fts` (keyword).
   - ~~No dedicated FTS/BM25 keyword endpoint exists yet.~~ — `ftsSearch()` + `ensureFtsIndex()` added to `lancedb.ts`.
8. URL hydration precedence is explicit (`cluster` > `keyword` > `search` > `column+value`):
   - `keyword` param added in Phase 4 between `cluster` and `search`.

## 8) Business Logic We Must Preserve

1. Use `ls_index` as canonical row identity.
2. Non-deleted rows are the base set.
3. Feed pagination is based on filtered result order.
4. Timeline playback updates visible nodes over time.
5. Thread/quotes opening does not destroy user filter context.
6. Existing graph/thread fetch behavior remains intact.

## 9) Why Users Want This (With Scenarios)

### 9.1 Combined Filtering

User sets:

1. cluster = `12`
2. search = `"startup"`
3. column filter `username=foo`
4. time range Jan 2021 to Dec 2022

Why this matters:

1. Users are narrowing to a meaningful slice, not just browsing one dimension.
2. If map and feed disagree here, trust breaks immediately.

Expected:

1. Map + feed show only rows satisfying all four constraints.

### 9.2 Playback + Active Filters

User enables playback while other filters are active.

Why this matters:

1. Playback is an exploration mode, not a reset.
2. Users expect to watch a chosen subset evolve over time.

Expected:

1. Existing filters stay active.
2. Time window animates visibility without discarding prior constraints.

### 9.3 Thread Panel While Filtered

User opens a thread from filtered map/feed.

Why this matters:

1. Reading a thread requires context that may extend outside current filter slice.
2. Users should not lose their working set when they return.

Expected:

1. Thread panel shows complete thread data.
2. Global filters remain unchanged.
3. Close panel -> previous filtered map/feed still there.

## 10) Architecture Design

## 10.1 Single Owner

`FilterContext` becomes the only owner of:

1. Filter intent state.
2. Filter derivation logic.
3. URL parse/serialize for filter params.

Other components dispatch actions only.

Important constraint:

1. This ownership rule is for intent + derived visibility state.
2. High-frequency playback preview state can stay local in `FullScreenExplore` for 60fps map updates.
3. Throttled/committed time intent still flows through `FilterContext` for feed/query/URL consistency.

## 10.2 Filter State Shape (Conceptual)

1. `cluster`: `{ active, clusterId, label }`
2. `search`: `{ active, query, status, resultSet }`
3. `column`: `{ active, column, value, status, resultSet }`
4. `time`: `{ active, start, end, domain, isPlaying, speed }`
5. `chips`: normalized UI tokens derived from canonical filter intent
   - example token shape: `{ type, key, label, value, removable }`

Notes:

1. `resultSet` for async filters may be loading/pending.
2. Time uses `timestampsByLsIndex` from existing timeline parsing.
3. Async filter slots should track resolution metadata:
   - `status`: `idle | loading | resolved | error`
   - `requestId`: guard against out-of-order responses
   - `lastResolvedSet`: most recent stable result for intersection

## 10.3 State Reconciliation Rules (Map, Feed, Timeline, Panels)

This is the critical implementation behavior:

1. **Map + feed reconciliation**:
   - Both consume the same derived visible indices from `FilterContext`.
   - No separate filtering logic in page/components.
2. **Pagination reconciliation**:
   - Any intent change resets feed paging to page 0.
3. **Timeline reconciliation**:
   - Keep dual-track model:
     - local preview range in `FullScreenExplore` updates at frame rate for map fluidity
     - committed time intent updates in `FilterContext` run on throttle and on playback stop
   - Feed/query derivation should use committed time intent, not frame-by-frame preview.
4. **Thread/quotes reconciliation**:
   - Opening panel does not mutate filter intent.
   - Panel fetch logic can show out-of-filter nodes.
5. **URL reconciliation**:
   - URL parse/serialize only in `FilterContext`.
   - Other components never write filter URL params.

## 10.4 One Visibility Derivation

Inside `FilterContext`:

1. Build `baseIndices` from `scopeRows` excluding deleted.
2. Build active sets per filter type.
3. Compute `visibleIndicesOrdered` by intersection in base order.
4. Provide `visibleIndexSet` for O(1) checks.

Consumers:

1. Scatter uses `visibleIndexSet`.
2. Feed/pagination uses `visibleIndicesOrdered`.

No component should re-implement intersection math.

## 10.5 Async Filter Resolution Policy

Search and column filters can be async. We need deterministic behavior while requests are in flight.

Chosen v1 policy:

1. Keep showing the last stable intersection (do not blank the map/feed).
2. Mark affected chip(s) as loading.
3. When latest request resolves, atomically apply its set and recompute intersection.
4. Ignore stale responses using `requestId` comparison.

Rationale:

1. Avoids hard loading stalls.
2. Avoids full-screen visual snaps from clearing results.
3. Keeps behavior explainable to users and testable.

## 10.6 URL Contract

Params (updated through Phase 4):

1. `cluster`
2. `keyword` (FTS/BM25 search — added Phase 4)
3. `search` (semantic/vector NN search)
4. `column`
5. `value`
6. `time_start`
6. `time_end`
7. `play` (optional)
8. `speed` (optional)
9. `thread` (optional panel deep-link)

Rules:

1. Parse invalid params safely (ignore bad values).
2. Hydrate all known params in one pass (not first-key-only parsing).
3. Serialize from canonical state only.
4. Never store derived index arrays in URL.
5. Chip UI is projection of canonical state, not a separate URL state.
6. Playback URL writes should be commit-on-stop (avoid history churn during animation).

## 10.7 Search Input + Chips Interaction Model

1. Input supports mixed free text + chip tokens.
2. Autocomplete suggests:
   - query mode actions (`keyword`, `semantic`) when applicable
   - matching cluster suggestions
   - no column facet suggestions
3. Selecting a suggestion either:
   - commits a chip immediately, or
   - fills token draft and commits on delimiter/enter.
4. Backspace behavior:
   - when draft text is empty, focus/remove last removable chip.
5. Chip removal dispatches canonical filter clear/update action.
6. Suggestion ranking prioritizes valid next tokens over generic text suggestions.
7. v1 scope is visual chips + click removal + suggestion-based creation.
8. Keyboard chip navigation/removal excluded from current scope (future work).

## 10.8 State Management Options (And Why This Plan Uses Context + Reducer)

We considered these approaches for filter state:

1. **Keep current Context + scattered `useState` writes**  
   Pros: no refactor overhead.  
   Cons: this is the current failure mode; ownership is fragmented.
2. **Context + reducer in existing `FilterContext` (chosen)**  
   Pros: explicit transitions, incremental migration, no new library, lowest rollout risk.  
   Cons: still local to React tree, not a global store library.
3. **External store (Zustand/Redux Toolkit)**  
   Pros: strong tooling and scalable global state patterns.  
   Cons: higher migration cost right now; dual state systems during transition.
4. **State machine framework (XState)**  
   Pros: excellent for explicit mode transitions.  
   Cons: heavier modeling overhead for current scope.

Why chosen now:

1. We need behavior correctness first, with minimal platform churn.
2. `ScopeContext` + `FilterContext` already exist; reducer migration is straightforward.
3. Once behavior is stable, we can revisit external store adoption based on real pain.

## 10.9 Search Architecture: FTS, Semantic, Hybrid

### 10.9.1 Infrastructure Audit (Updated Through Phase 4)

| Layer | File | Status |
|-------|------|--------|
| Scope table schema | `contracts/scope_input.schema.json` | `text` (required string), `vector`, `cluster`, `deleted`, `ls_index` |
| Indexes (Python export) | `latentscope/scripts/export_lance.py` | ANN on `vector`, BTREE on `cluster`. FTS on `text` pending (Python pipeline update — see 10.11.1) |
| TS SDK — FTS | `api/src/lib/lancedb.ts` | `ftsSearch()` + `ensureFtsIndex()` implemented (Phase 4). Lazy FTS index creation for existing tables. |
| TS SDK — vector | `api/src/lib/lancedb.ts` | `vectorSearch()` — unchanged |
| Backend routes | `api/src/routes/search.ts` | `GET /api/search/nn` (semantic) + `GET /api/search/fts` (keyword) — both implemented |
| Frontend hooks | `web/src/hooks/` | `useNearestNeighborsSearch.js` (semantic) + `useKeywordSearch.js` (keyword) — both implemented |
| FilterContext | `web/src/contexts/FilterContext.jsx` | `SEARCH` (semantic) + `KEYWORD_SEARCH` (keyword) — both implemented |
| URL params | FilterContext | `search=...` (semantic) + `keyword=...` (keyword) — both implemented |
| Search UI | `Search/Container.jsx` + `Search/SearchResults.jsx` | Mode toggle (keyword/semantic) + search/clusters suggestions. Column suggestions removed. |

Remaining gap: `export_lance.py` does not yet create the FTS index at export time. The TS `ensureFtsIndex()` handles this lazily for existing tables, but new exports should include FTS index creation for immediate availability.

### 10.9.2 Three Search Modes

| Mode | Backend path | Embedding call? | Latency | Strength | Score field | Score direction |
|------|-------------|-----------------|---------|----------|-------------|-----------------|
| Keyword (FTS/BM25) | LanceDB `table.search(query, "fts")` | No | ~50ms | Exact term/phrase matching | `_score` | Higher = better |
| Semantic (vector NN) | VoyageAI embed + LanceDB cosine | Yes (VoyageAI) | ~300-500ms | Concept/meaning matching | `_distance` | Lower = better |
| Hybrid (FTS + vector + RRF) | Both + `RRFReranker` | Yes (VoyageAI) | ~400-600ms | Both, fused ranking | `_relevance_score` | Higher = better |

**Score semantics warning:** BM25 `_score` and cosine `_distance` are on incompatible scales and directions. The frontend must **never** mix or compare them. Hybrid mode uses Reciprocal Rank Fusion (RRF) which produces its own unified `_relevance_score`.

User intent types are different:

1. **Keyword intent**: "show tweets containing exact terms/phrases." → FTS
2. **Concept intent**: "show tweets semantically related to this idea." → Semantic
3. **Both**: "find tweets about startups that mention YC" → Hybrid (future)

### 10.9.3 Rollout History

1. **Phase 4** (COMPLETE): Wired both keyword (FTS/BM25) and semantic (vector NN) search with mode toggle. Keyword is the default. Backend `/api/search/fts` endpoint, `useKeywordSearch` hook, `KEYWORD_SEARCH` filter type, `keyword=...` URL param, and mode toggle UI all shipped together.
2. **Phase 4.6** (future): Hybrid with `RRFReranker`, merged ranking, single search input

Why separate modes before hybrid:

1. No opaque blended ranking while we lack evaluation metrics for our specific dataset.
2. Users can learn which mode fits their intent (exact lookup vs conceptual exploration).
3. FTS is independently valuable: faster (~50ms vs ~500ms), no VoyageAI embedding cost, works offline.
4. Simpler debugging — when results look wrong, it's clear which search path produced them.

## 10.10 Reducer vs Hook Responsibilities

Reducer/state layer responsibilities:

1. own filter intent per slot
2. own status lifecycle for async slots
3. own URL parse/serialize
4. expose canonical derived outputs (`visibleIndicesOrdered`, `visibleIndexSet`, chips)

Hook/compute layer responsibilities:

1. `useClusterFilter`: compute cluster result set from scope rows + metadata
2. `useNearestNeighborsSearch`: execute semantic search via VoyageAI embed + LanceDB cosine; return result set/status/distances
3. `useKeywordSearch`: execute FTS/BM25 query via LanceDB FTS; return result set/status/scores

Rule:

1. hooks are compute engines; reducer/context is the state owner.

## 10.11 LanceDB FTS Technical Reference

This section is a concrete SDK reference for implementers. Both SDKs are already installed — no new dependencies.

### 10.11.1 Python SDK (`lancedb==0.19.0`) — Index Creation at Export Time

FTS index creation goes in `latentscope/scripts/export_lance.py`, inside `_create_table()` after the existing BTREE index:

```python
# After: tbl.create_scalar_index("cluster", index_type="BTREE")
tbl.create_fts_index("text", language="English", with_position=True)
tbl.wait_for_index(["text_idx"])  # blocks until FTS index is ready
```

FTS index parameters and tradeoffs:

| Param | Default | Our choice | Tradeoff |
|-------|---------|------------|----------|
| `with_position` | `False` | `True` | Enables phrase search (`"exact phrase"`); ~2-3x index size, acceptable at tweet scale (~100K rows) |
| `language` | `"English"` | `"English"` | Stemming + stop words for that language |
| `stem` | `True` | `True` | "running" matches "run" |
| `remove_stop_words` | `True` | `True` | Drops "the", "a", etc. — saves space |
| `ascii_folding` | `True` | `True` | "cafe" matches "cafe" |
| `base_tokenizer` | `"simple"` | `"simple"` | Split on punctuation/whitespace |
| `max_token_length` | `40` | `40` | Filters out base64 blobs, long URLs |

Note: `create_fts_index` returns immediately; the index builds asynchronously. Use `table.wait_for_index(["text_idx"])` to block until ready. The index name is `{column}_idx` by convention.

### 10.11.2 TypeScript SDK (`@lancedb/lancedb@^0.15.0`) — Querying + Lazy Index Fallback

**Index detection and lazy creation (for pre-FTS tables):**

```typescript
import * as lancedb from "@lancedb/lancedb";

// Detect existing FTS index
const indices = await table.listIndices(); // → IndexConfig[]
const hasFts = indices.some(
  (i) => i.indexType === "FTS" && i.columns.includes("text")
);

// Create FTS index if missing (lazy fallback)
if (!hasFts) {
  await table.createIndex("text", {
    config: lancedb.Index.fts({ withPosition: true, language: "English" }),
  });
}
```

**Simple FTS query (BM25):**

```typescript
const results = await table
  .search(query, "fts")      // query_type = "fts"
  .select(["index"])          // only return the row index
  .where("deleted = false")   // metadata prefilter (default)
  .limit(100)
  .toArray();
// Returns: [{ index: number, _score: number, ... }]
// _score is BM25 relevance (higher = better)
```

**Advanced query types:**

```typescript
import {
  MatchQuery, PhraseQuery, BooleanQuery, MultiMatchQuery,
  Occur, BoostQuery
} from "@lancedb/lancedb";

// Fuzzy match (typo tolerance)
new MatchQuery(query, "text", { fuzziness: 1, maxExpansions: 50 });

// Exact phrase (requires withPosition: true on index)
new PhraseQuery("exact phrase", "text", { slop: 0 });

// Boolean AND/OR/NOT
new BooleanQuery([
  [Occur.Must,    new MatchQuery("term1", "text")],
  [Occur.Should,  new MatchQuery("term2", "text")],
  [Occur.MustNot, new MatchQuery("spam", "text")],
]);

// Multi-column search with per-column boosts
new MultiMatchQuery("query", ["text", "username"], {
  boosts: [1.0, 0.5],
});

// Boost a sub-query
new BoostQuery(new MatchQuery("important", "text"), 2.0);
```

**Hybrid search (future Phase 4.6):**

```typescript
import { rerankers } from "@lancedb/lancedb";

const reranker = await rerankers.RRFReranker.create(60); // k=60

const results = await table
  .query()
  .fullTextSearch("keyword query")
  .nearestTo(embeddingVector)
  .rerank(reranker)
  .select(["index"])
  .where("deleted = false")
  .limit(100)
  .toArray();
// Returns: [{ index: number, _relevance_score: number, ... }]
```

### 10.11.3 Key Limitations and Gotchas

1. **No boolean operators in raw search strings** — typing `term1 AND term2` does NOT perform boolean AND. Must use `BooleanQuery` class for that.
2. **Phrase search requires `withPosition: true`** on FTS index creation. Without it, `PhraseQuery` silently degrades.
3. **Score incompatibility** — `_score` (BM25, higher=better) vs `_distance` (cosine, lower=better). Never merge.
4. **Async index creation** — `create_fts_index` (Python) and `createIndex` (TS) return before the index is ready. First query against an unfinished index may fail or return partial results.
5. **Pre-filtering is default** — `.where()` clause runs before search, narrowing the search space. This is what we want (filter out `deleted = true` before ranking).
6. **Field names with special characters** need backtick escaping in `.where()` clauses (e.g., `` `column name` ``). Our schema uses clean names so this shouldn't apply.

### 10.11.4 SDK Reference URLs

| Resource | URL |
|----------|-----|
| TS SDK index | https://lancedb.github.io/lancedb/js/globals/ |
| Table class | https://lancedb.github.io/lancedb/js/classes/Table/ |
| Query class | https://lancedb.github.io/lancedb/js/classes/Query/ |
| Index class | https://lancedb.github.io/lancedb/js/classes/Index/ |
| FtsOptions | https://lancedb.github.io/lancedb/js/interfaces/FtsOptions/ |
| MatchQuery | https://lancedb.github.io/lancedb/js/classes/MatchQuery/ |
| PhraseQuery | https://lancedb.github.io/lancedb/js/classes/PhraseQuery/ |
| BooleanQuery | https://lancedb.github.io/lancedb/js/classes/BooleanQuery/ |
| Occur enum | https://lancedb.github.io/lancedb/js/enumerations/Occur/ |
| RRFReranker | https://lancedb.github.io/lancedb/js/namespaces/rerankers/classes/RRFReranker/ |
| FTS search guide | https://docs.lancedb.com/search/full-text-search |
| Hybrid search guide | https://docs.lancedb.com/search/hybrid-search |
| FTS index guide | https://docs.lancedb.com/indexing/fts-index |
| Filtering guide | https://docs.lancedb.com/search/filtering |

## 11) Options Considered

### 11.1 Thread/Quotes + Filters

Option 1: preserve filters (chosen).  
Option 2: clear/suspend filters on open (rejected).

Reason for rejection: state surprise + user context loss.

### 11.2 URL Scope

Option 1: primary filter only (rejected).  
Option 2: full intent state (chosen).

Reason for rejection: primary-only cannot represent composable filters.

### 11.3 Search Semantics

Option 1: semantic-only forever (rejected as long-term plan).  
Option 2: FTS-only (rejected).  
Option 3: staged hybrid (chosen target).

Reason:

1. Users need exact keyword retrieval and conceptual retrieval.
2. One mode alone will fail for a meaningful portion of queries.

### 11.4 Async Slot UX During In-Flight Requests

Option 1: pessimistic blank/loading gate (rejected for v1).  
Option 2: immediate optimistic projection with no loading affordance (rejected).  
Option 3: last-stable-results + loading chip state (chosen).

Reason:

1. Keeps UI responsive while avoiding confusing empty-state flicker.
2. Makes async state explicit to users.

## 12) Implementation Plan

## Phase 0: Preconditions — COMPLETE

1. ~~Keep existing UI behavior stable while introducing new internals.~~
2. ~~Add minimal guard logs for invalid filter payloads.~~
3. ~~Audit and fix `clusterId` truthy checks (`if (clusterId)`) to explicit null/undefined checks.~~
   - Fixed: `useCarouselData.js:59`, `useCarouselData.js:211`, `SubClusterPills.jsx:9`
4. ~~Fix query-cache mutation in `useThreadData` (`reverse()` should not mutate cached arrays in place).~~
   - Fixed: `useThreadData.js:86` — `[...parent_chain].reverse()`
5. ~~Add `visibleIndexSet` to `FilterContext` output so consumers stop rebuilding it ad hoc.~~
   - Added to `FilterContext.jsx`; `VisualizationPane.jsx` now consumes it directly

## Phase 1: Canonical Filter Actions — COMPLETE

Replaced 3 scattered `useState` calls with `useReducer(filterReducer, initialFilterState)`.

Added canonical dispatcher functions:
1. ~~`applyCluster(cluster)`~~ — dispatches + `clusterFilter.setCluster()`
2. ~~`applySearch(query)`~~ — dispatches only (async filter runs in existing effect)
3. ~~`applyColumn(column, value)`~~ — dispatches only
4. ~~`applyTimeRange(start, end, timestampsByLsIndex, label)`~~ — dispatches only
5. ~~`clearFilter(filterType?)`~~ — dispatches + clears relevant hook state

Compatibility shims kept for existing callers: `setFilterConfig`, `setFilterQuery`, `setFilterActive`.
`timeRangePreviewTick` and `commitTimeRange` deferred to Phase 3 (timeline consumer migration).

## Phase 2: Centralize URL Logic — COMPLETE

Implemented in:

1. `web/src/contexts/FilterContext.jsx`
2. `web/src/components/Explore/V2/TopicTree.jsx`
3. `web/src/components/Explore/V2/Search/Container.jsx`
4. `web/src/pages/V2/FullScreenExplore.jsx`

What was completed:

1. URL parsing and writing moved into `FilterContext` as sole filter-URL owner.
2. First-key hydration replaced with explicit multi-param checks:
   - `cluster` first
   - else `keyword`
   - else `search`
   - else `column + value`
3. Added URL serialization effect from canonical `filterConfig`:
   - `cluster` => set `cluster`, clear `keyword/search/column/value/feature`
   - `keyword` => set `keyword`, clear `cluster/search/column/value/feature`
   - `search` => set `search`, clear `cluster/keyword/column/value/feature`
   - `column` => set `column + value`, clear `cluster/keyword/search/feature`
   - `timeRange` => no URL write (deferred per commit-on-stop policy)
   - `null` filter => clear all filter params
4. Removed direct filter URL writes from:
   - `TopicTree`
   - `Search/Container`
   - `FullScreenExplore`
5. Kept `setUrlParams` exposed on context for future non-filter URL concerns (for example thread deep-link flows).

Concurrency hardening from review:

1. URL skip guard is signature-based, not boolean.
2. Hydration sets target signature and uses canonical actions (`applyCluster`, `applySearch`, `applyColumn`) so skip is released only after matching filter state is reached.
3. This avoids premature skip clearing if React render timing splits updates.

## Phase 3: Migrate Consumers — COMPLETE

Replaced all compatibility shim calls (`setFilterConfig`, `setFilterActive`, `setFilterQuery`) with canonical dispatchers across three consumer files:

1. ~~`TopicTree.jsx`: `handleSelectCluster` → `applyCluster()`, `handleClearFilter` → `clearFilter(CLUSTER)`~~
2. ~~`Search/Container.jsx`: `handleSelect` → type-routed `applyCluster`/`applySearch`/`applyColumn` with explicit `Number(value)` cluster ID normalization; `handleClear` → `clearFilter(type)`~~
3. ~~`SearchResults.jsx`: removed cluster `setFilterQuery(\`Cluster ${data.value}\`)` override that was clobbering the real cluster label set by `applyCluster`'s reducer dispatch~~
4. ~~`FullScreenExplore.jsx` (8 call sites):~~
   - ~~`handleFilterToCluster` → `applyCluster(cluster)`~~
   - ~~`handlePointSelect` cluster-clear branch → `clearFilter(CLUSTER)`~~
   - ~~`handleTimeRangeChange` → `applyTimeRange()` / `clearFilter(TIME_RANGE)`~~
   - ~~`handlePlayToggle` → `applyTimeRange()`~~
   - ~~rAF static-duration fallback → `applyTimeRange()`~~
   - ~~playback debounce effect → `applyTimeRange()`~~
   - ~~domain-change sync effect → `applyTimeRange()` / `clearFilter(TIME_RANGE)`, removed `filterActive` from deps~~
5. ~~`VisualizationPane` reads canonical `visibleIndexSet`~~ (done in Phase 2)
6. ~~`TweetFeed` reads canonical `dataTableRows`~~ (already correct, no changes needed)

Timeline dual-track behavior preserved:
- Local `timeRange` state stays in FullScreenExplore for 60fps map animation
- `applyTimeRange()` called on: user slider gesture, playback debounce (300ms), playback start/stop, domain change sync
- rAF loop only updates local `setTimeRange()` — never calls a filter dispatcher directly

Design notes:
- `clearFilter(filterType)` performs a full reducer reset (`CLEAR_FILTER` → `{...initialFilterState}`) regardless of `filterType`; the arg only controls which hook's `.clear()` method is called. Correct for single-mode filter model.
- ~~`setFilterConfig` and `setFilterActive`~~ removed in Phase 5.
- `setFilterQuery` still used by `Search/Container.jsx` for input field typing (pre-commit text updates); not a shim for that use case.

## Phase 4: Wire Search/Filter UI + Keyword Search (FTS/BM25) — COMPLETE

Phases 4 and 4.5 from the original plan were merged into a single implementation since keyword search was the default mode from the start.

Implemented in:

1. `api/src/lib/lancedb.ts` — `ensureFtsIndex()`, `ftsSearch()`, `FtsResult` interface, `ftsIndexCache` Map
2. `api/src/routes/search.ts` — `GET /api/search/fts` route with Zod validation
3. `web/src/api/types.ts` — `KeywordSearchRawResponse` interface
4. `web/src/query/keys.ts` — `keywordSearch` query key factory
5. `web/src/lib/apiService.ts` — `searchKeyword()` method on `queryApi`
6. `web/src/hooks/useKeywordSearch.js` — new hook mirroring `useNearestNeighborsSearch`
7. `web/src/components/Explore/V2/Search/utils.js` — `KEYWORD_SEARCH` constant
8. `web/src/contexts/FilterContext.jsx` — `APPLY_KEYWORD_SEARCH` action, `applyKeywordSearch` dispatcher, `keyword` URL param, filter computation branch
9. `web/src/components/Explore/V2/Search/Container.jsx` — mode toggle button, dual-mode Enter key, mode-synced placeholder text
10. `web/src/components/Explore/V2/Search/SearchResults.jsx` — "Keyword search" / "Semantic search" actions + cluster suggestions, active mode listed first
11. `web/src/components/Explore/V2/Search/Container.module.scss` — `.modeToggle` / `.modeToggleSemantic` styles
12. `web/src/components/Explore/V2/Search/SearchResults.module.scss` — removed dark-mode hardcoded hex blocks

What was completed:

1. **Backend FTS endpoint**: `GET /api/search/fts?dataset=...&query=...&scope_id=...&limit=...`
   - Pure LanceDB FTS, no VoyageAI call, zero embedding cost
   - Response: `{ indices: number[], scores: number[] }` (BM25 scores, higher=better)
   - `getScopeTextColumn()` resolves text column from scope metadata with fallback to `"text"`
   - `ftsSearch()` performs column resolution (checks requested column exists in table, falls back to `"text"`)
   - `ensureFtsIndex()` does robust polling: 40 attempts @ 250ms for index registration, then 20s deadline waiting for `numUnindexedRows === 0`
   - Index existence cached per tableId+column in module-level Map
   - FTS route returns 503 for "index not ready yet" vs 500 for other errors
   - Bonus fix: `vectorSearch()` also updated to use `getIndexColumn()` instead of hardcoded `"index"`
2. **Frontend keyword search hook**: `useKeywordSearch` — mirrors `useNearestNeighborsSearch` pattern
   - `filter(query)` → calls FTS endpoint → returns ordered `ls_index[]`
   - `scoreMap` for BM25 scores (separate from semantic `distanceMap`)
   - Uses TanStack Query with `queryKeys.keywordSearch(...)` for caching (30s stale time)
3. **FilterContext integration**:
   - `filterConstants.KEYWORD_SEARCH = 'keyword'`
   - `ACTION.APPLY_KEYWORD_SEARCH` reducer action
   - `applyKeywordSearch(query)` canonical dispatcher
   - `KEYWORD_SEARCH` branch in filter computation effect
   - URL param: `keyword=...` (separate from `search=...`)
   - Hydration precedence: `cluster` > `keyword` > `search` > `column+value`
4. **Search UI**:
   - Mode toggle button appears when user has typed text in search bar
   - Default mode: **Keyword** (faster, no embedding cost)
   - Toggle switches between "Keyword" and "Semantic" labels
   - Semantic mode toggle uses accent color (`--semantic-color-semantic-info`)
   - Suggestion dropdown shows both "Keyword search: ..." and "Semantic search: ..." options
   - Suggestion dropdown shows clusters and does not show column facets
   - Active search mode's option listed first in suggestions
   - Placeholder text changes per mode: "Search by keyword..." / "Search by meaning..."
   - `SearchResultsMetadata` shows "Keyword Search" or "Semantic Search" label
5. **Dark mode cleanup**: Removed all `@media (prefers-color-scheme: dark)` and `:global(:root[data-theme="dark"])` blocks with hardcoded hex colors from `SearchResults.module.scss`
6. **distanceMap conditional**: `FullScreenExplore.jsx` only passes `distanceMap` to TweetFeed when filter type is `SEARCH` (semantic), preventing distance display for keyword results

Design decisions:
- Keyword is default mode (faster ~50ms vs ~500ms, no embedding cost, more intuitive for exact lookup)
- Single-mode filter model: only one search active at a time; switching mode clears the other
- BM25 `_score` and cosine `_distance` kept in separate score maps — never mixed
- Mode toggle syncs from `filterConfig.type` on URL hydration (e.g. loading `?keyword=foo` sets mode to keyword)

Remaining gap: `export_lance.py` does not yet create FTS index at export time. The TS `ensureFtsIndex()` handles this lazily, but new exports should include it for immediate availability.

### Edge Cases (Verified)

| Scenario | Behavior |
|----------|----------|
| Empty FTS query | Don't fire request. Return 400 or clear filter. |
| Query < 2 chars | Allow — no hard minimum. BM25 handles short queries fine. |
| Stop-words-only query ("the a is") | BM25 returns 0 results after stop-word removal. Show "No results" — don't crash. |
| Quoted phrase `"exact words"` | Pass to LanceDB as-is; BM25 handles phrase detection when `withPosition: true`. |
| Special chars in query | LanceDB FTS tokenizes naturally. No boolean ops in raw strings — just pass through. |
| FTS index missing on existing table | `ensureFtsIndex()` creates lazily with robust polling (40 attempts @ 250ms for registration, then 20s deadline for indexing). Route returns 503 if not ready. |
| FTS index still building | `ensureFtsIndex()` waits for `numUnindexedRows === 0` before caching. Python `wait_for_index` blocks at export time for new tables. |
| Stale FTS response | TanStack Query handles caching and deduplication; no manual seq tracking needed. |
| Score display | Don't show raw BM25 scores in UI. Just rank order. |
| Concurrent keyword + semantic | Single-mode filter model: only one search active at a time. Switching mode clears the other. |
| Very long query (>500 chars) | Truncate to first 200 chars before sending. LanceDB tokenizer handles the rest. |

## Phase 5: Remove Legacy Paths — COMPLETE

Implemented cleanup:

1. Removed `setFilterConfig` and `setFilterActive` from `FilterContext.jsx`.
2. Removed reducer compatibility actions `ACTION.SET_FILTER_CONFIG` and `ACTION.SET_FILTER_ACTIVE`.
3. Removed redundant search suggestion `setFilterQuery` writes in `SearchResults.jsx`; canonical dispatchers now own filter-query updates.
4. Removed redundant `clusterFilter.setCluster()` call in FilterContext's filter-computation branch.
5. Removed stale unused search stubs:
   - `web/src/components/Explore/V2/Search/NearestNeighbor.jsx`
   - `web/src/components/Explore/V2/Search/Filters.jsx`
6. Verified no remaining consumer references to removed compatibility shims.

## 13) Risks and Controls

1. **URL update loops**  
   Control: compare canonical state snapshots before writing.
2. **Playback causing fetch/render churn**  
   Control: throttle URL commits and fetch-trigger points.
3. **Mixed old/new code paths during migration**  
   Control: phase gates; delete compatibility only after consumer migration.
4. **Cluster id `0` bugs (truthy checks)**  
   Control: use explicit null/undefined checks everywhere.
5. **Chip UI retrofit complexity in current `react-select` customization**  
   Control: allow replace-vs-retrofit decision early in Phase 4 spike.
6. **Playback jank from collapsing map preview + committed filter paths**
   Control: preserve dual-track timeline model by design (preview tick vs committed time intent).
7. **FTS index missing on existing tables**
   Control: lazy `ensureFtsIndex()` with `listIndices()` check in TS; `export_lance.py` creates for new tables. Cache index existence per table to avoid repeated checks.
8. **First FTS query pays async index build cost**
   Control: cache index existence; show loading chip/spinner during first-time index creation. Python `wait_for_index()` blocks at export time so new tables are ready immediately.
9. **BM25 scores not comparable to cosine distances**
   Control: never merge score maps across modes. Separate `scores`/`scoreMap` (keyword) vs `distances`/`distanceMap` (semantic). Hybrid mode (Phase 4.6) uses RRF's unified `_relevance_score`.
10. **`withPosition: true` FTS index size increase (~2-3x)**
    Control: acceptable at tweet scale (~100K rows). Revisit if datasets grow to 1M+ rows.
11. **FTS index async creation race condition**
    Control: Python uses `wait_for_index()` to block. TS lazy fallback may need retry/poll if query fires while index is still building.

## 14) Acceptance Criteria

1. Map and feed always agree on what is visible.
2. Multiple filters work together (AND behavior).
3. Playback works with other filters active.
4. Thread/quotes preserve global filter state.
5. URL round-trips to same filter state.
6. `cd web && npm run typecheck` passes.
7. `cd web && npm run production` passes.
8. Search bar shows active filters as chips (not cluster-only).
9. Suggestions include keyword/semantic actions and cluster entries.
10. Removing a chip immediately updates visible map/feed/timeline state via canonical actions.
11. URL does not spam browser history during playback (commit-on-stop behavior).
12. Cluster `0` can be selected, persisted, and restored from URL correctly.
13. Keyword search returns results for exact terms present in tweet text.
14. Keyword and semantic search are clearly labeled in UI (chip label, suggestions).
15. Switching search mode preserves the query text in the input.
16. FTS endpoint does not call VoyageAI (no embedding cost for keyword search).
17. Missing FTS index triggers graceful lazy creation, not crash or empty results.
18. URL `keyword=...` round-trips correctly (hydrate on load, serialize on change).
19. Stop-words-only query shows "No results" instead of crashing.

## 15) Open Questions (Need Product/Eng Confirmation During Build)

### General (from earlier phases)

1. Dateless rows in time filter: default to include (current behavior). Do we need a user toggle later?
2. Playback URL writes: default to commit-on-stop. Do we need optional throttled live-share mode later?
3. Should `thread` param be included by default in share URLs when panel is open?
7. Should chip text syntax be exposed in docs/tooltips (for power users), or chip-first UI only?
8. Should we support keyboard-only chip navigation/removal in v1 (`Left/Right`, `Backspace`, `Delete`)?

### FTS / Search-specific

4. ~~**Default search mode after FTS ships: `Keyword` or `Semantic`?**~~
   DECIDED: Keyword. Implemented in Phase 4. Faster (~50ms vs ~500ms), no embedding cost, more intuitive for exact lookup. Users switch to semantic explicitly via mode toggle.

5. **Do we need phrase search in first FTS release (`"exact phrase"`)?**
   Recommendation: Yes. The `with_position=True` flag at export time is all we need. Acceptable index size increase at tweet scale. Users naturally expect quoted phrases to work.

6. **Do we need negation in first FTS release (`-term`)?**
   Recommendation: No for v1. Negation requires `BooleanQuery` with `Occur.MustNot`, which means parsing the query string ourselves. Defer to Phase 4.6 with hybrid/advanced search.

9. ~~**Merged hybrid ranking in v1, or mode toggle first?**~~
   DECIDED: Mode toggle first. Implemented in Phase 4. Hybrid (Phase 4.6) deferred until we understand usage patterns and have evaluation metrics.

10. **Multi-column FTS: `text` only (v1) vs `text` + `username` + `display_name` (future)?**
    Recommendation: `text` only for v1. Multi-column would use `MultiMatchQuery` with per-column boosts — powerful but adds complexity. Revisit based on user feedback.

11. **Fuzzy search in v1? (`MatchQuery({ fuzziness: 1 })`)**
    Recommendation: No for v1. Fuzzy matching helps with typos but adds noise. Standard BM25 with stemming already handles most morphological variations ("running" → "run"). Add as opt-in later.

12. **Minimum query length for FTS?**
    Recommendation: No hard minimum. BM25 handles single-character queries fine (they just return more results). The 300ms debounce handles the UX concern.

## 16) Execution Checklist For Fresh Agent

1. Read (filter system):
   - `web/src/api/types.ts`
   - `web/src/contexts/FilterContext.jsx`
   - `web/src/pages/V2/FullScreenExplore.jsx`
   - `web/src/components/Explore/V2/TopicTree.jsx`
   - `web/src/components/Explore/V2/Search/Container.jsx`
   - `web/src/components/Explore/V2/Search/SearchResults.jsx` — suggestion dropdown with react-select custom components (Option, Group, Menu)
   - `web/src/components/Explore/V2/VisualizationPane.jsx`
   - `web/src/hooks/useClusterFilter.js`
   - `web/src/hooks/useNearestNeighborsSearch.js`
   - `web/src/hooks/useKeywordSearch.js`
   - `web/src/hooks/useThreadData.js`
   - `api/src/routes/views.ts`
   - `api/src/routes/query.ts`
   - `api/src/routes/search.ts`
2. Read (FTS / search infrastructure — implemented in Phase 4):
   - `api/src/lib/lancedb.ts` — `vectorSearch()`, `ftsSearch()`, `ensureFtsIndex()`
   - `api/src/routes/search.ts` — `/nn` (semantic) and `/fts` (keyword) routes
   - `web/src/components/Explore/V2/Search/utils.js` — filter constants including `KEYWORD_SEARCH`
   - `latentscope/scripts/export_lance.py` — FTS index creation pending (Python pipeline gap)
3. Remaining work:
   - `export_lance.py`: add `create_fts_index("text", ...)` call at export time
4. Verify acceptance criteria (including FTS-specific items 13-19).
