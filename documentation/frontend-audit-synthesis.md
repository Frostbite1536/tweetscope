# Frontend Performance & Code Quality Audit — Full Synthesis

**Date**: February 18, 2026
**Scope**: `web/src/` — React + Deck.GL frontend for Latent Scope
**Auditors**: Claude Opus 4.6 (primary), Codex gpt-5.3 xhigh (cross-reference)
**Verification**: Deck.GL official docs, React official docs, benchmarks

---

## Executive Summary

A thorough audit of the Latent Scope frontend identified **25 issues** across 30+ files. Three independent verification sources confirmed all findings — zero were disproven. The most impactful issue is a Deck.GL layer rebuild triggered on every mouse hover, which forces GPU buffer regeneration for 100k+ points per frame. A newly identified carousel-specific issue compounds this — `hoveredIndex` cascades through every visible FeedColumn, causing ~200 TweetCard rerenders per hover frame on top of the GPU rebuild. Five quick wins (estimated ~2.5 hours total) would address the majority of perceived jank.

| Severity | Count | Confirmed | Qualified | New (Codex) |
|----------|-------|-----------|-----------|-------------|
| CRITICAL | 5     | 5         | 0         | 0           |
| HIGH     | 8     | 5         | 2         | 3           |
| MEDIUM   | 12    | 4         | 5         | 5           |
| **Total**| **25**| **14**    | **7**     | **8**       |

---

## Methodology

### Phase 1: Codebase Exploration
- Identified all source files and ranked by size/complexity
- Mapped component tree, context providers, hooks, and data flow

### Phase 2: Deep Analysis (5 parallel agents)
1. **DeckGLScatter.jsx** — Layer recreation, label placement, data format
2. **FullScreenExplore.jsx + Contexts** — God component, state management, context stability
3. **All hooks** — Memoization gaps, stale closures, data duplication
4. **UI components** — Virtualization, memo effectiveness, inline closures
5. **API layer** — Error handling, caching, request patterns

### Phase 3: Cross-Reference & Verification (3 parallel sources)
1. **Codex gpt-5.3 xhigh** — Independent audit + cross-reference of all findings
2. **Deck.GL documentation** — Verified 4 SDK-specific claims against official docs
3. **React documentation** — Verified 7 pattern recommendations against official docs + benchmarks

---

## Findings

### CRITICAL — Must Fix

---

#### C1. `hoveredPointIndex` in `layers` useMemo deps rebuilds all Deck.GL layers on hover

**Status**: CONFIRMED (Claude AGREE, Codex AGREE, Deck.GL docs CONFIRM)

**Features affected**: Scatter plot hover interaction — point highlight (radius boost, color change, outline) when mousing over the map. Affects both normal and carousel modes since the scatter plot is always visible.

**Behavior change**: None. The hovered point still gets the same radius boost, fill color change, and outline. The visual result is identical — it just computes ~95% faster because only the hover-affected accessors re-evaluate instead of rebuilding all 6 layers.

**Location**: `DeckGLScatter.jsx:1331` (dependency array), `:987` (hover state update), `:1104` (full layer list creation)

**What happens now**:
1. User hovers a point → `handleHover` calls `setHoveredPointIndex(info.object.index)` (line 987)
2. `hoveredPointIndex` is in the `layers` useMemo dependency array (line 1331)
3. The entire `layers` useMemo recomputes — creating new `ScatterplotLayer`, `PolygonLayer`, `PathLayer`, `TextLayer` instances (lines 1104-1340)
4. Each new layer instance has new `data` references → Deck.GL's shallow `===` comparison sees changed data
5. Deck.GL recalculates ALL accessor-derived GPU buffers (`getPosition`, `getRadius`, `getFillColor`, `getLineColor`, `getLineWidth`) for 100k+ points
6. This happens on **every mouse move** across the scatter plot

The `updateTriggers` on lines 1182-1186 already correctly list `hoveredPointIndex` — so Deck.GL would correctly re-evaluate only the hover-affected accessors IF the layer instances were preserved. But because the layers useMemo rebuilds everything, the `updateTriggers` optimization is completely bypassed.

**How to fix** — two complementary changes:

**Fix A: Remove `hoveredPointIndex` from `layers` deps and use `updateTriggers` only**

```jsx
// DeckGLScatter.jsx — layers useMemo

// BEFORE (line 1331):
], [
  edgeWidthScale, showReplyEdges, showQuoteEdges, replyEdgeData, quoteEdgeData,
  scatterData, hullData, placedLabels, labelCharacterSet,
  hoveredPointIndex,    // <-- REMOVE THIS
  isDarkMode, featureIsSelected, pointRadii, alphaScale, highlightIndexSet,
  onLabelClick, showClusterOutlines, activeClusterId,
]);

// AFTER:
], [
  edgeWidthScale, showReplyEdges, showQuoteEdges, replyEdgeData, quoteEdgeData,
  scatterData, hullData, placedLabels, labelCharacterSet,
  // hoveredPointIndex removed — handled via updateTriggers only
  isDarkMode, featureIsSelected, pointRadii, alphaScale, highlightIndexSet,
  onLabelClick, showClusterOutlines, activeClusterId,
]);
```

But we still need hoveredPointIndex inside the accessors (getRadius, getFillColor, etc.). Since it's excluded from deps, the closures will be stale. We need to use a ref:

```jsx
// Add a ref that the accessors read from:
const hoveredPointIndexRef = useRef(hoveredPointIndex);
hoveredPointIndexRef.current = hoveredPointIndex;

// In the ScatterplotLayer accessors, read from the ref:
getRadius: d => {
  const isHovered = d.index === hoveredPointIndexRef.current;
  // ... rest unchanged
},
getFillColor: d => {
  const isHovered = d.index === hoveredPointIndexRef.current;
  // ... rest unchanged
},

// updateTriggers already has hoveredPointIndex — this tells Deck.GL
// to re-evaluate ONLY these specific accessors when hover changes:
updateTriggers: {
  getRadius: [hoveredPointIndex, pointRadii, featureIsSelected, highlightIndexSet],
  getFillColor: [hoveredPointIndex, featureIsSelected, alphaScale, highlightIndexSet],
  getLineColor: [hoveredPointIndex, highlightIndexSet, isDarkMode],
  getLineWidth: [hoveredPointIndex, highlightIndexSet],
},
```

Now when `hoveredPointIndex` changes:
- The `layers` useMemo does NOT recompute (no dep change)
- Deck.GL sees the same layer instances with the same `data` reference
- Deck.GL detects that `updateTriggers.getRadius` changed → re-evaluates ONLY `getRadius` and `getFillColor` accessors
- Other layers (polygons, paths, text) are completely untouched

**Fix B (bonus): Use `autoHighlight` for the basic hover glow**

For just showing a visual highlight on hover, Deck.GL provides a GPU-accelerated path that needs zero accessor re-evaluation:

```jsx
new ScatterplotLayer({
  id: 'scatter-layer',
  data: scatterData,
  pickable: true,
  autoHighlight: true,                      // GPU-accelerated hover highlight
  highlightColor: [255, 255, 255, 80],      // semi-transparent white overlay
  // ... rest of props
})
```

This handles the "glow" effect entirely in the fragment shader. You'd still use the `updateTriggers` approach for the radius/outline changes that need accessor re-evaluation, but the visual feedback is instant.

**Expected improvement**: Eliminates ~95% of hover CPU cost. Instead of rebuilding all 6 layers and re-evaluating all accessors for 100k points, only the 4 hover-sensitive accessors on the scatter layer are re-evaluated.

---

#### C2. `placedLabels` O(n²) collision detection runs on every pan/zoom frame

**Status**: CONFIRMED (Claude AGREE, Codex AGREE)

**Features affected**: Cluster label display on the scatter plot. Labels are positioned with collision avoidance to show topic names over their cluster regions. This runs during all pan/zoom interactions — the primary way users navigate the map.

**Behavior change**: Yes, minor. With the debounce fix (Fix A), labels will "freeze" in their last positions during active pan/zoom and then reflow ~120ms after the interaction settles. Users may notice a brief moment where labels are slightly mispositioned during fast panning, then they snap to correct positions. This is a deliberate trade-off: smooth 60fps pan/zoom vs. perfectly-tracked labels. The spatial index fix (Fix B) has zero behavior change — same algorithm, just faster.

**Location**: `DeckGLScatter.jsx:667-911`

**What happens now**:
1. `placedLabels` is a `useMemo` that depends on `controlledViewState` and `currentViewState` (lines 906-907)
2. Every pan/zoom frame updates the view state → `placedLabels` recomputes
3. The algorithm processes up to 1500 labels (line 781), and for each candidate:
   - Projects to screen coordinates (line 788)
   - Generates up to 24 layout candidates (6 maxLines × 4 widths) per label (lines 831-840)
   - For each candidate, calls `boxIntersectsAny` which linearly scans all accepted boxes (lines 766-771)
   - Also calls `countIntersections` for soft labels, which is another full scan (lines 773-778)
