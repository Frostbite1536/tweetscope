# TanStack Virtual Horizontal Carousel Migration Plan

Baseline commit: `0b9c4fe` (`Fix far-jump feed carousel scrolling`)

## Goal

Replace the custom horizontal windowing logic in the Explore carousel with TanStack Virtual, while preserving:

- direct far-jump navigation from the topic list
- pinned / hover-revealed ToC behavior
- per-column lazy data loading
- thread overlay behavior
- current tweet/embed rendering inside each mounted column

This plan is intentionally scoped to the horizontal carousel only. It does **not** recommend virtualizing the vertical tweet list inside each `FeedColumn` yet.

## Current Dataflow

Current entry points:

- [FullScreenExplore.jsx](/Users/sheikmeeran/latent-scope/web/src/pages/V2/FullScreenExplore.jsx)
- [FeedCarousel.jsx](/Users/sheikmeeran/latent-scope/web/src/components/Explore/V2/Carousel/FeedCarousel.jsx)
- [TopicListSidebar.jsx](/Users/sheikmeeran/latent-scope/web/src/components/Explore/V2/Carousel/TopicListSidebar.jsx)
- [TopicCard.jsx](/Users/sheikmeeran/latent-scope/web/src/components/Explore/V2/TopicDirectory/TopicCard.jsx)
- [useCarouselData.js](/Users/sheikmeeran/latent-scope/web/src/hooks/useCarouselData.js)

Current flow:

1. `FullScreenExplore` owns `focusedClusterIndex`.
2. `useCarouselData` owns per-column rows, `ensureColumnsLoaded`, and subcluster filters.
3. `FeedCarousel` sorts clusters, maps sorted/original indexes, computes visible window bounds, and renders only a narrow manual range around `visualSortedIndex`.
4. `TopicListSidebar` emits sorted indexes via `TopicCard` clicks.
5. `FeedCarousel` converts sorted index -> original index, updates focus, then scrolls horizontally.

The bug we just fixed came from step 3: the virtualized window and the scroll target were managed separately. A far target often was not mounted when native snapped scrolling started.

## Why TanStack Virtual Fits

Official docs:

- Introduction: https://tanstack.com/virtual/latest/docs/introduction
- React adapter: https://tanstack.com/virtual/latest/docs/framework/react/react-virtual
- Virtualizer API: https://tanstack.com/virtual/latest/docs/api/virtualizer
- Sticky example: https://tanstack.com/virtual/latest/docs/framework/react/examples/sticky
- Infinite scroll example: https://tanstack.com/virtual/latest/docs/framework/react/examples/infinite-scroll
- Dynamic example: https://tanstack.com/virtual/latest/docs/framework/react/examples/dynamic
- Smooth scroll example: https://tanstack.com/virtual/latest/docs/framework/react/examples/smooth-scroll

Relevant API support from the docs:

- `useVirtualizer` for element-based scrolling
- `horizontal: true`
- `overscan`
- `gap`
- `getItemKey`
- `scrollToIndex` / `scrollToOffset`
- `onChange(instance, sync)`
- `scrollMargin`
- `paddingStart` / `paddingEnd`
- `scrollPaddingStart` / `scrollPaddingEnd`
- `useScrollendEvent`
- `rangeExtractor` for sticky/manual items when needed

Docs references:

- TanStack Virtual is headless and supports horizontal virtualizers: Introduction lines 265-269.
- `useVirtualizer` returns a standard `Virtualizer` for an element scroll container: React adapter lines 265-277.
- `horizontal`, `overscan`, `paddingStart`, `scrollPaddingStart`, `getItemKey`, `rangeExtractor`, `scrollToIndex`, `measureElement`, `shouldAdjustScrollPositionOnItemSizeChange`: Virtualizer API lines 324-395 and 569-652.
- `scrollMargin` is specifically meant for the space between the scroll element start and the start of the list when multiple things share a scroll container: Virtualizer API lines 446-458.
- Sticky items can be injected with `rangeExtractor`: Sticky example lines 315-331.
- Infinite loading can be driven from the last virtual item: Infinite Scroll example lines 327-352.

## Recommendation

Implement TanStack Virtual for the horizontal column strip only.

