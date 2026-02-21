import { useRef, useCallback, useState, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, TextLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import { OrthographicView, LinearInterpolator } from '@deck.gl/core';
import { CanvasContext } from '@luma.gl/core';
import PropTypes from 'prop-types';

import { mapSelectionKey } from '@/lib/colors';
import { useClusterColors, resolveClusterColor } from '@/hooks/useClusterColors';
import { useColorMode } from '@/hooks/useColorMode';
import { useScope } from '@/contexts/ScopeContext';
import { applyInteractionRadius, computePointRadii } from './pointSizing';
import styles from './Scatter.module.css';

// Work around an occasional luma resize race where CanvasContext can receive a
// ResizeObserver callback before `device.limits` is fully ready.
const patchCanvasContextResizeGuard = (() => {
  let patched = false;
  return () => {
    if (patched) return;
    const proto = CanvasContext?.prototype;
    const original = proto?.getMaxDrawingBufferSize;
    if (typeof original !== 'function') {
      patched = true;
      return;
    }

    proto.getMaxDrawingBufferSize = function getMaxDrawingBufferSizeGuarded() {
      const maxTextureDimension = this?.device?.limits?.maxTextureDimension2D;
      if (!Number.isFinite(maxTextureDimension) || maxTextureDimension <= 0) {
        // Conservative fallback that is valid on modern WebGL2 implementations.
        return [16384, 16384];
      }
      return [maxTextureDimension, maxTextureDimension];
    };

    patched = true;
  };
})();

patchCanvasContextResizeGuard();

// Color palette and helpers now live in @/lib/clusterColors.js
const CLUSTER_LABEL_FONT_FAMILY = "'Instrument Serif', Georgia, serif";
const CLUSTER_LABEL_FONT_WEIGHT = '600';
const HIERARCHY_LAYER_ZOOM_START_OFFSET = 2.2;
const HIERARCHY_LAYER_ZOOM_SPAN = 5.5;
const HIERARCHY_FINE_BIAS = 0.55;

// PropTypes defined after component (see end of file)

function toIntOrNull(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function edgeBendSign(srcIdx, dstIdx) {
  const seed = ((srcIdx * 73856093) ^ (dstIdx * 19349663)) >>> 0;
  return seed % 2 === 0 ? 1 : -1;
}

function buildCurvedPath(sourcePosition, targetPosition, srcIdx, dstIdx, curvature = 0.14, steps = 8) {
  const x0 = sourcePosition[0];
  const y0 = sourcePosition[1];
  const x1 = targetPosition[0];
  const y1 = targetPosition[1];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (!Number.isFinite(length) || length < 1e-6) {
    return [sourcePosition, targetPosition];
  }

  const nx = -dy / length;
  const ny = dx / length;
  const sign = edgeBendSign(srcIdx, dstIdx);
  const bend = clamp(length * curvature, 0.01, 0.18) * sign;
  const cx = (x0 + x1) * 0.5 + nx * bend;
  const cy = (y0 + y1) * 0.5 + ny * bend;

  const path = [];
  const segmentCount = Math.max(3, steps);
  for (let i = 0; i <= segmentCount; i++) {
    const t = i / segmentCount;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    path.push([x, y]);
  }
  return path;
}

function clamp(num, min, max) {
  return Math.min(max, Math.max(min, num));
}

function truncateWithEllipsis(text, maxChars) {
  const value = String(text || '').trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return '…';

  const slice = value.slice(0, maxChars - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cutoff = lastSpace >= Math.floor(maxChars * 0.6) ? lastSpace : slice.length;
  return `${slice.slice(0, cutoff)}…`;
}

function boxesIntersect(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function wrapTextToWidth(text, sizePx, maxWidthPx, measureTextWidth) {
  const value = String(text || '').trim();
  if (!value) return [];
  if (!Number.isFinite(maxWidthPx) || maxWidthPx <= 0) return [value];

  const words = value.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  const breakWord = (word) => {
    let remaining = word;
    while (remaining.length) {
      // Binary search the longest prefix that fits.
      let lo = 1;
      let hi = remaining.length;
      let best = 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = remaining.slice(0, mid);
        if (measureTextWidth(candidate, sizePx) <= maxWidthPx) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      lines.push(remaining.slice(0, best));
      remaining = remaining.slice(best);
    }
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current) {
      if (measureTextWidth(candidate, sizePx) <= maxWidthPx) {
        current = candidate;
      } else {
        breakWord(word);
        current = '';
      }
      continue;
    }

    if (measureTextWidth(candidate, sizePx) <= maxWidthPx) {
      current = candidate;
      continue;
    }

    lines.push(current);
    if (measureTextWidth(word, sizePx) <= maxWidthPx) {
      current = word;
    } else {
      breakWord(word);
      current = '';
    }
  }

  if (current) lines.push(current);
  return lines;
}

function truncateTextToWidth(text, sizePx, maxWidthPx, measureTextWidth, { forceEllipsis = false } = {}) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (!Number.isFinite(maxWidthPx) || maxWidthPx <= 0) return value;

  const fits = (s) => measureTextWidth(s, sizePx) <= maxWidthPx;
  const withEllipsis = (s) => (s.endsWith('…') ? s : `${s}…`);

  if (fits(value)) {
    if (!forceEllipsis) return value;
    const v = withEllipsis(value);
    if (fits(v)) return v;
  }

  const chars = Array.from(value.replace(/…+$/u, ''));
  if (!chars.length) return '…';

  // Binary search the longest prefix that fits with an ellipsis.
  let lo = 0;
  let hi = chars.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join('')}${mid < chars.length || forceEllipsis ? '…' : ''}`;
    if (fits(candidate)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const prefix = chars.slice(0, best).join('').trimEnd();
  const result = withEllipsis(prefix);
  return result === '…' && !fits(result) ? '' : result;
}

function calculateBaseAlpha(pointCount) {
  if (!pointCount) return 120;
  const value = 180 * Math.pow(5000 / pointCount, 0.2);
  return clamp(Math.round(value), 40, 180);
}

function toClusterKey(value) {
  return String(value);
}

function buildHierarchyIndex(labels) {
  const labelIds = new Set(labels.map((label) => toClusterKey(label.cluster)));
  const childrenByParent = new Map();
  const layerById = new Map();
  let maxLayer = 0;
  for (const label of labels) {
    const childKey = toClusterKey(label.cluster);
    const layer = Number(label.layer || 0);
    layerById.set(childKey, layer);
    if (layer > maxLayer) maxLayer = layer;

    if (label.parentCluster === null || label.parentCluster === undefined) continue;
    const parentKey = toClusterKey(label.parentCluster);
    if (!labelIds.has(parentKey)) continue;
    const children = childrenByParent.get(parentKey) ?? [];
    children.push(childKey);
    childrenByParent.set(parentKey, children);
  }

  const roots = [];
  for (const label of labels) {
    const id = toClusterKey(label.cluster);
    const parentRaw = label.parentCluster;
    const parentKey =
      parentRaw === null || parentRaw === undefined ? null : toClusterKey(parentRaw);
    if (!parentKey || !labelIds.has(parentKey)) roots.push(id);
  }

  return {
    childrenByParent,
    layerById,
    roots: roots.length > 0 ? roots : labels.map((label) => toClusterKey(label.cluster)),
    maxLayer,
  };
}

function selectHierarchyLabelCut(index, targetLayer) {
  const selected = new Set();
  const visited = new Set();

  const visit = (nodeId) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const layer = index.layerById.get(nodeId) ?? 0;
    const children = index.childrenByParent.get(nodeId) ?? [];
    if (!children.length || layer <= targetLayer) {
      selected.add(nodeId);
      return;
    }

    for (const childId of children) {
      visit(childId);
    }
  };

  for (const rootId of index.roots) {
    visit(rootId);
  }

  return selected;
}

const DeckGLScatter = forwardRef(function DeckGLScatter({
  points,
  width,
  height,
  contentPaddingRight = 0,
  pointScale = 1,
  pointOpacity = 1,
  minZoom = -2,
  maxZoom = 8,
  onView,
  onSelect,
  onHover,
  onLabelClick,
  showClusterOutlines = true,
  activeClusterId = null,
  featureIsSelected = false,
  linkEdges = [],
  showReplyEdges = true,
  showQuoteEdges = true,
  edgeWidthScale = 1,
  highlightIndices = null,
}, ref) {
  const { isDark: isDarkMode } = useColorMode();
  const { clusterLabels, clusterHierarchy, scope, scopeRows } = useScope();
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);
  const devicePixelRatio = useMemo(() => {
    if (typeof window === 'undefined') return 1;
    return Math.min(window.devicePixelRatio || 1, 2);
  }, []);

  const deckRef = useRef(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState(null);

  // Controlled view state for programmatic zoom
  const [controlledViewState, setControlledViewState] = useState(null);

  // Calculate the initial zoom level to fit the data range [-1, 1] in the viewport.
  // When contentPaddingRight > 0, frame data within the unoccluded visible area
  // (left of the sidebar overlay). Once the user pans/zooms, initialViewState is
  // no longer used by @deck.gl/react, so content can freely go behind the sidebar.
  const initialZoom = useMemo(() => {
    const visibleWidth = Math.max(320, width - contentPaddingRight);
    const fitSize = Math.min(visibleWidth, height) * 0.45;
    return clamp(Math.log2(fitSize), minZoom, maxZoom);
  }, [width, height, contentPaddingRight, minZoom, maxZoom]);

  // Shift the initial target so data is centered in the visible area (left of sidebar).
  // In OrthographicView, target maps to the canvas center. We offset target.x rightward
  // in data-space so that the data origin [0,0] appears at the visible-area center instead.
  const initialViewState = useMemo(() => {
    const scale = Math.pow(2, initialZoom);
    const targetOffsetX = contentPaddingRight > 0 ? contentPaddingRight / (2 * scale) : 0;
    return {
      target: [targetOffsetX, 0, 0],
      zoom: initialZoom,
      minZoom: minZoom,
      maxZoom: maxZoom,
    };
  }, [initialZoom, contentPaddingRight, minZoom, maxZoom]);

  // Track current view state for label filtering
  const [currentViewState, setCurrentViewState] = useState(initialViewState);

  // Debounced view state for label placement — labels hold position during
  // active pan/zoom and reflow ~150ms after interaction settles (C2 fix).
  const [debouncedViewState, setDebouncedViewState] = useState(null);
  const labelDebounceRef = useRef(null);
  useEffect(() => {
    const vs = controlledViewState || currentViewState || initialViewState;
    if (labelDebounceRef.current) clearTimeout(labelDebounceRef.current);
    labelDebounceRef.current = setTimeout(() => {
      setDebouncedViewState(vs);
    }, 150);
    return () => clearTimeout(labelDebounceRef.current);
  }, [controlledViewState, currentViewState, initialViewState]);

  const textMeasureContext = useMemo(() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    return canvas.getContext('2d');
  }, []);
  const textWidthCacheRef = useRef(new Map());

  // Expose zoomToBounds and getViewState methods via ref
  useImperativeHandle(ref, () => ({
    zoomToBounds: (bounds, transitionDuration = 500) => {
      const [minX, minY, maxX, maxY] = bounds;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const rangeX = maxX - minX;
      const rangeY = maxY - minY;
      // Account for sidebar: fit bounds in unoccluded visible area
      const visibleWidth = Math.max(320, width - contentPaddingRight);
      const fitZoom = Math.log2(Math.min(visibleWidth, height) * 0.8 / Math.max(rangeX, rangeY));
      const clampedZoom = Math.min(Math.max(fitZoom, minZoom), maxZoom);
      // Shift target so bounds center in the visible area (left of sidebar)
      const scale = Math.pow(2, clampedZoom);
      const targetOffsetX = contentPaddingRight > 0 ? contentPaddingRight / (2 * scale) : 0;

      setControlledViewState({
        target: [centerX + targetOffsetX, centerY, 0],
        zoom: clampedZoom,
        minZoom,
        maxZoom,
        transitionDuration,
        transitionInterpolator: new LinearInterpolator(['target', 'zoom']),
      });
    },
    zoomToPoint: (x, y, zoom, transitionDuration = 420) => {
      const clampedZoom = Math.min(Math.max(zoom, minZoom), maxZoom);
      const scale = Math.pow(2, clampedZoom);
      const targetOffsetX = contentPaddingRight > 0 ? contentPaddingRight / (2 * scale) : 0;

      setControlledViewState({
        target: [x + targetOffsetX, y, 0],
        zoom: clampedZoom,
        minZoom,
        maxZoom,
        transitionDuration,
        transitionInterpolator: new LinearInterpolator(['target', 'zoom']),
      });
    },
    getViewState: () => controlledViewState ?? currentViewState,
    setViewState: (viewState, transitionDuration = 0) => {
      if (!viewState) return;
      const nextViewState = {
        ...viewState,
        minZoom,
        maxZoom,
      };
      if (transitionDuration > 0) {
        nextViewState.transitionDuration = transitionDuration;
        nextViewState.transitionInterpolator = new LinearInterpolator(['target', 'zoom']);
      }
      setControlledViewState(nextViewState);
    },
  }), [width, height, contentPaddingRight, minZoom, maxZoom, controlledViewState, currentViewState]);

  const pointCount = points.length;

  const pointRadii = useMemo(() => {
    return computePointRadii(scopeRows, pointCount);
  }, [scopeRows, pointCount]);

  // Dataset-adaptive reference for zoom-dependent shrinking.
  // Using the actual max ensures the shrink curve adapts to any engagement range.
  const maxPointRadius = useMemo(() => {
    let max = 1;
    for (let i = 0; i < pointRadii.length; i++) {
      if (pointRadii[i] > max) max = pointRadii[i];
    }
    return max;
  }, [pointRadii]);

  const alphaScale = useMemo(() => {
    const base = calculateBaseAlpha(pointCount) * pointOpacity;
    const baseAlpha = clamp(Math.round(base), 10, 255);
    return {
      baseAlpha,
      selectedAlpha: clamp(baseAlpha + 64, 20, 255),
      dimAlpha: clamp(Math.round(baseAlpha * 0.28), 18, 120),
    };
  }, [pointCount, pointOpacity]);

  // Prepare point data for ScatterplotLayer
  // Data coordinates are already in [-1, 1] range
  // points format: [x, y, selectionKey, activation, cluster]
  //
  // Uses a for-loop instead of .map() to reduce GC pressure (H3 fix).
  const scatterData = useMemo(() => {
    const len = points.length;
    const items = new Array(len);
    for (let i = 0; i < len; i++) {
      const p = points[i];
      items[i] = {
        position: [p[0], p[1]],
        selectionKey: p[2],
        activation: p[3] || 0,
        cluster: p[4] !== undefined ? p[4] : 0,
        index: i,
        ls_index: scopeRows?.[i]?.ls_index ?? i,
      };
    }
    return items;
  }, [points, scopeRows]);

  const highlightIndexSet = useMemo(() => {
    if (!highlightIndices) return new Set();

    const rawValues = highlightIndices instanceof Set
      ? Array.from(highlightIndices)
      : (Array.isArray(highlightIndices) ? highlightIndices : []);

    const normalized = new Set();
    for (const value of rawValues) {
      if (value === null || value === undefined) continue;
      normalized.add(value);
      normalized.add(String(value));
      const numeric = Number(value);
      if (Number.isInteger(numeric)) normalized.add(numeric);
    }
    return normalized;
  }, [highlightIndices]);

  const lsIndexPositionMap = useMemo(() => {
    const map = new Map();
    if (!scopeRows?.length) return map;

    for (let i = 0; i < scopeRows.length; i++) {
      const row = scopeRows[i];
      if (!row) continue;
      const lsIndex = toIntOrNull(row.ls_index ?? i);
      if (lsIndex === null) continue;
      const x = Number(row.x);
      const y = Number(row.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      map.set(lsIndex, [x, y]);
    }
    return map;
  }, [scopeRows]);

  const { replyEdgeData, quoteEdgeData } = useMemo(() => {
    const reply = [];
    const quote = [];
    if (!Array.isArray(linkEdges) || linkEdges.length === 0 || lsIndexPositionMap.size === 0) {
      return { replyEdgeData: reply, quoteEdgeData: quote };
    }

    for (let i = 0; i < linkEdges.length; i++) {
      const edge = linkEdges[i];
      const srcIdx = toIntOrNull(edge?.src_ls_index);
      const dstIdx = toIntOrNull(edge?.dst_ls_index);
      if (srcIdx === null || dstIdx === null) continue;

      const sourcePosition = lsIndexPositionMap.get(srcIdx);
      const targetPosition = lsIndexPositionMap.get(dstIdx);
      if (!sourcePosition || !targetPosition) continue;

      const dx = targetPosition[0] - sourcePosition[0];
      const dy = targetPosition[1] - sourcePosition[1];
      const length = Math.sqrt(dx * dx + dy * dy);
      if (!Number.isFinite(length) || length <= 0) continue;

      const row = {
        edgeType: String(edge?.edge_kind || '').toLowerCase(),
        length,
        path: null,
        color: null,
        width: 1,
      };

      if (row.edgeType === 'reply') {
        const alphaBase = isDarkMode ? 120 : 90;
        const alpha = Math.round(alphaBase * clamp(1.04 - length * 0.22, 0.45, 1));
        row.path = buildCurvedPath(sourcePosition, targetPosition, srcIdx, dstIdx, 0.09, 6);
        row.color = isDarkMode ? [214, 206, 188, alpha] : [86, 72, 60, alpha];
        row.width = clamp(1.0 - length * 0.05, 0.72, 1.0);
        reply.push(row);
      } else if (row.edgeType === 'quote') {
        const alphaBase = isDarkMode ? 130 : 112;
        const alpha = Math.round(alphaBase * clamp(1.0 - length * 0.18, 0.5, 1));
        row.path = buildCurvedPath(sourcePosition, targetPosition, srcIdx, dstIdx, 0.16, 10);
        row.color = isDarkMode ? [124, 186, 230, alpha] : [24, 97, 174, alpha];
        row.width = clamp(1.08 - length * 0.04, 0.8, 1.08);
        quote.push(row);
      }
    }

    return { replyEdgeData: reply, quoteEdgeData: quote };
  }, [linkEdges, lsIndexPositionMap, isDarkMode]);

  // Prepare label data for TextLayer with hierarchical support
  const labelData = useMemo(() => {
    if (!clusterLabels || !scopeRows) return [];

    const isHierarchical = scope?.hierarchical_labels;

    if (isHierarchical) {
      // For hierarchical labels, we have layer info and centroid coordinates
      return clusterLabels.map(label => ({
        cluster: label.cluster,
        label: label.label,
        layer: label.layer || 0,
        count: label.count || 0,
        position: label.centroid_x !== undefined && label.centroid_y !== undefined
          ? [label.centroid_x, label.centroid_y]
          : computeCentroidFromHull(label.hull, scopeRows),
        hull: label.hull,
        parentCluster: label.parent_cluster,
        children: label.children || [],
      }));
    } else {
      // Standard flat labels - compute centroid from hull points
      return clusterLabels.map(label => {
        const centroid = computeCentroidFromHull(label.hull, scopeRows);
        return {
          cluster: label.cluster,
          label: label.label,
          layer: 0,
          count: label.count || 0,
          position: centroid,
          hull: label.hull,
        };
      });
    }
  }, [clusterLabels, scopeRows, scope]);

  // Compute centroid from hull indices
  function computeCentroidFromHull(hull, rows) {
    if (!hull || !hull.length || !rows) return [0, 0];

    let sumX = 0, sumY = 0, count = 0;
    hull.forEach(idx => {
      const row = rows[idx];
      if (row) {
        sumX += row.x;
        sumY += row.y;
        count++;
      }
    });

    return count > 0 ? [sumX / count, sumY / count] : [0, 0];
  }

  // Prepare labels sorted by importance (used by deterministic placement/truncation).
  const visibleLabels = useMemo(() => {
    if (!labelData.length) return [];

    // Sort by priority: layer weight * count
    // Higher layers (coarser clusters) and higher counts get priority
    // This lets CollisionFilterExtension naturally show important labels first
    return [...labelData]
      .map(l => ({
        ...l,
        priority: (l.count || 1) * Math.pow(2, (l.layer || 0))
      }))
      .sort((a, b) => b.priority - a.priority);
  }, [labelData]);

  const hierarchyIndex = useMemo(() => {
    if (!scope?.hierarchical_labels || !visibleLabels.length) return null;
    return buildHierarchyIndex(visibleLabels);
  }, [scope?.hierarchical_labels, visibleLabels]);

  const placedLabels = useMemo(() => {
    if (!visibleLabels.length) return [];

    const viewState = debouncedViewState || initialViewState;
    const zoom = viewState?.zoom ?? initialZoom;
    const target = viewState?.target ?? [0, 0, 0];
    const [targetX, targetY] = target;
    const scale = Math.pow(2, zoom);
    const zoomSpan = Math.max(1e-6, maxZoom - minZoom);
    const zoom01 = clamp((zoom - minZoom) / zoomSpan, 0, 1);
    const widthCapFraction = clamp(0.55 + zoom01 * 0.35, 0.55, 0.9);
    const widthCapPx = Math.min(1200, width * widthCapFraction);
    const maxLinesAtZoom = clamp(Math.round(3 + zoom01 * 7), 3, 12);

    const maxLayer = hierarchyIndex?.maxLayer ?? 0;
    // Label hierarchy progression should not depend on very large map maxZoom
    // values (e.g. 40), or lower layers become practically unreachable.
    // Use a local zoom window around the initial framing, with a small bias
    // toward finer layers so subclusters appear earlier.
    const hierarchyProgress = clamp(
      (zoom - initialZoom + HIERARCHY_LAYER_ZOOM_START_OFFSET) / HIERARCHY_LAYER_ZOOM_SPAN,
      0,
      1
    );
    // Pick one hierarchy "cut" from coarse (max layer) to fine (layer 0).
    // This keeps parent/child visibility stable as zoom changes.
    const targetLayer = maxLayer > 0
      ? Math.max(0, Math.floor((1 - hierarchyProgress) * (maxLayer + 1e-6) - HIERARCHY_FINE_BIAS))
      : 0;
    const selectedLabelIds =
      scope?.hierarchical_labels && hierarchyIndex
        ? selectHierarchyLabelCut(hierarchyIndex, targetLayer)
        : null;
    const labelsToProcess = selectedLabelIds
      ? visibleLabels.filter((label) => selectedLabelIds.has(toClusterKey(label.cluster)))
      : visibleLabels;

    const measureCtx = textMeasureContext;
    const widthCache = textWidthCacheRef.current;

    const fontFamily = CLUSTER_LABEL_FONT_FAMILY;
    const fontWeight = CLUSTER_LABEL_FONT_WEIGHT;
    const backgroundPadding = [8, 5, 8, 5]; // left, top, right, bottom (px)
    const collisionMargin = 2; // extra spacing between labels (px)
    const widthInflate = 1.12;
    const lineHeight = 1.1;

    const acceptedBoxes = [];
    const placed = [];

    const projectToScreen = (position) => {
      const x = (position[0] - targetX) * scale + width / 2;
      const y = (targetY - position[1]) * scale + height / 2;
      return [x, y];
    };

    const measureTextWidth = (text, sizePx) => {
      const clean = String(text || '');
      const fontSize = Math.max(1, Math.round(sizePx));
      const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
      const key = `${font}|${clean}`;
      const cached = widthCache.get(key);
      if (cached !== undefined) return cached;
      if (!measureCtx) return clean.length * fontSize * 0.6;
      measureCtx.font = font;
      const measured = measureCtx.measureText(clean).width;
      widthCache.set(key, measured);
      return measured;
    };

    const computeLabelSizePx = (d) => {
      const layer = d.layer || 0;
      const count = d.count || 0;
      const layerNorm = maxLayer > 0 ? layer / maxLayer : 1;
      const base = 13 + layerNorm * 6; // 13..19
      const countBonus = Math.log10(Math.max(count, 1)) * 1.2;
      return clamp(base + countBonus, 12, 22);
    };

    const layoutWrappedLabel = (text, sizePx, { maxWidthPx, maxLines }) => {
      const lines = wrapTextToWidth(text, sizePx, maxWidthPx, measureTextWidth);
      if (!lines.length) return null;

      if (Number.isFinite(maxLines) && maxLines > 0 && lines.length > maxLines) {
        const trimmed = lines.slice(0, maxLines);
        trimmed[maxLines - 1] = truncateTextToWidth(
          trimmed[maxLines - 1],
          sizePx,
          maxWidthPx,
          measureTextWidth,
          { forceEllipsis: true }
        );
        // If truncation made the last line empty, drop this layout.
        if (!trimmed[maxLines - 1]) return null;
        return { text: trimmed.join('\n'), lines: trimmed };
      }

      return { text: lines.join('\n'), lines };
    };

    const computeBox = (centerX, centerY, lines, sizePx) => {
      let maxLineWidth = 0;
      for (const line of lines) {
        maxLineWidth = Math.max(maxLineWidth, measureTextWidth(line, sizePx));
      }

      const textWidth = maxLineWidth * widthInflate;
      const textHeight = lines.length * sizePx * lineHeight;

      const x0 = centerX - textWidth / 2 - backgroundPadding[0] - collisionMargin;
      const x1 = centerX + textWidth / 2 + backgroundPadding[2] + collisionMargin;
      const y0 = centerY - textHeight / 2 - backgroundPadding[1] - collisionMargin;
      const y1 = centerY + textHeight / 2 + backgroundPadding[3] + collisionMargin;

      return { x0, y0, x1, y1 };
    };

    const boxIntersectsAny = (box) => {
      for (let i = 0; i < acceptedBoxes.length; i++) {
        if (boxesIntersect(box, acceptedBoxes[i])) return true;
      }
      return false;
    };

    const countIntersections = (box) => {
      let count = 0;
      for (let i = 0; i < acceptedBoxes.length; i++) {
        if (boxesIntersect(box, acceptedBoxes[i])) count++;
      }
      return count;
    };

    const maxToProcess = 1500;
    const maxSoftLabels = 400;
    let softPlaced = 0;
    for (let i = 0; i < labelsToProcess.length && i < maxToProcess; i++) {
      const d = labelsToProcess[i];
      if (!d?.position) continue;

      const [sx, sy] = projectToScreen(d.position);
      // Skip labels whose anchor is far outside the viewport.
      if (sx < -200 || sx > width + 200 || sy < -200 || sy > height + 200) continue;

      const fullText = String(d.label || '').trim();
      if (!fullText) continue;

      const dx = sx - width / 2;
      const dy = sy - height / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = Math.sqrt((width / 2) * (width / 2) + (height / 2) * (height / 2));
      const dist01 = maxDist > 0 ? clamp(dist / maxDist, 0, 1) : 0;

      // Fade labels as they get further from the current view center (less visually noisy on the periphery).
      const distanceFade = clamp(1 - Math.pow(dist01, 1.5) * 0.75, 0.35, 1);
      const baseTextAlpha = Math.round(230 * distanceFade);
      const baseBgAlpha = clamp(Math.round(84 * distanceFade), 28, 92);

      // Slightly shrink labels on the periphery to reduce overlap pressure (still mostly driven by cluster size).
      const distanceSizeScale = 1 - dist01 * 0.12; // down to ~0.88 at edges
      const zoomSizeScale = 1 + zoom01 * 0.32;
      const sizePx = clamp(computeLabelSizePx(d) * distanceSizeScale * zoomSizeScale, 12, 26);
      const baseMaxWidthPx = clamp(sizePx * (12 + zoom01 * 10), 120, Math.min(widthCapPx, width * 0.92));
      const widthPxOptions = [1, 0.9, 0.8, 0.7].map(f => baseMaxWidthPx * f);
      const maxLinesOptions = [];
      const pushMaxLines = (value) => {
        if (!maxLinesOptions.some(v => v === value)) maxLinesOptions.push(value);
      };

      // When we're focused (high zoom or first label), allow the full label with no line limit.
      if (
        acceptedBoxes.length === 0 ||
        (zoom01 >= 0.75 && dist01 <= 0.35)
      ) {
        pushMaxLines(null); // unlimited
      }
      pushMaxLines(maxLinesAtZoom);
      pushMaxLines(Math.max(4, maxLinesAtZoom - 2));
      pushMaxLines(Math.max(3, maxLinesAtZoom - 4));
      pushMaxLines(3);
      pushMaxLines(2);
      pushMaxLines(1);

      const candidates = [];
      for (const maxLines of maxLinesOptions) {
        for (const maxWidthPx of widthPxOptions) {
          const layout = layoutWrappedLabel(fullText, sizePx, { maxWidthPx, maxLines });
          if (!layout) continue;
          const key = layout.text;
          if (!candidates.some(c => c.text === key)) {
            candidates.push({ ...layout, maxLines, maxWidthPx });
          }
        }
      }

      let placedPrimary = false;
      for (const c of candidates) {
        const box = computeBox(sx, sy, c.lines, sizePx);
        if (boxIntersectsAny(box)) continue;

        acceptedBoxes.push(box);
        placed.push({
          ...d,
          label: c.text,
          fullLabel: fullText,
          sizePx,
          alpha: baseTextAlpha,
          backgroundAlpha: baseBgAlpha,
        });
        placedPrimary = true;
        break;
      }

      if (placedPrimary) continue;

      // If we couldn't place without collision, optionally place a "soft" label:
      // very low opacity, does not reserve collision space, and only away from center.
      if (softPlaced < maxSoftLabels && dist01 >= 0.55) {
        // Choose the most compact candidate (prefer 1 line, narrow width).
        const compact = candidates[candidates.length - 1] || null;
        if (compact?.lines?.length) {
          const box = computeBox(sx, sy, compact.lines, sizePx);
          const intersections = countIntersections(box);

          // Only allow mild overlap. This is intentionally conservative.
          if (intersections <= 2) {
            const softAlpha = clamp(
              Math.round((baseTextAlpha * 0.55) / (1 + intersections * 0.35)),
              20,
              baseTextAlpha
            );
            const softBgAlpha = clamp(
              Math.round((baseBgAlpha * 0.22) / (1 + intersections * 0.5)),
              0,
              baseBgAlpha
            );

            placed.push({
              ...d,
              label: compact.text,
              fullLabel: fullText,
              sizePx: clamp(sizePx * 0.92, 10, 22),
              alpha: softAlpha,
              backgroundAlpha: softBgAlpha,
              soft: true,
            });
            softPlaced++;
          }
        }
      }
    }

    return placed;
  }, [
    visibleLabels,
    width,
    height,
    minZoom,
    maxZoom,
    debouncedViewState,
    initialViewState,
    initialZoom,
    textMeasureContext,
    hierarchyIndex,
    scope?.hierarchical_labels,
  ]);

  const labelCharacterSet = useMemo(() => {
    const set = new Set();
    // Keep the default ASCII set and add characters from labels + the ellipsis glyph we use.
    for (let i = 32; i < 127; i++) set.add(String.fromCharCode(i));
    set.add('…');
    for (const l of labelData) {
      const text = l?.label || '';
      for (const ch of Array.from(String(text))) {
        if (ch === '\n' || ch === '\r' || ch === '\t') continue;
        set.add(ch);
      }
    }
    return Array.from(set);
  }, [labelData]);

  // Prepare hull data for PolygonLayer
  const hullData = useMemo(() => {
    if (!clusterLabels || !scopeRows) return [];

    return clusterLabels
      .filter(label => label.hull && label.hull.length >= 3)
      .map(label => {
        const hullCoords = label.hull
          .map(idx => {
            const row = scopeRows[idx];
            return row ? [row.x, row.y] : null;
          })
          .filter(coord => coord !== null);

        // Close the polygon
        if (hullCoords.length >= 3) {
          hullCoords.push(hullCoords[0]);
        }

        return {
          cluster: label.cluster,
          polygon: hullCoords,
          label: label.label,
          layer: label.layer || 0,
        };
      })
      .filter(h => h.polygon.length >= 4);
  }, [clusterLabels, scopeRows]);

  const activeHullData = useMemo(() => {
    if (activeClusterId === null || activeClusterId === undefined) return [];
    const activeId = String(activeClusterId);
    return hullData.filter((h) => String(h.cluster) === activeId);
  }, [hullData, activeClusterId]);

  // Handle view state changes
  const handleViewStateChange = useCallback(({ viewState: newViewState }) => {
    setCurrentViewState(newViewState);

    if (onView) {
      // Convert Deck.GL view state to domain format expected by existing code
      const scale = Math.pow(2, newViewState.zoom);
      const [centerX, centerY] = newViewState.target;

      // Calculate visible domain based on zoom and viewport size
      const halfWidthInUnits = (width / 2) / scale;
      const halfHeightInUnits = (height / 2) / scale;

      const xDomain = [centerX - halfWidthInUnits, centerX + halfWidthInUnits];
      const yDomain = [centerY - halfHeightInUnits, centerY + halfHeightInUnits];

      // Create a transform-like object for compatibility with existing code
      const transform = {
        k: scale / Math.pow(2, initialZoom), // Relative zoom from initial
        x: width / 2 - centerX * scale,
        y: height / 2 + centerY * scale, // Y is flipped
      };

      onView(xDomain, yDomain, transform);
    }
  }, [onView, width, height, initialZoom]);

  // Handle hover events
  const handleHover = useCallback((info) => {
    if (info.object && info.layer?.id === 'scatter-layer') {
      setHoveredPointIndex(info.object.index);
      if (onHover) {
        onHover({
          index: info.object.ls_index,
          x: info.x,
          y: info.y,
          source: 'scatter',
        });
      }
    } else {
      setHoveredPointIndex(null);
      if (onHover) {
        onHover(null);
      }
    }
  }, [onHover]);

  const labelHitRegions = useMemo(() => {
    if (!placedLabels.length) return [];

    const viewState = controlledViewState || currentViewState || initialViewState;
    const zoom = viewState?.zoom ?? initialZoom;
    const target = viewState?.target ?? [0, 0, 0];
    const [targetX, targetY] = target;
    const scale = Math.pow(2, zoom);
    const measureCtx = textMeasureContext;
    const widthCache = textWidthCacheRef.current;
    const fontFamily = CLUSTER_LABEL_FONT_FAMILY;
    const fontWeight = CLUSTER_LABEL_FONT_WEIGHT;
    const lineHeight = 1.1;
    const backgroundPadding = [8, 5, 8, 5];
    const widthInflate = 1.12;

    const measureTextWidth = (text, sizePx) => {
      const clean = String(text || '');
      const fontSize = Math.max(1, Math.round(sizePx));
      const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
      const key = `${font}|${clean}`;
      const cached = widthCache.get(key);
      if (cached !== undefined) return cached;
      if (!measureCtx) return clean.length * fontSize * 0.6;
      measureCtx.font = font;
      const measured = measureCtx.measureText(clean).width;
      widthCache.set(key, measured);
      return measured;
    };

    const projectToScreen = (position) => {
      const x = (position[0] - targetX) * scale + width / 2;
      const y = (targetY - position[1]) * scale + height / 2;
      return [x, y];
    };

    return placedLabels.map((d) => {
      const lines = String(d.label || '').split('\n').filter(Boolean);
      const sizePx = clamp(d.sizePx || 14, 10, 32);
      let maxLineWidth = 0;
      for (const line of lines) {
        maxLineWidth = Math.max(maxLineWidth, measureTextWidth(line, sizePx));
      }
      const textWidth = maxLineWidth * widthInflate;
      const textHeight = lines.length * sizePx * lineHeight;
      const [sx, sy] = projectToScreen(d.position);
      const x0 = sx - textWidth / 2 - backgroundPadding[0];
      const x1 = sx + textWidth / 2 + backgroundPadding[2];
      const y0 = sy - textHeight / 2 - backgroundPadding[1];
      const y1 = sy + textHeight / 2 + backgroundPadding[3];

      return { ...d, x0, x1, y0, y1, sx, sy };
    });
  }, [
    placedLabels,
    controlledViewState,
    currentViewState,
    initialViewState,
    initialZoom,
    textMeasureContext,
    width,
    height,
  ]);

  const pickLabelFromScreen = useCallback((x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !labelHitRegions.length) return null;

    let best = null;
    for (const region of labelHitRegions) {
      if (x < region.x0 || x > region.x1 || y < region.y0 || y > region.y1) continue;
      const dx = x - region.sx;
      const dy = y - region.sy;
      const dist2 = dx * dx + dy * dy;
      if (!best || dist2 < best.dist2) {
        best = { region, dist2 };
      }
    }

    return best?.region || null;
  }, [labelHitRegions]);

  // Handle click/select events
  const handleClick = useCallback((info) => {
    if (info.object && info.layer?.id === 'scatter-layer' && onSelect) {
      onSelect([info.object.ls_index]);
      return;
    }

    const labelHit = pickLabelFromScreen(info?.x, info?.y);
    if (labelHit && onLabelClick) {
      onLabelClick({ cluster: labelHit.cluster, label: labelHit.fullLabel || labelHit.label });
      return;
    }

    if (onSelect) {
      onSelect([]);
    }
  }, [onSelect, onLabelClick, pickLabelFromScreen]);

  // Create layers
  const layers = useMemo(() => {
    const layerList = [];

    // 1. Scatterplot Layer for points
    layerList.push(
      new ScatterplotLayer({
        id: 'scatter-layer',
        data: scatterData,
        pickable: true,
        opacity: 1,
        stroked: true,
        filled: true,
        // Use pixel units so point size is stable on screen and not tied to zoom.
        radiusUnits: 'pixels',
        radiusScale: pointScale,
        radiusMinPixels: 0,
        radiusMaxPixels: 28,
        lineWidthUnits: 'pixels',
        lineWidthScale: 1,
        lineWidthMinPixels: 0,
        lineWidthMaxPixels: 4,
        getRadius: d => {
          const isHovered = d.index === hoveredPointIndex;
          const isHighlighted = highlightIndexSet.has(d.ls_index);
          const baseRadius = pointRadii[d.index] || 1.2;
          let pixelRadius = applyInteractionRadius(baseRadius, {
            isHovered,
            isHighlighted,
            featureIsSelected,
            isFeatureSelectedPoint: d.selectionKey === mapSelectionKey.selected,
            activation: d.activation,
          });

          // Zoom-dependent sizing: when zoomed out, shrink small points MORE
          // than big ones so high-engagement nodes stand out in the overview.
          const activeZoom = (controlledViewState || currentViewState)?.zoom ?? initialZoom;
          const zoomDelta = activeZoom - initialZoom; // negative when zoomed out

          if (zoomDelta < 0) {
            const shrinkAmount = Math.min(1.5, Math.abs(zoomDelta) * 0.3);
            const sizeNorm = Math.min(pixelRadius / maxPointRadius, 1); // 0=tiny, 1=big
            const shrinkFactor = 1 - shrinkAmount * (1 - sizeNorm * 0.5);
            pixelRadius *= shrinkFactor;
          } else if (zoomDelta > 0) {
            // When zoomed in, boost small points so they're easier to click/hover.
            const growAmount = Math.min(1, Math.max(0, zoomDelta - 1) * 0.15);
            const sizeNorm = Math.min(pixelRadius / maxPointRadius, 1);
            const boostPx = growAmount * (1 - sizeNorm) * 1.5;
            pixelRadius += boostPx;
          }

          return Math.max(0.3, pixelRadius);
        },
        getFillColor: d => {
          const isHovered = d.index === hoveredPointIndex;
          const isHighlighted = highlightIndexSet.has(d.ls_index);
          const clusterColor = resolveClusterColor(colorMap, d.cluster, isDarkMode);

          let alpha = alphaScale.baseAlpha;
          if (d.selectionKey === mapSelectionKey.hidden) {
            alpha = 0;
          } else if (d.selectionKey === mapSelectionKey.notSelected) {
            alpha = alphaScale.dimAlpha;
          } else if (d.selectionKey === mapSelectionKey.selected) {
            alpha = alphaScale.selectedAlpha;
          }

          if (featureIsSelected && d.selectionKey === mapSelectionKey.selected && d.activation > 0) {
            // When feature view is active, let activation boost the alpha.
            alpha = clamp(Math.round(120 + d.activation * 135), alpha, 255);
          }

          if (isHighlighted) {
            alpha = Math.max(alpha, 220);
          }

          if (isHovered) alpha = 255;

          return [clusterColor[0], clusterColor[1], clusterColor[2], alpha];
        },
        getLineColor: d => {
          const isHovered = d.index === hoveredPointIndex;
          const isHighlighted = highlightIndexSet.has(d.ls_index);
          if (!isHovered && !isHighlighted) return [0, 0, 0, 0];
          if (isHighlighted) {
            return isDarkMode ? [143, 206, 237, 250] : [24, 97, 174, 246];
          }
          return isDarkMode ? [242, 240, 229, 240] : [16, 15, 15, 230];
        },
        getLineWidth: d => {
          if (d.index === hoveredPointIndex) return 2;
          return highlightIndexSet.has(d.ls_index) ? 1.4 : 0;
        },
        updateTriggers: {
          getRadius: [hoveredPointIndex, pointRadii, featureIsSelected, highlightIndexSet, controlledViewState, currentViewState, initialZoom, maxPointRadius],
          getFillColor: [hoveredPointIndex, featureIsSelected, alphaScale, highlightIndexSet, colorMap],
          getLineColor: [hoveredPointIndex, highlightIndexSet, isDarkMode],
          getLineWidth: [hoveredPointIndex, highlightIndexSet],
        },
      })
    );

    // 2. Polygon Layer for cluster hulls — per-cluster colored strokes
    if (showClusterOutlines && activeHullData.length > 0) {
      layerList.push(
        new PolygonLayer({
          id: 'hull-layer',
          data: activeHullData,
          pickable: false,
          stroked: true,
          filled: false,
          getPolygon: d => d.polygon,
          getLineColor: d => {
            const [r, g, b] = resolveClusterColor(colorMap, d.cluster, isDarkMode);
            return [r, g, b, isDarkMode ? 60 : 50];
          },
          lineWidthMinPixels: 0.5,
          lineWidthMaxPixels: 2,
          updateTriggers: {
            getLineColor: [isDarkMode, colorMap],
          },
        })
      );
    }

    // 3. Link edges (render above points/hulls so they are clearly visible)
    if (showReplyEdges && replyEdgeData.length > 0) {
      layerList.push(
        new PathLayer({
          id: 'reply-edges-layer',
          data: replyEdgeData,
          pickable: false,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
          widthUnits: 'pixels',
          widthScale: edgeWidthScale,
          widthMinPixels: 0.5,
          widthMaxPixels: 2.8,
          rounded: true,
          capRounded: true,
          jointRounded: true,
          visible: showReplyEdges,
          updateTriggers: {
            getWidth: [edgeWidthScale],
          },
        })
      );
    }

    if (showQuoteEdges && quoteEdgeData.length > 0) {
      layerList.push(
        new PathLayer({
          id: 'quote-edges-layer',
          data: quoteEdgeData,
          pickable: false,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
          widthUnits: 'pixels',
          widthScale: edgeWidthScale,
          widthMinPixels: 0.6,
          widthMaxPixels: 3.4,
          rounded: true,
          capRounded: true,
          jointRounded: true,
          visible: showQuoteEdges,
          updateTriggers: {
            getWidth: [edgeWidthScale],
          },
        })
      );
    }

    // 4. Text Layer for cluster labels with deterministic truncation on overlap
    if (placedLabels.length > 0) {
      layerList.push(
        new TextLayer({
          id: 'label-layer',
          data: placedLabels,
          pickable: false,
          getPosition: d => d.position,
          getText: d => d.label,
          characterSet: labelCharacterSet,
          // Use pixels for stable label sizing. We handle overlap in JS and truncate as needed.
          sizeUnits: 'pixels',
          getSize: d => {
            const isActive =
              activeClusterId !== null &&
              activeClusterId !== undefined &&
              String(d?.cluster) === String(activeClusterId);
            const baseSize = d.sizePx || 14;
            return isActive ? clamp(baseSize + 1.25, 9, 24) : baseSize;
          },
          getColor: d => {
            const isActive =
              activeClusterId !== null &&
              activeClusterId !== undefined &&
              String(d?.cluster) === String(activeClusterId);
            const alpha = Number.isFinite(d?.alpha) ? d.alpha : 230;
            if (isActive) {
              const [r, g, b] = resolveClusterColor(colorMap, d.cluster, isDarkMode);
              return [r, g, b, 252];
            }
            return isDarkMode ? [242, 240, 229, alpha] : [40, 39, 38, alpha];
          },
          getAngle: 0,
          fontFamily: CLUSTER_LABEL_FONT_FAMILY,
          fontWeight: CLUSTER_LABEL_FONT_WEIGHT,
          fontSettings: { sdf: true },
          // Disable auto-wrapping: we insert '\n' ourselves so we can measure and avoid overlaps.
          maxWidth: -1,
          lineHeight: 1.1,
          // Background for better readability (like datamapplot)
          background: true,
          getBackgroundColor: d => {
            const alpha = Number.isFinite(d?.backgroundAlpha) ? d.backgroundAlpha : 64;
            // Keep chip backgrounds neutral; active state is expressed via text color.
            return isDarkMode ? [52, 51, 49, alpha] : [230, 228, 217, alpha];
          },
          backgroundPadding: [8, 5, 8, 5],
          outlineWidth: 0.55,
          outlineColor: isDarkMode ? [28, 27, 26, 150] : [159, 157, 150, 118],
          sizeMinPixels: 10,
          sizeMaxPixels: 32,
          billboard: true,
          updateTriggers: {
            getSize: [activeClusterId],
            getColor: [isDarkMode, activeClusterId, colorMap],
            getBackgroundColor: [isDarkMode, activeClusterId],
          },
        })
      );
    }

    return layerList;
    // NOTE on hoveredPointIndex: Including it here causes the layers useMemo to
    // recompute on every hover, creating new layer JS instances. This is cheap.
    // Deck.GL diffs layers by id — same id + same `data` reference = NO GPU
    // buffer rebuild. Only the accessors named in `updateTriggers` are
    // re-evaluated. Other layers (polygon, path, text) get new instances but
    // Deck.GL sees their data/triggers unchanged → zero GPU work.
  }, [
    edgeWidthScale,
    showReplyEdges,
    showQuoteEdges,
    replyEdgeData,
    quoteEdgeData,
    scatterData,
    hullData,
    activeHullData,
    placedLabels,
    labelCharacterSet,
    hoveredPointIndex,
    isDarkMode,
    featureIsSelected,
    pointRadii,
    maxPointRadius,
    alphaScale,
    highlightIndexSet,
    onLabelClick,
    showClusterOutlines,
    activeClusterId,
    controlledViewState,
    currentViewState,
    initialZoom,
  ]);

  // OrthographicView for 2D scatter plot
  // flipY: false means y increases upward (standard Cartesian coordinates)
  const views = useMemo(() => [
    new OrthographicView({
      id: 'main',
      flipY: false,
      controller: true,
    }),
  ], []);

  // Handle view state change - keep programmatic transitions alive until they finish,
  // then release back to user-controlled interaction.
  const handleViewStateChangeWithControl = useCallback(({ viewState: newViewState, interactionState }) => {
    if (controlledViewState) {
      const isUserInteracting = Boolean(
        interactionState?.isDragging ||
        interactionState?.isPanning ||
        interactionState?.isZooming ||
        interactionState?.isRotating
      );
      const inTransition = Boolean(interactionState?.inTransition);

      if (isUserInteracting) {
        // User took over during a programmatic motion.
        setControlledViewState(null);
      } else if (inTransition) {
        // Keep feeding the interpolated frame back while transition runs.
        setControlledViewState(newViewState);
      } else {
        // Transition completed (or immediate setViewState with no transition).
        setControlledViewState(null);
      }
    }

    handleViewStateChange({ viewState: newViewState });
  }, [controlledViewState, handleViewStateChange]);

  return (
    <div className={styles.scatter} style={{ width, height, position: 'relative' }}>
      <DeckGL
        ref={deckRef}
        views={views}
        initialViewState={initialViewState}
        viewState={controlledViewState || undefined}
        onViewStateChange={handleViewStateChangeWithControl}
        layers={layers}
        onHover={handleHover}
        onClick={handleClick}
        width={width}
        height={height}
        style={{
          background: 'var(--viz-map-background, #fffcf0)',
        }}
        useDevicePixels={devicePixelRatio}
        getCursor={({ isHovering }) => isHovering ? 'pointer' : 'grab'}
      />
    </div>
  );
});

DeckGLScatter.propTypes = {
  points: PropTypes.array.isRequired, // an array of [x, y, selectionKey, activation, cluster]
  width: PropTypes.number.isRequired,
  height: PropTypes.number.isRequired,
  contentPaddingRight: PropTypes.number,
  maxZoom: PropTypes.number,
  pointScale: PropTypes.number,
  pointOpacity: PropTypes.number,
  onView: PropTypes.func,
  onSelect: PropTypes.func,
  onHover: PropTypes.func,
  onLabelClick: PropTypes.func,
  showClusterOutlines: PropTypes.bool,
  activeClusterId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  featureIsSelected: PropTypes.bool,
  linkEdges: PropTypes.array,
  showReplyEdges: PropTypes.bool,
  showQuoteEdges: PropTypes.bool,
  edgeWidthScale: PropTypes.number,
  highlightIndices: PropTypes.oneOfType([
    PropTypes.array,
    PropTypes.instanceOf(Set),
  ]),
};

export default DeckGLScatter;
