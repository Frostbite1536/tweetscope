import { useCallback, useMemo, memo } from 'react';
import { groupRowsByThread } from '../../../../lib/groupRowsByThread';
import TweetCard from '../TweetFeed/TweetCard';
import ThreadGroup from '../TweetFeed/ThreadGroup';
import SubClusterPills from './SubClusterPills';
import styles from './FeedColumn.module.scss';

function FeedColumn({
  columnIndex,
  cluster,
  tweets,
  focusState,
  columnWidth,
  subClusters,
  activeSubCluster,
  onSubClusterSelect,
  dataset,
  clusterMap,
  loading,
  hasMore,
  onLoadMore,
  onHover,
  onClick,
  hoveredIndex,
  nodeStats,
  onViewThread,
  onViewQuotes,
}) {
  const handleLoadMore = useCallback(() => {
    if (onLoadMore) onLoadMore(columnIndex);
  }, [onLoadMore, columnIndex]);

  const handleSelectSubCluster = useCallback(
    (subClusterId) => {
      if (onSubClusterSelect) onSubClusterSelect(columnIndex, subClusterId);
    },
    [onSubClusterSelect, columnIndex]
  );

  const groupedItems = useMemo(
    () => groupRowsByThread(tweets, nodeStats),
    [tweets, nodeStats]
  );

  return (
    <div
      className={`${styles.column} ${styles[focusState]}`}
      style={{ width: columnWidth, minWidth: columnWidth }}
    >
      <div className={styles.columnHeader}>
        <h3 className={styles.clusterLabel}>{cluster?.label}</h3>
        {cluster?.count > 0 && (
          <span className={styles.clusterCount}>{cluster.count} tweets</span>
        )}
      </div>

      <SubClusterPills
        subClusters={subClusters}
        activeSubCluster={activeSubCluster}
        onSelect={handleSelectSubCluster}
      />

      <div className={styles.tweetScroll}>
        {groupedItems.map((item) => {
          if (item.type === 'thread') {
            return (
              <ThreadGroup
                key={`thread-${item.threadRootId}`}
                rows={item.rows}
                threadRootId={item.threadRootId}
                textColumn={dataset?.text_column}
                clusterMap={clusterMap}
                nodeStats={nodeStats}
                onHover={onHover}
                onClick={onClick}
                hoveredIndex={hoveredIndex}
                onViewThread={onViewThread}
                onViewQuotes={onViewQuotes}
                hasMissingAncestors={item.hasMissingAncestors}
                missingAncestorCount={item.missingAncestorCount}
              />
            );
          }
          const row = item.row;
          return (
            <TweetCard
              key={row.ls_index ?? row.index}
              row={row}
              textColumn={dataset?.text_column}
              clusterInfo={clusterMap?.[row.ls_index]}
              isHighlighted={hoveredIndex === row.ls_index}
              onHover={onHover}
              onClick={onClick}
              nodeStats={nodeStats?.get(row.ls_index)}
              onViewThread={onViewThread ? () => onViewThread(row.ls_index) : undefined}
              onViewQuotes={onViewQuotes ? () => onViewQuotes(row.ls_index) : undefined}
              isReplyToMissing={item.hasMissingAncestors}
            />
          );
        })}

        {loading && (
          <div className={styles.loadingRow}>
            <div className={styles.spinner} />
          </div>
        )}

        {hasMore && !loading && (
          <button className={styles.loadMoreBtn} onClick={handleLoadMore}>
            Load more
          </button>
        )}

        {!loading && tweets.length === 0 && (
          <div className={styles.emptyState}>No tweets in this cluster</div>
        )}
      </div>
    </div>
  );
}

export default memo(FeedColumn);