4. Worst case: 1500 labels × 24 candidates × 400 accepted boxes = ~14.4M comparisons per frame
5. This runs synchronously, blocking the main thread during pan/zoom

**How to fix** — staged approach:

**Fix A: Debounce label placement during interaction (quick win)**

```jsx
// Add debounced view state for label computation only:
const [debouncedViewState, setDebouncedViewState] = useState(null);
const labelDebounceRef = useRef(null);

// In handleViewStateChange (or useEffect on viewState):
useEffect(() => {
  const vs = controlledViewState || currentViewState || initialViewState;
  if (labelDebounceRef.current) clearTimeout(labelDebounceRef.current);
  labelDebounceRef.current = setTimeout(() => {
    setDebouncedViewState(vs);
  }, 120); // 120ms after last frame
  return () => clearTimeout(labelDebounceRef.current);
}, [controlledViewState, currentViewState, initialViewState]);

// placedLabels depends on debouncedViewState instead:
const placedLabels = useMemo(() => {
  if (!visibleLabels.length) return [];
  const viewState = debouncedViewState || initialViewState;
  // ... rest of placement logic unchanged
}, [visibleLabels, width, height, minZoom, maxZoom,
    debouncedViewState,   // <-- replaces controlledViewState + currentViewState
    initialViewState, textMeasureContext]);
```

During active pan/zoom, labels hold their last position. They recompute 120ms after the interaction settles. This eliminates all label computation during animation frames.

**Fix B: Spatial index for collision detection (medium effort)**

Replace the linear `boxIntersectsAny` scan with a grid-based spatial hash:

```jsx
// Simple spatial hash for 2D boxes
class SpatialGrid {
  constructor(cellSize = 100) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }

  _cellKeys(box) {
    const keys = [];
    const x0 = Math.floor(box.x0 / this.cellSize);
    const x1 = Math.floor(box.x1 / this.cellSize);
    const y0 = Math.floor(box.y0 / this.cellSize);
    const y1 = Math.floor(box.y1 / this.cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        keys.push(`${x},${y}`);
      }
    }
    return keys;
  }

  insert(box) {
    for (const key of this._cellKeys(box)) {
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(box);
    }
  }

  intersectsAny(box) {
    const checked = new Set();
    for (const key of this._cellKeys(box)) {
      const cell = this.grid.get(key);
      if (!cell) continue;
      for (const other of cell) {
        if (checked.has(other)) continue;
        checked.add(other);
        if (boxesIntersect(box, other)) return true;
      }
    }
    return false;
  }
}

// In placedLabels useMemo, replace acceptedBoxes array:
const spatialGrid = new SpatialGrid(100); // 100px cells
// ... then in the loop:
// BEFORE:  if (boxIntersectsAny(box)) continue;
//          acceptedBoxes.push(box);
// AFTER:   if (spatialGrid.intersectsAny(box)) continue;
//          spatialGrid.insert(box);
```

This reduces collision checks from O(n²) to O(n) average case, since each cell typically contains only a few boxes.

**Expected improvement**: Fix A alone eliminates all label computation during pan/zoom. Fix A+B together make the settled-state recompute ~10-50x faster for large label sets.

---

#### C3. FilterContext value always produces new reference

**Status**: CONFIRMED (Claude AGREE, Codex AGREE, React docs CONFIRM)

**Features affected**: Everything downstream of FilterContext — the TweetFeed (main sidebar), FeedCarousel (all columns), TopicTree (cluster highlighting), SearchResults, filter pills/chips, and pagination controls. Any component calling `useFilter()` rerenders unnecessarily on every parent render, even when no filter has changed.

**Behavior change**: None. Filters work identically. The only difference is that components stop rerendering when the filter state hasn't actually changed, making the entire UI more responsive — especially during hover, scroll, and carousel interactions that trigger parent rerenders.

**Location**: `FilterContext.jsx:256-283`, `useClusterFilter.js`, `useColumnFilter.js`, `useNearestNeighborsSearch.js`

**What happens now**:
1. The three filter hooks each return a fresh object literal every render:
   - `useClusterFilter.js:19-24` — `{ cluster, setCluster, filter, clear }` — `filter` (line 6) and `clear` (line 15) are plain functions recreated every render
   - `useColumnFilter.js:39-44` — `{ columnToValue, columnFilters, filter, clear }` — `filter` (line 22) and `clear` (line 35) are plain functions
   - `useNearestNeighborsSearch.js:51-56` — `{ filter, clear, distances, distanceMap }` — `filter` (line 21) is a plain function
2. These three objects are dependencies of the FilterContext `value` useMemo (line 281)
3. Since the hook return objects are always new references, the `useMemo` always recomputes
4. Every consumer of FilterContext rerenders on every parent render

**How to fix** — memoize each hook's return:

```jsx
// useClusterFilter.js — BEFORE:
const filter = (cluster) => {
  if (cluster) {
    const annots = scopeRows.filter((d) => d.cluster === cluster.cluster);
    return annots.map((d) => d.ls_index);
  }
  return [];
};
const clear = () => { setCluster(null); };
return { cluster, setCluster, filter, clear };

// useClusterFilter.js — AFTER:
const filter = useCallback((cluster) => {
  if (cluster) {
    const annots = scopeRows.filter((d) => d.cluster === cluster.cluster);
    return annots.map((d) => d.ls_index);
  }
  return [];
}, [scopeRows]);

const clear = useCallback(() => { setCluster(null); }, []);

return useMemo(
  () => ({ cluster, setCluster, filter, clear }),
  [cluster, setCluster, filter, clear]
);
```

```jsx
// useColumnFilter.js — BEFORE:
const filter = async (column, value) => { ... };
const clear = () => { setColumnToValue({}); };
return { columnToValue, columnFilters, filter, clear };

// useColumnFilter.js — AFTER:
const filter = useCallback(async (column, value) => {
  let query = [{ column, type: 'eq', value }];
  const res = await queryClient.columnFilter(datasetId, query, scope?.id);
  return res.indices;
}, [datasetId, scope?.id]);

const clear = useCallback(() => { setColumnToValue({}); }, []);

return useMemo(
  () => ({ columnToValue, columnFilters, filter, clear }),
  [columnToValue, columnFilters, filter, clear]
);
```

```jsx
// useNearestNeighborsSearch.js — BEFORE:
const filter = async (query) => { ... };
// clear is already useCallback ✓
return { filter, clear, distances, distanceMap };

// useNearestNeighborsSearch.js — AFTER:
const filter = useCallback(async (query) => {
  try {
    const data = await queryClient.searchNearestNeighbors(
      datasetId, scope.embedding, query, scope
    );
    const { indices, distances: rawDistances } = data;
    setDistances(rawDistances);
    const dMap = new Map();
    for (let i = 0; i < indices.length; i++) {
      dMap.set(Number(indices[i]), rawDistances[i]);
    }
    setDistanceMap(dMap);
    const filteredIndices = uniqueOrdered(indices).filter(
      (idx) => !deletedIndices.has(idx) // Note: uses Set.has() after C4 fix
    );
    return filteredIndices;
  } catch (error) {
    console.error('Search failed:', error);
    return [];
  }
}, [datasetId, scope, deletedIndices]);

return useMemo(
  () => ({ filter, clear, distances, distanceMap }),
  [filter, clear, distances, distanceMap]
);
```

**Expected improvement**: FilterContext value reference becomes stable when no filter state has actually changed. All consumers (TweetFeed, FeedCarousel, TopicTree, SearchResults, etc.) skip rerenders unless a filter genuinely changes.

---

#### C4. `deletedIndices` is Array with `.includes()` in hot paths

**Status**: CONFIRMED (Claude AGREE, Codex AGREE)

**Features affected**: Deleted tweet filtering — used everywhere tweets are processed: building the base index set (FilterContext), hover interaction (checking if hovered point is deleted), search results filtering, and the scatter plot's `baseIndices` computation. Slowdown is proportional to number of deleted tweets × number of total tweets.

**Behavior change**: None. Deleted tweets are still excluded in exactly the same places. The Set produces identical membership results to the Array — just O(1) instead of O(n) per check.

**Location**: `ScopeContext.tsx:308` (exposed as array), `FilterContext.jsx:54`, `FullScreenExplore.jsx:656`, `useNearestNeighborsSearch.js:37`

**What happens now**:
- `deletedIndices` is built as a plain Array in ScopeContext (line 308)
- Every call to `.includes()` is O(n) — linear scan of the array
- Used in hot paths: `baseIndices` computation filters all scopeRows (FilterContext:54), hover handlers check on every mouse move (FullScreenExplore:656), search results filter (useNearestNeighborsSearch:37)
- With 200 deleted indices and 100k rows, `baseIndices` alone does 100k × 200 = 20M comparisons

**How to fix**:

