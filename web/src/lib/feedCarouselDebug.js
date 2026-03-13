const DEBUG_STORAGE_KEY = 'debug:feed-carousel';
const DEBUG_GLOBAL_FLAG = '__LATENT_SCOPE_DEBUG_FEED_CAROUSEL__';
const DEBUG_GLOBAL_EVENTS = '__LATENT_SCOPE_FEED_CAROUSEL_DEBUG_EVENTS__';
const MAX_DEBUG_EVENTS = 200;

export function isFeedCarouselDebugEnabled() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;

  try {
    return window.localStorage.getItem(DEBUG_STORAGE_KEY) === '1' || window[DEBUG_GLOBAL_FLAG] === true;
  } catch {
    return window[DEBUG_GLOBAL_FLAG] === true;
  }
}

export function recordFeedCarouselDebug(type, payload = {}) {
  if (!isFeedCarouselDebugEnabled()) return;

  const entry = {
    type,
    ts: typeof performance !== 'undefined' ? Number(performance.now().toFixed(1)) : Date.now(),
    ...payload,
  };

  const events = Array.isArray(window[DEBUG_GLOBAL_EVENTS]) ? window[DEBUG_GLOBAL_EVENTS] : [];
  events.push(entry);
  if (events.length > MAX_DEBUG_EVENTS) {
    events.splice(0, events.length - MAX_DEBUG_EVENTS);
  }
  window[DEBUG_GLOBAL_EVENTS] = events;

  console.log('[FeedCarouselDebug]', entry);
}
