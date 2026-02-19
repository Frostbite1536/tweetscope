import { useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryApi } from '../lib/apiService';
import { queryKeys } from '../query/keys';

const useColumnFilter = (userId, datasetId, scope) => {
  const queryClient = useQueryClient();
  const [columnToValue, setColumnToValue] = useState({});

  const dataset = useMemo(() => {
    return scope?.dataset;
  }, [scope]);

  const columnFilters = useMemo(() => {
    if (!dataset?.column_metadata) return [];
    return Object.keys(dataset.column_metadata)
      .map((column) => ({
        column,
        categories: dataset.column_metadata[column].categories,
        counts: dataset.column_metadata[column].counts,
      }))
      .filter((d) => d.counts && Object.keys(d.counts).length > 1);
  }, [dataset]);

  const filter = useCallback(async (column, value) => {
    const query = [{ column, type: 'eq', value }];
    const data = await queryClient.fetchQuery({
      queryKey: queryKeys.columnFilter(datasetId, scope?.id, column, value),
      queryFn: ({ signal }) => queryApi.columnFilter(datasetId, query, scope?.id, { signal }),
      staleTime: 30_000,
    });
    return data.indices;
  }, [queryClient, datasetId, scope?.id]);

  const clear = useCallback(() => {
    setColumnToValue({});
  }, []);

  return useMemo(
    () => ({
      columnToValue,
      columnFilters,
      filter,
      clear,
    }),
    [columnToValue, columnFilters, filter, clear]
  );
};

export default useColumnFilter;
