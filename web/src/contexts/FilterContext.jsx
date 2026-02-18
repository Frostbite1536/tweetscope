// FilterContext.js
import React, { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useScope } from './ScopeContext'; // Assuming this provides scopeRows, deletedIndices, etc.
import useColumnFilter from '../hooks/useColumnFilter';
import useNearestNeighborsSearch from '../hooks/useNearestNeighborsSearch';
import useClusterFilter from '../hooks/useClusterFilter';
import { apiService } from '../lib/apiService';

import {
  filterConstants,
  validateColumnAndValue,
} from '../components/Explore/V2/Search/utils';

const FilterContext = createContext(null);

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
  // Global filter config: { type, value } or null when no filter is active.
  const [filterConfig, setFilterConfig] = useState(null);
  const [filteredIndices, setFilteredIndices] = useState([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState(''); // Optional query string for UI
  const [filterActive, setFilterActive] = useState(false);

  const [urlParams, setUrlParams] = useSearchParams();
  // Pull shared data from a higher-level context.
  const {
    scopeRows,
    deletedIndices,
    userId,
    datasetId,
    scope,
    scopeLoaded,
    clusterLabels,
  } = useScope();

  // Base set of non-deleted indices from the dataset.
  const baseIndices = useMemo(() => {
    return uniqueOrderedIndices(
      scopeRows.map((row) => row.ls_index).filter((index) => !deletedIndices.includes(index))
    );
  }, [scopeRows, deletedIndices]);

  // Column filter
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

  // Populate filter state from url params
  useEffect(() => {
    if (!scopeLoaded || !hasFilterInUrl) return;

    // let's just grab the first key for now
    const key = urlParams.keys().next().value;
    const value = urlParams.get(key);
    const numericValue = parseInt(value);

    if (key === filterConstants.SEARCH) {
      console.log('==== search filter url param ==== ', { value });
      setFilterQuery(value);
      setFilterConfig({ type: filterConstants.SEARCH, value, label: value });
    } else if (key === filterConstants.CLUSTER) {
      const cluster = clusterLabels.find((cluster) => cluster.cluster === numericValue);
      if (cluster) {
        const { setCluster } = clusterFilter;
        setCluster(cluster);
        setFilterQuery(cluster.label);
        setFilterConfig({
          type: filterConstants.CLUSTER,
          value: numericValue,
          label: cluster.label,
        });
      }
    } else if (urlParams.has('column') && urlParams.has('value')) {
      const value = urlParams.get('value');
      const column = urlParams.get('column');
      const { columnFilters } = columnFilter;
      if (validateColumnAndValue(column, value, columnFilters)) {
        setFilterQuery(`${column}: ${value}`);
        setFilterConfig({
          type: filterConstants.COLUMN,
          value,
          column,
          label: `${column}: ${value}`,
        });
      }
    }
  }, [urlParams, scopeLoaded]);

  // ==== Filtering ====
  // compute filteredIndices based on the active filter.
  useEffect(() => {
    async function applyFilter() {
      setLoading(true);
      let indices = [];
      // If no filter is active, use the full baseIndices.
      if (!filterConfig && !hasFilterInUrl) {
        indices = baseIndices;
      } else if (filterConfig) {
        const { type, value } = filterConfig;

        switch (type) {
          case filterConstants.CLUSTER: {
            const { setCluster, filter } = clusterFilter;
            const cluster = clusterLabels.find((cluster) => cluster.cluster === value);
            if (cluster) {
              setCluster(cluster);
              indices = filter(cluster);
            }
            break;
          }
          case filterConstants.SEARCH: {
            const { filter } = searchFilter;
            indices = await filter(value);
            break;
          }
          case filterConstants.COLUMN: {
            const { filter } = columnFilter;
            const { column } = filterConfig;
            indices = await filter(column, value);
            break;
          }
          case filterConstants.TIME_RANGE: {
            const { start, end, timestampsByLsIndex } = filterConfig;
            if (timestampsByLsIndex && Number.isFinite(start) && Number.isFinite(end)) {
              indices = baseIndices.filter((lsIndex) => {
                const ts = timestampsByLsIndex.get(lsIndex);
                if (ts === undefined || Number.isNaN(ts)) return true; // Keep dateless rows (likes)
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
      setFilteredIndices(uniqueOrderedIndices(indices));
      setPage(0); // Reset to first page when filter changes.
      setLoading(false);
    }
    if (scopeLoaded) {
      applyFilter();
    }
  }, [filterConfig, baseIndices, scopeRows, deletedIndices, userId, datasetId, scope, scopeLoaded]);

  // === Fetch Data Table Rows Logic

  const [dataTableRows, setDataTableRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);

  // === Pagination ===
  const ROWS_PER_PAGE = 20;

  // Exclude deleted indices upfront so totalPages and shownIndices agree
  const visibleFilteredIndices = useMemo(() => {
    const deletedSet = new Set(deletedIndices);
    return filteredIndices.filter((index) => !deletedSet.has(index));
  }, [filteredIndices, deletedIndices]);

  const totalPages = useMemo(
    () => Math.ceil(visibleFilteredIndices.length / ROWS_PER_PAGE),
    [visibleFilteredIndices]
  );

  // Accumulative: all indices loaded so far (pages 0..page)
  const shownIndices = useMemo(() => {
    return visibleFilteredIndices.slice(0, (page + 1) * ROWS_PER_PAGE);
  }, [visibleFilteredIndices, page]);

  // The delta: just the current page's indices (for fetching)
  const currentPageIndices = useMemo(() => {
    return visibleFilteredIndices.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);
  }, [visibleFilteredIndices, page]);

  // Monotonic request counter for staleness detection
  const reqSeqRef = useRef(0);

  // Cache for default (unfiltered) page fetches
  const rowsCache = useRef(new Map());

  // Clear cache when dataset or scope changes
  useEffect(() => {
    rowsCache.current.clear();
  }, [datasetId, scope?.id]);

  useEffect(() => {
    if (currentPageIndices.length === 0) {
      if (page === 0) setDataTableRows([]);
      return;
    }

    const reqId = ++reqSeqRef.current;
    setRowsLoading(true);

    const cacheKey = `${datasetId}-${scope?.id}-${JSON.stringify(currentPageIndices)}`;

    if (!filterConfig) {
      const cachedResult = rowsCache.current.get(cacheKey);
      if (cachedResult) {
        setDataTableRows((prev) => (page === 0 ? cachedResult : [...prev, ...cachedResult]));
        setRowsLoading(false);
        return;
      }
    }

    apiService
      .fetchDataFromIndices(datasetId, currentPageIndices, scope?.id)
      .then((rows) => {
        if (reqSeqRef.current !== reqId) return;
        const baseIdx = page * ROWS_PER_PAGE;
        const rowsWithIdx = rows.map((row, i) => ({
          ...row,
          idx: baseIdx + i,
          ls_index: row.index,
        }));
        setDataTableRows((prev) => (page === 0 ? rowsWithIdx : [...prev, ...rowsWithIdx]));

        if (!filterConfig) {
          rowsCache.current.set(cacheKey, rowsWithIdx);
        }
      })
      .finally(() => {
        if (reqSeqRef.current === reqId) {
          setRowsLoading(false);
        }
      });
  }, [currentPageIndices, page, datasetId, scope, filterConfig]);

  // The context exposes only the state and setters that consumer components need.
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
    filterConfig, setFilterConfig, filterQuery, setFilterQuery,
    filteredIndices, shownIndices, page, setPage, totalPages, ROWS_PER_PAGE,
    loading, setLoading, rowsLoading, filterActive, setFilterActive,
    searchFilter, clusterFilter, columnFilter,
    setUrlParams, dataTableRows,
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
