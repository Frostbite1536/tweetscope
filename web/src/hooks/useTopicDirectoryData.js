import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useScope } from '@/contexts/ScopeContext';
import { queryApi } from '@/lib/apiService';
import { getLikesCount } from '@/lib/engagement';
import { appQueryClient } from '@/query/client';
import { queryKeys } from '@/query/keys';

const ROWS_PER_PAGE = 30;

const EMPTY_CLUSTERS = [];
const EMPTY_MAPPING = { clusterToTopLevel: {}, indicesByTopLevel: {} };

function normalizeClusterId(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function buildDescendantsMap(roots) {
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

export default function useTopicDirectoryData(selectedClusterIndex, enabled = true) {
  const { clusterHierarchy, scopeRows, dataset, scope, clusterMap } = useScope();

  // Per-cluster state: { rows, page, loading, hasMore }
  const [feedData, setFeedData] = useState({ rows: [], page: 0, loading: false, hasMore: true });
  const [activeSubCluster, setActiveSubCluster] = useState(null);
  const feedDataRef = useRef(feedData);
  feedDataRef.current = feedData;
  const prevClusterIndexRef = useRef(null);

  // Extract top-level clusters (roots of the hierarchy)
  const topLevelClusters = useMemo(() => {
    if (!clusterHierarchy?.children) return EMPTY_CLUSTERS;
    return clusterHierarchy.children;
  }, [clusterHierarchy]);

  const descendantsByCluster = useMemo(
    () => buildDescendantsMap(topLevelClusters),
    [topLevelClusters]
  );

  // Build mapping: cluster id → top-level root, and indices grouped by top-level
  const { clusterToTopLevel, indicesByTopLevel } = useMemo(() => {
    if (!enabled || !topLevelClusters.length || !scopeRows?.length) {
      return EMPTY_MAPPING;
    }

    const c2tl = {};
    const walkTree = (node, rootClusterId) => {
      c2tl[node.cluster] = rootClusterId;
      if (node.children) {
        node.children.forEach((child) => walkTree(child, rootClusterId));
      }
    };
    topLevelClusters.forEach((root) => walkTree(root, root.cluster));

    const groups = {};
    topLevelClusters.forEach((root) => {
      groups[root.cluster] = [];
    });

    scopeRows.forEach((row) => {
      if (row.deleted) return;
      const topLevel = c2tl[row.cluster];
      if (topLevel !== undefined && topLevel !== null && groups[topLevel]) {
        groups[topLevel].push(row);
      }
    });

    const indicesByTL = {};
    for (const [clusterId, rows] of Object.entries(groups)) {
      rows.sort((a, b) => getLikesCount(b) - getLikesCount(a));
      indicesByTL[clusterId] = rows.map((r) => r.ls_index);
    }

    return { clusterToTopLevel: c2tl, indicesByTopLevel: indicesByTL };
  }, [enabled, topLevelClusters, scopeRows]);

  // Fetch data for the selected cluster
  const fetchFeedData = useCallback(
    (clusterIndex, page = 0) => {
      const cluster = topLevelClusters[clusterIndex];
      if (!cluster || !dataset) return;

      const allIndices = indicesByTopLevel[cluster.cluster] || [];
      const start = page * ROWS_PER_PAGE;
      const pageIndices = allIndices.slice(start, start + ROWS_PER_PAGE);

      if (pageIndices.length === 0) {
        setFeedData((prev) => ({
          ...prev,
          loading: false,
          hasMore: false,
        }));
        return;
      }

      setFeedData((prev) => ({
        ...(page === 0 ? { rows: [], page: 0 } : prev),
        loading: true,
        page,
      }));

      appQueryClient
        .fetchQuery({
          queryKey: queryKeys.rowsByIndices(dataset.id, scope?.id, pageIndices),
          queryFn: ({ signal }) =>
            queryApi.fetchDataFromIndices(dataset.id, pageIndices, scope?.id, { signal }),
          staleTime: 5 * 60 * 1000,
        })
        .then((rows) => {
          const mappedRows = rows.map((row, i) => ({
            ...row,
            ls_index: row.index,
            idx: page * ROWS_PER_PAGE + i,
          }));
          setFeedData((prev) => {
            const newRows = page === 0 ? mappedRows : [...prev.rows, ...mappedRows];
            return {
              rows: newRows,
              page,
              loading: false,
              hasMore: pageIndices.length === ROWS_PER_PAGE,
            };
          });
        })
        .catch((err) => {
          console.error(`Failed to fetch topic feed data:`, err);
          setFeedData((prev) => ({
            ...prev,
            loading: false,
          }));
        });
    },
    [topLevelClusters, indicesByTopLevel, dataset, scope]
  );

  // Load more rows for the current selected cluster
  const loadMore = useCallback(() => {
    const data = feedDataRef.current;
    if (data.loading || !data.hasMore || selectedClusterIndex == null) return;
    fetchFeedData(selectedClusterIndex, (data.page || 0) + 1);
  }, [selectedClusterIndex, fetchFeedData]);

  // When selected cluster changes, fetch first page
  useEffect(() => {
    if (!enabled || selectedClusterIndex == null || !topLevelClusters.length || !dataset) return;
    if (prevClusterIndexRef.current === selectedClusterIndex) return;
    prevClusterIndexRef.current = selectedClusterIndex;
    setActiveSubCluster(null);
    fetchFeedData(selectedClusterIndex, 0);
  }, [enabled, selectedClusterIndex, topLevelClusters, dataset, fetchFeedData]);

  // Reset when hierarchy changes
  useEffect(() => {
    setFeedData({ rows: [], page: 0, loading: false, hasMore: true });
    setActiveSubCluster(null);
    prevClusterIndexRef.current = null;
  }, [clusterHierarchy]);

  // Sub-cluster filtering (client-side)
  const setSubClusterFilter = useCallback((subClusterId) => {
    setActiveSubCluster(subClusterId); // null = "all"
  }, []);

  // Filtered rows based on active sub-cluster
  const filteredRows = useMemo(() => {
    if (!feedData.rows.length) return feedData.rows;
    if (activeSubCluster === null || activeSubCluster === undefined) return feedData.rows;
    const activeId = normalizeClusterId(activeSubCluster);
    if (activeId === null) return feedData.rows;
    const allowedIds = descendantsByCluster.get(activeId) ?? new Set([activeId]);

    return feedData.rows.filter((row) => {
      const info = clusterMap[row.ls_index] ?? clusterMap[String(row.ls_index)];
      const rowClusterId = normalizeClusterId(info?.cluster ?? row.cluster);
      return rowClusterId !== null && allowedIds.has(rowClusterId);
    });
  }, [feedData.rows, activeSubCluster, clusterMap, descendantsByCluster]);

  return {
    topLevelClusters,
    feedData: {
      rows: filteredRows,
      loading: feedData.loading,
      hasMore: feedData.hasMore,
    },
    loadMore,
    activeSubCluster,
    setSubClusterFilter,
    clusterToTopLevel,
    indicesByTopLevel,
  };
}
