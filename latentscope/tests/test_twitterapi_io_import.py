"""Tests for the twitterapi.io JSON importer."""

import json

from latentscope.importers.twitterapi_io import (
    load_twitterapi_io_json,
    _flatten_twitterapi_tweet,
)


def _make_tweet(**overrides):
    """Build a minimal twitterapi.io tweet object."""
    tweet = {
        "type": "tweet",
        "id": "123456",
        "url": "https://x.com/testuser/status/123456",
        "text": "Hello world",
        "source": "Twitter Web App",
        "retweetCount": 5,
        "replyCount": 2,
        "likeCount": 10,
        "quoteCount": 1,
        "viewCount": 500,
        "createdAt": "2026-01-15T12:00:00.000Z",
        "lang": "en",
        "bookmarkCount": 0,
        "isReply": False,
        "inReplyToId": None,
        "conversationId": "123456",
        "inReplyToUsername": None,
        "author": {
            "type": "user",
            "userName": "testuser",
            "id": "999",
            "name": "Test User",
            "profilePicture": "https://pbs.twimg.com/profile/test.jpg",
            "coverPicture": "https://pbs.twimg.com/banner/test.jpg",
            "description": "A test account",
            "location": "Testville",
        },
        "entities": {"hashtags": [], "urls": [], "user_mentions": []},
    }
    tweet.update(overrides)
    return tweet


def test_basic_tweet_normalisation():
    row = _flatten_twitterapi_tweet(_make_tweet())
    assert row["id"] == "123456"
    assert row["text"] == "Hello world"
    assert row["favorites"] == 10
    assert row["retweets"] == 5
    assert row["replies"] == 2
    assert row["username"] == "testuser"
    assert row["display_name"] == "Test User"
    assert row["lang"] == "en"
    assert row["is_reply"] is False
    assert row["is_retweet"] is False
    assert row["is_like"] is False
    assert row["tweet_type"] == "tweet"
    assert row["archive_source"] == "twitterapi_io"
    assert row["conversation_id"] == "123456"


def test_html_entity_decoding():
    row = _flatten_twitterapi_tweet(_make_tweet(text="A &amp; B &lt;3"))
    assert row["text"] == "A & B <3"
    assert row["text_raw"] == "A &amp; B &lt;3"


def test_url_entity_extraction():
    tweet = _make_tweet(
        text="Check this https://t.co/abc",
        entities={
            "hashtags": [],
            "urls": [
                {
                    "url": "https://t.co/abc",
                    "expanded_url": "https://example.com/article",
                    "display_url": "example.com/article",
                    "indices": [11, 31],
                }
            ],
            "user_mentions": [],
        },
    )
    row = _flatten_twitterapi_tweet(tweet)
    assert "https://example.com/article" in row["text"]
    assert "t.co" not in row["text"]
    urls = json.loads(row["urls_json"])
    assert "https://example.com/article" in urls


def test_reply_detection():
    row = _flatten_twitterapi_tweet(_make_tweet(isReply=True, inReplyToId="999"))
    assert row["is_reply"] is True
    assert row["in_reply_to_status_id"] == "999"


def test_retweet_detection_via_text():
    row = _flatten_twitterapi_tweet(_make_tweet(text="RT @other: some tweet"))
    assert row["is_retweet"] is True


def test_retweet_detection_via_retweeted_tweet():
    row = _flatten_twitterapi_tweet(
        _make_tweet(retweeted_tweet={"id": "555", "text": "original"})
    )
    assert row["is_retweet"] is True


def test_quoted_tweet_id():
    row = _flatten_twitterapi_tweet(
        _make_tweet(quoted_tweet={"id": "777", "text": "quoted"})
    )
    assert row["quoted_status_id"] == "777"


def test_load_from_api_response():
    payload = {
        "tweets": [_make_tweet(), _make_tweet(id="999", text="Second tweet")],
        "has_next_page": False,
        "next_cursor": "",
    }
    result = load_twitterapi_io_json(payload)
    assert result.source == "twitterapi_io"
    assert len(result.rows) == 2
    assert result.profile["username"] == "testuser"
    assert result.rows[0]["id"] == "123456"
    assert result.rows[1]["id"] == "999"


def test_load_from_bare_list():
    result = load_twitterapi_io_json([_make_tweet()])
    assert len(result.rows) == 1
    assert result.source == "twitterapi_io"


def test_load_skips_empty_tweets():
    result = load_twitterapi_io_json([_make_tweet(id="", text="")])
    assert len(result.rows) == 0


def test_username_override():
    tweet = _make_tweet()
    del tweet["author"]
    result = load_twitterapi_io_json([tweet], username="override_user")
    assert result.profile["username"] == "override_user"


def test_schema_keys_match_flatten_tweet():
    """Ensure all keys from _flatten_twitterapi_tweet match the canonical schema."""
    from latentscope.importers.twitter import _flatten_tweet

    canonical = _flatten_tweet({"tweet": {"id_str": "1", "full_text": "test"}})
    twitterapi = _flatten_twitterapi_tweet(_make_tweet())
    assert set(canonical.keys()) == set(twitterapi.keys()), (
        f"Key mismatch: canonical has {set(canonical.keys()) - set(twitterapi.keys())}, "
        f"twitterapi has {set(twitterapi.keys()) - set(canonical.keys())}"
    )
