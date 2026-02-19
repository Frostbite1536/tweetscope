import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useReducer, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useScope } from './ScopeContext';
import useColumnFilter from '../hooks/useColumnFilter';
import useNearestNeighborsSearch from '../hooks/useNearestNeighborsSearch';
import useKeywordSearch from '../hooks/useKeywordSearch';
import useClusterFilter from '../hooks/useClusterFilter';
import { apiService } from '../lib/apiService';
import { queryKeys } from '../query/keys';

import {
  filterConstants,
  validateColumnAndValue,
} from '../components/Explore/V2/Search/utils';

const FilterContext = createContext(null);
const ROWS_PER_PAGE = 20;
const FILTER_URL_KEYS = ['cluster', 'search', 'keyword', 'column', 'value', 'feature'];

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


// ---------------------------------------------------------------------------
// Reducer — slot-based composable filter state (Phase 6)
// ---------------------------------------------------------------------------

const ACTION = {
  APPLY_CLUSTER: 'APPLY_CLUSTER',
  APPLY_SEARCH: 'APPLY_SEARCH',
  APPLY_KEYWORD_SEARCH: 'APPLY_KEYWORD_SEARCH',
  APPLY_COLUMN: 'APPLY_COLUMN',
  APPLY_TIME_RANGE: 'APPLY_TIME_RANGE',
  SET_FILTER_QUERY: 'SET_FILTER_QUERY',
  CLEAR_SLOT: 'CLEAR_SLOT',
  CLEAR_ALL: 'CLEAR_ALL',
};

// Slot keys — one slot per filter dimension
const SLOT = {
  CLUSTER: 'cluster',
  SEARCH: 'search',
  COLUMN: 'column',
  TIME_RANGE: 'timeRange',
};

const emptySlots = {
  [SLOT.CLUSTER]: null,
  [SLOT.SEARCH]: null,
  [SLOT.COLUMN]: null,
  [SLOT.TIME_RANGE]: null,
};

const initialFilterState = {
  filterSlots: { ...emptySlots },
  filterQuery: '',
};

