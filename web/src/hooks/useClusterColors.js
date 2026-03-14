import { useMemo } from 'react';
import {
  FLEXOKI_CLUSTER_TONES_LIGHT,
  FLEXOKI_CLUSTER_TONES_DARK,
  getClusterToneColor,
} from '../lib/clusterColors.js';

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

function spreadIndices(count, min, max) {
  if (count <= 0) return [];
  if (count === 1) return [Math.round((min + max) / 2)];

  const result = [];
  const span = max - min;
  for (let idx = 0; idx < count; idx += 1) {
    result.push(Math.round(min + (idx * span) / (count - 1)));
  }
  return result;
}

function siblingToneIndices(count, toneCount) {
  if (count <= 0) return [];
  if (count === 1) {
    return [Math.min(3, toneCount - 1)];
  }

  const safeMin = Math.min(1, toneCount - 1);
  const safeMax = Math.max(safeMin, toneCount - 2);
  const safeSpan = safeMax - safeMin + 1;

  if (count <= safeSpan) {
    return spreadIndices(count, safeMin, safeMax);
  }

  return spreadIndices(Math.min(count, toneCount), 0, toneCount - 1);
}

function familyHueBands(familyHue, hueCount, bandCount) {
  const preferredOffsets = [0, -1, 1, -2, 2];
  const result = [];

  preferredOffsets.forEach((offset) => {
    if (result.length >= bandCount) return;
    const hueIdx = familyHue + offset;
    if (hueIdx < 0 || hueIdx >= hueCount) return;
    if (!result.includes(hueIdx)) {
      result.push(hueIdx);
    }
  });

  while (result.length < bandCount) {
    result.push(clampInt(familyHue, 0, hueCount - 1));
  }

  return result;
}

