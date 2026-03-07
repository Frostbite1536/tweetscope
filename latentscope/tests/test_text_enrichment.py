from __future__ import annotations

import numpy as np
import pandas as pd

from latentscope.util.text_enrichment import get_labeling_texts


def test_get_labeling_texts_adds_thread_windows_for_long_self_threads() -> None:
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "text": "Root idea",
                "in_reply_to_status_id": None,
                "username": "alice",
                "created_at": "2024-01-01T00:00:00Z",
                "tweet_type": "tweet",
            },
            {
                "id": "2",
                "text": "First reply expands the idea",
                "in_reply_to_status_id": "1",
                "username": "alice",
                "created_at": "2024-01-01T00:01:00Z",
                "tweet_type": "tweet",
            },
            {
                "id": "3",
                "text": "Second reply adds detail",
                "in_reply_to_status_id": "2",
                "username": "alice",
                "created_at": "2024-01-01T00:02:00Z",
                "tweet_type": "tweet",
            },
            {
                "id": "4",
                "text": "Third reply concludes the thread",
                "in_reply_to_status_id": "3",
                "username": "alice",
                "created_at": "2024-01-01T00:03:00Z",
                "tweet_type": "tweet",
            },
            {
                "id": "5",
                "text": "Standalone thought",
                "in_reply_to_status_id": None,
                "username": "alice",
                "created_at": "2024-01-02T00:00:00Z",
                "tweet_type": "tweet",
            },
        ]
    )

    texts, stats, thread_metadata = get_labeling_texts(df, "text")

    assert stats["thread_window_count"] == 4
    assert stats["thread_window_thread_count"] == 1

    assert "Thread root:" in texts[2]
    assert "Previous post:" in texts[2]
    assert "Current post:" in texts[2]
    assert "Next post 1:" in texts[2]

    assert texts[4] == "Standalone thought"
    assert thread_metadata["exemplar_group_ids"][0] == thread_metadata["exemplar_group_ids"][3]
    assert thread_metadata["exemplar_group_ids"][4] != thread_metadata["exemplar_group_ids"][0]

