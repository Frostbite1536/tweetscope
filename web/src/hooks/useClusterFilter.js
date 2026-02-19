import { useState, useCallback, useMemo } from 'react';

export default function useClusterFilter({ scopeRows }) {
  const [cluster, setCluster] = useState(null);

  const filter = useCallback((nextCluster) => {
    if (!nextCluster) return [];
    const annots = scopeRows.filter((d) => d.cluster === nextCluster.cluster);
    return annots.map((d) => d.ls_index);
  }, [scopeRows]);

  const clear = useCallback(() => {
    setCluster(null);
  }, []);

  return useMemo(
    () => ({
      cluster,
      setCluster,
      filter,
      clear,
    }),
    [cluster, setCluster, filter, clear]
  );
}
