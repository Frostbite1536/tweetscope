/**
 * Shared URL parsing utilities for Twitter/X data from parquet columns.
 * Used by both VisualizationPane (hover card) and TweetCard (feed).
 */

export const TCO_RE = /https?:\/\/t\.co\/[a-zA-Z0-9]+/g;
export const STATUS_URL_RE = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]+)\/status\/(\d+)/i;

export function stripTcoUrls(text) {
  return text.replace(TCO_RE, '').replace(/\s{2,}/g, ' ').trim();
}

export function parseJsonArray(str) {
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function classifyUrls(urlsJson) {
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
