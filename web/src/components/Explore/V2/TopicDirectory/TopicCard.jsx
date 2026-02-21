import { memo, useState, useRef, useEffect, useCallback } from 'react';
import styles from './TopicCard.module.scss';

function TopicCard({ cluster, isActive, isUnclustered, onClick, clusterColor }) {
  const subClusters = cluster.children || [];
  const subsRef = useRef(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isSubsExpanded, setIsSubsExpanded] = useState(false);

  useEffect(() => {
    const el = subsRef.current;
    if (!el) return;
    // Check if content overflows the 2-line clamp
    setIsOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [subClusters]);

  const handleToggleSubs = useCallback((e) => {
    e.stopPropagation();
    setIsSubsExpanded((prev) => !prev);
  }, []);

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
        <span className={styles.count}>{cluster.cumulativeCount || cluster.count || 0}</span>
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
