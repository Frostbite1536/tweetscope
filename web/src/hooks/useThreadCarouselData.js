import { useState, useEffect, useMemo, useCallback, useRef, useReducer } from 'react';
import { useScope } from '@/contexts/ScopeContext';
import { graphClient, queryApi } from '@/lib/apiService';
import { appQueryClient } from '@/query/client';
import { queryKeys } from '@/query/keys';

const PREFETCH_RANGE = 2;
const MAX_CONCURRENT_FETCHES = 3;

const EMPTY_THREADS = [];
const EMPTY_COLUMN_MAP = new Map();

function parseDateMs(value) {
  if (!value) return Number.NaN;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.NaN;
}

function columnDataReducer(state, action) {
  switch (action.type) {
    case 'reset': {
      return new Map();
    }
    case 'setEmpty': {
      const next = new Map(state);
      next.set(action.columnIndex, { rows: [], loading: false, hasMore: false, page: 0 });
      return next;
    }
    case 'setLoading': {
      const next = new Map(state);
      const prev = next.get(action.columnIndex) || { rows: [] };
      next.set(action.columnIndex, {
        ...prev,
        loading: true,
        page: 0,
      });
      return next;
    }
    case 'setRows': {
      const next = new Map(state);
      next.set(action.columnIndex, {
        rows: action.rows,
        page: 0,
        loading: false,
        hasMore: false,
      });
      return next;
    }
    case 'setError': {
      const next = new Map(state);
      const prev = next.get(action.columnIndex) || { rows: [] };
      next.set(action.columnIndex, {
        ...prev,
        loading: false,
      });
      return next;
    }
    default:
      return state;
  }
}

/**
 * Thread carousel data hook — fetches thread structure from the
 * /links/threads API endpoint (server-side discovery from internal reply edges),
 * then lazily fetches row data for visible columns.
 *
 * Returns a shape compatible with FeedCarousel:
 * - threads (replaces topLevelClusters)
 * - columnData, loadMore
 */
