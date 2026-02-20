import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { Search, Zap, Type, Sparkles } from 'lucide-react';
import styles from './SearchResults.module.scss';
import { useScope } from '@/contexts/ScopeContext';
import { filterConstants, findClustersByQuery } from './utils';
import { useColorMode } from '@/hooks/useColorMode';
import { useClusterColors, resolveClusterColorCSS } from '@/hooks/useClusterColors';
import ClusterIcon from './ClusterIcon';

const CLUSTERS_GROUP = 'Clusters';

// Underline the matching search term in option labels
const underlineText = (text, query) => {
  if (!query) return text;
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts.map((part, index) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <span key={index} className={styles.underline}>{part}</span>
      ) : (
        <span key={index}>{part}</span>
      )
    );
  } catch {
    return text;
  }
};

// ---------------------------------------------------------------------------
// OptionRow — renders a single option in the dropdown
// ---------------------------------------------------------------------------

const OptionRow = ({ option, group, query, onSelect }) => {
  const { isDark: isDarkMode } = useColorMode();
  const { clusterLabels, clusterHierarchy } = useScope();
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);

  const handleClick = () => {
    if (option.isKeywordSearch) {
      onSelect({ type: filterConstants.KEYWORD_SEARCH, value: option.value, label: option.value });
      return;
    }
    if (option.isSemanticSearch) {
      onSelect({ type: filterConstants.SEARCH, value: option.value, label: option.value });
      return;
    }
    if (group === CLUSTERS_GROUP) {
      onSelect({ type: filterConstants.CLUSTER, value: option.value, label: option.label });
    }
  };

  let icon;
  if (option.isKeywordSearch) {
    icon = <Type size={14} className={styles.optionIcon} />;
  } else if (option.isSemanticSearch) {
    icon = <Sparkles size={14} className={styles.optionIconSemantic} />;
  } else if (group === CLUSTERS_GROUP) {
    icon = <ClusterIcon color={resolveClusterColorCSS(colorMap, option.value, isDarkMode)} width={16} height={16} />;
  } else {
    icon = <Search size={14} className={styles.optionIcon} />;
  }

  let labelContent;
  if (option.isKeywordSearch || option.isSemanticSearch) {
    labelContent = <span>Search for &ldquo;{option.value}&rdquo;</span>;
  } else {
    labelContent = <span>{underlineText(option.label, query)}</span>;
  }

  return (
    <div
      className={styles.optionRow}
      onPointerDown={(e) => {
        // Keep input focus until click handler runs; otherwise the menu can close before selection.
        e.preventDefault();
      }}
      onMouseDown={(e) => {
        // Keep input focus until click handler runs; otherwise the menu can close before selection.
        e.preventDefault();
      }}
      onClick={handleClick}
    >
      {icon}
      <div className={styles.optionLabel}>{labelContent}</div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// SearchResults — grouped dropdown list
// ---------------------------------------------------------------------------

export const NUM_SEARCH_RESULTS = 4;

const SearchResults = ({ query, menuIsOpen, onSelect, searchMode }) => {
  const { clusterLabels } = useScope();

  const clusterOptions = useMemo(
    () => findClustersByQuery(clusterLabels, query, NUM_SEARCH_RESULTS),
    [clusterLabels, query]
  );

  // Build grouped options — single search action based on active mode
  const groupedOptions = [];
  if (query.trim() !== '') {
    const searchOpt = searchMode === 'keyword'
      ? { value: query, label: query, isKeywordSearch: true }
      : { value: query, label: query, isSemanticSearch: true };
    groupedOptions.push({ label: 'Search', options: [searchOpt] });
  }
  groupedOptions.push({ label: CLUSTERS_GROUP, options: clusterOptions });

  if (!menuIsOpen) return null;

  return (
    <div className={styles.resultsList}>
      {groupedOptions.map((group) => {
        if (!group.options || group.options.length === 0) return null;
        return (
          <div key={group.label} className={styles.group}>
            <div className={styles.groupHeading}>{group.label}</div>
            <div className={styles.groupOptions}>
              {group.options.map((option, idx) => (
                <OptionRow
                  key={`${group.label}-${option.value}-${idx}`}
                  option={option}
                  group={group.label}
                  query={query}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

SearchResults.propTypes = {
  query: PropTypes.string.isRequired,
  menuIsOpen: PropTypes.bool.isRequired,
  onSelect: PropTypes.func.isRequired,
  searchMode: PropTypes.string,
};

export default SearchResults;
