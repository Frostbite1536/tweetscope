import { getLikesCount } from './engagement';

/**
 * Normalize cluster ID to a string (or null).
 */
export function normalizeClusterId(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Build a Map of cluster → Set of all descendant cluster IDs (including self).
 */
export function buildDescendantsMap(roots) {
  const descendantsByCluster = new Map();

  const walk = (node) => {
    const nodeId = normalizeClusterId(node?.cluster);
    if (nodeId === null) return new Set();

    const descendants = new Set([nodeId]);
    const children = Array.isArray(node?.children) ? node.children : [];
    children.forEach((child) => {
      const childDescendants = walk(child);
      childDescendants.forEach((id) => descendants.add(id));
    });

    descendantsByCluster.set(nodeId, descendants);
    return descendants;
  };

  (Array.isArray(roots) ? roots : []).forEach((root) => {
    walk(root);
  });

  return descendantsByCluster;
}

// ── Module-level identity memoization ──
// WeakMap<scopeRows, WeakMap<clusterHierarchy, result>> for object keys.
// Fallback Map<scopeRows, result> for null hierarchy (WeakMap rejects null keys).
const _cache = new WeakMap();
const _nullHierarchyCache = new WeakMap(); // WeakMap<scopeRows, result>

/**
 * Build a cluster feed index: maps every cluster ID to its top-level root,
 * groups scopeRow indices by top-level cluster sorted by likes desc,
 * and computes descendants map.
 *
 * Memoized by identity: returns cached result if same array references are passed.
 *
 * @param {Array} topLevelClusters - clusterHierarchy.children
 * @param {Array} scopeRows - all scope rows
 * @param {Object} clusterHierarchy - the hierarchy object (used for identity keying)
 * @returns {{ clusterToTopLevel: Object, indicesByTopLevel: Object, descendantsByCluster: Map }}
 */
export function buildClusterFeedIndex(topLevelClusters, scopeRows, clusterHierarchy) {
  if (!topLevelClusters?.length || !scopeRows?.length) {
    return {
      clusterToTopLevel: {},
      indicesByTopLevel: {},
      descendantsByCluster: new Map(),
    };
  }

  // Check cache — null hierarchy uses a separate WeakMap<scopeRows, result>
  if (clusterHierarchy == null) {
    const cached = _nullHierarchyCache.get(scopeRows);
    if (cached) return cached;
  } else {
    const innerCache = _cache.get(scopeRows);
    if (innerCache) {
      const cached = innerCache.get(clusterHierarchy);
      if (cached) return cached;
    }
  }

  // ── Single-pass computation ──

  // 1. Walk hierarchy to map every cluster → top-level root
  const clusterToTopLevel = {};
  const walkTree = (node, rootClusterId) => {
    clusterToTopLevel[node.cluster] = rootClusterId;
    if (node.children) {
      node.children.forEach((child) => walkTree(child, rootClusterId));
    }
  };
  topLevelClusters.forEach((root) => walkTree(root, root.cluster));

  // 2. Single pass: bucket rows by top-level cluster
  const groups = {};
  topLevelClusters.forEach((root) => {
    groups[root.cluster] = [];
  });

  for (let i = 0; i < scopeRows.length; i++) {
    const row = scopeRows[i];
    if (row.deleted) continue;
    const topLevel = clusterToTopLevel[row.cluster];
    if (topLevel !== undefined && topLevel !== null && groups[topLevel]) {
      groups[topLevel].push(row);
    }
  }

  // 3. Sort each group by likes desc, extract indices
  const indicesByTopLevel = {};
  for (const [clusterId, rows] of Object.entries(groups)) {
    rows.sort((a, b) => getLikesCount(b) - getLikesCount(a));
    indicesByTopLevel[clusterId] = rows.map((r) => r.ls_index);
  }

  // 4. Build descendants map
  const descendantsByCluster = buildDescendantsMap(topLevelClusters);

  const result = { clusterToTopLevel, indicesByTopLevel, descendantsByCluster };

  // Store in cache
  if (clusterHierarchy == null) {
    _nullHierarchyCache.set(scopeRows, result);
  } else {
    let innerCache = _cache.get(scopeRows);
    if (!innerCache) {
      innerCache = new WeakMap();
      _cache.set(scopeRows, innerCache);
    }
    innerCache.set(clusterHierarchy, result);
  }

  return result;
}
