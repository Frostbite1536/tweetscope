# Cluster Labeling And Toponymy Design

Date: 2026-03-05

## Purpose

This document explains how cluster labels are generated and used today, what parts of the web app depend on them, what the current Toponymy methodology is actually doing, why the current settings break down on large tweet corpora, and what should change.

The intended audience is someone making product and pipeline decisions, not just someone changing a single script.

The main product goal is:

- make a tweet corpus easy to browse semantically
- surface useful topic labels on the map and in sidebars
- preserve important thread-level ideas, not just isolated tweets
- work smoothly from small datasets (`~2k`) to large ones (`~300k`)

This is not a real-time system. Offline and precomputed work is acceptable. Label quality matters more than lowest possible cost.

One important current assumption in this repo is that the embedding pipeline uses Voyage contextual embeddings, specifically `voyage-context-3`. See:

- `documentation/voyage-context.md`
- `latentscope/scripts/embed.py`
- `latentscope/models/providers/voyageai.py`

That matters because any labeling design should stay consistent with the fact that upstream semantic structure is already partly thread-aware.

## Status Note

This document started as a design note for a system where Toponymy still handled both:

- structural clustering
- label generation

That is no longer the target architecture.

As of the current implementation direction:

- canonical structure is built upstream with `PLSCAN`
- that structure is saved as a hierarchy artifact
- Toponymy is naming-only on top of that saved structure
- hierarchical scope generation no longer depends on the old flat `cluster.py` pass

So this document now has two kinds of content:

### Still relevant

- web app business logic and actual label usage
- thread-specific product requirements
- calibration against `visakanv`, `defenderofbasic`, and `ivanvendrov-tweets`
- naming-side problems: context, exemplars, prompt design, keyphrases, specificity, duplicates
- coverage and `unknown` analysis

### Superseded by the PLSCAN cutover

- recommendations that assume `ToponymyClusterer` is the long-term structural engine
- advice to tune `min_clusters`, `next_cluster_size_quantile`, or `max_layers` on Toponymy as the primary production structure controls
- arguments that depend on the old “flat cluster first, Toponymy recluster later” architecture
- keeping legacy Toponymy structural params in the normal production labeling path after Option C is adopted

Where this doc discusses `base_n_clusters`, it should now be read as a hierarchy-builder concern first, not a Toponymy concern.
Where this doc cites `visakanv` numbers like `4874` leaf topics or `56.47%` `unknown`, those are best read as the pre-PLSCAN baseline we are replacing, not as a target steady state.

## Executive Summary

The old integration was not wrong in spirit, but it mixed structure and naming in the wrong place.

The current direction is:

- `PLSCAN` builds one canonical hierarchy upstream
- Toponymy names that hierarchy
- the web app consumes the resulting labeled hierarchy directly
- the production naming path should no longer accept old Toponymy structural controls like `min_clusters` or `next_cluster_size_quantile`

That resolves the biggest architectural problem: two competing cluster systems for the same dataset.

What remains to optimize is no longer “which structural clustering should Toponymy rerun?” It is:

- how to tune the canonical hierarchy for browse quality
- how to improve naming usefulness and thread-awareness on top of that hierarchy

The biggest problems are:

- the hierarchy policy is still not calibrated enough for tweet corpora across scales
- the naming path is less context-aware than the embedding path, even though upstream embeddings already use contextual thread grouping
- `unknown` is large enough to reduce topic coverage, and it includes many non-noise points
- hierarchy correctness problems are large enough that the web app ends up treating many detached nodes as roots
- at any given viewport the map only places a bounded label set, so very high leaf-topic counts only help if zoom reveals them as stable, distinct local topics

Under the new architecture, the primary structural knobs are:

- `hierarchy_min_samples`
- `hierarchy_max_layers`
- `hierarchy_base_min_cluster_size`
- `hierarchy_base_n_clusters`
- `hierarchy_layer_similarity_threshold`
- `hierarchy_reproducible`

The primary naming knobs are:

- `toponymy_provider`
- `toponymy_model`
- `toponymy_context`
- `toponymy_adaptive_exemplars`
- `max_concurrent_requests`

That separation matters because structural tuning and naming tuning should now be evaluated independently.

For the active `visakanv` run, the evidence is clear:

- dataset size: `259,083` tweets
- active scope: `scopes-001`
- active labels: `toponymy-001`
- baseline structural settings on that old run: `min_clusters=2`, `base_min_cluster_size=10`
- output hierarchy: `7` layers
- layer-0 topics: `4,874`
- median layer-0 topic size: `17`
- layer-0 topics with fewer than `20` tweets: `59.31%`
- scope rows assigned to `unknown`: `146,315` (`56.47%`)
- `unknown` rows that are not raw noise: `26,118`
- orphan-node warnings in the Toponymy run log: `3301`

This is over-fragmented, under-covered, and structurally unreliable for the current UX.

## Product And Business Logic

### What the product is trying to do

The app is not just a scatterplot. It is a semantic browser for an author or dataset:

- overview the corpus spatially
- zoom into increasingly specific themes
- click labels to filter into a topic and all its descendants
- browse top-level topics in a directory or carousel
- pivot into thread-specific exploration
- use engagement and hierarchy to rank what appears first

This matters because the right labeling policy is the one that improves human navigation, not the one that maximizes the number of clusters.

### Why labels matter to the UX

Labels are used in several distinct ways:

- on-map topic labels in `web/src/components/Explore/V2/DeckGLScatter.jsx`
- hierarchy and root sorting in `web/src/contexts/ScopeContext.tsx`
- descendant-inclusive cluster filtering in `web/src/hooks/useClusterFilter.js`
- topic directory cards and searches in `web/src/components/Explore/V2/TopicDirectory/TopicDirectory.jsx` and `web/src/hooks/useTopicDirectoryData.js`
- carousel columns in `web/src/hooks/useCarouselData.js`

