from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np


def _ensure_local_toponymy_on_path() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    local_toponymy = os.path.join(repo_root, "toponymy")
    if local_toponymy not in sys.path:
        sys.path.insert(0, local_toponymy)


_ensure_local_toponymy_on_path()

from toponymy.cluster_layer import rebalance_exemplar_indices_by_group


def test_rebalance_exemplar_indices_by_group_keeps_single_thread_dominance_when_only_two_groups() -> None:
    exemplar_indices = [0, 1, 2, 3]
    cluster_member_indices = np.array([0, 1, 2, 3, 4])
    exemplar_group_ids = np.array(["thread-a", "thread-a", "thread-a", "thread-b", "thread-b"], dtype=object)
    candidate_order = np.array([0, 1, 2, 3, 4])

    result = rebalance_exemplar_indices_by_group(
        exemplar_indices,
        cluster_member_indices,
        exemplar_group_ids,
        candidate_order,
    )

    assert result == exemplar_indices


def test_rebalance_exemplar_indices_by_group_adds_missing_groups_when_available() -> None:
    exemplar_indices = [0, 1, 2, 3]
    cluster_member_indices = np.array([0, 1, 2, 3, 4, 5])
    exemplar_group_ids = np.array(
        ["thread-a", "thread-a", "thread-a", "thread-b", "thread-c", "thread-d"],
        dtype=object,
    )
    candidate_order = np.array([0, 1, 2, 3, 4, 5])

    result = rebalance_exemplar_indices_by_group(
        exemplar_indices,
        cluster_member_indices,
        exemplar_group_ids,
        candidate_order,
    )

    unique_groups = {str(exemplar_group_ids[idx]) for idx in result}
    assert len(unique_groups) >= 3
    assert result[0] == 0

