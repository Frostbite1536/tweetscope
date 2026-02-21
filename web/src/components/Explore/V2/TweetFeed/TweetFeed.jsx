import { useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';
import { useFilter } from '../../../../contexts/FilterContext';
import { useScope } from '../../../../contexts/ScopeContext';
import { groupRowsByThread } from '../../../../lib/groupRowsByThread';
import TweetCard from './TweetCard';
import ThreadGroup from './ThreadGroup';
import StandaloneWithAncestors from './StandaloneWithAncestors';
import styles from './TweetFeed.module.scss';

TweetFeed.propTypes = {
  dataset: PropTypes.object.isRequired,
  clusterMap: PropTypes.object,
  onHover: PropTypes.func,
  onClick: PropTypes.func,
  dateColumn: PropTypes.string,
  nodeStats: PropTypes.object,
  onViewThread: PropTypes.func,
  onViewQuotes: PropTypes.func,
};

function TweetFeed({
  dataset,
  clusterMap = {},
  onHover = () => {},
  onClick = () => {},
  dateColumn = null,
  nodeStats = null,
  onViewThread,
  onViewQuotes,
}) {
  const { scope } = useScope();
  const { dataTableRows, page, setPage, totalPages, loading, rowsLoading } = useFilter();

  const handleLoadMore = useCallback(() => {
    if (page < totalPages - 1 && !loading && !rowsLoading) {
      setPage((prev) => prev + 1);
    }
  }, [page, totalPages, loading, rowsLoading, setPage]);

  const hasMore = page < totalPages - 1;

  const groupedItems = useMemo(
    () => groupRowsByThread(dataTableRows, nodeStats),
    [dataTableRows, nodeStats]
  );

  if (!dataTableRows || dataTableRows.length === 0) {
    return (
      <div className={styles.tweetFeedContainer}>
        <div className={styles.emptyState}>
          {loading ? 'Loading...' : 'No data to display'}
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.tweetFeedContainer} ${loading ? styles.loading : ''}`}>
      {loading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingSpinner}></div>
        </div>
      )}

      <div className={styles.tweetList}>
        {groupedItems.map((item) => {
          if (item.type === 'thread') {
            return (
              <ThreadGroup
                key={`thread-${item.threadRootId}`}
                rows={item.rows}
                threadRootId={item.threadRootId}
                textColumn={dataset.text_column}
                dateColumn={dateColumn}
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
              />
            );
          }
          const row = item.row;
          if (item.hasMissingAncestors) {
            return (
              <StandaloneWithAncestors
                key={row.ls_index}
                row={row}
                textColumn={dataset.text_column}
                dateColumn={dateColumn}
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
          const clusterInfo = clusterMap[row.ls_index];

          return (
            <TweetCard
              key={row.ls_index}
              row={row}
              textColumn={dataset.text_column}
              dateColumn={dateColumn}
              clusterInfo={clusterInfo}
              onHover={onHover}
              onClick={onClick}
              nodeStats={nodeStats?.get(row.ls_index)}
              onViewThread={onViewThread}
              onViewQuotes={onViewQuotes}
            />
          );
        })}
      </div>

      {hasMore && (
        <button
          className={styles.loadMoreBtn}
          onClick={handleLoadMore}
          disabled={rowsLoading}
        >
          {rowsLoading ? 'Loading...' : 'Load More'}
        </button>
      )}
    </div>
  );
}

export default TweetFeed;
