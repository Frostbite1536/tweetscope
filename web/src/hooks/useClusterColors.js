import { useMemo } from 'react';
import {
  FLEXOKI_CLUSTER_TONES_LIGHT,
  FLEXOKI_CLUSTER_TONES_DARK,
  getClusterToneColor,
} from '@/lib/clusterColors';

/**
 * Find the tree depth whose node count is closest to (but ideally >= )
 * the target count. This is where we assign hue columns.
 */
function findBestHueLayer(roots, targetCount) {
  let current = roots;
  let bestDepth = 0;
  let bestNodes = current;
  let bestScore = Math.abs(current.length - targetCount);

  for (let depth = 1; depth < 10; depth += 1) {
    const next = [];
    for (const node of current) {
      if (node.children && node.children.length > 0) {
        next.push(...node.children);
      }
    }
    if (next.length === 0) break;

    const score = Math.abs(next.length - targetCount);
    // Prefer layers >= targetCount, but accept fewer if closer
    if (score < bestScore || (next.length >= targetCount && bestNodes.length < targetCount)) {
      bestScore = score;
      bestDepth = depth;
      bestNodes = next;
    }
    current = next;
  }

  return { depth: bestDepth, nodes: bestNodes };
}

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

/**
 * Deterministic top-level hue allocator.
 * - Stable across sibling order changes.
 * - Tries to avoid collisions when root count <= hue count.
 * - `persistentCacheKey` can be used as a stable salt/version key.
 */
export function assignTopLevelHuesStable(topLevelNodes, hueCount, persistentCacheKey = '') {
  if (!Array.isArray(topLevelNodes) || topLevelNodes.length === 0 || hueCount <= 0) {
    return new Map();
  }

  const ordered = topLevelNodes
    .map((node) => {
      const nodeId = String(node?.cluster ?? stableNodeIdentity(node));
      const hash = stableHash32(`${persistentCacheKey}:${stableNodeIdentity(node)}`);
      return { nodeId, hash };
    })
    .sort((a, b) => (a.hash - b.hash) || a.nodeId.localeCompare(b.nodeId));

  const next = new Map();
  const used = new Set();

  for (const entry of ordered) {
    const preferred = entry.hash % hueCount;
    let hueIdx = preferred;

    if (topLevelNodes.length <= hueCount) {
      const step = ((entry.hash >>> 5) % Math.max(hueCount - 1, 1)) + 1;
      while (used.has(hueIdx)) {
        hueIdx = (hueIdx + step) % hueCount;
      }
      used.add(hueIdx);
    }

    next.set(entry.nodeId, hueIdx);
  }

  return next;
}

/**
 * Recursively collect all ancestor cluster IDs going up from a depth.
 * (Walk upward by finding parents of the hue-layer nodes.)
 */
function assignAncestorColors(roots, colorMap, seedClusterToHue, toneCount) {
  const clusterToHue = new Map(seedClusterToHue);

  // Walk the full tree and assign ancestors the hue of their first hue-layer descendant
  function walkUp(node) {
    const nodeId = String(node.cluster);
    if (clusterToHue.has(nodeId)) return clusterToHue.get(nodeId);

    if (node.children && node.children.length > 0) {
      // Take the hue of the first child that has one
      for (const child of node.children) {
        const childHue = walkUp(child);
        if (childHue !== undefined) {
          clusterToHue.set(nodeId, childHue);
          // Assign a muted middle tone for ancestor nodes
          const toneIdx = Math.floor(toneCount / 2);
          if (!colorMap.has(nodeId)) {
            colorMap.set(nodeId, {
              light: FLEXOKI_CLUSTER_TONES_LIGHT[toneIdx][childHue],
              dark: FLEXOKI_CLUSTER_TONES_DARK[toneIdx][childHue],
            });
          }
          return childHue;
        }
      }
    }
    return undefined;
  }

  for (const root of roots) {
    walkUp(root);
  }
}

/**
 * Hierarchy-aware cluster color assignment.
 *
 * Finds the tree layer closest to 8 nodes (the number of Flexoki hue
 * columns) and assigns hues there. Children below that layer get tonal
 * variations within their ancestor's hue. Ancestors above get their
 * first child's hue at a middle tone.
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

    // Stable top-level hue anchors (independent of likes/count ordering).
    const stableSalt = `${clusterHierarchy?.totalClusters ?? ''}:${clusterLabels?.length ?? 0}`;
    const topLevelHueMap = assignTopLevelHuesStable(realRoots, hueCount, stableSalt);

    // Build node -> top-level root mapping so deeper hue-layer nodes inherit
    // the same hue family as their top-level ancestor.
    const nodeToTopRoot = new Map();
    const indexTopRoot = (node, topRootId) => {
      const nodeId = String(node.cluster);
      nodeToTopRoot.set(nodeId, topRootId);
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          indexTopRoot(child, topRootId);
        }
      }
    };
    for (const root of realRoots) {
      const rootId = String(root.cluster);
      indexTopRoot(root, rootId);
    }

    // Find the best layer for hue assignment (closest to 8 nodes).
    const { nodes: hueNodes } = findBestHueLayer(realRoots, hueCount);

    const colorMap = new Map();
    const hueByCluster = new Map();
    const hueUsage = new Map();

    // Assign hue-layer nodes using stable top-level anchors.
    hueNodes.forEach((node, idx) => {
      const nodeId = String(node.cluster);
      const topRootId = nodeToTopRoot.get(nodeId) ?? nodeId;
      const fallbackHue = idx % hueCount;
      const hueIdx = topLevelHueMap.get(topRootId) ?? fallbackHue;

      const toneOffset = hueUsage.get(hueIdx) ?? 0;
      hueUsage.set(hueIdx, toneOffset + 1);

      // Hue-layer nodes get the canonical mid tone (row 3 = scale 600 light).
      const baseTone = (3 + toneOffset) % toneCount;

      hueByCluster.set(nodeId, hueIdx);
      colorMap.set(nodeId, {
        light: FLEXOKI_CLUSTER_TONES_LIGHT[baseTone][hueIdx],
        dark: FLEXOKI_CLUSTER_TONES_DARK[baseTone][hueIdx],
      });

      // Assign all descendants: spread across tone rows within same hue.
      const descendants = [];
      function collectAll(n) {
        if (n.children) {
          for (const child of n.children) {
            descendants.push(child);
            collectAll(child);
          }
        }
      }
      collectAll(node);

      descendants.forEach((desc, descIdx) => {
        const descId = String(desc.cluster);
        // Spread across tones, skipping the parent's tone for distinction.
        const toneIdx = (descIdx + (descIdx >= baseTone ? 1 : 0)) % toneCount;
        hueByCluster.set(descId, hueIdx);
        colorMap.set(descId, {
          light: FLEXOKI_CLUSTER_TONES_LIGHT[toneIdx][hueIdx],
          dark: FLEXOKI_CLUSTER_TONES_DARK[toneIdx][hueIdx],
        });
      });
    });

    // Assign ancestors above the hue layer.
    assignAncestorColors(roots, colorMap, hueByCluster, toneCount);

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