The important UI consequences are:

- the map selects one hierarchy cut based on zoom; it does not show every layer at once
- labels are collision-managed and only a limited subset can be placed in a viewport
- label priority is based on cumulative count, cumulative likes, and a penalty for `unknown`
- top-level topic browsing assumes the hierarchy roots are meaningful
- clicking a topic means "this cluster and all descendants"

This means label usefulness is determined by structure as much as by wording.

### Thread-specific business logic

Threads are not an edge case in this product. They are a first-class browsing mode.

Relevant files:

- `web/src/hooks/useNodeStats.ts`
- `web/src/contexts/FilterContext.jsx`
- `web/src/lib/groupRowsByThread.js`
- `web/src/hooks/useThreadCarouselData.js`

The web app already treats thread membership as meaningful:

- it builds a thread-membership mask from link stats
- it supports a `Threads only` filter
- it groups visible rows into thread bundles when safe
- it has a dedicated thread carousel

But label generation does not currently use thread structure in a comparable way.

`latentscope/util/text_enrichment.py` only enriches a tweet with referenced tweet text discovered from status URLs. It does not:

- enrich with reply-chain context
- use `conversation_id`
- use node stats like `thread_root_id` or `thread_depth`
- treat long-ish self-reply chains as meaningful semantic units

For this product, that is a real mismatch. Long threads often express one coherent idea across multiple tweets. If labeling sees only tweet fragments, the thread theme gets diluted or split.

## Key Files

### Web app files

`web/src/contexts/ScopeContext.tsx`

- loads scope metadata and scope rows
- builds `clusterMap`, `clusterLabels`, and `clusterHierarchy`
- aggregates cluster counts and likes upward through the hierarchy
- sorts roots and children by cumulative likes then cumulative count

`web/src/components/Explore/V2/DeckGLScatter.jsx`

- renders points, labels, hulls, and graph edges
- chooses a single hierarchy cut based on zoom
- prioritizes labels by cumulative count, likes, and layer
- does deterministic label placement with collision boxes and a small soft-label fallback
- hides labels whose hull is fully hidden by thread filtering

`web/src/components/Explore/V2/VisualizationPane.jsx`

- turns filters and time range into visible or hidden points
- hides deleted rows entirely
- disables edges by default for scopes above `10k` rows
- wires hover, filter-to-topic, thread view, quotes, and timeline controls

`web/src/contexts/FilterContext.jsx`

- composes cluster, semantic search, keyword, column, time-range, engagement, and thread filters
- cluster filtering is intersected with other active filters
- builds the thread-membership mask and exposes the `Threads only` toggle

`web/src/hooks/useClusterFilter.js`

- includes descendants recursively
- enforces the business rule that selecting a topic means selecting its subtree

`web/src/hooks/useTopicDirectoryData.js`

- treats top-level hierarchy roots as browseable topic cards
- builds per-root feeds
- optionally applies subtopic and thread-membership filtering

`web/src/hooks/useCarouselData.js`

- loads nearby top-level clusters lazily for the expanded carousel
- applies subtopic and thread-membership filtering inside each column

### Labeling and pipeline files

`latentscope/scripts/toponymy_labels.py`

- main Toponymy labeling entry point
- loads texts, embeddings, and display UMAP
- loads a precomputed hierarchy when available
- runs Toponymy fit in naming-only mode against that hierarchy
- runs audit-based relabeling
- extracts hierarchical labels and saves parquet plus JSON metadata

`latentscope/scripts/build_hierarchy.py`

- builds the canonical hierarchy artifact from the clustering manifold
- currently uses `PLSCAN`
- persists layer label arrays, cluster tree, persistence signals, and lineage metadata

`latentscope/pipeline/hierarchy.py`

- saves and loads hierarchy artifacts
- provides the precomputed-structure adapter that lets Toponymy skip reclustering

`latentscope/scripts/embed.py`

- builds corpus embeddings before clustering
- for contextual models like `voyage-context-3`, groups self-reply threads into ordered chunk groups
- adds limited parent-context when a self-thread begins as a reply to another in-dataset tweet
- writes metadata that records contextual embedding stats

`latentscope/pipeline/stages/scope_labels.py`

- converts cluster-label parquet into the `cluster_labels_lookup` served to the app
- computes hierarchical lookup
- appends the explicit `unknown` cluster
- maps point indices to layer-0 topic labels

`latentscope/scripts/twitter_import.py`

- wires the canonical hierarchy builder and Toponymy naming into the import pipeline
- carries the structural builder defaults and naming defaults separately
- contains the cache-match logic for reusing previous label runs

### Toponymy library files

`toponymy/toponymy/clustering.py`

- legacy structural path that Toponymy can still use in debug/manual runs
- no longer the intended production source of hierarchy structure

`toponymy/toponymy/cluster_layer.py`

- determines per-layer exemplar and keyphrase budgets
- builds prompts
- generates names
- runs disambiguation

`toponymy/toponymy/audit.py`

- flags clusters for relabeling based on duplicates, specificity, and keyphrase alignment
- reruns naming on flagged clusters

`toponymy/toponymy/keyphrases.py`

- builds the keyphrase matrix
- current defaults are general-purpose, not tweet-specific

`toponymy/toponymy/prompt_construction.py`

- builds naming prompts
- currently includes a skip path that can reuse a single child label for a parent

## Current Methodology

### Current input objects

The current system has two different kinds of context:

1. embedding-time context
2. labeling-time context

That distinction is important.

At embedding time, the pipeline already uses `voyage-context-3` and groups self-reply threads into contextual chunk groups. This means the vectors used for clustering can already reflect thread-local context.

