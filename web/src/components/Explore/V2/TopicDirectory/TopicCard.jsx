import { memo, useState, useCallback, useRef, useEffect } from 'react';
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

function TopicCard({ cluster, isActive, isUnclustered, onClick, clusterColor, sortMode }) {
  const subClusters = cluster.children || [];
  const subsRef = useRef(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isSubsExpanded, setIsSubsExpanded] = useState(false);

  useEffect(() => {
    const el = subsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setIsOverflowing(el.scrollHeight > el.clientHeight + 2);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleToggleSubs = useCallback((e) => {
    e.stopPropagation();
    setIsSubsExpanded((prev) => !prev);
  }, []);

  const metric = getMetric(cluster, sortMode);

  return (
    <button
      className={`${styles.card} ${isActive ? styles.active : ''} ${isUnclustered ? styles.unclustered : ''}`}
      onClick={onClick}
      style={{
        '--card-color': clusterColor || 'transparent',
      }}
    >
      <div className={styles.header}>
        <span className={styles.label}>{cluster.label}</span>
        {metric && (
          <span className={styles.count}>
            {metric.icon === 'heart' && <Heart size={10} className={styles.metricIcon} />}
            {metric.value}
          </span>
        )}
      </div>
      {subClusters.length > 0 && (
        <>
          <div
            ref={subsRef}
            className={`${styles.subs} ${isSubsExpanded ? styles.expanded : ''}`}
          >
            {subClusters.map((sub, i) => (
              <span key={sub.cluster} className={styles.sub}>
                {i > 0 && <span className={styles.dot}>&middot;</span>}
                {sub.label}
              </span>
            ))}
          </div>
          {(isOverflowing || isSubsExpanded) && (
            <span
              className={styles.moreToggle}
              onClick={handleToggleSubs}
              role="button"
              tabIndex={-1}
            >
              {isSubsExpanded ? 'show less' : 'more...'}
            </span>
          )}
        </>
      )}
    </button>
  );
}

export default memo(TopicCard);
