import { useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';
import { useFilter } from '../../../../contexts/FilterContext';
import { groupRowsByThread } from '../../../../lib/groupRowsByThread';
import TweetCard from './TweetCard';
import ThreadGroup from './ThreadGroup';
import styles from './TweetFeed.module.scss';

TweetFeed.propTypes = {
  dataset: PropTypes.object.isRequired,
  distanceMap: PropTypes.instanceOf(Map),
  clusterMap: PropTypes.object,
  sae_id: PropTypes.string,
  onHover: PropTypes.func,
  onClick: PropTypes.func,
  hoveredIndex: PropTypes.number,
  dateColumn: PropTypes.string,
  nodeStats: PropTypes.object,
  onViewThread: PropTypes.func,
  onViewQuotes: PropTypes.func,
};

function TweetFeed({
  dataset,
  distanceMap,
  clusterMap = {},
  sae_id = null,
  onHover = () => {},
  onClick = () => {},
  hoveredIndex = null,
  dateColumn = null,
  nodeStats = null,
  onViewThread,
  onViewQuotes,
}) {
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
                distanceMap={distanceMap}
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
          const clusterInfo = clusterMap[row.ls_index];
          const similarity = distanceMap?.has(row.ls_index)
            ? 1 - distanceMap.get(row.ls_index)
            : undefined;
          const isHighlighted = hoveredIndex === row.ls_index;

          return (
            <TweetCard
              key={row.ls_index}
              row={row}
              textColumn={dataset.text_column}
              dateColumn={dateColumn}
              clusterInfo={clusterInfo}
              similarity={similarity}
              isHighlighted={isHighlighted}
              onHover={onHover}
              onClick={onClick}
              showFeatures={!!sae_id}
              nodeStats={nodeStats?.get(row.ls_index)}
              onViewThread={onViewThread ? () => onViewThread(row.ls_index) : undefined}
              onViewQuotes={onViewQuotes ? () => onViewQuotes(row.ls_index) : undefined}
              isReplyToMissing={item.hasMissingAncestors}
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