Do **not** virtualize the vertical tweet cards inside `FeedColumn` in this migration.

Reason:

- Horizontal columns are fixed-width and predictable.
- Vertical tweet content is not: threads expand, embeds resize after mount, and the docs explicitly call out dynamic measurement complexity.
- The API also notes that smooth scrolling with dynamically measured content has special constraints, and dynamic measurement changes can shift later items.

For this codebase, the high-value simplification is replacing manual column windowing, not replacing the per-column tweet rendering strategy.

## What TanStack Should Replace

Delete or simplify in [FeedCarousel.jsx](/Users/sheikmeeran/latent-scope/web/src/components/Explore/V2/Carousel/FeedCarousel.jsx):

- manual `visibleStart` / `visibleEnd`
- manual leading/trailing spacer math for omitted columns
- manual `getClosestIndex`
- manual far-target pre-render queueing

Keep:

- sort/original index mapping
- ToC reveal/pin state
- overlay thread state
- `ensureColumnsLoaded`
- `activeSubClusters`
- feed loading and column content rendering

## Proposed Architecture

### Scroll Container

Keep the existing horizontal scroll element in `FeedCarousel`.

Keep `TopicListSidebar` as a real sibling inside that same scroll container so its “scroll off, then become sticky/overlayed” behavior remains intact.

### Virtualized Column Track

Render a single TanStack-managed inner track after the ToC/spacer region.

Recommended setup:

```tsx
const columnVirtualizer = useVirtualizer({
  count: sortedClusters.length,
  horizontal: true,
  getScrollElement: () => containerRef.current,
  estimateSize: () => COLUMN_WIDTH,
  gap: GAP,
  overscan: 2,
  getItemKey: (index) => sortedClusters[index]?.cluster ?? index,
  scrollMargin: listAndSpacerOffset,
  scrollPaddingStart: centerOffset,
  scrollPaddingEnd: centerOffset,
  onChange: handleVirtualizerChange,
})
```

Where:

- `listAndSpacerOffset = paddingLeft + LIST_WIDTH + GAP + spacerWidth`
- `centerOffset = (viewportWidth - COLUMN_WIDTH) / 2`

Why `scrollMargin` matters:

- the docs describe it as the offset between the start of the scroll element and the start of the list
- that exactly matches this carousel, because the column list does not start at `scrollLeft = 0`

### Rendering Strategy

Render only `columnVirtualizer.getVirtualItems()`.

Each virtual item should position from `virtualItem.start - scrollMargin` if using absolute positioning, per the docs.

Pseudo-structure:

```tsx
<div ref={containerRef} className={styles.carousel}>
  <TopicListSidebar ... />
  <div className={styles.spacer} style={{ width: spacerWidth }} />
  <div
    style={{
      width: columnVirtualizer.getTotalSize(),
      height: '100%',
      position: 'relative',
      flexShrink: 0,
    }}
  >
    {columnVirtualizer.getVirtualItems().map((item) => {
      const sortedIdx = item.index
      const originalIdx = sortToOriginal[sortedIdx]
      return (
        <div
          key={item.key}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: COLUMN_WIDTH,
            transform: `translateX(${item.start - columnVirtualizer.options.scrollMargin}px)`,
          }}
        >
          <FeedColumn ... />
        </div>
      )
    })}
  </div>
</div>
```

## Focus and Scroll Ownership

### Topic Clicks

Replace custom `scrollToColumn` math with:

```tsx
columnVirtualizer.scrollToIndex(sortedIdx, {
  align: 'center',
  behavior: 'smooth',
})
```

This should remove the “target not mounted yet” class of bug because the virtualizer owns both the rendered range and the scroll target.

### Scroll -> Focus Sync

Use `onChange(instance, sync)` to update the visual/focused index while scrolling.

Suggested rule:

- while `sync === true`, derive the nearest virtual item to the viewport center and update `visualSortedIndex`
- once scrolling settles, propagate the nearest sorted/original index back to `focusedClusterIndex`

This is a better fit than mixing raw `scrollLeft` math, `requestAnimationFrame`, and `scrollend`.

### Initial Entry

Keep the current “open expanded mode at start of strip” behavior.

Use:

- `initialOffset: 0` when entering expanded mode at the start
- `scrollToIndex(sortedFocusedIndex, { align: 'center' })` only for explicit sort changes or explicit ToC clicks

## Data Loading Plan

Drive `ensureColumnsLoaded` from the virtual items instead of manual window bounds.

Suggested behavior:

- collect `columnVirtualizer.getVirtualItems()`
- map them to original indices
- prefetch those plus one extra index on each side

This matches the Infinite Scroll example pattern, where side effects depend on `getVirtualItems()`.

## ToC / Sticky Overlay

Recommendation: keep the ToC outside TanStack’s item range.

Do **not** use `rangeExtractor` for the ToC in phase 1.

Reason:

- your ToC is not a sticky row within the column list
- it is a separate control surface with search, sort, hover reveal, pinned mode, and its own vertical scroll

`rangeExtractor` is useful if you later want sticky headers inside the virtualized range itself. The Sticky example shows that pattern, but it is not the cleanest model for this sidebar.

## CSS / Layout Changes

Required cleanup during migration:

- remove the manual leading/trailing placeholder elements
- remove column placeholder rendering
- remove `scroll-snap-type` / `scroll-snap-align` from the virtualized columns

Reason:

- native scroll snapping and virtualizer-driven `scrollToIndex` are overlapping control systems
- the bug we fixed came from that overlap plus manual windowing

Keep:

- overall carousel overflow container
- sticky overlay visuals
- column width styling

## Edge Cases

### Twitter Embeds

Horizontal virtualization is safe here because column width is fixed.

Embed height changes stay inside mounted columns and do not require horizontal measurement updates.

Do not virtualize tweet rows vertically in this migration.

### Threads / Expanded Column Content

Same answer as embeds: content height can change without invalidating horizontal item size.

### Sort Changes

After re-sorting:

- rebuild `sortedClusters`
- keep `getItemKey` stable on `cluster.cluster`
- call `scrollToIndex(sortedFocusedIndex, { align: 'center' })` if the current focus should remain visible

### Reveal / Pinned ToC

No TanStack feature replaces this. Keep existing custom state.

### Scroll-End Detection

TanStack has `useScrollendEvent` and `isScrollingResetDelay`, but I would treat `onChange(instance, sync)` as the main signal and use the native `scrollend` path only if the UI still needs a hard “animation completed” edge.

### Framer Motion

Be conservative with per-item entrance animation on virtual items.

Virtualized mount/unmount plus animation can create churn that looks like instability even when the logic is correct. If animation stays, keep it minimal.

## Migration Phases

### Phase 1

- add `@tanstack/react-virtual`
- introduce the column virtualizer alongside current sorted/original mapping
- keep ToC markup and state unchanged
- keep `FeedColumn` unchanged

### Phase 2

- switch `ensureColumnsLoaded` to virtual-item-driven prefetch
- remove manual visible window state and spacer replacement logic
- remove manual far-jump queueing

### Phase 3

- remove scroll-snap CSS
- re-tune focus syncing from `onChange`
- re-run browser verification on far jumps, sort changes, hover/pinned ToC, and thread overlay open/close

## Verification Checklist

Browser checks:

- open expanded mode from start of strip
- click a far-away topic once and confirm one-step landing
- click a far-away subtopic once and confirm one-step landing + filter application
- change sort mode and sort direction, confirm focus and centering remain correct
- hover-reveal ToC, pinned ToC, and sticky ToC all still behave correctly
- open thread overlay from a mounted column and close it
- verify load-more still works in mounted columns

Regression target:

- no repeated-click “walking” toward the target
- no spontaneous reset to the beginning of the horizontal strip

## Non-Goals

- virtualizing tweets inside `FeedColumn`
- redesigning ToC behavior
- changing cluster sort semantics
- changing embed scheduler behavior

## Recommendation Summary

Proceed with TanStack Virtual for horizontal columns only.

It should materially simplify the current carousel, remove the class of bug we just fixed manually, and let the codebase stop hand-maintaining visible ranges and spacer math.

It should **not** be treated as a drop-in simplifier for the tweet list inside each column. That part still has dynamic-height and embed-specific complexity that TanStack can support, but not cheaply.