At labeling time, `latentscope/scripts/toponymy_labels.py` loads row texts again and applies reference enrichment from `latentscope/util/text_enrichment.py`, but it does not fully mirror the contextual grouping logic from `embed.py`.

So the effective labeling object is still mostly the individual tweet row, even though the upstream embeddings may be richer than that.

The script:

1. loads `input.parquet`
2. enriches tweet text with referenced-tweet text when a tweet links to another tweet in the dataset
3. loads embedding vectors
4. loads the precomputed hierarchy artifact when available; only reclusters in legacy/debug mode
5. loads the clustering manifold or display UMAP only for structure-aware prompt inputs and diagnostics
6. uses LLM prompts to name topics
7. builds hierarchy metadata and assigns each point to the deepest surviving topic when possible

The critical limitation is not that the whole system is context-agnostic. It is that the naming path is less context-aware than the embedding path.

Today:

- embedding is contextualized with `voyage-context-3`
- Toponymy naming text is only partially contextualized

That mismatch makes labels weaker than the cluster geometry deserves.

### Current relevant settings

These are the settings that matter operationally under the PLSCAN + naming-only architecture.

Structural settings:

`hierarchy_min_samples`

- current import default: `5`
- simple meaning: local density sensitivity for the underlying mutual-reachability graph
- practical effect: lower values create more permissive fine structure; higher values suppress weaker local clusters

`hierarchy_max_layers`

- current import default: `10`
- simple meaning: hard cap on how many persistent layers PLSCAN may keep
- practical effect: this should usually be reduced for product use, because the app wants a few meaningful browse levels rather than every possible abstraction layer

`hierarchy_base_min_cluster_size`

- current import default: `10`
- simple meaning: density-oriented base resolution for the finest layer when we do not specify a target leaf count
- practical effect: still useful as a coarse fallback, but it should not be the main product policy axis once `hierarchy_base_n_clusters` is calibrated

`hierarchy_base_n_clusters`

- current import default: `None`
- simple meaning: ask PLSCAN for an approximate number of clusters in the finest base layer
- exact implementation meaning in the pinned `fast_hdbscan` code:
  - build the Boruvka MST once
  - binary-search `min_cluster_size` on the uncondensed tree until the base layer is close to the requested cluster count
  - then derive coarser persistent layers from that base condensed tree
- practical effect: this is the most direct structural knob for browse cardinality, which is why it matters for the product even though PLSCAN later selects coarser layers by persistence

`hierarchy_layer_similarity_threshold`

- current import default: `0.2`
- simple meaning: how different two persistence peaks must be before both are kept as separate hierarchy layers
- practical effect: lower values keep more similar layers; higher values force stronger separation between browse levels

`hierarchy_reproducible`

- current import default: `False`
- simple meaning: favor reproducibility over raw speed in the underlying `fast_hdbscan` path
- practical effect: useful for benchmark/regression runs, less important for routine offline iteration

One important lineage rule under the new architecture:

- hierarchy reuse should key on embedding lineage plus the clustering manifold and hierarchy params
- it should not depend on the display `2D` UMAP, because that map is a rendering projection, not the source of structure

Naming settings:

`toponymy_adaptive_exemplars`

- current script default: `True`
- simple meaning: exemplar and keyphrase budgets change based on median cluster size for the layer
- current layer behavior in `cluster_layer.py`:
  - median size `< 50`: `8` exemplars, `12` keyphrases
  - median size `< 200`: `16` exemplars, `20` keyphrases
  - else: `24` exemplars, `28` keyphrases

Interaction with coarser clustering: with fewer, larger leaf clusters, within-layer size variance increases. The current layer-wide policy (based on median cluster size) may under-serve small clusters in a layer dominated by large ones. Per-cluster exemplar scaling should be considered as a follow-up once the base granularity change is validated.

`max_concurrent_requests`

- current script default: `25`
- simple meaning: cap on in-flight async LLM requests
- practical effect: mostly a throughput knob, not a quality knob

Legacy structural settings still visible in old label metadata:

- `min_clusters`
- `base_min_cluster_size`
- `next_cluster_size_quantile`

These describe the old `ToponymyClusterer` path and are now mainly useful for interpreting historical runs like `toponymy-001`, not for the intended production structure. In the codebase, they should be removed from the normal Toponymy labeling entrypoint to avoid implying that Toponymy still owns structure.

Audit thresholds in `toponymy/toponymy/audit.py`

- `duplicate_threshold=0.0`
- `specificity_threshold=0.3`
- `keyphrase_alignment_threshold=0.2`

Simple meaning:

- duplicate threshold: any duplicated names in a layer are considered a problem
- specificity threshold: names that are too vague can be relabeled if specificity exists
- keyphrase alignment threshold: names that do not align with the top keyphrases can be relabeled

Keyphrase builder defaults in `toponymy/toponymy/keyphrases.py`

- `ngram_range=(1, 4)`
- `max_features=50_000`
- `min_occurrences=2`

Simple meaning:

- consider unigrams through four-grams
- keep a very large candidate vocabulary
- keep phrases that appear at least twice

These are generic defaults, not tuned for tweet corpora.

Embedding model baseline

- current import default in `latentscope/scripts/twitter_import.py`: `voyage-context-3`
- simple meaning: related chunks from the same thread can be embedded together so each tweet vector carries sibling context
- practical effect: this is good for tweet corpora, and the labeling methodology should be designed to take advantage of it instead of ignoring it

## Current Baseline: `visakanv`

Active files:

- scope metadata: `~/latent-scope-data/visakanv/scopes/scopes-001.json`
- labels metadata: `~/latent-scope-data/visakanv/clusters/toponymy-001.json`
- labels parquet: `~/latent-scope-data/visakanv/clusters/toponymy-001.parquet`

Observed pre-PLSCAN baseline state:

