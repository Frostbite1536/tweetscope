import { useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryApi } from '../lib/apiService';
import { queryKeys } from '../query/keys';

export default function useNearestNeighborsSearch({ userId, datasetId, scope, deletedIndices }) {
  const queryClient = useQueryClient();
  const [distances, setDistances] = useState([]);
  const [distanceMap, setDistanceMap] = useState(() => new Map());
  // deletedIndices is already a Set from ScopeContext
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
    if (!datasetId || !scope?.embedding?.id || !query) {
      setDistances([]);
      setDistanceMap(new Map());
      return [];
    }

    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.nearestNeighbors(datasetId, scope?.id, scope?.embedding?.id, query),
        queryFn: ({ signal }) =>
          queryApi.searchNearestNeighbors(datasetId, scope.embedding, query, scope, { signal }),
        staleTime: 30_000,
      });

      const { indices, distances: rawDistances } = data;
      setDistances(rawDistances);

      const dMap = new Map();
      for (let i = 0; i < indices.length; i++) {
        dMap.set(Number(indices[i]), rawDistances[i]);
      }
      setDistanceMap(dMap);

      return uniqueOrdered(indices).filter((idx) => !deletedSet.has(idx));
    } catch (error) {
      console.error('Search failed:', error);
      return [];
    }
  }, [queryClient, datasetId, scope, uniqueOrdered, deletedSet]);

  const clear = useCallback(() => {
    setDistances([]);
    setDistanceMap(new Map());
  }, []);

  return useMemo(
    () => ({
      filter,
      clear,
      distances,
      distanceMap,
    }),
    [filter, clear, distances, distanceMap]
  );
}
