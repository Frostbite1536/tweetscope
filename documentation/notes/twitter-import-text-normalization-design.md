# Twitter Import Text Normalization Design (Embeddings + Labels)

## Why this doc exists

We currently import Twitter/X data correctly for storage and graph edges, but we do **not** normalize/expand text enough before embeddings and Toponymy labeling.  
This leaves a lot of semantic signal on the table (especially URL-heavy and quote-heavy tweets).

This doc explains:

1. The current import pipeline for both native exports and community archives.
2. The current data shape at each step.
3. Where link resolution happens today.
4. What is missing for embeddings and label generation.
5. A concrete improvement plan.

## Current pipeline (simple view)

### Path A: Native X export zip (`archives/my-twitter-archive.zip`)

1. Frontend reads zip locally (`web/src/lib/twitterArchiveParser.js`).
2. Frontend extracts a reduced JSON payload:
   - `archive_format: x_native_extracted_v1`
   - `profile`
   - `tweets`
   - `likes`
3. Frontend uploads extracted JSON (`source_type=community_json`) to `/api/jobs/import_twitter`.
4. API validates payload shape (`api/src/routes/jobs.ts`).
5. Python import script loads extracted JSON (`latentscope/scripts/twitter_import.py` -> `load_community_extracted_json`).
6. Rows are flattened and written to `input.parquet`.
7. Optional pipeline runs: `embed -> umap -> cluster -> scope -> labels`, then optional links graph.

### Path B: Community archive username (CA raw)

1. User submits `username` (`source_type=community`).
2. Python fetches `archive.json` from CA blob storage (`fetch_community_archive`).
3. Raw CA JSON is flattened (`load_community_archive_raw`).
4. Rows are written/upserted to `input.parquet`.
5. Optional pipeline runs as above.

## Current normalized row shape (`input.parquet`)

Importer writes these tweet-centric columns (plus `ls_index`):

- Identity: `id`, `tweet_type`, `archive_source`
- Text/time: `text`, `created_at`, `created_at_raw`
- Author: `username`, `display_name`
- Engagement: `favorites`, `retweets`, `replies`
- Reply/quote fields: `in_reply_to_status_id`, `in_reply_to_screen_name`, `quoted_status_id`, `conversation_id`
- Flags: `is_reply`, `is_retweet`, `is_like`
- Links/media: `urls_json`, `media_urls_json`
- Note support: `note_tweet_id`

Important: `urls_json` stores only a list of expanded URLs, not full entity mapping.

## How link resolution works today

### Import-time

- We keep tweet text as-is (`text`).
- We extract expanded URLs into `urls_json`.
- We do **not** replace `t.co` text in `text` before embeddings.
- We do **not** append quoted tweet text into `text`, even when quoted tweet is present in dataset.

### Graph-time (`build_links_graph.py`)

- Reply edges: from `in_reply_to_status_id`.
- Quote edges:
  - first from `quoted_status_id` if present
  - fallback by parsing status URLs from `urls_json`.

This is good for graph edges, but those edges are built after ingest and are not used to enrich embedding text.

### Render-time (frontend URL resolver)

- UI does lazy URL resolution on visible cards (`web/src/lib/urlResolver.js`).
- This helps display media/quote embeds, but happens too late for embeddings/labels.
- Current TS route (`api/src/routes/resolve-url.ts`) returns `{ urls: [{ original, resolved }] }`, while frontend resolver expects `data.results` with type/media classification. This is a separate runtime mismatch to fix, but it still does not help embedding-time text quality.

## What is hard about Twitter text for embeddings/labels

1. `t.co` placeholders hide semantic targets.
2. Replies often start with long `@mention` chains.
3. Quote semantics often live in linked tweet, not author text.
4. Community archives often miss `quoted_status_id`/`conversation_id`.
5. Note tweets can be split/truncated artifacts.
6. URL-only or very short tweets are weak standalone embedding inputs.

