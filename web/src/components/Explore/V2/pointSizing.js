import { getEngagementScore } from '../../../lib/engagement.js';

function clamp(num, min, max) {
  return Math.min(max, Math.max(min, num));
}

function quantileSorted(sortedValues, q) {
  if (!sortedValues.length) return 0;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }
  return sortedValues[base];
}

function calculateBaseRadius(pointCount) {
  if (!pointCount) return 1.2;
  const value = 2.3 * Math.pow(5000 / pointCount, 0.25);
  return clamp(value, 0.8, 2.3);
}

function isDevBuild() {
  return typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);
}

function getZeroFloor(nonZeroBase) {
  return Math.max(1.05, nonZeroBase - 0.18);
}

function assertFloorInvariant(zeroFloor, nonZeroBase) {
  if (zeroFloor < nonZeroBase) return;
  if (isDevBuild()) {
    console.warn(
      `[pointSizing] Invariant violated: zeroFloor (${zeroFloor}) must be < nonZeroBase (${nonZeroBase}).`
    );
  }
}

export function computePointRadii(scopeRows, pointCount) {
  const minRadius = 0.5;
  const maxRadius = 12.0;
  const baseRadius = calculateBaseRadius(pointCount);
  const radii = new Float32Array(pointCount);

  if (!scopeRows || scopeRows.length === 0) {
    radii.fill(clamp(baseRadius, minRadius, maxRadius));
    return radii;
  }

  const rawImportance = new Float32Array(pointCount);
  let hasAnyEngagement = false;
  for (let i = 0; i < pointCount; i++) {
    const row = scopeRows[i] || {};
    const engagement = getEngagementScore(row);
    if (engagement > 0) hasAnyEngagement = true;
    rawImportance[i] = Math.log1p(Math.max(0, engagement));
  }

  if (!hasAnyEngagement) {
    radii.fill(clamp(baseRadius, minRadius, maxRadius));
    return radii;
  }

  const nonZeroValues = [];
  for (let i = 0; i < pointCount; i++) {
    if (rawImportance[i] > 0) nonZeroValues.push(rawImportance[i]);
  }
  nonZeroValues.sort((a, b) => a - b);

  const q10nz = nonZeroValues.length > 0 ? quantileSorted(nonZeroValues, 0.10) : 0;
  const q99nz = nonZeroValues.length > 0 ? quantileSorted(nonZeroValues, 0.99) : 1;
  const logLow = Math.log1p(q10nz > 0 ? Math.expm1(q10nz) : 0);
  const logHigh = q99nz;
  const logRange = logHigh > logLow ? logHigh - logLow : 1;

  const sizeBoost = clamp(Math.log10(5000 / Math.max(pointCount, 500)), 0, 0.7) * 1.5;
  const scale = 2.10 + sizeBoost;
  const nonZeroBase = 1.44;
  const zeroFloor = getZeroFloor(nonZeroBase);
  assertFloorInvariant(zeroFloor, nonZeroBase);

  for (let i = 0; i < pointCount; i++) {
    const imp = rawImportance[i];
    let importanceFactor;
    if (imp <= 0) {
      importanceFactor = zeroFloor;
    } else {
      const t = clamp((imp - logLow) / logRange, 0, 1);
      importanceFactor = nonZeroBase + scale * Math.pow(t, 0.85);
    }
    radii[i] = clamp(baseRadius * importanceFactor, minRadius, maxRadius);
  }

  return radii;
}

export function applyInteractionRadius(baseRadius, opts = {}) {
  const {
    isHovered = false,
    isHighlighted = false,
    featureIsSelected = false,
    isFeatureSelectedPoint = false,
    activation = 0,
  } = opts;

  let radius = baseRadius || 1.2;

  if (featureIsSelected && isFeatureSelectedPoint && activation > 0) {
    const activationBoost = 1 + Math.pow(clamp(activation, 0, 1), 0.65) * 1.35;
    radius = clamp(radius * activationBoost, 0.45, 16.0);
  }

  if (isHighlighted) {
    radius = clamp(radius * 1.35 + 0.6, 0.6, 18.0);
  }

  if (isHovered) {
    radius = clamp(radius + 2, 0.6, 18.0);
  }

  return radius;
}

