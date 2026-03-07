# Toponymy Clustering Unification Plan

Date: 2026-03-06
Status: Draft
Scope: clustering duplication only

## 1. Problem Statement

Today the pipeline produces two different cluster structures for the same dataset:

1. a regular flat clustering used to build the initial scope
2. a separate Toponymy clustering pass used to build the hierarchical labels

This is not just redundant compute. It creates two different answers to the question:

"What topic does this tweet belong to?"

That is a product problem because the app is not using labels as decoration. The hierarchy is part of navigation.

## 2. What The App Actually Does Today

This section is intentionally grounded in current web code, not in an abstract idea of what the product might be.

### 2.1 Map behavior

`web/src/components/Explore/V2/DeckGLScatter.jsx`

- The map does not show all hierarchy layers at once.
- It chooses one hierarchy cut based on zoom.
- It then places only a bounded number of labels from that cut.
- Labels are collision-managed.
- Hidden rows from thread-only filtering can suppress labels and hulls.

Important consequence:

- the hierarchy is part of the map interaction model
- it is not just an annotation layer

### 2.2 Label click behavior

`web/src/pages/V2/FullScreenExplore.jsx`

- Clicking a map label does two things:
  - applies a cluster filter
  - zooms to the label hull

Important consequence:

- a cluster id is a navigation object, not just a display string

### 2.3 Cluster filtering behavior

`web/src/hooks/useClusterFilter.js`

- Filtering a cluster includes all descendants recursively.

Important consequence:

- parent/child structure must be trustworthy
- a broken hierarchy changes what the filter means

### 2.4 Topic directory behavior

`web/src/hooks/useTopicDirectoryData.js`
`web/src/components/Explore/V2/TopicDirectory/TopicDirectory.jsx`

- The directory uses hierarchy roots as top-level topic cards.
- Each card opens a feed sourced from all rows under that root.
- Subtopic filtering is descendant-based.
- Thread-only mode can prune rows inside those feeds.

Important consequence:

- top-level roots need to be meaningful browse categories
- descendant closure needs to be correct

### 2.5 Carousel behavior

`web/src/hooks/useCarouselData.js`
`web/src/components/Explore/V2/Carousel/FeedCarousel.jsx`

- The carousel columns are also hierarchy roots.
- Each column lazily loads rows from that root.
- Subtopic pills filter by descendants.
- Thread-only mode prunes rows there too.

Important consequence:

- the same hierarchy is being reused across multiple browse surfaces

### 2.6 Scope bootstrap behavior

`web/src/contexts/ScopeContext.tsx`

- The frontend builds the hierarchy from `scope.cluster_labels_lookup`.
- It recomputes leaf counts and likes from `scopeRows`.
- It then propagates those metrics upward through parents.
- Roots are used for sorting and color/hierarchy behavior.

Important consequence:

- the frontend mainly needs:
  - a correct point -> leaf assignment
  - correct parent/child links
  - stable root semantics
- precomputed counts are less important than structural correctness

## 3. What The Pipeline Actually Does Today

### 3.1 Current import path

`latentscope/scripts/twitter_import.py`

The current import path is:

1. build embeddings
2. build `2D` display UMAP
3. build `10D` clustering UMAP
4. run regular HDBSCAN clustering on the `10D` manifold
5. build a scope from that flat clustering
6. if hierarchical labels are enabled, run Toponymy
7. rebuild the scope using Toponymy labels

### 3.2 What the regular clustering does

`latentscope/scripts/cluster.py`

- Runs one HDBSCAN pass on the clustering manifold.
- Writes `cluster` and `raw_cluster` per point.
- Reassigns noise points to nearest centroids, so coverage is near-total.
- Produces a flat partition only.

This is a coverage-first flat clustering.

### 3.3 What Toponymy does

`latentscope/scripts/toponymy_labels.py`
`toponymy/toponymy/toponymy.py`
`toponymy/toponymy/clustering.py`

- Reloads embeddings.
- Reloads the same clustering manifold.
- Creates a fresh `ToponymyClusterer`.
- Reclusters from vectors into multiple layers.
- Then names those layers.

This is a hierarchy-first clustering plus labeling pass.

### 3.4 What the app ultimately uses

