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
  isSameClusterValue,
  validateColumnAndValue,
} from '../components/Explore/V2/Search/utils';
import { getLikesCount } from '../lib/engagement';
import { isThreadMember } from '../lib/threadMembership';

const FilterContext = createContext(null);
const ROWS_PER_PAGE = 20;
const FILTER_URL_KEYS = ['cluster', 'search', 'keyword', 'column', 'value', 'min_faves'];
const HYDRATED_URL_KEYS = ['cluster', 'search', 'keyword', 'column', 'value', 'min_faves'];
const THREAD_MASK_MAX_INDEX = 5_000_000;
const THREAD_MASK_DENSITY_DIVISOR = 16;

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

function buildUrlFilterSignature(params) {
  const parts = [];
  for (const key of HYDRATED_URL_KEYS) {
    const value = params.get(key);
    if (value === null) continue;
    parts.push(`${key}:${value}`);
  }
  return parts.join('|') || 'none';
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
  APPLY_ENGAGEMENT: 'APPLY_ENGAGEMENT',
  APPLY_THREAD: 'APPLY_THREAD',
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
  ENGAGEMENT: 'engagement',
  THREAD: 'thread',
};

const emptySlots = {
  [SLOT.CLUSTER]: null,
  [SLOT.SEARCH]: null,
  [SLOT.COLUMN]: null,
  [SLOT.TIME_RANGE]: null,
  [SLOT.ENGAGEMENT]: null,
  [SLOT.THREAD]: null,
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

    case ACTION.APPLY_ENGAGEMENT: {
      const { minFaves } = action;
      return {
        ...state,
        filterSlots: {
          ...state.filterSlots,
          [SLOT.ENGAGEMENT]: { minFaves, label: `♥ ≥ ${minFaves}` },
        },
      };
    }

    case ACTION.APPLY_THREAD: {
      return {
        ...state,
        filterSlots: {
          ...state.filterSlots,
          [SLOT.THREAD]: { enabled: true, label: 'Threads only' },
        },
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
    if (filterSlots.engagement) {
      return { type: filterConstants.ENGAGEMENT, ...filterSlots.engagement };
    }
    if (filterSlots.thread) {
      return { type: filterConstants.THREAD, ...filterSlots.thread };
    }
    return null;
  }, [filterSlots]);

  const [filteredIndices, setFilteredIndices] = useState([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState('likes');
  const [sortDirection, setSortDirection] = useState('desc');

  const [urlParams, setUrlParams] = useSearchParams();
  const urlFilterSignature = useMemo(
    () => buildUrlFilterSignature(urlParams),
    [urlParams],
  );
  const urlWriteSkipRef = useRef(null);
  const lastHydratedUrlSignatureRef = useRef(null);
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

  const scopeRowsByIndex = useMemo(() => {
    const map = new Map();
    for (const row of scopeRows) {
      map.set(row.ls_index, row);
    }
    return map;
  }, [scopeRows]);

  const columnFilter = useColumnFilter(userId, datasetId, scope);
  const clusterFilter = useClusterFilter({ scopeRows, clusterLabels });
  const searchFilter = useNearestNeighborsSearch({ userId, datasetId, scope, deletedIndices });
  const keywordSearchFilter = useKeywordSearch({ datasetId, scope, deletedIndices });
  const clusterFilterFn = clusterFilter.filter;
  const columnFilterFn = columnFilter.filter;
  const semanticSearchFilterFn = searchFilter.filter;
  const keywordSearchFilterFn = keywordSearchFilter.filter;

  // Auto-switch sort to relevance when search becomes active, revert when cleared
  const prevSearchRef = useRef(null);
  useEffect(() => {
    const hasSearch = filterSlots.search !== null;
    const hadSearch = prevSearchRef.current !== null;
    prevSearchRef.current = filterSlots.search;

    if (hasSearch && !hadSearch) {
      setSortKey('relevance');
    } else if (!hasSearch && hadSearch) {
      setSortKey('likes');
    }
  }, [filterSlots.search]);

  // Reset page when sort changes
  useEffect(() => {
    setPage(0);
  }, [sortKey, sortDirection]);

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

  const applyEngagement = useCallback((minFaves) => {
    dispatch({ type: ACTION.APPLY_ENGAGEMENT, minFaves });
  }, []);

  // ---------------------------------------------------------------------------
  // Thread-membership mask (chain-safe predicate)
  // Stored outside reducer to avoid large object churn.
  // ---------------------------------------------------------------------------

  const [threadMembership, setThreadMembershipState] = useState(null); // Uint8Array | Set<number> | null

  // Accept nodeStats from page level and build chain-safe membership mask
  const setThreadMembership = useCallback((nodeStats) => {
    if (!nodeStats || !(nodeStats instanceof Map) || nodeStats.size === 0) {
      setThreadMembershipState(null);
      return;
    }
    // Build set of all tweetIds in dataset (for root_in_dataset check)
    const allTweetIds = new Set();
    let maxIndex = 0;
    for (const [key, stats] of nodeStats) {
      if (typeof key !== 'number') continue;
      if (key > maxIndex) maxIndex = key;
      if (stats.tweetId) allTweetIds.add(String(stats.tweetId));
    }

    const memberIndices = [];
    for (const [key, stats] of nodeStats) {
      if (typeof key !== 'number') continue;
      const threadSize = stats.threadSize ?? 1;
      if (threadSize < 2) continue;
      const rootInDataset = stats.threadRootId && allTweetIds.has(String(stats.threadRootId));
      const depthGt1 = (stats.threadDepth ?? 0) > 1;
      const hasReplyChildren = (stats.replyChildCount ?? 0) > 0;
      if (rootInDataset || depthGt1 || hasReplyChildren) {
        memberIndices.push(key);
      }
    }
    if (memberIndices.length === 0) {
      setThreadMembershipState(null);
      return;
    }

    const shouldUseMask =
      maxIndex <= THREAD_MASK_MAX_INDEX &&
      maxIndex <= memberIndices.length * THREAD_MASK_DENSITY_DIVISOR;

    if (shouldUseMask) {
      const mask = new Uint8Array(maxIndex + 1);
      for (let i = 0; i < memberIndices.length; i++) {
        mask[memberIndices[i]] = 1;
      }
      setThreadMembershipState(mask);
      return;
    }

    setThreadMembershipState(new Set(memberIndices));
  }, []);

  const threadsOnlyAvailable = threadMembership !== null;
  const threadsOnlyActive = !!filterSlots.thread;

  const toggleThreadsOnly = useCallback(() => {
    if (filterSlots.thread) {
      dispatch({ type: ACTION.CLEAR_SLOT, slotKey: SLOT.THREAD });
    } else {
      dispatch({ type: ACTION.APPLY_THREAD });
    }
  }, [filterSlots.thread]);

  useEffect(() => {
    if (threadMembership !== null) return;
    if (!filterSlots.thread) return;
    dispatch({ type: ACTION.CLEAR_SLOT, slotKey: SLOT.THREAD });
  }, [threadMembership, filterSlots.thread]);

  // Map filter type constants to slot keys for clearFilter backward compat
  const typeToSlot = useMemo(() => ({
    [filterConstants.CLUSTER]: SLOT.CLUSTER,
    [filterConstants.SEARCH]: SLOT.SEARCH,
    [filterConstants.KEYWORD_SEARCH]: SLOT.SEARCH,
    [filterConstants.COLUMN]: SLOT.COLUMN,
    [filterConstants.TIME_RANGE]: SLOT.TIME_RANGE,
    [filterConstants.ENGAGEMENT]: SLOT.ENGAGEMENT,
    [filterConstants.THREAD]: SLOT.THREAD,
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
      (urlParams.has('column') && urlParams.has('value')) ||
      urlParams.has('min_faves')
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
    if (filterSlots.engagement) parts.push(`engagement:${filterSlots.engagement.minFaves}`);
    return parts.join('|') || 'none';
  }, [filterSlots]);

  useEffect(() => {
    if (!scopeLoaded) return;
    if (urlFilterSignature === lastHydratedUrlSignatureRef.current) return;
    lastHydratedUrlSignatureRef.current = urlFilterSignature;
    if (!hasFilterInUrl) return;

    // Parse ALL URL params and hydrate each matching slot.
    // We track expected signatures to avoid re-dispatching on our own URL writes.
    const expectedParts = [];

    if (urlParams.has('cluster')) {
      const rawValue = urlParams.get('cluster');
      if (rawValue !== null) {
        const cluster = clusterLabels.find((item) => isSameClusterValue(item.cluster, rawValue));
        if (cluster && !isSameClusterValue(filterSlots.cluster?.value, cluster.cluster)) {
          expectedParts.push(`cluster:${cluster.cluster}`);
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

    if (urlParams.has('min_faves')) {
      const raw = parseInt(urlParams.get('min_faves'), 10);
      if (raw > 0 && filterSlots.engagement?.minFaves !== raw) {
        expectedParts.push(`engagement:${raw}`);
        applyEngagement(raw);
      }
    }

    if (expectedParts.length > 0) {
      urlWriteSkipRef.current = expectedParts.join('|');
    }
  }, [scopeLoaded, hasFilterInUrl, urlParams, urlFilterSignature, clusterLabels, columnFilter, filterSlots, applyCluster, applyKeywordSearch, applySearch, applyColumn, applyEngagement]);

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
    if (filterSlots.engagement) {
      nextParams.set('min_faves', String(filterSlots.engagement.minFaves));
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

      // Pre-resolve filter sets — cluster is sync, search + column are async (parallel)
      let clusterSet = null;
      if (filterSlots.cluster) {
        const cluster = clusterLabels.find((item) =>
          isSameClusterValue(item.cluster, filterSlots.cluster.value)
        );
        if (cluster) clusterSet = new Set(clusterFilterFn(cluster));
      }

      const [searchIndices, columnIndices] = await Promise.all([
        filterSlots.search
          ? (filterSlots.search.mode === 'keyword' ? keywordSearchFilterFn : semanticSearchFilterFn)(filterSlots.search.value)
          : null,
        filterSlots.column
          ? columnFilterFn(filterSlots.column.column, filterSlots.column.value)
          : null,
      ]);
      const searchSet = searchIndices ? new Set(searchIndices) : null;
      const columnSet = columnIndices ? new Set(columnIndices) : null;

      const hasTimeRange = filterSlots.timeRange
        && filterSlots.timeRange.timestampsByLsIndex
        && Number.isFinite(filterSlots.timeRange.start)
        && Number.isFinite(filterSlots.timeRange.end);

      const hasEngagement = filterSlots.engagement && filterSlots.engagement.minFaves > 0;

      // Thread membership: Uint8Array mask for dense indices, Set for sparse indices
      const hasThread = filterSlots.thread && threadMembership;

      // Single pass — check all predicates per index
      const out = [];
      for (const i of baseIndices) {
        if (clusterSet && !clusterSet.has(i)) continue;
        if (searchSet && !searchSet.has(i)) continue;
        if (columnSet && !columnSet.has(i)) continue;
        if (hasTimeRange) {
          const ts = filterSlots.timeRange.timestampsByLsIndex.get(i);
          if (ts !== undefined && !Number.isNaN(ts)) {
            if (ts < filterSlots.timeRange.start || ts > filterSlots.timeRange.end) continue;
          }
        }
        if (hasEngagement) {
          const row = scopeRowsByIndex.get(i);
          if (!row || getLikesCount(row) < filterSlots.engagement.minFaves) continue;
        }
        if (hasThread && !isThreadMember(threadMembership, i)) continue;
        out.push(i);
      }
      return out;
    };

    computeIntersection()
      .then((indices) => {
        if (filterReqSeqRef.current !== reqId) return;
        setFilteredIndices(indices);
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
    clusterFilterFn,
    semanticSearchFilterFn,
    keywordSearchFilterFn,
    columnFilterFn,
    scopeRowsByIndex,
    threadMembership,
  ]);

  // ---------------------------------------------------------------------------
  // Derived state — pagination, visible sets, row fetching
  // ---------------------------------------------------------------------------

  const visibleFilteredIndices = useMemo(() => {
    return filteredIndices.filter((index) => !deletedIndices.has(index));
  }, [filteredIndices, deletedIndices]);

  const visibleIndexSet = useMemo(() => new Set(visibleFilteredIndices), [visibleFilteredIndices]);

  // Sort indices for feed ordering (scatter dimming uses visibleIndexSet above, unaffected by sort)
  const sortedIndices = useMemo(() => {
    if (sortKey === 'recent' && sortDirection === 'desc') return visibleFilteredIndices;

    const sorted = [...visibleFilteredIndices];

    if (sortKey === 'recent') {
      sorted.reverse();
    } else if (sortKey === 'likes') {
      sorted.sort((a, b) => {
        const diff = getLikesCount(scopeRowsByIndex.get(a)) - getLikesCount(scopeRowsByIndex.get(b));
        return sortDirection === 'desc' ? -diff : diff;
      });
    } else if (sortKey === 'relevance') {
      const dMap = searchFilter.distanceMap;
      const sMap = keywordSearchFilter.scoreMap;
      if (dMap.size > 0) {
        sorted.sort((a, b) => {
          const diff = (dMap.get(a) ?? Infinity) - (dMap.get(b) ?? Infinity);
          return sortDirection === 'desc' ? diff : -diff;
        });
      } else if (sMap.size > 0) {
        sorted.sort((a, b) => {
          const diff = (sMap.get(b) ?? -Infinity) - (sMap.get(a) ?? -Infinity);
          return sortDirection === 'desc' ? diff : -diff;
        });
      }
    }

    return sorted;
  }, [visibleFilteredIndices, sortKey, sortDirection, scopeRowsByIndex, searchFilter.distanceMap, keywordSearchFilter.scoreMap]);

  const totalPages = useMemo(
    () => Math.ceil(sortedIndices.length / ROWS_PER_PAGE),
    [sortedIndices]
  );

  const shownIndices = useMemo(() => {
    return sortedIndices.slice(0, (page + 1) * ROWS_PER_PAGE);
  }, [sortedIndices, page]);

  const pageSlices = useMemo(() => {
    const maxPage = Math.min(page, Math.max(totalPages - 1, 0));
    const slices = [];
    for (let p = 0; p <= maxPage; p++) {
      const indices = sortedIndices.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE);
      if (indices.length === 0) continue;
      slices.push({ pageIndex: p, indices });
    }
    return slices;
  }, [sortedIndices, page, totalPages]);

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
    applyEngagement,
    clearFilter,
    clearAllFilters,

    // Slot-based state (Phase 6)
    filterSlots,
    filterConfig, // backward compat — derived from filterSlots
    filterQuery,
    setFilterQuery,
    filterActive,

    // Sort
    sortKey,
    setSortKey,
    sortDirection,
    setSortDirection,

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

    // Thread-only filter
    setThreadMembership,
    threadMembership,
    threadsOnlyAvailable,
    threadsOnlyActive,
    toggleThreadsOnly,
  }), [
    applyCluster,
    applySearch,
    applyKeywordSearch,
    applyColumn,
    applyTimeRange,
    applyEngagement,
    clearFilter,
    clearAllFilters,
    filterSlots,
    filterConfig,
    filterQuery,
    setFilterQuery,
    filterActive,
    sortKey,
    setSortKey,
    sortDirection,
    setSortDirection,
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
    setThreadMembership,
    threadMembership,
    threadsOnlyAvailable,
    threadsOnlyActive,
    toggleThreadsOnly,
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
