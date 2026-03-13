import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, memo } from 'react';
import PropTypes from 'prop-types';
import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import TopicListSidebar from './TopicListSidebar';
import FeedColumn from './FeedColumn';
import ThreadOverlay from './ThreadOverlay';
import { DEFAULT_SORT_DIRECTIONS, sortClusters } from '../../../../lib/sortClusters';
import styles from './FeedCarousel.module.scss';

const COLUMN_WIDTH = 550;
const GAP = 32;
const LIST_WIDTH = 360;
const VISIBLE_COLUMN_RADIUS = 3;
const DEFAULT_VIEWPORT_WIDTH = typeof window === 'undefined' ? COLUMN_WIDTH : window.innerWidth;

// Hoisted to avoid new object refs on every render
const MOTION_INITIAL = { opacity: 0, y: 20 };
const MOTION_ANIMATE = { opacity: 1, y: 0 };
const MOTION_TRANSITION = { duration: 0.25 };
const MOTION_STYLE = { flexShrink: 0 };
const EMPTY_TWEETS = [];

function FeedCarousel({
  topLevelClusters,
  columnData,
  columnRowsMap,
  loadMore,
  ensureColumnsLoaded,
  activeSubClusters,
  setSubClusterFilter,
  dataset,
  clusterMap,
  focusedClusterIndex,
  onFocusedIndexChange,
  onHover,
  onClick,
  nodeStats,
  onViewQuotes,
  subNavProps,
}) {
  const containerRef = useRef(null);
  const scrollRafRef = useRef(null);
  const latestScrollLeftRef = useRef(0);
  const [carouselGeometry, setCarouselGeometry] = useState({
    paddingLeft: 0,
    viewportWidth: DEFAULT_VIEWPORT_WIDTH,
  });
  const [overlayTweetId, setOverlayTweetId] = useState(null);
  const [overlayLsIndex, setOverlayLsIndex] = useState(null);
  const [isListScrolledOff, setIsListScrolledOff] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [sortMode, setSortMode] = useState('popular');
  const [sortDirection, setSortDirection] = useState(DEFAULT_SORT_DIRECTIONS.popular);
  const hasInitialScrollSyncRef = useRef(false);

  const handleSortDirectionToggle = useCallback(() => {
    setSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'));
  }, []);

  // ── Sticky ToC state ──
  const isHoveringToCRef = useRef(false);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef(null);
  const [isToCSticky, setIsToCSticky] = useState(false);

  // Sticky activates only when a programmatic scroll is in flight, OR
  // when the mouse is hovering AND the list has scrolled off (meaning a
  // prior programmatic scroll moved it). Just hovering in the default
  // unscrolled position should NOT activate sticky.
  const updateSticky = useCallback(() => {
    const shouldStick = isProgrammaticScrollRef.current ||
      (isHoveringToCRef.current && latestScrollLeftRef.current > 50);
    setIsToCSticky(shouldStick);
  }, []);

  const beginProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true;
    updateSticky();

    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
      updateSticky();
    }, 600);
  }, [updateSticky]);

  // ── Sort clusters: produces sorted array + index mappings ──
  const { sortedClusters, sortToOriginal, originalToSort } = useMemo(
    () => sortClusters(topLevelClusters, sortMode, sortDirection),
    [topLevelClusters, sortDirection, sortMode]
  );

  // ── Focused index in both spaces ──
  const normalizedFocusedIndex = Number.isFinite(focusedClusterIndex)
    ? Math.trunc(focusedClusterIndex)
    : 0;
  const clampedFocusedIndex = topLevelClusters.length > 0
    ? Math.min(Math.max(normalizedFocusedIndex, 0), topLevelClusters.length - 1)
    : 0;
  const sortedFocusedIndex = originalToSort[clampedFocusedIndex] ?? 0;

  const focusedIndexRef = useRef(clampedFocusedIndex); // original space
  focusedIndexRef.current = clampedFocusedIndex;

  // Stable ref for sortToOriginal so scroll handler doesn't stale-close
  const sortToOriginalRef = useRef(sortToOriginal);
  sortToOriginalRef.current = sortToOriginal;

  const measureCarouselGeometry = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const computedStyle = window.getComputedStyle(container);
    const nextPaddingLeft = Number.parseFloat(computedStyle.paddingLeft) || 0;
    const nextViewportWidth = container.clientWidth || window.innerWidth;

    setCarouselGeometry((prev) => {
      if (prev.paddingLeft === nextPaddingLeft && prev.viewportWidth === nextViewportWidth) {
        return prev;
      }
      return {
        paddingLeft: nextPaddingLeft,
        viewportWidth: nextViewportWidth,
      };
    });
  }, []);

  const spacerWidth = useMemo(() => {
    const targetStart = (carouselGeometry.viewportWidth - COLUMN_WIDTH) / 2;
    const currentStart = carouselGeometry.paddingLeft + LIST_WIDTH + GAP;
    return Math.max(0, targetStart - currentStart);
  }, [carouselGeometry.paddingLeft, carouselGeometry.viewportWidth]);

  useLayoutEffect(() => {
    measureCarouselGeometry();
  }, [measureCarouselGeometry]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        measureCarouselGeometry();
      });
      resizeObserver.observe(container);
    }

    window.addEventListener('resize', measureCarouselGeometry);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measureCarouselGeometry);
    };
  }, [measureCarouselGeometry]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, []);

  // scrollend listener — clears programmatic flag (supersedes fallback timeout)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScrollEnd = () => {
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = null;
      }
      isProgrammaticScrollRef.current = false;
      updateSticky();
    };
    el.addEventListener('scrollend', onScrollEnd);
    return () => el.removeEventListener('scrollend', onScrollEnd);
  }, [updateSticky]);

  useEffect(() => {
    if (!topLevelClusters.length) return;
    if (normalizedFocusedIndex !== clampedFocusedIndex) {
      onFocusedIndexChange(clampedFocusedIndex);
    }
  }, [normalizedFocusedIndex, clampedFocusedIndex, onFocusedIndexChange, topLevelClusters.length]);

  // getClosestIndex returns SORTED index (visual column position)
  const getClosestIndex = useCallback(
    (scrollLeft) => {
      if (!sortedClusters.length) return 0;

      const viewportCenter = carouselGeometry.viewportWidth / 2;
      const contentBefore = carouselGeometry.paddingLeft + LIST_WIDTH + GAP + spacerWidth;
      const effectiveWidth = COLUMN_WIDTH + GAP;
      const targetCenter = scrollLeft + viewportCenter - contentBefore - COLUMN_WIDTH / 2;
      const index = Math.round(targetCenter / effectiveWidth);

      return Math.max(0, Math.min(index, sortedClusters.length - 1));
    },
    [carouselGeometry.paddingLeft, carouselGeometry.viewportWidth, spacerWidth, sortedClusters.length]
  );

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    latestScrollLeftRef.current = containerRef.current.scrollLeft;
    if (scrollRafRef.current !== null) return;

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const scrollLeft = latestScrollLeftRef.current;
      setIsListScrolledOff(scrollLeft > 50);

      // Don't let the scroll listener rewrite focus while an entry/sort/click
      // scroll is still settling; otherwise the virtualized window can "walk"
      // focus away from the intended column.
      if (isProgrammaticScrollRef.current) return;

      const closestSortedIndex = getClosestIndex(scrollLeft);
      const closestOriginalIndex = sortToOriginalRef.current[closestSortedIndex];

      // Convert sorted index → original index for parent
      if (closestOriginalIndex !== undefined && closestOriginalIndex !== focusedIndexRef.current) {
        onFocusedIndexChange(closestOriginalIndex);
      }
    });
  }, [getClosestIndex, onFocusedIndexChange]);

  const getScrollTargetForColumn = useCallback(
    (sortedIndex) => {
      const contentBefore = carouselGeometry.paddingLeft + LIST_WIDTH + GAP + spacerWidth;
      const effectiveWidth = COLUMN_WIDTH + GAP;
      const columnStart = contentBefore + sortedIndex * effectiveWidth;
      return Math.max(0, columnStart - (carouselGeometry.viewportWidth - COLUMN_WIDTH) / 2);
    },
    [carouselGeometry.paddingLeft, carouselGeometry.viewportWidth, spacerWidth]
  );

  const scrollToStart = useCallback(
    ({ behavior = 'auto' } = {}) => {
      if (!containerRef.current) return;

      beginProgrammaticScroll();

      latestScrollLeftRef.current = 0;
      setIsListScrolledOff(false);
      containerRef.current.scrollTo({
        left: 0,
        behavior,
      });

      // Some browsers re-anchor the newly mounted overflow container after the
      // expanded layout settles. Re-apply the start position on the next paint
      // so the entry state reliably shows the ToC and first column.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!containerRef.current) return;
          latestScrollLeftRef.current = 0;
          setIsListScrolledOff(false);
          containerRef.current.scrollTo({
            left: 0,
            behavior: 'auto',
          });
        });
      });
    },
    [beginProgrammaticScroll]
  );

  // scrollToColumn takes a SORTED index
  const scrollToColumn = useCallback(
    (sortedIndex, { behavior = 'smooth' } = {}) => {
      if (!containerRef.current) return;

      beginProgrammaticScroll();

      const scrollTarget = getScrollTargetForColumn(sortedIndex);
      latestScrollLeftRef.current = scrollTarget;
      setIsListScrolledOff(scrollTarget > 50);
      containerRef.current.scrollTo({
        left: scrollTarget,
        behavior,
      });
    },
    [beginProgrammaticScroll, getScrollTargetForColumn]
  );

  useLayoutEffect(() => {
    if (!sortedClusters.length || !containerRef.current || hasInitialScrollSyncRef.current) return;

    const initialOriginalIndex = sortToOriginalRef.current[0] ?? 0;
    if (initialOriginalIndex !== focusedIndexRef.current) {
      onFocusedIndexChange(initialOriginalIndex);
      return;
    }

    // First open of the expanded carousel should land at the start of the
    // current column sort: ToC fully visible, first sorted topic selected.
    hasInitialScrollSyncRef.current = true;
    scrollToStart({ behavior: 'auto' });
  }, [clampedFocusedIndex, onFocusedIndexChange, scrollToStart, sortedClusters.length]);

  // Scroll to focused cluster when sort mode changes
  const prevSortKeyRef = useRef(`${sortMode}:${sortDirection}`);
  useEffect(() => {
    const nextSortKey = `${sortMode}:${sortDirection}`;
    if (prevSortKeyRef.current !== nextSortKey) {
      prevSortKeyRef.current = nextSortKey;
      requestAnimationFrame(() => {
        scrollToColumn(sortedFocusedIndex);
      });
    }
  }, [sortDirection, sortMode, sortedFocusedIndex, scrollToColumn]);

  // ── Sidebar click handlers ──
  // TopicListSidebar passes sorted indices; we convert to original for data ops

  const handleListClusterClick = useCallback(
    (sortedIdx) => {
      const originalIdx = sortToOriginalRef.current[sortedIdx];
      if (originalIdx !== undefined && originalIdx !== focusedIndexRef.current) {
        onFocusedIndexChange(originalIdx);
      }
      scrollToColumn(sortedIdx);
    },
    [onFocusedIndexChange, scrollToColumn]
  );

  const handleListSubClusterClick = useCallback(
    (sortedIdx, subClusterId) => {
      const originalIdx = sortToOriginalRef.current[sortedIdx];
      if (originalIdx !== undefined && originalIdx !== focusedIndexRef.current) {
        onFocusedIndexChange(originalIdx);
      }
      scrollToColumn(sortedIdx);
      if (originalIdx !== undefined) {
        setSubClusterFilter(originalIdx, subClusterId);
      }
    },
    [onFocusedIndexChange, scrollToColumn, setSubClusterFilter]
  );


  // FeedColumn's onSubClusterSelect passes original index (columnIndex prop is original)
  const handleColumnSubClusterClick = useCallback(
    (originalIdx, subClusterId) => {
      setSubClusterFilter(originalIdx, subClusterId);
    },
    [setSubClusterFilter]
  );

  const handleOpenThreadOverlay = useCallback((lsIndex) => {
    const tid = nodeStats?.get(lsIndex)?.tweetId;
    if (!tid) return;
    setOverlayTweetId(tid);
    setOverlayLsIndex(lsIndex);
  }, [nodeStats]);

  const handleCloseThreadOverlay = useCallback(() => {
    setOverlayTweetId(null);
    setOverlayLsIndex(null);
  }, []);

  const getFocusState = (sortedIdx) => {
    const distance = Math.abs(sortedIdx - sortedFocusedIndex);
    if (distance === 0) return 'focused';
    if (distance <= 2) return 'adjacent';
    return 'far';
  };

  const { visibleStart, visibleEnd, leadingSpacerWidth, trailingSpacerWidth } = useMemo(() => {
    if (!sortedClusters.length) return { visibleStart: 0, visibleEnd: 0, leadingSpacerWidth: 0, trailingSpacerWidth: 0 };
    const lastIndex = sortedClusters.length - 1;
    const windowStart = Math.max(0, sortedFocusedIndex - VISIBLE_COLUMN_RADIUS - 2);
    const windowEnd = Math.min(lastIndex, sortedFocusedIndex + VISIBLE_COLUMN_RADIUS + 2);

    const leadingCount = windowStart;
    const trailingCount = lastIndex - windowEnd;
    const calcSpacerWidth = (k) => k > 0 ? k * COLUMN_WIDTH + Math.max(0, k - 1) * GAP : 0;

    return {
      visibleStart: windowStart,
      visibleEnd: windowEnd,
      leadingSpacerWidth: calcSpacerWidth(leadingCount),
      trailingSpacerWidth: calcSpacerWidth(trailingCount),
    };
  }, [sortedFocusedIndex, sortedClusters.length]);

  const visibleOriginalIndices = useMemo(() => {
    const indices = [];
    for (let sortedIdx = visibleStart; sortedIdx <= visibleEnd; sortedIdx++) {
      const originalIdx = sortToOriginal[sortedIdx];
      if (originalIdx !== undefined) {
        indices.push(originalIdx);
      }
    }
    return indices;
  }, [sortToOriginal, visibleEnd, visibleStart]);

  useEffect(() => {
    ensureColumnsLoaded?.(visibleOriginalIndices);
  }, [ensureColumnsLoaded, visibleOriginalIndices]);

  if (!topLevelClusters?.length) {
    return (
      <div className={styles.emptyCarousel}>
        <p>No hierarchical clusters available for carousel view.</p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div ref={containerRef} className={styles.carousel} onScroll={handleScroll}>
        <TopicListSidebar
          topLevelClusters={sortedClusters}
          focusedIndex={sortedFocusedIndex}
          onClickCluster={handleListClusterClick}
          onClickSubCluster={handleListSubClusterClick}
          sortMode={sortMode}
          onSortChange={setSortMode}
          sortDirection={sortDirection}
          onSortDirectionToggle={handleSortDirectionToggle}
          isSticky={isToCSticky}
          onMouseEnter={() => { isHoveringToCRef.current = true; updateSticky(); }}
          onMouseLeave={() => { isHoveringToCRef.current = false; updateSticky(); }}
          subNavProps={subNavProps}
        />

        {/* Spacer to center first feed */}
        <div className={styles.spacer} style={{ width: spacerWidth }} />

        {/* Leading spacer replaces omitted columns before window */}
        {leadingSpacerWidth > 0 && (
          <div style={{ width: leadingSpacerWidth, minWidth: leadingSpacerWidth, flexShrink: 0 }} aria-hidden="true" />
        )}

        {sortedClusters.slice(visibleStart, visibleEnd + 1).map((cluster, i) => {
          const sortedIdx = visibleStart + i;
          const originalIdx = sortToOriginal[sortedIdx];
          const col = columnData[originalIdx] || {};
          const tweets = columnRowsMap[originalIdx] || EMPTY_TWEETS;
          const distance = Math.abs(sortedIdx - sortedFocusedIndex);
          const isInViewRadius = distance <= VISIBLE_COLUMN_RADIUS;

          if (!isInViewRadius) {
            return (
              <div
                key={cluster.cluster}
                className={styles.columnPlaceholder}
                style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
                aria-hidden="true"
              />
            );
          }

          return (
            <motion.div
              key={cluster.cluster}
              initial={MOTION_INITIAL}
              animate={MOTION_ANIMATE}
              transition={MOTION_TRANSITION}
              style={MOTION_STYLE}
            >
              <FeedColumn
                columnIndex={originalIdx}
                cluster={cluster}
                tweets={tweets}
                focusState={getFocusState(sortedIdx)}
                columnWidth={COLUMN_WIDTH}
                subClusters={cluster.children}
                activeSubCluster={activeSubClusters[originalIdx] || null}
                onSubClusterSelect={handleColumnSubClusterClick}
                dataset={dataset}
                clusterMap={clusterMap}
                loading={col.loading}
                hasMore={col.hasMore}
                onLoadMore={loadMore}
                onHover={onHover}
                onClick={onClick}
                nodeStats={nodeStats}
                onViewThread={handleOpenThreadOverlay}
                onViewQuotes={onViewQuotes}
              />
            </motion.div>
          );
        })}

        {/* Trailing spacer replaces omitted columns after window */}
        {trailingSpacerWidth > 0 && (
          <div style={{ width: trailingSpacerWidth, minWidth: trailingSpacerWidth, flexShrink: 0 }} aria-hidden="true" />
        )}
      </div>

      {/* Left-edge hover zone with visible tab indicator */}
      {!isToCSticky && isListScrolledOff && !showOverlay && (
        <div
          className={styles.hoverZone}
          onMouseEnter={() => setShowOverlay(true)}
        >
          <div className={styles.hoverTab}>
            <ChevronRight size={14} />
          </div>
        </div>
      )}
      {showOverlay && (
        <div
          className={styles.listOverlay}
          onMouseLeave={() => setShowOverlay(false)}
        >
          <TopicListSidebar
            topLevelClusters={sortedClusters}
            focusedIndex={sortedFocusedIndex}
            onClickCluster={handleListClusterClick}
            onClickSubCluster={handleListSubClusterClick}
            sortMode={sortMode}
            onSortChange={setSortMode}
            sortDirection={sortDirection}
            onSortDirectionToggle={handleSortDirectionToggle}
            disableKeyboardShortcuts
            subNavProps={subNavProps}
          />
        </div>
      )}

      <ThreadOverlay
        open={!!overlayTweetId}
        dataset={dataset}
        tweetId={overlayTweetId}
        currentLsIndex={overlayLsIndex}
        nodeStats={nodeStats}
        clusterMap={clusterMap}
        onClose={handleCloseThreadOverlay}
        onViewThread={handleOpenThreadOverlay}
        onViewQuotes={onViewQuotes}
      />
    </div>
  );
}

FeedCarousel.propTypes = {
  topLevelClusters: PropTypes.array.isRequired,
  columnData: PropTypes.object.isRequired,
  columnRowsMap: PropTypes.object.isRequired,
  loadMore: PropTypes.func,
  ensureColumnsLoaded: PropTypes.func,
  activeSubClusters: PropTypes.object.isRequired,
  setSubClusterFilter: PropTypes.func.isRequired,
  dataset: PropTypes.object,
  clusterMap: PropTypes.object,
  focusedClusterIndex: PropTypes.number,
  onFocusedIndexChange: PropTypes.func.isRequired,
  onHover: PropTypes.func,
  onClick: PropTypes.func,
  nodeStats: PropTypes.shape({
    get: PropTypes.func,
  }),
  onViewQuotes: PropTypes.func,
  subNavProps: PropTypes.shape({
    dataset: PropTypes.object,
    scope: PropTypes.object,
    scopes: PropTypes.array,
    onScopeChange: PropTypes.func,
    onBack: PropTypes.func,
  }),
};

export default memo(FeedCarousel);
