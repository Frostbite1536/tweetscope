import { useState, useCallback } from 'react';
import { queryClient } from '../lib/apiService';

export default function useNearestNeighborsSearch({ userId, datasetId, scope, deletedIndices }) {
  const [distances, setDistances] = useState([]);
  const [distanceMap, setDistanceMap] = useState(() => new Map());

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
          const { indices, distances: rawDistances } = data;
          setDistances(rawDistances);

          // Build ls_index → distance map from the parallel arrays
          const dMap = new Map();
          for (let i = 0; i < indices.length; i++) {
            dMap.set(Number(indices[i]), rawDistances[i]);
          }
          setDistanceMap(dMap);

          // Return all results (let FilterContext handle pagination)
          const filteredIndices = uniqueOrdered(indices).filter((idx) => !deletedIndices.includes(idx));
          return filteredIndices;
        });
    } catch (error) {
      console.error('Search failed:', error);
      return [];
    }
  };

  const clear = useCallback(() => {
    setDistances([]);
    setDistanceMap(new Map());
  }, []);

  return {
    filter,
    clear,
    distances,
    distanceMap,
  };
}
