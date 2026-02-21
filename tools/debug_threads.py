#!/usr/bin/env python3
"""
Headless thread diagnostic for sheik-tweets.
Reads node_stats + tweet data from LanceDB to verify thread groupings.
"""
import os
import lancedb
import pandas as pd
from collections import defaultdict, Counter

DATASET = os.environ.get("DATASET", "sheik-tweets")
DATA_DIR = os.path.expanduser(os.environ.get("LATENT_SCOPE_DATA", "~/latent-scope-data"))

def main():
    dataset_dir = os.path.join(DATA_DIR, DATASET)
    db_uri = os.path.join(dataset_dir, "lancedb")

    print(f"=== Thread Diagnostic: {DATASET} ===")
    print(f"Data dir: {dataset_dir}\n")

    db = lancedb.connect(db_uri)
    ns_df = db.open_table(f"{DATASET}__node_stats").to_pandas()
    tweets_df = pd.read_parquet(os.path.join(dataset_dir, "input.parquet"))
    print(f"node_stats rows: {len(ns_df)}")
    print(f"tweets rows: {len(tweets_df)}")

    # Check thread_root_id distribution
    root_counts = Counter(ns_df["thread_root_id"].astype(str).tolist())
    print(f"\n=== THREAD_ROOT_ID DISTRIBUTION ===")
    print(f"Unique values: {len(root_counts)}")
    for root_id, count in root_counts.most_common(20):
        print(f"  {repr(root_id):>50s}: {count:>5d} tweets")

    # Check thread_size distribution
    size_counts = Counter(ns_df["thread_size"].tolist())
    print(f"\n=== THREAD_SIZE DISTRIBUTION ===")
    for size, count in sorted(size_counts.items()):
        print(f"  thread_size={size}: {count} tweets")

    # Check thread_depth distribution
    depth_counts = Counter(ns_df["thread_depth"].tolist())
    print(f"\n=== THREAD_DEPTH DISTRIBUTION ===")
    for depth, count in sorted(depth_counts.items()):
        print(f"  thread_depth={depth}: {count} tweets")

    # Check what's going on with the most common root_id
    top_root, top_count = root_counts.most_common(1)[0]
    print(f"\n=== BIGGEST 'THREAD': root_id={repr(top_root)}, {top_count} tweets ===")
    big_members = ns_df[ns_df["thread_root_id"].astype(str) == top_root]
    # Sample some of these
    sample_indices = big_members["ls_index"].head(10).tolist()
    for idx in sample_indices:
        row = tweets_df.iloc[idx]
        reply_to = row.get("in_reply_to_status_id", "")
        is_rt = row.get("is_retweet", False)
        is_reply = row.get("is_reply", False)
        text = str(row.get("text", ""))[:120]
        ns_row = big_members[big_members["ls_index"] == idx].iloc[0]
        print(f"  [idx={idx}] [depth={ns_row['thread_depth']}] [size={ns_row['thread_size']}]"
              f" [reply_to={reply_to}] [RT={is_rt}] [is_reply={is_reply}]")
        print(f"    {text}")

    # Check how many tweets have reply_to = None/empty
    reply_tos = tweets_df["in_reply_to_status_id"].astype(str)
    null_replies = reply_tos.isin(["None", "", "nan", "null"]).sum()
    has_reply = len(tweets_df) - null_replies
    print(f"\n=== REPLY STATUS ===")
    print(f"  Tweets with in_reply_to_status_id: {has_reply}")
    print(f"  Tweets without (standalone/RT): {null_replies}")

    # Check tweet_type and is_retweet distribution
    if "is_retweet" in tweets_df.columns:
        rt_count = tweets_df["is_retweet"].sum()
        print(f"  Retweets: {rt_count}")
    if "tweet_type" in tweets_df.columns:
        print(f"  Tweet types: {Counter(tweets_df['tweet_type'].tolist())}")

    # Check: what does the JS hook see?
    # It groups by threadRootId where threadSize >= 2
    print(f"\n=== WHAT THE JS HOOK WOULD SEE ===")
    multi_thread = ns_df[ns_df["thread_size"] >= 2]
    print(f"  Tweets with thread_size >= 2: {len(multi_thread)}")
    hook_roots = Counter(multi_thread["thread_root_id"].astype(str).tolist())
    for root_id, count in hook_roots.most_common(10):
        print(f"    root={repr(root_id)}: {count} tweets")

    # Now check: the JS hook also uses statsMap which is keyed by ls_index
    # It iterates statsMap.forEach and groups by threadRootId
    # The issue: all tweets have a thread_root_id, even standalone ones
    # thread_size=1 means standalone — the hook correctly filters these
    # But what if thread_size is wrong?

    # Let's verify: group by thread_root_id and count, compare to thread_size
    print(f"\n=== THREAD_SIZE vs ACTUAL GROUP SIZE ===")
    actual_groups = ns_df.groupby(ns_df["thread_root_id"].astype(str)).size()
    for root_id in actual_groups.index:
        actual_size = actual_groups[root_id]
        stated_sizes = ns_df[ns_df["thread_root_id"].astype(str) == root_id]["thread_size"].unique()
        if actual_size != stated_sizes[0] or actual_size > 1:
            print(f"  root={repr(root_id)}: actual={actual_size}, stated={stated_sizes}")

    # The real question: how many ACTUAL self-reply threads exist?
    # A self-reply thread = user's own tweet replying to their own tweet
    print(f"\n=== ACTUAL SELF-REPLY CHAINS ===")
    all_tweet_ids = set(tweets_df["id"].astype(str).tolist())
    replies_to_self = tweets_df[
        tweets_df["in_reply_to_status_id"].astype(str).isin(all_tweet_ids) &
        (tweets_df["is_retweet"] != True)
    ]
    print(f"  Tweets replying to another tweet in dataset: {len(replies_to_self)}")

    # Build real thread chains from in_reply_to
    parent_map = {}
    for _, row in tweets_df.iterrows():
        tid = str(row["id"])
        reply_to = str(row.get("in_reply_to_status_id", ""))
        if reply_to and reply_to not in ("None", "", "nan") and reply_to in all_tweet_ids:
            parent_map[tid] = reply_to

    # Walk chains to find roots
    real_threads = defaultdict(list)
    for tid in all_tweet_ids:
        current = tid
        visited = set()
        while current in parent_map and current not in visited:
            visited.add(current)
            current = parent_map[current]
        real_threads[current].append(tid)

    real_multi = {root: members for root, members in real_threads.items() if len(members) >= 2}
    print(f"  Real threads (in-dataset chains, size >= 2): {len(real_multi)}")
    for root_id, members in sorted(real_multi.items(), key=lambda x: -len(x[1]))[:10]:
        root_idx = tweets_df[tweets_df["id"].astype(str) == root_id].index
        root_text = str(tweets_df.iloc[root_idx[0]]["text"])[:100] if len(root_idx) > 0 else "<external>"
        total_eng = 0
        for tid in members:
            tidx = tweets_df[tweets_df["id"].astype(str) == tid].index
            if len(tidx) > 0:
                r = tweets_df.iloc[tidx[0]]
                total_eng += int(r.get("favorites", 0) or 0) + int(r.get("retweets", 0) or 0)
        print(f"  [{len(members)} tweets, {total_eng} engagement] {root_text}")

    # Also check conversation_id — Twitter's native thread grouping
    if "conversation_id" in tweets_df.columns:
        convo_ids = tweets_df["conversation_id"].astype(str)
        non_null_convos = convo_ids[~convo_ids.isin(["None", "", "nan"])].tolist()
        print(f"\n=== CONVERSATION_ID ANALYSIS ===")
        print(f"  Tweets with conversation_id: {len(non_null_convos)}")
        convo_counts = Counter(non_null_convos)
        multi_convos = {k: v for k, v in convo_counts.items() if v >= 2}
        print(f"  Conversations with 2+ tweets: {len(multi_convos)}")
        for cid, count in sorted(multi_convos.items(), key=lambda x: -x[1])[:10]:
            cidx = tweets_df[tweets_df["conversation_id"].astype(str) == cid].index
            first_text = str(tweets_df.iloc[cidx[0]]["text"])[:100]
            print(f"    [conv_id={cid}, {count} tweets] {first_text}")


if __name__ == "__main__":
    main()
