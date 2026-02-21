import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useCombobox } from 'downshift';
import { Search, Type, Sparkles } from 'lucide-react';

import FilterChips from './FilterChips';
import SearchResults from './SearchResults';
import SearchResultsMetadata from './SearchResultsMetadata';
import { useScope } from '@/contexts/ScopeContext';
import styles from './Container.module.scss';
import { useFilter, FILTER_SLOT } from '@/contexts/FilterContext';
import {
  isSameClusterValue,
  parseEngagementOperators,
  buildGroupedOptions,
  flattenGroups,
  SLOT_TO_FILTER_TYPE,
} from './utils';

const SEARCH_MODES = { KEYWORD: 'keyword', SEMANTIC: 'semantic' };

// Ordered list of filter slots for backspace-to-clear (last active gets removed first)
const CHIP_ORDER = [
  FILTER_SLOT.CLUSTER, FILTER_SLOT.SEARCH, FILTER_SLOT.COLUMN,
  FILTER_SLOT.TIME_RANGE, FILTER_SLOT.ENGAGEMENT,
];

const Container = () => {
  const [searchMode, setSearchMode] = useState(SEARCH_MODES.KEYWORD);
  const { clusterLabels } = useScope();
  const {
    filterQuery, setFilterQuery,
    filterSlots, applyCluster, applySearch, applyKeywordSearch,
    applyEngagement, clearFilter, clearAllFilters,
  } = useFilter();

  // Sync search mode from active search slot (e.g. URL hydration)
  useEffect(() => {
    if (filterSlots.search?.mode === 'semantic') setSearchMode(SEARCH_MODES.SEMANTIC);
    else if (filterSlots.search?.mode === 'keyword') setSearchMode(SEARCH_MODES.KEYWORD);
  }, [filterSlots.search?.mode]);

  // Build items for downshift
  const groupedOptions = useMemo(
    () => buildGroupedOptions(filterQuery, searchMode, clusterLabels),
    [filterQuery, searchMode, clusterLabels],
  );
  const flatItems = useMemo(() => flattenGroups(groupedOptions), [groupedOptions]);

  // Apply a dropdown selection as a filter
  const applySelection = useCallback((item) => {
    if (!item) return;
    if (item.isKeywordSearch) return applyKeywordSearch(item.value);
    if (item.isSemanticSearch) return applySearch(item.value);
    const clusterObj = clusterLabels?.find((c) => isSameClusterValue(c.cluster, item.value))
      || {
        cluster: Number.isFinite(Number(item.value)) ? Number(item.value) : item.value,
        label: item.label || String(item.value),
      };
    applyCluster(clusterObj);
  }, [clusterLabels, applyCluster, applyKeywordSearch, applySearch]);

  // Enter with no highlighted item → run search / engagement operators
  const handleEnterKeyRef = useRef(null);
  handleEnterKeyRef.current = useCallback(() => {
    if (!filterQuery) return;
    const { minFaves, remainingQuery } = parseEngagementOperators(filterQuery);
    if (minFaves) applyEngagement(minFaves);
    if (remainingQuery) {
      (searchMode === SEARCH_MODES.KEYWORD ? applyKeywordSearch : applySearch)(remainingQuery);
    } else if (minFaves) {
      setFilterQuery('');
    }
  }, [filterQuery, searchMode, applyKeywordSearch, applySearch, applyEngagement, setFilterQuery]);

  // Backspace on empty input → clear last active chip
  const clearLastChip = useCallback(() => {
    if (filterQuery !== '') return;
    for (let i = CHIP_ORDER.length - 1; i >= 0; i--) {
      if (filterSlots[CHIP_ORDER[i]]) {
        clearFilter(SLOT_TO_FILTER_TYPE[CHIP_ORDER[i]]);
        return;
      }
    }
  }, [filterQuery, filterSlots, clearFilter]);

  const clearSlot = useCallback(
    (slotKey) => clearFilter(SLOT_TO_FILTER_TYPE[slotKey]),
    [clearFilter],
  );

  // ==== DOWNSHIFT ====

  const {
    isOpen, highlightedIndex,
    getInputProps, getMenuProps, getItemProps,
    openMenu,
  } = useCombobox({
    items: flatItems,
    inputValue: filterQuery,
    itemToString: () => '',
    onInputValueChange: ({ inputValue }) => setFilterQuery(inputValue),
    onSelectedItemChange: ({ selectedItem }) => applySelection(selectedItem),
    stateReducer: (state, { type, changes }) => {
      switch (type) {
        case useCombobox.stateChangeTypes.InputKeyDownEnter:
          if (state.highlightedIndex === -1) {
            handleEnterKeyRef.current();
            return { ...changes, isOpen: false, highlightedIndex: -1, selectedItem: null };
          }
          return { ...changes, isOpen: false, highlightedIndex: -1 };
        case useCombobox.stateChangeTypes.InputBlur:
          return { ...changes, selectedItem: null, highlightedIndex: -1 };
        default:
          return changes;
      }
    },
  });

  // ==== RENDER ====

  return (
    <div className={styles.searchContainer}>
      <div className={styles.searchBarRow}>
        <Search size={15} className={styles.searchIcon} />
        <div className={styles.inputWrapper}>
          <FilterChips
            filterSlots={filterSlots}
            onClearSlot={clearSlot}
            onClearAll={clearAllFilters}
          />
          <input
            {...getInputProps({
              className: styles.searchInput,
              placeholder: searchMode === SEARCH_MODES.KEYWORD
                ? 'Search by keyword...'
                : 'Search by meaning...',
              onFocus: () => openMenu(),
              onKeyDown: (e) => {
                if (e.key === 'Backspace' && filterQuery === '') clearLastChip();
              },
            })}
          />
        </div>
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

      <div
        className={styles.searchResultsDropdown}
        style={isOpen ? undefined : { display: 'none' }}
        {...getMenuProps()}
      >
        {isOpen && (
          <SearchResults
            groupedOptions={groupedOptions}
            query={filterQuery}
            highlightedIndex={highlightedIndex}
            getItemProps={getItemProps}
          />
        )}
      </div>

      <SearchResultsMetadata filterSlots={filterSlots} />
    </div>
  );
};

export default Container;