- rows: `259,083`
- active labels id: `toponymy-001`
- provider/model: `openai / gpt-5-mini`
- `min_clusters=2`
- `base_min_cluster_size=10`
- metadata layer counts before collapse: `[4874, 1238, 275, 68, 20, 5, 2]`
- actual stored non-unknown layer counts after collapse: `{0: 4874, 1: 729, 2: 145, 3: 37, 4: 11, 5: 4, 6: 1}`
- single-child collapses recorded: `681`
- audit stats:
  - flagged before: `3697`
  - relabeled: `3211`
  - flagged after: `3212`
- enriched texts from reference resolution: `34,490`

What this means:

- the current leaf layer is much finer than the current UX seems able to turn into useful browse topics
- the hierarchy still ends in a single top node
- the audit pass is doing a huge amount of corrective work, which is a sign that the first pass is not producing robust names

Coverage and assignment problems:

- `unknown`: `146,315` rows (`56.47%`)
- raw noise rows: `124,569`
- `unknown` rows coming from raw noise: `120,197`
- `unknown` rows coming from non-noise clusters: `26,118`

This last number is especially important. It does not prove that all `26,118` rows deserve a final topic label, but it does show that a large amount of content that earlier clustering treated as non-noise is getting dropped by the final layer-0 assignment path.

Topic granularity problems:

- layer-0 topics: `4,874`
- median layer-0 cluster size: `17`
- layer-0 `p90` size: `40`
- share of layer-0 topics with fewer than `20` tweets: `59.31%`
- median label length: `11` words

For a browsing interface with collision-managed labels, descendant filters, and top-level topic browsing, this is a weak operating point.

Representative leaf-level examples from `visakanv`:

- weak-but-large leaf:
  - label: `Short social media replies expressing affection and gratitude to tagged users`
  - count: `483`
  - sample tweets: mostly `@user` plus emoji acknowledgements
- weak-and-small leaf:
  - label: `Short social media replies and user handle acknowledgements expressing brief emoji reactions`
  - count: `17`
  - sample tweets: mostly single-handle emoji reactions
- good small leaf:
  - label: `Climate catastrophe spy-thriller involving Elon Musk, Mars exile, geopolitics and cults`
  - count: `11`
  - sample tweets: coherent story-development thread fragments

That mix is important. It shows:

- some small leaf clusters are bad because the underlying tweets are bad labeling objects
- some small leaf clusters are genuinely good and should not be merged away just because they are small

## Cross-Dataset Calibration

Two smaller datasets in the data directory show the same patterns:

- `defenderofbasic` (`23,295` rows)
- `ivanvendrov-tweets` (`1,349` rows)

Observed current state:

- `defenderofbasic`
  - unknown ratio: `53.32%`
  - layer counts: `{0: 516, 1: 144, 2: 39, 3: 12, 4: 4}`
  - layer-0 median size: `17`
  - share of layer-0 topics below `20`: `60.47%`
  - UI-root count under current root rule: `304`
- `ivanvendrov-tweets`
  - unknown ratio: `51.15%`
  - layer counts: `{0: 41, 1: 12, 2: 3}`
  - layer-0 median size: `13`
  - share of layer-0 topics below `20`: `80.49%`
  - UI-root count under current root rule: `23`

Two things are clear from that comparison.

First:

- the detached-root / high-unknown pattern is not only a large-dataset problem
- it appears across small, medium, and large runs

Second:

- some small leaf clusters are actually good

Examples from the smaller datasets:

- `defenderofbasic` has coherent leaf topics of size `10` to `17`, such as:
  - voter registration, poll worker oversight, and election security
  - human-AI interaction and prompting skill
  - tribalism, trust dynamics, and social cohesion
- `ivanvendrov-tweets` has coherent leaf topics of size `13`, such as:
  - automation, attention, flow, boredom, and escapism
  - museum observations and historical art commentary

Teen-sized leaf clusters are not inherently too small. They work when tweet text is semantically dense.

The more accurate conclusion is:

- small leaf clusters fail more often in reply-heavy, low-information corpora
- small leaf clusters can work in denser corpora with longer and more coherent tweet text

For these three datasets, the text-density difference is visible:

- `visakanv`: reply ratio `81.44%`, median text length `109`
- `defenderofbasic`: reply ratio `79.17%`, median text length `222`
- `ivanvendrov-tweets`: reply ratio `62.05%`, median text length `157`

So parameter policy should be corpus-aware as well as size-aware.

## Where The Current Design Conflicts With The UX

### 1. Each viewport only shows a limited label set at a time

`DeckGLScatter.jsx` intentionally limits label candidates per viewport and resolves collisions. This is the correct UI behavior.

Important nuance: this does not mean fine labels are useless. Deep zoom absolutely matters in this product.

The real point is narrower:

- the map chooses one hierarchy cut at a time
- it only processes a bounded number of candidate labels per viewport
- those labels still have to survive collision rules

So the pipeline should not optimize for "generate as many tiny topics as possible." Very high leaf-topic counts only help if zoom reveals them as stable, distinct, local topics with good names.

On the current `visakanv` run, the evidence against the present operating point is the combination of:

- `4,874` layer-0 topics
- median topic size `17`
- `59.31%` of layer-0 topics below `20` tweets
- repetitive “short social media replies” style labels
- `56.47%` of rows assigned to `unknown`

The pipeline should optimize for:

- label usefulness
- navigable hierarchy
- low `unknown`
- stable zoom transitions

not raw topic count alone.

### 2. The current hierarchy depth is not caller-controlled enough for the current UX

The map chooses one hierarchy cut from zoom progression. In practice the UI benefits from a small number of meaningful semantic levels:

- macro themes
- subthemes
- fine topics

