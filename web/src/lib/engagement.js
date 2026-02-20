const LIKE_KEYS = ['favorites', 'favorite_count', 'like_count', 'likes'];
const RETWEET_KEYS = ['retweets', 'retweet_count'];
const REPLY_KEYS = ['replies', 'reply_count'];

export function toMetricNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const num = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(num) ? num : 0;
}

export function getMetricRawValue(row, keys) {
  if (!row) return null;
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

export function getLikesRawValue(row) {
  return getMetricRawValue(row, LIKE_KEYS);
}

export function getRetweetsRawValue(row) {
  return getMetricRawValue(row, RETWEET_KEYS);
}

export function getRepliesRawValue(row) {
  return getMetricRawValue(row, REPLY_KEYS);
}

export function getLikesCount(row) {
  return toMetricNumber(getLikesRawValue(row));
}

export function getRetweetsCount(row) {
  return toMetricNumber(getRetweetsRawValue(row));
}

export function getRepliesCount(row) {
  return toMetricNumber(getRepliesRawValue(row));
}

export function getEngagementScore(row, { retweetWeight = 0.7, replyWeight = 0.1 } = {}) {
  return getLikesCount(row) + getRetweetsCount(row) * retweetWeight + getRepliesCount(row) * replyWeight;
}

