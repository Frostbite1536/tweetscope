import styles from './SubClusterPills.module.scss';

function normalizeClusterId(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

export default function SubClusterPills({ subClusters, activeSubCluster, onSelect }) {
  if (!subClusters || subClusters.length === 0) return null;
  const activeClusterId = normalizeClusterId(activeSubCluster);

  return (
    <div className={styles.pillBar}>
      <button
        className={`${styles.pill} ${activeClusterId === null ? styles.active : ''}`}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {subClusters.map((sub) => (
        <button
          key={sub.cluster}
          className={`${styles.pill} ${activeClusterId === normalizeClusterId(sub.cluster) ? styles.active : ''}`}
          onClick={() => onSelect(sub.cluster)}
          title={sub.label}
        >
          <span className={styles.pillLabel}>{sub.label}</span>
          {sub.count > 0 && <span className={styles.pillBadge}>{sub.count}</span>}
        </button>
      ))}
    </div>
  );
}