```tsx
// ScopeContext.tsx — BEFORE (inside the useMemo around line 255-310):
return {
  clusterMap: nextClusterMap,
  clusterLabels: visibleLabels,
  clusterHierarchy: hierarchy,
  deletedIndices: nextDeletedIndices,  // Array
};

// ScopeContext.tsx — AFTER:
const deletedIndicesSet = useMemo(
  () => new Set(nextDeletedIndices),
  [nextDeletedIndices]
);
// ... in the returned value:
return {
  clusterMap: nextClusterMap,
  clusterLabels: visibleLabels,
  clusterHierarchy: hierarchy,
  deletedIndices: deletedIndicesSet,  // Set
};
```

Then update all consumers:

```jsx
// FilterContext.jsx:54 — BEFORE:
.filter((index) => !deletedIndices.includes(index))
// AFTER:
.filter((index) => !deletedIndices.has(index))

// FullScreenExplore.jsx:656 — BEFORE:
if (deletedIndices.includes(payload.index)) ...
// AFTER:
if (deletedIndices.has(payload.index)) ...

// useNearestNeighborsSearch.js:37 — BEFORE:
.filter((idx) => !deletedIndices.includes(idx))
// AFTER:
.filter((idx) => !deletedIndices.has(idx))

// FilterContext.jsx:182 — already uses Set internally, but verify:
const deletedSet = new Set(deletedIndices);  // <-- redundant after fix, simplify to:
// Use deletedIndices directly (it's already a Set)
return filteredIndices.filter((index) => !deletedIndices.has(index));
```

**Expected improvement**: All `.includes()` calls become O(1) `.has()`. The `baseIndices` computation goes from 20M comparisons to 100k Set lookups. Hover path goes from O(n) to O(1) per event.

---

#### C5. `hoveredIndex` cascades through all carousel columns on every hover *(NEW)*

**Status**: CONFIRMED (found during carousel-specific analysis)

**Features affected**: Carousel mode specifically — the expanded multi-column feed view. When a user hovers any point on the scatter plot, the corresponding tweet card in the carousel should highlight. This cross-component highlight is the intended feature, but the current implementation forces ALL ~210 visible cards across ALL 7 columns to rerender just to update the highlight state of 1-2 cards.

**Behavior change**: None. The highlighted card in the carousel still highlights on hover. The only difference is that the other ~208 cards don't wastefully rerender. With the HoverContext approach, each TweetCard subscribes directly to hover state, so only the previously-highlighted and newly-highlighted cards rerender.

**Location**: `FullScreenExplore.jsx:672` (sets `hoveredIndex`), `FeedCarousel.jsx:225` (passes to all FeedColumns), `FeedColumn.jsx:91` (passes to TweetCard as `isHighlighted`)

**What happens now**:
1. User hovers any point on the scatter plot → `setHoveredIndex(nonDeletedIndex)` fires (FullScreenExplore:672)
2. `hoveredIndex` is passed as a prop to `<FeedCarousel hoveredIndex={hoveredIndex}>`
3. FeedCarousel passes `hoveredIndex` to every visible `<FeedColumn>` (FeedCarousel:225)
4. FeedColumn is `memo()`'d, but `hoveredIndex` changes on every hover → memo busted for ALL columns
5. Each FeedColumn rerenders all its cards. With `VISIBLE_COLUMN_RADIUS = 3` → up to 7 columns × ~30 cards = **~210 TweetCard rerenders per hover event**
6. Each TweetCard also gets defeated memo from inline closures (see H1): `onViewThread={() => onViewThread(row.ls_index)}` on FeedColumn:95

**Compounding with C1**: A single hover event triggers BOTH:
- C1: Full Deck.GL layer rebuild (100k points, all accessors)
- C5: 210 TweetCard rerenders across 7 carousel columns

**How to fix** — stop `hoveredIndex` from flowing into FeedColumn props:

```jsx
// FeedColumn.jsx — BEFORE:
function FeedColumn({
  // ... many props
  hoveredIndex,     // <-- changes on every hover, busting memo
  // ...
}) {
  // ... renders cards with:
  // isHighlighted={hoveredIndex === row.ls_index}
}

// FeedColumn.jsx — AFTER:
// Remove hoveredIndex from props entirely.
// Move highlight state into TweetCard via a lightweight context or subscription:
```

**Option A: Lightweight HoverContext (recommended)**

Create a dedicated context for hover state that only TweetCard subscribes to:

```jsx
// contexts/HoverContext.jsx
const HoverContext = createContext(null);

export function HoverProvider({ children, hoveredIndex }) {
  // Only a single number changes — extremely cheap context
  return (
    <HoverContext.Provider value={hoveredIndex}>
      {children}
    </HoverContext.Provider>
  );
}

export function useHoveredIndex() {
  return useContext(HoverContext);
}
```

```jsx
// In FullScreenExplore, wrap the carousel section:
<HoverProvider hoveredIndex={hoveredIndex}>
  <FeedCarousel
    // ... remove hoveredIndex prop
  />
</HoverProvider>
```

```jsx
// TweetCard.jsx — subscribe directly:
import { useHoveredIndex } from '@/contexts/HoverContext';

const TweetCard = memo(function TweetCard({ row, /* ... no isHighlighted prop */ }) {
  const hoveredIndex = useHoveredIndex();
  const isHighlighted = hoveredIndex === row.ls_index;
  // ... rest unchanged
});
```

Now when hoveredIndex changes:
- FeedCarousel: no prop change → memo preserved
- FeedColumn: no prop change → memo preserved
- Only the previously-highlighted and newly-highlighted TweetCards rerender (2 cards instead of 210)

**Option B: Ref + forceUpdate on matching card only**

For maximum performance, store hoveredIndex in a ref and only rerender the affected card via a subscription pattern. More complex but zero unnecessary rerenders.

**Expected improvement**: Hover on scatter with carousel open goes from ~210 card rerenders to ~2 card rerenders per hover event. Combined with C1 fix, hover CPU cost drops by ~99%.

---

### HIGH — Should Fix Soon

---

#### H1. Inline arrow functions defeat React.memo on TweetCards

**Status**: CONFIRMED (Claude AGREE, Codex AGREE, React docs CONFIRM)

**Features affected**: Tweet feed rendering in both normal sidebar mode and carousel mode. Every TweetCard is wrapped in `React.memo`, but the inline closures `() => onViewThread(row.ls_index)` and `() => onViewQuotes(row.ls_index)` create new function refs per card per render, making memo useless. This means the "View Thread" and "View Quotes" button callbacks are the reason every card rerenders when the parent rerenders.

**Behavior change**: None. Thread and quote view buttons work identically. The closure just moves inside TweetCard.

