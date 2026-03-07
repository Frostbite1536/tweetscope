# Latent Scope: Embedding Enrichment & Pipeline Quality Upgrade

## Context

Analysis of the **visakanv-2024** dataset (14,989 tweets, scopes-004) revealed that the pipeline's core bottleneck is **information poverty at the embedding stage**. Rich metadata is extracted at import but almost none reaches the embedding model.

**Key findings:**
- 87.7% of tweets are replies; 62% classified as micro-replies ("yes", emoji, single links)
- Voyage-context-3 is used for contextual embedding, but only self-reply threads get context. **13,146 replies to other users are embedded with zero context** about what they're replying to
- Quote tweets (where `quoted_status_id` exists) are embedded without the quoted text
- 47% of tweets became HDBSCAN noise and were force-assigned to nearest cluster
- Middle-layer labels (Layers 1-2) have ~0.45 specificity vs 0.88 at leaf level

**Root cause chain:** Poor embeddings → noisy UMAP topology → noise-dominated HDBSCAN → weak clusters → vague labels → poor knowledge extraction

**Primary use case:** Knowledge extraction — finding visa's best ideas, essays, and intellectual threads.

---

## Phase 1: Embedding Enrichment (Implement Now)

Two distinct enrichment strategies, matching how the Voyage context-3 API is designed:

- **Text concatenation** for quote tweets and cross-user replies: the related text is merged into a single string, because a quote tweet (quoted + commentary) is one semantic unit, not two separate chunks.
- **Multi-chunk groups** for self-reply threads: each tweet in a thread is a separate chunk in a group, because a thread IS a document split into chronological pieces — exactly what context-3's chunked embedding is designed for.

### 1a. Quote Tweet Text Enrichment

**Files:** `latentscope/importers/twitter.py`, `latentscope/scripts/embed.py`

**Current:** `quoted_status_id` is stored (twitter.py:401) but the quoted text never reaches the embedding.

**Change:** When a tweet quotes another tweet that exists in the dataset, concatenate the quoted text into the tweet's text before embedding.

```
Currently:  "Visa's commentary about the quote"
Proposed:   "Original quoted tweet text\n\nVisa's commentary about the quote"
```

This happens in `embed.py` at text preparation time (not in the stored `text` column — the UI still shows the original tweet text). The enriched text is what gets embedded as a single chunk (standalone or within a thread group). The quoted tweet still gets its own independent embedding when it's processed in its own group.

**Architecture for future CA lookup:** Add an optional `context_resolver` callback to look up tweet text by ID. Default checks the dataset; future implementation could query community-archive.org.

### 1b. Cross-User Reply Context

**File:** `latentscope/scripts/embed.py`

**Current behavior (line 110-116):** Only same-username replies form threads. Replies to other users are embedded standalone with no context.

**Change:** For replies where the parent tweet exists in the dataset but is by a different user, concatenate the parent text into the reply's text.

```
Currently:  "@bob great point"  → embedded alone, meaning unclear
Proposed:   "Bob's original tweet text\n\n@bob great point"  → full context in one string
```

This is text enrichment in `embed.py`, not group restructuring. The stored `text` column is unchanged (UI displays the original). The enriched reply text becomes a single chunk — either standalone or within a self-reply thread group if the reply is also part of one.

For tweets that are both a reply AND a quote, both the parent text and quoted text get concatenated.

### 1c. Content Signal Score (Text-Based Only)

**File:** `latentscope/importers/twitter.py` (or `latentscope/scripts/twitter_import.py`)

Add a `content_signal` float column (0.0-1.0) computed at import time. **Purely text-based** — engagement metrics (likes, retweets) are NOT included here. Likes will be exposed as a separate `min_likes` filter in the UI, independent of content quality.

| Signal | Score contribution |
|--------|-------------------|
| Text length < 20 chars | 0.1 base |
| Text length 20-100 chars | 0.3 base |
| Text length 100-200 chars | 0.6 base |
| Text length > 200 chars | 0.8 base |
| Pattern match: pure emoji, "yes/no/yup/haha/lol/real" | cap at 0.15 |
| URL-only tweet (just a link, no commentary) | 0.2 |
| Is a note_tweet (long-form) | +0.15 bonus |

Capped at 1.0. This column flows through the pipeline as metadata — used by clustering (Phase 2) and label exemplar selection (Phase 3).

