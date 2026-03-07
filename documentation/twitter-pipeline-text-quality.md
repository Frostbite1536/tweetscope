# Twitter Pipeline Text Quality Design (CA + Native)

Last updated: 2026-02-20

## TL;DR

We had two different truths:

1. The **raw Community Archive blob** has rich URL entities (`url`, `expanded_url`, `display_url`, `indices`) and can support deterministic `t.co` replacement.
2. Some of our ingest paths were **flattening that away** before import, so embeddings/labels still saw unresolved `t.co`.

This doc defines the current shapes, the gaps, fixes, and how to verify them.

## What We Verified Live

### 1) CA Supabase `tweets` table (DB API)

For `visakanv` (`account_id=16884623`), the public DB `tweets` endpoint currently returns a thin schema:

- `tweet_id`
- `full_text`
- `reply_to_tweet_id`
- `reply_to_user_id`
- `reply_to_username`
- counts/time columns (`favorite_count`, `retweet_count`, `created_at`, etc.)

It does **not** expose full entity JSON in this route.

Implication: DB API alone is not enough for reliable inline `t.co` replacement.

### 2) CA blob archive JSON

`https://fabxmporizzqflnftavs.supabase.co/storage/v1/object/public/archives/visakanv/archive.json`

Top-level sections include:

- `account`
- `profile`
- `tweets`
- `community-tweet`
- `note-tweet`
- `like`
- `follower`, `following`
- `upload-options`

`tweets[].tweet.entities.urls[]` and `extended_entities.media[]` include the fields we need:

- `url` (the `t.co` token in text)
- `expanded_url`
- `display_url`
- `indices`

Implication: blob archive is the high-fidelity source for text normalization.

## Current Pipeline Inputs (And Where Quality Can Be Lost)

### Path A: Raw CA username import (`--source community`)

- Fetches blob archive directly.
- Importer can now use full entity metadata for replacement.
- Best path for text fidelity.

### Path B: Browser-extracted payload (`--source community_json`)

- Uses `web/src/lib/twitterArchiveParser.js`.
- Previously, this reduced URL/media entities to expanded-only fields, dropping `url` + `indices`.
- Without `url` + `indices`, importer cannot reliably replace inline `t.co`.

### Path C: Flattened helper JSONs (example: `tools/twitter/visakanv_tweets_2024.json`)

- Flat schema (`id`, `text`, etc.), often no entity arrays at all.
- Strongly lossy for normalization.

## Why You Saw `t.co` In Practice

In `visakanv-2024/input.parquet` right now:

- rows: `14,989`
- rows with `t.co` in `text`: `5,405` (`36.06%`)

This dataset was imported from a shape that did not retain full URL entity mapping.

## Labeling: What Happens Now

Cluster labeling (`latentscope/scripts/toponymy_labels.py`) reads:

- `scope.dataset.text_column` from `scopes/<scope>.json`
- then pulls that column from `input.parquet`

So labeling quality is only as good as the stored text column.

Important: current local label parquet/json artifacts do not currently contain `t.co` in cluster label strings; the unresolved links are still present mainly in row text inputs.

## Fixes Implemented

### 1) Importer text normalization (Phase A core)

In `latentscope/importers/twitter.py`:

- HTML decode (`html.unescape`)
- richer `url_entities_json` capture
- deterministic `t.co` replacement (indices-first, fallback literal)
- media placeholder replacement with full media URL target
- preserve `text_raw` alongside normalized `text`

### 2) Raw CA note-tweet parity

`load_community_archive_raw` now:

- builds note-tweet lookup
- merges matched note text into tweet rows
- keeps unmatched note-tweets as standalone rows

This aligns raw CA behavior with native zip behavior.

### 3) Browser extractor shape fix

In `web/src/lib/twitterArchiveParser.js` we now preserve URL/media fields needed for replacement:

- URL: `url`, `expanded_url`, `display_url`, `indices`
- media: `url`, `expanded_url`, `display_url`, `indices`, `media_url_https`, `media_url`, `type`

This prevents dropping required metadata before Python import.

## Data Layers Affected

1. `input.parquet`
- Directly affected. New/updated text normalization outcomes and additional columns like `text_raw`/`url_entities_json`.

2. `meta.json`
- Affected indirectly via schema/column metadata updates.

3. `embeddings/*.h5` + `embeddings/*.json`
- Must be regenerated after text normalization changes.

4. `umaps/*`
- Must be regenerated after embedding refresh.

5. `clusters/*` and `toponymy-*`
- Must be regenerated after UMAP/cluster refresh.

6. `scopes/*`
- Must be regenerated for updated cluster labels and serving state.

7. LanceDB primary scope tables (`{dataset}__<scope_uid>`)
- Refreshed when scope export is rerun.

8. Audit parquet outputs
- Affected if they read `input.parquet` text columns.

9. Links graph parquet/Lance (`edges`, `node_stats`)
- Not schema-blocked by this change, but recommended to rebuild for consistency if scope is rebuilt.

## What We Do Right Now vs Proposed

### Right now

- Importer can normalize well **if entity metadata survives ingest**.
- Some datasets were imported from lossy shapes, so `t.co` still remains in stored text.

### Proposed operational default

1. Prefer `--source community` (raw blob) for CA imports.
2. If using browser-extracted JSON, ensure parser version includes entity metadata preservation.
3. Re-import stale datasets that were built from lossy shapes.
4. Re-run pipeline artifacts (embed -> umap -> cluster -> scope -> labels).

## Verification Checklist (Base Assumptions + Edge Cases)

### A) Shape verification

1. DB API schema check:
- confirm `tweets` endpoint fields do not include full entity maps.

2. Blob schema check:
- confirm `tweets[].tweet.entities.urls[].url/expanded_url/indices` exist.

### B) Import verification

1. Run a small CA import slice (or sample file).
2. Validate:
- `text_raw` contains original `t.co` tokens where present.
- `text` has replaced expanded/media URLs when entities include token+indices.
- `url_entities_json` is populated.

### C) Regression checks

1. Replies with mention chains still preserve meaning.
2. Media-only tweets do not become empty.
3. Note-tweet merge:
- matched notes update parent tweet text.
- unmatched notes remain rows.

### D) End-to-end quality checks

1. Compare `% rows containing t.co` before/after import.
2. Re-run embeddings + labels.
3. Spot-check clusters that were previously URL-heavy.

## Recommended Next Step For `visakanv-2024`

1. Re-import from raw CA (`--source community --username visakanv --year 2024`) using current code.
2. Re-run pipeline with `voyage-context-3`.
3. Compare:
- `input.parquet` `t.co` incidence
- cluster cohesion and label quality
- scope/Lance outputs after refresh.

