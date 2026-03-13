import { memo, forwardRef } from 'react';
import { Heart } from 'lucide-react';
import styles from './TopicCard.module.scss';

function compactNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function getMetric(cluster, sortMode) {
  switch (sortMode) {
    case 'popular': {
      const v = cluster.cumulativeLikes || cluster.likes || 0;
      return v ? { icon: 'heart', value: compactNumber(v) } : null;
    }
    case 'largest': {
      const v = cluster.cumulativeCount || cluster.count || 0;
      return v ? { icon: null, value: compactNumber(v) } : null;
    }
    default: {
      // similar, az — show likes if available, otherwise count
      const likes = cluster.cumulativeLikes || cluster.likes || 0;
      if (likes) return { icon: 'heart', value: compactNumber(likes) };
      const count = cluster.cumulativeCount || cluster.count || 0;
      if (count) return { icon: null, value: compactNumber(count) };
      return null;
    }
  }
}

const TopicCard = forwardRef(function TopicCard(
  { cluster, isActive, isUnclustered, onClick, clusterColor, sortMode, isExpanded, onClickSubCluster },
  ref
) {
  const subClusters = cluster.children || [];
  const metric = getMetric(cluster, sortMode);

  // Line 2: description if available, otherwise dot-separated subclusters
  const secondaryText = cluster.description
    ? cluster.description
    : subClusters.map((sub) => sub.label).join(' \u00b7 ');

  return (
    <button
      ref={ref}
      className={`${styles.row} ${isActive ? styles.active : ''} ${isUnclustered ? styles.unclustered : ''}`}
      onClick={onClick}
      style={{ '--row-color': clusterColor || 'transparent' }}
    >
      <div className={styles.line1}>
        {!isUnclustered && <span className={styles.colorDot} />}
        <span className={styles.label}>{cluster.label}</span>
        {metric && (
          <span className={styles.metric}>
            {metric.icon === 'heart' && <Heart size={12} className={styles.metricIcon} />}
            {metric.value}
          </span>
        )}
      </div>
      {isExpanded && subClusters.length > 0 ? (
        <div className={styles.subList}>
          {subClusters.map((sub) => (
            <span
              key={sub.cluster}
              role="button"
              tabIndex={0}
              className={styles.subItem}
              onClick={(e) => {
                e.stopPropagation();
                onClickSubCluster?.(sub.cluster);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  onClickSubCluster?.(sub.cluster);
                }
              }}
            >
              <span className={styles.subLabel}>{sub.label}</span>
              <span className={styles.subCount}>{compactNumber(sub.count || 0)}</span>
            </span>
          ))}
        </div>
      ) : (
        secondaryText && <div className={styles.line2}>{secondaryText}</div>
      )}
    </button>
  );
});

export default memo(TopicCard);
