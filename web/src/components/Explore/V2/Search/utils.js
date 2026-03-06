export const findClustersByQuery = (clusters, query, top = 5) => {
  if (!query) {
    return clusters.slice(0, top).map((cluster) => ({
      value: cluster.cluster,
      label: cluster.label,
    }));
  }

  const searchTerm = query.toLowerCase();
  return clusters
    .filter((cluster) => cluster.label.toLowerCase().includes(searchTerm))
    .slice(0, top)
    .map((cluster) => ({
      value: cluster.cluster,
      label: cluster.label,
    }));
};

export const isSameClusterValue = (a, b) => {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;

  const aNum = Number(a);
  const bNum = Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum === bNum) return true;

  return String(a) === String(b);
};

// check that the given column and value are valid
// meaning that the column exists and the value is one of the categories
export const validateColumnAndValue = (column, value, columnFilters) => {
  const columnFilter = columnFilters.find((c) => c.column === column);
  if (!columnFilter) return false;
  return columnFilter.categories.includes(value);
};

export const NUM_SEARCH_RESULTS = 4;
const CLUSTERS_GROUP = 'Clusters';

export function buildGroupedOptions(query, clusterLabels) {
  const groups = [];
  if (query.trim() !== '') {
    groups.push({ label: 'Search', options: [{ value: query, label: query, isKeywordSearch: true }] });
  }
  const clusterOptions = findClustersByQuery(clusterLabels, query, NUM_SEARCH_RESULTS);
  if (clusterOptions.length > 0) {
    groups.push({ label: CLUSTERS_GROUP, options: clusterOptions });
  }
  return groups;
}

export function flattenGroups(groups) {
  const items = [];
  for (const group of groups) {
    for (const option of group.options) {
      items.push({ ...option, group: group.label });
    }
  }
  return items;
}

export const filterConstants = {
  SEARCH: 'search',
  KEYWORD_SEARCH: 'keyword',
  CLUSTER: 'cluster',
  COLUMN: 'column',
  TIME_RANGE: 'timeRange',
  ENGAGEMENT: 'engagement',
  THREAD: 'thread',
};

// Maps FILTER_SLOT keys → filterConstants values (imported by Container + FilterChips)
// Needs FILTER_SLOT at call site — kept as a plain object keyed by slot string.
export const SLOT_TO_FILTER_TYPE = {
  cluster: filterConstants.CLUSTER,
  search: filterConstants.SEARCH,
  column: filterConstants.COLUMN,
  timeRange: filterConstants.TIME_RANGE,
  engagement: filterConstants.ENGAGEMENT,
  thread: filterConstants.THREAD,
};

const ENGAGEMENT_PATTERN = /\b(?:min_faves|min_likes):(\d+)\b/gi;

export function parseEngagementOperators(query) {
  let minFaves = null;
  const remaining = query.replace(ENGAGEMENT_PATTERN, (_, n) => {
    const parsed = parseInt(n, 10);
    if (parsed > 0) minFaves = parsed;
    return '';
  }).replace(/\s{2,}/g, ' ').trim();
  return { minFaves, remainingQuery: remaining };
}
