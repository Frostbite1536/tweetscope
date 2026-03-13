import { useMemo } from 'react';
import {
  FLEXOKI_CLUSTER_TONES_LIGHT,
  FLEXOKI_CLUSTER_TONES_DARK,
  getClusterToneColor,
} from '@/lib/clusterColors';

/**
 * 32-bit stable hash (FNV-1a) for deterministic hue assignment.
 */
function stableHash32(value) {
  const input = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeLabel(label) {
  return String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function stableNodeIdentity(node) {
  if (node?.cluster !== undefined && node?.cluster !== null) return String(node.cluster);
  return normalizeLabel(node?.label);
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getNodeLayer(node) {
  return toFiniteNumber(node?.layer) ?? 0;
}

function getNodeSemanticOrder(node) {
  return toFiniteNumber(node?.semantic_order);
}

function getNodeDisplayCentroid(node) {
  const x = toFiniteNumber(node?.display_centroid_x ?? node?.centroid_x);
  const y = toFiniteNumber(node?.display_centroid_y ?? node?.centroid_y);
  if (x === null || y === null) return null;
  return [x, y];
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function collectTreeNodes(roots) {
  const nodeMap = new Map();

  const visit = (node) => {
    if (!node) return;
    const nodeId = String(node.cluster);
    if (nodeMap.has(nodeId)) return;
    nodeMap.set(nodeId, node);
    if (node.children && node.children.length > 0) {
      node.children.forEach(visit);
    }
  };

  roots.forEach(visit);
  return nodeMap;
}

function findBestHueLayer(nodes, targetCount) {
  const byLayer = new Map();
  nodes.forEach((node) => {
    const layer = getNodeLayer(node);
    const current = byLayer.get(layer) ?? [];
    current.push(node);
    byLayer.set(layer, current);
  });

  let bestLayer = null;
  let bestNodes = [];
  let bestScore = Number.POSITIVE_INFINITY;
  let bestHasEnough = false;

  Array.from(byLayer.entries())
    .sort((a, b) => b[0] - a[0])
    .forEach(([layer, layerNodes]) => {
      const count = layerNodes.length;
      const score = Math.abs(count - targetCount);
      const hasEnough = count >= targetCount;
      if (
        bestLayer === null ||
        score < bestScore ||
        (score === bestScore && hasEnough && !bestHasEnough) ||
        (score === bestScore && hasEnough === bestHasEnough && layer > bestLayer)
      ) {
        bestLayer = layer;
        bestNodes = layerNodes;
        bestScore = score;
        bestHasEnough = hasEnough;
      }
    });

  return { layer: bestLayer, nodes: bestNodes };
}

function orderHueNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [];
  }

  const semanticReady = nodes.filter((node) => getNodeSemanticOrder(node) !== null);
  if (semanticReady.length === nodes.length) {
    return [...nodes].sort((a, b) => {
      const orderDiff = getNodeSemanticOrder(a) - getNodeSemanticOrder(b);
      if (orderDiff !== 0) return orderDiff;
      return stableNodeIdentity(a).localeCompare(stableNodeIdentity(b));
    });
  }

  const geometricReady = nodes.filter((node) => getNodeDisplayCentroid(node) !== null);
  if (geometricReady.length === nodes.length) {
    const cx =
      geometricReady.reduce((sum, node) => sum + getNodeDisplayCentroid(node)[0], 0) /
      geometricReady.length;
    const cy =
      geometricReady.reduce((sum, node) => sum + getNodeDisplayCentroid(node)[1], 0) /
      geometricReady.length;

    return [...nodes].sort((a, b) => {
      const [ax, ay] = getNodeDisplayCentroid(a);
      const [bx, by] = getNodeDisplayCentroid(b);
      const angleDiff = Math.atan2(ay - cy, ax - cx) - Math.atan2(by - cy, bx - cx);
      if (angleDiff !== 0) return angleDiff;
      return stableNodeIdentity(a).localeCompare(stableNodeIdentity(b));
    });
  }

  return [...nodes]
    .map((node) => {
      const nodeId = String(node?.cluster ?? stableNodeIdentity(node));
      const hash = stableHash32(stableNodeIdentity(node));
      return { node, nodeId, hash };
    })
    .sort((a, b) => (a.hash - b.hash) || a.nodeId.localeCompare(b.nodeId))
    .map((entry) => entry.node);
}

function spreadOrderedNodesAcrossHues(orderedNodes, hueCount) {
  const hueByCluster = new Map();
  const total = orderedNodes.length;
  if (total === 0 || hueCount <= 0) return hueByCluster;

  orderedNodes.forEach((entry, idx) => {
    const node = entry?.node ?? entry;
    const nodeId = String(node.cluster);
    let hueIdx = 0;
    if (total === 1) {
      hueIdx = 0;
    } else if (total <= hueCount) {
      hueIdx = Math.round((idx * (hueCount - 1)) / (total - 1));
    } else {
      hueIdx = Math.min(hueCount - 1, Math.floor((idx * hueCount) / total));
    }
    hueByCluster.set(nodeId, hueIdx);
  });

  return hueByCluster;
}

function toneIndexForNode(node, hueLayer, toneCount) {
  const baseTone = Math.min(3, toneCount - 1);
  const layer = getNodeLayer(node);
  const specificity = toFiniteNumber(node?.topic_specificity);
  const specificityShift =
    specificity === null
      ? 0
      : specificity >= 0.75
        ? 1
        : specificity <= 0.3
          ? -1
          : 0;

  if (layer < hueLayer) {
    return clampInt(baseTone + (hueLayer - layer) + Math.max(0, specificityShift), 0, toneCount - 1);
  }

  if (layer > hueLayer) {
    return clampInt(baseTone - (layer - hueLayer), 0, toneCount - 1);
  }

  return clampInt(baseTone + specificityShift, 0, toneCount - 1);
}

function setNodeColor(colorMap, hueByCluster, node, hueLayer, toneCount) {
  const nodeId = String(node.cluster);
  const hueIdx = hueByCluster.get(nodeId);
  if (hueIdx === undefined) return;
  const toneIdx = toneIndexForNode(node, hueLayer, toneCount);
  colorMap.set(nodeId, {
    light: FLEXOKI_CLUSTER_TONES_LIGHT[toneIdx][hueIdx],
    dark: FLEXOKI_CLUSTER_TONES_DARK[toneIdx][hueIdx],
  });
}

/**
 * Hierarchy-aware cluster color assignment.
 *
 * Finds the hierarchy layer whose node count is closest to the available
 * Flexoki hue count, orders that layer semantically when possible, and
 * assigns hues there. Descendants inherit hue family with tone derived from
 * depth/specificity. Ancestors receive the averaged hue family of their
 * colored descendants.
 *
 * When no hierarchy is available, returns null -> callers use the default
 * index-based Flexoki palette.
 */
export function useClusterColors(clusterLabels, clusterHierarchy) {
  return useMemo(() => {
    if (!clusterHierarchy || !clusterHierarchy.children || clusterHierarchy.children.length === 0) {
      return { colorMap: null };
    }

    const roots = clusterHierarchy.children;
    const hueCount = FLEXOKI_CLUSTER_TONES_LIGHT[0].length; // 8
    const toneCount = FLEXOKI_CLUSTER_TONES_LIGHT.length; // 6

    // Filter out the "unknown" / "Unclustered" pseudo-cluster.
    const realRoots = roots.filter((root) => String(root.cluster) !== 'unknown');
    if (realRoots.length === 0) return { colorMap: null };

    const colorMap = new Map();
    const allRealNodes = Array.from(collectTreeNodes(realRoots).values()).filter(
      (node) => String(node.cluster) !== 'unknown'
    );
    if (allRealNodes.length === 0) return { colorMap: null };

    const { layer: hueLayer, nodes: rawHueNodes } = findBestHueLayer(allRealNodes, hueCount);
    if (hueLayer === null || rawHueNodes.length === 0) return { colorMap: null };

    const orderedHueNodes = orderHueNodes(rawHueNodes);
    const hueByCluster = spreadOrderedNodesAcrossHues(orderedHueNodes, hueCount);

    // First pass: assign hue families from the selected semantic layer downward.
    const assignDescendantColors = (node, inheritedHue) => {
      const nodeId = String(node.cluster);
      const ownHue = hueByCluster.get(nodeId);
      const activeHue = ownHue ?? inheritedHue;

      if (activeHue !== undefined) {
        hueByCluster.set(nodeId, activeHue);
        setNodeColor(colorMap, hueByCluster, node, hueLayer, toneCount);
      }

      if (node.children && node.children.length > 0) {
        node.children.forEach((child) => assignDescendantColors(child, activeHue));
      }
    };

    realRoots.forEach((root) => assignDescendantColors(root, undefined));

    // Second pass: assign ancestors from the mean of their colored descendants.
    const assignAncestorColors = (node) => {
      const nodeId = String(node.cluster);
      if (node.children && node.children.length > 0) {
        const childHues = node.children
          .map((child) => assignAncestorColors(child))
          .filter((value) => value !== undefined);

        if (!hueByCluster.has(nodeId) && childHues.length > 0) {
          const hueIdx = Math.round(
            childHues.reduce((sum, value) => sum + value, 0) / childHues.length
          );
          hueByCluster.set(nodeId, clampInt(hueIdx, 0, hueCount - 1));
        }
      }

      if (hueByCluster.has(nodeId)) {
        setNodeColor(colorMap, hueByCluster, node, hueLayer, toneCount);
      }
      return hueByCluster.get(nodeId);
    };

    realRoots.forEach(assignAncestorColors);

    return { colorMap };
  }, [clusterLabels, clusterHierarchy]);
}

/**
 * Look up a cluster's color from the hierarchy-aware map, falling back
 * to the default palette when the map doesn't have an entry.
 */
export function resolveClusterColor(colorMap, clusterId, isDarkMode) {
  if (colorMap) {
    const entry = colorMap.get(String(clusterId));
    if (entry) {
      return isDarkMode ? entry.dark : entry.light;
    }
  }
  return getClusterToneColor(clusterId, isDarkMode);
}

// Convenience helpers for UI components.
const toRgbaString = (rgb, alpha = 1) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;

/**
 * Drop-in replacement for getClusterColorCSS that respects hierarchy.
 */
export function resolveClusterColorCSS(colorMap, clusterId, isDarkMode, alpha = 1) {
  return toRgbaString(resolveClusterColor(colorMap, clusterId, isDarkMode), alpha);
}

/**
 * Drop-in replacement for getClusterColorRGBA that respects hierarchy.
 */
export function resolveClusterColorRGBA(colorMap, clusterId, isDarkMode, alpha = 255) {
  const rgb = resolveClusterColor(colorMap, clusterId, isDarkMode);
  return [rgb[0], rgb[1], rgb[2], alpha];
}
