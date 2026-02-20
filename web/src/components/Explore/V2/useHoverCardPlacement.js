import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_MARGIN = 12;
const DEFAULT_OFFSET = 24;
const DEFAULT_PREFERRED_WIDTH = 360;
const DEFAULT_MIN_WIDTH = 200;
const DEFAULT_FALLBACK_HEIGHT = 280;
const HYSTERESIS_BONUS = 72;
const DEFAULT_ANCHOR_CLEARANCE = 30;

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function intersectionArea(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return width * height;
}

function distancePointToRect(x, y, rect) {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

function clampRect(rect, safeRect) {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;

  const left = clamp(rect.left, safeRect.left, safeRect.right - width);
  const top = clamp(rect.top, safeRect.top, safeRect.bottom - height);
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
}

function placementToTransformOrigin(key) {
  const horizontal = key.includes('w') ? 'right' : key.includes('e') ? 'left' : 'center';
  const vertical = key.includes('n') ? 'bottom' : key.includes('s') ? 'top' : 'center';
  return `${horizontal} ${vertical}`;
}

function buildCandidates(anchorX, anchorY, width, height, offset) {
  return [
    { key: 'se', left: anchorX + offset, top: anchorY + offset },
    { key: 'sw', left: anchorX - width - offset, top: anchorY + offset },
    { key: 'ne', left: anchorX + offset, top: anchorY - height - offset },
    { key: 'nw', left: anchorX - width - offset, top: anchorY - height - offset },
  ];
}

export default function useHoverCardPlacement({
  enabled,
  anchor,
  viewportWidth,
  viewportHeight,
  contentPaddingRight = 0,
  exclusionZones = [],
  margin = DEFAULT_MARGIN,
  offset = DEFAULT_OFFSET,
  preferredWidth = DEFAULT_PREFERRED_WIDTH,
  minWidth = DEFAULT_MIN_WIDTH,
  fallbackHeight = DEFAULT_FALLBACK_HEIGHT,
  anchorClearance = DEFAULT_ANCHOR_CLEARANCE,
}) {
  const [cardNode, setCardNode] = useState(null);
  const [measuredSize, setMeasuredSize] = useState({
    width: preferredWidth,
    height: fallbackHeight,
  });

  const pendingSizeRef = useRef(null);
  const resizeRafRef = useRef(null);
  const lastPlacementRef = useRef(null);

  const cardRef = useCallback((node) => {
    setCardNode(node);
  }, []);

  useEffect(() => {
    if (!cardNode || typeof ResizeObserver === 'undefined') return;

    const applyPendingSize = () => {
      resizeRafRef.current = null;
      const pending = pendingSizeRef.current;
      if (!pending) return;
      pendingSizeRef.current = null;
      setMeasuredSize((prev) => {
        if (Math.abs(prev.width - pending.width) < 0.5 && Math.abs(prev.height - pending.height) < 0.5) {
          return prev;
        }
        return pending;
      });
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries?.[0];
      if (!entry?.contentRect) return;
      pendingSizeRef.current = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      if (resizeRafRef.current === null) {
        resizeRafRef.current = window.requestAnimationFrame(applyPendingSize);
      }
    });

    observer.observe(cardNode);
    return () => {
      observer.disconnect();
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      pendingSizeRef.current = null;
    };
  }, [cardNode]);

  const safeRect = useMemo(() => {
    const visibleWidth = Math.max(320, viewportWidth - contentPaddingRight);
    const left = margin;
    const top = margin;
    const right = Math.max(left + 1, visibleWidth - margin);
    const bottom = Math.max(top + 1, viewportHeight - margin);
    return { left, top, right, bottom };
  }, [viewportWidth, viewportHeight, contentPaddingRight, margin]);

  const cardWidth = useMemo(() => {
    const maxWidth = Math.max(120, safeRect.right - safeRect.left);
    const target = Math.min(preferredWidth, maxWidth);
    return Math.max(Math.min(target, maxWidth), Math.min(minWidth, maxWidth));
  }, [preferredWidth, minWidth, safeRect]);

  const cardHeight = useMemo(() => {
    const height = Number(measuredSize?.height);
    if (Number.isFinite(height) && height > 0) return height;
    return fallbackHeight;
  }, [measuredSize, fallbackHeight]);

  const normalizedExclusionZones = useMemo(() => {
    if (!Array.isArray(exclusionZones) || exclusionZones.length === 0) return [];

    const zones = [];
    for (const zone of exclusionZones) {
      if (!zone) continue;
      const left = Number(zone.left);
      const top = Number(zone.top);
      const right = Number(zone.right);
      const bottom = Number(zone.bottom);
      if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
        continue;
      }
      const clamped = {
        left: clamp(left, safeRect.left, safeRect.right),
        top: clamp(top, safeRect.top, safeRect.bottom),
        right: clamp(right, safeRect.left, safeRect.right),
        bottom: clamp(bottom, safeRect.top, safeRect.bottom),
      };
      if (clamped.right > clamped.left && clamped.bottom > clamped.top) {
        zones.push(clamped);
      }
    }
    return zones;
  }, [exclusionZones, safeRect]);

  const position = useMemo(() => {
    if (!enabled) {
      lastPlacementRef.current = null;
      return null;
    }

    const anchorX = Number.isFinite(anchor?.x) ? anchor.x : safeRect.left + cardWidth / 2;
    const anchorY = Number.isFinite(anchor?.y) ? anchor.y : safeRect.top + 24;
    const candidates = buildCandidates(anchorX, anchorY, cardWidth, cardHeight, offset);

    let best = null;
    for (const candidate of candidates) {
      const rect = {
        left: candidate.left,
        top: candidate.top,
        right: candidate.left + cardWidth,
        bottom: candidate.top + cardHeight,
      };
      const clamped = clampRect(rect, safeRect);

      const clampDistance =
        Math.abs(rect.left - clamped.left) +
        Math.abs(rect.top - clamped.top) +
        Math.abs(rect.right - clamped.right) +
        Math.abs(rect.bottom - clamped.bottom);

      let overlapArea = 0;
      for (const zone of normalizedExclusionZones) {
        overlapArea += intersectionArea(clamped, zone);
      }

      const centerX = (clamped.left + clamped.right) / 2;
      const centerY = (clamped.top + clamped.bottom) / 2;
      const anchorDistance = Math.abs(centerX - anchorX) + Math.abs(centerY - anchorY);
      const anchorGap = distancePointToRect(anchorX, anchorY, clamped);
      const anchorPenalty = anchorGap < anchorClearance
        ? (anchorClearance - anchorGap) * 1200
        : 0;

      let score =
        -(clampDistance * 80) -
        overlapArea / 10 -
        anchorDistance * 0.6 -
        anchorPenalty;

      if (candidate.key === lastPlacementRef.current) {
        score += HYSTERESIS_BONUS;
      }

      if (!best || score > best.score) {
        best = {
          key: candidate.key,
          rect: clamped,
          score,
        };
      }
    }

    const chosen = best || {
      key: 'se',
      rect: clampRect(
        {
          left: anchorX + offset,
          top: anchorY + offset,
          right: anchorX + offset + cardWidth,
          bottom: anchorY + offset + cardHeight,
        },
        safeRect
      ),
    };

    lastPlacementRef.current = chosen.key;
    return {
      left: chosen.rect.left,
      top: chosen.rect.top,
      width: cardWidth,
      placement: chosen.key,
      transformOrigin: placementToTransformOrigin(chosen.key),
    };
  }, [
    enabled,
    anchor?.x,
    anchor?.y,
    safeRect,
    cardWidth,
    cardHeight,
    offset,
    anchorClearance,
    normalizedExclusionZones,
  ]);

  return {
    cardRef,
    position,
  };
}
