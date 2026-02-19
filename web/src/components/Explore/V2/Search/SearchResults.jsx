import React, { useMemo } from 'react';

import PropTypes from 'prop-types';
import Select, { components } from 'react-select';
import styles from './SearchResults.module.scss';
import { Button } from 'react-element-forge';
import { useScope } from '@/contexts/ScopeContext';
import { filterConstants, findClustersByQuery } from './utils';
import useColumnFilter from '@/hooks/useColumnFilter';
import { useColorMode } from '@/hooks/useColorMode';
import { getClusterColorCSS } from '../DeckGLScatter';
import ClusterIcon from './ClusterIcon';

const COLUMNS = 'Columns';
const CLUSTERS = 'Clusters';

// Function to underline the search term
const underlineText = (text, query) => {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query})`, 'gi'));
  return parts.map((part, index) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <span key={index} className={styles.underline}>
        {part}
      </span>
    ) : (
      <span key={index}>{part}</span>
    )
  );
};

// Custom Option component that includes an icon. Note the added branch for NN options.
const Option = (props) => {
  const { data, selectProps } = props;
  const { onSelect, inputValue } = selectProps;
  const { isDark: isDarkMode } = useColorMode();

  const handleClick = (e) => {
    e.preventDefault();
    if (data.isKeywordSearch) {
      onSelect({ type: filterConstants.KEYWORD_SEARCH, value: data.value, label: data.value });
      return;
    }
    if (data.isSemanticSearch) {
      onSelect({ type: filterConstants.SEARCH, value: data.value, label: data.value });
      return;
    }
    // Determine which group this option belongs to
    const groupType = props.options.find((group) =>
      group.options?.some((opt) => opt.value === data.value && opt.label === data.label)
    )?.label;

    if (groupType === COLUMNS) {
      const label = `${data.column}: ${data.value}`;
      onSelect({
        type: filterConstants.COLUMN,
        value: data.value,
        column: data.column,
        label,
      });
    } else if (groupType === CLUSTERS) {
      onSelect({ type: filterConstants.CLUSTER, value: data.value, label: data.label });
      // applyCluster sets filterQuery to the real cluster label via the reducer;
      // do NOT override it here with a generic "Cluster N" string.
    }
  };

  // Keyword search option
  if (data.isKeywordSearch) {
    return (
      <div onClick={handleClick}>
        <components.Option {...props}>
          <div className={styles.resultContent}>
            <Button
              onClick={handleClick}
              icon="search"
              color="primary"
              variant="clear"
              size="small"
              className={styles.resultButton}
            />
            <span>Keyword search: &ldquo;{data.value}&rdquo;</span>
          </div>
        </components.Option>
      </div>
    );
  }

  // Semantic search option
  if (data.isSemanticSearch) {
    return (
      <div onClick={handleClick}>
        <components.Option {...props}>
          <div className={styles.resultContent}>
            <Button
              onClick={handleClick}
              icon="zap"
              color="primary"
              variant="clear"
              size="small"
              className={styles.resultButton}
            />
            <span>Semantic search: &ldquo;{data.value}&rdquo;</span>
          </div>
        </components.Option>
      </div>
    );
  }

  // Get the group type to determine which icon to show
  const groupType = props.options.find((group) =>
    group.options?.some((opt) => opt.value === data.value && opt.label === data.label)
  )?.label;

  const getIcon = (type) => {
    switch (type) {
      case 'Clusters':
        return 'cloud';
      case 'Columns':
        return 'columns';
      default:
        return 'search';
    }
  };

  if (groupType === COLUMNS) {
    return (
      <div onClick={handleClick}>
        <components.Option {...props}>
          <div className={styles.columnResultContent}>
            <Button
              onClick={handleClick}
              icon={getIcon(groupType)}
              color="primary"
              variant="clear"
              size="small"
              className={styles.resultButton}
            />
            <span>{underlineText(data.label, inputValue)}</span>
            <span className={styles.columnLabel}>{data.column}</span>
          </div>
        </components.Option>
      </div>
    );
  }

  return (
    <div onClick={handleClick}>
      <components.Option {...props}>
        <div className={styles.resultContent}>
          {groupType === 'Clusters' ? (
            <ClusterIcon color={getClusterColorCSS(data.value, isDarkMode)} />
          ) : (
            <Button
              onClick={handleClick}
              icon={getIcon(groupType)}
              color="primary"
              variant="clear"
              size="small"
              className={styles.resultButton}
            />
          )}
          <div>{underlineText(data.label, inputValue)}</div>
        </div>
      </components.Option>
    </div>
  );
};

// Custom Group component
const Group = ({ children, ...props }) => {
  return <components.Group {...props}>{children}</components.Group>;
};

// A simplified custom Menu component (only for styling)
const CustomMenu = ({ children, ...props }) => {
  return (
    <components.Menu {...props}>
      <div className={styles.resultsList}>{children}</div>
    </components.Menu>
  );
};

export const NUM_SEARCH_RESULTS = 4;

const SearchResults = ({ query, menuIsOpen, onSelect, searchMode }) => {
  const { userId, datasetId, scope, clusterLabels } = useScope();
  const columnFilter = useColumnFilter(userId, datasetId, scope);
  const { columnFilters } = columnFilter;

  const clusterOptions = useMemo(
    () => findClustersByQuery(clusterLabels, query, NUM_SEARCH_RESULTS),
    [clusterLabels, query]
  );

  // Transform column values into options
  const columnOptions = useMemo(() => {
    if (!columnFilters) {
      return [];
    }

    // Flatten all column values into searchable options
    const options = columnFilters.flatMap((column) =>
      column.categories.map((category) => ({
        value: category,
        label: category, // Just the value
        column: column.column, // Store column name for display
      }))
    );

    // Filter based on query
    if (!query) return options.slice(0, NUM_SEARCH_RESULTS);
    const searchTerm = query.toLowerCase();
    return options
      .filter((option) => option.value.toString().toLowerCase().includes(searchTerm))
      .slice(0, NUM_SEARCH_RESULTS);
  }, [columnFilters, query]);

  // Build grouped options.
  // When user has typed something, show both keyword and semantic search options.
  // The active search mode's option comes first.
  const groupedOptions = [];
  if (query.trim() !== '') {
    const keywordOpt = { value: query, label: query, isKeywordSearch: true };
    const semanticOpt = { value: query, label: query, isSemanticSearch: true };
    const searchOptions = searchMode === 'keyword'
      ? [keywordOpt, semanticOpt]
      : [semanticOpt, keywordOpt];
    groupedOptions.push({
      label: 'Search',
      options: searchOptions,
    });
  }

  // Then add the other group(s).
  groupedOptions.push({
    label: CLUSTERS,
    options: clusterOptions,
  });

  if (columnOptions.length > 0) {
    groupedOptions.push({
      label: COLUMNS,
      options: columnOptions,
    });
  }

  const filterOption = (option, inputValue) => {
    if (!inputValue) return true;
    // Always show search action options
    if (option.data?.isKeywordSearch || option.data?.isSemanticSearch) return true;
    // For individual options
    return option.label.toLowerCase().includes(inputValue.toLowerCase());
  };

  return (
    <Select
      options={groupedOptions}
      components={{
        Option,
        Group,
        Menu: CustomMenu, // using our simplified custom Menu just to wrap the children
      }}
      styles={{
        control: () => ({
          display: 'none',
        }),
        menu: (base) => ({
          ...base,
          border: 'none',
          boxShadow: 'none',
          backgroundColor: 'transparent',
          position: 'static',
        }),
        group: (base) => ({
          ...base,
          padding: '8px 0',
        }),
        groupHeading: (base) => ({
          ...base,
          color: 'var(--text-color-text-subtle)',
          fontSize: '0.9em',
          fontWeight: 600,
          textTransform: 'uppercase',
          padding: '0 10px',
          marginBottom: '8px',
        }),
        option: (base, state) => ({
          ...base,
          padding: '8px 16px',
          backgroundColor: state.isFocused ? 'var(--neutrals-color-neutral-1)' : 'transparent',
          cursor: 'pointer',
          '&:hover': {
            backgroundColor: 'var(--neutrals-color-neutral-1)',
          },
        }),
        menuList: (base) => ({
          ...base,
          padding: 0,
          overflowY: 'visible',
          maxHeight: 'none',
        }),
      }}
      query={query}
      onMenuOpen={() => true}
      onMenuClose={() => false}
      onChange={() => false}
      onSelect={onSelect}
      controlShouldRenderValue={false}
      filterOption={filterOption}
      inputValue={query}
      isSearchable={true}
      hideSelectedOptions={false}
      closeMenuOnSelect={false}
      menuIsOpen={menuIsOpen}
    />
  );
};

SearchResults.propTypes = {
  query: PropTypes.string.isRequired,
  menuIsOpen: PropTypes.bool.isRequired,
  onSelect: PropTypes.func.isRequired,
  searchMode: PropTypes.string,
};

export default SearchResults;