**Verification (required before using downstream):**
1. Sample 20 tweets per score bucket (0.0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0) from visakanv-2024
2. Print each sample with its score
3. Manually verify: do low-score tweets actually look like noise? Do high-score tweets look substantive?
4. Adjust thresholds/weights based on findings before using in clustering

This eval step is critical — the heuristics should be validated empirically, not assumed correct.

---

## Phase 2: Clustering Quality (Implement Now)

### 2a. Two-Phase Signal-Weighted Clustering

**File:** `latentscope/scripts/cluster.py`

~~Original plan: use HDBSCAN's `sample_weight` parameter.~~ **BLOCKED:** Neither `hdbscan` nor `sklearn.cluster.HDBSCAN` supports `sample_weight` (confirmed via API inspection and GitHub issues [#148](https://github.com/scikit-learn-contrib/hdbscan/issues/148), [#101](https://github.com/scikit-learn-contrib/hdbscan/issues/101)).

**Replacement approach: Two-Phase Clustering**

1. **Phase 1 — Cluster high-signal points only:** Filter to tweets with `content_signal >= threshold`, run HDBSCAN on this subset. Cluster centers are shaped entirely by substantive content.
2. **Phase 2 — Assign low-signal points:** Compute centroids from Phase 1 clusters, then assign all below-threshold points to their nearest centroid (same pattern as existing noise reassignment in `cluster.py:96-112`).

```python
if signal_threshold is not None:
    content_signal = input_df['content_signal'].to_numpy()
    high_signal_mask = content_signal >= signal_threshold

    # Phase 1: cluster only substantive tweets
    clusterer = hdbscan.HDBSCAN(...).fit(clustering_vectors[high_signal_mask])
    labels_high = clusterer.labels_

    # Phase 2: assign low-signal tweets to nearest cluster centroid
    cluster_labels = np.full(len(clustering_vectors), -1)
    cluster_labels[high_signal_mask] = labels_high
    # ... reuse existing centroid reassignment logic for remaining points
```

**Why this over alternatives:**
- `sklearn.DBSCAN` supports `sample_weight` but requires manual epsilon tuning and assumes uniform density — not suitable
- Point duplication (copying high-signal rows) inflates the dataset and creates degenerate geometry
- Post-hoc weighted centroid reassignment doesn't reshape the actual density structure
- HDBSCAN soft clustering (`all_points_membership_vectors()`) gives uncertainty info but doesn't weight cluster formation

**CLI flag:** `--signal_threshold <float>` (e.g., 0.3). When set, enables two-phase clustering. Default: None (standard single-phase).

### 2b. Thread-Coherent Post-Processing

**File:** `latentscope/scripts/cluster.py`

After HDBSCAN + noise reassignment:
1. Group tweets by `thread_id` (from the thread groups built in embed.py)
2. For each thread: find the majority cluster
3. If >60% of thread tweets are in one cluster, reassign the rest to that cluster
4. Store `thread_id` column in output for frontend use

This keeps essay-length threads coherent — a 79-tweet thread shouldn't fragment across clusters.

---

## Phase 3: Label Quality (Future — Needs More Research)

These improvements require deeper investigation of the toponymy submodule's internals before implementation.

### 3a. Child-Label-Aware Parent Naming

**Files:** `toponymy/` submodule — `prompt_construction.py`, `templates.py`, `cluster_layer.py`

When generating labels for non-leaf clusters, include child cluster labels in the prompt:
```
"The sub-topics in this cluster are:
- 'Iterative Essaycraft' (42 tweets)
- 'Constraint-Based Drafting' (28 tweets)
- 'Writing Process Reflections' (35 tweets)
Name the overarching theme that unifies these sub-topics."
```

Currently the LLM only sees raw exemplar tweets from the parent cluster. It's being asked to do topic extraction when it should be doing summarization of already-labeled children.

**Research needed:** How does the toponymy labeling order work? Are children always labeled before parents? Need to trace the code path to confirm this assumption holds.

### 3b. Signal-Weighted Exemplar Selection

**Files:** `toponymy/` submodule — `cluster_layer.py` (`adaptive_exemplars`)

When selecting exemplar tweets for label generation, sort by `content_signal` descending and take top N. The LLM should see the cluster's best content, not `"yup"` and `"haha"`.

**Research needed:** How are exemplars currently selected? What does `adaptive_exemplars` actually do? Need to read the code before proposing changes.

### 3c. Thread Position Markers (Hypothesis — Unverified)

