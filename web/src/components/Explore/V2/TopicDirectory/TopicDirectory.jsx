import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useDeferredValue,
  memo,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, ChevronDown, LayoutGrid, GalleryHorizontalEnd } from 'lucide-react';
import { useScope } from '../../../../contexts/ScopeContext';
import { sortClusterItems } from '../../../../lib/sortClusters';
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
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const hasFeedOpen = selectedClusterIndex != null;
  const selectedCluster = hasFeedOpen ? topLevelClusters[selectedClusterIndex] : null;

  // Separate, sort, and extract unclustered in one pass
  const { sortedClusters, unclustered } = useMemo(() => {
    const items = topLevelClusters.map((c, i) => ({ cluster: c, originalIndex: i }));
    const result = sortClusterItems(items, sortMode);
    // sortedItems excludes unclustered (it's appended at end but also returned separately)
    const sorted = result.sortedItems.filter(
      (item) => String(item.cluster.cluster) !== 'unknown'
    );
    return { sortedClusters: sorted, unclustered: result.unclustered };
  }, [topLevelClusters, sortMode]);

  // Filter clusters by search
  const filteredClusters = useMemo(() => {
    if (!deferredSearchQuery.trim()) return sortedClusters;
    const q = deferredSearchQuery.toLowerCase().trim();
    return sortedClusters.filter(({ cluster }) => {
      const labelMatch = cluster.label?.toLowerCase().includes(q);
      const descMatch = cluster.description?.toLowerCase().includes(q);
      const subMatch = cluster.children?.some((sub) =>
        sub.label?.toLowerCase().includes(q)
      );
      return labelMatch || descMatch || subMatch;
    });
  }, [deferredSearchQuery, sortedClusters]);

  const filteredUnclustered = useMemo(() => {
    if (!unclustered) return null;
    if (!deferredSearchQuery.trim()) return unclustered;
    const q = deferredSearchQuery.toLowerCase().trim();
    const cluster = unclustered.cluster;
    const labelMatch = cluster.label?.toLowerCase().includes(q);
    const descMatch = cluster.description?.toLowerCase().includes(q);
    return labelMatch || descMatch ? unclustered : null;
  }, [deferredSearchQuery, unclustered]);

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
          <div className={styles.list}>
            {filteredClusters.map(({ cluster, originalIndex }) => (
              <TopicCard
                key={cluster.cluster}
                ref={originalIndex === selectedClusterIndex ? activeCardRef : undefined}
                cluster={cluster}
                isActive={originalIndex === selectedClusterIndex}
                onClick={() => handleCardClick(originalIndex)}
                clusterColor={getClusterColor(cluster.cluster)}
                sortMode={sortMode}
              />
            ))}

            {/* Unclustered at bottom */}
            {filteredUnclustered && (
              <TopicCard
                ref={filteredUnclustered.originalIndex === selectedClusterIndex ? activeCardRef : undefined}
                cluster={filteredUnclustered.cluster}
                isActive={filteredUnclustered.originalIndex === selectedClusterIndex}
                isUnclustered
                onClick={() => handleCardClick(filteredUnclustered.originalIndex)}
              />
            )}
          </div>

          {/* Footer */}
          <div className={styles.footer}>
            {sortedClusters.length} topics &middot; {totalTweets.toLocaleString()} tweets
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