`latentscope/pipeline/stages/scope_materialize.py`

When hierarchical labels are active:

- the final serving `cluster` column is overwritten from the hierarchical labels
- the app is no longer using the original flat cluster ids as its primary topic ids

So the current flat clustering is not actually the final semantic truth seen by users.

## 4. Diagnosis

The current design mixes two roles that should be separated:

1. structural clustering
2. LLM naming

Right now both happen twice in different ways:

- one structure for the initial scope
- another structure inside Toponymy

That creates four practical problems.

### 4.1 It makes the product semantics harder to reason about

The map, filter system, topic directory, and carousel all rely on one hierarchy.

But the pipeline first creates a different flat cluster system and only later replaces it.

### 4.2 It makes tuning harder

If a result is bad, it is harder to know whether the cause is:

- the original HDBSCAN settings
- the Toponymy clustering settings
- hierarchy normalization
- naming quality

### 4.3 It weakens coverage semantics

The flat clustering force-assigns noise.
Toponymy does not follow the same coverage rule.

So a tweet can be:

- assigned in the flat clustering
- then effectively dropped in the hierarchical system

That is exactly the kind of mismatch that creates large `unknown`.

### 4.4 It does extra work for no product gain

The app ultimately wants one topic system.

Running two independent clustering passes only makes sense if they serve clearly different user-facing roles. Right now they do not.

## 5. Decision

Adopt a single canonical hierarchical clustering structure.

That structure should be built once on the `10D` clustering manifold and then reused everywhere.

Toponymy should become a labeling layer on top of that structure, not a second structural clustering system.

In short:

- `10D` manifold remains the clustering geometry
- `2D` UMAP remains display-only
- one hierarchy becomes canonical
- Toponymy names that hierarchy
- any flat leaf assignment becomes a derived view of the hierarchy

## 6. Why This Fits Tweet / Thread Exploration

This recommendation is specific to the shape of this product and data.

### 6.1 Tweets are noisy at the row level

Tweet corpora contain many:

- short replies
- acknowledgements
- emojis
- fragments
- quote/reply stubs

Those rows are often not good standalone leaf topics.

### 6.2 Threads carry a lot of the real semantic value

Long-ish self-reply chains often express one idea across multiple tweets.

The product already treats thread membership as important:

- thread-only mode
- thread overlays
- thread grouping in feeds

So the cluster system should not arbitrarily disagree with the topic system shown to users.

### 6.3 The UI is multi-scale by design

The app already expects:

- broad topics at overview
- narrower topics on zoom
- top-level roots for directory and carousel
- descendant-aware filtering

That is exactly what a canonical hierarchy is for.

## 7. Separate Display And Clustering Manifolds

The current pipeline already distinguishes between:

- a `2D` UMAP for display
- a `10D` UMAP for clustering

That split is the right basic idea. I would keep it.

The issue is not that there are two manifolds.
The issue is that the repo currently treats them as two loosely related intermediate artifacts instead of as two different views with sharply different product responsibilities.

### 7.1 Why the split is correct in principle

The display map and the structural clustering are solving different problems.

The `2D` map is for:

- human legibility
- stable overview navigation
- label placement
- hover and click interaction
- hull zoom

The clustering manifold is for:

- density-based separation
- hierarchy construction
- stable leaf assignments
- parent/child topic structure

Those objectives are not the same, so they should not be forced into the same dimensionality or parameter regime.

### 7.2 Why `2D` should stay display-only

Clustering directly on the display map is the wrong default for this product.

Why:

1. `2D` is optimized for visual interpretability, not structural faithfulness.
2. UMAP does not preserve density perfectly, so a `2D` embedding can create false gaps or over-tight local islands.
3. The app already relies on hierarchy semantics, not just visual proximity, for filters and topic browsing.

The UMAP clustering guide and FAQ both support this framing:

- UMAP can be useful before clustering, but "with care"
- UMAP does not preserve density perfectly
- larger embedding dimensions than `2` are often better for clustering than `2D`

References:

