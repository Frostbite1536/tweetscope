import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useReducer, useRef } from 'react';
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
const FILTER_URL_KEYS = ['cluster', 'search', 'column', 'value', 'feature'];

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

function getFilterUrlSignature(config) {
  if (!config) return 'none';

  if (config.type === filterConstants.CLUSTER) {
    return `cluster:${String(config.value)}`;
  }

  if (config.type === filterConstants.SEARCH) {
    return `search:${String(config.value)}`;
  }

  if (config.type === filterConstants.COLUMN) {
    return `column:${String(config.column)}:${String(config.value)}`;
  }

  if (config.type === filterConstants.TIME_RANGE) {
    return 'timeRange';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Reducer — single owner of filter intent state
// ---------------------------------------------------------------------------

const ACTION = {
  APPLY_CLUSTER: 'APPLY_CLUSTER',
  APPLY_SEARCH: 'APPLY_SEARCH',
  APPLY_COLUMN: 'APPLY_COLUMN',
  APPLY_TIME_RANGE: 'APPLY_TIME_RANGE',
  SET_FILTER_QUERY: 'SET_FILTER_QUERY',
  CLEAR_FILTER: 'CLEAR_FILTER',
  // Compatibility shims (used by existing callers until Phase 3 migration)
  SET_FILTER_CONFIG: 'SET_FILTER_CONFIG',
  SET_FILTER_ACTIVE: 'SET_FILTER_ACTIVE',
};

const initialFilterState = {
  filterConfig: null,
  filterQuery: '',
  filterActive: false,
};

function filterReducer(state, action) {
  switch (action.type) {
    case ACTION.APPLY_CLUSTER: {
      const { cluster } = action;
      const label = cluster.label || String(cluster.cluster);
      return {
        filterConfig: {
          type: filterConstants.CLUSTER,
          value: cluster.cluster,
          label,
        },
        filterQuery: label,
        filterActive: true,
      };
    }

    case ACTION.APPLY_SEARCH: {
      const { query } = action;
      return {
        filterConfig: {
          type: filterConstants.SEARCH,
          value: query,
          label: query,
        },
        filterQuery: query,
        filterActive: true,
      };
    }

    case ACTION.APPLY_COLUMN: {
      const { column, value } = action;
      const label = `${column}: ${value}`;
      return {
        filterConfig: {
          type: filterConstants.COLUMN,
          value,
          column,
          label,
        },
        filterQuery: label,
        filterActive: true,
      };
    }

    case ACTION.APPLY_TIME_RANGE: {
      const { start, end, timestampsByLsIndex, label } = action;
      return {
        ...state,
        filterConfig: {
          type: filterConstants.TIME_RANGE,
          start,
          end,
          timestampsByLsIndex,
          label,
        },
        filterActive: true,
        // filterQuery intentionally unchanged for time range
      };
    }

    case ACTION.SET_FILTER_QUERY:
      return { ...state, filterQuery: action.query };

    case ACTION.CLEAR_FILTER:
      return { ...initialFilterState };

    // --- Compatibility shims (existing callers pass raw values) ---

    case ACTION.SET_FILTER_CONFIG: {
      const config = action.config;
      return {
        ...state,
        filterConfig: config,
        filterActive: config !== null && config !== undefined ? state.filterActive : false,
      };
    }

    case ACTION.SET_FILTER_ACTIVE:
      return { ...state, filterActive: action.active };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function FilterProvider({ children }) {
  const [state, dispatch] = useReducer(filterReducer, initialFilterState);
  const { filterConfig, filterQuery, filterActive } = state;

  const [filteredIndices, setFilteredIndices] = useState([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);

  const [urlParams, setUrlParams] = useSearchParams();
  const urlWriteSkipRef = useRef(null);
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

  // ---------------------------------------------------------------------------
  // DEPRECATED (Phase 3 complete): setFilterConfig and setFilterActive are no
  // longer used by any consumer for filter dispatch. Remove in Phase 5.
  // setFilterQuery is still used by Search/Container for input field text.
  // ---------------------------------------------------------------------------

  const setFilterConfig = useCallback((config) => {
    dispatch({ type: ACTION.SET_FILTER_CONFIG, config });
  }, []);

  const setFilterQuery = useCallback((query) => {
    dispatch({ type: ACTION.SET_FILTER_QUERY, query });
  }, []);

  const setFilterActive = useCallback((active) => {
    dispatch({ type: ACTION.SET_FILTER_ACTIVE, active });
  }, []);

  // ---------------------------------------------------------------------------
  // New canonical dispatchers — Phase 1 additions
  // ---------------------------------------------------------------------------

  const applyCluster = useCallback((cluster) => {
    dispatch({ type: ACTION.APPLY_CLUSTER, cluster });
    clusterFilter.setCluster(cluster);
  }, [clusterFilter]);

  const applySearch = useCallback((query) => {
    dispatch({ type: ACTION.APPLY_SEARCH, query });
  }, []);

  const applyColumn = useCallback((column, value) => {
    dispatch({ type: ACTION.APPLY_COLUMN, column, value });
  }, []);

  const applyTimeRange = useCallback((start, end, timestampsByLsIndex, label) => {
    dispatch({ type: ACTION.APPLY_TIME_RANGE, start, end, timestampsByLsIndex, label });
  }, []);

  const clearFilter = useCallback((filterType) => {
    dispatch({ type: ACTION.CLEAR_FILTER });
    // Clear hook-internal state for the relevant type
    if (!filterType || filterType === filterConstants.CLUSTER) {
      clusterFilter.clear();
    }
    if (!filterType || filterType === filterConstants.SEARCH) {
      searchFilter.clear();
    }
    if (!filterType || filterType === filterConstants.COLUMN) {
      columnFilter.clear();
    }
  }, [clusterFilter, searchFilter, columnFilter]);

  // ---------------------------------------------------------------------------
  // URL restore — hydrate filter state from URL on load
  // ---------------------------------------------------------------------------

  const hasFilterInUrl = useMemo(() => {
    return (
      urlParams.has('cluster') ||
      urlParams.has('search') ||
      (urlParams.has('column') && urlParams.has('value'))
    );
  }, [urlParams]);

  useEffect(() => {
    if (!scopeLoaded || !hasFilterInUrl) return;

    if (urlParams.has('cluster')) {
      const clusterValue = urlParams.get('cluster');
      const numericValue = Number.parseInt(clusterValue, 10);
      if (!Number.isInteger(numericValue)) return;
      const cluster = clusterLabels.find((item) => item.cluster === numericValue);
      if (!cluster) return;
      const targetSignature = `cluster:${String(numericValue)}`;
      if (getFilterUrlSignature(filterConfig) === targetSignature) {
        return;
      }
      urlWriteSkipRef.current = targetSignature;
      applyCluster(cluster);
      return;
    }

    if (urlParams.has('search')) {
      const searchValue = urlParams.get('search');
      if (!searchValue) return;
      const targetSignature = `search:${searchValue}`;
      if (getFilterUrlSignature(filterConfig) === targetSignature) {
        return;
      }
      urlWriteSkipRef.current = targetSignature;
      applySearch(searchValue);
      return;
    }

    if (urlParams.has('column') && urlParams.has('value')) {
      const columnValue = urlParams.get('value');
      const column = urlParams.get('column');
      const { columnFilters } = columnFilter;
      if (!validateColumnAndValue(column, columnValue, columnFilters)) return;
      const targetSignature = `column:${String(column)}:${String(columnValue)}`;
      if (getFilterUrlSignature(filterConfig) === targetSignature) {
        return;
      }

      urlWriteSkipRef.current = targetSignature;
      applyColumn(column, columnValue);
    }
  }, [scopeLoaded, hasFilterInUrl, urlParams, clusterLabels, columnFilter, filterConfig, applyCluster, applySearch, applyColumn]);

  useEffect(() => {
    if (!scopeLoaded) return;

    if (urlWriteSkipRef.current !== null) {
      if (getFilterUrlSignature(filterConfig) === urlWriteSkipRef.current) {
        urlWriteSkipRef.current = null;
      }
      return;
    }

    if (filterConfig?.type === filterConstants.TIME_RANGE) {
      return;
    }

    const nextParams = new URLSearchParams(urlParams);
    for (const key of FILTER_URL_KEYS) {
      nextParams.delete(key);
    }

    if (filterConfig) {
      if (filterConfig.type === filterConstants.CLUSTER) {
        nextParams.set('cluster', String(filterConfig.value));
      } else if (filterConfig.type === filterConstants.SEARCH) {
        nextParams.set('search', String(filterConfig.value));
      } else if (filterConfig.type === filterConstants.COLUMN) {
        nextParams.set('column', String(filterConfig.column));
        nextParams.set('value', String(filterConfig.value));
      }
    }

    const shouldWriteUrl = FILTER_URL_KEYS.some((key) => {
      return urlParams.get(key) !== nextParams.get(key);
    });

    if (shouldWriteUrl) {
      setUrlParams(nextParams);
    }
  }, [scopeLoaded, filterConfig, urlParams, setUrlParams]);

  // ---------------------------------------------------------------------------
  // Filter computation — watches filterConfig and computes filteredIndices
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Derived state — pagination, visible sets, row fetching
  // ---------------------------------------------------------------------------

  const visibleFilteredIndices = useMemo(() => {
    return filteredIndices.filter((index) => !deletedIndices.has(index));
  }, [filteredIndices, deletedIndices]);

  const visibleIndexSet = useMemo(() => new Set(visibleFilteredIndices), [visibleFilteredIndices]);

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

  // ---------------------------------------------------------------------------
  // Context value
  // ---------------------------------------------------------------------------

  const value = useMemo(() => ({
    // New canonical dispatchers (Phase 1)
    applyCluster,
    applySearch,
    applyColumn,
    applyTimeRange,
    clearFilter,

    // Deprecated shims (Phase 3 complete — remove in Phase 5)
    filterConfig,
    setFilterConfig,
    filterQuery,
    setFilterQuery,
    filterActive,
    setFilterActive,

    // Unchanged
    filteredIndices,
    visibleIndexSet,
    shownIndices,
    page,
    setPage,
    totalPages,
    ROWS_PER_PAGE,
    loading,
    setLoading,
    rowsLoading,
    searchFilter,
    clusterFilter,
    columnFilter,
    setUrlParams,
    dataTableRows,
  }), [
    applyCluster,
    applySearch,
    applyColumn,
    applyTimeRange,
    clearFilter,
    filterConfig,
    setFilterConfig,
    filterQuery,
    setFilterQuery,
    filterActive,
    setFilterActive,
    filteredIndices,
    visibleIndexSet,
    shownIndices,
    page,
    setPage,
    totalPages,
    loading,
    setLoading,
    rowsLoading,
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
