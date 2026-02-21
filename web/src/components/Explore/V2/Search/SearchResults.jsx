import React from 'react';
import { Search, Type, Sparkles } from 'lucide-react';
import styles from './SearchResults.module.scss';
import { useScope } from '@/contexts/ScopeContext';
import { useColorMode } from '@/hooks/useColorMode';
import { useClusterColors, resolveClusterColorCSS } from '@/hooks/useClusterColors';
import ClusterIcon from './ClusterIcon';

const CLUSTERS_GROUP = 'Clusters';

const underlineText = (text, query) => {
  if (!query) return text;
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase()
        ? <span key={i} className={styles.underline}>{part}</span>
        : <span key={i}>{part}</span>
    );
  } catch {
    return text;
  }
};

// ---------------------------------------------------------------------------
// OptionRow — single dropdown item (pure presentational)
// ---------------------------------------------------------------------------

const OptionRow = ({ option, group, query, isHighlighted, colorMap, isDark, itemProps }) => {
  let icon;
  if (option.isKeywordSearch) {
    icon = <Type size={14} className={styles.optionIcon} />;
  } else if (option.isSemanticSearch) {
    icon = <Sparkles size={14} className={styles.optionIconSemantic} />;
  } else if (group === CLUSTERS_GROUP) {
    icon = <ClusterIcon color={resolveClusterColorCSS(colorMap, option.value, isDark)} width={16} height={16} />;
  } else {
    icon = <Search size={14} className={styles.optionIcon} />;
  }

  const labelContent = (option.isKeywordSearch || option.isSemanticSearch)
    ? <span>Search for &ldquo;{option.value}&rdquo;</span>
    : <span>{underlineText(option.label, query)}</span>;

  return (
    <div
      className={`${styles.optionRow} ${isHighlighted ? styles.highlighted : ''}`}
      {...itemProps}
    >
      {icon}
      <div className={styles.optionLabel}>{labelContent}</div>
      {option.isKeywordSearch && (
        <span className={styles.semanticHint}>⌘ Enter for vibe search</span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// SearchResults — grouped dropdown list (driven by downshift)
// ---------------------------------------------------------------------------

const SearchResults = ({ groupedOptions, query, highlightedIndex, getItemProps }) => {
  const { isDark } = useColorMode();
  const { clusterLabels, clusterHierarchy } = useScope();
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);

  let flatIndex = 0;

  return (
    <div className={styles.resultsList}>
      {groupedOptions.map((group) => {
        if (!group.options || group.options.length === 0) return null;
        return (
          <div key={group.label} className={styles.group}>
            <div className={styles.groupHeading}>{group.label}</div>
            <div className={styles.groupOptions}>
              {group.options.map((option, idx) => {
                const currentIndex = flatIndex++;
                return (
                  <OptionRow
                    key={`${group.label}-${option.value}-${idx}`}
                    option={option}
                    group={group.label}
                    query={query}
                    isHighlighted={highlightedIndex === currentIndex}
                    colorMap={colorMap}
                    isDark={isDark}
                    itemProps={getItemProps({ item: { ...option, group: group.label }, index: currentIndex })}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default SearchResults;