## Cluster label generation input (current state)

This is the current Toponymy path used by `latentscope/scripts/toponymy_labels.py`:

1. Load scope metadata (`scopes/<scope_id>.json`) to get `embedding_id`, `umap_id`, `cluster_id`, and dataset `text_column`.
2. Load `input.parquet` and read **all rows** from `text_column` into `texts`.
3. Load embedding vectors from `embeddings/<embedding_id>.h5`.
4. Load clustering vectors from clustering UMAP (`dim_*`) if present, else display UMAP `x,y`.
5. Build Toponymy prompts from:
   - exemplar texts sampled from `texts` (raw tweet text from input column),
   - keyphrases extracted from the same `texts`,
   - subtopics/topic names from lower layers.
6. Send prompts to LLM topic naming wrappers (OpenAI/Anthropic/etc).

Important implications:

- If `text_column` is `text` (current default), Toponymy sees unnormalized tweet text.
- It does not automatically pull quoted/reply target tweet text unless we inject it into a normalized text column first.
- It does not use frontend URL resolution.
- Prompt exemplars are sampled, not full-cluster raw dumps.

### What embedding sees today

`latentscope/scripts/embed.py` currently applies only minimal prep:

- null/empty -> `" "`
- prepend optional prefix
- no URL expansion
- no HTML entity decode
- no quote-text injection

So both embeddings and Toponymy labels are currently built from the same raw tweet text quality level.

## Concrete text artifacts we should fix

1. `t.co` links remain inline in `text` even though expanded URLs are available in archive entities.
2. HTML entities (`&amp;`, `&lt;`, `&gt;`, numeric entities) are preserved in stored text.
3. Quote-only tweets can be semantically empty unless we inject quoted content.
4. Reply tweets can be under-specified without parent context.
5. Retweet text is often truncated (`RT @user: ...`) and may be replaceable when original exists.
6. Trailing media-link placeholders can add noise when they only point to attached media.

## Evidence from local data in this repo

### Native export (`archives/my-twitter-archive.zip`) via importer

- Tweets: `2161`
- Likes: `7767`
- Tweet rows with `t.co` in text: `1007`
- Tweet rows with non-empty `quoted_status_id`: `0`

### Loaded CA dataset (`visakanv-2024/input.parquet`)

- Rows: `14989` (all `tweet`)
- `quoted_status_id`: effectively empty across dataset
- `conversation_id`: effectively empty across dataset
- Rows with `t.co` in text: `5405`
- Rows with status URLs in `urls_json`: `3717`
- Rows where status URL points to another tweet inside dataset: `292`

This means we have internal quote context available but currently unused in embedding/label text.

### CA raw archive content (`fetch_community_archive("visakanv")`)

- Contains `note-tweet` entries (`362` total; `42` in year 2024).
- Current `community` import path does not merge `note-tweet` into tweet text.
- Fingerprint matching on 2024 data shows those 42 note tweets can be matched/upgraded.

## Main gaps

1. No pre-embedding text normalization step for Twitter.
2. No quote/reply text enrichment even when target text is in dataset.
3. CA raw path ignores note-tweet merge (native path handles it).
4. URL entity detail is lossy (`urls_json` only), making deterministic text replacement harder.

## Data layers affected (explicitly)

Below is the impact by storage/artifact layer if we implement this design.

### Layer impact matrix

1. `input.parquet` (source-of-truth tabular ingest)
   - **Affected**: yes.
   - Add columns like `text_raw`, `text_embed`, `text_label`, optional `url_entities_json`.
   - This is where normalization/enrichment should live.

2. `meta.json` (dataset metadata + column metadata)
   - **Affected**: yes.
   - New columns appear in `columns` / `column_metadata`.
   - Twitter import should record which text column pipeline used.

3. `embeddings/*.h5` + `embeddings/*.json`
   - **Affected**: yes (regenerate).
   - Any change to embedding input text means new embedding run IDs.

