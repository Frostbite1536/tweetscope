import { useEffect, useRef } from 'react';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import useThreadData from '../../../../hooks/useThreadData';
import ThreadNode from './ThreadNode';
import styles from './ThreadView.module.scss';

let supportsNearestContainerScrollIntoViewCache;

function supportsNearestContainerScrollIntoView() {
  if (supportsNearestContainerScrollIntoViewCache !== undefined) {
    return supportsNearestContainerScrollIntoViewCache;
  }

  if (typeof document === 'undefined' || !document.body) {
    supportsNearestContainerScrollIntoViewCache = false;
    return supportsNearestContainerScrollIntoViewCache;
  }

  const outer = document.createElement('div');
  const inner = document.createElement('div');
  const target = document.createElement('div');

  outer.style.cssText = [
    'position:absolute',
    'top:-9999px',
    'left:0',
    'width:120px',
    'height:120px',
    'overflow:auto',
  ].join(';');
  inner.style.cssText = [
    'width:120px',
    'height:240px',
    'overflow:auto',
  ].join(';');
  target.style.cssText = 'margin-top:180px;height:20px;';

  inner.appendChild(target);
  outer.appendChild(inner);
  document.body.appendChild(outer);

  outer.scrollTop = 0;
  inner.scrollTop = 0;

  target.scrollIntoView({
    behavior: 'auto',
    block: 'start',
    inline: 'nearest',
    container: 'nearest',
  });

  supportsNearestContainerScrollIntoViewCache = inner.scrollTop > 0 && outer.scrollTop === 0;
  document.body.removeChild(outer);
  return supportsNearestContainerScrollIntoViewCache;
}

function scrollIntoContainerCenter(targetEl, containerEl) {
  if (!targetEl || !containerEl) return;

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const behavior = prefersReducedMotion ? 'auto' : 'smooth';

  if (supportsNearestContainerScrollIntoView()) {
    targetEl.scrollIntoView({
      behavior,
      block: 'center',
      inline: 'nearest',
      container: 'nearest',
    });
    return;
  }

  const containerRect = containerEl.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  const nextTop = containerEl.scrollTop
    + (targetRect.top - containerRect.top)
    - (containerEl.clientHeight - targetRect.height) / 2;

  containerEl.scrollTo({
    top: Math.max(0, nextTop),
    behavior,
  });
}

/**
 * Thread reading panel that replaces the normal sidebar feed
 * when the user clicks "View Thread" on a connected tweet.
 */
export default function ThreadView({
  datasetId,
  scopeId,
  tweetId,
  currentLsIndex,
  nodeStats,
  clusterMap,
  dataset,
  onBack,
  onViewThread,
  onViewQuotes,
  showHeader = true,
  onThreadDataChange,
}) {
  const {
    parentChain,
    currentTweet,
    descendants,
    edges,
    internalIndices,
    loading,
    error,
    tweetCount,
  } = useThreadData(datasetId, scopeId, tweetId, currentLsIndex, !!tweetId);

  const scrollRef = useRef(null);
  const currentRef = useRef(null);

  // Auto-scroll to the current tweet when thread loads
  useEffect(() => {
    if (!loading && currentRef.current && scrollRef.current) {
      const timer = setTimeout(() => {
        scrollIntoContainerCenter(currentRef.current, scrollRef.current);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [loading, tweetId]);

  useEffect(() => {
    if (!onThreadDataChange) return;
    onThreadDataChange({
      internalIndices,
      edges,
      loading,
      error,
    });
  }, [internalIndices, edges, loading, error, onThreadDataChange]);

  return (
    <div className={styles.threadView}>
      {/* Header */}
      {showHeader && (
        <div className={styles.header}>
          <button className={styles.backButton} onClick={onBack} type="button">
            <ArrowLeft size={16} />
            <span>Back to feed</span>
          </button>
          <div className={styles.headerInfo}>
            <MessageSquare size={14} />
            <span>
              {loading ? 'Loading thread...' : `Thread (${tweetCount} tweets)`}
            </span>
          </div>
        </div>
      )}

      {/* Thread content */}
      <div className={styles.scrollContainer} ref={scrollRef}>
        {error && (
          <div className={styles.errorState}>
            Failed to load thread. <button onClick={onBack}>Go back</button>
          </div>
        )}

        {loading && (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <span>Loading thread...</span>
          </div>
        )}

        {!loading && !error && (
          <div className={styles.threadContent}>
            {/* Parent chain (ancestors — muted) */}
            {parentChain.length > 0 && (
              <div className={styles.parentSection}>
                {parentChain.map((node) => (
                  <ThreadNode
                    key={node.tweet_id}
                    node={node}
                    isMuted
                    dataset={dataset}
                    clusterMap={clusterMap}
                    nodeStats={nodeStats}
                    onViewThread={onViewThread}
                    onViewQuotes={onViewQuotes}
                  />
                ))}
              </div>
            )}

            {/* Current tweet (highlighted) */}
            {currentTweet && (
              <div ref={currentRef}>
                <ThreadNode
                  node={currentTweet}
                  isCurrent
                  dataset={dataset}
                  clusterMap={clusterMap}
                  nodeStats={nodeStats}
                  onViewThread={onViewThread}
                  onViewQuotes={onViewQuotes}
                />
              </div>
            )}

            {/* Descendants (replies) */}
            {descendants.length > 0 && (
              <div className={styles.descendantsSection}>
                {descendants.map((node) => (
                  <ThreadNode
                    key={node.tweet_id}
                    node={node}
                    dataset={dataset}
                    clusterMap={clusterMap}
                    nodeStats={nodeStats}
                    onViewThread={onViewThread}
                    onViewQuotes={onViewQuotes}
                  />
                ))}
              </div>
            )}

            {/* Empty state — no thread found */}
            {!loading && parentChain.length === 0 && descendants.length === 0 && currentTweet && (
              <div className={styles.emptyState}>
                This tweet does not appear to be part of a thread.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
