import React, { useState, useRef, useEffect, useCallback } from 'react';

import SearchResults from './SearchResults';
import { useScope } from '../../../../contexts/ScopeContext';
import styles from './Container.module.scss';
import { useFilter, FILTER_SLOT } from '../../../../contexts/FilterContext';
import { filterConstants } from './utils';
import { useColorMode } from '../../../../hooks/useColorMode';
import { getClusterColorCSS } from '../DeckGLScatter';

const SEARCH_MODES = {
  KEYWORD: 'keyword',
  SEMANTIC: 'semantic',
};

// ---------------------------------------------------------------------------
// FilterChips — renders active filter slots as removable chips
// ---------------------------------------------------------------------------

const CHIP_META = {
  [FILTER_SLOT.CLUSTER]: { icon: '●', prefix: '' },
  keyword: { icon: '⌕', prefix: 'KW: ' },
  semantic: { icon: '⚡', prefix: 'AI: ' },
  [FILTER_SLOT.COLUMN]: { icon: '▦', prefix: '' },
  [FILTER_SLOT.TIME_RANGE]: { icon: '◷', prefix: '' },
};

const FilterChips = ({ filterSlots, onClearSlot, onClearAll }) => {
  const { isDark: isDarkMode } = useColorMode();

  const chips = [];

  if (filterSlots.cluster) {
    const clusterId = filterSlots.cluster.value;
    const clusterColor = getClusterColorCSS(clusterId, isDarkMode);
    chips.push({
      key: FILTER_SLOT.CLUSTER,
      label: filterSlots.cluster.label,
      meta: CHIP_META[FILTER_SLOT.CLUSTER],
      style: {
        '--chip-bg': `color-mix(in srgb, ${clusterColor} 14%, transparent)`,
        '--chip-border': `color-mix(in srgb, ${clusterColor} 28%, transparent)`,
        '--chip-color': clusterColor,
        '--chip-clear-bg': `color-mix(in srgb, ${clusterColor} 22%, transparent)`,
        '--chip-clear-hover-bg': `color-mix(in srgb, ${clusterColor} 38%, transparent)`,
      },
    });
  }

  if (filterSlots.search) {
    const mode = filterSlots.search.mode;
    chips.push({
      key: FILTER_SLOT.SEARCH,
      label: filterSlots.search.label,
      meta: CHIP_META[mode] || CHIP_META.keyword,
      style: mode === 'semantic' ? {
        '--chip-bg': 'color-mix(in srgb, var(--semantic-color-semantic-info) 12%, transparent)',
        '--chip-border': 'color-mix(in srgb, var(--semantic-color-semantic-info) 24%, transparent)',
        '--chip-color': 'var(--semantic-color-semantic-info)',
        '--chip-clear-bg': 'color-mix(in srgb, var(--semantic-color-semantic-info) 20%, transparent)',
        '--chip-clear-hover-bg': 'color-mix(in srgb, var(--semantic-color-semantic-info) 36%, transparent)',
      } : {},
    });
  }

  if (filterSlots.column) {
    chips.push({
      key: FILTER_SLOT.COLUMN,
      label: filterSlots.column.label,
      meta: CHIP_META[FILTER_SLOT.COLUMN],
      style: {},
    });
  }

  if (filterSlots.timeRange) {
    chips.push({
      key: FILTER_SLOT.TIME_RANGE,
      label: filterSlots.timeRange.label || 'Time range',
      meta: CHIP_META[FILTER_SLOT.TIME_RANGE],
      style: {},
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className={styles.chipRow}>
      {chips.map((chip) => (
        <span key={chip.key} className={styles.chip} style={chip.style}>
          <span className={styles.chipIcon}>{chip.meta.icon}</span>
          <span className={styles.chipLabel} title={chip.label}>
            {chip.meta.prefix}{chip.label}
          </span>
          <button
            className={styles.chipClear}
            onClick={() => onClearSlot(chip.key)}
            aria-label={`Remove ${chip.label} filter`}
          >
            ×
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button className={styles.chipClearAll} onClick={onClearAll} type="button">
          Clear all
        </button>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Container — main search bar + chips + dropdown
// ---------------------------------------------------------------------------

const Container = () => {
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [searchMode, setSearchMode] = useState(SEARCH_MODES.KEYWORD);

  const { clusterLabels } = useScope();
  const {
    filterQuery,
    setFilterQuery,
    filterSlots,
    filterActive,
    applyCluster,
    applySearch,
    applyKeywordSearch,
    applyColumn,
    clearFilter,
    clearAllFilters,
  } = useFilter();

  // Sync search mode from active search slot (e.g. URL hydration)
  useEffect(() => {
    if (filterSlots.search?.mode === 'semantic') {
      setSearchMode(SEARCH_MODES.SEMANTIC);
    } else if (filterSlots.search?.mode === 'keyword') {
      setSearchMode(SEARCH_MODES.KEYWORD);
    }
  }, [filterSlots.search?.mode]);

  const handleInputChange = (val) => {
    setFilterQuery(val);
    setDropdownIsOpen(true);
  };

  const handleInputFocus = () => setIsInputFocused(true);
  const handleInputBlur = () => setIsInputFocused(false);

  // ==== DROPDOWN STATE ====

  const [dropdownIsOpen, setDropdownIsOpen] = useState(false);
  const selectRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (selectRef.current && !selectRef.current.contains(event.target)) {
        setDropdownIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = useCallback((selection) => {
    setDropdownIsOpen(false);
    const { type, value, column, label } = selection;
    if (type === filterConstants.CLUSTER) {
      const clusterId = Number(value);
      if (!Number.isFinite(clusterId)) return;
      const clusterObj = clusterLabels?.find(c => c.cluster === clusterId)
        || { cluster: clusterId, label: label || String(clusterId) };
      applyCluster(clusterObj);
    } else if (type === filterConstants.KEYWORD_SEARCH) {
      applyKeywordSearch(value);
    } else if (type === filterConstants.SEARCH) {
      applySearch(value);
    } else if (type === filterConstants.COLUMN) {
      applyColumn(column, value);
    }
  }, [clusterLabels, applyCluster, applyKeywordSearch, applySearch, applyColumn]);

  const handleEnterKey = useCallback(() => {
    if (!filterQuery) return;
    if (searchMode === SEARCH_MODES.KEYWORD) {
      handleSelect({ type: filterConstants.KEYWORD_SEARCH, value: filterQuery, label: filterQuery });
    } else {
      handleSelect({ type: filterConstants.SEARCH, value: filterQuery, label: filterQuery });
    }
  }, [filterQuery, searchMode, handleSelect]);

  const handleClearSlot = useCallback((slotKey) => {
    // Map slot key to the filterConstants type for clearFilter
    const slotToType = {
      [FILTER_SLOT.CLUSTER]: filterConstants.CLUSTER,
      [FILTER_SLOT.SEARCH]: filterConstants.SEARCH,
      [FILTER_SLOT.COLUMN]: filterConstants.COLUMN,
      [FILTER_SLOT.TIME_RANGE]: filterConstants.TIME_RANGE,
    };
    clearFilter(slotToType[slotKey]);
  }, [clearFilter]);

  const toggleSearchMode = () => {
    setSearchMode((prev) =>
      prev === SEARCH_MODES.KEYWORD ? SEARCH_MODES.SEMANTIC : SEARCH_MODES.KEYWORD
    );
  };

  return (
    <div className={styles.searchContainer}>
      <FilterChips
        filterSlots={filterSlots}
        onClearSlot={handleClearSlot}
        onClearAll={clearAllFilters}
      />
      <div className={styles.searchBarContainer}>
        <div className={styles.inputWrapper}>
          <input
            className={styles.searchInput}
            type="text"
            value={filterQuery}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleEnterKey();
            }}
            placeholder={searchMode === SEARCH_MODES.KEYWORD
              ? 'Search by keyword...'
              : 'Search by meaning...'}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
          />
          <button
            className={`${styles.modeToggle} ${searchMode === SEARCH_MODES.SEMANTIC ? styles.modeToggleSemantic : ''}`}
            onClick={toggleSearchMode}
            title={searchMode === SEARCH_MODES.KEYWORD
              ? 'Keyword search (BM25) — click to switch to Semantic'
              : 'Semantic search (AI) — click to switch to Keyword'}
            type="button"
          >
            {searchMode === SEARCH_MODES.KEYWORD ? 'Keyword' : 'Semantic'}
          </button>
        </div>

        <div className={styles.searchResults} ref={selectRef}>
          <div className={styles.searchResultsHeader}>
            <SearchResults
              query={filterQuery}
              onSelect={handleSelect}
              menuIsOpen={dropdownIsOpen || (isInputFocused && filterQuery === '')}
              searchMode={searchMode}
            />
          </div>
        </div>
      </div>
      <SearchResultsMetadata filterSlots={filterSlots} />
    </div>
  );
};

const SearchResultsMetadata = ({ filterSlots }) => {
  const { shownIndices, filteredIndices, filterActive } = useFilter();

  if (!filterActive) {
    return (
      <div className={styles.searchResultsMetadata}>
        <div className={styles.searchResultsMetadataItem}>
          <span className={styles.searchResultsMetadataLabel}>
            Showing first {shownIndices.length} rows
          </span>
        </div>
        <div className={styles.searchResultsMetadataItem}>
          <span className={styles.searchResultsMetadataValue}>
            {filteredIndices.length} total
          </span>
        </div>
      </div>
    );
  }

  // Build a summary of all active filter labels
  const activeLabels = [];
  if (filterSlots.cluster) activeLabels.push(`Cluster: ${filterSlots.cluster.label}`);
  if (filterSlots.search) {
    const prefix = filterSlots.search.mode === 'keyword' ? 'Keyword' : 'Semantic';
    activeLabels.push(`${prefix}: ${filterSlots.search.label}`);
  }
  if (filterSlots.column) activeLabels.push(`Column: ${filterSlots.column.label}`);
  if (filterSlots.timeRange) activeLabels.push(filterSlots.timeRange.label || 'Time range');

  const totalResults = filteredIndices.length;

  return (
    <div className={styles.searchResultsMetadata}>
      <div className={styles.searchResultsMetadataItem}>
        <span className={styles.searchResultsMetadataLabel}>
          {activeLabels.join(' + ')}
        </span>
      </div>
      <div className={styles.searchResultsMetadataItem}>
        <span className={styles.searchResultsMetadataValue}>{totalResults} rows</span>
      </div>
    </div>
  );
};

export default Container;