The issue is not that seven layers are always bad in the abstract. The issue is that the current caller does not set `max_layers`, so the library keeps building layers until it naturally bottoms out. For this app, that mostly adds:

- collapse work
- parent/child correctness risk
- label duplication risk
- single-root endings that do not help navigation

On `visakanv`, the post-collapse hierarchy still has `7` layers and ends in a single top node. That is a weak fit for:

- map-based zoom cuts
- top-level topic directory cards
- carousel root navigation

### 3. The current naming path is not as thread-aware as the embedding path

The product treats thread membership as meaningful during browsing, and the embedding pipeline already uses `voyage-context-3` thread grouping. But the naming path does not reconstruct that same context.

That creates two likely failure modes:

- long threads get split into tweet fragments and produce weak labels
- one long thread can dominate a cluster's exemplars in a noisy way

The right behavior is not "cluster threads instead of tweets" across the board. The right behavior is to make naming and exemplar selection more thread-aware without forcing the serving model to become thread-only.

Because the repo already uses `voyage-context-3`, the issue is not that thread-aware semantics are impossible. The issue is that the Toponymy naming path is lagging behind the embedding path.

### 4. `unknown` currently mixes true leftovers with content users would expect topics to cover

The app explicitly de-prioritizes `unknown` on the map. That is correct.

But if more than half the scope is `unknown`, then the semantic layer is not carrying enough of the product. Topic directory, carousel, and label clicks all become less representative.

This needs nuance:

- much of `unknown` really is weak reply debris or near-noise
- but not all of it is disposable junk

The sampled non-noise `unknown` rows for `visakanv` contain both:

- trivial replies like `@user yes!`, emoji replies, and status/photo-link replies
- substantive tweets and thread members, including longer reflective posts and medium-engagement thread content

The numbers support that mixed picture:

- `26,118` rows are `unknown` even though `raw_cluster != -1`
- `9,041` of those belong to threads of size `>= 3`
- `7,091` belong to threads of size `>= 5`
- `8,546` have reply children

So the problem is not "all unknown content is good." The problem is that the current `unknown` bucket is too coarse and swallows content that should be easier to recover or backfill.

### 5. Hierarchy correctness problems leak directly into the product

The `visakanv` run produced thousands of orphan warnings. The app can still render something, but the browse model becomes unreliable:

- top-level roots may not correspond to true macro topics
- descendants can be wrong
- root-level browse ordering is distorted

In simple terms:

- some labels below the top layer are missing a valid parent
- the UI does not crash
- instead, it treats `no parent` as a reason to consider that node a root

That behavior exists in the current root-building rule in `ScopeContext.tsx`.

On `visakanv`:

- `3302` below-top labels have `null` parent
- under the current UI root rule, that becomes `3303` roots total
- `2763` of those roots are layer-0 labels

That is what "the UI works around broken structure" means: the app still renders, but many detached nodes get promoted to top-level status and the browse model becomes distorted.

Correctness has to be fixed before parameter tuning can be trusted.

## What We Should Do

### 1. Make the hierarchy shallow, bounded, and product-shaped

For tweet exploration, the target hierarchy should usually be:

- layer 0: fine topics
- layer 1: subthemes
- layer 2: macro themes

Optional:

- layer 3 only if it still contains several useful macro groups

Practical recommendation:

- pass `max_layers=3` by default
- allow `4` only for very large corpora if the top layer still contains more than roughly `8` clusters
- keep `hierarchy_layer_similarity_threshold` high enough that adjacent layers are meaningfully different
- validate the final top layer after build; if it collapses to one giant root, stop one layer earlier or tighten the base leaf target

Why this should work:

- it matches how the map reveals hierarchy by zoom
- it matches how topic directory and carousel browse roots
- it avoids a fake single universal root

### 2. Control leaf granularity by target cluster count, not minimum cluster size

Under the new architecture, `base_n_clusters` belongs to the hierarchy builder, not to Toponymy naming.

It is still the preferred conceptual control knob for this product because it directly expresses browse shape:

- how many leaf topics do we want users to navigate at the finest useful level?

That is a better product control than a fixed `base_min_cluster_size`, which only indirectly influences leaf count and changes meaning across corpora.

Cross-dataset evidence shows that leaf clusters in the `10` to `20` range can sometimes produce genuinely useful labels in denser corpora. The right move is not to ban small leaves outright, but to choose a target count based on both corpus size and corpus density:

- reply-heavy corpora with lots of short acknowledgements, emoji replies, or link replies should be pushed toward coarser leaves
- denser corpora with longer and more self-contained tweets can support smaller leaf clusters

The target leaf-topic count should be derived from a corpus-density-aware heuristic, not a single-constant formula.

Recommended primary heuristic:

1. Compute a corpus-density score.

```text
text_density       = clamp((median_text_chars - 120) / 120, 0, 1)
standalone_density = clamp(((1 - reply_ratio) - 0.15) / 0.30, 0, 1)
corpus_density     = 0.65 * text_density + 0.35 * standalone_density
```

Interpretation:

- median text around `120` chars is treated as short
- median text around `240` chars is treated as dense
- standalone ratio near `15%` is treated as very reply-heavy
- standalone ratio near `45%` is treated as much less reply-dominated

2. Convert that density score into a target rows-per-leaf number.

```text
if N <= 5_000:
    rows_per_leaf = lerp(55, 25, corpus_density)
elif N <= 50_000:
    rows_per_leaf = lerp(130, 55, corpus_density)
else:
    rows_per_leaf = lerp(220, 100, corpus_density)
```

Where `lerp(a, b, t) = a + t * (b - a)`.

Interpretation:

- small dense corpora can support leaves as small as roughly `25` rows
- medium corpora should usually land around `55` to `130` rows per leaf
- large reply-heavy corpora should usually land closer to `220` rows per leaf than to `100`

