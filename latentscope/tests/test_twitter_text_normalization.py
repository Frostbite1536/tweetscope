import json

from latentscope.importers.twitter import _flatten_tweet, load_community_archive_raw


def test_flatten_tweet_decodes_html_and_replaces_url_entities() -> None:
    row = _flatten_tweet(
        {
            "tweet": {
                "id_str": "1",
                "full_text": "A &amp; B https://t.co/abc https://t.co/media",
                "created_at": "Thu Jan 01 00:00:00 +0000 2026",
                "entities": {
                    "urls": [
                        {
                            "url": "https://t.co/abc",
                            "expanded_url": "https://example.com/path?a=1",
                            "display_url": "example.com/path",
                            "indices": ["10", "26"],
                        }
                    ]
                },
                "extended_entities": {
                    "media": [
                        {
                            "url": "https://t.co/media",
                            "expanded_url": "https://x.com/user/status/1/photo/1",
                            "display_url": "pic.x.com/media",
                            "media_url_https": "https://pbs.twimg.com/media/foo.jpg",
                            "indices": ["27", "45"],
                            "type": "photo",
                        }
                    ]
                },
            }
        }
    )

    assert row["text_raw"] == "A &amp; B https://t.co/abc https://t.co/media"
    assert row["text"] == "A & B https://example.com/path?a=1 https://x.com/user/status/1/photo/1"
    assert "https://t.co/" not in row["text"]

    assert json.loads(row["urls_json"]) == ["https://example.com/path?a=1"]
    assert json.loads(row["media_urls_json"]) == ["https://pbs.twimg.com/media/foo.jpg"]

    entities = json.loads(row["url_entities_json"])
    assert len(entities) == 2
    assert entities[0]["kind"] == "url"
    assert entities[1]["kind"] == "media"
    assert entities[1]["expanded_url"] == "https://x.com/user/status/1/photo/1"


def test_flatten_tweet_replaces_media_placeholder_with_full_media_url() -> None:
    row = _flatten_tweet(
        {
            "tweet": {
                "id_str": "2",
                "full_text": "Look https://t.co/mediaonly",
                "entities": {"urls": []},
                "extended_entities": {
                    "media": [
                        {
                            "url": "https://t.co/mediaonly",
                            "expanded_url": "https://x.com/user/status/2/photo/1",
                            "media_url_https": "https://pbs.twimg.com/media/bar.jpg",
                            "indices": ["5", "29"],
                            "type": "photo",
                        }
                    ]
                },
            }
        }
    )

    assert row["text"] == "Look https://x.com/user/status/2/photo/1"
    assert "https://t.co/" not in row["text"]
    assert json.loads(row["urls_json"]) == []
    assert json.loads(row["media_urls_json"]) == ["https://pbs.twimg.com/media/bar.jpg"]


def test_flatten_tweet_uses_flat_url_fallback_and_decodes_html() -> None:
    row = _flatten_tweet(
        {
            "tweet": {
                "id_str": "3",
                "full_text": "&lt;ok&gt;",
                "urls": ["https://example.org/foo"],
                "media_urls": ["https://pbs.twimg.com/media/fallback.jpg"],
            }
        }
    )

    assert row["text"] == "<ok>"
    assert json.loads(row["urls_json"]) == ["https://example.org/foo"]
    assert json.loads(row["media_urls_json"]) == ["https://pbs.twimg.com/media/fallback.jpg"]
    entities = json.loads(row["url_entities_json"])
    assert len(entities) == 1
    assert entities[0]["kind"] == "url"
    assert entities[0]["expanded_url"] == "https://example.org/foo"


def test_load_community_archive_raw_merges_note_tweet_and_keeps_unmatched() -> None:
    raw_data = {
        "account": [{"account": {"username": "alice", "accountDisplayName": "Alice"}}],
        "profile": [{"profile": {"description": {"bio": "bio"}}}],
        "tweets": [
            {
                "tweet": {
                    "id_str": "100",
                    "full_text": "short draft",
                    "created_at": "Thu Jan 01 00:00:00 +0000 2026",
                    "note_tweet": {"note_tweet_id": "note-100"},
                    "entities": {"urls": []},
                    "extended_entities": {"media": []},
                }
            }
        ],
        "note-tweet": [
            {
                "noteTweet": {
                    "noteTweetId": "note-100",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "core": {
                        "text": "longer note text with url",
                        "urls": [{"expandedUrl": "https://example.com/note"}],
                    },
                }
            },
            {
                "noteTweet": {
                    "noteTweetId": "note-unmatched",
                    "createdAt": "2026-01-02T00:00:00.000Z",
                    "core": {"text": "unmatched note"},
                }
            },
        ],
        "like": [],
    }

    result = load_community_archive_raw(raw_data, username="alice")
    rows = result.rows

    tweet_row = next(r for r in rows if r["id"] == "100")
    assert tweet_row["tweet_type"] == "tweet"
    assert tweet_row["text"] == "longer note text with url"
    assert tweet_row["note_tweet_id"] == "note-100"
    assert json.loads(tweet_row["urls_json"]) == ["https://example.com/note"]

    unmatched_note = next(r for r in rows if r["id"] == "note-unmatched")
    assert unmatched_note["tweet_type"] == "note_tweet"
    assert unmatched_note["text"] == "unmatched note"
