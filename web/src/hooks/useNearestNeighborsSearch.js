import { useState, useCallback } from 'react';
import { queryClient } from '../lib/apiService';

export default function useNearestNeighborsSearch({ userId, datasetId, scope, deletedIndices }) {
  const [distances, setDistances] = useState([]);

  const uniqueOrdered = (values) => {
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
  };

  const filter = async (query) => {
    try {
      return await queryClient
        .searchNearestNeighbors(datasetId, scope.embedding, query, scope)
        .then((data) => {
          const { indices, distances } = data;
          const filteredIndices = uniqueOrdered(indices).filter((idx) => !deletedIndices.includes(idx));
          setDistances(distances);
          const limit = 20;
          return filteredIndices.slice(0, limit);
        });
    } catch (error) {
      console.error('Search failed:', error);
      return [];
    }
  };

  const clear = useCallback(() => {
    setDistances([]);
  }, []);

  return {
    filter,
    clear,
    distances,
  };
}
