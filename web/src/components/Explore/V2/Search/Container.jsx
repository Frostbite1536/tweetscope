import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, Type, Sparkles } from 'lucide-react';

import SearchResults from './SearchResults';
import { useScope } from '../../../../contexts/ScopeContext';
import styles from './Container.module.scss';
import { useFilter, FILTER_SLOT } from '../../../../contexts/FilterContext';
import { filterConstants, isSameClusterValue } from './utils';
import { useColorMode } from '../../../../hooks/useColorMode';
import { useClusterColors, resolveClusterColorCSS } from '@/hooks/useClusterColors';

const SEARCH_MODES = {
  KEYWORD: 'keyword',
  SEMANTIC: 'semantic',
};

// ---------------------------------------------------------------------------
// FilterChips — renders active filter slots as removable inline chips
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
  const { clusterLabels, clusterHierarchy } = useScope();
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);

  const chips = [];

  if (filterSlots.cluster) {
    const clusterId = filterSlots.cluster.value;
    const clusterColor = resolveClusterColorCSS(colorMap, clusterId, isDarkMode);
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
            <X size={9} />
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
  const containerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
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
      const clusterObj = clusterLabels?.find((c) => isSameClusterValue(c.cluster, value))
        || {
          cluster: Number.isFinite(Number(value)) ? Number(value) : value,
          label: label || String(value),
        };
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
    const slotToType = {
      [FILTER_SLOT.CLUSTER]: filterConstants.CLUSTER,
      [FILTER_SLOT.SEARCH]: filterConstants.SEARCH,
      [FILTER_SLOT.COLUMN]: filterConstants.COLUMN,
      [FILTER_SLOT.TIME_RANGE]: filterConstants.TIME_RANGE,
    };
    clearFilter(slotToType[slotKey]);
  }, [clearFilter]);

  const menuIsOpen = dropdownIsOpen || (isInputFocused && filterQuery === '');

  return (
    <div className={styles.searchContainer} ref={containerRef}>
      {/* Search row: icon + chips + input + mode pill */}
      <div className={styles.searchBarRow}>
        <Search size={15} className={styles.searchIcon} />
        <div className={styles.inputWrapper}>
          <FilterChips
            filterSlots={filterSlots}
            onClearSlot={handleClearSlot}
            onClearAll={clearAllFilters}
          />
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
        </div>
        {/* Inner pill toggle */}
        <div className={styles.modePill}>
          <button
            className={`${styles.modeButton} ${searchMode === SEARCH_MODES.KEYWORD ? styles.modeButtonActive : ''}`}
            onClick={() => setSearchMode(SEARCH_MODES.KEYWORD)}
            type="button"
          >
            <Type size={11} className={styles.modeIcon} />
            Keyword
          </button>
          <button
            className={`${styles.modeButton} ${searchMode === SEARCH_MODES.SEMANTIC ? styles.modeButtonActiveSemantic : ''}`}
            onClick={() => setSearchMode(SEARCH_MODES.SEMANTIC)}
            type="button"
          >
            <Sparkles size={11} className={styles.modeIcon} />
            Semantic
          </button>
        </div>
      </div>

      {/* Dropdown results */}
      {menuIsOpen && (
        <div className={styles.searchResultsDropdown}>
          <SearchResults
            query={filterQuery}
            onSelect={handleSelect}
            menuIsOpen={menuIsOpen}
            searchMode={searchMode}
          />
        </div>
      )}

      {/* Simplified metadata */}
      <SearchResultsMetadata filterSlots={filterSlots} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// SearchResultsMetadata — simplified count display
// ---------------------------------------------------------------------------

const SearchResultsMetadata = ({ filterSlots }) => {
  const { filteredIndices, filterActive } = useFilter();

  const label = filterActive
    ? (() => {
        const parts = [];
        if (filterSlots.cluster) parts.push(filterSlots.cluster.label);
        if (filterSlots.search) parts.push(filterSlots.search.label);
        if (filterSlots.column) parts.push(filterSlots.column.label);
        if (filterSlots.timeRange) parts.push(filterSlots.timeRange.label || 'Time range');
        return parts.join(' + ');
      })()
    : null;

  const count = filteredIndices.length;

  return (
    <div className={styles.metadataRow}>
      {label && (
        <span className={styles.metadataLabel} title={label}>{label}</span>
      )}
      <span className={styles.metadataCount}>
        {count} {filterActive ? 'results' : 'total'}
      </span>
    </div>
  );
};

export default Container;