4. `umaps/*` and `clusters/*`
   - **Affected**: yes (regenerate when embeddings change).
   - Cluster assignments and hulls shift with new embedding space.

5. Toponymy label artifacts `clusters/toponymy-*.parquet|json`
   - **Affected**: yes (regenerate).
   - Label prompts depend on tweet text + clusters.

6. Scope serving parquet `scopes/*-input.parquet`
   - **Affected**: mostly indirect.
   - If we keep display `text` unchanged and do not add new serving columns, schema can stay stable.
   - Regenerated scopes will still be needed when cluster/labels change.

7. LanceDB primary scope table (`{dataset}__<scope_uid>`)
   - **Affected**: indirect via scope rebuild/export.
   - If serving schema unchanged, no new columns required; table gets refreshed for new scope.

8. Links parquet (`links/edges.parquet`, `links/node_link_stats.parquet`) and Lance graph tables (`{dataset}__edges`, `{dataset}__node_stats`)
   - **Affected**: optional/partial.
   - Core normalization changes do not require schema change here.
   - If we start using richer URL entity fields for edge extraction, edge counts may improve; artifacts should be rebuilt.

9. Import manifests (`imports/*.json`)
   - **Affected**: recommended.
   - Add normalization metadata (version, enabled enrichers, text column used).

10. Audit/export parquet layers
   - **Affected**: yes for any audit flow reading `input.parquet`; optional for serving exports.
   - Audit tools can inspect raw vs normalized text quality directly if both columns are retained.

### Practical summary

- **Direct schema change**: `input.parquet` (+ `meta.json`).
- **Must regenerate**: embeddings -> UMAP -> clusters -> scopes -> labels (and usually catalog pointers).
- **LanceDB**:
  - primary scope tables refresh because scopes refresh,
  - graph tables only need rebuild if edge extraction logic changes.

## Proposed design

Use a hybrid approach:

1. deterministic per-row normalization during import (fast, local data only),
2. cross-tweet enrichment after import (join by IDs),
3. optional external resolvers later (only if needed).

Important: cross-tweet enrichment should be **embedding-model aware**.  
For `voyageai-voyage-context-3`, prefer passing extra context as context-only chunks instead of rewriting the tweet body.

### 1) Deterministic normalization in importer (per-row)

In `latentscope/importers/twitter.py`:

1. Decode HTML entities in text (`html.unescape`).
2. Preserve rich URL entity metadata (`url_entities_json`) including:
   - `url` (`t.co`), `expanded_url`, `display_url`, `indices`
3. Replace inline `t.co` using entity offsets (right-to-left replacement order):
   - prefer full `expanded_url`; for media placeholders, use media `expanded_url` (e.g. `/photo/1`) when available.
4. Media placeholder cleanup:
   - replace media `t.co` placeholders with full media URL instead of dropping by default.
   - only strip if unresolved and clearly placeholder-only noise.
5. Keep original raw text as `text_raw`; normalized base as `text`.

This gives cleaner text before any embedding/label step and does not require network calls.

### 2) Cross-tweet enrichment stage (post-import, same dataset)

Add a dedicated enrichment pass (new script/stage) that reads `input.parquet` and writes enriched text columns:

- `text_embed` for embeddings
- `text_label` for Toponymy prompts

Use a single in-memory `tweet_id -> row` map for O(n) joins, but apply it differently by embedding mode:

1. For contextual embedding (`voyageai-voyage-context-3`):
   - do **not** prepend parent/quote text directly into the row text by default.
   - extend grouping logic to add internal parent/quote text as context-only chunks where appropriate.
   - keep row-level tweet text semantically clean and avoid duplication from both inline concat + contextual API.
2. For non-contextual embedding models:
   - reply enrichment: if `in_reply_to_status_id` is internal, prepend concise parent context.
   - quote enrichment: if `quoted_status_id` is internal, append quoted tweet text.
   - fallback: derive internal quote target from status URLs in `urls_json`.
