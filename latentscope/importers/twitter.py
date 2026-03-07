"""Helpers for importing Twitter/X archive data into Latent Scope."""

from __future__ import annotations

import html
import json
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.error import HTTPError
from urllib.request import urlopen


COMMUNITY_ARCHIVE_BLOB_BASE = (
    "https://fabxmporizzqflnftavs.supabase.co/storage/v1/object/public/archives"
)
EXTRACTED_ARCHIVE_FORMAT = "x_native_extracted_v1"


@dataclass
class ImportResult:
    """Normalized import payload ready for tabular ingestion."""

    profile: dict[str, Any]
    rows: list[dict[str, Any]]
    source: str


def _parse_ytd_js_payload(raw_text: str) -> Any:
    """
    Parse Twitter/X archive JS payload files shaped like:
      window.YTD.tweets.part0 = [ ... ];
    """
    text = raw_text.strip()
    equals_idx = text.find("=")
    if equals_idx < 0:
        raise ValueError("Invalid YTD payload: missing assignment")
    payload = text[equals_idx + 1 :].strip()
    if payload.endswith(";"):
        payload = payload[:-1].strip()
    return json.loads(payload)


def _to_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_date_any(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value

    text = str(value).strip()
    if not text:
        return None

    # Native tweet date format: Thu Jan 22 12:32:00 +0000 2026
    try:
        return datetime.strptime(text, "%a %b %d %H:%M:%S %z %Y")
    except ValueError:
        pass

    # ISO date format with optional Z suffix.
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _parse_indices(value: Any) -> tuple[int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    try:
        start = int(value[0])
        end = int(value[1])
    except (TypeError, ValueError):
        return None
    if start < 0 or end < start:
        return None
    return start, end


def _extract_urls_and_entities(
    tweet: dict[str, Any],
) -> tuple[list[str], list[str], list[dict[str, Any]]]:
    """Extract URLs/media plus rich entity metadata for deterministic text cleanup."""
    urls: list[str] = []
    media_urls: list[str] = []
    url_entities: list[dict[str, Any]] = []

    for url in tweet.get("entities", {}).get("urls", []) or []:
        expanded = url.get("expanded_url")
        short = url.get("url")
        display = url.get("display_url")
        indices = _parse_indices(url.get("indices"))
        if expanded:
            urls.append(str(expanded))
        url_entities.append(
            {
                "kind": "url",
                "url": str(short) if short else None,
                "expanded_url": str(expanded) if expanded else None,
                "display_url": str(display) if display else None,
                "indices": [indices[0], indices[1]] if indices else None,
            }
        )

    for media in tweet.get("extended_entities", {}).get("media", []) or []:
        short = media.get("url")
        expanded = media.get("expanded_url")
        display = media.get("display_url")
        media_url = media.get("media_url_https") or media.get("media_url")
        indices = _parse_indices(media.get("indices"))
        if media_url:
            media_urls.append(str(media_url))
        url_entities.append(
            {
                "kind": "media",
                "url": str(short) if short else None,
                "expanded_url": str(expanded) if expanded else None,
                "display_url": str(display) if display else None,
                "media_url": str(media_url) if media_url else None,
                "media_type": media.get("type"),
                "indices": [indices[0], indices[1]] if indices else None,
            }
        )

    # Fallback: community archive flat format has top-level `urls` list.
    if not urls:
        flat_urls = tweet.get("urls")
        if isinstance(flat_urls, list):
            for value in flat_urls:
                if isinstance(value, str) and value:
                    urls.append(value)
                    url_entities.append(
                        {
                            "kind": "url",
                            "url": None,
                            "expanded_url": value,
                            "display_url": None,
                            "indices": None,
                        }
                    )

    # Fallback: community archive flat format has top-level `media_urls` list.
    if not media_urls:
        flat_media = tweet.get("media_urls")
        if isinstance(flat_media, list):
            for value in flat_media:
                if isinstance(value, str) and value:
                    media_urls.append(value)

    return (
        _dedupe_preserve_order(urls),
        _dedupe_preserve_order(media_urls),
        url_entities,
    )


def _entity_replacement_value(entity: dict[str, Any]) -> str | None:
    kind = str(entity.get("kind") or "").lower()
    if kind == "media":
        return (
            entity.get("expanded_url")
            or entity.get("media_url")
            or entity.get("display_url")
        )
    return entity.get("expanded_url") or entity.get("display_url")


def _replace_tco_entities(text: str, entities: list[dict[str, Any]]) -> str:
    """Replace t.co placeholders with richer URLs (media prefers full expanded URL)."""
    out = text

    indexed: list[tuple[int, int, str, str]] = []
    for entity in entities:
        token = entity.get("url")
        replacement = _entity_replacement_value(entity)
        idx = _parse_indices(entity.get("indices"))
        if not token or not replacement or "t.co/" not in str(token) or not idx:
            continue
        indexed.append((idx[0], idx[1], str(token), str(replacement)))

    for start, end, token, replacement in sorted(indexed, key=lambda item: item[0], reverse=True):
        if end <= len(out) and out[start:end] == token:
            out = out[:start] + replacement + out[end:]

    # Fallback pass: literal replacement handles index mismatches (e.g., UTF-16 offsets).
    for entity in entities:
        token = entity.get("url")
        replacement = _entity_replacement_value(entity)
        if not token or not replacement or "t.co/" not in str(token):
            continue
        if token in out:
            out = out.replace(str(token), str(replacement))

    return out


def _text_fingerprint(text: str) -> str:
    """Normalize tweet text for fuzzy matching against note tweets.

    Strips leading @mentions, decodes common HTML entities, removes trailing
    ellipsis, collapses whitespace, and lowercases.
    """
    t = str(text)
    # Strip leading @mention chains (e.g. "@user1 @user2 actual text")
    t = re.sub(r"^(?:@\w+\s*)+", "", t)
    # Decode common HTML entities
    t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    # Strip trailing ellipsis (Unicode … or ...)
    t = re.sub(r"[\u2026.]{1,3}\s*$", "", t)
    # Collapse whitespace and lowercase
    t = re.sub(r"\s+", " ", t).strip().lower()
    # Use first 80 chars for matching (enough to be unique, short enough to
    # tolerate truncation differences)
    return t[:80]


@dataclass
class _NoteTweetInfo:
    """Parsed note tweet ready for merging into its parent tweet."""
    note_tweet_id: str
    text: str
    urls: list[str]
    created_at: str | None


def _build_note_tweet_lookup(
    notes_raw: list[Any],
) -> tuple[dict[str, _NoteTweetInfo], dict[str, _NoteTweetInfo]]:
    """Build lookup tables from raw note-tweet.js entries.

    Returns (by_id, by_fingerprint) where:
      - by_id maps noteTweetId → _NoteTweetInfo
      - by_fingerprint maps _text_fingerprint(text) → _NoteTweetInfo
    """
    by_id: dict[str, _NoteTweetInfo] = {}
    by_fingerprint: dict[str, _NoteTweetInfo] = {}

    for note_obj in notes_raw:
        note = note_obj.get("noteTweet", note_obj)
        core = note.get("core", {})
        text = core.get("text", "")
        if not text:
            continue
        note_id = str(note.get("noteTweetId") or "")
        if not note_id:
            continue

        urls = []
        for url in core.get("urls", []) or []:
            expanded = url.get("expandedUrl")
            if expanded:
                urls.append(expanded)

        dt = _parse_date_any(note.get("createdAt"))
        info = _NoteTweetInfo(
            note_tweet_id=note_id,
            text=str(text),
            urls=urls,
            created_at=dt.isoformat() if dt else None,
        )
        by_id[note_id] = info
        fp = _text_fingerprint(text)
        if fp:
            by_fingerprint[fp] = info

    return by_id, by_fingerprint


def _extract_profile_from_native(account_data: Any, profile_data: Any) -> dict[str, Any]:
    account = {}
    if isinstance(account_data, list) and account_data:
        account = account_data[0].get("account", {})
    elif isinstance(account_data, dict):
        account = account_data.get("account", account_data)

    profile = {}
    if isinstance(profile_data, list) and profile_data:
        profile = profile_data[0].get("profile", {})
    elif isinstance(profile_data, dict):
        profile = profile_data.get("profile", profile_data)

    return {
        "username": account.get("username"),
        "display_name": account.get("accountDisplayName"),
        "account_id": account.get("accountId"),
        "created_at": account.get("createdAt"),
        "bio": profile.get("description", {}).get("bio", ""),
        "website": profile.get("description", {}).get("website", ""),
        "location": profile.get("description", {}).get("location", ""),
        "avatar_url": profile.get("avatarMediaUrl"),
        "header_url": profile.get("headerMediaUrl"),
    }


def _flatten_tweet(
    tweet_obj: dict[str, Any],
    username: str | None = None,
    display_name: str | None = None,
    source: str = "x_native",
    note_tweets_by_id: dict[str, _NoteTweetInfo] | None = None,
    note_tweets_by_fp: dict[str, _NoteTweetInfo] | None = None,
    consumed_note_ids: set[str] | None = None,
) -> dict[str, Any]:
    t = tweet_obj.get("tweet", tweet_obj)
    dt = _parse_date_any(t.get("created_at"))
    created_at_iso = dt.isoformat() if dt else None
    text_raw = str(t.get("full_text") or t.get("text") or "")
    text = text_raw

    urls, media_urls, url_entities = _extract_urls_and_entities(t)

    is_reply = bool(t.get("in_reply_to_status_id_str") or t.get("in_reply_to_status_id"))
    is_retweet = bool(t.get("retweeted_status")) or str(text).startswith("RT @")

    # --- Note tweet merge: upgrade truncated text with full note version ---
    note_tweet_id = None
    matched_note: _NoteTweetInfo | None = None

    if note_tweets_by_id or note_tweets_by_fp:
        # 1) Direct lookup: tweet object may contain a note_tweet reference
        raw_note_ref = t.get("note_tweet", {})
        if isinstance(raw_note_ref, dict):
            ref_id = str(raw_note_ref.get("note_tweet_id") or "")
            if ref_id and note_tweets_by_id and ref_id in note_tweets_by_id:
                matched_note = note_tweets_by_id[ref_id]

        # 2) Fallback: fingerprint-based matching
        if matched_note is None and note_tweets_by_fp:
            fp = _text_fingerprint(text)
            if fp and fp in note_tweets_by_fp:
                matched_note = note_tweets_by_fp[fp]

        if matched_note is not None:
            text = matched_note.text
            note_tweet_id = matched_note.note_tweet_id
            # Merge URLs from note tweet (may have expanded URLs not in the
            # truncated tweet's entities)
            if matched_note.urls:
                existing = set(urls)
                for u in matched_note.urls:
                    if u not in existing:
                        urls.append(u)
                        url_entities.append(
                            {
                                "kind": "url",
                                "url": None,
                                "expanded_url": u,
                                "display_url": None,
                                "indices": None,
                                "source": "note_tweet",
                            }
                        )
            if consumed_note_ids is not None:
                consumed_note_ids.add(matched_note.note_tweet_id)

    # Phase A normalization:
    # 1) preserve original text, 2) decode HTML entities, 3) replace t.co links.
    text = html.unescape(str(text))
    text = _replace_tco_entities(text, url_entities)

    return {
        "id": str(t.get("id_str") or t.get("id") or ""),
        "liked_tweet_id": None,
        "text": str(text),
        "text_raw": text_raw,
        "created_at": created_at_iso or t.get("created_at"),
        "created_at_raw": t.get("created_at"),
        "favorites": _to_int(t.get("favorite_count")),
        "retweets": _to_int(t.get("retweet_count")),
        "replies": _to_int(t.get("reply_count")),
        "lang": t.get("lang"),
        "source": t.get("source"),
        "username": username or t.get("user", {}).get("screen_name"),
        "display_name": display_name,
        "in_reply_to_status_id": t.get("in_reply_to_status_id_str") or t.get("in_reply_to_status_id"),
        "in_reply_to_screen_name": t.get("in_reply_to_screen_name"),
        # NOTE: quoted_status_id is always empty in both native X archive exports
        # and community archives (X strips this key from export data). Kept as a
        # dormant field — if a future data source populates it, build_links_graph.py
        # will use it as the primary quote-edge source (with URL parsing as fallback).
        "quoted_status_id": t.get("quoted_status_id_str") or t.get("quoted_status_id") or None,
        "conversation_id": t.get("conversation_id_str") or t.get("conversation_id") or None,
        "is_reply": is_reply,
        "is_retweet": is_retweet,
        "is_like": False,
        "urls_json": json.dumps(urls, ensure_ascii=False) if urls else "[]",
        "media_urls_json": json.dumps(media_urls, ensure_ascii=False) if media_urls else "[]",
        "url_entities_json": json.dumps(url_entities, ensure_ascii=False) if url_entities else "[]",
        "tweet_type": "tweet",
        "archive_source": source,
        "note_tweet_id": note_tweet_id,
    }


def _flatten_note_tweet(
    note_obj: dict[str, Any],
    username: str | None = None,
    display_name: str | None = None,
    source: str = "x_native",
) -> dict[str, Any] | None:
    note = note_obj.get("noteTweet", note_obj)
    core = note.get("core", {})
    text = core.get("text", "")
    if not text:
        return None

    dt = _parse_date_any(note.get("createdAt"))
    created_at_iso = dt.isoformat() if dt else None

    urls = []
    url_entities = []
    for url in core.get("urls", []) or []:
        expanded = url.get("expandedUrl")
        if expanded:
            urls.append(expanded)
            url_entities.append(
                {
                    "kind": "url",
                    "url": str(url.get("url")) if url.get("url") else None,
                    "expanded_url": str(expanded),
                    "display_url": str(url.get("displayUrl")) if url.get("displayUrl") else None,
                    "indices": None,
                }
            )

    note_id = str(note.get("noteTweetId") or "")
    text_raw = str(text)
    text_norm = html.unescape(text_raw)
    return {
        "id": note_id,
        "liked_tweet_id": None,
        "text": text_norm,
        "text_raw": text_raw,
        "created_at": created_at_iso or note.get("createdAt"),
        "created_at_raw": note.get("createdAt"),
        "favorites": 0,
        "retweets": 0,
        "replies": 0,
        "lang": None,
        "source": None,
        "username": username,
        "display_name": display_name,
        "in_reply_to_status_id": None,
        "in_reply_to_screen_name": None,
        "quoted_status_id": None,
        "conversation_id": None,
        "is_reply": False,
        "is_retweet": False,
        "is_like": False,
        "urls_json": json.dumps(urls, ensure_ascii=False) if urls else "[]",
        "media_urls_json": "[]",
        "url_entities_json": json.dumps(url_entities, ensure_ascii=False) if url_entities else "[]",
        "tweet_type": "note_tweet",
        "archive_source": source,
        "note_tweet_id": note_id,
    }


def _flatten_like(
    like_obj: dict[str, Any],
    username: str | None = None,
    display_name: str | None = None,
    source: str = "x_native",
) -> dict[str, Any] | None:
    like = like_obj.get("like", like_obj)
    tweet_id = like.get("tweetId") or like.get("tweet_id") or like.get("id_str") or like.get("id")
    if not tweet_id:
        return None

    expanded_url = like.get("expandedUrl") or like.get("expanded_url")
    full_text = like.get("fullText") or like.get("full_text") or like.get("text") or ""
    text = str(full_text).strip()
    if not text:
        text = str(expanded_url or f"Liked tweet {tweet_id}")
    text_raw = text

    urls = []
    url_entities = []
    if expanded_url:
        urls.append(expanded_url)
        url_entities.append(
            {
                "kind": "url",
                "url": None,
                "expanded_url": str(expanded_url),
                "display_url": None,
                "indices": None,
            }
        )

    text = html.unescape(text)

    return {
        "id": str(tweet_id),
        "liked_tweet_id": str(tweet_id),
        "text": text,
        "text_raw": text_raw,
        "created_at": like.get("createdAt") or like.get("created_at"),
        "created_at_raw": like.get("createdAt") or like.get("created_at"),
        "favorites": 0,
        "retweets": 0,
        "replies": 0,
        "lang": None,
        "source": None,
        "username": username,
        "display_name": display_name,
        "in_reply_to_status_id": None,
        "in_reply_to_screen_name": None,
        "quoted_status_id": None,
        "conversation_id": None,
        "is_reply": False,
        "is_retweet": False,
        "is_like": True,
        "urls_json": json.dumps(urls, ensure_ascii=False) if urls else "[]",
        "media_urls_json": "[]",
        "url_entities_json": json.dumps(url_entities, ensure_ascii=False) if url_entities else "[]",
        "tweet_type": "like",
        "archive_source": source,
        "note_tweet_id": None,
    }


def _collect_deduped_community_likes(payload: dict[str, Any]) -> list[Any]:
    """
    Collect community-archive likes supporting both key variants:
    - `like` (raw archive payload)
    - `likes` (some extracted variants)
    """
    likes: list[Any] = []
    seen_like_keys: set[str] = set()
    for key in ("like", "likes"):
        value = payload.get(key, [])
        if not isinstance(value, list):
            continue
        for like_obj in value:
            like_core = like_obj.get("like", like_obj) if isinstance(like_obj, dict) else like_obj
            if isinstance(like_core, dict):
                dedupe_key = str(
                    like_core.get("tweetId")
                    or like_core.get("tweet_id")
                    or like_core.get("id_str")
                    or like_core.get("id")
                    or json.dumps(like_core, sort_keys=True, ensure_ascii=False)
                )
            else:
                dedupe_key = json.dumps(like_core, sort_keys=True, ensure_ascii=False)
            if dedupe_key in seen_like_keys:
                continue
            seen_like_keys.add(dedupe_key)
            likes.append(like_obj)
    return likes


def _ensure_int_like(value: Any, field_name: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as err:
        raise ValueError(f"{field_name} must be an integer") from err


def validate_extracted_archive_payload(
    payload: Any,
    *,
    require_archive_format: bool = True,
) -> dict[str, int]:
    """
    Validate extracted archive payload contract used by browser-local imports.

    Expected top-level shape:
      {
        "archive_format": "x_native_extracted_v1",
        "profile": {...},
        "tweets": [ ... ],
        "likes": [ ... ],
        "tweet_count": int,
        "likes_count": int,
        "total_count": int
      }
    """
    if not isinstance(payload, dict):
        raise ValueError("Extracted payload must be a JSON object")

    archive_format = payload.get("archive_format")
    if require_archive_format and archive_format != EXTRACTED_ARCHIVE_FORMAT:
        raise ValueError(
            f"archive_format must be '{EXTRACTED_ARCHIVE_FORMAT}'"
        )
    if archive_format not in (None, EXTRACTED_ARCHIVE_FORMAT):
        raise ValueError(f"Unsupported archive_format: {archive_format}")

    profile = payload.get("profile")
    if profile is None:
        raise ValueError("Missing required field: profile")
    if not isinstance(profile, dict):
        raise ValueError("profile must be an object")

    tweets = payload.get("tweets")
    likes = payload.get("likes")
    if not isinstance(tweets, list):
        raise ValueError("tweets must be an array")
    if not isinstance(likes, list):
        raise ValueError("likes must be an array")

    if not tweets and not likes:
        raise ValueError("Extracted payload must include at least one tweet or like")

    for idx, tweet_obj in enumerate(tweets):
        if not isinstance(tweet_obj, dict):
            raise ValueError(f"tweets[{idx}] must be an object")
        tweet = tweet_obj.get("tweet", tweet_obj)
        if not isinstance(tweet, dict):
            raise ValueError(f"tweets[{idx}].tweet must be an object")
        tweet_id = tweet.get("id_str") or tweet.get("id")
        text = tweet.get("full_text") or tweet.get("text")
        if not str(tweet_id or "").strip():
            raise ValueError(f"tweets[{idx}] missing id_str/id")
        if not str(text or "").strip():
            raise ValueError(f"tweets[{idx}] missing full_text/text")

    for idx, like_obj in enumerate(likes):
        if not isinstance(like_obj, dict):
            raise ValueError(f"likes[{idx}] must be an object")
        like = like_obj.get("like", like_obj)
        if not isinstance(like, dict):
            raise ValueError(f"likes[{idx}].like must be an object")
        tweet_id = (
            like.get("tweetId")
            or like.get("tweet_id")
            or like.get("id_str")
            or like.get("id")
        )
        if not str(tweet_id or "").strip():
            raise ValueError(f"likes[{idx}] missing tweetId/tweet_id/id")

    tweet_count = _ensure_int_like(payload.get("tweet_count"), "tweet_count")
    likes_count = _ensure_int_like(payload.get("likes_count"), "likes_count")
    total_count = _ensure_int_like(payload.get("total_count"), "total_count")

    if tweet_count != len(tweets):
        raise ValueError("tweet_count does not match tweets length")
    if likes_count != len(likes):
        raise ValueError("likes_count does not match likes length")
    if total_count != tweet_count + likes_count:
        raise ValueError("total_count must equal tweet_count + likes_count")

    return {
        "tweet_count": tweet_count,
        "likes_count": likes_count,
        "total_count": total_count,
    }


def load_native_x_archive_zip(zip_path: str) -> ImportResult:
    """Load and normalize a native X export archive zip."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = set(zf.namelist())

        if "data/tweets.js" not in names:
            raise ValueError("Invalid X archive zip: expected data/tweets.js")

        account_raw = _parse_ytd_js_payload(
            zf.read("data/account.js").decode("utf-8")
        ) if "data/account.js" in names else []
        profile_raw = _parse_ytd_js_payload(
            zf.read("data/profile.js").decode("utf-8")
        ) if "data/profile.js" in names else []
        tweets_raw = _parse_ytd_js_payload(zf.read("data/tweets.js").decode("utf-8"))
        notes_raw = _parse_ytd_js_payload(
            zf.read("data/note-tweet.js").decode("utf-8")
        ) if "data/note-tweet.js" in names else []
        likes_raw = _parse_ytd_js_payload(
            zf.read("data/like.js").decode("utf-8")
        ) if "data/like.js" in names else []

    profile = _extract_profile_from_native(account_raw, profile_raw)
    username = profile.get("username")
    display_name = profile.get("display_name")

    # Build note tweet lookup for merging into parent tweets
    note_by_id, note_by_fp = _build_note_tweet_lookup(notes_raw)
    consumed_note_ids: set[str] = set()

    rows: list[dict[str, Any]] = []
    for tw in tweets_raw:
        rows.append(_flatten_tweet(
            tw,
            username=username,
            display_name=display_name,
            source="x_native",
            note_tweets_by_id=note_by_id,
            note_tweets_by_fp=note_by_fp,
            consumed_note_ids=consumed_note_ids,
        ))
    # Only add note tweets that weren't merged into a parent tweet
    for nt in notes_raw:
        note = nt.get("noteTweet", nt)
        note_id = str(note.get("noteTweetId") or "")
        if note_id in consumed_note_ids:
            continue
        row = _flatten_note_tweet(nt, username=username, display_name=display_name, source="x_native")
        if row:
            rows.append(row)
    for lk in likes_raw:
        row = _flatten_like(lk, username=username, display_name=display_name, source="x_native")
        if row:
            rows.append(row)

    return ImportResult(profile=profile, rows=rows, source="x_native")


def _extract_profile_from_community_raw(raw_data: dict[str, Any], username: str) -> dict[str, Any]:
    account_data = {}
    if raw_data.get("account"):
        acc = raw_data["account"]
        if isinstance(acc, list) and acc:
            account_data = acc[0].get("account", {})
        elif isinstance(acc, dict):
            account_data = acc.get("account", acc)

    profile_data = {}
    if raw_data.get("profile"):
        prof = raw_data["profile"]
        if isinstance(prof, list) and prof:
            profile_data = prof[0].get("profile", {})
        elif isinstance(prof, dict):
            profile_data = prof.get("profile", prof)

    return {
        "username": account_data.get("username", username),
        "account_id": account_data.get("accountId"),
        "display_name": account_data.get("accountDisplayName"),
        "created_at": account_data.get("createdAt"),
        "bio": profile_data.get("description", {}).get("bio", ""),
        "website": profile_data.get("description", {}).get("website", ""),
        "location": profile_data.get("description", {}).get("location", ""),
        "avatar_url": profile_data.get("avatarMediaUrl"),
        "header_url": profile_data.get("headerMediaUrl"),
    }


def fetch_community_archive(username: str) -> dict[str, Any]:
    """Fetch raw community archive payload for a username."""
    url = f"{COMMUNITY_ARCHIVE_BLOB_BASE}/{username.lower()}/archive.json"
    try:
        with urlopen(url) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as err:
        if err.code in (400, 404):
            raise ValueError(
                f"Community archive for '{username}' not found. "
                "Check that this user has a public archive at community.archive.org."
            ) from err
        raise


def load_community_archive_raw(raw_data: dict[str, Any], username: str) -> ImportResult:
    """Load and normalize raw community archive JSON payload."""
    profile = _extract_profile_from_community_raw(raw_data, username)
    notes_raw = raw_data.get("note-tweet", [])
    if not isinstance(notes_raw, list):
        notes_raw = []

    note_by_id, note_by_fp = _build_note_tweet_lookup(notes_raw)
    consumed_note_ids: set[str] = set()

    normalized: list[dict[str, Any]] = []
    for tweet_obj in raw_data.get("tweets", []):
        normalized.append(
            _flatten_tweet(
                tweet_obj,
                username=profile.get("username"),
                display_name=profile.get("display_name"),
                source="community_archive",
                note_tweets_by_id=note_by_id,
                note_tweets_by_fp=note_by_fp,
                consumed_note_ids=consumed_note_ids,
            )
        )

    # Keep unmatched note tweets as standalone rows (same behavior as native zip path).
    for nt in notes_raw:
        note = nt.get("noteTweet", nt) if isinstance(nt, dict) else {}
        note_id = str(note.get("noteTweetId") or "")
        if note_id and note_id in consumed_note_ids:
            continue
        row = _flatten_note_tweet(
            nt,
            username=profile.get("username"),
            display_name=profile.get("display_name"),
            source="community_archive",
        )
        if row:
            normalized.append(row)

    for like_obj in _collect_deduped_community_likes(raw_data):
        row = _flatten_like(
            like_obj,
            username=profile.get("username"),
            display_name=profile.get("display_name"),
            source="community_archive",
        )
        if row:
            normalized.append(row)
    return ImportResult(profile=profile, rows=normalized, source="community_archive")


def _dedup_note_tweet_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove note-tweet duplicate rows that overlap with a regular tweet.

    When the browser-side extraction includes both a truncated tweet and its
    note-tweet version as separate entries, keep the regular tweet (which has
    engagement metadata) but upgrade its text with the note-tweet version.
    """
    # Separate note_tweet rows from the rest
    note_rows: list[dict[str, Any]] = []
    other_rows: list[dict[str, Any]] = []
    for row in rows:
        if row.get("tweet_type") == "note_tweet":
            note_rows.append(row)
        else:
            other_rows.append(row)

    if not note_rows:
        return rows

    # Build fingerprint index from non-note rows
    fp_to_idx: dict[str, int] = {}
    for idx, row in enumerate(other_rows):
        fp = _text_fingerprint(row.get("text", ""))
        if fp:
            fp_to_idx[fp] = idx

    consumed: set[int] = set()
    for note_row in note_rows:
        note_fp = _text_fingerprint(note_row.get("text", ""))
        if note_fp and note_fp in fp_to_idx:
            # Upgrade the regular tweet's text with the note version
            target_idx = fp_to_idx[note_fp]
            other_rows[target_idx]["text"] = note_row["text"]
            other_rows[target_idx]["text_raw"] = note_row.get("text_raw", note_row["text"])
            other_rows[target_idx]["note_tweet_id"] = note_row.get("id")

            # Merge note URLs/entities so replacement metadata remains available.
            try:
                target_urls = json.loads(other_rows[target_idx].get("urls_json", "[]"))
            except Exception:
                target_urls = []
            try:
                note_urls = json.loads(note_row.get("urls_json", "[]"))
            except Exception:
                note_urls = []
            if isinstance(target_urls, list) and isinstance(note_urls, list):
                merged_urls = _dedupe_preserve_order(
                    [u for u in target_urls if isinstance(u, str) and u]
                    + [u for u in note_urls if isinstance(u, str) and u]
                )
                other_rows[target_idx]["urls_json"] = json.dumps(merged_urls, ensure_ascii=False)

            try:
                target_entities = json.loads(other_rows[target_idx].get("url_entities_json", "[]"))
            except Exception:
                target_entities = []
            try:
                note_entities = json.loads(note_row.get("url_entities_json", "[]"))
            except Exception:
                note_entities = []
            if isinstance(target_entities, list) and isinstance(note_entities, list):
                merged_entities = [*target_entities, *note_entities]
                other_rows[target_idx]["url_entities_json"] = json.dumps(merged_entities, ensure_ascii=False)

            consumed.add(id(note_row))

    # Keep unmatched note tweets as standalone rows
    for note_row in note_rows:
        if id(note_row) not in consumed:
            other_rows.append(note_row)

    return other_rows


def load_community_extracted_json(path: str) -> ImportResult:
    """
    Load strict browser-extracted archive payload.
    Format:
      {
        "archive_format": "x_native_extracted_v1",
        "profile": {...},
        "tweets": [...],
        "likes": [...],
        "tweet_count": N,
        "likes_count": N,
        "total_count": N
      }
    """
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    validate_extracted_archive_payload(payload, require_archive_format=True)

    profile = payload.get("profile", {})
    username = profile.get("username")
    display_name = profile.get("display_name")

    rows = []
    for tweet in payload.get("tweets", []):
        rows.append(
            _flatten_tweet(
                tweet,
                username=username,
                display_name=display_name,
                source="community_archive",
            )
        )
    for like_obj in _collect_deduped_community_likes(payload):
        row = _flatten_like(
            like_obj,
            username=username,
            display_name=display_name,
            source="community_archive",
        )
        if row:
            rows.append(row)

    # Defensive dedup: older browser-extracted payloads may include both a
    # regular tweet and its note tweet as separate entries.  Remove note-tweet
    # duplicates by fingerprint matching.
    rows = _dedup_note_tweet_rows(rows)

    return ImportResult(profile=profile, rows=rows, source="community_archive")


def apply_filters(
    rows: list[dict[str, Any]],
    *,
    include_likes: bool = True,
    year: int | None = None,
    lang: str | None = None,
    min_favorites: int = 0,
    min_text_length: int = 0,
    exclude_replies: bool = False,
    exclude_retweets: bool = False,
    top_n: int | None = None,
    sort: str = "recent",
) -> list[dict[str, Any]]:
    """Apply common tweet filters and return sorted rows."""
    result: list[dict[str, Any]] = []

    for row in rows:
        if not include_likes and row.get("tweet_type") == "like":
            continue
        text = row.get("text") or ""
        if min_text_length and len(text) < min_text_length:
            continue
        if lang and row.get("lang") != lang:
            continue
        if min_favorites and _to_int(row.get("favorites")) < min_favorites:
            continue
        if exclude_replies and row.get("is_reply"):
            continue
        if exclude_retweets and row.get("is_retweet"):
            continue
        if year is not None:
            dt = _parse_date_any(row.get("created_at"))
            if not dt or dt.year != year:
                continue
        result.append(row)

    if sort == "engagement":
        result.sort(key=lambda r: (_to_int(r.get("favorites")), _to_int(r.get("retweets"))), reverse=True)
    else:
        def _recent_sort_key(row: dict[str, Any]) -> float:
            dt = _parse_date_any(row.get("created_at"))
            if not dt:
                return float("-inf")
            try:
                return float(dt.timestamp())
            except Exception:
                return float("-inf")

        result.sort(key=_recent_sort_key, reverse=True)

    if top_n is not None and top_n > 0:
        return result[:top_n]
    return result


def split_tweets_and_likes(
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Partition rows into (tweets, likes) based on tweet_type."""
    tweets: list[dict[str, Any]] = []
    likes: list[dict[str, Any]] = []
    for row in rows:
        if row.get("tweet_type") == "like":
            likes.append(row)
        else:
            tweets.append(row)
    return tweets, likes


def sanitize_dataset_id(value: str) -> str:
    """Normalize dataset identifiers to safe slugs."""
    lowered = value.strip().lower()
    lowered = re.sub(r"[^a-z0-9_-]+", "-", lowered)
    lowered = re.sub(r"-{2,}", "-", lowered).strip("-")
    if not lowered:
        raise ValueError("Invalid dataset id")
    return lowered
