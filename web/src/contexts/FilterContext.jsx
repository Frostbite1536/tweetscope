import React, { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useScope } from './ScopeContext';
import useColumnFilter from '../hooks/useColumnFilter';
import useNearestNeighborsSearch from '../hooks/useNearestNeighborsSearch';
import useClusterFilter from '../hooks/useClusterFilter';
import { apiService } from '../lib/apiService';
import { queryKeys } from '../query/keys';

import {
  filterConstants,
  validateColumnAndValue,
} from '../components/Explore/V2/Search/utils';

const FilterContext = createContext(null);
const ROWS_PER_PAGE = 20;

function uniqueOrderedIndices(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const n = Number(value);
    if (!Number.isInteger(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function FilterProvider({ children }) {
  const [filterConfig, setFilterConfig] = useState(null);
  const [filteredIndices, setFilteredIndices] = useState([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterActive, setFilterActive] = useState(false);

  const [urlParams, setUrlParams] = useSearchParams();
  const {
    scopeRows,
    deletedIndices,
    userId,
    datasetId,
    scope,
    scopeLoaded,
    clusterLabels,
  } = useScope();

  const baseIndices = useMemo(() => {
    return uniqueOrderedIndices(
      scopeRows
        .map((row) => row.ls_index)
        .filter((index) => !deletedIndices.has(index))
    );
  }, [scopeRows, deletedIndices]);

  const columnFilter = useColumnFilter(userId, datasetId, scope);
  const clusterFilter = useClusterFilter({ scopeRows, scope, scopeLoaded });
  const searchFilter = useNearestNeighborsSearch({ userId, datasetId, scope, deletedIndices });

  const hasFilterInUrl = useMemo(() => {
    return (
      urlParams.has('column') ||
      urlParams.has('cluster') ||
      urlParams.has('search')
    );
  }, [urlParams]);

  useEffect(() => {
    if (!scopeLoaded || !hasFilterInUrl) return;

    const key = urlParams.keys().next().value;
    const value = urlParams.get(key);
    const numericValue = Number.parseInt(value, 10);

    if (key === filterConstants.SEARCH) {
      setFilterQuery(value);
      setFilterConfig({ type: filterConstants.SEARCH, value, label: value });
      return;
    }

    if (key === filterConstants.CLUSTER) {
      const cluster = clusterLabels.find((item) => item.cluster === numericValue);
      if (!cluster) return;
      clusterFilter.setCluster(cluster);
      setFilterQuery(cluster.label);
      setFilterConfig({
        type: filterConstants.CLUSTER,
        value: numericValue,
        label: cluster.label,
      });
      return;
    }

    if (urlParams.has('column') && urlParams.has('value')) {
      const columnValue = urlParams.get('value');
      const column = urlParams.get('column');
      const { columnFilters } = columnFilter;
      if (!validateColumnAndValue(column, columnValue, columnFilters)) return;

      setFilterQuery(`${column}: ${columnValue}`);
      setFilterConfig({
        type: filterConstants.COLUMN,
        value: columnValue,
        column,
        label: `${column}: ${columnValue}`,
      });
    }
  }, [scopeLoaded, hasFilterInUrl, urlParams, clusterLabels, clusterFilter, columnFilter]);

  const filterReqSeqRef = useRef(0);

  useEffect(() => {
    if (!scopeLoaded) return;

    const reqId = ++filterReqSeqRef.current;
    setLoading(true);

    const applyFilter = async () => {
      let indices = [];

      if (!filterConfig && !hasFilterInUrl) {
        indices = baseIndices;
      } else if (filterConfig) {
        const { type, value } = filterConfig;

        switch (type) {
          case filterConstants.CLUSTER: {
            const cluster = clusterLabels.find((item) => item.cluster === value);
            if (cluster) {
              clusterFilter.setCluster(cluster);
              indices = clusterFilter.filter(cluster);
            }
            break;
          }
          case filterConstants.SEARCH: {
            indices = await searchFilter.filter(value);
            break;
          }
          case filterConstants.COLUMN: {
            const { column } = filterConfig;
            indices = await columnFilter.filter(column, value);
            break;
          }
          case filterConstants.TIME_RANGE: {
            const { start, end, timestampsByLsIndex } = filterConfig;
            if (timestampsByLsIndex && Number.isFinite(start) && Number.isFinite(end)) {
              indices = baseIndices.filter((lsIndex) => {
                const ts = timestampsByLsIndex.get(lsIndex);
                if (ts === undefined || Number.isNaN(ts)) return true;
                return ts >= start && ts <= end;
              });
            } else {
              indices = baseIndices;
            }
            break;
          }
          default: {
            indices = baseIndices;
          }
        }
      }

      if (filterReqSeqRef.current !== reqId) return;
      setFilteredIndices(uniqueOrderedIndices(indices));
      setPage(0);
      setLoading(false);
    };

    applyFilter().catch((error) => {
      if (filterReqSeqRef.current !== reqId) return;
      console.error('Failed to apply filter', error);
      setFilteredIndices(baseIndices);
      setPage(0);
      setLoading(false);
    });
  }, [
    filterConfig,
    baseIndices,
    scopeLoaded,
    hasFilterInUrl,
    clusterLabels,
    clusterFilter,
    searchFilter,
    columnFilter,
  ]);

  const visibleFilteredIndices = useMemo(() => {
    return filteredIndices.filter((index) => !deletedIndices.has(index));
  }, [filteredIndices, deletedIndices]);

  const totalPages = useMemo(
    () => Math.ceil(visibleFilteredIndices.length / ROWS_PER_PAGE),
    [visibleFilteredIndices]
  );

  const shownIndices = useMemo(() => {
    return visibleFilteredIndices.slice(0, (page + 1) * ROWS_PER_PAGE);
  }, [visibleFilteredIndices, page]);

  const pageSlices = useMemo(() => {
    const maxPage = Math.min(page, Math.max(totalPages - 1, 0));
    const slices = [];
    for (let p = 0; p <= maxPage; p++) {
      const indices = visibleFilteredIndices.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE);
      if (indices.length === 0) continue;
      slices.push({ pageIndex: p, indices });
    }
    return slices;
  }, [visibleFilteredIndices, page, totalPages]);

  const rowQueries = useQueries({
    queries: pageSlices.map(({ indices }) => ({
      queryKey: queryKeys.rowsByIndices(datasetId, scope?.id, indices),
      enabled: Boolean(datasetId && scope?.id && indices.length > 0),
      queryFn: ({ signal }) =>
        apiService.fetchDataFromIndices(datasetId, indices, scope?.id, { signal }),
      staleTime: filterConfig ? 30_000 : 5 * 60 * 1000,
    })),
  });

  const rowsLoading = rowQueries.some((query) => query.isFetching);

  const dataTableRows = useMemo(() => {
    return pageSlices.flatMap(({ pageIndex }, idx) => {
      const rows = rowQueries[idx]?.data || [];
      const baseIdx = pageIndex * ROWS_PER_PAGE;
      return rows.map((row, i) => ({
        ...row,
        idx: baseIdx + i,
        ls_index: row.index,
      }));
    });
  }, [pageSlices, rowQueries]);

  const value = useMemo(() => ({
    filterConfig,
    setFilterConfig,
    filterQuery,
    setFilterQuery,
    filteredIndices,
    shownIndices,
    page,
    setPage,
    totalPages,
    ROWS_PER_PAGE,
    loading,
    setLoading,
    rowsLoading,
    filterActive,
    setFilterActive,
    searchFilter,
    clusterFilter,
    columnFilter,
    setUrlParams,
    dataTableRows,
  }), [
    filterConfig,
    setFilterConfig,
    filterQuery,
    setFilterQuery,
    filteredIndices,
    shownIndices,
    page,
    setPage,
    totalPages,
    loading,
    setLoading,
    rowsLoading,
    filterActive,
    setFilterActive,
    searchFilter,
    clusterFilter,
    columnFilter,
    setUrlParams,
    dataTableRows,
  ]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilter() {
  const context = useContext(FilterContext);
  if (!context) {
    throw new Error('useFilter must be used within a FilterProvider');
  }
  return context;
}
