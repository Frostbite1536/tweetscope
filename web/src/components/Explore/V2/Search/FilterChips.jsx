import React from 'react';
import { X } from 'lucide-react';
import styles from './Container.module.scss';
import { useScope } from '@/contexts/ScopeContext';
import { FILTER_SLOT } from '@/contexts/FilterContext';
import { useColorMode } from '@/hooks/useColorMode';
import { useClusterColors, resolveClusterColorCSS } from '@/hooks/useClusterColors';

const colorMix = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

const chipStyle = (color) => ({
  '--chip-bg': colorMix(color, 14),
  '--chip-border': colorMix(color, 28),
  '--chip-color': color,
  '--chip-clear-bg': colorMix(color, 22),
  '--chip-clear-hover-bg': colorMix(color, 38),
});

const SEMANTIC_COLOR = 'var(--semantic-color-semantic-info)';
const ENGAGEMENT_COLOR = 'var(--semantic-color-semantic-critical)';

const CHIP_DEFS = [
  {
    slot: FILTER_SLOT.CLUSTER,
    icon: '●',
    prefix: '',
    getLabel: (s) => s.label,
    getStyle: (s, colorMap, isDark) => {
      const color = resolveClusterColorCSS(colorMap, s.value, isDark);
      return chipStyle(color);
    },
  },
  {
    slot: FILTER_SLOT.SEARCH,
    getIcon: (s) => (s.mode === 'semantic' ? '⚡' : '⌕'),
    getPrefix: (s) => (s.mode === 'semantic' ? 'AI: ' : 'KW: '),
    getLabel: (s) => s.label,
    getStyle: (s) => (s.mode === 'semantic' ? chipStyle(SEMANTIC_COLOR) : {}),
  },
  {
    slot: FILTER_SLOT.COLUMN,
    icon: '▦',
    prefix: '',
    getLabel: (s) => s.label,
    getStyle: () => ({}),
  },
  {
    slot: FILTER_SLOT.TIME_RANGE,
    icon: '◷',
    prefix: '',
    getLabel: (s) => s.label || 'Time range',
    getStyle: () => ({}),
  },
  {
    slot: FILTER_SLOT.ENGAGEMENT,
    icon: '♥',
    prefix: '',
    getLabel: (s) => s.label,
    getStyle: () => chipStyle(ENGAGEMENT_COLOR),
  },
];

const FilterChips = ({ filterSlots, onClearSlot, onClearAll }) => {
  const { isDark } = useColorMode();
  const { clusterLabels, clusterHierarchy } = useScope();
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);

  const chips = [];
  for (const def of CHIP_DEFS) {
    const slotData = filterSlots[def.slot];
    if (!slotData) continue;
    chips.push({
      key: def.slot,
      icon: def.getIcon ? def.getIcon(slotData) : def.icon,
      prefix: def.getPrefix ? def.getPrefix(slotData) : def.prefix,
      label: def.getLabel(slotData),
      style: def.getStyle(slotData, colorMap, isDark),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className={styles.chipRow}>
      {chips.map((chip) => (
        <span key={chip.key} className={styles.chip} style={chip.style}>
          <span className={styles.chipIcon}>{chip.icon}</span>
          <span className={styles.chipLabel} title={chip.label}>
            {chip.prefix}{chip.label}
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

export default FilterChips;
