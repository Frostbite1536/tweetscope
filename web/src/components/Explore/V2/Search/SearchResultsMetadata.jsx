import React from 'react';
import { ArrowDownNarrowWide, ArrowUpNarrowWide } from 'lucide-react';
import styles from './Container.module.scss';
import { useFilter } from '@/contexts/FilterContext';

const SORT_LABELS = { recent: 'Recent', likes: 'Likes', relevance: 'Relevance' };

const SearchResultsMetadata = ({ filterSlots }) => {
  const { filteredIndices, filterActive, sortKey, setSortKey, sortDirection, setSortDirection } = useFilter();

  const hasSearch = filterSlots.search !== null;
  const sortOptions = hasSearch
    ? ['recent', 'likes', 'relevance']
    : ['recent', 'likes'];

  const cycleSortKey = () => {
    const idx = sortOptions.indexOf(sortKey);
    setSortKey(sortOptions[(idx + 1) % sortOptions.length]);
  };

  const toggleDirection = () => setSortDirection((d) => (d === 'desc' ? 'asc' : 'desc'));

  const label = filterActive
    ? [
        filterSlots.cluster?.label,
        filterSlots.search?.label,
        filterSlots.column?.label,
        filterSlots.timeRange?.label || (filterSlots.timeRange && 'Time range'),
        filterSlots.engagement?.label,
      ].filter(Boolean).join(' + ')
    : null;

  return (
    <div className={styles.metadataRow}>
      <span className={styles.metadataCount}>
        {filteredIndices.length} {filterActive ? 'results' : 'total'}
        {label && (
          <span className={styles.metadataLabel} title={label}> — {label}</span>
        )}
      </span>
      <div className={styles.metadataRight}>
        <button
          className={styles.sortDirectionButton}
          onClick={toggleDirection}
          type="button"
          title={sortDirection === 'desc' ? 'Descending' : 'Ascending'}
        >
          {sortDirection === 'desc' ? <ArrowDownNarrowWide size={13} /> : <ArrowUpNarrowWide size={13} />}
        </button>
        <button
          className={styles.sortCycleButton}
          onClick={cycleSortKey}
          type="button"
          title={`Sort by ${SORT_LABELS[sortKey]} — click to cycle`}
        >
          {SORT_LABELS[sortKey]}
        </button>
      </div>
    </div>
  );
};

export default SearchResultsMetadata;
