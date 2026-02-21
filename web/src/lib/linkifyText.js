import { createElement } from 'react';

// Match http/https URLs — stops at whitespace or common delimiters
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

// Trailing punctuation that often gets swept into URL matches
const TRAILING_PUNCT_RE = /[.,;:!?)]+$/;

function truncateUrl(href) {
  try {
    const u = new URL(href);
    const path = u.pathname + u.search;
    const display = u.hostname.replace(/^www\./, '') + (path.length > 1 ? path : '');
    return display.length > 35 ? display.slice(0, 32) + '\u2026' : display;
  } catch {
    return href.length > 35 ? href.slice(0, 32) + '\u2026' : href;
  }
}

const stopProp = (e) => e.stopPropagation();

/**
 * Split text into an array of strings and <a> elements for detected URLs.
 * Pure function — no side effects, no network calls.
 *
 * @param {string} text - Raw text
 * @param {string} [linkClassName] - CSS class for <a> elements
 * @returns {(string|ReactElement)[]}
 */
export function linkifyText(text, linkClassName) {
  if (!text) return [text];

  const parts = [];
  let lastIndex = 0;

  URL_RE.lastIndex = 0;
  let match;

  while ((match = URL_RE.exec(text)) !== null) {
    let url = match[0];

    // Strip trailing punctuation
    const trailing = url.match(TRAILING_PUNCT_RE);
    if (trailing) {
      url = url.slice(0, -trailing[0].length);
    }

    const matchEnd = match.index + url.length;

    // Preceding text
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    // Link element
    parts.push(
      createElement(
        'a',
        {
          key: match.index,
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: linkClassName,
          onClick: stopProp,
        },
        truncateUrl(url)
      )
    );

    lastIndex = matchEnd;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}
