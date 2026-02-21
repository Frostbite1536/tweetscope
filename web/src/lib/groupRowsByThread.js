/**
 * Groups a flat array of scope rows into standalone items and thread groups
 * using thread metadata from the nodeStats map.
 *
 * @param {Array} rows - Flat array of scope rows (from dataTableRows or carousel tweets)
 * @param {Map} nodeStats - Map<ls_index, NodeStatsEntry> from useNodeStats
 * @returns {Array<Item>} where Item is one of:
 *   { type: 'standalone', row, hasMissingAncestors: boolean, missingAncestorCount: number, threadRootId: string|null, threadDepth: number, globalThreadSize: number, isThreadMember: boolean }
 *   { type: 'thread', threadRootId: string, rows: Array, visibleCount: number, globalThreadSize: number, hasMissingAncestors: boolean, missingAncestorCount: number }
 */
function normalizeThreadRootId(value) {
  if (!value || value === 'None') return null;
  return String(value);
}

function normalizeNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const normalized = Math.trunc(n);
  return normalized >= 0 ? normalized : fallback;
}

function shouldBundleVisibleBucket(bucket, rootId) {
  if (!bucket || bucket.length < 2 || !rootId) return false;

  const hasVisibleInternalRoot = bucket.some((meta) => meta.tweetId === rootId);
  if (hasVisibleInternalRoot) return true;

  // Guard against false "mega-thread" bundles where multiple independent
  // depth-1 replies target the same external root id.
  return bucket.some((meta) => meta.depth > 1);
}

export function groupRowsByThread(rows, nodeStats) {
  if (!rows || rows.length === 0) return [];
  if (!nodeStats || !(nodeStats instanceof Map) || nodeStats.size === 0) {
    return rows.map((row) => ({
      type: 'standalone',
      row,
      hasMissingAncestors: false,
      missingAncestorCount: 0,
      threadRootId: null,
      threadDepth: 0,
      globalThreadSize: 1,
      isThreadMember: false,
    }));
  }

  // Single-pass bucketing: group rows by threadRootId
  const buckets = new Map(); // rootId → [{row, depth, tweetId}]
  const rowMeta = []; // parallel array for iteration order

  for (const row of rows) {
    const stats = nodeStats.get(row.ls_index);
    const rootId = normalizeThreadRootId(stats?.threadRootId);
    const depth = normalizeNonNegativeInt(stats?.threadDepth, 0);
    const threadSize = Math.max(1, normalizeNonNegativeInt(stats?.threadSize, 1));
    const tweetId = stats?.tweetId ? String(stats.tweetId) : null;
    const meta = {
      row,
      rootId,
      depth,
      tweetId,
      threadSize,
      isThreadMember: Boolean(rootId && threadSize >= 2),
    };
    rowMeta.push(meta);

    if (rootId) {
      if (!buckets.has(rootId)) {
        buckets.set(rootId, []);
      }
      buckets.get(rootId).push(meta);
    }
  }

  // Build grouped output, preserving position of first occurrence
  const result = [];
  const emittedRoots = new Set();

  for (const meta of rowMeta) {
    const { row, rootId, depth } = meta;
    const bucket = rootId ? buckets.get(rootId) : null;
    const shouldBundle = shouldBundleVisibleBucket(bucket, rootId);
    const canShowSingletonRootThread = Boolean(
      rootId &&
      bucket &&
      bucket.length === 1 &&
      meta.isThreadMember &&
      meta.depth === 0 &&
      meta.tweetId === rootId
    );

    // Standalone: no thread info, or visible members are not safe to bundle.
    if (!rootId || (!shouldBundle && !canShowSingletonRootThread)) {
      const hasMissingAncestors = depth > 0;
      result.push({
        type: 'standalone',
        row,
        hasMissingAncestors,
        missingAncestorCount: hasMissingAncestors ? depth : 0,
        threadRootId: rootId,
        threadDepth: depth,
        globalThreadSize: meta.threadSize,
        isThreadMember: meta.isThreadMember,
      });
      continue;
    }

    // Already emitted this thread group
    if (emittedRoots.has(rootId)) continue;
    emittedRoots.add(rootId);

    // Sort bucket by depth, with actual root (tweetId === rootId) pinned first
    const sorted = [...bucket]
      .sort((a, b) => {
        const aIsRoot = a.tweetId === rootId ? 0 : 1;
        const bIsRoot = b.tweetId === rootId ? 0 : 1;
        if (aIsRoot !== bIsRoot) return aIsRoot - bIsRoot;
        return a.depth - b.depth;
      });

    const groupRows = sorted.map((m) => m.row);

    // Thread has missing ancestors if the shallowest visible tweet isn't the actual root
    const minDepth = Math.min(...sorted.map((item) => item.depth));
    const hasVisibleInternalRoot = sorted.some((item) => item.tweetId === rootId);
    const hasMissing = !hasVisibleInternalRoot || minDepth > 0;
    const globalThreadSize = sorted.reduce(
      (max, item) => Math.max(max, item.threadSize),
      1
    );

    result.push({
      type: 'thread',
      threadRootId: rootId,
      rows: groupRows,
      visibleCount: sorted.length,
      globalThreadSize,
      hasMissingAncestors: hasMissing,
      missingAncestorCount: hasMissing ? Math.max(minDepth, 1) : 0,
    });
  }

  return result;
}
