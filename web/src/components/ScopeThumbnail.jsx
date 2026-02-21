import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

import { viewClient } from '../lib/apiService';
import { getClusterToneColor } from '../lib/clusterColors';
import { useColorMode } from '../hooks/useColorMode';

const CANVAS_WIDTH = 440;
const CANVAS_HEIGHT = 280;
const EDGE_PADDING = 10;
const MAX_RENDER_POINTS = 3500;

function isFinitePoint(point) {
  return (
    point &&
    point.deleted !== true &&
    Number.isFinite(Number(point.x)) &&
    Number.isFinite(Number(point.y))
  );
}

function samplePoints(points, targetCount) {
  if (!Array.isArray(points) || points.length <= targetCount) return points;
  const sampled = [];
  const step = points.length / targetCount;
  for (let i = 0; i < targetCount; i += 1) {
    sampled.push(points[Math.floor(i * step)]);
  }
  return sampled;
}

function getPreviewRadius(pointCount) {
  if (!pointCount) return 1.25;
  const scaled = 1.9 / Math.sqrt(Math.max(pointCount / 1000, 0.6));
  return Math.max(0.7, Math.min(1.8, scaled));
}

function toCanvasX(x) {
  const usableWidth = CANVAS_WIDTH - EDGE_PADDING * 2;
  return EDGE_PADDING + ((x + 1) / 2) * usableWidth;
}

function toCanvasY(y) {
  const usableHeight = CANVAS_HEIGHT - EDGE_PADDING * 2;
  return EDGE_PADDING + ((1 - y) / 2) * usableHeight;
}

function ScopeThumbnail({ datasetId, scopeId, className, alt, fallbackSrc }) {
  const canvasRef = useRef(null);
  const { isDark } = useColorMode();
  const [points, setPoints] = useState([]);
  const [loadStatus, setLoadStatus] = useState('loading');

  useEffect(() => {
    const controller = new AbortController();
    setLoadStatus('loading');
    setPoints([]);

    viewClient.fetchScopePoints(datasetId, scopeId, { signal: controller.signal })
      .then((rows) => {
        const validRows = Array.isArray(rows) ? rows.filter(isFinitePoint) : [];
        setPoints(samplePoints(validRows, MAX_RENDER_POINTS));
        setLoadStatus('ready');
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          setLoadStatus('error');
        }
      });

    return () => controller.abort();
  }, [datasetId, scopeId]);

  const hasRenderablePoints = points.length > 0;

  const pointStyle = useMemo(() => {
    if (!hasRenderablePoints) return { radius: 1, alpha: 0.7 };
    return {
      radius: getPreviewRadius(points.length),
      alpha: points.length > 2400 ? 0.56 : 0.68,
    };
  }, [hasRenderablePoints, points.length]);

  useEffect(() => {
    if (loadStatus === 'error') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.fillStyle = isDark ? 'rgba(17, 24, 39, 0.92)' : 'rgba(248, 244, 236, 0.9)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.11)' : 'rgba(45, 35, 24, 0.12)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CANVAS_WIDTH - 2, CANVAS_HEIGHT - 2);

    if (!hasRenderablePoints) return;

    const colorCache = new Map();
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      const clusterKey = String(point.cluster ?? 'unknown');
      let color = colorCache.get(clusterKey);
      if (!color) {
        const rgb = getClusterToneColor(point.cluster, isDark);
        color = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${pointStyle.alpha})`;
        colorCache.set(clusterKey, color);
      }

      const px = toCanvasX(Number(point.x));
      const py = toCanvasY(Number(point.y));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, pointStyle.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [hasRenderablePoints, isDark, loadStatus, pointStyle.alpha, pointStyle.radius, points]);

  if (loadStatus === 'error') {
    return (
      <img
        className={className}
        src={fallbackSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      role="img"
      aria-label={alt}
    />
  );
}

ScopeThumbnail.propTypes = {
  datasetId: PropTypes.string.isRequired,
  scopeId: PropTypes.string.isRequired,
  className: PropTypes.string,
  alt: PropTypes.string,
  fallbackSrc: PropTypes.string.isRequired,
};

ScopeThumbnail.defaultProps = {
  className: '',
  alt: 'Scope preview',
};

export default ScopeThumbnail;