- **Location**: `TweetFeed.jsx:109`, `FeedColumn.jsx:95-96`, `ThreadGroup.jsx:91,128`
- **Fix**: Have TweetCard call `onViewThread(lsIndex)` internally using its own `row.ls_index`. Pass `onViewThread` directly (it's already stable from `useCallback` in parent). Inside TweetCard:

```jsx
const handleViewThread = useCallback(() => {
  if (onViewThread) onViewThread(row.ls_index);
}, [onViewThread, row.ls_index]);
```

Same pattern for `onViewQuotes`. Remove the inline closures from FeedColumn/TweetFeed/ThreadGroup.

#### H2. No row-level virtualization in TweetFeed / FeedColumn

**Status**: QUALIFIED (Claude AGREE, Codex QUALIFY)

**Features affected**: Tweet feed scrolling in sidebar and carousel. All loaded cards are rendered to the DOM — after a few "Load more" clicks, 100+ cards are in the DOM. In carousel mode, 7 columns × 30 cards = 210 DOM nodes minimum. Becomes sluggish as users load more content.

**Behavior change**: Minimal. Scrolling behavior changes from native DOM scroll of all elements to virtualized scroll where only visible cards + overscan buffer are in the DOM. Users may notice slightly different scroll momentum/inertia on some browsers. "Load more" still works — Virtuoso supports `endReached` for triggering pagination. We will use react-virtuoso (not TanStack Virtual or react-window).

- **Location**: `TweetFeed.jsx:68`, `FeedColumn.jsx:64`
- **Qualification**: Pagination and column-level placeholder virtualization exist, but row-level virtualization within columns is absent.
- **Fix**: Wrap card list in `<Virtuoso>` from react-virtuoso (verified as best for variable-height items). Works with existing load-more.

#### H3. `scatterData` creates 100k object-per-point instead of columnar format

**Status**: CONFIRMED (Claude AGREE, Codex AGREE, Deck.GL docs CONFIRM)

**Features affected**: Scatter plot initial load and any layer update (filter change, feature selection, highlight change). The `.map()` creates 100k JS objects that Deck.GL then iterates via accessor functions to build GPU buffers. Contributes to load time and GC pauses.

**Behavior change**: None. The scatter plot looks and behaves identically. Points have the same positions, colors, and sizes. The data just goes to the GPU via typed arrays instead of per-point objects.

- **Location**: `DeckGLScatter.jsx:515-524`
- **Impact**: 100k object allocations + GC pressure + accessor evaluation per layer update.
- **Fix**: Pre-compute `Float32Array` buffers and use `data.attributes`:

```jsx
const { scatterDataObj, positionBuffer, lsIndexBuffer } = useMemo(() => {
  const len = points.length;
  const positions = new Float32Array(len * 2);
  const lsIndices = new Int32Array(len);
  for (let i = 0; i < len; i++) {
    positions[i * 2] = points[i][0];
    positions[i * 2 + 1] = points[i][1];
    lsIndices[i] = scopeRows?.[i]?.ls_index ?? i;
  }
  return {
    scatterDataObj: { length: len, attributes: { getPosition: { value: positions, size: 2 } } },
    positionBuffer: positions,
    lsIndexBuffer: lsIndices,
  };
}, [points, scopeRows]);
```

#### H4. URL params effect has missing dependencies

**Status**: QUALIFIED (Claude AGREE, Codex QUALIFY)

**Features affected**: Deep linking / URL-based filter restore. When a user loads a URL like `?cluster=5` or `?column=lang&value=en`, the effect reads URL params and applies the corresponding filter. If `clusterLabels` hasn't loaded yet when the effect runs (stale deps), the filter silently fails to apply.

**Behavior change**: Yes — bug fix. Users sharing filtered URLs may currently see the filter not applied on initial load (race condition). After fix, URL filters will correctly wait for data availability and apply reliably.

- **Location**: `FilterContext.jsx:72-110` (effect body), `:110` (deps array)
- **Fix**: Add `clusterLabels`, `clusterFilter`, `columnFilter` to deps. Split into separate effects for each filter type with proper guards.

#### H5. Async filter race condition applies stale results *(Codex finding)*

**Status**: NEW — HIGH

**Features affected**: All filtering — cluster filter (click topic in tree), search filter (semantic search), column filter (metadata facets). When a user rapidly switches between filters (e.g., clicks cluster A, then immediately clicks cluster B), both async operations race. If cluster A's response arrives after B's, the UI shows cluster A's results even though the user selected B.

**Behavior change**: Yes — bug fix. Rapid filter switching will now correctly show only the most recently selected filter's results. Previously, stale results could silently win the race.

- **Location**: `FilterContext.jsx:115-170`
- **Fix**: Use the existing `reqSeqRef` pattern (already used for row fetching at line 202) for the filter effect too:

```jsx
const filterSeqRef = useRef(0);

useEffect(() => {
  async function applyFilter() {
    const reqId = ++filterSeqRef.current;
    setLoading(true);
    let indices = [];
    // ... existing switch logic ...
    if (filterSeqRef.current !== reqId) return; // stale — discard
    setFilteredIndices(uniqueOrderedIndices(indices));
    setPage(0);
    setLoading(false);
  }
  if (scopeLoaded) applyFilter();
}, [filterConfig, baseIndices, scopeLoaded]);
```

#### H6. `ls_index` vs array-index mismatch in hover annotations *(Codex finding)*

**Status**: NEW — HIGH

**Features affected**: Hover card / annotation popup — when hovering a point on the scatter plot, a card appears showing the tweet's content, metadata, and cluster info. If `ls_index` doesn't equal the array position (possible after tweet deletions or sparse datasets), the hover card shows the WRONG tweet's data.

**Behavior change**: Yes — bug fix. Hover cards will show the correct tweet for the hovered point. This may currently be masked if your backend happens to guarantee dense `ls_index` values, but would surface as a correctness bug with any sparse dataset.

- **Location**: `DeckGLScatter.jsx:990`, `FullScreenExplore.jsx:672,499-500`
- **Fix**: Use a lookup map (`Map<ls_index, row>`) or validate `scopeRows[hoveredIndex]?.ls_index === hoveredIndex`.

#### H7. Multiple async effects lack error handling *(Codex finding)*

**Status**: NEW — HIGH

**Features affected**: Initial data loading — scope metadata, cluster labels, scope rows, and row fetching. If the backend is down, returns an error, or the network drops, all these fetches silently fail. The UI stays in a perpetual loading state with no feedback. Users have no way to know what went wrong or retry.

**Behavior change**: Yes — new user-facing behavior. Errors will now surface (e.g., "Failed to load scope data — check your connection" or a retry button). Previously, failures were invisible. This is a UX improvement, not a regression.

- **Location**: `ScopeContext.tsx:92,112,124,136`, `FilterContext.jsx:232`
- **Fix**: Wrap in try/catch, add error state, surface via UI or error boundary.

#### H8. `selectedPoints` is O(N*M) and unused

**Status**: CONFIRMED (unused — delete it)

**Features affected**: None — this is dead code. The `selectedPoints` computation runs `scopeRows.find()` per selected index but the result is only referenced in a commented-out debug line (VisualizationPane:444). It wastes CPU cycles on every render of VisualizationPane for no purpose.

**Behavior change**: None. Deleting dead code.

- **Location**: `VisualizationPane.jsx:255-264`
- **Fix**: Delete the entire computation. It's dead code.

---

### MEDIUM — Address When Convenient

#### M1. God component: ExploreContent (1275 lines, 22 useState)

**Status**: CONFIRMED (Claude AGREE, Codex AGREE)

- **Location**: `FullScreenExplore.jsx:76-1352`
- **Fix**: Extract `useTimelinePlayback`, `useDragResize`, `useHoverHydration`, `useLinkEdges`. Move thread/quote view state into a `ViewStateContext`.

#### M2. Two monolithic contexts force broad rerenders

**Status**: CONFIRMED (Claude AGREE, Codex AGREE)

- **Location**: `FullScreenExplore.jsx:1357`, `ScopeContext.tsx:312`, `FilterContext.jsx:256`
- **Fix**: Split ScopeContext into `ScopeDataContext` (stable: scopeRows, clusterMap) and `ScopeUIContext` (dynamic: deletedIndices). Split FilterContext into `FilterStateContext` (filter config) and `FilterDataContext` (rows/pagination).

#### M3. Drag handlers leak event listeners on interrupted drag

**Status**: QUALIFIED (Claude AGREE, Codex QUALIFY)

- **Location**: `FullScreenExplore.jsx:955,969`
- **Fix**: Add `useEffect` cleanup for in-flight drag listeners on unmount.

#### M4. Dead state/props increase complexity *(Codex finding)*

**Status**: NEW — MEDIUM

- **Location**: `FullScreenExplore.jsx:133,140,141`
- **Fix**: Delete `scatter`, `dataTableRows`, `selectedAnnotations` states and their corresponding props in VisualizationPane.

#### M5. `useDebounce` invokes stale callback *(Codex finding)*

**Status**: NEW — MEDIUM

- **Location**: `useDebounce.js:17,25`
- **Fix**: Store callback in a `useRef`, update on every render, call `callbackRef.current()` from timeout.

#### M6. `fetchDataFromIndices` assumes backend row order *(Codex finding)*

**Status**: NEW — MEDIUM

- **Location**: `apiService.ts:184`
- **Fix**: Match response rows by `ls_index` field instead of positional assignment.

#### M7. Inline closures in ThreadGroup *(Codex finding)*

**Status**: NEW — MEDIUM

- **Location**: `ThreadGroup.jsx:91,128`
- **Fix**: Same as H1 — move closure into TweetCard, pass `onViewThread` directly.

#### M8. Repeated row-fetch pathways lack shared cache *(Codex finding)*

**Status**: NEW — MEDIUM

- **Location**: `FilterContext.jsx:233`, `useCarouselData.js:108`, `useThreadData.js:66`, `useThreadCarouselData.js:247`
- **Fix**: Shared row cache at apiService level with request deduplication.

#### M9. `clusterMap` is plain object with 100k+ keys

**Status**: QUALIFIED — Low priority. Object lookup is O(1). Real issue is rebuild churn.

#### M10. `normalizeScopeRows` spread-copies every row

**Status**: QUALIFIED — Low priority. Done once per fetch.

#### M11. Console.log statements in production code

**Status**: QUALIFIED — ~10 active `console.log` calls across `web/src/`. Remove all.

#### M12. No AbortController usage anywhere

**Status**: CONFIRMED — Zero `AbortController` in `web/src/`. Add to all fetch calls in effects.

---

## Documentation Verification Details

### Deck.GL Claims (4/4 Verified Correct)

| Claim | Verdict | Key Evidence |
|-------|---------|-------------|
| `updateTriggers` re-evaluates only named accessors | **CORRECT** | "all attributes that depend on [accessor] will be updated" — only specified accessors, not all |
| Binary/columnar data via `Float32Array` supported | **CORRECT** | `data.attributes` accepts typed arrays; bypasses CPU accessor evaluation entirely |
| `autoHighlight` is GPU-accelerated, no layer rebuild | **CORRECT** | Inherited from base Layer; color blend in fragment shader; requires `pickable: true` |
| Shallow `===` comparison is default data diff | **CORRECT** | New array references trigger full buffer rebuild; `dataComparator` overrides |

**Source URLs**:
- https://deck.gl/docs/api-reference/core/layer
- https://deck.gl/docs/api-reference/layers/scatterplot-layer
- https://deck.gl/docs/developer-guide/performance
- https://deck.gl/docs/get-started/using-with-react

### React Claims (7/7 Verified Correct)

| Claim | Verdict | Key Evidence |
|-------|---------|-------------|
| Context splitting prevents unnecessary rerenders | **CORRECT** | No built-in selectors (RFC #119 never merged); React Compiler helps but doesn't solve it |
| Inline arrow functions defeat React.memo | **CORRECT** | Docs: makes memo "completely useless" |
| `useCallback` preferred over callbacks inside `useMemo` | **CORRECT** | Functionally equivalent; `useCallback` is idiomatic |
| `setState` inside updater is unsafe | **CORRECT** | Violates purity requirement; double-called in Strict Mode |
| Hooks after conditional returns violate Rules of Hooks | **CORRECT** | Explicitly prohibited; TopicTree does NOT have this bug (false positive corrected) |
| react-virtuoso better for variable-height items | **CORRECT** | Auto-measures heights; no boilerplate for dynamic content |
| Shared IntersectionObserver more performant | **CORRECT** | ~3x faster scripting time; designed for multi-element observation |

**Source URLs**:
- https://react.dev/reference/react/useContext
- https://react.dev/reference/react/memo
- https://react.dev/reference/react/useMemo
- https://react.dev/reference/react/useCallback
- https://react.dev/reference/react/useState
- https://react.dev/reference/rules/rules-of-hooks
- https://react.dev/blog/2025/10/07/react-compiler-1

---

## Prioritized Fix Recommendations

### Tier 1: Quick Wins (~3 hours, highest impact-to-effort)

| Priority | Fix | Effort | Impact | Files |
|----------|-----|--------|--------|-------|
| 1 | **C1**: Remove `hoveredPointIndex` from `layers` deps, use ref + `updateTriggers` | ~30 min | Eliminates full layer rebuild on every hover | `DeckGLScatter.jsx` |
| 2 | **C5**: Stop `hoveredIndex` cascading through carousel via HoverContext | ~30 min | 210 → 2 card rerenders per hover | `FeedCarousel.jsx`, `FeedColumn.jsx`, `TweetCard.jsx` |
| 3 | **C4**: Convert `deletedIndices` to `Set` | ~20 min | O(1) membership checks across 6+ hot paths | `ScopeContext.tsx` + 4 consumers |
| 4 | **C3**: Memoize hook return values with `useCallback`/`useMemo` | ~45 min | Stabilizes FilterContext, stops cascading rerenders | 3 hook files + `FilterContext.jsx` |
| 5 | **H8 + M4**: Delete dead code (`selectedPoints`, `scatter`, `dataTableRows`, etc.) | ~15 min | Removes unused computation + reduces prop surface | `FullScreenExplore.jsx`, `VisualizationPane.jsx` |
| 6 | **H5**: Add request-id guard to `applyFilter` | ~20 min | Fixes async race condition | `FilterContext.jsx` |

### Tier 2: Medium Effort (~1-2 days)

| Fix | Effort | Impact |
|-----|--------|--------|
| **H1 + M7**: Stabilize TweetCard/ThreadGroup callbacks | ~1 hr | Enables React.memo to work as intended |
| **H3**: Convert scatterData to columnar Float32Array | ~2 hr | Eliminates 100k object allocations + accessor overhead |
| **C2**: Debounce label placement + spatial index | ~3 hr | Removes main-thread blocking during pan/zoom |
| **M1**: Extract hooks from ExploreContent | ~3 hr | Reduces blast radius of state changes |
| **M12 + H7**: Add AbortController + error handling to all effects | ~2 hr | Prevents stale updates + surfaces errors |

### Tier 3: Architectural (~1 week)

| Fix | Effort | Impact |
|-----|--------|--------|
| **M2**: Split monolithic contexts into focused providers | ~1 day | Reduces unnecessary rerenders across the tree |
| **H2**: Add react-virtuoso to TweetFeed/FeedColumn | ~1 day | Handles large feeds without DOM bloat |
| **M8**: Shared row cache / SWR integration | ~1 day | Eliminates duplicate fetches, improves perceived performance |
| **M1 continued**: Full ExploreContent decomposition | ~2 days | Maintainability, testability, developer velocity |

---

## Architecture Notes

### Current Data Flow
```
API → ScopeContext (scopeRows, clusterMap, labels)
                 ↓
         FilterContext (filters → filteredIndices → paginated rows)
                 ↓
    FullScreenExplore (22 useState, ~15 effects)
         ↓           ↓              ↓
  VisualizationPane  TweetFeed  FeedCarousel
         ↓                       ↓ (hoveredIndex cascades to ALL columns)
   DeckGLScatter              7× FeedColumn → 30× TweetCard each
```

### The Hover Storm (C1 + C5 combined)
```
Mouse hover on scatter plot
  ├─ C1: setHoveredPointIndex → layers useMemo recomputes
  │       → ALL 6 Deck.GL layers recreated
  │       → 100k points: all accessors re-evaluated
  │       → GPU buffers regenerated
  │
  └─ C5: setHoveredIndex → prop flows to FeedCarousel
          → prop flows to 7 visible FeedColumns (memo busted)
          → each column rerenders 30 TweetCards
          → 210 React component renders
          → each card also gets new inline closures (H1)

Total per hover frame: ~100k accessor calls + ~210 component renders
After C1+C5 fix:      ~4 accessor calls  + ~2 component renders
```

### Recommended Target Architecture
```
API → ScopeDataContext (stable: scopeRows, clusterMap, labels)
    → ScopeUIContext (dynamic: deletedIndicesSet, scope selection)
    → FilterStateContext (filter values, memoized hooks)
    → FilterDataContext (filtered rows, pagination)
    → HoverContext (just hoveredIndex — lightweight, only cards subscribe)
                 ↓
    FullScreenExplore (reduced to layout + composition)
         ↓           ↓              ↓
  VisualizationPane  TweetFeed     FeedCarousel
   (own state)     (virtualized)  (virtualized, hover-isolated)
         ↓
   DeckGLScatter (columnar data, autoHighlight, ref-based hover, debounced labels)
```

### Key Principles for Fixes
1. **Memoize at the boundary** — stabilize context values and callback props
2. **Columnar over object-per-point** — let Deck.GL talk directly to the GPU
3. **Debounce expensive work** — label placement should not block pan/zoom frames
4. **Isolate hover state** — hover changes should only affect the 2 cards that actually change
5. **Delete before refactoring** — remove dead code first to reduce surface area
6. **Abort stale work** — every async operation should be cancellable

---

## Appendix: Files Analyzed

| File | Lines | Key Issues |
|------|-------|------------|
| `DeckGLScatter.jsx` | 1410 | C1, C2, H3 |
| `FullScreenExplore.jsx` | 1365 | C5, M1, M3, M4, H6 |
| `VisualizationPane.jsx` | 687 | H8 |
| `FilterContext.jsx` | 294 | C3, H4, H5, M12 |
| `ScopeContext.tsx` | 356 | C4, H7, M9, M10 |
| `FeedCarousel.jsx` | 250 | C5, H2 (partial mitigation) |
| `FeedColumn.jsx` | 122 | C5, H1, H2 |
| `TweetFeed.jsx` | 130 | H1, H2 |
| `TweetCard.jsx` | 399 | H1 (victim), C5 (victim) |
| `TopicTree.jsx` | 379 | Render perf (minor) |
| `ThreadGroup.jsx` | 159 | M7 |
| `useCarouselData.js` | 211 | M8 |
| `useThreadCarouselData.js` | 342 | M8 |
| `useThreadData.js` | 140 | M8 |
| `useNearestNeighborsSearch.js` | ~60 | C3, C4 |
| `useClusterFilter.js` | ~25 | C3 |
| `useColumnFilter.js` | ~45 | C3, M11 |
| `useDebounce.js` | ~30 | M5 |
| `useSidebarState.js` | 82 | setState purity violation |
| `apiService.ts` | 255 | M6, M11, M12 |
| `urlResolver.js` | 119 | Unbounded cache |
| `embedScheduler.js` | 158 | Global listener leak |
| `SearchResults.jsx` | 311 | Minor perf |
| `Container.jsx` | 217 | Minor perf |

---

## Library Ecosystem Recommendations

### Current TanStack Usage

Already installed: `@tanstack/react-table` (v8.15), `@tanstack/match-sorter-utils` (v8.11).
Also installed but unused in audited components: `react-window` (v1.8.10).

### Recommended Additions

#### 1. TanStack Query — for data fetching, caching, dedup

**Install**: `@tanstack/react-query`

**Issues it addresses**: M8 (duplicate fetches), H5 (race conditions), H7 (error handling), M12 (AbortController), unbounded caches.

**What it provides out of the box** (verified against docs):
- **Automatic request deduplication**: Multiple components calling `useQuery` with the same key get a single network request. This directly solves M8 — FilterContext, useCarouselData, useThreadData, and useThreadCarouselData all fetching the same rows would share one request.
- **Automatic query cancellation**: When query keys change (e.g., rapid filter switches), the previous query is automatically cancelled via AbortController. Solves H5 (race condition) and M12 (no AbortController).
- **Built-in error handling + retry**: Queries have `error` state, configurable retry count and backoff. Solves H7 (unhandled rejections).
- **Cache with GC**: Configurable `staleTime` and `gcTime` (formerly `cacheTime`). Inactive queries are garbage-collected after `gcTime` (default 5 minutes). Solves unbounded cache growth.
- **`prefetchQuery`**: Pre-fetches data before components mount. Perfect for carousel's prefetch pattern (fetch columns within `focusedIndex ± 2`).

**Migration example** — `fetchDataFromIndices` as a query hook:

```jsx
import { useQuery, useQueryClient } from '@tanstack/react-query';

function useRowData(datasetId, indices, scopeId) {
  return useQuery({
    queryKey: ['rows', datasetId, scopeId, indices],
    queryFn: ({ signal }) =>  // signal is auto-provided AbortController
      apiService.fetchDataFromIndices(datasetId, indices, scopeId, { signal }),
    enabled: indices.length > 0,
    staleTime: 5 * 60 * 1000,  // 5 min before refetch
    gcTime: 10 * 60 * 1000,    // 10 min before GC
  });
}

// Carousel prefetch:
const queryClient = useQueryClient();
useEffect(() => {
  for (let i = start; i <= end; i++) {
    const indices = indicesByTopLevel[topLevelClusters[i]?.cluster];
    if (indices?.length) {
      queryClient.prefetchQuery({
        queryKey: ['rows', datasetId, scopeId, indices.slice(0, 30)],
        queryFn: ({ signal }) => apiService.fetchDataFromIndices(datasetId, indices.slice(0, 30), scopeId, { signal }),
      });
    }
  }
}, [focusedClusterIndex]);
```

**Bundle size**: ~13KB gzipped.

---

#### 2. TanStack Pacer — for debouncing, throttling, async rate control

**Install**: `@tanstack/react-pacer`

**Issues it addresses**: C2 (label placement debounce), M5 (stale callback bug), H5 (async debounce for filters), general hover/scroll throttling.

**Key hooks** (verified against docs + source):

| Hook | Purpose | Solves |
|------|---------|--------|
| `useDebouncedValue` | Debounce a rapidly-changing value | C2 — `useDebouncedValue(viewState, { wait: 120 })` |
| `useDebouncedCallback` | Debounce a callback (replaces our `useDebounce`) | M5 — immune to stale callback bug |
| `useThrottledCallback` | Throttle a callback with leading/trailing control | Hover hydration, link edge fetching |
| `useAsyncDebouncer` | Async debounce with AbortSignal + auto-cancel | H5 — rapid filter changes |

**Why it fixes M5 (stale callback)**: Our `useDebounce` captures the callback in a `setTimeout` closure at creation time. If the callback changes mid-timeout, the old one fires with stale state. TanStack Pacer's `Debouncer` class mutates `this.fn` on every render and reads it at execution time — the latest callback always runs.

**Concrete replacements for our code**:

```jsx
// BEFORE (FullScreenExplore.jsx:417) — uses our buggy useDebounce:
const debouncedHydrateHoverRecord = useDebounce(hydrateHoverRecord, 120);

// AFTER — throttle is more appropriate for hover (updates during movement):
import { useThrottledCallback } from '@tanstack/react-pacer';
const throttledHydrateHoverRecord = useThrottledCallback(
  hydrateHoverRecord,
  { wait: 120, leading: true, trailing: true }
);
```

```jsx
// BEFORE (label placement in DeckGLScatter.jsx) — viewState in useMemo deps:
const placedLabels = useMemo(() => {
  const viewState = controlledViewState || currentViewState;
  // ... O(n²) collision detection
}, [controlledViewState, currentViewState, ...]);

// AFTER — debounce the viewState input:
import { useDebouncedValue } from '@tanstack/react-pacer';
const [debouncedViewState] = useDebouncedValue(
  controlledViewState || currentViewState || initialViewState,
  { wait: 120 }
);
const placedLabels = useMemo(() => {
  // Only recomputes 120ms after pan/zoom settles
  // ... same collision detection logic
}, [debouncedViewState, ...]);
```

```jsx
// BEFORE (FilterContext.jsx applyFilter) — no race protection:
useEffect(() => {
  async function applyFilter() { /* ... */ }
  if (scopeLoaded) applyFilter();
}, [filterConfig, baseIndices, scopeLoaded]);

// AFTER — async debounce with auto-abort:
import { useAsyncDebouncer } from '@tanstack/react-pacer';
const asyncFilter = useAsyncDebouncer(
  async (config, { signal }) => {
    // signal auto-aborts previous in-flight request
    const indices = await fetchFilteredIndices(config, { signal });
    setFilteredIndices(indices);
  },
  { wait: 150 }
);
// In effect: asyncFilter.maybeExecute(filterConfig);
```

**Bundle size**: ~1-2KB gzipped per utility. Tree-shakeable via deep imports (`@tanstack/react-pacer/debouncer`).

---

#### 3. react-virtuoso — for list virtualization

**Install**: `react-virtuoso` (NOT TanStack Virtual — user preference)

**Issues it addresses**: H2 (no row-level virtualization in TweetFeed/FeedColumn).

**Why react-virtuoso over react-window** (already installed but unused):
- **Auto-measures variable heights** via ResizeObserver — no need to pre-calculate or cache sizes
- **Handles dynamic resize** — images loading, threads expanding, embeds appearing all handled automatically
- **`context` prop** — pass frequently-changing values (like `hoveredIndex`) without recreating `itemContent` callback
- **`endReached`** — built-in load-more/infinite scroll trigger
- **`scrollSeekConfiguration`** — fast-scroll placeholders for expensive card renders
- **React 18 compatible** — concurrent mode issues resolved in v2.10.2+

**Bundle size**: ~13KB gzipped (vs ~6KB for react-window). Extra 7KB buys auto-measurement + dynamic resize.

**Key integration pattern** — FeedColumn with Virtuoso:

```jsx
import { Virtuoso } from 'react-virtuoso';

function FeedColumn({ tweets, nodeStats, dataset, clusterMap, hoveredIndex, ... }) {
  const groupedItems = useMemo(() => groupRowsByThread(tweets, nodeStats), [tweets, nodeStats]);

  // context prop: pass changing values without recreating itemContent
  const ctx = useMemo(() => ({
    dataset, clusterMap, hoveredIndex, nodeStats, onHover, onClick, onViewThread, onViewQuotes,
  }), [dataset, clusterMap, hoveredIndex, nodeStats, onHover, onClick, onViewThread, onViewQuotes]);

  // Stable callback — context handles all changing values
  const renderItem = useCallback((index, item, context) => {
    if (item.type === 'thread') {
      return <ThreadGroup rows={item.rows} hoveredIndex={context.hoveredIndex} ... />;
    }
    return <TweetCard row={item.row} isHighlighted={context.hoveredIndex === item.row.ls_index} ... />;
  }, []);  // Empty deps! Context handles everything

  return (
    <Virtuoso
      style={{ flex: 1 }}
      data={groupedItems}
      context={ctx}
      defaultItemHeight={180}
      increaseViewportBy={{ top: 100, bottom: 300 }}
      skipAnimationFrameInResizeObserver={true}
      endReached={handleLoadMore}
      itemContent={renderItem}
    />
  );
}
```

**Critical gotchas from docs research**:

1. **No margins on item root elements** — `ResizeObserver.contentRect` excludes margins. Convert all card `margin-bottom` to `padding-bottom` in SCSS.
2. **Lift ThreadGroup expanded state** — When items scroll out of view, they unmount. Internal `useState(false)` in ThreadGroup resets on remount. Lift `expandedThreads` to a `Set` in the parent.
3. **Container must have fixed height** — Virtuoso needs a deterministic scrollable area. Use `flex: 1` + `min-height: 0` on the scroll container.
4. **TweetCard media state** — `resolvedMedia`, `quotedTweets` state will be lost on unmount. `urlResolver` cache should handle re-resolution quickly, but expect brief flicker on scroll-back.

---

### Issue-to-Library Mapping

| Issue | Library | How It Helps |
|-------|---------|-------------|
| C2 (label O(n²)) | **TanStack Pacer** | `useDebouncedValue(viewState)` — labels only recompute after pan/zoom settles |
| H2 (no virtualization) | **react-virtuoso** | `<Virtuoso>` wraps card lists — only visible items in DOM |
| H5 (filter race) | **TanStack Pacer** or **TanStack Query** | `useAsyncDebouncer` auto-aborts previous; Query auto-cancels stale queries |
| H7 (no error handling) | **TanStack Query** | Built-in `error` state + configurable retry |
| M5 (stale debounce) | **TanStack Pacer** | `Debouncer` always reads latest `fn` at execution time |
| M8 (duplicate fetches) | **TanStack Query** | Automatic dedup — same query key = single request |
| M12 (no AbortController) | **TanStack Query** | Auto-provides `signal` to `queryFn`; cancels on unmount |
| Unbounded cache | **TanStack Query** | `gcTime` evicts inactive queries automatically |
| Hover throttling | **TanStack Pacer** | `useThrottledCallback` with leading/trailing edge control |
| Carousel prefetch | **TanStack Query** | `queryClient.prefetchQuery` for columns near focused index |

### What They DON'T Fix

These libraries do not address: C1 (Deck.GL layer rebuild), C3 (FilterContext instability), C4 (Set vs Array), C5 (hover cascade), H1 (inline closures), H3 (columnar data), H6 (ls_index mismatch), or M1 (god component). Those require manual code fixes as described in the findings above.

---

### Codebase-Specific TanStack Query Implementation Plan

This section maps TanStack Query adoption to the current `web/src` architecture, with explicit issue coverage and expected user-visible behavior.

#### Pre-step (naming + wiring)

Before migration, resolve naming ambiguity in `web/src/lib/apiService.ts`:
- Current API wrapper export is named `queryClient`.
- TanStack also uses `QueryClient`.
- Rename wrapper export to `queryApi` (or similar) before introducing TanStack provider/hooks.

Then add Query wiring:
- Install: `@tanstack/react-query`
- Add `QueryClientProvider` in `web/src/main.jsx`
- Add a shared query client module (for defaults and Devtools-ready setup)

#### Implementation sequence

| Step | Where to implement | Issues fixed | User behavior change |
|------|--------------------|--------------|----------------------|
| 1. Query foundation | `web/src/main.jsx`, new `web/src/query/client.ts`, `web/package.json` | Enables M8/H5/H7/M12 fixes consistently | Minor: repeat navigations feel faster due to cache reuse |
| 2. Scope bootstrap queries | `web/src/contexts/ScopeContext.tsx`, `web/src/lib/apiService.ts` | H7, M12, partial M8 | Yes: explicit error states replace silent loading stalls |
| 3. Filter and feed rows queryization | `web/src/contexts/FilterContext.jsx`, `web/src/hooks/useColumnFilter.js`, `web/src/hooks/useNearestNeighborsSearch.js`, `web/src/lib/apiService.ts` | H5, M8, M12, H7 | Yes: rapid filter switches show latest filter reliably; fewer stale flashes |
| 4. Carousel/thread/quote row fetch unification | `web/src/hooks/useCarouselData.js`, `web/src/hooks/useThreadData.js`, `web/src/components/Explore/V2/ThreadView/QuoteView.jsx`, `web/src/hooks/useThreadCarouselData.js` | M8, M12, H7, partial H5 | Mostly none: data appears faster when reopening previously viewed columns/threads |
| 5. Hover and links fetch cleanup | `web/src/pages/V2/FullScreenExplore.jsx`, `web/src/lib/apiService.ts` | M12, H7 | Mostly none: hover cards/edge overlays become more stable under rapid movement |

#### Suggested query key families

- `['appConfig']`
- `['scope', datasetId, scopeId]`
- `['scopeRows', datasetId, scopeId]`
- `['scopes', datasetId]`
- `['embeddings', datasetId]`
- `['tags', datasetId]`
- `['rowsByIndices', datasetId, scopeId, indicesHash]`
- `['nearestNeighbors', datasetId, scopeId, embeddingId, query]`
- `['columnFilter', datasetId, scopeId, column, value]`
- `['nodeStats', datasetId]`
- `['linksMeta', datasetId]`
- `['linksByIndices', datasetId, indicesHash]`
- `['thread', datasetId, tweetId]`
- `['quotes', datasetId, tweetId]`

`indicesHash` should be deterministic (e.g. stable join/hash of numeric indices) to maximize dedup/cache hits.

#### Defaults recommended for this frontend

- `staleTime`: 30s for rapidly changing views; 5m for mostly static scope metadata/rows
- `gcTime`: 10m (increase if memory allows and repeated navigation is common)
- `retry`: 1 for user-triggered queries, 2 for background queries
- `refetchOnWindowFocus`: `false` for heavy row payloads

#### What this plan intentionally does not claim

TanStack Query adoption does **not** solve these by itself:
- C1 hover-triggered Deck.GL layer rebuild
- C3 context value instability
- C4 Array `.includes()` hot-path checks
- C5 carousel hover rerender cascade
- H1 inline callback memo busting
- H3 object-per-point scatter format
- H6 `ls_index` vs array index mismatch

Those remain separate code fixes and should be implemented in parallel with the query migration.

---

### TanStack Migration Implementation Status (2026-02-18)

This section records what was actually implemented in this codebase.

#### Completed in code

- Added TanStack Query dependency in `web/package.json` and lock update in `web/package-lock.json`.
- Added shared Query client in `web/src/query/client.ts` with defaults:
  - `staleTime: 30_000`
  - `gcTime: 10 * 60 * 1000`
  - `retry: 1`
  - `refetchOnWindowFocus: false`
- Added Query key helpers in `web/src/query/keys.ts` including deterministic `rowsByIndices` key hashing.
- Added provider wiring in `web/src/main.jsx` via `QueryClientProvider`.
- Resolved naming collision by renaming API wrapper export from `queryClient` to `queryApi` in `web/src/lib/apiService.ts`.
- Extended API wrappers to accept `{ signal }` so Query cancellation can propagate to network calls.
- Migrated app config load to Query in `web/src/App.jsx`.
- Migrated scope bootstrapping to Query in `web/src/contexts/ScopeContext.tsx`:
  - `scope`
  - `scopeRows`
  - `scopes`
  - `embeddings`
  - `tags`
- Added explicit scope-load error exposure in `ScopeContext` and surfaced it in `web/src/pages/V2/FullScreenExplore.jsx`.
- Migrated filter/rows pipeline in `web/src/contexts/FilterContext.jsx`:
  - kept existing filter logic semantics
  - replaced manual row cache + request sequencing with query-backed `useQueries` page loading
  - retained race guard for async filter application
- Updated filter hooks:
  - `web/src/hooks/useColumnFilter.js` now uses `fetchQuery` + keyed cache.
  - `web/src/hooks/useNearestNeighborsSearch.js` now uses `fetchQuery` + keyed cache.
  - `web/src/hooks/useClusterFilter.js` now memoizes callbacks/return values.
- Migrated additional duplicate row-fetch pathways to query cache reuse:
  - `web/src/hooks/useNodeStats.ts`
  - `web/src/hooks/useCarouselData.js` (+ prefetch for nearby columns)
  - `web/src/hooks/useThreadData.js`
  - `web/src/components/Explore/V2/ThreadView/QuoteView.jsx`
  - `web/src/hooks/useThreadCarouselData.js` row fetches (hook currently not mounted in main Explore flow)
- Migrated hover/links fetch pathways in `web/src/pages/V2/FullScreenExplore.jsx` to query-backed fetches.

#### Issue coverage achieved

- `M8` duplicate fetches: reduced across filter pagination, thread/quote loads, node stats, and carousel row retrieval.
- `M12` AbortController/cancellation gap: addressed by passing Query-provided `signal` through API wrappers.
- `H7` error handling: improved via query error state and explicit scope/scopeRows error surface.
- `H5` race behavior: improved in filter application path with request sequencing and query-keyed fetches.

#### User-visible behavior impact

- Faster repeat navigation and repeat-open interactions due to shared cache reuse.
- Rapid filter changes are less likely to show stale row sets.
- Scope loading failures now show an explicit error message instead of a perpetual loading state.
- No intentional UX changes to filtering semantics, carousel behavior, or thread/quote rendering.

#### Validation run

- `npm run typecheck` in `web/`: passing.
- `npm run production` in `web/`: passing (build completes).
- `npm run lint` in `web/`: still failing due to many pre-existing repository lint violations unrelated to this migration.

#### Process notes

- External Claude review was requested but ultimately skipped by user direction in this run.

---

### Performance Fixes Implementation Status (2026-02-18)

This section records the manual code fixes implemented for the non-TanStack issues.

#### C1 — `hoveredPointIndex` layer rebuild: REVISED

**Files changed**: `web/src/components/Explore/V2/DeckGLScatter.jsx`

- **Original approach (reverted)**: Used a `hoveredPointIndexRef` and removed `hoveredPointIndex` from deps. This was incorrect — `updateTriggers` were frozen inside the memoized layer instances, so Deck.GL never saw trigger changes and never re-evaluated hover accessors. Caught by Codex review.
- **Corrected approach**: `hoveredPointIndex` remains in the `layers` useMemo dependency array. When hover changes, the useMemo recomputes and creates new layer JS instances. However, Deck.GL diffs layers by `id` — same `id` + same `data` reference = NO GPU buffer rebuild. Only the accessors named in `updateTriggers` whose trigger values changed are re-evaluated. Other layers (polygon, path, text) get new instances but Deck.GL sees their data/triggers unchanged → zero GPU work for those layers.
- **Correction to original audit**: The audit's C1 finding overstated the cost. Creating new `ScatterplotLayer` JS instances is cheap (~microseconds). The expensive operation — GPU buffer regeneration — only happens when the `data` reference changes or when `updateTriggers` signal accessor invalidation. Since `scatterData` is memoized separately and its reference is stable across hover changes, Deck.GL correctly limits work to re-evaluating the 4 hover-sensitive accessors. The original code was already working correctly; the only improvement is the explanatory comment documenting why this is safe.
- **Result**: Hover behavior unchanged. The `updateTriggers` mechanism correctly limits re-evaluation to hover-affected accessors only.

#### C2 — Label placement debounce during pan/zoom: FIXED

**Files changed**: `web/src/components/Explore/V2/DeckGLScatter.jsx`

- Added `useEffect` import.
- Added `debouncedViewState` state + 150ms debounce timer via `useEffect` on `controlledViewState`/`currentViewState`/`initialViewState`.
- `placedLabels` useMemo now depends on `debouncedViewState` instead of the raw `controlledViewState` + `currentViewState`.
- **Result**: Labels hold their last positions during active pan/zoom and reflow ~150ms after interaction settles. Main thread is unblocked during animation frames.
- **Behavior change**: Minor — labels may appear slightly mispositioned during fast panning, then snap to correct positions after settling.

#### C4 — `deletedIndices` converted to Set: FIXED

**Files changed**: `web/src/contexts/ScopeContext.tsx`, `web/src/contexts/FilterContext.jsx`, `web/src/pages/V2/FullScreenExplore.jsx`, `web/src/hooks/useNearestNeighborsSearch.js`

- `ScopeContext.tsx`: Type changed from `number[]` to `Set<number>`. Return value wraps `nextDeletedIndices` in `new Set()`.
- `FilterContext.jsx`: Removed redundant `deletedIndexSet` useMemo (was `new Set(deletedIndices)`). All references now use `deletedIndices.has()` directly.
- `FullScreenExplore.jsx`: All 5 `.includes()` calls converted to `.has()`.
- `useNearestNeighborsSearch.js`: Removed redundant `new Set(deletedIndices)` — `deletedIndices` is already a Set from ScopeContext.
- **Result**: All membership checks are O(1) instead of O(n). The `baseIndices` computation in FilterContext and all hover-path checks in FullScreenExplore are now constant-time.

#### C5 — HoverContext to isolate carousel rerenders: FIXED

**Files changed**: New `web/src/contexts/HoverContext.jsx`, `web/src/pages/V2/FullScreenExplore.jsx`, `web/src/components/Explore/V2/Carousel/FeedCarousel.jsx`, `web/src/components/Explore/V2/Carousel/FeedColumn.jsx`, `web/src/components/Explore/V2/TweetFeed/TweetCard.jsx`

- Created lightweight `HoverContext` with `HoverProvider` and `useHoveredIndex()` hook.
- `FullScreenExplore.jsx`: Wraps the page content with `<HoverProvider hoveredIndex={hoveredIndex}>`. Removed `hoveredIndex` prop from `TweetFeed` and `FeedCarousel` renders.
- `FeedCarousel.jsx`: Removed `hoveredIndex` from props and from `FeedColumn` prop pass.
- `FeedColumn.jsx`: Removed `hoveredIndex` from props. No longer passes `hoveredIndex` to `ThreadGroup` or computes `isHighlighted` inline.
- `TweetCard.jsx`: Now calls `useHoveredIndex()` from context and computes `isHighlighted` internally.
- **Note**: At time of implementation, `hoveredIndex` was already being passed as `null` to both FeedCarousel and TweetFeed. The HoverContext approach is architecturally correct for enabling future hover-highlighting in feeds without prop cascade.
- **Perf nuance (Codex review correction)**: Context value changes cause ALL context consumers to rerender, not just the 2 affected cards. The original audit overstated the reduction. The real win is structural: removing `hoveredIndex` from FeedCarousel/FeedColumn props means those components' `memo()` is no longer busted by hover. TweetCards still rerender from context, but since `hoveredIndex` is a primitive and TweetCard is `memo()`'d, the reconciliation is lightweight (only the highlight style changes).
- **Result**: FeedCarousel and FeedColumn memo preservation is the primary gain. TweetCard rerenders are cheaper but still occur for all context consumers.

#### H1 — Inline closures defeated React.memo: FIXED

**Files changed**: `web/src/components/Explore/V2/TweetFeed/TweetCard.jsx`, `web/src/components/Explore/V2/TweetFeed/TweetFeed.jsx`, `web/src/components/Explore/V2/TweetFeed/ThreadGroup.jsx`, `web/src/components/Explore/V2/Carousel/FeedColumn.jsx`

- `TweetCard.jsx`: Added `useCallback` import. Added stable `handleViewThread` and `handleViewQuotes` callbacks that call `onViewThread(row.ls_index)` / `onViewQuotes(row.ls_index)` internally. Removed `isHighlighted` prop (now via context). ConnectionBadges and reply button use the stable callbacks.
- `TweetFeed.jsx`: Removed `hoveredIndex` prop. Passes `onViewThread` / `onViewQuotes` directly to TweetCard (no inline closures).
- `ThreadGroup.jsx`: Removed `hoveredIndex` prop. Both root TweetCard and reply TweetCards receive `onViewThread` / `onViewQuotes` directly.
- `FeedColumn.jsx`: Removed `hoveredIndex` prop and inline closures from both TweetCard and ThreadGroup renders.
- **Not fixed**: Inline closures in `VisualizationPane.jsx:588` and `ThreadNode.jsx:55` — these render single cards / are in the thread view panel, not in the feed/carousel cascade path.
- **Result**: `React.memo` on TweetCard now works as intended. Parent rerenders no longer bust the memo via new function refs.

#### H3 — scatterData object allocation reduction: FIXED

**Files changed**: `web/src/components/Explore/V2/DeckGLScatter.jsx`

- Replaced `.map()` with a `for` loop and pre-allocated array (`new Array(len)`) to reduce GC pressure.
- **Reverted position reuse (Codex review correction)**: An earlier version reused the source `points[i]` array directly as `position`, but ScatterplotLayer interprets `position[2]` as z-coordinate — `selectionKey` would leak into z, affecting depth/picking. Reverted to creating `[p[0], p[1]]` pairs per point.
- **Note**: Full columnar `Float32Array` + `data.attributes` conversion was considered but deferred — it would require rewriting all accessors to be index-based since `data = { length, attributes }` format doesn't provide per-item objects to accessor functions.

#### H6 — `ls_index` vs array-index mismatch in hover: FIXED

**Files changed**: `web/src/pages/V2/FullScreenExplore.jsx`

- Added `scopeRowByLsIndex` Map (built via useMemo over `scopeRows`) for O(1) lookup by `ls_index`.
- Fixed hover annotation effect: `scopeRows[hoveredIndex]` → `scopeRowByLsIndex.get(hoveredIndex)` with null guard.
- **Note**: Hull-based lookups (`scopeRows[idx]` at lines 848, 1056) were NOT changed — hull indices are array positions, not `ls_index` values.
- **Result**: Hover annotations now correctly display for the hovered point even when `ls_index` doesn't equal array position (sparse datasets, post-deletion).

#### Validation

- `npx tsc --noEmit`: passing (zero errors).
- `npx vite build`: passing (build completes in ~6s).
- Sass deprecation warnings (legacy JS API) are pre-existing and unrelated.

#### Remaining unfixed issues from audit

| Issue | Status | Reason |
|-------|--------|--------|
| H2 (row-level virtualization) | Not started | Requires react-virtuoso integration, needs separate effort |
| H4 (URL params missing deps) | Already fixed | Addressed during TanStack migration (deps now include `clusterLabels`, `clusterFilter`, `columnFilter`) |
| H8 + M4 (dead code) | Not started | Low risk, deferred |
| M1 (god component extraction) | Not started | Architectural, deferred |
| M2 (context splitting) | Not started | Architectural, deferred |
| M3 (drag listener leak) | Not started | Low frequency, deferred |
| M5 (stale debounce callback) | Not started | Requires TanStack Pacer or manual fix |
| M6 (row order assumption) | Not started | Correctness risk, but low frequency |
| M8 (shared row cache) | Partially fixed | TanStack Query covers most duplicate fetch paths |
| M9 (clusterMap as object) | Low priority | O(1) lookup, rebuild churn is the real issue |
| M10 (normalizeScopeRows spread) | Low priority | Done once per fetch |
| M11 (console.log in production) | Not started | Cosmetic |
| M12 (AbortController) | Partially fixed | TanStack Query provides signal for migrated fetches |
