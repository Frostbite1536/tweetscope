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

export const filterConstants = {
  SEARCH: 'search',
  KEYWORD_SEARCH: 'keyword',
  CLUSTER: 'cluster',
  COLUMN: 'column',
  TIME_RANGE: 'timeRange',
};
