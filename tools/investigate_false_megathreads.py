"""
Investigate whether "false mega-threads" exist in actual datasets.

A false mega-thread is: multiple internal tweets replying to the same external tweet
share a thread_root_id with thread_size > 1, but have 0 internal reply edges between them.
"""

import lancedb
import os
import pandas as pd

pd.set_option('display.max_columns', None)
pd.set_option('display.width', 200)
pd.set_option('display.max_colwidth', 80)

data_dir = os.path.expanduser("~/latent-scope-data")

datasets = [d for d in os.listdir(data_dir) if os.path.isdir(os.path.join(data_dir, d)) and d != '_catalog']
print("=" * 80)
print("DATASETS:", datasets)
print("=" * 80)

for ds in datasets:
    db_path = os.path.join(data_dir, ds, "lancedb")
    if not os.path.exists(db_path):
        print(f"\n{ds}: no lancedb/ directory, skipping")
        continue
    
    db = lancedb.connect(db_path)
    tables = db.table_names()
    print(f"\n{ds} tables: {tables}")
    
    ns_name = f"{ds}__node_stats"
    edge_name = f"{ds}__edges"
    
    has_ns = ns_name in tables
    has_edges = edge_name in tables
    print(f"  node_stats ({ns_name}): {has_ns}")
    print(f"  edges ({edge_name}): {has_edges}")
    
    if not has_ns:
        print(f"  No node_stats table, skipping")
        continue
    
    print(f"\n{'=' * 80}")
    print(f"DATASET: {ds}")
    print(f"{'=' * 80}")
    
    ns = db.open_table(ns_name).to_pandas()
    print(f"\nnode_stats shape: {ns.shape}")
    print(f"node_stats columns: {list(ns.columns)}")
    
    has_thread_root = 'thread_root_id' in ns.columns
    has_thread_size = 'thread_size' in ns.columns
    has_thread_depth = 'thread_depth' in ns.columns
    has_ls_index = 'ls_index' in ns.columns
    
    print(f"  has thread_root_id: {has_thread_root}")
    print(f"  has thread_size: {has_thread_size}")
    print(f"  has thread_depth: {has_thread_depth}")
    print(f"  has ls_index: {has_ls_index}")
    
    if not has_thread_root:
        print("  No thread_root_id column, skipping")
        continue
    
    print(f"\nSample rows (first 5):")
    show_cols = [c for c in ['ls_index', 'tweet_id', 'thread_root_id', 'thread_depth', 'thread_size', 
                              'in_reply_to_tweet_id', 'in_reply_to_user_id', 'reply_count', 'quote_count'] 
                 if c in ns.columns]
    print(ns[show_cols].head(5).to_string())
    
    # Filter to rows that have a non-null/non-empty thread_root_id
    ns_threaded = ns[ns['thread_root_id'].notna() & (ns['thread_root_id'] != '')]
    print(f"\nRows with thread_root_id: {len(ns_threaded)} / {len(ns)}")
    
    print(f"thread_root_id nunique: {ns_threaded['thread_root_id'].nunique()}")
    if has_thread_size:
        print(f"\nthread_size distribution:")
        print(ns_threaded['thread_size'].describe())
        print(f"\nthread_size value_counts (top 15):")
        print(ns_threaded['thread_size'].value_counts().head(15))
    
    # Group by thread_root_id to count INTERNAL members
    root_counts = ns_threaded.groupby('thread_root_id').size().reset_index(name='member_count')
    multi_roots = root_counts[root_counts['member_count'] >= 2].sort_values('member_count', ascending=False)
    print(f"\nThread roots with 2+ internal members: {len(multi_roots)}")
    print(f"Top 15 by member count:")
    print(multi_roots.head(15).to_string())
    
    if not has_edges:
        print(f"\n  No edges table, cannot check internal edges. Skipping edge analysis.")
        # But we can still look at depth patterns
        if has_thread_depth and len(multi_roots) > 0:
            print(f"\n--- DEPTH ANALYSIS (no edges available) ---")
            for _, row in multi_roots.head(10).iterrows():
                root_id = row['thread_root_id']
                members = ns_threaded[ns_threaded['thread_root_id'] == root_id]
                depths = sorted(members['thread_depth'].tolist())
                print(f"  root={root_id}, members={row['member_count']}, depths={depths[:20]}")
        continue
    
    print(f"\n--- Loading edges table: {edge_name} ---")
    edges = db.open_table(edge_name).to_pandas()
    print(f"edges shape: {edges.shape}")
    print(f"edges columns: {list(edges.columns)}")
    
    if 'edge_kind' in edges.columns:
        print(f"\nedge_kind value_counts:")
        print(edges['edge_kind'].value_counts())
    
    print(f"\nSample edges (first 5):")
    print(edges.head(5).to_string())
    
    # Detect src/dst columns
    src_col = None
    dst_col = None
    for c in edges.columns:
        if 'src' in c.lower() and 'index' in c.lower():
            src_col = c
        if 'dst' in c.lower() and 'index' in c.lower():
            dst_col = c
    if not src_col or not dst_col:
        for c in edges.columns:
            if 'source' in c.lower():
                src_col = c
            if 'target' in c.lower() or 'dest' in c.lower():
                dst_col = c
    
    print(f"  Detected src_col={src_col}, dst_col={dst_col}")
    
    if not src_col or not dst_col:
        print("  Could not detect src/dst columns!")
        print(f"  Available: {list(edges.columns)}")
        continue
    
    idx_col = 'ls_index' if has_ls_index else ns.columns[0]
    
    if 'edge_kind' in edges.columns:
        reply_edges = edges[edges['edge_kind'] == 'reply']
    else:
        reply_edges = edges
    print(f"Total reply edges: {len(reply_edges)}")
    
    print(f"\n{'*' * 60}")
    print(f"FALSE MEGA-THREAD ANALYSIS")
    print(f"{'*' * 60}")
    
    false_mega_count = 0
    true_thread_count = 0
    partial_thread_count = 0
    results = []
    
    for _, row in multi_roots.iterrows():
        root_id = row['thread_root_id']
        member_count = row['member_count']
        
        members = ns_threaded[ns_threaded['thread_root_id'] == root_id]
        member_indices = set(members[idx_col].tolist())
        
        internal_edges = reply_edges[
            (reply_edges[src_col].isin(member_indices)) & 
            (reply_edges[dst_col].isin(member_indices))
        ]
        
        n_internal = len(internal_edges)
        expected_min = member_count - 1
        
        if n_internal == 0:
            category = "FALSE_MEGA_THREAD"
            false_mega_count += 1
        elif n_internal < expected_min:
            category = "PARTIAL_THREAD"
            partial_thread_count += 1
        else:
            category = "TRUE_THREAD"
            true_thread_count += 1
        
        depths = sorted(members['thread_depth'].tolist()) if has_thread_depth else []
        sizes = members['thread_size'].tolist() if has_thread_size else []
        
        results.append({
            'thread_root_id': root_id,
            'member_count': member_count,
            'internal_reply_edges': n_internal,
            'expected_min_edges': expected_min,
            'category': category,
            'depths': depths,
            'sizes': sizes,
        })
    
    print(f"\n--- SUMMARY ---")
    print(f"Total multi-member thread roots: {len(multi_roots)}")
    print(f"  TRUE_THREAD (>= N-1 internal edges): {true_thread_count}")
    print(f"  PARTIAL_THREAD (1..N-2 internal edges): {partial_thread_count}")
    print(f"  FALSE_MEGA_THREAD (0 internal edges): {false_mega_count}")
    
    total_false_members = sum(r['member_count'] for r in results if r['category'] == 'FALSE_MEGA_THREAD')
    total_partial_members = sum(r['member_count'] for r in results if r['category'] == 'PARTIAL_THREAD')
    total_true_members = sum(r['member_count'] for r in results if r['category'] == 'TRUE_THREAD')
    print(f"\n  Tweets in FALSE_MEGA_THREADs: {total_false_members}")
    print(f"  Tweets in PARTIAL_THREADs: {total_partial_members}")
    print(f"  Tweets in TRUE_THREADs: {total_true_members}")
    
    if false_mega_count > 0:
        print(f"\n--- FALSE MEGA-THREAD EXAMPLES (up to 20) ---")
        false_results = sorted([r for r in results if r['category'] == 'FALSE_MEGA_THREAD'],
                               key=lambda x: x['member_count'], reverse=True)
        for r in false_results[:20]:
            print(f"  root={r['thread_root_id']}, members={r['member_count']}, "
                  f"internal_edges={r['internal_reply_edges']}, "
                  f"depths={r['depths'][:15]}, sizes={r['sizes'][:5]}")
    
    if partial_thread_count > 0:
        print(f"\n--- PARTIAL THREAD EXAMPLES (up to 10) ---")
        partial_results = sorted([r for r in results if r['category'] == 'PARTIAL_THREAD'],
                                 key=lambda x: x['member_count'], reverse=True)
        for r in partial_results[:10]:
            print(f"  root={r['thread_root_id']}, members={r['member_count']}, "
                  f"internal_edges={r['internal_reply_edges']}, expected_min={r['expected_min_edges']}, "
                  f"depths={r['depths'][:15]}")
    
    # Deep dive into biggest false mega-thread
    if false_mega_count > 0:
        biggest_false = max(
            [r for r in results if r['category'] == 'FALSE_MEGA_THREAD'],
            key=lambda x: x['member_count']
        )
        print(f"\n{'*' * 60}")
        print(f"DEEP DIVE: Biggest false mega-thread")
        print(f"{'*' * 60}")
        print(f"thread_root_id: {biggest_false['thread_root_id']}")
        print(f"member_count: {biggest_false['member_count']}")
        
        members = ns_threaded[ns_threaded['thread_root_id'] == biggest_false['thread_root_id']]
        print(f"\nAll members:")
        if show_cols:
            print(members[show_cols].to_string())
        else:
            print(members.to_string())
        
        member_indices = set(members[idx_col].tolist())
        
        # Check ALL edges (not just reply) involving these members
        all_involving = edges[
            (edges[src_col].isin(member_indices)) | 
            (edges[dst_col].isin(member_indices))
        ]
        print(f"\nAll edges (any kind) involving these members: {len(all_involving)}")
        if len(all_involving) > 0 and len(all_involving) <= 40:
            print(all_involving.to_string())
        elif len(all_involving) > 40:
            print(all_involving.head(40).to_string())
            print(f"  ... and {len(all_involving) - 40} more")
        else:
            print("  NONE - these tweets have no edges to each other at all!")
        
        # Check what these tweets are replying to
        if 'in_reply_to_tweet_id' in members.columns:
            print(f"\nin_reply_to_tweet_id values:")
            print(members[['ls_index', 'tweet_id', 'in_reply_to_tweet_id', 'thread_root_id', 'thread_depth']].to_string())
            reply_targets = members['in_reply_to_tweet_id'].unique()
            print(f"\nUnique reply targets: {reply_targets}")
            print(f"Are all replying to same external tweet? {len(reply_targets) == 1}")
    
    # Also deep dive into biggest true thread for comparison
    if true_thread_count > 0:
        biggest_true = max(
            [r for r in results if r['category'] == 'TRUE_THREAD'],
            key=lambda x: x['member_count']
        )
        print(f"\n{'*' * 60}")
        print(f"COMPARISON: Biggest true thread")
        print(f"{'*' * 60}")
        print(f"thread_root_id: {biggest_true['thread_root_id']}")
        print(f"member_count: {biggest_true['member_count']}")
        print(f"internal_edges: {biggest_true['internal_reply_edges']}")
        print(f"depths: {biggest_true['depths'][:30]}")

print("\n" + "=" * 80)
print("INVESTIGATION COMPLETE")
print("=" * 80)