3. Convert that into a target leaf-topic count and clamp by band.

```text
target_leaf_topics = round(N / rows_per_leaf)

if N <= 5_000:
    clamp to 16..200
elif N <= 50_000:
    clamp to 80..500
else:
    clamp to 250..1600
```

This is still heuristic, but it is a much better heuristic because every constant has an interpretable meaning.

Using the current observed dataset statistics, this yields:

- `visakanv` -> about `1205` leaf topics
- `defenderofbasic` -> about `279`
- `ivanvendrov-tweets` -> about `33`

Those numbers are consistent with the product intuition from the label samples.

Use `base_n_clusters` as the primary conceptual leaf control when we need explicit leaf-cardinality targeting.

Why expose it even with `PLSCAN`:

- `PLSCAN` still needs a base resolution from which to discover persistent layers
- `base_min_cluster_size` is a density-oriented proxy
- `base_n_clusters` is a product-oriented target
- the right choice may vary by corpus family

Recommended stance:

- keep `hierarchy_base_min_cluster_size` as the default coarse starting policy for now
- expose `hierarchy_base_n_clusters` for calibration runs and for datasets where leaf-topic count needs tighter control
- decide whether to make it the default only after regenerated runs on `visakanv`, `defenderofbasic`, and `ivanvendrov-tweets`

Implementation note:

- if `hierarchy_base_n_clusters` is too slow in practice for the largest datasets, do not fall back to a magic constant
- instead, cache a dataset-specific mapping from `min_cluster_size` to first-layer cluster count, and warm-start future searches from previous runs

For `visakanv`, this still implies a first pass target around `1200` to `1300` leaf topics, not `4874`.

### 3. Require a useful top layer

The top layer should not collapse to one giant catch-all topic.

Desired top-layer range:

- small datasets: about `8` to `16`
- mid datasets: about `12` to `24`
- large datasets: about `16` to `32`

This is the scale that makes sense for:

- topic directory cards
- carousel table of contents
- overview map labels

If the final layer would have fewer than that, stop one layer earlier.

Sanity check:

- after choosing a leaf target and a top-layer target, compute the implied median branching factor
- with `3` semantic layers, `branching ≈ sqrt(leaf_topics / top_layer_topics)`
- with `4` semantic layers, `branching ≈ cbrt(leaf_topics / top_layer_topics)`

If the implied branching factor is much above about `8`, either:

- lower the leaf target
- or allow one extra layer

This is a better secondary check than a raw `a * sqrt(N)` rule because it is expressed in product terms: how broad each browsing step needs to be.

### 4. Make label generation thread-aware

This is the most important product-specific improvement beyond raw clustering.

Recommended changes:

1. Add thread-window enrichment for replies in addition to status-URL enrichment.
2. Use internal reply-chain context for tweets that are part of a thread of meaningful size.
3. Cap the enrichment so it stays compact and does not become a whole-document dump.
4. During exemplar selection, diversify softly by `thread_root_id` so one long thread does not fill the entire prompt when many thread roots are available, but still allow multiple tweets from the same thread when a cluster genuinely has only `1` or `2` thread roots.

This should be implemented to match the `voyage-context-3` mental model already described in `documentation/voyage-context.md`: related chunks from one document-like unit should be embedded and interpreted together, but each chunk should still keep its own identity.

Concrete policy:

- if a tweet belongs to an internal thread of size `>= 3`, enrich with a compact thread window
- include:
  - the root tweet text if available
  - up to one ancestor
  - up to one or two nearby descendants
- cap the combined added context by character count or token count

Why this should work:

- long-ish threads become semantically legible to the labeler
- exemplar lists stop overrepresenting one prolific thread
- the cluster label better matches how users perceive the content
- it aligns the naming path with the existing contextual embedding path instead of making them disagree

### 5. Keep the canonical label specific; let the UI shorten or wrap it as needed

Canonical labels should be specific enough to distinguish neighboring topics. The map display can be shorter than the canonical stored label; wrapping and truncation in the UI should handle brevity rather than forcing every label to be ultra-short.

Evidence from the smaller datasets confirms this: many of the best leaf labels are longer than a few words, and forcing them shorter would make them generic and indistinguishable.

Practical target:

- prefer `6` to `14` words as a soft range, not a hard cap
- no sentence-like phrasing
- no boilerplate prefixes

Use `description` for the longer explanation:

- what the topic is about
- representative themes
- maybe one sentence of clarification

This matches the current UI better:

- map labels already wrap and truncate to fit collision boxes
- topic directory can search `description`
- the label should identify the topic without collapsing into generic shorthand

### 6. Tighten tweet-specific keyphrase extraction

Current keyphrase defaults are too broad for tweets.

Recommended tweet defaults:

- `ngram_range=(1, 2)` (down from `(1, 4)`)
- `max_features=10_000` (down from `50_000`)
- `min_occurrences=3` for datasets above `50k` rows, `2` otherwise
- strip leading `@` handles and `#` symbols before n-gram extraction

Why this should work:

- tweets rarely benefit from many four-gram candidates
- broad n-gram spaces invite noisy fragments
- fewer, cleaner keyphrases produce better names

### 7. Change the parent-naming rule

The current prompt-construction skip path can reuse a single child name for a parent.

That is the wrong abstraction for this product.

Better rule:

- do not keep one-child parents in the first place
- collapse them before naming, or avoid generating them at all
- every surviving parent label should represent a real abstraction step

This makes the hierarchy more honest and the zoom transitions more understandable.

### 8. Reduce `unknown` with explicit backfill

`unknown` should be reserved for real leftovers, not for a large fraction of non-noise content.

Recommended serving policy:

- preserve one canonical cluster-label lineage
- backfill only points that are still unlabeled after the final hierarchy is normalized
- backfill only into the deepest surviving topical clusters