export default function useThreadCarouselData(focusedThreadIndex, enabled = true) {
  const { scopeRows, dataset, scope } = useScope();

  const [threadEntries, setThreadEntries] = useState(EMPTY_THREADS);
  const [columnData, dispatchColumnData] = useReducer(columnDataReducer, EMPTY_COLUMN_MAP);
  const fetchedRef = useRef(new Set());
  const fetchedForDatasetRef = useRef(null);
  const pendingQueueRef = useRef([]);
  const inFlightRef = useRef(new Set());
  const generationRef = useRef(0);

  // Fetch thread structure from API
  useEffect(() => {
    if (!enabled || !dataset?.id) return;
    if (fetchedForDatasetRef.current === dataset.id) return;
    fetchedForDatasetRef.current = dataset.id;

    graphClient
      .fetchThreads(dataset.id)
      .then((response) => {
        setThreadEntries(response.threads || []);
      })
      .catch((err) => {
        console.error('Failed to fetch threads:', err);
        setThreadEntries(EMPTY_THREADS);
      });
  }, [enabled, dataset?.id]);

  // Reset queued/in-flight work when fetching is disabled
  useEffect(() => {
    if (enabled) return;
    generationRef.current += 1;
    pendingQueueRef.current = [];
    inFlightRef.current = new Set();
  }, [enabled]);

  // Reset when dataset changes
  useEffect(() => {
    generationRef.current += 1;
    dispatchColumnData({ type: 'reset' });
    setThreadEntries(EMPTY_THREADS);
    fetchedRef.current = new Set();
    pendingQueueRef.current = [];
    inFlightRef.current = new Set();
  }, [dataset?.id]);

  // Build engagement lookup from scopeRows: ls_index → engagement score
  const engagementByIndex = useMemo(() => {
    if (!enabled || !scopeRows?.length) return null;
    const map = new Map();
    for (const row of scopeRows) {
      if (row.deleted) continue;
      const fav = Number(row.favorites ?? row.favorite_count ?? row.like_count ?? row.likes ?? 0);
      const rt = Number(row.retweets ?? row.retweet_count ?? 0);
      map.set(row.ls_index, fav + rt);
    }
    return map;
  }, [enabled, scopeRows]);

  // Enrich thread entries with engagement data and sort
  const threads = useMemo(() => {
    if (!enabled || !threadEntries.length || !engagementByIndex) return EMPTY_THREADS;

    const enriched = threadEntries.map((entry) => {
      let totalEngagement = 0;
      for (const idx of entry.member_indices) {
        totalEngagement += engagementByIndex.get(idx) || 0;
      }
      return {
        rootLsIndex: entry.root_ls_index,
        rootTweetId: entry.root_tweet_id,
        memberIndices: entry.member_indices,
        memberDepths: entry.member_depths,
        size: entry.size,
        totalEngagement,
      };
    });

    // Sort: size >= 3 first, then by combined engagement + thread length
    enriched.sort((a, b) => {
      const aPriority = a.size >= 3 ? 1 : 0;
      const bPriority = b.size >= 3 ? 1 : 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      const aScore = a.totalEngagement + a.size;
      const bScore = b.totalEngagement + b.size;
      return bScore - aScore;
    });

    return enriched;
  }, [enabled, threadEntries, engagementByIndex]);

  const scopeRowByIndex = useMemo(() => {
    if (!enabled || !scopeRows?.length) return null;
    const map = new Map();
    for (const row of scopeRows) {
      const idx = Number(row.ls_index ?? row.index);
      if (!Number.isInteger(idx)) continue;
      map.set(idx, row);
    }
    return map;
  }, [enabled, scopeRows]);

  // Fetch all rows for a thread column (no pagination — threads are small)
  const fetchColumnData = useCallback(
    async (columnIndex, generation) => {
      const thread = threads[columnIndex];
      if (!thread || !dataset) return;

      const indices = thread.memberIndices;
      if (indices.length === 0) {
        if (generation !== generationRef.current) return;
        dispatchColumnData({ type: 'setEmpty', columnIndex });
        return;
      }

      const depthByIndex = new Map();
      for (let i = 0; i < thread.memberIndices.length; i++) {
        const idx = Number(thread.memberIndices[i]);
        if (!Number.isInteger(idx)) continue;
        depthByIndex.set(idx, Number(thread.memberDepths?.[i] ?? 0));
      }

      const localRows = [];
      const missingIndices = [];
      for (const idx of indices) {
        const local = scopeRowByIndex?.get(idx);
        if (local) {
          localRows.push({
            ...local,
            ls_index: Number(local.ls_index ?? idx),
          });
        } else {
          missingIndices.push(idx);
        }
      }

      const shapeAndSort = (rows) => {
        const byIndex = new Map();
        for (const row of rows) {
          const idx = Number(row.ls_index ?? row.index);
          if (!Number.isInteger(idx)) continue;
          byIndex.set(idx, { ...row, ls_index: idx });
        }

        const ordered = indices
          .map((idx) => byIndex.get(idx))
          .filter(Boolean);

        ordered.sort((a, b) => {
          const dateA = parseDateMs(a.created_at);
          const dateB = parseDateMs(b.created_at);
          const hasDateA = Number.isFinite(dateA);
          const hasDateB = Number.isFinite(dateB);
          if (hasDateA && hasDateB && dateA !== dateB) return dateA - dateB;
          if (hasDateA !== hasDateB) return hasDateA ? -1 : 1;
          const depthA = depthByIndex.get(a.ls_index) ?? Number.MAX_SAFE_INTEGER;
          const depthB = depthByIndex.get(b.ls_index) ?? Number.MAX_SAFE_INTEGER;
          if (depthA !== depthB) return depthA - depthB;
          return a.ls_index - b.ls_index;
        });

        return ordered.map((row, i) => ({
          ...row,
          idx: i,
        }));
      };

      if (missingIndices.length === 0) {
        if (generation !== generationRef.current) return;
        dispatchColumnData({ type: 'setRows', columnIndex, rows: shapeAndSort(localRows) });
        return;
      }

      if (generation !== generationRef.current) return;
      dispatchColumnData({ type: 'setLoading', columnIndex });

      try {
        const rows = await appQueryClient.fetchQuery({
          queryKey: queryKeys.rowsByIndices(dataset.id, scope?.id, missingIndices),
          queryFn: ({ signal }) =>
            queryApi.fetchDataFromIndices(dataset.id, missingIndices, scope?.id, { signal }),
          staleTime: 5 * 60 * 1000,
        });
        if (generation !== generationRef.current) return;

        const fetchedRows = rows.map((row) => ({
          ...row,
          ls_index: row.index,
        }));

        const combinedRows = [...localRows, ...fetchedRows];
        dispatchColumnData({ type: 'setRows', columnIndex, rows: shapeAndSort(combinedRows) });
      } catch (err) {
        if (generation !== generationRef.current) return;
        console.error(`Failed to fetch thread column ${columnIndex} data:`, err);
        dispatchColumnData({ type: 'setError', columnIndex });
      }
    },
    [threads, dataset, scope, scopeRowByIndex]
  );

  const pumpQueue = useCallback(() => {
    if (!enabled || !dataset?.id) return;

    while (
      inFlightRef.current.size < MAX_CONCURRENT_FETCHES &&
      pendingQueueRef.current.length > 0
    ) {
      const columnIndex = pendingQueueRef.current.shift();
      if (!Number.isInteger(columnIndex)) continue;

      inFlightRef.current.add(columnIndex);
      const generation = generationRef.current;

      fetchColumnData(columnIndex, generation)
        .finally(() => {
          inFlightRef.current.delete(columnIndex);
          if (generation !== generationRef.current) return;
          pumpQueue();
        });
    }
  }, [enabled, dataset?.id, fetchColumnData]);

  const enqueueColumnFetch = useCallback((columnIndex) => {
    if (fetchedRef.current.has(columnIndex)) return;
    fetchedRef.current.add(columnIndex);
    pendingQueueRef.current.push(columnIndex);
    pumpQueue();
  }, [pumpQueue]);

  // No-op loadMore — threads load all at once
  const loadMore = useCallback(() => {}, []);

  // Lazy-load columns near the focused index
  useEffect(() => {
    if (!enabled || !threads.length || !dataset) return;

    const start = Math.max(0, focusedThreadIndex - PREFETCH_RANGE);
    const end = Math.min(threads.length - 1, focusedThreadIndex + PREFETCH_RANGE);

    for (let i = start; i <= end; i++) {
      enqueueColumnFetch(i);
    }
  }, [enabled, focusedThreadIndex, threads, dataset, enqueueColumnFetch]);

  // Stable thread structure — only recomputes when thread list changes,
  // NOT when column data loads. Labels are static here; FeedColumn reads
  // root tweet text from its own tweets array.
  const threadsAsClusters = useMemo(() => {
    if (!enabled || !threads.length) return EMPTY_THREADS;

    return threads.map((thread) => {
      const engagementStr = formatEngagement(thread.totalEngagement);

      return {
        cluster: `thread-${thread.rootLsIndex}`,
        label: `Thread · ${thread.size} tweets`,
        description: `${engagementStr} engagement`,
        count: thread.size,
        children: null,
        _thread: thread,
      };
    });
  }, [enabled, threads]);

  return {
    threads: threadsAsClusters,
    columnData,
    loadMore,
    threadCount: threads.length,
  };
}

function formatEngagement(num) {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num);
}
