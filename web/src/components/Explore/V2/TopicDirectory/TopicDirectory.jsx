import { useState, useCallback, useMemo, useEffect, useRef, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, ChevronDown, LayoutGrid, GalleryHorizontalEnd } from 'lucide-react';
import { useScope } from '../../../../contexts/ScopeContext';
import { useClusterColors, resolveClusterColorCSS } from '../../../../hooks/useClusterColors';
import { useColorMode } from '../../../../hooks/useColorMode';
import TopicCard from './TopicCard';
import TopicFeedPanel from './TopicFeedPanel';
import styles from './TopicDirectory.module.scss';

function TopicDirectory({
  topLevelClusters,
  feedData,
  loadMore,
  activeSubCluster,
  setSubClusterFilter,
  selectedClusterIndex,
  onSelectCluster,
  onBack,
  dataset,
  clusterMap,
  nodeStats,
  onHover,
  onClick,
  onViewThread,
  onViewQuotes,
  expandedView,
  onToggleView,
}) {
  const { clusterLabels, clusterHierarchy } = useScope();
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);
  const { isDark } = useColorMode();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState('popular');
  const searchRef = useRef(null);
  const activeCardRef = useRef(null);

  const hasFeedOpen = selectedClusterIndex != null;
  const selectedCluster = hasFeedOpen ? topLevelClusters[selectedClusterIndex] : null;

  // Separate unclustered from real clusters
  const { realClusters, unclustered } = useMemo(() => {
    const real = [];
    let unc = null;
    topLevelClusters.forEach((c, i) => {
      if (String(c.cluster) === 'unknown') {
        unc = { cluster: c, index: i };
      } else {
        real.push({ cluster: c, index: i });
      }
    });
    return { realClusters: real, unclustered: unc };
  }, [topLevelClusters]);

  // Sort clusters
  const sortedClusters = useMemo(() => {
    const items = [...realClusters];
    switch (sortMode) {
      case 'similar': {
        // Angle sort: compute angle of each centroid relative to global center
        const withCentroids = items.filter(
          ({ cluster }) => cluster.centroid_x != null && cluster.centroid_y != null
        );
        const noCentroids = items.filter(
          ({ cluster }) => cluster.centroid_x == null || cluster.centroid_y == null
        );
        if (withCentroids.length > 0) {
          const cx =
            withCentroids.reduce((s, { cluster }) => s + cluster.centroid_x, 0) /
            withCentroids.length;
          const cy =
            withCentroids.reduce((s, { cluster }) => s + cluster.centroid_y, 0) /
            withCentroids.length;
          withCentroids.sort(
            (a, b) =>
              Math.atan2(a.cluster.centroid_y - cy, a.cluster.centroid_x - cx) -
              Math.atan2(b.cluster.centroid_y - cy, b.cluster.centroid_x - cx)
          );
          return [...withCentroids, ...noCentroids];
        }
        return items;
      }
      case 'largest':
        return items.sort(
          (a, b) =>
            (b.cluster.cumulativeCount || b.cluster.count || 0) -
            (a.cluster.cumulativeCount || a.cluster.count || 0)
        );
      case 'az':
        return items.sort((a, b) =>
          (a.cluster.label || '').localeCompare(b.cluster.label || '')
        );
      case 'popular':
      default:
        return items.sort(
          (a, b) =>
            (b.cluster.cumulativeLikes || 0) - (a.cluster.cumulativeLikes || 0)
        );
    }
  }, [realClusters, sortMode]);

  // Filter clusters by search
  const filteredClusters = useMemo(() => {
    if (!searchQuery.trim()) return sortedClusters;
    const q = searchQuery.toLowerCase().trim();
    return sortedClusters.filter(({ cluster }) => {
      const labelMatch = cluster.label?.toLowerCase().includes(q);
      const descMatch = cluster.description?.toLowerCase().includes(q);
      const subMatch = cluster.children?.some((sub) =>
        sub.label?.toLowerCase().includes(q)
      );
      return labelMatch || descMatch || subMatch;
    });
  }, [realClusters, searchQuery]);

  const matchingIndices = useMemo(() => {
    if (!searchQuery.trim()) return null; // null = no filter active
    return new Set(filteredClusters.map(({ index }) => index));
  }, [filteredClusters, searchQuery]);

  // Auto-scroll active card into view
  useEffect(() => {
    if (activeCardRef.current) {
      activeCardRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedClusterIndex]);

  // Keyboard: "/" to focus search, Escape to close feed
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        if (document.activeElement === searchRef.current) {
          setSearchQuery('');
          searchRef.current.blur();
        } else if (hasFeedOpen) {
          onSelectCluster(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasFeedOpen, onSelectCluster]);

  const getClusterColor = useCallback(
    (clusterId) => resolveClusterColorCSS(colorMap, clusterId, isDark),
    [colorMap, isDark]
  );

  const handleCardClick = useCallback(
    (index) => {
      onSelectCluster(index);
    },
    [onSelectCluster]
  );

  const handleCloseFeed = useCallback(() => {
    onSelectCluster(null);
  }, [onSelectCluster]);

  // Count stats
  const totalTweets = useMemo(() => {
    return topLevelClusters.reduce((sum, c) => sum + (c.cumulativeCount || c.count || 0), 0);
  }, [topLevelClusters]);

  return (
    <div className={styles.container}>
      {/* Top bar */}
      <div className={styles.topBar}>
        <div className={styles.topBarRight}>
          <div className={styles.searchWrap}>
            <Search size={14} className={styles.searchIcon} />
            <input
              ref={searchRef}
              type="text"
              className={styles.searchInput}
              placeholder="Search topics..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className={styles.searchClear}
                onClick={() => setSearchQuery('')}
              >
                &times;
              </button>
            )}
          </div>
          <div className={styles.sortWrap}>
            <select
              className={styles.sortSelect}
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value)}
            >
              <option value="popular">Most popular</option>
              <option value="similar">By similarity</option>
              <option value="largest">Most tweets</option>
              <option value="az">A–Z</option>
            </select>
            <ChevronDown size={12} className={styles.sortIcon} />
          </div>
          {onToggleView && (
            <div className={styles.viewToggle}>
              <button
                className={`${styles.viewToggleBtn} ${expandedView === 'directory' ? styles.viewToggleActive : ''}`}
                onClick={() => onToggleView('directory')}
                title="Topic directory"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                className={`${styles.viewToggleBtn} ${expandedView === 'carousel' ? styles.viewToggleActive : ''}`}
                onClick={() => onToggleView('carousel')}
                title="Feed carousel"
              >
                <GalleryHorizontalEnd size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main content: directory + optional feed panel */}
      <div className={`${styles.main} ${hasFeedOpen ? styles.split : ''}`}>
        {/* Directory pane */}
        <div className={styles.directory}>
          <div className={styles.grid}>
            {sortedClusters.map(({ cluster, index }) => {
              const isFiltered = matchingIndices !== null && !matchingIndices.has(index);
              return (
                <div
                  key={cluster.cluster}
                  ref={index === selectedClusterIndex ? activeCardRef : undefined}
                  className={`${styles.cardWrap} ${isFiltered ? styles.filtered : ''}`}
                >
                  <TopicCard
                    cluster={cluster}
                    isActive={index === selectedClusterIndex}
                    onClick={() => handleCardClick(index)}
                    clusterColor={getClusterColor(cluster.cluster)}
                    sortMode={sortMode}
                  />
                </div>
              );
            })}

            {/* Unclustered at bottom */}
            {unclustered && (
              <div
                className={`${styles.cardWrap} ${styles.unclusteredWrap}`}
                ref={unclustered.index === selectedClusterIndex ? activeCardRef : undefined}
              >
                <TopicCard
                  cluster={unclustered.cluster}
                  isActive={unclustered.index === selectedClusterIndex}
                  isUnclustered
                  onClick={() => handleCardClick(unclustered.index)}
                />
              </div>
            )}
          </div>

          {/* Footer */}
          <div className={styles.footer}>
            {realClusters.length} topics &middot; {totalTweets.toLocaleString()} tweets
          </div>
        </div>

        {/* Feed panel */}
        <AnimatePresence mode="wait">
          {hasFeedOpen && selectedCluster && (
            <motion.div
              key="feed-panel"
              className={styles.feedPane}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <TopicFeedPanel
                cluster={selectedCluster}
                tweets={feedData.rows}
                loading={feedData.loading}
                hasMore={feedData.hasMore}
                onLoadMore={loadMore}
                subClusters={selectedCluster.children}
                activeSubCluster={activeSubCluster}
                onSubClusterSelect={setSubClusterFilter}
                dataset={dataset}
                clusterMap={clusterMap}
                nodeStats={nodeStats}
                onHover={onHover}
                onClick={onClick}
                onViewThread={onViewThread}
                onViewQuotes={onViewQuotes}
                onClose={handleCloseFeed}
                clusterColor={getClusterColor(selectedCluster.cluster)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default memo(TopicDirectory);
