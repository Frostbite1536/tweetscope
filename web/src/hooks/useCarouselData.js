import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useScope } from '@/contexts/ScopeContext';
import { queryApi } from '@/lib/apiService';
import { appQueryClient } from '@/query/client';
import { queryKeys } from '@/query/keys';
import { buildClusterFeedIndex, normalizeClusterId } from '@/lib/buildClusterFeedIndex';
import { isThreadMember } from '@/lib/threadMembership';

const ROWS_PER_PAGE = 30;
const PREFETCH_RANGE = 2; // Fetch columns within focusedIndex +/- this range

const EMPTY_CLUSTERS = [];
const EMPTY_ROWS_MAP = {};

export default function useCarouselData(focusedClusterIndex, enabled = true, threadMembership = null) {
  const { clusterHierarchy, scopeRows, dataset, scope, clusterMap } = useScope();

  // Per-column state: { [clusterIndex]: { rows: [], page: 0, loading: false, hasMore: true } }
  const [columnData, setColumnData] = useState({});
  const [activeSubClusters, setActiveSubClusters] = useState({}); // { [columnIndex]: subClusterId | null }
  const fetchedRef = useRef(new Set()); // Track which columns we've initiated fetches for

  // Ref for columnData so loadMore doesn't depend on it
  const columnDataRef = useRef(columnData);
  columnDataRef.current = columnData;

  // Extract top-level clusters (roots of the hierarchy)
  const allTopLevelClusters = useMemo(() => {
    if (!clusterHierarchy?.children) return EMPTY_CLUSTERS;
    return clusterHierarchy.children;
  }, [clusterHierarchy]);

  // Shared feed index — identity-cached at module level, no duplicate work
  const baseFeedIndex = useMemo(
    () => buildClusterFeedIndex(allTopLevelClusters, scopeRows, clusterHierarchy),
    [allTopLevelClusters, scopeRows, clusterHierarchy]
  );
  const { clusterToTopLevel, indicesByTopLevel: baseIndicesByTopLevel, descendantsByCluster } = baseFeedIndex;

  const indicesByTopLevel = useMemo(() => {
    if (!threadMembership) return baseIndicesByTopLevel;
    const filtered = {};
    for (let i = 0; i < allTopLevelClusters.length; i++) {
      const clusterId = allTopLevelClusters[i].cluster;
      const indices = baseIndicesByTopLevel[clusterId] || [];
      filtered[clusterId] = indices.filter((lsIndex) => isThreadMember(threadMembership, lsIndex));
    }
    return filtered;
  }, [allTopLevelClusters, baseIndicesByTopLevel, threadMembership]);

  const topLevelClusters = useMemo(() => {
    if (!threadMembership) return allTopLevelClusters;
    return allTopLevelClusters.filter((cluster) => (indicesByTopLevel[cluster.cluster]?.length ?? 0) > 0);
  }, [allTopLevelClusters, indicesByTopLevel, threadMembership]);

  // Fetch column data for a given column index
  const fetchColumnData = useCallback(
    (columnIndex, page = 0) => {
      const cluster = topLevelClusters[columnIndex];
      if (!cluster || !dataset) return;

      const allIndices = indicesByTopLevel[cluster.cluster] || [];
      const start = page * ROWS_PER_PAGE;
      const pageIndices = allIndices.slice(start, start + ROWS_PER_PAGE);
      const hasMoreAfterPage = start + pageIndices.length < allIndices.length;

      if (pageIndices.length === 0) {
        setColumnData((prev) => ({
          ...prev,
          [columnIndex]: {
            ...(prev[columnIndex] || { rows: [] }),
            loading: false,
            hasMore: false,
          },
        }));
        return;
      }

      setColumnData((prev) => ({
        ...prev,
        [columnIndex]: {
          ...(prev[columnIndex] || { rows: [] }),
          loading: true,
          page,
        },
      }));

      appQueryClient
        .fetchQuery({
          queryKey: queryKeys.rowsByIndices(dataset.id, scope?.id, pageIndices),
          queryFn: ({ signal }) =>
            queryApi.fetchDataFromIndices(dataset.id, pageIndices, scope?.id, { signal }),
          staleTime: 5 * 60 * 1000,
        })
        .then((rows) => {
          // Map rows to include ls_index and idx (same as FilterContext does)
          const mappedRows = rows.map((row, i) => ({
            ...row,
            ls_index: row.index,
            idx: page * ROWS_PER_PAGE + i,
          }));
          setColumnData((prev) => {
            const existing = prev[columnIndex]?.rows || [];
            const newRows = page === 0 ? mappedRows : [...existing, ...mappedRows];
            return {
              ...prev,
              [columnIndex]: {
                rows: newRows,
                page,
                loading: false,
                hasMore: hasMoreAfterPage,
              },
            };
          });
        })
        .catch((err) => {
          console.error(`Failed to fetch column ${columnIndex} data:`, err);
          setColumnData((prev) => ({
            ...prev,
            [columnIndex]: {
              ...(prev[columnIndex] || { rows: [] }),
              loading: false,
            },
          }));
        });
    },
    [topLevelClusters, indicesByTopLevel, dataset, scope]
  );

  // Load more for a specific column — uses ref to avoid dep on columnData
  const loadMore = useCallback(
    (columnIndex) => {
      const col = columnDataRef.current[columnIndex];
      if (!col || col.loading || !col.hasMore) return;
      fetchColumnData(columnIndex, (col.page || 0) + 1);
    },
    [fetchColumnData]
  );

  // Lazy-load columns near the focused index (gated by enabled)
  useEffect(() => {
    if (!enabled || !topLevelClusters.length || !dataset) return;

    const start = Math.max(0, focusedClusterIndex - PREFETCH_RANGE);
    const end = Math.min(topLevelClusters.length - 1, focusedClusterIndex + PREFETCH_RANGE);

    for (let i = start; i <= end; i++) {
      if (!fetchedRef.current.has(i)) {
        fetchedRef.current.add(i);
        fetchColumnData(i, 0);
      } else {
        const cluster = topLevelClusters[i];
        const indices = indicesByTopLevel[cluster?.cluster] || [];
        const pageIndices = indices.slice(0, ROWS_PER_PAGE);
        if (pageIndices.length > 0) {
          appQueryClient.prefetchQuery({
            queryKey: queryKeys.rowsByIndices(dataset.id, scope?.id, pageIndices),
            queryFn: ({ signal }) =>
              queryApi.fetchDataFromIndices(dataset.id, pageIndices, scope?.id, { signal }),
            staleTime: 5 * 60 * 1000,
          });
        }
      }
    }
  }, [enabled, focusedClusterIndex, topLevelClusters, dataset, scope?.id, indicesByTopLevel, fetchColumnData]);

  // Reset when hierarchy changes
  useEffect(() => {
    setColumnData({});
    setActiveSubClusters({});
    fetchedRef.current = new Set();
  }, [topLevelClusters]);

  // Sub-cluster filtering (client-side)
  const setSubClusterFilter = useCallback((columnIndex, subClusterId) => {
    setActiveSubClusters((prev) => ({
      ...prev,
      [columnIndex]: subClusterId, // null means "all"
    }));
  }, []);

  // Pre-computed per-column rows map — referentially stable per column
  const columnRowsMap = useMemo(() => {
    if (!enabled) return EMPTY_ROWS_MAP;
    const map = {};
    for (const [indexStr, col] of Object.entries(columnData)) {
      const index = Number(indexStr);
      if (!col?.rows) { map[index] = []; continue; }

      let rows = col.rows;

      // Sub-cluster filter
      const activeSubCluster = activeSubClusters[index];
      if (activeSubCluster !== null && activeSubCluster !== undefined) {
        const activeId = normalizeClusterId(activeSubCluster);
        const allowedIds = activeId === null
          ? null
          : descendantsByCluster.get(activeId) ?? new Set([activeId]);
        if (allowedIds) {
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

      map[index] = rows;
    }
    return map;
  }, [enabled, columnData, activeSubClusters, clusterMap, descendantsByCluster, threadMembership]);

  return {
    topLevelClusters,
    columnData,
    columnRowsMap,
    loadMore,
    activeSubClusters,
    setSubClusterFilter,
    clusterToTopLevel,
    indicesByTopLevel,
  };
}