Concrete backfill rule:

1. Only consider points with `raw_cluster != -1`.
2. Measure distance in the original embedding space, not display UMAP.
3. For each unlabeled point, find its two nearest deepest-surviving cluster centroids.
4. Assign to the nearest cluster only if both are true:
   - `d1 <= cluster_q90`
   - `d1 / d2 <= 0.85`

Where:

- `d1` is distance to the nearest eligible centroid
- `d2` is distance to the second-nearest eligible centroid
- `cluster_q90` is the 90th percentile of centroid-distance among already assigned members of that cluster

This uses a cluster-relative threshold rather than a single global distance number.

Materialization rule:

- backfill affects deepest-cluster assignment only
- after backfill, recompute deepest-cluster counts, centroids, and hulls from the final membership
- parent counts then roll up from those final deepest-cluster assignments

Residual buckets:

- if a point fails centroid backfill, do not send it into one monolithic `unknown`
- place it into a deterministic coarse residual bucket such as:
  - `residual-replies`
  - `residual-link-shares`
  - `residual-misc`

These residual buckets differ from the current `unknown` because they expose why the content is residual and keep reply debris separate from substantive leftovers.

Classification rules:

- `residual-replies`: `is_reply == True` and text length below `80` characters
- `residual-link-shares`: text contains a URL and text minus the URL is below `40` characters
- `residual-misc`: everything else that fails centroid backfill

The goal is not to force every row into a fake precise topic. The goal is to avoid wasting semantically placeable content.

### 9. Fix hierarchy correctness before retuning quality

This is a hard requirement.

Required invariants:

- every non-top node has exactly one parent
- every parent is exactly one layer above its child
- no dangling parent references after collapse
- metadata layer counts match the post-collapse output
- no orphan warnings in healthy runs

Preferred normalization pipeline:

1. Collapse single-child nodes exactly once in `toponymy_labels.py`.
2. Stop collapsing again in `scope_labels.py`.
3. Rebuild the surviving tree from parent links.
4. Renumber layers from the roots downward so every surviving edge spans exactly one layer and roots remain at the maximum layer number.
5. Assign each point to its deepest surviving cluster, not to `layer == 0` specifically.

This solves two current problems at once:

- layer gaps caused by reparenting children directly to grandparents
- double-collapse across two pipeline stages

Important nuance:

- after normalization, not every deepest surviving cluster has to be numeric `layer 0`
- some branches will simply be shallower than others
- that is acceptable as long as parent-child edges are consistent and point assignment uses the deepest surviving node on each path

Without this, the web app may still render, but the product behavior is not trustworthy.

### 10. Expand the label-methodology signature

The current label-reuse match in `twitter_import.py` is too narrow.

It should include at least:

- provider and model
- clustering policy
- hierarchy depth controls
- prompt context
- tweet-enrichment mode
- keyphrase mode
- audit thresholds

Otherwise the pipeline can reuse labels from a different methodology and hide real regressions.

## Cost And Scalability Notes

### LLM cost

The proposed changes increase some costs and reduce others.

Costs that go up:

- thread-window enrichment makes some texts longer
- tighter residual handling and backfill add some postprocessing

Costs that go down:

- fewer leaf topics means far fewer naming prompts
- fewer higher-layer nodes means fewer parent labels to generate
- fewer flagged junk clusters should reduce audit churn

For `visakanv`-scale corpora, moving from `4874` leaf topics toward roughly `1200` leaf topics should cut naming-call volume substantially. The likely net effect is cost-neutral or cheaper, not more expensive.

### Clustering cost

`base_n_clusters` is not free.

- the pinned `PLSCAN` path builds the MST / uncondensed tree once
- but `base_n_clusters` still requires repeated `condense_tree()` calls during binary search on that tree

That is acceptable for an offline pipeline, but it should be benchmarked on the largest corpora before becoming the only implementation path.

If it proves too slow:

- cache cluster-count calibration results per dataset
- or warm-start from the previous run's nearest successful setting

### Memory

The main memory consumers at the large end are:

- embedding arrays
- clustering manifold arrays
- condensed-tree operations
- keyphrase matrices

For `100k` to `300k` corpora, the pipeline should continue to prefer a low-dimensional clustering manifold and avoid rebuilding unnecessary full-data intermediate frames in memory.

### Keyphrase extraction and enrichment

Thread enrichment increases effective corpus text volume, which can inflate keyphrase vocabulary and matrix size.

That makes the following changes more important, not less:

- `ngram_range=(1, 2)`
- smaller `max_features`
- higher `min_occurrences` on large corpora
- caching the keyphrase matrix for iterative tuning runs

### Parallelism and caching

The current `max_concurrent_requests=25` is a throughput knob, not a quality knob.

For offline runs, scalability should be improved by:

- exposing higher safe concurrency when providers permit it
- caching keyphrase matrices
- caching prompt inputs for unchanged clusters
- caching the normalized collapsed hierarchy artifact

## Recommended Default Policy By Scale

This is the recommended starting policy.

### Small datasets: `2k` to `20k`

- leaf topics: roughly `30` to `220`, depending on corpus density
- top layer: `8` to `16`
- layers: `3`
- thread enrichment: on for internal threads `>= 3`
- keyphrases: conservative and clean

Why:

- small datasets still need semantic spread
- too few clusters makes everything collapse into generic bins
- but denser small datasets can tolerate somewhat smaller leaf clusters than reply-heavy ones
- for datasets below about `2k`, relax the floor further and inspect manually

### Mid datasets: `20k` to `100k`

- leaf topics: roughly `150` to `500`, depending on corpus density
- top layer: `12` to `24`
- layers: `3`
- stronger exemplar diversification by thread root

Why:

