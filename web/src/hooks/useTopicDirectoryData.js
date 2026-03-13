import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useScope } from '@/contexts/ScopeContext';
import { queryApi } from '@/lib/apiService';
import { appQueryClient } from '@/query/client';
import { queryKeys } from '@/query/keys';
import { buildClusterFeedIndex, normalizeClusterId, EMPTY_FEED_INDEX } from '@/lib/buildClusterFeedIndex';
import { isThreadMember } from '@/lib/threadMembership';

const ROWS_PER_PAGE = 30;

const EMPTY_CLUSTERS = [];

export default function useTopicDirectoryData(selectedClusterIndex, enabled = true, threadMembership = null) {
  const { clusterHierarchy, scopeRows, dataset, scope, clusterMap } = useScope();

  // Per-cluster state: { rows, page, loading, hasMore }
  const [feedData, setFeedData] = useState({ rows: [], page: 0, loading: false, hasMore: true });
  const [activeSubCluster, setActiveSubCluster] = useState(null);
  const feedDataRef = useRef(feedData);
  feedDataRef.current = feedData;
  const prevClusterIndexRef = useRef(null);

  // Extract top-level clusters (roots of the hierarchy)
  const allTopLevelClusters = useMemo(() => {
    if (!clusterHierarchy?.children) return EMPTY_CLUSTERS;
    return clusterHierarchy.children;
  }, [clusterHierarchy]);

  const shouldBuildFeedIndex =
    enabled && allTopLevelClusters.length > 0 && (selectedClusterIndex != null || threadMembership != null);

  // Shared feed index — identity-cached at module level, no duplicate work
  const baseFeedIndex = useMemo(
    () =>
      shouldBuildFeedIndex
        ? buildClusterFeedIndex(allTopLevelClusters, scopeRows, clusterHierarchy)
        : EMPTY_FEED_INDEX,
    [shouldBuildFeedIndex, allTopLevelClusters, scopeRows, clusterHierarchy]
  );
  const { clusterToTopLevel, indicesByTopLevel: baseIndicesByTopLevel, descendantsByCluster } = baseFeedIndex;

  const indicesByTopLevel = useMemo(() => {
    if (!shouldBuildFeedIndex) return EMPTY_FEED_INDEX.indicesByTopLevel;
    if (!threadMembership) return baseIndicesByTopLevel;
    const filtered = {};
    for (let i = 0; i < allTopLevelClusters.length; i++) {
      const clusterId = allTopLevelClusters[i].cluster;
      const indices = baseIndicesByTopLevel[clusterId] || [];
      filtered[clusterId] = indices.filter((lsIndex) => isThreadMember(threadMembership, lsIndex));
    }
    return filtered;
  }, [allTopLevelClusters, baseIndicesByTopLevel, shouldBuildFeedIndex, threadMembership]);

  const topLevelClusters = useMemo(() => {
    if (!threadMembership) return allTopLevelClusters;
    if (!shouldBuildFeedIndex) return EMPTY_CLUSTERS;
    return allTopLevelClusters.filter((cluster) => (indicesByTopLevel[cluster.cluster]?.length ?? 0) > 0);
  }, [allTopLevelClusters, indicesByTopLevel, shouldBuildFeedIndex, threadMembership]);

  // Fetch data for the selected cluster
  const fetchFeedData = useCallback(
    (clusterIndex, page = 0) => {
      const cluster = topLevelClusters[clusterIndex];
      if (!cluster || !dataset) return;

      const allIndices = indicesByTopLevel[cluster.cluster] || [];
      const start = page * ROWS_PER_PAGE;
      const pageIndices = allIndices.slice(start, start + ROWS_PER_PAGE);
      const hasMoreAfterPage = start + pageIndices.length < allIndices.length;

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
              hasMore: hasMoreAfterPage,
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
    if (!enabled) return;
    setFeedData({ rows: [], page: 0, loading: false, hasMore: true });
    setActiveSubCluster(null);
    prevClusterIndexRef.current = null;
  }, [enabled, topLevelClusters]);

  // Sub-cluster filtering (client-side)
  const setSubClusterFilter = useCallback((subClusterId) => {
    setActiveSubCluster(subClusterId); // null = "all"
  }, []);

  // Filtered rows based on active sub-cluster + thread membership
  const filteredRows = useMemo(() => {
    let rows = feedData.rows;
    if (!rows.length) return rows;

    // Sub-cluster filter
    if (activeSubCluster !== null && activeSubCluster !== undefined) {
      const activeId = normalizeClusterId(activeSubCluster);
      if (activeId !== null) {
        const allowedIds = descendantsByCluster.get(activeId) ?? new Set([activeId]);
        rows = rows.filter((row) => {
          const info = clusterMap[row.ls_index] ?? clusterMap[String(row.ls_index)];
          const rowClusterId = normalizeClusterId(info?.cluster ?? row.cluster);
          return rowClusterId !== null && allowedIds.has(rowClusterId);
        });
      }
    }

    // Thread membership filter
    if (threadMembership) {
      rows = rows.filter((row) => {
        const lsIdx = Number(row.ls_index ?? row.index);
        return isThreadMember(threadMembership, lsIdx);
      });
    }

    return rows;
  }, [feedData.rows, activeSubCluster, clusterMap, descendantsByCluster, threadMembership]);

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
