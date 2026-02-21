"""Shared text enrichment utilities for tweet reference resolution.

Used by both the embedding pipeline (embed.py) and the labeling pipeline
(toponymy_labels.py) to enrich tweet text with referenced tweet content
(quote tweets, linked tweets) found via status URLs in the urls_json column.

Import-time enrichment (t.co expansion, HTML entity decoding) happens
earlier in twitter.py and is already baked into input.parquet.
"""

import re
import json

_NULL_SENTINELS = frozenset({"none", "null", "nan", "<na>", ""})

_STATUS_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:x\.com|twitter\.com)/(?:i/web/)?(?:[A-Za-z0-9_]+/)?status/(?P<tweet_id>\d+)",
    re.IGNORECASE,
)


def normalize_tweet_id(value):
    """Normalize tweet ID: strip trailing .0, handle null sentinels."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in _NULL_SENTINELS:
        return None
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text


def _parse_urls_json(value):
    """Parse urls_json column into list of URL strings."""
    if value is None:
        return []
    raw = value
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return []
    else:
        parsed = raw
    if not isinstance(parsed, list):
        return []
    urls = []
    for item in parsed:
        if isinstance(item, str):
            urls.append(item)
        elif isinstance(item, dict):
            url = item.get("expanded_url") or item.get("url") or ""
            if url:
                urls.append(str(url))
    return urls


def _extract_status_id(url):
    """Extract tweet ID from a twitter.com/x.com status URL."""
    match = _STATUS_URL_RE.search(str(url))
    if not match:
        return None
    return match.group("tweet_id")


def build_reference_text_map(df, text_column):
    """Build a map from row index to enriched text with referenced tweet content.

    For each tweet, finds referenced tweets (via urls_json status URLs) that exist
    in the dataset, and prepends their text. This gives downstream consumers context
    about what a quote tweet or link-reference is commenting on.

    The original text column in the DataFrame is NOT modified.

    Returns:
        enriched_text: dict[int, str] — row_index → enriched text (only for rows
            that have resolvable references; rows without references are absent)
        stats: dict with enrichment statistics
    """
    has_urls = "urls_json" in df.columns
    if not has_urls:
        return {}, {"enriched_count": 0, "total_references_resolved": 0}

    # Build normalized ID → (row_index, text) lookup
    id_to_text = {}
    for idx in range(len(df)):
        row = df.iloc[idx]
        norm_id = normalize_tweet_id(row.get("id"))
        if norm_id:
            id_to_text[norm_id] = str(row.get(text_column) or "")

    enriched_text = {}
    total_resolved = 0

    for idx in range(len(df)):
        row = df.iloc[idx]
        own_id = normalize_tweet_id(row.get("id"))

        # Collect referenced tweet IDs from URL entities
        ref_texts = []
        seen_ref_ids = set()
        for url in _parse_urls_json(row.get("urls_json")):
            ref_id = _extract_status_id(url)
            if not ref_id or ref_id == own_id or ref_id in seen_ref_ids:
                continue
            seen_ref_ids.add(ref_id)
            ref_text = id_to_text.get(ref_id)
            if ref_text:
                ref_texts.append(ref_text)

        if ref_texts:
            # Concatenate: referenced text(s) first, then the tweet's own text
            own_text = str(row.get(text_column) or "")
            combined = "\n\n".join(ref_texts) + "\n\n" + own_text
            enriched_text[idx] = combined
            total_resolved += len(ref_texts)

    stats = {
        "enriched_count": len(enriched_text),
        "total_references_resolved": total_resolved,
    }
    return enriched_text, stats


def get_enriched_texts(df, text_column):
    """Return list[str] with enriched versions where references resolve.

    For tweets that reference other tweets in the dataset (via status URLs
    in urls_json), returns the referenced text concatenated with the tweet's
    own text. For all other tweets, returns the raw text.

    Returns:
        texts: list[str] — one text per row, enriched where possible
        stats: dict with enrichment statistics
    """
    enriched_map, stats = build_reference_text_map(df, text_column)
    texts = df[text_column].tolist()
    for idx, enriched in enriched_map.items():
        texts[idx] = enriched
    return texts, stats
