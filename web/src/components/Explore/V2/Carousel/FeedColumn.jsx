import { useState, useCallback, useMemo, memo } from 'react';
import { groupRowsByThread } from '../../../../lib/groupRowsByThread';
import { useHoveredIndex } from '../../../../contexts/HoverContext';
import { useScope } from '../../../../contexts/ScopeContext';
import TweetCard from '../TweetFeed/TweetCard';
import ThreadGroup from '../TweetFeed/ThreadGroup';
import StandaloneWithAncestors from '../TweetFeed/StandaloneWithAncestors';
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
  nodeStats,
  onViewThread,
  onViewQuotes,
}) {
  const { scope } = useScope();
  const [descExpanded, setDescExpanded] = useState(false);

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
      className={`${styles.columnOuter} ${styles[focusState]}`}
      style={{ width: columnWidth, minWidth: columnWidth }}
    >
      <div className={styles.columnHeader}>
        <div className={styles.columnHeaderTop}>
          <h3 className={styles.clusterLabel}>{cluster?.label}</h3>
          {cluster?.count > 0 && (
            <span className={styles.clusterCount}>{cluster.count} tweets</span>
          )}
        </div>
        {cluster?.description && (
          <div className={styles.descriptionWrap}>
            <p className={`${styles.descText} ${descExpanded ? styles.expanded : ''}`}>
              {cluster.description}
            </p>
            {cluster.description.length > 120 && (
              <button
                className={styles.moreBtn}
                onClick={() => setDescExpanded((v) => !v)}
              >
                {descExpanded ? 'less' : 'more'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className={styles.column}>
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
                  onViewThread={onViewThread}
                  onViewQuotes={onViewQuotes}
                  hasMissingAncestors={item.hasMissingAncestors}
                  missingAncestorCount={item.missingAncestorCount}
                  globalThreadSize={item.globalThreadSize}
                  visibleCount={item.visibleCount}
                  borderless
                />
              );
            }
            const row = item.row;
            if (item.hasMissingAncestors) {
              return (
                <StandaloneWithAncestors
                  key={row.ls_index ?? row.index}
                  row={row}
                  textColumn={dataset?.text_column}
                  clusterMap={clusterMap}
                  nodeStats={nodeStats}
                  onHover={onHover}
                  onClick={onClick}
                  onViewThread={onViewThread}
                  onViewQuotes={onViewQuotes}
                  datasetId={dataset?.id}
                  scopeId={scope?.id}
                  dataset={dataset}
                />
              );
            }
            return (
              <TweetCard
                key={row.ls_index ?? row.index}
                row={row}
                textColumn={dataset?.text_column}
                clusterInfo={clusterMap?.[row.ls_index]}
                onHover={onHover}
                onClick={onClick}
                nodeStats={nodeStats?.get(row.ls_index)}
                onViewThread={onViewThread}
                onViewQuotes={onViewQuotes}
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

          {!loading && tweets.length === 0 && !hasMore && (
            <div className={styles.emptyState}>No tweets in this cluster</div>
          )}

          {!loading && tweets.length === 0 && hasMore && (
            <div className={styles.emptyState}>Loading tweets...</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(FeedColumn);
