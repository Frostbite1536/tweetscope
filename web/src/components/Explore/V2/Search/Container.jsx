import React, { useRef, useCallback, useMemo } from 'react';
import { useCombobox } from 'downshift';
import { Search } from 'lucide-react';

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

// Ordered list of filter slots for backspace-to-clear (last active gets removed first)
const CHIP_ORDER = [
  FILTER_SLOT.CLUSTER, FILTER_SLOT.SEARCH, FILTER_SLOT.COLUMN,
  FILTER_SLOT.TIME_RANGE, FILTER_SLOT.ENGAGEMENT,
];

const Container = () => {
  const { clusterLabels } = useScope();
  const {
    filterQuery, setFilterQuery,
    filterSlots, applyCluster, applySearch, applyKeywordSearch,
    applyEngagement, clearFilter, clearAllFilters,
  } = useFilter();

  // Build items for downshift
  const groupedOptions = useMemo(
    () => buildGroupedOptions(filterQuery, clusterLabels),
    [filterQuery, clusterLabels],
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

  // Run search with the given apply function (keyword or semantic)
  const runSearch = useCallback((applyFn) => {
    if (!filterQuery) return;
    const { minFaves, remainingQuery } = parseEngagementOperators(filterQuery);
    if (minFaves) applyEngagement(minFaves);
    if (remainingQuery) {
      applyFn(remainingQuery);
    } else if (minFaves) {
      setFilterQuery('');
    }
  }, [filterQuery, applyEngagement, setFilterQuery]);

  // Enter with no highlighted item → keyword search
  const handleEnterKeyRef = useRef(null);
  handleEnterKeyRef.current = () => runSearch(applyKeywordSearch);

  // ⌘+Enter → semantic search
  const handleMetaEnter = useCallback(() => runSearch(applySearch), [runSearch, applySearch]);

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
          <textarea
            rows={1}
            {...getInputProps({
              className: styles.searchInput,
              placeholder: 'Search by keyword...',
              onFocus: () => openMenu(),
              onKeyDown: (e) => {
                // Submit on bare Enter (suppress newline); allow shift+Enter for newlines
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                }
                if (e.key === 'Backspace' && filterQuery === '') clearLastChip();
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleMetaEnter();
                }
              },
              onChange: (e) => {
                // Auto-resize textarea
                e.target.style.height = 'auto';
                e.target.style.height = e.target.scrollHeight + 'px';
              },
            })}
          />
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
