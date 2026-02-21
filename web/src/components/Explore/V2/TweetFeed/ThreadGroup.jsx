import { useState, useId, memo } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown, ChevronUp, MessageSquare } from 'lucide-react';
import TweetCard from './TweetCard';
import styles from './ThreadGroup.module.scss';

ThreadGroup.propTypes = {
  rows: PropTypes.array.isRequired,
  threadRootId: PropTypes.string.isRequired,
  textColumn: PropTypes.string.isRequired,
  dateColumn: PropTypes.string,
  clusterMap: PropTypes.object,
  nodeStats: PropTypes.object,
  onHover: PropTypes.func,
  onClick: PropTypes.func,
  onViewThread: PropTypes.func,
  onViewQuotes: PropTypes.func,
  hasMissingAncestors: PropTypes.bool,
  missingAncestorCount: PropTypes.number,
  globalThreadSize: PropTypes.number,
  visibleCount: PropTypes.number,
  borderless: PropTypes.bool,
};

function ThreadGroup({
  rows,
  threadRootId,
  textColumn,
  dateColumn,
  clusterMap,
  nodeStats,
  onHover,
  onClick,
  onViewThread,
  onViewQuotes,
  hasMissingAncestors = false,
  missingAncestorCount = 0,
  globalThreadSize = null,
  visibleCount = rows.length,
  borderless = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const repliesId = useId();

  if (rows.length === 0) return null;

  const rootRow = rows[0];
  const remainingCount = rows.length - 1;
  const normalizedGlobalSize = Number.isFinite(globalThreadSize)
    ? Math.max(1, Math.trunc(globalThreadSize))
    : null;
  const stableReplyCount = normalizedGlobalSize && normalizedGlobalSize > 1
    ? normalizedGlobalSize - 1
    : null;
  const groupLabelCount = normalizedGlobalSize || visibleCount || rows.length;
  const hasLocalReplies = remainingCount > 0;
  const hasGlobalHiddenReplies = !hasLocalReplies && Boolean(stableReplyCount && stableReplyCount > 0);
  const canShowRepliesAction = hasLocalReplies || (hasGlobalHiddenReplies && onViewThread);

  const handleLoadAncestors = (e) => {
    e.stopPropagation();
    // For now, delegate to existing onViewThread which opens the thread panel
    if (onViewThread) onViewThread(rootRow.ls_index);
  };

  const handleRepliesAction = () => {
    if (hasLocalReplies) {
      setExpanded((prev) => !prev);
      return;
    }
    if (hasGlobalHiddenReplies && onViewThread) {
      onViewThread(rootRow.ls_index);
    }
  };

  return (
    <div
      className={`${styles.threadGroup} ${borderless ? styles.borderless : ''}`}
      role="group"
      aria-label={`Thread of ${groupLabelCount} tweets`}
    >
      {/* Missing ancestors banner */}
      {hasMissingAncestors && (
        <button
          className={styles.ancestorBanner}
          onClick={handleLoadAncestors}
          type="button"
        >
          <ChevronUp size={13} />
          <span>
            {missingAncestorCount > 0
              ? `${missingAncestorCount} earlier tweet${missingAncestorCount === 1 ? '' : 's'} in this thread`
              : 'Show earlier context'}
          </span>
        </button>
      )}

      {/* Root tweet — wrapped so we can draw connector from avatar down */}
      <div className={styles.rootWrap}>
        {/* Connector segment: bottom of root avatar → bottom of root card */}
        {expanded && <div className={styles.rootConnector} aria-hidden="true" />}
        {/* Connector from ancestor banner down to root avatar */}
        {hasMissingAncestors && <div className={styles.ancestorConnector} aria-hidden="true" />}
        <TweetCard
          row={rootRow}
          textColumn={textColumn}
          dateColumn={dateColumn}
          clusterInfo={clusterMap?.[rootRow.ls_index]}
          onHover={onHover}
          onClick={onClick}
          nodeStats={nodeStats?.get(rootRow.ls_index)}
          onViewThread={onViewThread}
          onViewQuotes={onViewQuotes}
        />
      </div>

      {/* Expanded: reply tweets with continuous clickable connector line */}
      {expanded && (
        <div id={repliesId} className={styles.repliesWrap} role="list">
          {/* Clickable connector line — click to collapse */}
          <button
            className={styles.connectorLine}
            onClick={() => setExpanded(false)}
            type="button"
            aria-label="Collapse thread"
            title="Collapse thread"
          />
          {rows.slice(1).map((row) => {
            const stats = nodeStats?.get(row.ls_index);
            return (
              <div
                key={row.ls_index}
                className={styles.threadReply}
                role="listitem"
              >
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
            );
          })}
        </div>
      )}

      {/* Expand/collapse bar */}
      {canShowRepliesAction && (
        <button
          className={`${styles.expandBar} ${expanded ? styles.expandBarExpanded : ''}`}
          onClick={handleRepliesAction}
          type="button"
          aria-expanded={hasLocalReplies ? expanded : undefined}
          aria-controls={hasLocalReplies ? repliesId : undefined}
        >
          <MessageSquare size={13} />
          <span>
            {expanded
              ? 'Hide replies'
              : (stableReplyCount
                ? `Show replies (${stableReplyCount} in thread)`
                : `${remainingCount} more tweet${remainingCount === 1 ? '' : 's'} in this thread`)}
          </span>
          <ChevronDown size={13} className={styles.expandChevron} />
        </button>
      )}
    </div>
  );
}

export default memo(ThreadGroup);
