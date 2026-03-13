import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, memo } from 'react';
import PropTypes from 'prop-types';
import { ChevronRight } from 'lucide-react';
import TopicListSidebar from './TopicListSidebar';
import FeedColumn from './FeedColumn';
import ThreadOverlay from './ThreadOverlay';
import { recordFeedCarouselDebug } from '../../../../lib/feedCarouselDebug';
import { DEFAULT_SORT_DIRECTIONS, sortClusters } from '../../../../lib/sortClusters';
import styles from './FeedCarousel.module.scss';

const COLUMN_WIDTH = 550;
const GAP = 32;
const LIST_WIDTH = 360;
const VISIBLE_COLUMN_RADIUS = 3;
const PROGRAMMATIC_SCROLL_TOLERANCE = 8;
const DEFAULT_VIEWPORT_WIDTH = typeof window === 'undefined' ? COLUMN_WIDTH : window.innerWidth;

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
  const tocContainerRef = useRef(null);
  const scrollRafRef = useRef(null);
  const pendingColumnScrollRef = useRef(null);
  const lastToCPointerRef = useRef({ x: null, y: null });
  const latestScrollLeftRef = useRef(0);
  const [carouselGeometry, setCarouselGeometry] = useState({
    paddingLeft: 0,
    viewportWidth: DEFAULT_VIEWPORT_WIDTH,
  });
  const [overlayTweetId, setOverlayTweetId] = useState(null);
  const [overlayLsIndex, setOverlayLsIndex] = useState(null);
  const [isListScrolledOff, setIsListScrolledOff] = useState(false);
  const [isToCRevealed, setIsToCRevealed] = useState(false);
  const [isPinnedAfterToCAction, setIsPinnedAfterToCAction] = useState(false);
  const [sortMode, setSortMode] = useState('popular');
  const [sortDirection, setSortDirection] = useState(DEFAULT_SORT_DIRECTIONS.popular);
  const [visualSortedIndex, setVisualSortedIndex] = useState(0);
  const hasInitialScrollSyncRef = useRef(false);

  // ── Sticky ToC state ──
  const isHoveringStickyToCRef = useRef(false);
  const isPinnedAfterToCActionRef = useRef(false);
  const isProgrammaticScrollRef = useRef(false);
  const shouldHideToCAfterProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef(null);
  const programmaticScrollReasonRef = useRef(null);
  const programmaticTargetLeftRef = useRef(null);

  // Keep the sticky shell mounted for the whole "scrolled away from start"
  // state. Only the shell's visual exposure changes; otherwise hiding the ToC
  // can perturb browser scroll/focus behavior and jerk the carousel sideways.
  const isToCStickyShell = isListScrolledOff;
  const isToCStickyVisible = isListScrolledOff && (isToCRevealed || isPinnedAfterToCAction);

  const clearLastToCPointer = useCallback(() => {
    lastToCPointerRef.current = { x: null, y: null };
  }, []);

  const updateLastToCPointer = useCallback((event) => {
    if (!event) return;
    lastToCPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }, []);

  const isPointerWithinStickyToC = useCallback(() => {
    const tocEl = tocContainerRef.current;
    if (!tocEl || typeof document === 'undefined') return false;
    if (tocEl.matches(':hover')) return true;

    const { x, y } = lastToCPointerRef.current;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

    const hoveredEl = document.elementFromPoint(x, y);
    return Boolean(hoveredEl && tocEl.contains(hoveredEl));
  }, []);

  const revealToC = useCallback(() => {
    setIsToCRevealed(true);
  }, []);

  const clearToCReveal = useCallback(() => {
    if (tocContainerRef.current?.contains(document.activeElement)) {
      // Once the sticky ToC is no longer visually exposed, any focused control
      // inside it becomes an offscreen target. Browsers may then auto-scroll
      // the horizontal strip back toward the start to reveal that focused
      // element, so blur it before collapsing the sticky shell.
      document.activeElement.blur();
    }
    clearLastToCPointer();
    shouldHideToCAfterProgrammaticScrollRef.current = false;
    isHoveringStickyToCRef.current = false;
    isPinnedAfterToCActionRef.current = false;
    setIsPinnedAfterToCAction(false);
    setIsToCRevealed(false);
  }, [clearLastToCPointer]);

  const pinToCAfterAction = useCallback(() => {
    shouldHideToCAfterProgrammaticScrollRef.current = false;
    isPinnedAfterToCActionRef.current = true;
    setIsPinnedAfterToCAction(true);
    setIsToCRevealed(true);
  }, []);

  const handleToCMouseEnter = useCallback((event) => {
    updateLastToCPointer(event);
    if (!latestScrollLeftRef.current || latestScrollLeftRef.current <= 50) return;
    isHoveringStickyToCRef.current = true;
    setIsToCRevealed(true);
  }, [updateLastToCPointer]);

  const handleToCMouseMove = useCallback((event) => {
    updateLastToCPointer(event);
    if (!latestScrollLeftRef.current || latestScrollLeftRef.current <= 50) return;
    isHoveringStickyToCRef.current = true;
  }, [updateLastToCPointer]);

  const handleToCMouseLeave = useCallback((event) => {
    if (!latestScrollLeftRef.current || latestScrollLeftRef.current <= 50) return;
    if (isProgrammaticScrollRef.current) {
      // Keep the sticky ToC mounted until the click-driven horizontal scroll
      // settles. Clearing reveal immediately changes the strip's snap/layout
      // state mid-flight, which can cause the browser to re-snap back to the
      // first column.
      clearLastToCPointer();
      shouldHideToCAfterProgrammaticScrollRef.current = true;
      isHoveringStickyToCRef.current = false;
      isPinnedAfterToCActionRef.current = false;
      setIsPinnedAfterToCAction(false);
      return;
    }
    clearToCReveal();
  }, [clearLastToCPointer, clearToCReveal]);

  const handleSortChange = useCallback(
    (nextSortMode) => {
      pinToCAfterAction();
      setSortMode(nextSortMode);
    },
    [pinToCAfterAction]
  );

  const handleSortDirectionToggle = useCallback(() => {
    pinToCAfterAction();
    setSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'));
  }, [pinToCAfterAction]);

  const endProgrammaticScroll = useCallback((source, scrollLeft) => {
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }

    // Preserve the sticky ToC after a programmatic click-driven scroll if the
    // pointer is still physically over it, even if React enter/leave state
    // momentarily lags during the rerender/scroll sequence.
    const hoveredStickyToC = isHoveringStickyToCRef.current || isPointerWithinStickyToC();
    const shouldHideToCAfterProgrammaticScroll =
      shouldHideToCAfterProgrammaticScrollRef.current;
    shouldHideToCAfterProgrammaticScrollRef.current = false;
    isProgrammaticScrollRef.current = false;
    recordFeedCarouselDebug('programmatic-scroll-end', {
      source,
      reason: programmaticScrollReasonRef.current,
      targetLeft: programmaticTargetLeftRef.current,
      scrollLeft,
      hoveredStickyToC,
      pinnedAfterToCAction: isPinnedAfterToCActionRef.current,
      shouldHideToCAfterProgrammaticScroll,
    });
    programmaticScrollReasonRef.current = null;
    programmaticTargetLeftRef.current = null;

    if (hoveredStickyToC) {
      isHoveringStickyToCRef.current = true;
      setIsToCRevealed(true);
      return;
    }

    if (!hoveredStickyToC) {
      clearToCReveal();
    }
  }, [clearToCReveal, isPointerWithinStickyToC]);

  const beginProgrammaticScroll = useCallback((reason = 'unknown', targetLeft = null) => {
    isProgrammaticScrollRef.current = true;
    programmaticScrollReasonRef.current = reason;
    programmaticTargetLeftRef.current = targetLeft;

    const distance = targetLeft == null
      ? 0
      : Math.abs(targetLeft - latestScrollLeftRef.current);
    const timeoutMs = Math.max(600, Math.min(3000, 600 + distance * 0.12));

    recordFeedCarouselDebug('programmatic-scroll-begin', {
      reason,
      targetLeft,
      timeoutMs,
      scrollLeft: latestScrollLeftRef.current,
      focusedOriginal: focusedIndexRef.current,
    });

    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = setTimeout(() => {
      recordFeedCarouselDebug('programmatic-scroll-timeout', {
        reason: programmaticScrollReasonRef.current,
        targetLeft: programmaticTargetLeftRef.current,
        scrollLeft: latestScrollLeftRef.current,
      });
      endProgrammaticScroll('timeout', latestScrollLeftRef.current);
    }, timeoutMs);
  }, [endProgrammaticScroll]);

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

  const visibleWindowRangeRef = useRef({ start: 0, end: 0 });

  useEffect(() => {
    if (!sortedClusters.length) {
      setVisualSortedIndex(0);
      return;
    }

    if (!isProgrammaticScrollRef.current) {
      setVisualSortedIndex((current) => (
        current === sortedFocusedIndex ? current : sortedFocusedIndex
      ));
    }
  }, [sortedClusters.length, sortedFocusedIndex]);

  const getClusterDebugMeta = useCallback(
    (originalIdx, sortedIdx = originalToSort[originalIdx]) => {
      const originalCluster = Number.isInteger(originalIdx) ? topLevelClusters[originalIdx] : null;
      const sortedCluster = Number.isInteger(sortedIdx) ? sortedClusters[sortedIdx] : null;
      const cluster = originalCluster || sortedCluster;

      return {
        originalIdx,
        sortedIdx,
        clusterId: cluster?.cluster ?? null,
        label: cluster?.label ?? null,
      };
    },
    [originalToSort, sortedClusters, topLevelClusters]
  );

  const emitFocusedIndexChange = useCallback(
    (source, originalIdx, extra = {}) => {
      recordFeedCarouselDebug('focus-change', {
        source,
        ...getClusterDebugMeta(originalIdx),
        currentFocusedOriginal: focusedIndexRef.current,
        scrollLeft: latestScrollLeftRef.current,
        ...extra,
      });
      onFocusedIndexChange(originalIdx);
    },
    [getClusterDebugMeta, onFocusedIndexChange]
  );

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
      pendingColumnScrollRef.current = null;
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Reset sticky-ToC reveal state when the user is genuinely back at the
    // strip start. Do not clear it while a click-driven scroll is leaving the
    // start, otherwise the ToC can collapse before the sticky shell takes over.
    if (!isListScrolledOff && !isProgrammaticScrollRef.current) {
      clearToCReveal();
    }
  }, [clearToCReveal, isListScrolledOff]);

  useEffect(() => {
    if (!isToCRevealed) return undefined;

    const viewportHeight = window.innerHeight;

    const handlePointerMove = (event) => {
      // Don't collapse the sticky ToC while a click-triggered horizontal scroll
      // is still settling. Changing reveal state here mutates the strip layout
      // and can force the browser to re-snap to the start.
      if (isProgrammaticScrollRef.current) return;
      if (isHoveringStickyToCRef.current || isPinnedAfterToCActionRef.current) return;
      if (event.clientX > LIST_WIDTH || event.clientY < 0 || event.clientY > viewportHeight) {
        setIsToCRevealed(false);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, [isToCRevealed]);

  // scrollend listener — clears programmatic flag (supersedes fallback timeout)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScrollEnd = () => {
      if (!isProgrammaticScrollRef.current) return;
      endProgrammaticScroll('scrollend', el.scrollLeft);
    };
    el.addEventListener('scrollend', onScrollEnd);
    return () => el.removeEventListener('scrollend', onScrollEnd);
  }, [endProgrammaticScroll]);

  useEffect(() => {
    if (!topLevelClusters.length) return;
    if (normalizedFocusedIndex !== clampedFocusedIndex) {
      emitFocusedIndexChange('clamp-focused-index', clampedFocusedIndex, {
        normalizedFocusedIndex,
      });
    }
  }, [normalizedFocusedIndex, clampedFocusedIndex, emitFocusedIndexChange, topLevelClusters.length]);

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
      const nextIsScrolledOff = scrollLeft > 50;
      setIsListScrolledOff(nextIsScrolledOff);

      const closestSortedIndex = getClosestIndex(scrollLeft);
      setVisualSortedIndex((current) => (
        current === closestSortedIndex ? current : closestSortedIndex
      ));

      if (
        !isProgrammaticScrollRef.current &&
        !isHoveringStickyToCRef.current &&
        !isPinnedAfterToCActionRef.current &&
        nextIsScrolledOff
      ) {
        setIsToCRevealed(false);
      }

      // Don't let the scroll listener rewrite focus while an entry/sort/click
      // scroll is still settling; otherwise the virtualized window can "walk"
      // focus away from the intended column.
      if (isProgrammaticScrollRef.current) {
        const targetLeft = programmaticTargetLeftRef.current;
        if (
          targetLeft != null &&
          Math.abs(scrollLeft - targetLeft) <= PROGRAMMATIC_SCROLL_TOLERANCE
        ) {
          endProgrammaticScroll('target-reached', scrollLeft);
        }
        return;
      }

      const closestOriginalIndex = sortToOriginalRef.current[closestSortedIndex];

      // Convert sorted index → original index for parent
      if (closestOriginalIndex !== undefined && closestOriginalIndex !== focusedIndexRef.current) {
        emitFocusedIndexChange('scroll-center', closestOriginalIndex, {
          scrollLeft,
          closestSortedIndex,
        });
      }
    });
  }, [emitFocusedIndexChange, endProgrammaticScroll, getClosestIndex]);

  const getScrollTargetForColumn = useCallback(
    (sortedIndex) => {
      if (sortedIndex <= 0) {
        return 0;
      }
      const contentBefore = carouselGeometry.paddingLeft + LIST_WIDTH + GAP + spacerWidth;
      const effectiveWidth = COLUMN_WIDTH + GAP;
      const columnStart = contentBefore + sortedIndex * effectiveWidth;
      return Math.max(0, columnStart - (carouselGeometry.viewportWidth - COLUMN_WIDTH) / 2);
    },
    [carouselGeometry.paddingLeft, carouselGeometry.viewportWidth, spacerWidth]
  );

  const scrollToStart = useCallback(
    ({ behavior = 'auto', reason = 'unknown' } = {}) => {
      if (!containerRef.current) return;

      recordFeedCarouselDebug('scroll-to-start', {
        reason,
        behavior,
        currentLeft: containerRef.current.scrollLeft,
      });
      beginProgrammaticScroll(reason, 0);

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

  const performScrollToColumn = useCallback(
    (sortedIndex, { behavior = 'smooth', reason = 'unknown' } = {}) => {
      if (!containerRef.current) return;

      const scrollTarget = getScrollTargetForColumn(sortedIndex);
      const originalIdx = sortToOriginalRef.current[sortedIndex];

      recordFeedCarouselDebug('scroll-to-column', {
        reason,
        behavior,
        targetLeft: scrollTarget,
        currentLeft: containerRef.current.scrollLeft,
        ...getClusterDebugMeta(originalIdx, sortedIndex),
      });

      beginProgrammaticScroll(reason, scrollTarget);

      latestScrollLeftRef.current = scrollTarget;
      setIsListScrolledOff(scrollTarget > 50);
      containerRef.current.scrollTo({
        left: scrollTarget,
        behavior,
      });
    },
    [beginProgrammaticScroll, getClusterDebugMeta, getScrollTargetForColumn]
  );

  // scrollToColumn takes a SORTED index
  const scrollToColumn = useCallback(
    (sortedIndex, options = {}) => {
      if (!containerRef.current) return;

      if (sortedIndex <= 0) {
        pendingColumnScrollRef.current = null;
        scrollToStart({
          ...options,
          behavior: options.behavior ?? 'smooth',
        });
        return;
      }

      const { start, end } = visibleWindowRangeRef.current;
      const targetOutsideWindow = sortedIndex < start || sortedIndex > end;

      if (targetOutsideWindow) {
        pendingColumnScrollRef.current = { sortedIndex, options };
        setVisualSortedIndex((current) => (current === sortedIndex ? current : sortedIndex));
        return;
      }

      pendingColumnScrollRef.current = null;
      performScrollToColumn(sortedIndex, options);
    },
    [performScrollToColumn, scrollToStart]
  );

  useLayoutEffect(() => {
    if (!sortedClusters.length || !containerRef.current || hasInitialScrollSyncRef.current) return;

    const initialOriginalIndex = sortToOriginalRef.current[0] ?? 0;
    if (initialOriginalIndex !== focusedIndexRef.current) {
      emitFocusedIndexChange('initial-sync', initialOriginalIndex);
      return;
    }

    // First open of the expanded carousel should land at the start of the
    // current column sort: ToC fully visible, first sorted topic selected.
    hasInitialScrollSyncRef.current = true;
    scrollToStart({ behavior: 'auto' });
  }, [clampedFocusedIndex, emitFocusedIndexChange, scrollToStart, sortedClusters.length]);

  // Scroll to focused cluster when sort mode changes
  const prevSortKeyRef = useRef(`${sortMode}:${sortDirection}`);
  useEffect(() => {
    const nextSortKey = `${sortMode}:${sortDirection}`;
    if (prevSortKeyRef.current !== nextSortKey) {
      prevSortKeyRef.current = nextSortKey;
      requestAnimationFrame(() => {
        scrollToColumn(sortedFocusedIndex, { reason: 'sort-change' });
      });
    }
  }, [sortDirection, sortMode, sortedFocusedIndex, scrollToColumn]);

  // ── Sidebar click handlers ──
  // TopicListSidebar passes sorted indices; we convert to original for data ops

  const handleListClusterClick = useCallback(
    (sortedIdx) => {
      pinToCAfterAction();
      const originalIdx = sortToOriginalRef.current[sortedIdx];
      recordFeedCarouselDebug('toc-cluster-click', {
        ...getClusterDebugMeta(originalIdx, sortedIdx),
        currentFocusedOriginal: focusedIndexRef.current,
      });
      if (originalIdx !== undefined && originalIdx !== focusedIndexRef.current) {
        emitFocusedIndexChange('toc-cluster-click', originalIdx);
      }
      scrollToColumn(sortedIdx, { reason: 'toc-cluster-click' });
    },
    [emitFocusedIndexChange, getClusterDebugMeta, pinToCAfterAction, scrollToColumn]
  );

  const handleListSubClusterClick = useCallback(
    (sortedIdx, subClusterId) => {
      pinToCAfterAction();
      const originalIdx = sortToOriginalRef.current[sortedIdx];
      recordFeedCarouselDebug('toc-subcluster-click', {
        ...getClusterDebugMeta(originalIdx, sortedIdx),
        subClusterId,
        currentFocusedOriginal: focusedIndexRef.current,
      });
      if (originalIdx !== undefined && originalIdx !== focusedIndexRef.current) {
        emitFocusedIndexChange('toc-subcluster-click', originalIdx, { subClusterId });
      }
      scrollToColumn(sortedIdx, { reason: 'toc-subcluster-click' });
      if (originalIdx !== undefined) {
        setSubClusterFilter(originalIdx, subClusterId);
      }
    },
    [emitFocusedIndexChange, getClusterDebugMeta, pinToCAfterAction, scrollToColumn, setSubClusterFilter]
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
    const distance = Math.abs(sortedIdx - visualSortedIndex);
    if (distance === 0) return 'focused';
    if (distance <= 2) return 'adjacent';
    return 'far';
  };

  const { visibleStart, visibleEnd, leadingSpacerWidth, trailingSpacerWidth } = useMemo(() => {
    if (!sortedClusters.length) return { visibleStart: 0, visibleEnd: 0, leadingSpacerWidth: 0, trailingSpacerWidth: 0 };
    const lastIndex = sortedClusters.length - 1;
    const windowStart = Math.max(0, visualSortedIndex - VISIBLE_COLUMN_RADIUS - 2);
    const windowEnd = Math.min(lastIndex, visualSortedIndex + VISIBLE_COLUMN_RADIUS + 2);

    const leadingCount = windowStart;
    const trailingCount = lastIndex - windowEnd;
    const calcSpacerWidth = (k) => k > 0 ? k * COLUMN_WIDTH + Math.max(0, k - 1) * GAP : 0;

    return {
      visibleStart: windowStart,
      visibleEnd: windowEnd,
      leadingSpacerWidth: calcSpacerWidth(leadingCount),
      trailingSpacerWidth: calcSpacerWidth(trailingCount),
    };
  }, [sortedClusters.length, visualSortedIndex]);

  visibleWindowRangeRef.current = {
    start: visibleStart,
    end: visibleEnd,
  };

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

  useLayoutEffect(() => {
    const pendingScroll = pendingColumnScrollRef.current;
    if (!pendingScroll) return;
    if (pendingScroll.sortedIndex < visibleStart || pendingScroll.sortedIndex > visibleEnd) return;

    pendingColumnScrollRef.current = null;
    performScrollToColumn(pendingScroll.sortedIndex, pendingScroll.options);
  }, [performScrollToColumn, visibleEnd, visibleStart]);

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
          containerRef={tocContainerRef}
          topLevelClusters={sortedClusters}
          focusedIndex={sortedFocusedIndex}
          onClickCluster={handleListClusterClick}
          onClickSubCluster={handleListSubClusterClick}
          sortMode={sortMode}
          onSortChange={handleSortChange}
          sortDirection={sortDirection}
          onSortDirectionToggle={handleSortDirectionToggle}
          isStickyShell={isToCStickyShell}
          isStickyVisible={isToCStickyVisible}
          onMouseEnter={handleToCMouseEnter}
          onMouseMove={handleToCMouseMove}
          onMouseLeave={handleToCMouseLeave}
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
          const distance = Math.abs(sortedIdx - visualSortedIndex);
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
            <div key={cluster.cluster} style={{ flexShrink: 0 }}>
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
            </div>
          );
        })}

        {/* Trailing spacer replaces omitted columns after window */}
        {trailingSpacerWidth > 0 && (
          <div style={{ width: trailingSpacerWidth, minWidth: trailingSpacerWidth, flexShrink: 0 }} aria-hidden="true" />
        )}
      </div>

      {/* Left-edge hover zone with visible tab indicator */}
      {!isToCStickyVisible && isListScrolledOff && (
        <div
          className={styles.hoverZone}
          onMouseEnter={revealToC}
        >
          <div className={styles.hoverTab}>
            <ChevronRight size={14} />
          </div>
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