Prepending `[n/total]` to thread chunks was proposed as a way to give the embedding model structural awareness. However, **there is no empirical evidence** this helps embedding quality. It could equally add noise. This should only be attempted as a controlled experiment:
1. Embed the same dataset with and without markers
2. Compare downstream cluster quality (noise rate, specificity)
3. Only adopt if measurably better

**Status:** Parked. Not implementing without evidence.

---

## Phase 4: Frontend (Implement Now)

### 4a. Content Quality Filter + Min Likes Filter

**Files:** `web/src/contexts/FilterContext.jsx`, `DeckGLScatter.jsx`

Two independent filter controls:

1. **Content quality slider** (0.0-1.0): Filters by `content_signal` (text-based heuristic)
   - Scatter: low-signal points rendered at 50% opacity and 60% size (not hidden — preserves spatial context)
   - Feed/carousel: hide below-threshold tweets by default, toggle to show all

2. **Min likes filter**: Filters by `favorites_count >= N`
   - Independent of content quality — no cross-wiring
   - Users may want high-engagement micro-replies (a "yes" with 1000 likes is interesting) or low-engagement essays

These are orthogonal dimensions: quality measures text substance, likes measure audience resonance.

### 4b. Cluster Specificity Indicators (Future — Needs Design)

The toponymy labeling process produces a `topic_specificity` score (0-1) per cluster, indicating how well the label captures the cluster's actual content. Currently these scores are stored but invisible to the user.

The idea: surface specificity in the UI so users can tell at a glance which clusters are tightly-defined topics vs. catch-all groupings. But the exact visual treatment needs design work. Deferring until Phase 3 research clarifies how specificity scores actually distribute across the hierarchy.

---

## Critical API & Business Logic Notes

### Voyage context-3: How it actually works

The `contextualized_embed()` API takes `inputs = [["chunk1", "chunk2", ...], ...]`. Each inner list is a **group**. The API returns **one embedding per chunk**, where each chunk's embedding is informed by all other chunks in the same group.

