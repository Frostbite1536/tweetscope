import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { graphClient } from '../lib/apiService';
import { queryKeys } from '../query/keys';
import type { NodeStatsEntry, NodeStatsResponse } from '../api/types';

interface UseNodeStatsResult {
  statsMap: Map<number | string, NodeStatsEntry> | null;
  tweetIdMap: Map<number | string, string> | null;
  loading: boolean;
}

type NodeStatsMaps = {
  statsMap: Map<number | string, NodeStatsEntry>;
  tweetIdMap: Map<number | string, string>;
};

function normalizeLsIndex(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function setDualKey<T>(map: Map<number | string, T>, lsIndex: number, value: T) {
  map.set(lsIndex, value);
  map.set(String(lsIndex), value);
}

function buildNodeStatsMaps(data: NodeStatsResponse | null | undefined): NodeStatsMaps {
  const indices = Array.isArray(data?.ls_index) ? data.ls_index : [];
  const statsMap = new Map<number | string, NodeStatsEntry>();
  const tweetIdMap = new Map<number | string, string>();

  for (let i = 0; i < indices.length; i++) {
    const lsIndex = normalizeLsIndex(indices[i]);
    if (lsIndex == null) continue;

    const stats: NodeStatsEntry = {
      threadDepth: data?.thread_depth?.[i] ?? 0,
      threadSize: data?.thread_size?.[i] ?? 1,
      replyChildCount: data?.reply_child_count?.[i] ?? 0,
      replyInCount: data?.reply_in_count?.[i] ?? 0,
      replyOutCount: data?.reply_out_count?.[i] ?? 0,
      quoteInCount: data?.quote_in_count?.[i] ?? 0,
      quoteOutCount: data?.quote_out_count?.[i] ?? 0,
      threadRootId: data?.thread_root_id?.[i] ?? null,
      tweetId: data?.tweet_id?.[i] ?? null,
    };

    setDualKey(statsMap, lsIndex, stats);
    if (data?.tweet_id?.[i]) {
      setDualKey(tweetIdMap, lsIndex, data.tweet_id[i] as string);
    }
  }

  return { statsMap, tweetIdMap };
}

export default function useNodeStats(
  datasetId: string | undefined,
  linksAvailable: boolean
): UseNodeStatsResult {
  const query = useQuery({
    queryKey: queryKeys.nodeStats(datasetId),
    enabled: Boolean(datasetId && linksAvailable),
    queryFn: ({ signal }) => graphClient.fetchNodeStats(datasetId!, { signal }),
    staleTime: 5 * 60 * 1000,
  });

  const maps = useMemo(() => {
    if (!query.data) return null;
    return buildNodeStatsMaps(query.data);
  }, [query.data]);

  return {
    statsMap: maps?.statsMap ?? null,
    tweetIdMap: maps?.tweetIdMap ?? null,
    loading: query.isFetching,
  };
}
