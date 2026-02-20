import { useState, useCallback, useMemo } from 'react';

function buildDescendantSet(childrenByParent, clusterId) {
  const rootId = String(clusterId);
  const included = new Set([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const children = childrenByParent.get(currentId);
    if (!children) continue;
    for (const childId of children) {
      if (included.has(childId)) continue;
      included.add(childId);
      queue.push(childId);
    }
  }

  return included;
}

export default function useClusterFilter({ scopeRows, clusterLabels = [] }) {
  const [cluster, setCluster] = useState(null);
  const childrenByParent = useMemo(() => {
    const map = new Map();
    for (const label of clusterLabels || []) {
      if (!label) continue;
      if (label.parent_cluster === null || label.parent_cluster === undefined) continue;
      const parentId = String(label.parent_cluster);
      const childId = String(label.cluster);
      if (!map.has(parentId)) {
        map.set(parentId, new Set());
      }
      map.get(parentId).add(childId);
    }
    return map;
  }, [clusterLabels]);

  const filter = useCallback((nextCluster) => {
    if (!nextCluster) return [];
    const includedClusters = buildDescendantSet(childrenByParent, nextCluster.cluster);
    const annots = scopeRows.filter((d) => includedClusters.has(String(d.cluster)));
    return annots.map((d) => d.ls_index);
  }, [scopeRows, childrenByParent]);

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