**There is no "context" concept in the API.** Every chunk is treated equally — the API produces embeddings for all of them. The `context_count` variable in our `embed.py` is **purely our internal bookkeeping**: it tells `_scatter_contextual_batch_embeddings()` how many leading embeddings to skip (because those chunks were included only to influence other chunks' embeddings, not to be stored).

### When to use multi-chunk groups vs. text concatenation

- **Multi-chunk groups** (separate strings in one inner list): For **self-reply threads**. A thread is a document split into chronological pieces — each tweet is a chunk. This is exactly what context-3 was designed for. Each tweet gets its own embedding, contextualized by the rest of the thread.

- **Text concatenation** (one merged string): For **quote tweets** and **cross-user replies**. A quote tweet is a single semantic unit — the quoted text and the commentary together form one thought. They should NOT be two separate chunks. Same for a reply: the parent text + reply text together give the reply meaning.

### One embedding per row — no duplication

When tweet 2 quotes tweet 1:
- Tweet 2's text is enriched by concatenating tweet 1's text → one string → one embedding stored on tweet 2's row
- Tweet 1 gets its own independent embedding when processed in its own group (standalone or its own thread)
- No conflict, no "which embedding wins" problem
- A tweet can be quoted multiple times — each quoting tweet gets its own enriched embedding independently

### Content signal vs. engagement — must be independent

`content_signal` is **purely text-based** (length, patterns, note_tweet flag). It answers: "does this text contain substantive content?"

Engagement (`favorites_count`, retweet count) is a **separate dimension** exposed as `min_likes` filter. It answers: "did the audience resonate with this?"

These must NOT be combined because:
- A "yes" tweet with 5,000 likes is low-quality text but high-signal engagement — users might want it
- A long essay with 3 likes is high-quality text but low engagement — users might want it
- Mixing them creates a muddy score that serves neither use case

### LanceDB is the primary data store

All scope data is served through LanceDB tables. New columns (`content_signal`, `thread_id`) must be included in the scope materialization so they're queryable in Lance. Filtered vector search, FTS, and column filters all go through Lance.

### Python execution

Always use `uv run python3` for running scripts (never bare `python` or `python3`). The Hono API spawns Python jobs via `getPythonPrefix()` which returns `["uv", "run", "python3"]`.

---

## Key Files to Modify (Phases 1, 2, 4a only)

| File | Phase | Changes |
|---|---|---|
| `latentscope/scripts/embed.py` | 1a, 1b | Quote text concatenation, cross-user reply text concatenation, context_resolver architecture |
| `latentscope/importers/twitter.py` | 1c | Content signal scoring (text-based only) |
| `latentscope/scripts/twitter_import.py` | 1c | Pass-through for content_signal column |
| `latentscope/scripts/cluster.py` | 2a, 2b | Weighted HDBSCAN, thread-coherent post-processing |
| `latentscope/pipeline/scope_runner.py` | 2b | Thread_id column in scope materialization |
| `web/src/contexts/FilterContext.jsx` | 4a | Content quality filter slot, min_likes filter |
| `web/src/components/Explore/V2/DeckGLScatter.jsx` | 4a | Signal-based point sizing/opacity |

## Codex Review Findings (gpt-5.3-codex, high reasoning)

### Hard Blockers

1. **`sample_weight` doesn't exist in HDBSCAN** — Phase 2a as written will fail at runtime. The `hdbscan` package's `fit_predict()` does not accept a `sample_weight` parameter. Need an alternative weighting strategy. See "Open Questions" below.

2. **Cross-user reply parents are NOT in the visakanv-2024 dataset** — Checked the actual data: **0 cross-user replies have their parent tweet in-dataset**. The `quoted_status_id` column is also effectively empty (`"None"` strings). Dataset-only enrichment (1a, 1b) will have **near-zero impact** without an external context resolver (community archive API or similar). This is the biggest plan-to-impact gap.

### Must-Fix Before Implementation

3. **Serving columns contract** — `latentscope/pipeline/contracts/scope_input.py:13` allowlists serving columns. `content_signal` and `thread_id` will be **silently dropped** during scope materialization (`scope_materialize.py:84` filters to `SERVING_COLUMNS`) unless we update the contract.

4. **ID null handling** — `_normalize_tweet_id()` in `embed.py:27` doesn't handle `"None"`, `"nan"` string sentinels as null. `build_links_graph.py:41` already fixed this pattern but embed.py hasn't. Must fix before enrichment or resolver logic will misfire.

### Important Design Gaps

5. **Token budget for concatenated text** — Concatenating quoted+reply text could exceed Voyage's 32K per-group token limit. Current code (`embed.py:252`) only drops context-only prefix chunks on oversize, not oversized real chunks. Need a truncation/fallback policy for concatenated strings.

6. **Concatenation edge cases not specified** — Missing rules for:
   - Ordering when a tweet is BOTH a reply AND a quote
   - Deduplication when parent text == quoted text
   - Circular/self-quote protection
   - Guard against recursive enrichment (must use raw/base text, not already-enriched text)

7. **Content signal heuristics too coarse** — Length-heavy scoring overrates URL-expanded text (long URLs inflate char count) and underrates short but substantive tweets. Also: `note_tweet` detection should check `note_tweet_id` field (`importers/twitter.py:411`), not just `tweet_type`, because merged note-tweets retain `tweet` type.

8. **Thread coherence over-merging risk** — Long threads that shift topics mid-thread will have minority tweets forced into the wrong cluster. Need safeguards: minimum thread length threshold, margin requirement, or only reassign low-confidence members.

### Open Questions

- **HDBSCAN weighting alternative**: RESOLVED — Two-Phase Clustering (see Phase 2a). Cluster high-signal only, then assign low-signal to nearest centroid.
- **External context resolver**: What API/source provides cross-user parent tweet text? Community archive? Cached fetch? This is required for Phase 1b to have any impact on visakanv-2024.
- **Quote tweet text source**: `quoted_status_id` is empty strings/"None" in the dataset. Where does the quoted text actually live in a Twitter archive? May need to extract from URL entities or the archive's quote structure.

---

## Verification

1. **Content signal eval**: Sample 20 tweets per score bucket, print with scores, manually validate heuristics make sense before using downstream
2. **Embedding enrichment**: Re-embed visakanv-2024 with quote/reply concatenation, compare UMAP topology visually
3. **Clustering**: Compare noise rate (currently 47%) before and after weighted HDBSCAN — target <25%
4. **Thread coherence**: Find the 79-tweet essay thread, verify all tweets land in one cluster
5. **Frontend**: Test content quality slider and min_likes filter independently at localhost:5173
6. **LanceDB**: Verify new columns (content_signal, thread_id) are queryable in scope table
7. **Regression**: Ensure the pipeline still works for non-Twitter datasets (no thread columns → graceful fallback)
