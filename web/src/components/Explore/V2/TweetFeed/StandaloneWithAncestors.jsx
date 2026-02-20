import { useState, useCallback, memo } from 'react';
import { X, Loader2, CornerLeftUp } from 'lucide-react';
import useThreadData from '../../../../hooks/useThreadData';
import ThreadNode from '../ThreadView/ThreadNode';
import TweetCard from './TweetCard';
import styles from './StandaloneWithAncestors.module.scss';

/**
 * Wraps a standalone TweetCard that has missing ancestors.
 *
 * Collapsed: TweetCard shows "↰ Replying to earlier tweet" line (via isReplyToMissing).
 * Expanded:  Ancestors render above the TweetCard. A "× Replying to earlier tweet"
 *            line sits above the ancestors as the collapse toggle (same style, same text).
 *            The line inside TweetCard disappears.
 */
function StandaloneWithAncestors({
  row,
  textColumn,
  dateColumn,
  clusterMap,
  nodeStats,
  onHover,
  onClick,
  onViewThread,
  onViewQuotes,
  datasetId,
  scopeId,
  dataset,
}) {
  const [ancestorsExpanded, setAncestorsExpanded] = useState(false);

  const stats = nodeStats?.get(row.ls_index);
  const tweetId = stats?.tweetId;

  const {
    parentChain,
    loading,
    error,
  } = useThreadData(datasetId, scopeId, tweetId, row.ls_index, ancestorsExpanded, { descLimit: 0 });

  const handleExpand = useCallback(() => {
    setAncestorsExpanded(true);
  }, []);

  const handleCollapse = useCallback(() => {
    setAncestorsExpanded(false);
  }, []);

  // Not expanded — plain TweetCard with "Replying to earlier tweet" trigger
  if (!ancestorsExpanded) {
    return (
      <TweetCard
        row={row}
        textColumn={textColumn}
        dateColumn={dateColumn}
        clusterInfo={clusterMap?.[row.ls_index]}
        onHover={onHover}
        onClick={onClick}
        nodeStats={stats}
        onViewThread={onViewThread}
        onViewQuotes={onViewQuotes}
        isReplyToMissing
        onExpandAncestors={handleExpand}
      />
    );
  }

  // Expanded — collapse line above, ancestors, then TweetCard (no isReplyToMissing)
  return (
    <div className={styles.wrapper}>
      {/* Collapse toggle — inverse of "Replying to earlier tweet" */}
      <button
        className={styles.collapseLine}
        onClick={handleCollapse}
        type="button"
      >
        <X size={11} />
        <span>
          {loading
            ? 'Loading...'
            : `Hide earlier tweet${parentChain.length === 1 ? '' : 's'}`}
        </span>
      </button>

      {/* Ancestor section */}
      <div className={styles.ancestorSection}>
        {loading && (
          <div className={styles.loadingState}>
            <Loader2 size={14} className={styles.spinIcon} />
            <span>Loading...</span>
          </div>
        )}

        {error && !loading && (
          <div className={styles.errorState}>Failed to load ancestors</div>
        )}

        {!loading && !error && parentChain.length > 0 && (
          <div className={styles.ancestorList}>
            {parentChain.map((node) => (
              <ThreadNode
                key={node.tweet_id}
                node={node}
                isMuted
                dataset={dataset}
                clusterMap={clusterMap}
                nodeStats={nodeStats}
                onClick={onClick}
                onViewThread={onViewThread}
                onViewQuotes={onViewQuotes}
              />
            ))}
          </div>
        )}
      </div>

      {/* The tweet — connector from ancestors, no "Replying to" line */}
      <div className={styles.tweetWrap}>
        {!loading && parentChain.length > 0 && (
          <div className={styles.connectorToTweet} aria-hidden="true" />
        )}
        <TweetCard
          row={row}
          textColumn={textColumn}
          dateColumn={dateColumn}
          clusterInfo={clusterMap?.[row.ls_index]}
          onHover={onHover}
          onClick={onClick}
          nodeStats={stats}
          onViewThread={onViewThread}
          onViewQuotes={onViewQuotes}
        />
      </div>
    </div>
  );
}

export default memo(StandaloneWithAncestors);
