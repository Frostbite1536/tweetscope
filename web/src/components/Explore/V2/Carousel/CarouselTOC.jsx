import { useState, useCallback, useRef, useEffect, memo } from 'react';
import styles from './CarouselTOC.module.scss';

const CarouselTOCGroup = memo(function CarouselTOCGroup({
  cluster,
  index,
  isFocused,
  isHovered,
  onClickCluster,
  onClickSubCluster,
  onHoverStart,
  onHoverEnd,
}) {
  const handleClusterClick = useCallback(() => {
    onClickCluster(index);
  }, [index, onClickCluster]);

  const handleMouseEnter = useCallback(() => {
    onHoverStart(index);
  }, [index, onHoverStart]);

  return (
    <div
      className={styles.tocGroup}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onHoverEnd}
    >
      {isHovered && cluster.description && (
        <div className={styles.tooltip}>{cluster.description}</div>
      )}

      <button
        className={`${styles.tocItem} ${isFocused ? styles.active : ''}`}
        onClick={handleClusterClick}
      >
        <span className={styles.tocLabel}>{cluster.label}</span>
        <span className={styles.tocCount}>{cluster.count || cluster.cumulativeCount || 0}</span>
      </button>

      {cluster.children?.length > 0 && (isFocused || isHovered) && (
        <div className={styles.subList}>
          {cluster.children.map((sub) => (
            <div key={sub.cluster}>
              <button
                className={styles.subItem}
                onClick={() => {
                  onClickCluster(index);
                  if (onClickSubCluster) onClickSubCluster(index, sub.cluster);
                }}
              >
                <span className={styles.subLabel}>{sub.label}</span>
                <span className={styles.subCount}>{sub.count || 0}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function CarouselTOC({
  topLevelClusters,
  focusedIndex,
  onClickCluster,
  onClickSubCluster,
}) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const hoverTimeoutRef = useRef(null);

  const handleMouseEnter = useCallback((index) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredIndex(index);
    }, 800);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setHoveredIndex(null);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
    };
  }, []);

  if (!topLevelClusters?.length) return null;

  return (
    <div className={styles.toc} role="navigation" aria-label="Topic navigation">
      <div className={styles.tocList}>
        {topLevelClusters.map((cluster, index) => (
          <CarouselTOCGroup
            key={cluster.cluster}
            cluster={cluster}
            index={index}
            isFocused={index === focusedIndex}
            isHovered={index === hoveredIndex}
            onClickCluster={onClickCluster}
            onClickSubCluster={onClickSubCluster}
            onHoverStart={handleMouseEnter}
            onHoverEnd={handleMouseLeave}
          />
        ))}
      </div>
    </div>
  );
}

export default memo(CarouselTOC);