- enough data for many meaningful themes
- still small enough that over-fragmentation is easy to create accidentally
- if tweet text is dense, some teen-sized leaf clusters may still be acceptable

### Large datasets: `100k` to `300k`

- leaf topics: roughly `450` to `1600`, with reply-heavy corpora usually toward the middle of that band
- top layer: `16` to `32`
- layers: `3`, occasionally `4`
- explicit `base_n_clusters`
- explicit `max_layers`
- aggressive control of `unknown`

Why:

- this is the range where fixed leaf cluster size stops being viable
- the product needs bounded navigability, not exhaustiveness

Across all three ranges, the final policy should be adjusted by corpus type:

- more reply-heavy / acknowledgment-heavy -> coarser leaves
- more self-contained / essay-like tweets -> finer leaves can work

## Quick Verification Workflow

The right approach prefers reasoning over blind experimentation:

1. choose a reasoned default policy
2. verify that the resulting structure matches product needs
3. only then do targeted parameter adjustments

### Structural checks

Run:

```bash
uv run python tools/eval_hierarchy_labels.py --dataset visakanv
```

Healthy output should show:

- `orphan_nodes = 0`
- `wrong_layer_parents = 0`
- `invalid_parent_refs = 0`
- low duplicate assignment count
- a much lower `unknown_count_actual`

### Topic-count checks

Use a quick parquet summary:

```bash
uv run python - <<'PY'
import os, pandas as pd
base=os.path.expanduser('~/latent-scope-data/visakanv')
labels=pd.read_parquet(os.path.join(base,'clusters','toponymy-001.parquet'))
real=labels[labels['cluster']!='unknown']
print(real.groupby('layer').size().to_dict())
PY
```

Healthy shape for a large dataset should look roughly like:

- hundreds to low-thousands at layer 0
- tens to low-hundreds at layer 1
- tens at the top layer, not `1`

### Coverage checks

Check how much non-noise content still falls to `unknown`:

```bash
uv run python - <<'PY'
import os, pandas as pd
base=os.path.expanduser('~/latent-scope-data/visakanv')
scope=pd.read_parquet(os.path.join(base,'scopes','scopes-001-input.parquet'))
unknown=scope['cluster'].astype(str)=='unknown'
noise=scope['raw_cluster'].astype(str)=='-1'
print({
  'unknown_total': int(unknown.sum()),
  'unknown_from_noise': int((unknown & noise).sum()),
  'unknown_from_non_noise': int((unknown & ~noise).sum()),
})
PY
```

The important number is `unknown_from_non_noise`. That should drop sharply.

### Label-shape checks

Sanity-check label length and duplicates:

```bash
uv run python - <<'PY'
import os, pandas as pd
from collections import Counter
base=os.path.expanduser('~/latent-scope-data/visakanv')
labels=pd.read_parquet(os.path.join(base,'clusters','toponymy-001.parquet'))
real=labels[labels['cluster']!='unknown']
for layer in sorted(real['layer'].unique()):
    names=real[real['layer']==layer]['label'].astype(str).tolist()
    dup=sum(v-1 for v in Counter(names).values() if v>1)
    print(layer, {'count': len(names), 'duplicate_excess': dup})
PY
```

Also manually inspect whether map-facing labels are short and distinct.

### Thread-specific checks

This is essential for this product.

Sample validation questions:

- do coherent long-ish threads now tend to land inside a meaningful topic instead of `unknown`?
- if a cluster is heavily represented by one long thread, does its label capture the thread's idea?
- do exemplar prompts show variety across thread roots instead of repeating one chain?

A quick pragmatic method:

1. pick `10` thread roots with size `>= 5`
2. inspect their member tweets and assigned layer-0 topics
3. verify that the label describes the thread theme in human terms

### UX checks

In the running web app:

- zoom out: top-level labels should be legible and not collapse into one root
- zoom in: label transitions should feel like refinement, not random replacement
- click a topic label: descendant-inclusive filtering should produce a coherent feed
- open topic directory: top-level cards should feel like macro themes, not leftovers
- toggle `Threads only`: thread-rich topics should still make semantic sense

## Why This Should Work

This design should work across the scales we care about because it follows the product constraints directly.

It is not trying to find a universal mathematical optimum. It is trying to satisfy these facts:

- the map can only display a limited number of labels at once
- the app already assumes the hierarchy roots are meaningful browse units
- threads are semantically important in tweet corpora
- very small leaf clusters make weak prompt inputs
- a single giant top root does not help navigation
- `unknown` cannot dominate the experience

The recommended policy solves those constraints directly:

- `base_n_clusters` gives scale-aware leaf control
- `max_layers` and layer-diversity filtering keep the hierarchy browseable
- thread-aware enrichment preserves long-form ideas
- canonical labels stay specific while the UI handles wrapping and truncation
- explicit coverage handling reduces wasted content

## Implementation Order

If this is turned into engineering work, the order should be:

1. fix hierarchy correctness and post-collapse metadata
2. add `base_n_clusters`, `max_layers`, and a scale-aware policy
3. add thread-aware text enrichment and exemplar diversification
4. tighten keyphrase defaults for tweets
5. keep canonical labels specific and improve display handling separately if needed
6. add non-noise unknown backfill
7. expand methodology signature and jobs wiring

## Concrete Recommendation For The Next `visakanv` Run

For the next serious `visakanv` regeneration, the recommended starting point is:

- `hierarchy_base_n_clusters` around `1200`
- target top-layer topics: about `20`
- `hierarchy_max_layers=3`
- `hierarchy_layer_similarity_threshold=0.2` as the first pass
- thread-window enrichment enabled
- soft exemplar diversity by `thread_root_id`
- tweet-tuned keyphrase extraction
- specific canonical labels, with map/display shortening handled in the UI if necessary

That is the first setup that is plausibly aligned with the current UX and business logic.
