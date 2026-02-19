import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';

import { apiUrl, catalogClient, viewClient } from '../lib/apiService';
import type { ClusterLabel, JsonRecord, ScopeData, ScopeRow } from '../api/types';
import { queryKeys } from '../query/keys';

type DatasetMeta = ScopeData['dataset'];
type ClusterMapEntry = ClusterLabel | { cluster: string | number; label: string };

interface ClusterTreeNode extends ClusterLabel {
  children: ClusterTreeNode[];
  cumulativeLikes?: number;
  cumulativeCount?: number;
}

interface ClusterHierarchy {
  name: string;
  children: ClusterTreeNode[];
  layers: number[];
  totalClusters: number;
}

interface ScopeContextValue {
  userId?: string;
  datasetId?: string;
  scopeId?: string;
  dataset: DatasetMeta | null;
  scope: ScopeData | null;
  scopeLoaded: boolean;
  clusterMap: Record<number, ClusterMapEntry>;
  clusterLabels: ClusterLabel[];
  clusterHierarchy: ClusterHierarchy | null;
  scopeRows: ScopeRow[];
  deletedIndices: Set<number>;
  scopes: ScopeData[];
  embeddings: JsonRecord[];
  tags: string[];
  scopeError: string | null;
  scopeRowsError: string | null;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);
const EMPTY_SCOPE_ROWS: ScopeRow[] = [];
const EMPTY_SCOPES: ScopeData[] = [];
const EMPTY_EMBEDDINGS: JsonRecord[] = [];

function toNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const num = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function normalizeScopeRows(rows: ScopeRow[]): ScopeRow[] {
  return (rows || []).map((row, idx) => {
    const lsIndexRaw = row?.ls_index ?? row?.index ?? idx;
    const lsIndex = Number.isFinite(Number(lsIndexRaw)) ? Number(lsIndexRaw) : idx;
    return {
      ...row,
      ls_index: lsIndex,
    };
  });
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const { user: userId, dataset: datasetId, scope: scopeId } = useParams<{
    user?: string;
    dataset?: string;
    scope?: string;
  }>();

  const scopeQuery = useQuery({
    queryKey: queryKeys.scope(datasetId, scopeId),
    enabled: Boolean(datasetId && scopeId),
    queryFn: ({ signal }) => catalogClient.fetchScope(datasetId!, scopeId!, { signal }),
    staleTime: 5 * 60 * 1000,
  });

  const scope = scopeQuery.data ?? null;
  const dataset = scope?.dataset ?? null;

  const scopesQuery = useQuery({
    queryKey: queryKeys.scopes(datasetId),
    enabled: Boolean(datasetId),
    queryFn: ({ signal }) => catalogClient.fetchScopes(datasetId!, { signal }),
    staleTime: 5 * 60 * 1000,
  });

  const embeddingsQuery = useQuery({
    queryKey: queryKeys.embeddings(datasetId),
    enabled: Boolean(datasetId),
    queryFn: ({ signal }) => catalogClient.fetchEmbeddings(datasetId!, { signal }),
    staleTime: 5 * 60 * 1000,
  });

  const tagsetQuery = useQuery({
    queryKey: queryKeys.tags(datasetId),
    enabled: Boolean(datasetId),
    queryFn: async ({ signal }) => {
      const res = await fetch(`${apiUrl}/tags?dataset=${datasetId}`, { signal });
      if (!res.ok) {
        throw new Error(`Failed to fetch tags (${res.status})`);
      }
      return (await res.json()) as Record<string, unknown>;
    },
    staleTime: 5 * 60 * 1000,
  });

  const scopeRowsQuery = useQuery({
    queryKey: queryKeys.scopeRows(datasetId, scope?.id),
    enabled: Boolean(datasetId && scope?.id),
    queryFn: ({ signal }) => viewClient.fetchScopeRows(datasetId!, scope!.id, { signal }),
    select: normalizeScopeRows,
    staleTime: 5 * 60 * 1000,
  });

  const scopeRows = scopeRowsQuery.data ?? EMPTY_SCOPE_ROWS;
  const scopeLoaded = Boolean(datasetId && scope?.id && scopeRowsQuery.isSuccess);
  const scopes = scopesQuery.data ?? EMPTY_SCOPES;
  const embeddings = embeddingsQuery.data ?? EMPTY_EMBEDDINGS;

  const tags = useMemo(() => {
    const tagset = tagsetQuery.data ?? {};
    return Object.keys(tagset);
  }, [tagsetQuery.data]);

  const scopeError = scopeQuery.error instanceof Error ? scopeQuery.error.message : null;
  const scopeRowsError =
    scopeRowsQuery.error instanceof Error ? scopeRowsQuery.error.message : null;

  const buildClusterTree = useCallback((labels: ClusterLabel[]): ClusterHierarchy | null => {
    if (!labels || labels.length === 0) return null;

    const byLayer: Record<number, ClusterLabel[]> = {};
    labels.forEach((label) => {
      const layer = Number(label.layer ?? 0);
      if (!byLayer[layer]) byLayer[layer] = [];
      byLayer[layer].push(label);
    });

    const layers = Object.keys(byLayer)
      .map(Number)
      .sort((a, b) => b - a);
    const maxLayer = layers[0] ?? 0;

    const labelMap = new Map<string, ClusterTreeNode>();
    labels.forEach((label) => {
      const node: ClusterTreeNode = { ...label, children: [] };
      labelMap.set(String(label.cluster), node);
    });

    labels.forEach((label) => {
      if (!label.parent_cluster) return;
      const parent = labelMap.get(String(label.parent_cluster));
      const child = labelMap.get(String(label.cluster));
      if (parent && child) {
        parent.children.push(child);
      }
    });

    const roots = labels
      .filter((label) => Number(label.layer ?? 0) === maxLayer || !label.parent_cluster)
      .map((label) => labelMap.get(String(label.cluster)))
      .filter((node): node is ClusterTreeNode => Boolean(node));

    const computeCumulativeMetrics = (node: ClusterTreeNode) => {
      let cumulativeLikes = Number(node.likes ?? 0);
      let cumulativeCount = Number(node.count ?? 0);

      if (node.children.length > 0) {
        node.children.forEach((child) => {
          computeCumulativeMetrics(child);
          cumulativeLikes += child.cumulativeLikes ?? 0;
          cumulativeCount += child.cumulativeCount ?? 0;
        });
      }

      node.cumulativeLikes = cumulativeLikes;
      node.cumulativeCount = cumulativeCount;
    };

    roots.forEach(computeCumulativeMetrics);

    const sortChildren = (node: ClusterTreeNode) => {
      if (node.children.length > 0) {
        node.children.sort((a, b) => {
          const likesDiff = (b.cumulativeLikes ?? 0) - (a.cumulativeLikes ?? 0);
          if (likesDiff !== 0) return likesDiff;
          return (b.cumulativeCount ?? 0) - (a.cumulativeCount ?? 0);
        });
        node.children.forEach(sortChildren);
      }
    };

    roots.sort((a, b) => {
      const likesDiff = (b.cumulativeLikes ?? 0) - (a.cumulativeLikes ?? 0);
      if (likesDiff !== 0) return likesDiff;
      return (b.cumulativeCount ?? 0) - (a.cumulativeCount ?? 0);
    });
    roots.forEach(sortChildren);

    return {
      name: 'Root',
      children: roots,
      layers,
      totalClusters: labels.length,
    };
  }, []);

  const { clusterMap, clusterLabels, clusterHierarchy, deletedIndices } = useMemo(() => {
    const labelSource = Array.isArray(scope?.cluster_labels_lookup)
      ? scope.cluster_labels_lookup
      : [];

    const preparedLabels: ClusterLabel[] = labelSource
      .filter(Boolean)
      .map((label) => ({ ...label, count: 0, likes: 0 }));

    const clusterLookupMap = new Map<string | number, ClusterLabel>();
    preparedLabels.forEach((cluster, idx) => {
      clusterLookupMap.set(cluster.cluster, cluster);
      clusterLookupMap.set(idx, cluster);
    });

    const nextClusterMap: Record<number, ClusterMapEntry> = {};
    const nonDeletedClusters = new Set<string | number>();
    const nextDeletedIndices: number[] = [];

    scopeRows.forEach((row) => {
      const cluster =
        clusterLookupMap.get(row.cluster) ??
        clusterLookupMap.get(Number(row.cluster));
      if (cluster) {
        cluster.count = Number(cluster.count ?? 0) + 1;
        const likesValue = toNumber(
          row.favorites ?? row.favorite_count ?? row.like_count ?? row.likes
        );
        cluster.likes = Number(cluster.likes ?? 0) + likesValue;
      }

      nextClusterMap[row.ls_index] =
        cluster ?? { cluster: row.cluster, label: row.label || 'Unknown' };

      if (!row.deleted) {
        nonDeletedClusters.add(row.cluster);
      } else {
        nextDeletedIndices.push(row.ls_index);
      }
    });

    const visibleLabels = preparedLabels.filter((label) =>
      nonDeletedClusters.has(label.cluster)
    );
    const hierarchy =
      scope?.hierarchical_labels && visibleLabels.length > 0
        ? buildClusterTree(visibleLabels)
        : null;

    return {
      clusterMap: nextClusterMap,
      clusterLabels: visibleLabels,
      clusterHierarchy: hierarchy,
      deletedIndices: new Set(nextDeletedIndices),
    };
  }, [scope, scopeRows, buildClusterTree]);

  const value = useMemo<ScopeContextValue>(
    () => ({
      userId,
      datasetId,
      scopeId,
      dataset,
      scope,
      scopeLoaded,
      clusterMap,
      clusterLabels,
      clusterHierarchy,
      scopeRows,
      deletedIndices,
      scopes,
      embeddings,
      tags,
      scopeError,
      scopeRowsError,
    }),
    [
      userId,
      datasetId,
      scopeId,
      dataset,
      scope,
      scopeLoaded,
      clusterMap,
      clusterLabels,
      clusterHierarchy,
      scopeRows,
      deletedIndices,
      scopes,
      embeddings,
      tags,
      scopeError,
      scopeRowsError,
    ]
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const context = useContext(ScopeContext);
  if (!context) {
    throw new Error('useScope must be used within a ScopeProvider');
  }
  return context;
}
