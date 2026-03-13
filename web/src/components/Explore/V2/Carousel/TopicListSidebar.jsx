import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useDeferredValue,
  memo,
} from 'react';
import PropTypes from 'prop-types';
import { Search, ChevronDown, ArrowDownNarrowWide, ArrowUpNarrowWide } from 'lucide-react';
import { useScope } from '../../../../contexts/ScopeContext';
import { useClusterColors, resolveClusterColorCSS } from '../../../../hooks/useClusterColors';
import { useColorMode } from '../../../../hooks/useColorMode';
import { recordFeedCarouselDebug } from '../../../../lib/feedCarouselDebug';
import SubNav from '../../../SubNav';
import TopicCard from '../TopicDirectory/TopicCard';
import styles from './TopicListSidebar.module.scss';

function TopicListSidebar({
  containerRef,
  topLevelClusters,
  focusedIndex,
  onClickCluster,
  onClickSubCluster,
  sortMode,
  onSortChange,
  sortDirection = 'desc',
  onSortDirectionToggle,
  disableKeyboardShortcuts = false,
  isStickyShell = false,
  isStickyVisible = false,
  onMouseEnter,
  onMouseMove,
  onMouseLeave,
  subNavProps,
}) {
  const { clusterLabels, clusterHierarchy } = useScope();
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);
  const { isDark } = useColorMode();
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const activeCardRef = useRef(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // Build indexed list, identifying unclustered for styling
  const clustersWithIndex = useMemo(() => {
    return topLevelClusters.map((c, i) => ({
      cluster: c,
      index: i,
      isUnclustered: String(c.cluster) === 'unknown',
    }));
  }, [topLevelClusters]);

  // Separate for footer count (exclude unclustered)
  const realCount = useMemo(() => {
    return clustersWithIndex.filter((c) => !c.isUnclustered).length;
  }, [clustersWithIndex]);

  // Filter by search (search only affects the list, not columns)
  const filteredClusters = useMemo(() => {
    if (!deferredSearchQuery.trim()) return clustersWithIndex;
    const q = deferredSearchQuery.toLowerCase().trim();
    return clustersWithIndex.filter(({ cluster }) => {
      const labelMatch = cluster.label?.toLowerCase().includes(q);
      const descMatch = cluster.description?.toLowerCase().includes(q);
      const subMatch = cluster.children?.some((sub) =>
        sub.label?.toLowerCase().includes(q)
      );
      return labelMatch || descMatch || subMatch;
    });
  }, [deferredSearchQuery, clustersWithIndex]);

  // Auto-scroll active card into view — scoped to the list container
  // so it doesn't bubble up and scroll the parent carousel
  useEffect(() => {
    const card = activeCardRef.current;
    const list = listRef.current;
    if (!card || !list) return;

    const cardRect = card.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const startingScrollTop = list.scrollTop;

    if (cardRect.top < listRect.top) {
      list.scrollTop += cardRect.top - listRect.top;
      recordFeedCarouselDebug('toc-vertical-autoscroll', {
        direction: 'up',
        focusedIndex,
        label: topLevelClusters[focusedIndex]?.label ?? null,
        fromScrollTop: startingScrollTop,
        toScrollTop: list.scrollTop,
      });
    } else if (cardRect.bottom > listRect.bottom) {
      list.scrollTop += cardRect.bottom - listRect.bottom;
      recordFeedCarouselDebug('toc-vertical-autoscroll', {
        direction: 'down',
        focusedIndex,
        label: topLevelClusters[focusedIndex]?.label ?? null,
        fromScrollTop: startingScrollTop,
        toScrollTop: list.scrollTop,
      });
    }
  }, [focusedIndex, topLevelClusters]);

  // Keyboard: "/" to focus search, Escape to clear
  // Disabled for overlay instance to avoid duplicate global listeners
  useEffect(() => {
    if (disableKeyboardShortcuts) return;
    const handleKeyDown = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearchQuery('');
        searchRef.current.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [disableKeyboardShortcuts]);

  const getClusterColor = useCallback(
    (clusterId) => resolveClusterColorCSS(colorMap, clusterId, isDark),
    [colorMap, isDark]
  );

  const handleCardClick = useCallback(
    (index) => {
      onClickCluster(index);
    },
    [onClickCluster]
  );

  const handleSubClusterClick = useCallback(
    (index, subClusterId) => {
      onClickSubCluster?.(index, subClusterId);
    },
    [onClickSubCluster]
  );

  // Count stats
  const totalTweets = useMemo(() => {
    return topLevelClusters.reduce((sum, c) => sum + (c.cumulativeCount || c.count || 0), 0);
  }, [topLevelClusters]);

  if (!topLevelClusters?.length) return null;

  return (
    <div
      ref={containerRef}
      className={[
        styles.container,
        isStickyShell ? styles.stickyShell : '',
        isStickyVisible ? styles.stickyVisible : '',
      ].filter(Boolean).join(' ')}
      onMouseEnter={onMouseEnter}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {subNavProps && <SubNav {...subNavProps} embedded />}

      {/* Top bar with search + sort */}
      <div className={styles.topBar}>
        <div className={styles.controlsRow}>
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
            <button
              type="button"
              className={styles.sortDirectionButton}
              onClick={onSortDirectionToggle}
              title={sortDirection === 'desc' ? 'Descending' : 'Ascending'}
            >
              {sortDirection === 'desc' ? <ArrowDownNarrowWide size={13} /> : <ArrowUpNarrowWide size={13} />}
            </button>
            <div className={styles.sortSelectWrap}>
              <select
                className={styles.sortSelect}
                value={sortMode}
                onChange={(e) => onSortChange(e.target.value)}
              >
                <option value="popular">Popular</option>
                <option value="similar">Similarity</option>
                <option value="largest">Tweets</option>
                <option value="az">Alphabetical</option>
              </select>
              <ChevronDown size={12} className={styles.sortIcon} />
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable list */}
      <div ref={listRef} className={styles.list}>
        {filteredClusters.map(({ cluster, index, isUnclustered }) => {
          const isActive = index === focusedIndex;
          return (
            <div key={cluster.cluster}>
              <TopicCard
                ref={isActive ? activeCardRef : undefined}
                cluster={cluster}
                isActive={isActive}
                isUnclustered={isUnclustered}
                onClick={() => handleCardClick(index)}
                clusterColor={isUnclustered ? undefined : getClusterColor(cluster.cluster)}
                sortMode={sortMode}
                isExpanded={!isUnclustered && Boolean(cluster.children?.length)}
                onClickSubCluster={!isUnclustered ? (subId) => handleSubClusterClick(index, subId) : undefined}
              />
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        {realCount} topics &middot; {totalTweets.toLocaleString()} tweets
      </div>
    </div>
  );
}

TopicListSidebar.propTypes = {
  containerRef: PropTypes.oneOfType([
    PropTypes.func,
    PropTypes.shape({ current: PropTypes.any }),
  ]),
  topLevelClusters: PropTypes.array.isRequired,
  focusedIndex: PropTypes.number,
  onClickCluster: PropTypes.func.isRequired,
  onClickSubCluster: PropTypes.func,
  sortMode: PropTypes.string.isRequired,
  onSortChange: PropTypes.func.isRequired,
  sortDirection: PropTypes.oneOf(['asc', 'desc']),
  onSortDirectionToggle: PropTypes.func,
  disableKeyboardShortcuts: PropTypes.bool,
  isStickyShell: PropTypes.bool,
  isStickyVisible: PropTypes.bool,
  onMouseEnter: PropTypes.func,
  onMouseMove: PropTypes.func,
  onMouseLeave: PropTypes.func,
  subNavProps: PropTypes.shape({
    dataset: PropTypes.object,
    scope: PropTypes.object,
    scopes: PropTypes.array,
    onScopeChange: PropTypes.func,
    onBack: PropTypes.func,
  }),
};

export default memo(TopicListSidebar);
