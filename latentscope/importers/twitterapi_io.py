"""Import tweets fetched from the twitterapi.io REST API.

twitterapi.io returns tweets in a camelCase JSON schema that differs from
both the native X archive export and the community archive format.  This
module normalises that schema into the same flat row dictionaries produced
by :func:`latentscope.importers.twitter._flatten_tweet`, so the rows plug
directly into the existing ingestion pipeline.

Typical usage::

    import json, pathlib
    from latentscope.importers.twitterapi_io import load_twitterapi_io_json

    payload = json.loads(pathlib.Path("tweets.json").read_text())
    result = load_twitterapi_io_json(payload)
    # result.rows  -> list[dict] ready for DataFrame / ingest

The loader accepts **either** the raw API response (with a top-level
``"tweets"`` array) **or** a bare list of tweet objects.
"""

from __future__ import annotations

import html as _html
import json
from typing import Any

try:
    from latentscope.importers.twitter import ImportResult
except ImportError:  # standalone / test usage
    from dataclasses import dataclass

    @dataclass
    class ImportResult:  # type: ignore[no-redef]
        profile: dict[str, Any]
        rows: list[dict[str, Any]]
        source: str


_SOURCE = "twitterapi_io"


def _to_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _extract_profile(author: dict[str, Any] | None) -> dict[str, Any]:
    """Build a normalised profile dict from a twitterapi.io ``author`` object."""
    if not author or not isinstance(author, dict):
        return {}
    return {
        "username": author.get("userName"),
        "display_name": author.get("name"),
        "account_id": author.get("id"),
        "created_at": author.get("createdAt"),
        "bio": author.get("description", ""),
        "website": "",
        "location": author.get("location", ""),
        "avatar_url": author.get("profilePicture"),
        "header_url": author.get("coverPicture"),
    }


def _flatten_twitterapi_tweet(tweet: dict[str, Any]) -> dict[str, Any]:
    """Normalise a single twitterapi.io tweet object to the canonical row schema."""
    author = tweet.get("author") or {}

    text_raw = str(tweet.get("text") or "")
    text = _html.unescape(text_raw)

    # --- URL / media extraction from entities --------------------------------
    urls: list[str] = []
    media_urls: list[str] = []
    url_entities: list[dict[str, Any]] = []

    entities = tweet.get("entities") or {}
    for url_obj in entities.get("urls", []) or []:
        expanded = url_obj.get("expanded_url")
        short = url_obj.get("url")
        display = url_obj.get("display_url")
        indices = url_obj.get("indices")
        if expanded:
            urls.append(str(expanded))
        url_entities.append({
            "kind": "url",
            "url": str(short) if short else None,
            "expanded_url": str(expanded) if expanded else None,
            "display_url": str(display) if display else None,
            "indices": indices if isinstance(indices, list) else None,
        })

    # twitterapi.io may embed media in extendedEntities or entities.media
    for media in (tweet.get("extendedEntities") or {}).get("media", []) or []:
        media_url = media.get("media_url_https") or media.get("media_url")
        if media_url:
            media_urls.append(str(media_url))
        url_entities.append({
            "kind": "media",
            "url": str(media.get("url")) if media.get("url") else None,
            "expanded_url": str(media.get("expanded_url")) if media.get("expanded_url") else None,
            "display_url": str(media.get("display_url")) if media.get("display_url") else None,
            "media_url": str(media_url) if media_url else None,
            "media_type": media.get("type"),
            "indices": media.get("indices") if isinstance(media.get("indices"), list) else None,
        })

    # Replace t.co links in text with expanded URLs
    for ue in url_entities:
        token = ue.get("url")
        replacement = ue.get("expanded_url") or ue.get("media_url") or ue.get("display_url")
        if token and replacement and "t.co/" in str(token) and token in text:
            text = text.replace(str(token), str(replacement))

    # --- Reply / retweet detection -------------------------------------------
    is_reply = bool(tweet.get("isReply") or tweet.get("inReplyToId"))
    is_retweet = tweet.get("retweeted_tweet") is not None or text.startswith("RT @")

    # --- Quoted tweet ID (if available) --------------------------------------
    quoted_tweet = tweet.get("quoted_tweet")
    quoted_status_id: str | None = None
    if isinstance(quoted_tweet, dict):
        quoted_status_id = str(quoted_tweet.get("id") or "") or None

    return {
        "id": str(tweet.get("id") or ""),
        "liked_tweet_id": None,
        "text": text,
        "text_raw": text_raw,
        "created_at": tweet.get("createdAt"),
        "created_at_raw": tweet.get("createdAt"),
        "favorites": _to_int(tweet.get("likeCount")),
        "retweets": _to_int(tweet.get("retweetCount")),
        "replies": _to_int(tweet.get("replyCount")),
        "lang": tweet.get("lang"),
        "source": tweet.get("source"),
        "username": author.get("userName"),
        "display_name": author.get("name"),
        "in_reply_to_status_id": tweet.get("inReplyToId"),
        "in_reply_to_screen_name": tweet.get("inReplyToUsername"),
        "quoted_status_id": quoted_status_id,
        "conversation_id": tweet.get("conversationId"),
        "is_reply": is_reply,
        "is_retweet": is_retweet,
        "is_like": False,
        "urls_json": json.dumps(urls, ensure_ascii=False) if urls else "[]",
        "media_urls_json": json.dumps(media_urls, ensure_ascii=False) if media_urls else "[]",
        "url_entities_json": json.dumps(url_entities, ensure_ascii=False) if url_entities else "[]",
        "tweet_type": "tweet",
        "archive_source": _SOURCE,
        "note_tweet_id": None,
    }


def load_twitterapi_io_json(
    data: dict[str, Any] | list[dict[str, Any]],
    *,
    username: str | None = None,
) -> ImportResult:
    """Load tweets from a twitterapi.io JSON response or list of tweet dicts.

    Parameters
    ----------
    data
        Either the raw API response ``{"tweets": [...], ...}`` or a plain
        list of tweet objects.
    username
        Optional username override used for the profile when the payload
        does not include an ``author`` block.

    Returns
    -------
    ImportResult
        Normalised result with ``source="twitterapi_io"``.
    """
    if isinstance(data, list):
        tweets = data
    elif isinstance(data, dict):
        tweets = data.get("tweets", [])
        if not isinstance(tweets, list):
            tweets = []
    else:
        raise TypeError(f"Expected dict or list, got {type(data).__name__}")

    rows: list[dict[str, Any]] = []
    profile: dict[str, Any] = {}

    for tweet in tweets:
        if not isinstance(tweet, dict):
            continue
        row = _flatten_twitterapi_tweet(tweet)
        if not row["id"] or not row["text"]:
            continue
        rows.append(row)

        # Capture profile from the first tweet's author block
        if not profile:
            profile = _extract_profile(tweet.get("author"))

    # Allow caller-supplied username to fill gaps
    if username and not profile.get("username"):
        profile["username"] = username

    return ImportResult(profile=profile, rows=rows, source=_SOURCE)
