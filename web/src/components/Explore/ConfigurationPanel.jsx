import { Button } from 'react-element-forge';
import { Sun, Moon, Monitor, Minus, Plus } from 'lucide-react';
import { useColorMode } from '../../hooks/useColorMode';
import styles from './ConfigurationPanel.module.scss';

const THEME_CYCLE = ['auto', 'light', 'dark'];
const THEME_META = {
  auto: { Icon: Monitor, label: 'System Theme' },
  light: { Icon: Sun, label: 'Light Theme' },
  dark: { Icon: Moon, label: 'Dark Theme' },
};

const ConfigurationPanel = ({
  isOpen,
  onClose,
  title = 'Configuration',
  vizConfig,
  toggleShowClusterOutlines,
  updatePointSize,
  updatePointOpacity,
  linksAvailable = false,
  linksMeta = null,
  linksLoading = false,
  toggleShowReplyEdges = () => {},
  toggleShowQuoteEdges = () => {},
  updateEdgeWidthScale = () => {},
  timelineHasDates = false,
  toggleShowTimeline = () => {},
  threadsOnlyActive = false,
  threadsOnlyAvailable = false,
  onToggleThreadsOnly = () => {},
}) => {
  const { themePreference, setThemePreference } = useColorMode();

  const {
    showClusterOutlines,
    pointSize,
    pointOpacity,
    showReplyEdges = true,
    showQuoteEdges = true,
    edgeWidthScale = 1,
    showTimeline = false,
  } = vizConfig;

  const internalReplyEdges = linksMeta?.internal_edge_kind_counts?.reply;
  const internalQuoteEdges = linksMeta?.internal_edge_kind_counts?.quote;
  const internalEdges = linksMeta?.internal_edges ?? linksMeta?.internal_internal_edges;
  const hasInternalBreakdown =
    Number.isFinite(internalEdges) &&
    Number.isFinite(internalReplyEdges) &&
    Number.isFinite(internalQuoteEdges);

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(themePreference);
    setThemePreference(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  };

  const { Icon: ThemeIcon, label: themeLabel } = THEME_META[themePreference] || THEME_META.auto;

  return (
    <div className={`${styles.panel} ${isOpen ? styles.open : ''}`}>
      <div className={styles.header}>
        <h3>{title}</h3>
        <Button
          className={styles.closeButton}
          variant="outline"
          onClick={onClose}
          aria-label="Minimize configuration panel"
          icon="minus"
        />
      </div>

      <div className={styles.content}>
        {/* ── Show / Hide ── */}
        <div className={styles.section}>
          <span className={styles.sectionLabel}>Show</span>
          {threadsOnlyAvailable && (
            <label className={styles.inlineToggle}>
              <input
                type="checkbox"
                checked={threadsOnlyActive}
                onChange={onToggleThreadsOnly}
              />
              <span>Show Threads Only</span>
            </label>
          )}
          {linksAvailable && (
            <>
              <label className={styles.inlineToggle}>
                <input
                  type="checkbox"
                  checked={showReplyEdges}
                  onChange={(e) => toggleShowReplyEdges(e.target.checked)}
                />
                <span>Reply Connections</span>
              </label>
              <label className={styles.inlineToggle}>
                <input
                  type="checkbox"
                  checked={showQuoteEdges}
                  onChange={(e) => toggleShowQuoteEdges(e.target.checked)}
                />
                <span>Quote Connections</span>
              </label>
            </>
          )}
          <label className={styles.inlineToggle}>
            <input
              type="checkbox"
              checked={showClusterOutlines}
              onChange={toggleShowClusterOutlines}
            />
            <span>Topic Borders</span>
          </label>
          {timelineHasDates && (
            <label className={styles.inlineToggle}>
              <input
                type="checkbox"
                checked={showTimeline}
                onChange={toggleShowTimeline}
              />
              <span>Timeline <span className={styles.betaBadge}>beta</span></span>
            </label>
          )}
        </div>

        {/* ── Adjust ── */}
        <div className={styles.section}>
          <span className={styles.sectionLabel}>Adjust</span>
          <div className={styles.stepper}>
            <span className={styles.stepperLabel}>Dot Size</span>
            <div className={styles.stepperControls}>
              <button
                onClick={() => updatePointSize(Math.max(0.1, +(pointSize - 0.5).toFixed(1)))}
                disabled={pointSize <= 0.1}
                aria-label="Decrease dot size"
              >
                <Minus size={12} />
              </button>
              <span className={styles.stepperValue}>{pointSize}x</span>
              <button
                onClick={() => updatePointSize(Math.min(10, +(pointSize + 0.5).toFixed(1)))}
                disabled={pointSize >= 10}
                aria-label="Increase dot size"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
          <div className={styles.stepper}>
            <span className={styles.stepperLabel}>Dot Opacity</span>
            <div className={styles.stepperControls}>
              <button
                onClick={() => updatePointOpacity(Math.max(0.1, +(pointOpacity - 0.1).toFixed(1)))}
                disabled={pointOpacity <= 0.1}
                aria-label="Decrease dot opacity"
              >
                <Minus size={12} />
              </button>
              <span className={styles.stepperValue}>{pointOpacity}x</span>
              <button
                onClick={() => updatePointOpacity(Math.min(1.5, +(pointOpacity + 0.1).toFixed(1)))}
                disabled={pointOpacity >= 1.5}
                aria-label="Increase dot opacity"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
          {linksAvailable && (
            <div className={styles.stepper}>
              <span className={styles.stepperLabel}>Line Thickness</span>
              <div className={styles.stepperControls}>
                <button
                  onClick={() => updateEdgeWidthScale(Math.max(0.2, +(edgeWidthScale - 0.2).toFixed(1)))}
                  disabled={edgeWidthScale <= 0.2}
                  aria-label="Decrease line thickness"
                >
                  <Minus size={12} />
                </button>
                <span className={styles.stepperValue}>{edgeWidthScale.toFixed(1)}x</span>
                <button
                  onClick={() => updateEdgeWidthScale(Math.min(2.2, +(edgeWidthScale + 0.2).toFixed(1)))}
                  disabled={edgeWidthScale >= 2.2}
                  aria-label="Increase line thickness"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
          )}
        </div>

        {linksAvailable && (
          <div className={styles.linksMeta}>
            {linksLoading ? (
              <span>Loading...</span>
            ) : (
              <span>
                {hasInternalBreakdown
                  ? `${internalEdges} connections (${internalReplyEdges} replies, ${internalQuoteEdges} quotes)`
                  : `${linksMeta?.edges ?? 0} connections (${linksMeta?.edge_kind_counts?.reply ?? 0} replies, ${linksMeta?.edge_kind_counts?.quote ?? 0} quotes)`}
              </span>
            )}
          </div>
        )}

        <button className={styles.themeCycler} onClick={cycleTheme} title={`Theme: ${themeLabel}`}>
          <ThemeIcon size={14} />
          <span>{themeLabel}</span>
        </button>
      </div>
    </div>
  );
};

export default ConfigurationPanel;