export function buildSiblingVariants(count, familyHue, hueCount, toneCount) {
  if (count <= 0) return [];

  const maxHueBands = 5;
  const neededBands = Math.ceil(count / toneCount);
  const bandCount = Math.min(neededBands, maxHueBands);
  const hueBands = familyHueBands(familyHue, hueCount, bandCount);

  const variants = [];
  let remaining = count;

  for (let bandIdx = 0; bandIdx < hueBands.length && remaining > 0; bandIdx += 1) {
    const slotCount = Math.min(remaining, toneCount);
    const toneIndices = siblingToneIndices(slotCount, toneCount);
    toneIndices.forEach((toneIdx) => {
      variants.push({
        hueIdx: hueBands[bandIdx],
        toneIdx,
      });
    });
    remaining -= slotCount;
  }

  while (variants.length < count) {
    const slotCount = Math.min(count - variants.length, toneCount);
    const toneIndices = siblingToneIndices(slotCount, toneCount);
    toneIndices.forEach((toneIdx) => {
      variants.push({
        hueIdx: clampInt(familyHue, 0, hueCount - 1),
        toneIdx,
      });
    });
  }

  return variants.slice(0, count);
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

function getByLayer(nodes) {
  const byLayer = new Map();
  nodes.forEach((node) => {
    const layer = getNodeLayer(node);
    const current = byLayer.get(layer) ?? [];
    current.push(node);
    byLayer.set(layer, current);
  });
  return byLayer;
}

export function selectColorAnchorLayer(nodes, targetCount, preferredMin = 4, preferredMax = 10) {
  const byLayer = getByLayer(nodes);
  const candidates = Array.from(byLayer.entries()).map(([layer, layerNodes]) => ({
    layer,
    nodes: layerNodes,
    count: layerNodes.length,
    targetDistance: Math.abs(layerNodes.length - targetCount),
  }));

  if (candidates.length === 0) {
    return { layer: null, nodes: [] };
  }

  const preferred = candidates.filter(
    (candidate) => candidate.count >= preferredMin && candidate.count <= preferredMax
  );
  const pool = preferred.length > 0 ? preferred : candidates;

  pool.sort((a, b) => {
    if (preferred.length > 0) {
      const layerDiff = b.layer - a.layer;
      if (layerDiff !== 0) return layerDiff;
      const targetDiff = a.targetDistance - b.targetDistance;
      if (targetDiff !== 0) return targetDiff;
      return a.count - b.count;
    }

    const targetDiff = a.targetDistance - b.targetDistance;
    if (targetDiff !== 0) return targetDiff;
    const layerDiff = b.layer - a.layer;
    if (layerDiff !== 0) return layerDiff;
    return a.count - b.count;
  });

  return { layer: pool[0].layer, nodes: pool[0].nodes };
}

export function selectHierarchyColorAnchor(
  clusterHierarchy,
  targetCount,
  preferredMin = 4,
  preferredMax = 10
) {
  if (!clusterHierarchy || !clusterHierarchy.children || clusterHierarchy.children.length === 0) {
    return { layer: null, nodes: [], realRoots: [], connectedNodeIds: new Set() };
  }

  const roots = clusterHierarchy.children;
  const realRoots = roots.filter((root) => String(root.cluster) !== 'unknown');
  if (realRoots.length === 0) {
    return { layer: null, nodes: [], realRoots: [], connectedNodeIds: new Set() };
  }

  const maxRootLayer = Math.max(...realRoots.map((root) => getNodeLayer(root)));
  const topLayerRoots = realRoots.filter((root) => getNodeLayer(root) === maxRootLayer);
  const connectedRoots = topLayerRoots.length > 0 ? topLayerRoots : realRoots;
  const connectedNodeMap = collectTreeNodes(connectedRoots);
  const connectedNodes = Array.from(connectedNodeMap.values()).filter(
    (node) => String(node.cluster) !== 'unknown'
  );
  const allRealNodes = Array.from(collectTreeNodes(realRoots).values()).filter(
    (node) => String(node.cluster) !== 'unknown'
  );
  const anchorCandidateNodes = connectedNodes.length > 0 ? connectedNodes : allRealNodes;
  const selection = selectColorAnchorLayer(
    anchorCandidateNodes,
    targetCount,
    preferredMin,
    preferredMax
  );

  return {
    ...selection,
    realRoots,
    connectedNodeIds: new Set(connectedNodeMap.keys()),
  };
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

function setVariantColor(colorMap, node, hueIdx, toneIdx) {
  colorMap.set(String(node.cluster), {
    light: FLEXOKI_CLUSTER_TONES_LIGHT[toneIdx][hueIdx],
    dark: FLEXOKI_CLUSTER_TONES_DARK[toneIdx][hueIdx],
  });
}

export function buildHierarchyColorMap(clusterHierarchy) {
  const hueCount = FLEXOKI_CLUSTER_TONES_LIGHT[0].length; // 8
  const toneCount = FLEXOKI_CLUSTER_TONES_LIGHT.length; // 6

  const { layer: hueLayer, nodes: rawHueNodes, realRoots, connectedNodeIds } =
    selectHierarchyColorAnchor(clusterHierarchy, hueCount);
  if (realRoots.length === 0) return null;

  const colorMap = new Map();
  if (hueLayer === null || rawHueNodes.length === 0) return null;

  const orderedHueNodes = orderHueNodes(rawHueNodes);
  const hueByCluster = spreadOrderedNodesAcrossHues(orderedHueNodes, hueCount);

  // First pass: assign stable family hues from the selected semantic layer downward.
  const assignDescendantFamilies = (node, inheritedHue) => {
    const nodeId = String(node.cluster);
    const ownHue = hueByCluster.get(nodeId);
    const activeHue = ownHue ?? inheritedHue;

    if (activeHue !== undefined) {
      hueByCluster.set(nodeId, activeHue);
    }

    if (node.children && node.children.length > 0) {
      node.children.forEach((child) => assignDescendantFamilies(child, activeHue));
    }
  };

  realRoots.forEach((root) => assignDescendantFamilies(root, undefined));

  // Second pass: backfill ancestors from the mean family hue of their descendants.
  const assignAncestorFamilies = (node) => {
    const nodeId = String(node.cluster);
    if (node.children && node.children.length > 0) {
      const childHues = node.children
        .map((child) => assignAncestorFamilies(child))
        .filter((value) => value !== undefined);

      if (!hueByCluster.has(nodeId) && childHues.length > 0) {
        const hueIdx = Math.round(
          childHues.reduce((sum, value) => sum + value, 0) / childHues.length
        );
        hueByCluster.set(nodeId, clampInt(hueIdx, 0, hueCount - 1));
      }
    }

    return hueByCluster.get(nodeId);
  };

  realRoots.forEach(assignAncestorFamilies);

  const disconnectedRoots = realRoots.filter((root) => !connectedNodeIds.has(String(root.cluster)));
  if (disconnectedRoots.length > 0) {
    const orderedDisconnectedRoots = orderHueNodes(disconnectedRoots);
    const usedHues = new Set(hueByCluster.values());
    const availableHues = [];

    for (let hueIdx = 0; hueIdx < hueCount; hueIdx += 1) {
      if (!usedHues.has(hueIdx)) {
        availableHues.push(hueIdx);
      }
    }
    for (let hueIdx = 0; hueIdx < hueCount; hueIdx += 1) {
      if (availableHues.length >= hueCount) break;
      if (!availableHues.includes(hueIdx)) {
        availableHues.push(hueIdx);
      }
    }

    orderedDisconnectedRoots.forEach((root, idx) => {
      const rootHue = availableHues[idx % availableHues.length];
      hueByCluster.set(String(root.cluster), rootHue);
      assignDescendantFamilies(root, rootHue);
    });
  }

  // Final pass: resolve each node to an actual family-local color variant.
  const assignResolvedColors = (node, assignedVariant = null) => {
    const nodeId = String(node.cluster);
    const familyHue = hueByCluster.get(nodeId);
    if (familyHue === undefined) return;

    const baseToneIdx = toneIndexForNode(node, hueLayer, toneCount);
    const toneIdx = assignedVariant?.toneIdx ?? baseToneIdx;
    const hueIdx = assignedVariant?.hueIdx ?? familyHue;
    setVariantColor(colorMap, node, hueIdx, toneIdx);

    if (!node.children || node.children.length === 0) return;

    const childrenByFamily = new Map();
    node.children.forEach((child) => {
      const childId = String(child.cluster);
      const childFamilyHue = hueByCluster.get(childId);
      const activeFamilyHue = childFamilyHue ?? familyHue;
      const current = childrenByFamily.get(activeFamilyHue) ?? [];
      current.push(child);
      childrenByFamily.set(activeFamilyHue, current);
    });

    childrenByFamily.forEach((familyChildren, childFamilyHue) => {
      const orderedChildren = orderHueNodes(familyChildren);
      if (orderedChildren.length === 1) {
        const child = orderedChildren[0];
        assignResolvedColors(child, {
          hueIdx: childFamilyHue,
          toneIdx: toneIndexForNode(child, hueLayer, toneCount),
        });
        return;
      }

      const variants = buildSiblingVariants(
        orderedChildren.length,
        childFamilyHue,
        hueCount,
        toneCount
      );
      orderedChildren.forEach((child, idx) => {
        assignResolvedColors(child, variants[idx]);
      });
    });
  };

  realRoots.forEach((root) => assignResolvedColors(root));

  return colorMap;
}

/**
 * Hierarchy-aware cluster color assignment.
 *
 * Chooses a connected anchor layer in the preferred browse band when possible,
 * orders that layer semantically when possible, and assigns hues there.
 * Descendants inherit hue family with local sibling variation. Ancestors
 * receive the averaged hue family of their colored descendants.
 *
 * When no hierarchy is available, returns null -> callers use the default
 * index-based Flexoki palette.
 */
export function useClusterColors(clusterLabels, clusterHierarchy) {
  return useMemo(() => {
    return { colorMap: buildHierarchyColorMap(clusterHierarchy) };
  }, [clusterHierarchy]);
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
