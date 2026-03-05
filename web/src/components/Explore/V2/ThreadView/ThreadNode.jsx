import { memo } from 'react';
import { ExternalLink } from 'lucide-react';
import { useColorMode } from '../../../../hooks/useColorMode';
import { EMBED_PRIORITY } from '../../../../lib/embedScheduler';
import TweetCard from '../TweetFeed/TweetCard';
import TwitterEmbed from '../TweetFeed/TwitterEmbed';
import styles from './ThreadView.module.scss';

/**
 * Renders a single node in the thread view.
 * - Internal tweets (with row data) render as a compact TweetCard
 * - External tweets (no ls_index) render as a Twitter embed with fallback
 */
function ThreadNode({
  node,
  isCurrent = false,
  isMuted = false,
  isFirstInThread = false,
  isLastInThread = false,
  showConnector = false,
  dataset,
  clusterMap,
  nodeStats,
  onViewThread,
  onViewQuotes,
  onClick,
}) {
  const hasRow = node.row != null;
  const tweetId = node.tweet_id;
  const lsIndex = node.ls_index;
  const { colorMode } = useColorMode();

  const username = hasRow ? (node.row.username || node.row.display_name) : null;
  const twitterUrl = username && tweetId
    ? `https://twitter.com/${username}/status/${tweetId}`
    : tweetId
      ? `https://twitter.com/i/web/status/${tweetId}`
      : null;

  return (
    <div
      className={[
        styles.threadNode,
        isCurrent && styles.current,
        isMuted && styles.muted,
        showConnector && styles.hasConnector,
        isFirstInThread && styles.firstInThread,
        isLastInThread && styles.lastInThread,
      ].filter(Boolean).join(' ')}
    >
      {hasRow ? (
        <div className={styles.internalTweet}>
          <TweetCard
            row={node.row}
            textColumn={dataset?.text_column}
            clusterInfo={clusterMap?.[lsIndex]}
            nodeStats={nodeStats?.get(lsIndex)}
            onClick={onClick}
            onViewThread={onViewThread && lsIndex != null ? () => onViewThread(lsIndex) : undefined}
            onViewQuotes={onViewQuotes && lsIndex != null ? () => onViewQuotes(lsIndex) : undefined}
          />
        </div>
      ) : (
        <div className={styles.externalTweet}>
          {tweetId ? (
            <div className={styles.externalEmbedWrap} onClick={(e) => e.stopPropagation()}>
              <TwitterEmbed
                tweetId={tweetId}
                tweetUrl={twitterUrl}
                theme={colorMode}
                hideConversation
                compact
                priority={EMBED_PRIORITY.USER_INITIATED}
                allowDuringActivity={true}
              />
            </div>
          ) : (
            <div className={styles.externalContent}>
              <span className={styles.externalLabel}>Tweet not in dataset</span>
              {twitterUrl && (
                <a
                  href={twitterUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.externalLink}
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink size={13} />
                  <span>View on Twitter</span>
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ThreadNode);
