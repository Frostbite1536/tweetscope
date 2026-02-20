import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import Scatter from './DeckGLScatter';
import { useClusterColors, resolveClusterColorCSS } from '@/hooks/useClusterColors';

import { useColorMode } from '../../../hooks/useColorMode';
import ConnectionBadges from './ConnectionBadges';

import { useScope } from '../../../contexts/ScopeContext';
import { useFilter } from '../../../contexts/FilterContext';

import { Heart, Repeat2 } from 'lucide-react';
import { mapSelectionKey } from '../../../lib/colors';
import {
  getLikesRawValue,
  getRetweetsRawValue,
  toMetricNumber,
} from '../../../lib/engagement.js';
import { urlResolver } from '../../../lib/urlResolver';
import styles from './VisualizationPane.module.scss';
import hoverStyles from './HoverCard.module.scss';
import ConfigurationPanel from '../ConfigurationPanel';
import TimelineControls from './TimelineControls';
import TwitterEmbed from './TweetFeed/TwitterEmbed';
import { Button } from 'react-element-forge';
import useHoverCardPlacement from './useHoverCardPlacement';

const DATE_COLUMN_NAMES = ['created_at', 'date', 'timestamp', 'time', 'posted_at', 'published_at'];
const TIMELINE_EXCLUSION_HEIGHT = 110;

function getFirstValue(obj, keys) {
  if (!obj) return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

function formatDate(dateValue) {
  if (!dateValue) return null;
  try {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_error) {
    return null;
  }
}

function formatCount(value) {
  const num = toMetricNumber(value);
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num);
}

const TCO_RE = /https?:\/\/t\.co\/[a-zA-Z0-9]+/g;
const STATUS_URL_RE = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]+)\/status\/(\d+)/i;

function stripTcoUrls(text) {
  return text.replace(TCO_RE, '').replace(/\s{2,}/g, ' ').trim();
}

