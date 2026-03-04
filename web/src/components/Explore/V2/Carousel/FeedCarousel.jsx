import { useState, useRef, useCallback, useEffect, useMemo, memo } from 'react';
import { motion } from 'framer-motion';
import CarouselTOC from './CarouselTOC';
import FeedColumn from './FeedColumn';
import ThreadOverlay from './ThreadOverlay';
import styles from './FeedCarousel.module.scss';

const COLUMN_WIDTH = 550;
const GAP = 32;
const TOC_WIDTH = 280;
const PADDING_LEFT = 32;
const VISIBLE_COLUMN_RADIUS = 3;

// Hoisted to avoid new object refs on every render
const MOTION_INITIAL = { opacity: 0, y: 20 };
const MOTION_ANIMATE = { opacity: 1, y: 0 };
const MOTION_TRANSITION = { duration: 0.25 };
const MOTION_STYLE = { flexShrink: 0 };

const getSpacerWidth = () => {
  const targetStart = (window.innerWidth - COLUMN_WIDTH) / 2;
  const currentStart = PADDING_LEFT + TOC_WIDTH + GAP;
  return Math.max(0, targetStart - currentStart);
};

function FeedCarousel({
  topLevelClusters,
  columnData,
  columnRowsMap,
  loadMore,
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
}) {
  const containerRef = useRef(null);
  const scrollRafRef = useRef(null);
  const latestScrollLeftRef = useRef(0);
  const normalizedFocusedIndex = Number.isFinite(focusedClusterIndex)
    ? Math.trunc(focusedClusterIndex)
    : 0;
  const clampedFocusedIndex = topLevelClusters.length > 0
    ? Math.min(Math.max(normalizedFocusedIndex, 0), topLevelClusters.length - 1)
    : 0;
  const focusedIndexRef = useRef(clampedFocusedIndex);
  focusedIndexRef.current = clampedFocusedIndex;
  const [spacerWidth, setSpacerWidth] = useState(getSpacerWidth());
  const [overlayTweetId, setOverlayTweetId] = useState(null);
  const [overlayLsIndex, setOverlayLsIndex] = useState(null);

  // Update spacer on resize
  useEffect(() => {
    const handleResize = () => setSpacerWidth(getSpacerWidth());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!topLevelClusters.length) return;
    if (normalizedFocusedIndex !== clampedFocusedIndex) {
      onFocusedIndexChange(clampedFocusedIndex);
    }
  }, [normalizedFocusedIndex, clampedFocusedIndex, onFocusedIndexChange, topLevelClusters.length]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    latestScrollLeftRef.current = containerRef.current.scrollLeft;
    if (scrollRafRef.current !== null) return;

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const scrollLeft = latestScrollLeftRef.current;

      // Find which column center is closest to viewport center
      const viewportCenter = window.innerWidth / 2;
      const contentBefore = PADDING_LEFT + TOC_WIDTH + GAP + spacerWidth;
      const effectiveWidth = COLUMN_WIDTH + GAP;

      let closestIndex = 0;
      let closestDistance = Infinity;

      for (let i = 0; i < topLevelClusters.length; i++) {
        const columnStart = contentBefore + i * effectiveWidth - scrollLeft;
        const columnCenter = columnStart + COLUMN_WIDTH / 2;
        const distance = Math.abs(columnCenter - viewportCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = i;
        }
      }

      if (closestIndex !== focusedIndexRef.current) {
        onFocusedIndexChange(closestIndex);
      }
    });
  }, [spacerWidth, topLevelClusters.length, onFocusedIndexChange]);

  const scrollToColumn = useCallback(
    (index) => {
      if (!containerRef.current) return;
      const contentBefore = PADDING_LEFT + TOC_WIDTH + GAP + spacerWidth;
      const effectiveWidth = COLUMN_WIDTH + GAP;
      const columnStart = contentBefore + index * effectiveWidth;
      const scrollTarget = columnStart - (window.innerWidth - COLUMN_WIDTH) / 2;
      containerRef.current.scrollTo({
        left: Math.max(0, scrollTarget),
        behavior: 'smooth',
      });
    },
    [spacerWidth]
  );

  const handleSubClusterClick = useCallback(
    (columnIndex, subClusterId) => {
      setSubClusterFilter(columnIndex, subClusterId);
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

  const getFocusState = (index) => {
    const distance = Math.abs(index - clampedFocusedIndex);
    if (distance === 0) return 'focused';
    if (distance <= 2) return 'adjacent';
    return 'far';
  };

  const { visibleStart, visibleEnd, leadingSpacerWidth, trailingSpacerWidth } = useMemo(() => {
    if (!topLevelClusters?.length) return { visibleStart: 0, visibleEnd: 0, leadingSpacerWidth: 0, trailingSpacerWidth: 0 };
    const lastIndex = topLevelClusters.length - 1;
    // Add buffer of 2 beyond visible radius for smoother scrolling
    const windowStart = Math.max(0, clampedFocusedIndex - VISIBLE_COLUMN_RADIUS - 2);
    const windowEnd = Math.min(lastIndex, clampedFocusedIndex + VISIBLE_COLUMN_RADIUS + 2);

    // Spacer width for k omitted columns: k * COLUMN_WIDTH + max(0, k - 1) * GAP
    const leadingCount = windowStart;
    const trailingCount = lastIndex - windowEnd;
    const calcSpacerWidth = (k) => k > 0 ? k * COLUMN_WIDTH + Math.max(0, k - 1) * GAP : 0;

    return {
      visibleStart: windowStart,
      visibleEnd: windowEnd,
      leadingSpacerWidth: calcSpacerWidth(leadingCount),
      trailingSpacerWidth: calcSpacerWidth(trailingCount),
    };
  }, [clampedFocusedIndex, topLevelClusters.length]);

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
        <CarouselTOC
          topLevelClusters={topLevelClusters}
          focusedIndex={clampedFocusedIndex}
          onClickCluster={scrollToColumn}
          onClickSubCluster={handleSubClusterClick}
        />

        {/* Spacer to center first feed */}
        <div className={styles.spacer} style={{ width: spacerWidth }} />

        {/* Leading spacer replaces omitted columns before window */}
        {leadingSpacerWidth > 0 && (
          <div style={{ width: leadingSpacerWidth, minWidth: leadingSpacerWidth, flexShrink: 0 }} aria-hidden="true" />
        )}

        {topLevelClusters.slice(visibleStart, visibleEnd + 1).map((cluster, i) => {
          const index = visibleStart + i;
          const col = columnData[index] || {};
          const tweets = columnRowsMap[index] || [];
          const distance = Math.abs(index - clampedFocusedIndex);
          const isInViewRadius = distance <= VISIBLE_COLUMN_RADIUS;

          if (!isInViewRadius) {
            // Buffer zone: render lightweight placeholder
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
                columnIndex={index}
                cluster={cluster}
                tweets={tweets}
                focusState={getFocusState(index)}
                columnWidth={COLUMN_WIDTH}
                subClusters={cluster.children}
                activeSubCluster={activeSubClusters[index] || null}
                onSubClusterSelect={handleSubClusterClick}
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

export default memo(FeedCarousel);