3. Retweet enrichment (both modes, optional):
   - if retweeted source text is available (nested archive object or internal match), use/append fuller source text.
4. Mention-chain cleanup:
   - strip only leading reply mention chains for normalized columns, not all mentions.

### 3) Community raw note-tweet parity fix

In `load_community_archive_raw`, apply the same note-tweet merge logic already used for native zip:

- build note lookup tables,
- match by direct id or fingerprint,
- upgrade text + URLs,
- keep unmatched note tweets as rows.

### 4) Pipeline defaults

For Twitter imports:

- embed default text column: `text_embed` (fallback `text`)
- Toponymy default text column: `text_label` (fallback `text_embed`, then `text`)

For `voyageai-voyage-context-3` specifically:

- prioritize context-chunk enrichment in `embed.py` grouping over aggressive inline text concatenation.
- keep text concatenation policies conservative to avoid double-counting context.

Non-Twitter datasets keep current behavior.

### 5) Optional future: resolver chain for external coverage

If needed later, add a pluggable resolver chain for missing quote/reply targets:

- local dataset resolver (default),
- archive-object resolver (nested quoted/retweeted objects),
- optional community archive resolver,
- optional X API resolver with strict rate/budget limits.

This should be optional; core quality gains do not depend on external fetches.

## Improvement priority

| Improvement | Embedding impact | Label impact | Complexity |
|---|---|---|---|
| t.co replacement + entity mapping | High | High | Low |
| internal quote/reply enrichment | High | High | Medium |
| HTML entity decode | Medium | Medium | Very low |
| media placeholder replacement (full media URL) | Medium | Medium | Low |
| retweet full-text recovery | Low-Med | Low-Med | Medium |
| external resolver chain | Optional | Optional | High |

## Implementation map (files)

- `latentscope/importers/twitter.py`
  - URL entity capture (`display_url`, `indices`, etc.)
  - HTML decode
  - deterministic URL/media text cleanup
  - community raw note-tweet merge parity
- `latentscope/scripts/twitter_import.py`
  - invoke enrichment stage before embed/toponymy
  - default Twitter text column routing (`text_embed` / `text_label`)
- `latentscope/scripts/embed.py`
  - consume normalized text column
  - contextual mode: carry parent/quote context via context-only chunks (not only inline text)
- `latentscope/scripts/toponymy_labels.py`
  - consume normalized label text column
- `latentscope/scripts/twitter_text_enrich.py` (new)
  - post-import reply/quote/retweet enrichment into `text_embed`/`text_label`

## Rollout plan

1. Phase A (quick wins)
   - HTML decode
   - URL entity capture
   - t.co replacement
   - media placeholder replacement (full media URL)
2. Phase B (local semantic enrichment)
   - add `text_embed`/`text_label`
   - internal reply/quote enrichment
   - retweet recovery where available
   - community raw note-tweet parity
3. Phase C (switch defaults + backfill)
   - use enriched columns by default in embed/toponymy
   - regenerate embeddings -> UMAP -> clusters -> scopes -> labels
   - optional external resolver support later

## Tests to add

1. Import normalization tests
   - HTML decode
   - t.co replacement with `indices` ordering
   - media placeholder replacement
2. Community raw note-tweet parity test
3. Enrichment tests
   - internal reply context
   - internal quote context (native id and URL-derived id paths)
   - retweet source enrichment
   - contextual embedding mode: context-only chunk injection without mutating base tweet text
4. Pipeline integration
   - Twitter import with `--run_pipeline` uses enriched text columns for embed + Toponymy.

## Expected impact

1. Cleaner semantic inputs to both embedding and topic naming.
2. Fewer empty/low-information vectors for quote/reply-heavy timelines.
3. Better cluster coherence and more specific labels.
4. Consistent behavior across native zip and community archive paths.