function parseJsonArray(str) {
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function classifyUrls(urlsJson) {
  const urls = parseJsonArray(urlsJson);
  const quotedTweets = [];
  const externalUrls = [];
  for (const href of urls) {
    if (typeof href !== 'string') continue;
    const statusMatch = href.match(STATUS_URL_RE);
    if (statusMatch) {
      quotedTweets.push({ tweetId: statusMatch[1], tweetUrl: href });
    } else {
      try {
        const u = new URL(href);
        const path = u.pathname + u.search;
        const display = u.hostname + (path.length > 1 ? path : '');
        externalUrls.push({ href, display: display.length > 45 ? display.slice(0, 42) + '...' : display });
      } catch {
        externalUrls.push({ href, display: href.slice(0, 45) });
      }
    }
  }
  return { quotedTweets, externalUrls };
}

const VisualizationPane = forwardRef(function VisualizationPane({
  width,
  height,
  contentPaddingRight = 0,
  hovered,
  hoveredIndex,
  hoverAnchor,
  hoverPinned = false,
  onHover,
  onSelect,
  onLabelClick,
  onUnpinHover,
  onFilterToCluster,
  hoverAnnotations,
  hoveredCluster,
  textColumn,
  linksEdges = [],
  linksAvailable = false,
  linksMeta = null,
  linksLoading = false,
  onHoverCardMouseEnter,
  onHoverCardMouseLeave,
  // Timeline props
  timeRange = null,
  timestamps = null,
  timelineDomain = null,
  timelineHasDates = false,
  timelineDatedCount = 0,
  timelineTotalCount = 0,
  isPlaying = false,
  onPlayToggle,
  playbackSpeed = 1,
  onSpeedChange,
  onTimeRangeChange,
  nodeStats = null,
  onViewThread,
  onViewQuotes,
  highlightIndices = null,
}, ref) {
  const { scopeRows, scope, clusterLabels, clusterHierarchy } = useScope();
  const { isDark: isDarkMode } = useColorMode();
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);

  const { clusterFilter, filterActive, visibleIndexSet } = useFilter();

  const maxZoom = 40;

  // Ref for scatter component to enable programmatic zoom
  const scatterRef = useRef(null);

  // Expose zoomToBounds and getViewState methods to parent
  useImperativeHandle(ref, () => ({
    zoomToBounds: (bounds, duration) => {
      scatterRef.current?.zoomToBounds(bounds, duration);
    },
    getViewState: () => scatterRef.current?.getViewState?.(),
    setViewState: (viewState, duration) => {
      scatterRef.current?.setViewState?.(viewState, duration);
    },
  }), []);

  const handleView = useCallback(() => {}, []);

  const umapRef = useRef(null);

  const isFilterActive = filterActive;

  // Points format: [x, y, selectionKey, activation, cluster]
  const drawingPoints = useMemo(() => {
    return scopeRows.map((p, i) => {
      const cluster = p.cluster ?? 0;
      const lsIndex = p.ls_index ?? i;
      const isFilterMatch = isFilterActive ? visibleIndexSet.has(lsIndex) : true;

      // Time range check (applied locally so playback updates are reflected immediately)
      let isTimeMatch = true;
      if (timeRange && timestamps) {
        const ts = timestamps[i];
        if (!Number.isNaN(ts)) {
          isTimeMatch = ts >= timeRange[0] && ts <= timeRange[1];
        }
        // NaN (dateless rows) pass through — stay visible
      }

      const isMatch = isFilterMatch && isTimeMatch;

      if (p.deleted) {
        return [-10, -10, mapSelectionKey.hidden, 0.0, cluster];
      }

      if (isFilterActive || timeRange) {
        return [
          p.x,
          p.y,
          isMatch ? mapSelectionKey.selected : mapSelectionKey.notSelected,
          0.0,
          cluster,
        ];
      }

      return [p.x, p.y, mapSelectionKey.normal, 0.0, cluster];
    });
  }, [scopeRows, isFilterActive, visibleIndexSet, timeRange, timestamps]);



  // ====================================================================================================
  // Configuration Panel
  // ====================================================================================================
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [vizConfig, setVizConfig] = useState({
    showClusterOutlines: true,
    pointSize: 1,
    pointOpacity: 1,
    showReplyEdges: true,
    showQuoteEdges: true,
    edgeWidthScale: 0.7,
    showTimeline: false,
  });


  const toggleShowClusterOutlines = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showClusterOutlines: !prev.showClusterOutlines }));
  }, []);

  const updatePointSize = useCallback((value) => {
    setVizConfig((prev) => ({ ...prev, pointSize: value }));
  }, []);

  const updatePointOpacity = useCallback((value) => {
    setVizConfig((prev) => ({ ...prev, pointOpacity: value }));
  }, []);

  const toggleShowReplyEdges = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showReplyEdges: !prev.showReplyEdges }));
  }, []);

  const toggleShowQuoteEdges = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showQuoteEdges: !prev.showQuoteEdges }));
  }, []);

  const updateEdgeWidthScale = useCallback((value) => {
    setVizConfig((prev) => ({ ...prev, edgeWidthScale: value }));
  }, []);

  const toggleShowTimeline = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showTimeline: !prev.showTimeline }));
  }, []);

  // Async URL resolution fallback state
  const [asyncMedia, setAsyncMedia] = useState([]);
  const [asyncQuotes, setAsyncQuotes] = useState([]);
  const asyncResolvedIdRef = useRef(null);

  const hoverCardData = useMemo(() => {
    if (!hovered) return null;
    const record = hovered || {};
    const dateValue = getFirstValue(record, DATE_COLUMN_NAMES);
    const likesValue = getLikesRawValue(record);
    const retweetValue = getRetweetsRawValue(record);

    const username = record.username || null;
    const tweetId = record.id ? String(record.id) : null;
    const tweetUrl = username && tweetId ? `https://x.com/${username}/status/${tweetId}` : null;
    const typeRaw = String(record.tweet_type || '').trim().toLowerCase();
    const isLike = record.is_like === true || typeRaw === 'like';

    const rawText = String(
      record.text ||
      (textColumn ? record[textColumn] : '') ||
      ''
    ).trim();
    const displayText = stripTcoUrls(rawText);
    const tcoLinks = rawText.match(TCO_RE) || [];

    // Parse URL columns from parquet
    const { quotedTweets, externalUrls } = classifyUrls(record.urls_json);
    const mediaUrls = parseJsonArray(record.media_urls_json);
    const hasParquetUrls = quotedTweets.length > 0 || externalUrls.length > 0 || mediaUrls.length > 0;

    // Show type label only for non-default types
    let typeLabel = null;
    if (isLike) typeLabel = 'Like';
    else if (typeRaw === 'retweet' || typeRaw === 'is_retweet') typeLabel = 'Retweet';

    return {
      rawText,
      displayText,
      tcoLinks,
      username,
      displayName: record.display_name || null,
      dateLabel: formatDate(dateValue),
      typeLabel,
      likes: likesValue === null ? null : toMetricNumber(likesValue),
      retweets: retweetValue === null ? null : toMetricNumber(retweetValue),
      tweetUrl,
      quotedTweets,
      mediaUrls,
      externalUrls,
      hasParquetUrls,
      index: hovered.index,
    };
  }, [hovered, textColumn]);

  // Async fallback: resolve t.co links when parquet has no URL data
  useEffect(() => {
    if (!hoverCardData || hoverCardData.hasParquetUrls || hoverCardData.tcoLinks.length === 0) {
      if (asyncResolvedIdRef.current !== null) {
        setAsyncMedia([]);
        setAsyncQuotes([]);
        asyncResolvedIdRef.current = null;
      }
      return;
    }
    const resolveId = hoverCardData.index;
    if (asyncResolvedIdRef.current === resolveId) return;
    asyncResolvedIdRef.current = resolveId;

    urlResolver.resolve(hoverCardData.tcoLinks).then((results) => {
      if (asyncResolvedIdRef.current !== resolveId) return;
      setAsyncMedia(results.filter((r) => r.type === 'image' && r.media_url && !r.error));
      setAsyncQuotes(results.filter((r) => r.type === 'quote' && r.media_url && !r.error).map((r) => ({
        tweetId: String(r.media_url),
        tweetUrl: r.final,
      })));
    }).catch(() => {
      if (asyncResolvedIdRef.current === resolveId) {
        setAsyncMedia([]);
        setAsyncQuotes([]);
      }
    });
  }, [hoverCardData]);

  const hoverCardExclusionZones = useMemo(() => {
    const zones = [];

    if (vizConfig.showTimeline && timelineHasDates) {
      const timelineLeft = 56;
      const timelineRight = Math.max(timelineLeft + 60, width - contentPaddingRight - 16);
      zones.push({
        left: timelineLeft,
        top: Math.max(0, height - TIMELINE_EXCLUSION_HEIGHT),
        right: timelineRight,
        bottom: Math.max(1, height - 8),
      });
    }

    // Desktop-only app: keep the bottom-left config button area clear.
    zones.push({
      left: 6,
      top: Math.max(0, height - 64),
      right: 64,
      bottom: Math.max(1, height - 4),
    });

    return zones;
  }, [vizConfig.showTimeline, timelineHasDates, width, height, contentPaddingRight]);

  const { cardRef: hoverCardRef, position: hoverCardPosition } = useHoverCardPlacement({
    enabled: Boolean(hovered),
    anchor: hoverAnchor,
    viewportWidth: width,
    viewportHeight: height,
    contentPaddingRight,
    exclusionZones: hoverCardExclusionZones,
    preferredWidth: 360,
    minWidth: 200,
    fallbackHeight: hoverPinned ? 320 : 260,
  });

  const handleCopyText = useCallback(() => {
    if (!hoverCardData?.rawText || !navigator?.clipboard?.writeText) return;
    navigator.clipboard.writeText(hoverCardData.rawText).catch(() => {});
  }, [hoverCardData?.rawText]);


  const hoverConnectionStats = useMemo(() => {
    if (hoveredIndex === null || hoveredIndex === undefined) return null;
    const directStats = nodeStats?.get(hoveredIndex);
    if (directStats) return directStats;

    if (!Array.isArray(linksEdges) || linksEdges.length === 0) return null;
    const target = Number(hoveredIndex);
    if (!Number.isInteger(target)) return null;

    let replyOutCount = 0;
    let replyInCount = 0;
    let replyChildCount = 0;
    let quoteOutCount = 0;
    let quoteInCount = 0;
    let hasAny = false;

    for (const edge of linksEdges) {
      const src = Number(edge?.src_ls_index);
      const dst = Number(edge?.dst_ls_index);
      if (!Number.isInteger(src) || !Number.isInteger(dst)) continue;
      const type = String(edge?.edge_kind || '').toLowerCase();

      if (type === 'reply') {
        if (src === target) {
          replyOutCount += 1;
          hasAny = true;
        }
        if (dst === target) {
          replyInCount += 1;
          replyChildCount += 1;
          hasAny = true;
        }
      } else if (type === 'quote') {
        if (src === target) {
          quoteOutCount += 1;
          hasAny = true;
        }
        if (dst === target) {
          quoteInCount += 1;
          hasAny = true;
        }
      }
    }

    if (!hasAny) return null;
    return {
      threadDepth: replyOutCount > 0 ? 1 : 0,
      threadSize: 1 + replyChildCount,
      replyChildCount,
      replyInCount,
      replyOutCount,
      quoteInCount,
      quoteOutCount,
      threadRootId: null,
      tweetId: null,
    };
  }, [hoveredIndex, nodeStats, linksEdges]);

  return (
    // <div style={{ width, height }} ref={umapRef}>
    <div ref={umapRef} style={{ width: '100%', height: '100%' }}>
      <div className={styles.configToggleContainer}>
        <Button
          className={styles['configToggle']}
          onClick={() => setIsPanelOpen(!isPanelOpen)}
          aria-label="Toggle configuration panel"
          icon={'settings'}
          size="small"
          // color="#333"
        />

        <ConfigurationPanel
          isOpen={isPanelOpen}
          onClose={() => setIsPanelOpen(false)}
          title="View Settings"
          vizConfig={vizConfig}
          toggleShowClusterOutlines={toggleShowClusterOutlines}
          updatePointSize={updatePointSize}
          updatePointOpacity={updatePointOpacity}
          linksAvailable={linksAvailable}
          linksMeta={linksMeta}
          linksLoading={linksLoading}
          toggleShowReplyEdges={toggleShowReplyEdges}
          toggleShowQuoteEdges={toggleShowQuoteEdges}
          updateEdgeWidthScale={updateEdgeWidthScale}
          timelineHasDates={timelineHasDates}
          toggleShowTimeline={toggleShowTimeline}
        />
      </div>

      <div className={`${styles.scatters} ${styles.fullScreen}`}>
        {scope && (
          <Scatter
            ref={scatterRef}
            points={drawingPoints}
            width={width}
            height={height}
            contentPaddingRight={contentPaddingRight}
            pointScale={vizConfig.pointSize}
            pointOpacity={vizConfig.pointOpacity}
            onView={handleView}
            onSelect={onSelect}
            onHover={onHover}
            onLabelClick={onLabelClick}
            showClusterOutlines={vizConfig.showClusterOutlines}
            activeClusterId={clusterFilter.cluster?.cluster ?? null}
            linkEdges={linksEdges}
            showReplyEdges={linksAvailable && vizConfig.showReplyEdges}
            showQuoteEdges={linksAvailable && vizConfig.showQuoteEdges}
            edgeWidthScale={vizConfig.edgeWidthScale}
            highlightIndices={highlightIndices}
            maxZoom={maxZoom}
          />
        )}

        {vizConfig.showTimeline && timelineHasDates && (
          <TimelineControls
            domain={timelineDomain}
            range={timeRange}
            onRangeChange={onTimeRangeChange}
            isPlaying={isPlaying}
            onPlayToggle={onPlayToggle}
            playbackSpeed={playbackSpeed}
            onSpeedChange={onSpeedChange}
            hasDates={timelineHasDates}
            timestamps={timestamps}
            datedCount={timelineDatedCount}
            totalCount={timelineTotalCount}
            paddingRight={contentPaddingRight}
          />
        )}
      </div>

      {/* Hover information display */}
      {hovered && hoverCardData && hoverCardPosition && (() => {
        const allQuotes = hoverCardData.quotedTweets.length > 0 ? hoverCardData.quotedTweets : asyncQuotes;
        const allMedia = hoverCardData.mediaUrls.length > 0 ? hoverCardData.mediaUrls : asyncMedia.map((m) => m.media_url);
        return (
          <div
            ref={hoverCardRef}
            className={`${hoverStyles.hoverCard} ${hoverPinned ? hoverStyles.pinned : ''}`}
            style={{
              position: 'absolute',
              left: hoverCardPosition.left,
              top: hoverCardPosition.top,
              width: hoverCardPosition.width,
              transformOrigin: hoverCardPosition.transformOrigin,
              zIndex: 350,
            }}
            onMouseEnter={onHoverCardMouseEnter}
            onMouseLeave={onHoverCardMouseLeave}
          >
            {hoverPinned && <span className={hoverStyles.pinnedTag}>Pinned</span>}

            {/* 1. Text — first and largest */}
            <p className={`${hoverStyles.textPreview} ${hoverPinned ? hoverStyles.expanded : ''}`}>
              {hoverCardData.typeLabel && (
                <span className={hoverStyles.typeTag}>{hoverCardData.typeLabel}</span>
              )}
              {hoverCardData.displayText || 'No text preview'}
            </p>

            {/* 2. Attribution line */}
            <div className={hoverStyles.attributionLine}>
              {hoverCardData.username && <span>@{hoverCardData.username}</span>}
              {hoverCardData.dateLabel && <><span className={hoverStyles.dot}>·</span><span>{hoverCardData.dateLabel}</span></>}
              {hoverCardData.likes !== null && (
                <><span className={hoverStyles.dot}>·</span><Heart size={12} className={hoverStyles.metricIcon} /><span>{formatCount(hoverCardData.likes)}</span></>
              )}
              {hoverCardData.retweets !== null && (
                <><span className={hoverStyles.dot}>·</span><Repeat2 size={12} className={hoverStyles.metricIcon} /><span>{formatCount(hoverCardData.retweets)}</span></>
              )}
            </div>

            {/* 3. Cluster hint */}
            {hoveredCluster && (
              <div className={hoverStyles.clusterHint}>
                <span
                  className={hoverStyles.clusterDotSmall}
                  style={{ backgroundColor: resolveClusterColorCSS(colorMap, hoveredCluster.cluster, isDarkMode) }}
                />
                <span>{hoveredCluster.label}</span>
              </div>
            )}

            {/* 3b. Connection badges */}
            {hoverConnectionStats && (
              <div className={hoverStyles.connectionBadges}>
                <ConnectionBadges
                  stats={hoverConnectionStats}
                  compact
                  onViewThread={
                    hoverPinned && onViewThread && hoveredIndex !== null && hoveredIndex !== undefined
                      ? () => onViewThread(hoveredIndex)
                      : undefined
                  }
                  onViewQuotes={
                    hoverPinned && onViewQuotes && hoveredIndex !== null && hoveredIndex !== undefined
                      ? () => onViewQuotes(hoveredIndex)
                      : undefined
                  }
                />
              </div>
            )}

            {/* 4. Media thumbnails */}
            {allMedia.length > 0 && (
              <div className={hoverStyles.mediaRow}>
                {allMedia.slice(0, 4).map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                    <img src={url} alt="" className={hoverStyles.mediaThumb} loading="lazy" />
                  </a>
                ))}
              </div>
            )}

            {/* 5. Quoted tweets */}
            {allQuotes.length > 0 && (
              <div className={hoverStyles.quotesRow}>
                {allQuotes.slice(0, 2).map((qt) => (
                  <div key={qt.tweetId} onClick={(e) => e.stopPropagation()}>
                    <TwitterEmbed
                      tweetId={qt.tweetId}
                      tweetUrl={qt.tweetUrl}
                      theme={isDarkMode ? 'dark' : 'light'}
                      hideConversation={true}
                      compact={true}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* 6. External URL hints */}
            {hoverCardData.externalUrls.length > 0 && (
              <div className={hoverStyles.urlHints}>
                {hoverCardData.externalUrls.slice(0, 3).map((u, i) => (
                  <a
                    key={i}
                    href={u.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={hoverStyles.urlHint}
                    onClick={(e) => e.stopPropagation()}
                  >
                    ↗ {u.display}
                  </a>
                ))}
              </div>
            )}

            {/* 7. Actions — only when pinned */}
            {hoverPinned && (
              <div className={hoverStyles.actionRow}>
                {hoverCardData.tweetUrl && (
                  <button
                    className={hoverStyles.actionButton}
                    onClick={() => window.open(hoverCardData.tweetUrl, '_blank', 'noopener,noreferrer')}
                  >
                    Open
                  </button>
                )}
                <button
                  className={hoverStyles.actionButton}
                  onClick={handleCopyText}
                  disabled={!hoverCardData.rawText}
                >
                  Copy
                </button>
                <button
                  className={hoverStyles.actionButton}
                  onClick={() => onFilterToCluster && onFilterToCluster(hoveredCluster)}
                  disabled={!hoveredCluster}
                >
                  Filter Cluster
                </button>
                <button
                  className={hoverStyles.actionButton}
                  onClick={() => onUnpinHover && onUnpinHover()}
                >
                  Unpin
                </button>
              </div>
            )}
          </div>
        );
      })()}

    </div>
  );
});

export default VisualizationPane;
