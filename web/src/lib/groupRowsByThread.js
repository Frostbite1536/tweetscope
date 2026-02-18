/**
 * Groups a flat array of scope rows into standalone items and thread groups
 * using thread metadata from the nodeStats map.
 *
 * @param {Array} rows - Flat array of scope rows (from dataTableRows or carousel tweets)
 * @param {Map} nodeStats - Map<ls_index, NodeStatsEntry> from useNodeStats
 * @returns {Array<Item>} where Item is one of:
 *   { type: 'standalone', row, hasMissingAncestors: boolean, missingAncestorCount: number }
 *   { type: 'thread', threadRootId: string, rows: Array, hasMissingAncestors: boolean, missingAncestorCount: number }
 */
export function groupRowsByThread(rows, nodeStats) {
  if (!rows || rows.length === 0) return [];
  if (!nodeStats || !(nodeStats instanceof Map) || nodeStats.size === 0) {
    return rows.map((row) => ({ type: 'standalone', row, hasMissingAncestors: false, missingAncestorCount: 0 }));
  }

  // Single-pass bucketing: group rows by threadRootId
  const buckets = new Map(); // rootId → [{row, depth, tweetId}]
  const rowMeta = []; // parallel array for iteration order

  for (const row of rows) {
    const stats = nodeStats.get(row.ls_index);
    // Guard against null, undefined, empty string, and Python "None" sentinel
    const rawRootId = stats?.threadRootId;
    const rootId = (rawRootId && rawRootId !== 'None') ? rawRootId : null;
    const meta = { row, rootId, depth: stats?.threadDepth ?? 0, tweetId: stats?.tweetId };
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

    // Standalone: no thread info, or only one member on this page
    if (!rootId || buckets.get(rootId).length < 2) {
      // A standalone tweet with depth > 0 is replying to something not visible
      const hasMissing = depth > 0;
      result.push({
        type: 'standalone',
        row,
        hasMissingAncestors: hasMissing,
        missingAncestorCount: hasMissing ? depth : 0,
      });
      continue;
    }

    // Already emitted this thread group
    if (emittedRoots.has(rootId)) continue;
    emittedRoots.add(rootId);

    // Sort bucket by depth, with actual root (tweetId === rootId) pinned first
    const sorted = buckets.get(rootId)
      .sort((a, b) => {
        const aIsRoot = a.tweetId === rootId ? 0 : 1;
        const bIsRoot = b.tweetId === rootId ? 0 : 1;
        if (aIsRoot !== bIsRoot) return aIsRoot - bIsRoot;
        return a.depth - b.depth;
      });

    const groupRows = sorted.map((m) => m.row);

    // Thread has missing ancestors if the shallowest visible tweet isn't the actual root
    const minDepth = sorted[0].depth;
    const firstIsTrueRoot = sorted[0].tweetId === rootId;
    const hasMissing = !firstIsTrueRoot || minDepth > 0;

    result.push({
      type: 'thread',
      threadRootId: rootId,
      rows: groupRows,
      hasMissingAncestors: hasMissing,
      missingAncestorCount: hasMissing ? minDepth : 0,
    });
  }

  return result;
}