- [UMAP: Using UMAP for Clustering](https://umap-learn.readthedocs.io/en/latest/clustering.html)
- [UMAP FAQ: Can I cluster the results of UMAP?](https://umap-learn.readthedocs.io/en/latest/faq.html)

This matters a lot for tweet corpora because row-level tweet geometry is noisy. A `2D` map can exaggerate:

- micro-reply islands
- author-style artifacts
- local gaps caused by projection rather than true semantic separation

### 7.3 Why a higher-dimensional clustering manifold still makes sense

The alternative is not "cluster in `2D`" versus "cluster in the full embedding space."

For this stack, the practical choice is:

- cluster in a lower-dimensional but still richer manifold than `2D`

That is also well supported by the UMAP docs:

- HDBSCAN struggles in high dimensions because density becomes harder to estimate
- UMAP can reduce to something like `10` dimensions for clustering rather than `2`
- clustering-oriented UMAP should use different parameters than visualization-oriented UMAP

The UMAP clustering guide explicitly recommends:

- larger `n_neighbors`
- very low `min_dist`
- trying dimensions larger than `2`

That is exactly the reasoning behind the current `10D` clustering UMAP.

For this repo, that means the current split is directionally right:

- `2D` for rendering
- `10D` for density clustering

### 7.4 What the current implementation gets right

`latentscope/scripts/twitter_import.py`

The current import path already does two important things correctly:

1. it builds a separate clustering manifold
2. it sets clustering `min_dist=0.0`

Those are good defaults for a density-based clustering manifold.

### 7.5 What the current implementation gets wrong or leaves under-specified

The current split needs to be made more explicit and more product-aware.

#### A. It reuses too much parameter policy between display and clustering

Today the display UMAP and clustering UMAP share the same `n_neighbors` input, while only `min_dist` is specialized.

That is too weak a separation.

Clustering and display should have separately tunable parameters.

Recommended direction:

- display UMAP:
  - optimize readability and stable visual overview
- clustering UMAP:
  - optimize density contrast and structural stability

#### B. `10D` is reasonable, but it should be a policy band, not a sacred constant

`10D` is a good default, not a law.

For this app:

- small datasets can often use something like `5–10`
- medium and large datasets are more likely to want `10–20`

The goal is not to hit a theoretically perfect dimension count. The goal is:

- enough dimensions to avoid the worst projection artifacts of `2D`
- few enough dimensions for density clustering to remain tractable and meaningful

#### C. A cluster defined in `10D` can look broken in `2D`

This is one of the most important UI edge cases.

A semantic cluster can appear in the display map as:

- multiple islands
- a stretched crescent
- a shape with holes
- an apparently overlapping region with another cluster

That does not necessarily mean the clustering is wrong.
It often means the display projection is flattening a richer structure.

This is especially important because the app currently uses hulls for:

- label anchoring
- label visibility
- click-to-zoom bounds

A single convex hull is a weak display proxy for a cluster that was defined in `10D`.

#### D. The structure/display relationship is not explicit enough in lineage

If the app is going to rely on:

- one display manifold
- one clustering manifold
- one canonical hierarchy

then the lineage needs to make those relationships first-class, not implicit.

At minimum, scope metadata should clearly distinguish:

- display manifold id and params
- clustering manifold id and params
- hierarchy id and params
- naming run id and params

### 7.6 Recommended manifold policy

Keep the separate manifold design, but formalize it.

#### Canonical rules

1. Never cluster on the display `2D` map in the normal Twitter-import path.
2. Always treat the clustering manifold as the structural source of truth.
3. Always treat the `2D` map as a projection for rendering and interaction.
4. Tune display and clustering UMAPs separately.

#### Practical defaults

Display manifold:

- `n_components=2`
- readability-first parameter choices
- stable enough for repeated exploration and screenshots

Clustering manifold:

- `n_components` in a policy band such as `5–20`
- larger `n_neighbors` than display
- `min_dist=0.0`
- stable seed and lineage tracking

#### Current recommendation for this repo

For the `2k–300k` tweet range:

- keep `2D` display UMAP
- keep a separate clustering manifold
- default clustering manifold to around `10D`
- allow policy-based movement toward `5D` for smaller corpora and `15–20D` for larger or denser corpora

### 7.7 Important edge cases

#### Edge case 1: one cluster becomes multiple islands in `2D`

This is acceptable structurally.
It is a rendering problem, not necessarily a clustering problem.

Recommended handling:

- stop assuming one convex hull is always the right visual summary
- support multi-component display shapes or a more conservative hull policy

#### Edge case 2: visually nearby points in `2D` belong to different clusters

This is also acceptable if the clustering manifold is canonical.

The UI just needs to avoid implying that `2D` adjacency alone defines topic membership.

#### Edge case 3: very small datasets

Two UMAP runs may be heavier than necessary for very small corpora.

But for consistency of product behavior, it is still reasonable to keep the split and simply use a smaller clustering manifold.

#### Edge case 4: very large datasets

At larger sizes the main risk is not "too many UMAPs."
The main risk is semantic drift between:

- the display map users see
- the structural hierarchy the app uses

That is why the clustering manifold must be the canonical structure source.

### 7.8 References

Primary sources that support the design:

- [UMAP: Using UMAP for Clustering](https://umap-learn.readthedocs.io/en/latest/clustering.html)
- [UMAP FAQ: Can I cluster the results of UMAP?](https://umap-learn.readthedocs.io/en/latest/faq.html)
- [Toponymy basic usage](https://toponymy.readthedocs.io/en/latest/basic_usage.html)
- [Toponymy clusterers](https://toponymy.readthedocs.io/en/latest/clusterers.html)

Key takeaways from those sources:

- clustering on UMAP is valid but requires care
- UMAP is better suited to clustering than t-SNE partly because it supports embedding dimensions larger than `2`
- clustering-oriented UMAP should use different parameters than visualization-oriented UMAP
- Toponymy is already built around the distinction between `embedding_vectors` and `clusterable_vectors`

## 8. Recommended Architecture

### 8.1 Canonical structure

Introduce a new precomputed hierarchy artifact as the single source of truth for topic structure.

Proposed artifact name:

- `hierarchy-XXX.json`
- `hierarchy-XXX.parquet`
- `hierarchy-XXX.npz`

Suggested responsibilities:

- `hierarchy-XXX.json`
  - lineage metadata
  - clustering policy used
  - layer counts
  - coverage stats
  - manifold ids

- `hierarchy-XXX.parquet`
  - node table used by scope serving
  - columns compatible with current hierarchical label serving shape
  - `cluster`, `layer`, `parent_cluster`, `children`, `indices`, `count`, `hull`, `centroid_x`, `centroid_y`

- `hierarchy-XXX.npz`
  - raw cluster label arrays per layer
  - enough information to reconstruct Toponymy cluster layers without reclustering

The key idea is:

- save the structure once
- reuse it for naming

### 8.2 Toponymy role after the change

Toponymy should:

- load the precomputed hierarchy
- reconstruct cluster layers from saved arrays
- skip `fit_predict` reclustering
- run exemplar/keyphrase/naming/disambiguation on the existing hierarchy
- write labeled output in the existing `toponymy-XXX.parquet/json` format

This uses an existing Toponymy seam:

- `Toponymy.fit()` already skips reclustering if the supplied clusterer already has `cluster_layers_` and `cluster_tree_`

So the clean design is not "rewrite Toponymy."
The clean design is "feed Toponymy a precomputed structure."

### 8.3 Independent roots are allowed, but current root counts are not yet trustworthy

Density-based hierarchical clustering can legitimately produce independent roots:

- some fine-grained clusters may have no meaningful broader parent
- forcing every cluster into a synthetic parent would create misleading browse categories

The frontend is already capable of handling true independent roots:

- `ScopeContext.tsx` treats `parent_cluster === null/undefined` as a root
- `buildClusterFeedIndex` maps those roots into independent top-level browse entries
- `selectHierarchyLabelCut` in `DeckGLScatter.jsx` can include them at their natural layer

That capability should be preserved.

However, the current `visakanv` root count should not be treated as clean evidence of intended semantics.

In the current artifact:

- `2,763` of `4,874` layer-0 clusters have no parent
- `3,303` total clusters have no parent
- `243` clusters still have wrong-layer parents

That means current null-parent counts are a mix of:

- potentially valid independent roots
- structural pathologies from the current tree construction / translation path

So the implementation rule should be:

- preserve validated independent roots
- do not assume every current null-parent node is semantically intentional
- keep parent-gap validation and normalization in the hierarchy-serving path

### 8.4 Scope serving after the change

The scope should be built from the canonical hierarchy, not from an earlier unrelated flat clustering.

The frontend contracts that must still hold:

- each row has one serving cluster id
- cluster id corresponds to the deepest surviving node for that row
- parents are available for descendant filters
- roots are available for directory and carousel
- hulls and centroids exist for map label click and zoom

## 9. Options Considered

### Option A: keep the current dual system

Rejected.

Reason:

- continues the semantic mismatch
- keeps tuning ambiguous
- duplicates work

### Option B: delete the earlier flat clustering and let Toponymy own all structure

Better than today, but still not ideal.

Reason:

- it still couples expensive LLM labeling with structural clustering
- structure becomes harder to cache and reuse independently
- failures in labeling are harder to isolate from failures in clustering

### Option C: build one structural hierarchy earlier, then let Toponymy only label it

Recommended.

Reason:

- separates structure from naming
- gives one canonical topic system to the app
- preserves offline tuning flexibility
- reduces repeated clustering work
- fits the current web contracts cleanly

## 10. Implementation Phases

### Phase 0: Implement PLSCAN as the upstream hierarchy builder

Goal:

- add PLSCAN as the upstream structure builder for canonical hierarchy artifacts
- make it the default builder for new hierarchy artifacts
- keep the current quantile-based hierarchy builder available as a fallback while we validate output quality

Background:

The current hierarchy path derives layers using the quantile heuristic now exposed through `ToponymyClusterer`: at each iteration, the next layer's `min_cluster_size` is the 80th-85th percentile of current cluster sizes. This works but is manual — you pick `next_cluster_size_quantile` and `min_clusters` and hope for reasonable layers.

PLSCAN (Persistent Layered Scanning) is a principled alternative from the same team (Tutte Institute / Leland McInnes). Instead of the quantile heuristic, it:

1. Builds the same Boruvka MST (one-time, same as `ToponymyClusterer`)
2. Sweeps ALL possible `min_cluster_size` values, computing a persistence barcode at each
3. Finds peaks in total persistence — these are the resolutions where clusters are most stable
4. Filters peaks for diversity using Jaccard similarity between layers (`layer_similarity_threshold`)

PLSCAN produces the same structural outputs we need for the hierarchy artifact:

- `cluster_layers_`: `List[np.ndarray]` — label vectors per layer (-1 = noise)
- `cluster_tree_`: `Dict[Tuple[int,int], List[Tuple[int,int]]]` — same parent-child format

Plus additional quality signals:

- `membership_strength_layers_`: soft confidence per point per layer (0.0-1.0)
- `layer_persistence_scores_`: quality score per selected layer
- `min_cluster_sizes_`: the `min_cluster_size` used at each layer

Availability:

- NOT in the installed `fast_hdbscan==0.2.2` (Toponymy pins `>=0.2.2`)
- EXISTS on `fast_hdbscan` GitHub `main` branch and is already documented in that repo's `README.rst`
- exported directly from `fast_hdbscan.__init__`
- same authors as Toponymy — uses the same Boruvka / numba infrastructure and low-dimensional clustering assumptions

PLSCAN parameters:

```python
PLSCAN(
    min_samples=5,                      # same as ToponymyClusterer
    max_layers=10,                      # same concept
    base_min_cluster_size=10,           # same
    base_n_clusters=None,               # same
    layer_similarity_threshold=0.2,     # replaces next_cluster_size_quantile
    reproducible=False,
    verbose=False,
)
```

Integration path:

PLSCAN should run in the upstream hierarchy-building stage, not inside Toponymy's structural step.

The hierarchy builder should:

- run `PLSCAN.fit(clusterable_vectors)`
- persist:
  - `cluster_layers_`
  - `cluster_tree_`
  - `membership_strength_layers_`
  - `layer_persistence_scores_`
  - `min_cluster_sizes_`

Toponymy should later consume the saved `cluster_layers_` and `cluster_tree_` via a precomputed-structure adapter.

That adapter belongs on the naming boundary, not as the primary place where hierarchy structure is chosen.

Key advantage for coverage:

`membership_strength_layers_` provides soft membership scores for all points, including noise. This gives a principled way to reassign noise points — assign to the cluster with highest membership strength rather than nearest centroid.

Important caution from the code:

- PLSCAN's `cluster_tree_` is built via `build_layer_cluster_tree(...)`
- that helper uses the same broad parent-matching pattern as the current Toponymy tree builder
- so PLSCAN improves layer selection, but it does NOT by itself eliminate the need for parent-gap validation / hierarchy normalization before serving or labeling

Implementation:

1. Upgrade `fast_hdbscan` to a pinned GitHub commit on `main` that includes `PLSCAN`
2. Add a hierarchy-builder switch, e.g. `--hierarchy-builder {plscan,quantile}`
3. Default new hierarchy builds to `plscan`
4. In the hierarchy-building stage, persist:
   - `cluster_layers_`
   - `cluster_tree_`
   - `membership_strength_layers_`
   - `layer_persistence_scores_`
   - `min_cluster_sizes_`
5. Run on `visakanv` 10D manifold with a conservative initial config
6. Compare against the current quantile-based hierarchy output:
   - number of layers
   - cluster counts per layer
   - coverage (% of points assigned)
   - number of validated roots after normalization
   - `layer_persistence_scores_`
   - visual inspection of label quality after naming

Success criteria:

- PLSCAN produces at least as many meaningful browse layers as the quantile heuristic
- `layer_persistence_scores_` provide a useful quality signal
- `membership_strength_layers_` can guide noise reassignment
- normalized root counts and coverage are no worse than the current path

Fallback:

- keep the current quantile-based hierarchy builder available as the structural fallback until the first `visakanv` and one smaller-corpus run pass review

Primary sources:

- `fast_hdbscan` README on `main`
- `fast_hdbscan/hdbscan.py`
- `fast_hdbscan/layer_clusters.py`
- [Persistent Multiscale Density-based Clustering](https://arxiv.org/pdf/2512.16558)

### Phase 1: Introduce a canonical hierarchy artifact

Goal:

- compute the hierarchy once, without LLM naming

Implementation:

- add a new pipeline stage, likely `latentscope/scripts/build_hierarchy.py`
- use the same `10D` clustering manifold currently used by Toponymy
- use the selected hierarchy builder (`plscan` by default, quantile fallback)
- save:
  - node parquet
  - raw layer arrays
  - metadata json

Notes:

- this stage is structural only
- no prompts
- no LLM

Success criteria:

- one hierarchy artifact can fully describe the structure currently needed by the app
- deepest-node assignment can be derived from it
- roots/parents/children/indices/hulls are all preserved

### Phase 2: Make Toponymy consume the precomputed hierarchy

Goal:

- remove the second structural clustering pass

Implementation:

- modify `latentscope/scripts/toponymy_labels.py` to accept `hierarchy_id`
- load saved layer arrays and tree
- reconstruct `ClusterLayerText` objects using the saved labels plus current embeddings
- provide a clusterer object with:
  - `cluster_layers_`
  - `cluster_tree_`
- call `Toponymy.fit()` so naming runs but structural reclustering is skipped

Success criteria:

- same prompts/naming pipeline still works
- no second clustering pass runs
- final labeled parquet remains compatible with scope serving

### Phase 3: Derive serving cluster ids from the canonical hierarchy

Goal:

- make the app’s point-level topic ids come from the same hierarchy that powers labels

Implementation:

- change scope materialization to read deepest-node assignments from the hierarchy-derived labels
- stop treating the earlier flat clustering as canonical topic membership
- keep `raw_cluster` only if we still want it as a diagnostic or residual coverage field

Success criteria:

- map labels, filters, directory, and carousel all operate over the same structure
- no separate flat semantic partition remains in the main happy path

### Phase 4: Remove the old flat clustering from the default happy path

Goal:

- end the duplication cleanly

Implementation:

- stop running `latentscope/scripts/cluster.py` in the default import path when hierarchical mode is enabled
- keep a fallback flat clustering path only for:
  - non-hierarchical imports
  - debugging
  - explicit legacy mode

Success criteria:

- normal Twitter import path produces one structure, not two

## 11. File-Level Plan

### New or changed backend files

`toponymy/pyproject.toml`

- upgrade `fast_hdbscan` dependency from `>=0.2.2` to a pinned GitHub commit on `main` that includes `PLSCAN` until an official release contains it

`toponymy/toponymy/clustering.py`

- add a small precomputed-structure adapter class so Toponymy can consume saved `cluster_layers_` and `cluster_tree_` without reclustering

`latentscope/scripts/twitter_import.py`

- replace the current "flat cluster first, Toponymy cluster later" flow for hierarchical imports
- create hierarchy before Toponymy naming

`latentscope/scripts/build_hierarchy.py` or equivalent new stage

- build and save canonical structural hierarchy
- support `plscan` and quantile-based hierarchy builders
- default to `plscan` for new hierarchical imports

`latentscope/scripts/toponymy_labels.py`

- accept a precomputed hierarchy
- reconstruct cluster layers
- skip reclustering

`latentscope/pipeline/stages/scope_materialize.py`

- use hierarchy-derived deepest assignments as the primary serving cluster ids

`latentscope/pipeline/stages/scope_meta.py`

- add `hierarchy_id` to scope lineage metadata

Optional:

`latentscope/pipeline/stages/scope_labels.py`

- may stay mostly unchanged if final labeled parquet keeps today’s schema

### Frontend files that should not need semantic changes

These should continue working if the backend delivers the same contract more cleanly:

- `web/src/components/Explore/V2/DeckGLScatter.jsx`
- `web/src/pages/V2/FullScreenExplore.jsx`
- `web/src/contexts/ScopeContext.tsx`
- `web/src/hooks/useClusterFilter.js`
- `web/src/hooks/useTopicDirectoryData.js`
- `web/src/hooks/useCarouselData.js`

That is an important design constraint:

- unify the backend structure
- do not rewrite the current browse model unless necessary

## 12. Compatibility Strategy

This change should be staged so the frontend does not need a simultaneous rewrite.

Recommended compatibility plan:

1. keep the current `cluster_labels_lookup` serving shape
2. keep `cluster`, `parent_cluster`, `children`, `layer`, `hull`, `centroid_x`, `centroid_y`
3. add `hierarchy_id` in metadata first
4. only later deprecate the old flat `cluster_id` happy path

This lets us change the structure source without changing the web contract immediately.

## 13. Risks

### 13.1 Reconstruction risk

Reconstructing Toponymy cluster layers from saved arrays must preserve naming behavior closely enough.

Mitigation:

- use the same layer class construction path as current `create_cluster_layers`

### 13.2 Coverage regression

If we remove the flat clustering too early, we may lose the current near-total coverage behavior from centroid reassignment.

Mitigation:

- keep an explicit backfill/residual policy in the canonical hierarchy path
- do not rely on the old flat clustering implicitly

### 13.3 Migration ambiguity

There may be old scopes whose lineage still references only `cluster_id`.

Mitigation:

- support legacy reads during migration
- only switch the default import path once canonical hierarchy artifacts exist

## 14. Verification Plan

### Structural verification

For each of:

- `visakanv`
- `defenderofbasic`
- `ivanvendrov-tweets`

verify:

- one canonical hierarchy artifact exists
- Toponymy naming reuses it instead of reclustering
- point -> deepest cluster assignment is total or near-total
- directory roots and carousel roots remain stable
- label click still zooms to the correct hull

### Product verification

Manual checks:

1. zoom the map from overview to fine detail
2. click several labels and confirm:
   - cluster filter applies
   - zoom-to-hull still works
3. open topic directory and carousel:
   - roots look consistent
   - subtopic filters remain descendant-based
4. enable thread-only mode:
   - feeds prune correctly
   - map labels do not become semantically inconsistent

### Pipeline verification

For one hierarchical import run:

- confirm `cluster.py` is no longer in the main path
- confirm Toponymy does not call structural reclustering
- compare runtime against the old dual path

## 15. Recommendation

Move to Option C.

That means:

- one structural hierarchy
- one naming pass
- one canonical topic system for the app

This is the best fit for the current product because the web app already behaves like a hierarchy-driven explorer. The backend should stop pretending there are two different cluster systems when, in practice, only one should matter.
