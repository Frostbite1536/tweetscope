import { useMemo, useCallback, memo } from 'react';
import { X } from 'lucide-react';
import { groupRowsByThread } from '../../../../lib/groupRowsByThread';
import TweetCard from '../TweetFeed/TweetCard';
import ThreadGroup from '../TweetFeed/ThreadGroup';
import StandaloneWithAncestors from '../TweetFeed/StandaloneWithAncestors';
import SubClusterPills from '../Carousel/SubClusterPills';
import { useScope } from '../../../../contexts/ScopeContext';
import styles from './TopicFeedPanel.module.scss';

function TopicFeedPanel({
  cluster,
  tweets,
  loading,
  hasMore,
  onLoadMore,
  subClusters,
  activeSubCluster,
  onSubClusterSelect,
  dataset,
  clusterMap,
  nodeStats,
  onHover,
  onClick,
  onViewThread,
  onViewQuotes,
  onClose,
  clusterColor,
}) {
  const { scope } = useScope();

  const groupedItems = useMemo(
    () => groupRowsByThread(tweets, nodeStats),
    [tweets, nodeStats]
  );

  const handleSelectSubCluster = useCallback(
    (subClusterId) => {
      if (onSubClusterSelect) onSubClusterSelect(subClusterId);
    },
    [onSubClusterSelect]
  );

  if (!cluster) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.header} style={{ '--panel-color': clusterColor || 'transparent' }}>
        <div className={styles.headerTop}>
          <h2 className={styles.title}>{cluster.label}</h2>
          <span className={styles.count}>{cluster.cumulativeCount || cluster.count || 0} tweets</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close feed panel">
            <X size={16} />
          </button>
        </div>
        {cluster.description && (
          <p className={styles.description}>{cluster.description}</p>
        )}
        <SubClusterPills
          subClusters={subClusters}
          activeSubCluster={activeSubCluster}
          onSelect={handleSelectSubCluster}
        />
      </div>

      <div className={styles.feed}>
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
          <button className={styles.loadMoreBtn} onClick={onLoadMore}>
            Load more
          </button>
        )}

        {!loading && tweets.length === 0 && (
          <div className={styles.emptyState}>No tweets in this topic</div>
        )}
      </div>
    </div>
  );
}

export default memo(TopicFeedPanel);
