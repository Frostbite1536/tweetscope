import { memo } from 'react';
import { CornerDownRight, MessageSquare, Quote } from 'lucide-react';
import styles from './ConnectionBadges.module.scss';

function ConnectionBadges({ stats, onViewThread, onViewQuotes, compact = false }) {
  if (!stats) return null;

  const badges = [];
  const threadSize = Number.isFinite(Number(stats.threadSize)) ? Number(stats.threadSize) : 1;
  const threadDepth = Number.isFinite(Number(stats.threadDepth)) ? Number(stats.threadDepth) : 0;
  const rootId = stats.threadRootId == null ? null : String(stats.threadRootId);
  const tweetId = stats.tweetId == null ? null : String(stats.tweetId);
  const isCanonicalInternalRoot = Boolean(
    rootId &&
    tweetId &&
    threadDepth === 0 &&
    rootId === tweetId
  );
  const isThreadMember = threadSize >= 2 && (isCanonicalInternalRoot || threadDepth > 0);
  const hasDirectReplies = Number(stats.replyChildCount) > 0;

  // Priority 1: Reply indicator (other tweets reply to this tweet)
  if (hasDirectReplies) {
    badges.push({
      key: 'reply',
      type: 'thread',
      icon: CornerDownRight,
      label: 'Reply',
      action: onViewThread,
    });
  }

  // Priority 2: Thread indicator from node stats.
  // Show numeric size only for canonical internal roots; members get a
  // non-numeric indicator so the badge doesn't oscillate with feed paging.
  if (isCanonicalInternalRoot) {
    badges.push({
      key: 'thread',
      type: 'thread',
      icon: MessageSquare,
      label: `${threadSize}-tweet thread`,
      action: onViewThread,
    });
  } else if (isThreadMember) {
    badges.push({
      key: 'thread-member',
      type: 'thread',
      icon: MessageSquare,
      label: 'In thread',
      action: onViewThread,
    });
  }

  // Priority 3: Quoted by others
  if (stats.quoteInCount > 0) {
    badges.push({
      key: 'quoted',
      type: 'quote',
      icon: Quote,
      label: `Quoted ${stats.quoteInCount}x`,
      action: onViewQuotes,
    });
  }

  // Limit to 3 badges max to avoid clutter
  const visibleBadges = badges.slice(0, 3);

  if (visibleBadges.length === 0) return null;

  return (
    <span className={`${styles.badges} ${compact ? styles.compact : ''}`}>
      {visibleBadges.map((badge) => {
        const Icon = badge.icon;
        const clickable = !!badge.action;
        const Tag = clickable ? 'button' : 'span';
        return (
          <Tag
            key={badge.key}
            className={`${styles.badge} ${styles[badge.type]}`}
            onClick={clickable ? (e) => {
              e.stopPropagation();
              badge.action();
            } : undefined}
            type={clickable ? 'button' : undefined}
          >
            <Icon size={11} />
            <span>{badge.label}</span>
          </Tag>
        );
      })}
    </span>
  );
}

export default memo(ConnectionBadges);
