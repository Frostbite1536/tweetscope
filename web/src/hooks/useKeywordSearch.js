import { useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryApi } from '../lib/apiService';
import { queryKeys } from '../query/keys';

export default function useKeywordSearch({ datasetId, scope, deletedIndices }) {
  const queryClient = useQueryClient();
  const [scores, setScores] = useState([]);
  const [scoreMap, setScoreMap] = useState(() => new Map());
  const deletedSet = deletedIndices;

  const uniqueOrdered = useCallback((values) => {
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
  }, []);

  const filter = useCallback(async (query) => {
    if (!datasetId || !scope?.id || !query) {
      setScores([]);
      setScoreMap(new Map());
      return [];
    }

    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.keywordSearch(datasetId, scope?.id, query),
        queryFn: ({ signal }) =>
          queryApi.searchKeyword(datasetId, query, scope, { signal }),
        staleTime: 30_000,
      });

      const { indices, scores: rawScores } = data;
      setScores(rawScores);

      const sMap = new Map();
      for (let i = 0; i < indices.length; i++) {
        sMap.set(Number(indices[i]), rawScores[i]);
      }
      setScoreMap(sMap);

      return uniqueOrdered(indices).filter((idx) => !deletedSet.has(idx));
    } catch (error) {
      console.error('[KeywordSearch] failed:', error);
      setScores([]);
      setScoreMap(new Map());
      return [];
    }
  }, [queryClient, datasetId, scope, uniqueOrdered, deletedSet]);

  const clear = useCallback(() => {
    setScores([]);
    setScoreMap(new Map());
  }, []);

  return useMemo(
    () => ({
      filter,
      clear,
      scores,
      scoreMap,
    }),
    [filter, clear, scores, scoreMap]
  );
}