function filterReducer(state, action) {
  switch (action.type) {
    case ACTION.APPLY_CLUSTER: {
      const { cluster } = action;
      const label = cluster.label || String(cluster.cluster);
      return {
        ...state,
        filterSlots: {
          ...state.filterSlots,
          [SLOT.CLUSTER]: { value: cluster.cluster, label },
        },
      };
    }

    case ACTION.APPLY_SEARCH: {
      const { query } = action;
      return {
        ...state,
        filterSlots: {
          ...state.filterSlots,
          [SLOT.SEARCH]: { value: query, label: query, mode: 'semantic' },
        },
        filterQuery: '',
      };
    }

    case ACTION.APPLY_KEYWORD_SEARCH: {
      const { query } = action;
      return {
        ...state,
        filterSlots: {
          ...state.filterSlots,
          [SLOT.SEARCH]: { value: query, label: query, mode: 'keyword' },
        },
        filterQuery: '',
      };
    }

    case ACTION.APPLY_COLUMN: {
      const { column, value } = action;
      const label = `${column}: ${value}`;
      return {
        ...state,
        filterSlots: {
          ...state.filterSlots,
          [SLOT.COLUMN]: { value, column, label },
        },
      };
    }

    case ACTION.APPLY_TIME_RANGE: {
      const { start, end, timestampsByLsIndex, label } = action;
      return {
        ...state,
        filterSlots: {
          ...state.filterSlots,
          [SLOT.TIME_RANGE]: { start, end, timestampsByLsIndex, label },
        },
        // filterQuery intentionally unchanged for time range
      };
    }

    case ACTION.SET_FILTER_QUERY:
      return { ...state, filterQuery: action.query };

    case ACTION.CLEAR_SLOT: {
      const { slotKey } = action;
      return {
        ...state,
        filterSlots: {
          ...state.filterSlots,
          [slotKey]: null,
        },
      };
    }

    case ACTION.CLEAR_ALL:
      return { ...initialFilterState };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export { SLOT as FILTER_SLOT };

export function FilterProvider({ children }) {
  const [state, dispatch] = useReducer(filterReducer, initialFilterState);
  const { filterSlots, filterQuery } = state;

  // Derived: is any filter active?
  const filterActive = useMemo(
    () => Object.values(filterSlots).some((s) => s !== null),
    [filterSlots],
  );

  // Backward-compat: single filterConfig for consumers not yet migrated.
  // Returns the "primary" active filter or null. Prefer filterSlots directly.
  const filterConfig = useMemo(() => {
    if (filterSlots.cluster) {
      return { type: filterConstants.CLUSTER, value: filterSlots.cluster.value, label: filterSlots.cluster.label };
    }
    if (filterSlots.search) {
      const type = filterSlots.search.mode === 'keyword' ? filterConstants.KEYWORD_SEARCH : filterConstants.SEARCH;
      return { type, value: filterSlots.search.value, label: filterSlots.search.label };
    }
    if (filterSlots.column) {
      return { type: filterConstants.COLUMN, value: filterSlots.column.value, column: filterSlots.column.column, label: filterSlots.column.label };
    }
    if (filterSlots.timeRange) {
      return { type: filterConstants.TIME_RANGE, ...filterSlots.timeRange };
    }
    return null;
  }, [filterSlots]);

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
  const keywordSearchFilter = useKeywordSearch({ datasetId, scope, deletedIndices });

  const setFilterQuery = useCallback((query) => {
    dispatch({ type: ACTION.SET_FILTER_QUERY, query });
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

  const applyKeywordSearch = useCallback((query) => {
    dispatch({ type: ACTION.APPLY_KEYWORD_SEARCH, query });
  }, []);

  const applyColumn = useCallback((column, value) => {
    dispatch({ type: ACTION.APPLY_COLUMN, column, value });
  }, []);

  const applyTimeRange = useCallback((start, end, timestampsByLsIndex, label) => {
    dispatch({ type: ACTION.APPLY_TIME_RANGE, start, end, timestampsByLsIndex, label });
  }, []);

  // Map filter type constants to slot keys for clearFilter backward compat
  const typeToSlot = useMemo(() => ({
    [filterConstants.CLUSTER]: SLOT.CLUSTER,
    [filterConstants.SEARCH]: SLOT.SEARCH,
    [filterConstants.KEYWORD_SEARCH]: SLOT.SEARCH,
    [filterConstants.COLUMN]: SLOT.COLUMN,
    [filterConstants.TIME_RANGE]: SLOT.TIME_RANGE,
  }), []);

  const clearFilter = useCallback((filterType) => {
    if (filterType) {
      const slotKey = typeToSlot[filterType];
      if (slotKey) {
        dispatch({ type: ACTION.CLEAR_SLOT, slotKey });
      }
    } else {
      dispatch({ type: ACTION.CLEAR_ALL });
    }
    // Clear hook-internal state for the relevant type
    if (!filterType || filterType === filterConstants.CLUSTER) {
      clusterFilter.clear();
    }
    if (!filterType || filterType === filterConstants.SEARCH || filterType === filterConstants.KEYWORD_SEARCH) {
      searchFilter.clear();
      keywordSearchFilter.clear();
    }
    if (!filterType || filterType === filterConstants.COLUMN) {
      columnFilter.clear();
    }
  }, [typeToSlot, clusterFilter, searchFilter, keywordSearchFilter, columnFilter]);

  const clearAllFilters = useCallback(() => {
    dispatch({ type: ACTION.CLEAR_ALL });
    clusterFilter.clear();
    searchFilter.clear();
    keywordSearchFilter.clear();
    columnFilter.clear();
  }, [clusterFilter, searchFilter, keywordSearchFilter, columnFilter]);

  // ---------------------------------------------------------------------------
  // URL restore — hydrate ALL filter slots from URL on load
  // ---------------------------------------------------------------------------

  const hasFilterInUrl = useMemo(() => {
    return (
      urlParams.has('cluster') ||
      urlParams.has('keyword') ||
      urlParams.has('search') ||
      (urlParams.has('column') && urlParams.has('value'))
    );
  }, [urlParams]);

  // Build a URL "signature" from all active slots for dedup
  const slotsUrlSignature = useMemo(() => {
    const parts = [];
    if (filterSlots.cluster) parts.push(`cluster:${filterSlots.cluster.value}`);
    if (filterSlots.search) {
      const key = filterSlots.search.mode === 'keyword' ? 'keyword' : 'search';
      parts.push(`${key}:${filterSlots.search.value}`);
    }
    if (filterSlots.column) parts.push(`column:${filterSlots.column.column}:${filterSlots.column.value}`);
    return parts.join('|') || 'none';
  }, [filterSlots]);

  useEffect(() => {
    if (!scopeLoaded || !hasFilterInUrl) return;

    // Parse ALL URL params and hydrate each matching slot.
    // We track expected signatures to avoid re-dispatching on our own URL writes.
    const expectedParts = [];

    if (urlParams.has('cluster')) {
      const numericValue = Number.parseInt(urlParams.get('cluster'), 10);
      if (Number.isInteger(numericValue)) {
        const cluster = clusterLabels.find((item) => item.cluster === numericValue);
        if (cluster && filterSlots.cluster?.value !== numericValue) {
          expectedParts.push(`cluster:${numericValue}`);
          applyCluster(cluster);
        }
      }
    }

    if (urlParams.has('keyword')) {
      const keywordValue = urlParams.get('keyword');
      if (keywordValue && !(filterSlots.search?.mode === 'keyword' && filterSlots.search?.value === keywordValue)) {
        expectedParts.push(`keyword:${keywordValue}`);
        applyKeywordSearch(keywordValue);
      }
    } else if (urlParams.has('search')) {
      const searchValue = urlParams.get('search');
      if (searchValue && !(filterSlots.search?.mode === 'semantic' && filterSlots.search?.value === searchValue)) {
        expectedParts.push(`search:${searchValue}`);
        applySearch(searchValue);
      }
    }

    if (urlParams.has('column') && urlParams.has('value')) {
      const columnValue = urlParams.get('value');
      const column = urlParams.get('column');
      const { columnFilters } = columnFilter;
      if (validateColumnAndValue(column, columnValue, columnFilters) &&
          !(filterSlots.column?.column === column && filterSlots.column?.value === columnValue)) {
        expectedParts.push(`column:${column}:${columnValue}`);
        applyColumn(column, columnValue);
      }
    }

    if (expectedParts.length > 0) {
      urlWriteSkipRef.current = expectedParts.join('|');
    }
  }, [scopeLoaded, hasFilterInUrl, urlParams, clusterLabels, columnFilter, filterSlots, applyCluster, applyKeywordSearch, applySearch, applyColumn]);

  // Write filterSlots → URL params
  useEffect(() => {
    if (!scopeLoaded) return;

    // Skip URL write when we just hydrated from URL
    if (urlWriteSkipRef.current !== null) {
      if (slotsUrlSignature === urlWriteSkipRef.current) {
        urlWriteSkipRef.current = null;
      }
      return;
    }

    const nextParams = new URLSearchParams(urlParams);
    for (const key of FILTER_URL_KEYS) {
      nextParams.delete(key);
    }

    if (filterSlots.cluster) {
      nextParams.set('cluster', String(filterSlots.cluster.value));
    }
    if (filterSlots.search) {
      if (filterSlots.search.mode === 'keyword') {
        nextParams.set('keyword', String(filterSlots.search.value));
      } else {
        nextParams.set('search', String(filterSlots.search.value));
      }
    }
    if (filterSlots.column) {
      nextParams.set('column', String(filterSlots.column.column));
      nextParams.set('value', String(filterSlots.column.value));
    }
    // timeRange is not serialized to URL

    const shouldWriteUrl = FILTER_URL_KEYS.some((key) => {
      return urlParams.get(key) !== nextParams.get(key);
    });

    if (shouldWriteUrl) {
      setUrlParams(nextParams);
    }
  }, [scopeLoaded, filterSlots, slotsUrlSignature, urlParams, setUrlParams]);

  // ---------------------------------------------------------------------------
  // Filter computation — intersects ALL active slots (AND logic)
  // ---------------------------------------------------------------------------

  const filterReqSeqRef = useRef(0);

  useEffect(() => {
    if (!scopeLoaded) return;

    const reqId = ++filterReqSeqRef.current;
    setLoading(true);

    const computeIntersection = async () => {
      // If nothing active and no pending URL hydration, return everything
      if (!filterActive && !hasFilterInUrl) {
        return baseIndices;
      }

      let indices = baseIndices;

      // Cluster slot
      if (filterSlots.cluster) {
        const cluster = clusterLabels.find((item) => item.cluster === filterSlots.cluster.value);
        if (cluster) {
          const clusterSet = new Set(clusterFilter.filter(cluster));
          indices = indices.filter((i) => clusterSet.has(i));
        }
      }

      // Search slot (keyword or semantic)
      if (filterSlots.search) {
        const hook = filterSlots.search.mode === 'keyword' ? keywordSearchFilter : searchFilter;
        const searchIndices = await hook.filter(filterSlots.search.value);
        const searchSet = new Set(searchIndices);
        indices = indices.filter((i) => searchSet.has(i));
      }

      // Column slot
      if (filterSlots.column) {
        const columnIndices = await columnFilter.filter(filterSlots.column.column, filterSlots.column.value);
        const columnSet = new Set(columnIndices);
        indices = indices.filter((i) => columnSet.has(i));
      }

      // Time range slot
      if (filterSlots.timeRange) {
        const { start, end, timestampsByLsIndex } = filterSlots.timeRange;
        if (timestampsByLsIndex && Number.isFinite(start) && Number.isFinite(end)) {
          indices = indices.filter((lsIndex) => {
            const ts = timestampsByLsIndex.get(lsIndex);
            if (ts === undefined || Number.isNaN(ts)) return true;
            return ts >= start && ts <= end;
          });
        }
      }

      return indices;
    };

    computeIntersection()
      .then((indices) => {
        if (filterReqSeqRef.current !== reqId) return;
        setFilteredIndices(uniqueOrderedIndices(indices));
        setPage(0);
        setLoading(false);
      })
      .catch((error) => {
        if (filterReqSeqRef.current !== reqId) return;
        console.error('Failed to apply filter', error);
        setFilteredIndices(baseIndices);
        setPage(0);
        setLoading(false);
      });
  }, [
    filterSlots,
    filterActive,
    baseIndices,
    scopeLoaded,
    hasFilterInUrl,
    clusterLabels,
    clusterFilter,
    searchFilter,
    keywordSearchFilter,
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
      staleTime: filterActive ? 30_000 : 5 * 60 * 1000,
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
    // Canonical dispatchers
    applyCluster,
    applySearch,
    applyKeywordSearch,
    applyColumn,
    applyTimeRange,
    clearFilter,
    clearAllFilters,

    // Slot-based state (Phase 6)
    filterSlots,
    filterConfig, // backward compat — derived from filterSlots
    filterQuery,
    setFilterQuery,
    filterActive,

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
    keywordSearchFilter,
    clusterFilter,
    columnFilter,
    setUrlParams,
    dataTableRows,
  }), [
    applyCluster,
    applySearch,
    applyKeywordSearch,
    applyColumn,
    applyTimeRange,
    clearFilter,
    clearAllFilters,
    filterSlots,
    filterConfig,
    filterQuery,
    setFilterQuery,
    filterActive,
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
    keywordSearchFilter,
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
