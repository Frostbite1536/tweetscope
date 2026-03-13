# Topic Maps, Clustering, Neighborhoods, and Color Semantics

## Purpose

This document explains how topic structure is produced and rendered in the current product, with special focus on:

- the intent of the topic map
- the shape of the data that drives it
- how embeddings, clustering, hierarchy, and `2D` map coordinates relate
- what "neighboring" means in different parts of the system
- how cluster colors are assigned today
- why the current colors do not read as topic-related
- what the expected coloring semantics should be
- how Flexoki constrains the design space

The core conclusion is:

- topic clustering is mostly coming from the right places
- topic colors are not currently wired to semantic relatedness
- the current color system is mostly a stable branch/palette system
- Flexoki is not the problem; the semantic mapping into Flexoki is the problem


## Product Intent

The product is not just a scatter plot of tweets. It is a topic explorer.

At a high level, the app is trying to do four things at once:

1. turn a corpus of short posts into meaningful semantic units
2. organize those units into a browseable topic structure
3. project that structure into a `2D` interactive map
4. give the user visual cues that help them understand what belongs together

That means the map has several overlapping jobs:

- show a readable spatial layout
- expose topic hierarchy as the user zooms
- support search and filtering
- make groups feel legible at a glance

Colors are part of that last job. They are not decoration. They are a compression layer for topic structure.


## The Shape Of Our Data

The system operates on several related but distinct data shapes.

### 1. Corpus rows

Each row in a dataset is a tweet-like item that eventually becomes one point in a scope parquet.

Those rows carry:

- text and tweet metadata
- `x`, `y` display coordinates
- a serving `cluster`
- a serving `label`
- `ls_index`
- deleted state

The scope parquet is the frontend-facing table of points.

### 2. Raw embeddings

Embeddings are generated upstream and stored in HDF5. The current default is contextual `voyage-context-3` at `1024D`.

Important implication:

- the raw embedding space is the most semantic vector space in the system

This is the space used for:

- semantic nearest-neighbor search
- exemplar selection and cluster centroids in naming flows
- the input to downstream dimensionality reduction

### 3. Display manifold

The display UMAP is a separate `2D` projection used for visualization.

This is what the map renders.

Important implication:

- `2D` proximity is a visualization convenience, not ground-truth semantic distance

### 4. Clustering manifold

The clustering UMAP is a separate lower-dimensional manifold, currently `10D`, used to build hierarchy with `PLSCAN`.

Important implication:

- cluster structure is not built directly from raw Voyage vectors
- cluster structure is built from a reduced manifold

### 5. Hierarchical labels

When hierarchical labels are available, `scope.cluster_labels_lookup` contains topic nodes such as:

- `cluster`
- `layer`
- `label`
- `parent_cluster`
- `children`
- `count`
- `display_centroid_x`, `display_centroid_y`
- `semantic_order`
- `topic_specificity`

This is the structure the frontend rebuilds into a tree and then uses for:

- directory / carousel topic roots
- zoom-based label cuts
- cluster filters
- color assignment

### 6. Hierarchy integrity

Scopes are expected to carry hierarchical labels.


## Current Pipeline Logic

The current production path is roughly:

1. import tweets
2. enrich tweet text with reference context
3. embed with contextual Voyage embeddings
4. build a `2D` display UMAP
5. build a `10D` clustering UMAP
6. build a hierarchy with `PLSCAN`
7. name that hierarchy with Toponymy
8. materialize a scope for serving
9. export raw vectors to LanceDB for semantic search

Relevant code paths:

- `latentscope/scripts/embed.py`
- `latentscope/scripts/twitter_import.py`
- `latentscope/scripts/umapper.py`
- `latentscope/scripts/build_hierarchy.py`
- `latentscope/scripts/toponymy_labels.py`
- `latentscope/pipeline/stages/scope_materialize.py`
- `api/src/routes/search.ts`

Important product fact:

- the app is hierarchy-driven, not just cluster-ID driven

That shows up in the map, topic directory, carousel, and filters.


## What "Neighboring" Means In This Product

One source of confusion is that the app has several different neighborhood concepts at once.

They are not interchangeable.

### 1. Semantic neighbors

These are nearest neighbors in raw embedding space.

They come from:

- query embedding through Voyage REST
- vector search in LanceDB

Code:

- `api/src/routes/search.ts`
- `web/src/hooks/useNearestNeighborsSearch.js`

This is the cleanest notion of semantic similarity in the current product.

### 2. Visual neighbors

These are points near each other in display `x`, `y`.

They come from:

- `2D` display UMAP
- viewport position
- projection to screen coordinates in `DeckGLScatter`

Code:

- `latentscope/scripts/umapper.py`
- `web/src/components/Explore/V2/DeckGLScatter.jsx`

This is useful for browsing, but it is not the same thing as semantic nearest-neighbor structure.

### 3. Structural neighbors

These are topics that share ancestry in the hierarchy.

They come from:

- `PLSCAN` clustering on the `10D` clustering manifold
- parent-child relations materialized into `cluster_labels_lookup`

Code:

- `latentscope/scripts/build_hierarchy.py`
- `latentscope/pipeline/hierarchy.py`
- `latentscope/scripts/toponymy_labels.py`
- `web/src/contexts/ScopeContext.tsx`

This is the product's browse structure.

### 4. Label-layer neighbors

These are the topics that are visible together at the current zoom level.

The map does not show every hierarchy layer at once. It chooses one hierarchy cut based on zoom.

Code:

- `web/src/components/Explore/V2/DeckGLScatter.jsx`

This is a UI-specific notion of neighborhood.


## Current Clustering And Mapping State

### Embedding and dimensionality

Local checks on current corpora show:

- `voyage-context-3`, `1024D`, contextual embeddings are the standard operating point
- grouped tweet units are still short on average
- this is still fundamentally short-text clustering, not long-document clustering

Examples from local embedding metadata:

- `patio11-tweets`: average thread-group length `1.78`
- `ivanvendrov-tweets-likes`: average thread-group length `1.0`

### Clustering manifold

Current clustering uses:

- display UMAP: `2D`, `metric='cosine'`
- clustering UMAP: `10D`, `metric='cosine'`, tighter `min_dist`
- hierarchy builder: `PLSCAN.fit(clusterable_vectors)`

This means:

- topic structure is not coming straight from raw embedding space
- topic structure is mediated by a dimensionality reduction step

### Local quantitative checks

On local sample checks:

- estimated local intrinsic dimension of raw embeddings was roughly `15-17`
- `UMAP10` preserves local structure better than `UMAP2`
- but `UMAP10` is still a real bottleneck, not a neutral pass-through
- in sampled checks, moving `UMAP` from `5D` to `10D` to `25D` did not materially change neighborhood preservation
- simple `PCA25` baselines often preserved neighborhoods better than current `UMAP10`

Interpretation:

- current clustering is plausible
- current `10D` choice is heuristic, not deeply justified by the data

That matters for color expectations because if clustering is "mostly right," users will naturally expect color to reinforce that structure.


## Current Hierarchy State

The frontend rebuilds hierarchy from `scope.cluster_labels_lookup` in `ScopeContext`.

Important behaviors:

- cluster counts and likes are aggregated upward through the tree
- children are sorted by cumulative likes and count
- top-level browse views depend on those roots

Code:

- `web/src/contexts/ScopeContext.tsx`

One subtle issue:

- roots are built from all `maxLayer` nodes plus all parentless nodes

That means the hierarchy color system can start from a mixed abstraction layer rather than one clean semantic cut.

This matters because the color allocator depends on that tree shape.


## Current Coloring Logic

The current color system lives primarily in:

- `web/src/lib/clusterColors.js`
- `web/src/hooks/useClusterColors.js`

It then flows into:

- `DeckGLScatter`
- topic directory
- carousel
- feed cards
- search UI

### What the palette is

The palette is a Flexoki-based accent system:

- `8` hue columns
- `6` tone rows
- `48` unique hue-tone combinations before reuse

This is a valid Flexoki-inspired palette implementation.

### What the allocator does

When hierarchy exists:

1. choose the hierarchy layer whose node count is closest to `8`
2. assign one hue per node on that layer
3. make descendants inherit the same hue family
4. vary descendants by tone
5. make ancestors inherit the hue of the first child that has a hue

### The crucial detail

The hue assignment is not semantic.

It is driven by a stable hash of the node identity:

- `stableHash32`
- `stableNodeIdentity`
- `assignTopLevelHuesStable`

The stable identity prefers:

- `node.cluster`

before it uses:

- normalized label text

So in practice, hue anchors are mostly keyed off arbitrary cluster ids.

### Tone assignment is also not semantic

Descendants get tones by traversal order.

That traversal order comes from:

- tree order
- which is sorted by cumulative likes / count

So the current tone system is influenced by popularity/order, not by topic distance or specificity.


## Why The Colors Feel Wrong

The current system is optimizing for stability and branch grouping, not semantic relatedness.

That creates several mismatches with user expectation.

### 1. Similar topics do not necessarily get similar colors

Because hue anchors are hash-based, two semantically nearby roots can get distant hues.

### 2. Distant topics can share a color family

Because the palette only has `8` hue columns, collisions are guaranteed in larger scopes.

### 3. Tone does not mean "closer topic"

Tone is currently mostly:

- descendant order
- likes/count sorting
- branch traversal

not:

- semantic closeness
- abstraction depth
- specificity in a principled way

### 4. The tree shape itself is imperfect

Because roots can be mixed-level and because some scopes have many detached roots, the color allocator is operating on a structure that is not always a clean semantic partition.


## Local Examples

Local scope checks illustrate the problem.

### `sheik-tweets`

- hierarchical labels: `true`
- total topic nodes: `53`
- roots: `23`
- max layer: `2`
- best hue layer for the current allocator: `11` nodes

Already more than the ideal `8` hue anchors.

### `defenderofbasic`

- hierarchical labels: `true`
- total topic nodes: `338`
- roots: `98`
- max layer: `4`
- best hue layer: `10` nodes

Again exceeds the canonical hue count.

### `patio11-tweets`

- hierarchical labels: `true`
- total topic nodes: `1887`
- roots: `867`
- max layer: `6`
- best hue layer: `56` nodes

This scope massively exceeds the palette's semantic capacity.

## Flexoki And Its Implications

Flexoki is not a semantic color model. It is a perceptual palette system.

That distinction matters.

### What Flexoki is good for

Flexoki gives us:

- warm readable colors
- strong light/dark theme behavior
- coherent perceptual contrast
- a small set of accent families that feel intentional

That is ideal for:

- UI accents
- cluster families
- labels, chips, outlines, and feed panels

### What Flexoki does not give us

Flexoki does not tell us:

- which topic should be red vs blue
- which topics should be adjacent in color
- how semantic distances should be compressed into `8` hues

That mapping has to come from our own semantics.

### Practical constraint

With only `8` canonical hues:

- we cannot encode exact global topic similarity for hundreds of clusters
- we can only encode a compressed family structure

So the right question is not:

- "Can color represent exact topic relatedness?"

The right question is:

- "What is the most useful semantic compression we can express with 8 hue families and a handful of tone steps?"

### One current palette mismatch

The local Flexoki doc recommends:

- light interfaces use `600`
- dark interfaces use `400`

Current cluster tables use:

- light rows `300` through `800`
- dark rows `100` through `500`

This is not inherently wrong, but it means the current implementation is a product-specific Flexoki adaptation, not a literal one-to-one mapping of "main accent" recommendations.


## Expected State

The expected behavior should be:

### 1. Hue means topic family

Clusters that belong to the same branch should share a hue family.

### 2. Nearby topic families should receive nearby hues

If two top-level branches are semantically or spatially adjacent, their hues should be adjacent in the limited Flexoki hue sequence.

This does not require exact color-distance fidelity.

It requires a consistent ordering of topic families before quantization into `8` hues.

### 3. Tone should mean something stable

Tone should reflect one or both of:

- hierarchy depth
- topic specificity

It should not depend on child traversal order or likes ordering.

### 4. Unknown / unclustered should remain clearly separate

The current special-case "unknown" behavior is good in principle and should remain a neutral or special accent path rather than being confused with a real topic family.

### 5. The system should degrade honestly

If a scope has too many top-level semantic groups for `8` hues, the system should still group sensibly by family rather than pretending every topic gets a unique hue.


## What The Current System Actually Encodes

Today color mostly encodes:

- branch membership when hierarchy exists
- deterministic but arbitrary hue anchors
- descendant traversal order
- a Flexoki-compatible palette family

It does not reliably encode:

- semantic nearest-neighbor similarity
- visual neighborhood in `2D`
- cluster centroid similarity in raw embedding space
- topic specificity


## Recommended State, Smallest Change First

There are two levels of fix.

### Level 1: smallest useful frontend-only fix

Keep Flexoki. Keep the existing hierarchical model. Change only the mapping logic.

#### Hue assignment

Instead of hashing cluster ids for hue anchors:

- choose the hue layer as now
- order hue-layer nodes by their map geometry
- assign adjacent Flexoki hues along that order

The simplest version is angular ordering around the layer centroid, using the existing `display_centroid_x` / `display_centroid_y` fields.

This is similar to the existing "similar" ordering logic in `web/src/lib/sortClusters.js`.

This would make:

- nearby visible topic groups tend to have neighboring hues

It would still not be perfect semantics, but it would be much more legible than hash assignment.

#### Tone assignment

Instead of descendant tone = traversal order:

- tone = function of `layer`
- optionally modulate by `topic_specificity`

Examples:

- coarser topics use middle tones
- more specific children use lighter or darker variants within the same hue family

That would make tone interpretable.

#### Tree input cleanup

Use one clean semantic root layer for coloring when possible:

- prefer actual `maxLayer` roots
- only fall back to parentless nodes when a layered hierarchy does not exist

This removes mixed-level anchor assignment.

### Level 2: better semantic fix with backend support

Export a semantic centroid vector for each cluster.

The current cluster-label artifact can carry both:

- `display_centroid_x`
- `display_centroid_y`
- `semantic_centroid`
- `semantic_order`

The served scope lookup should stay lightweight, so it carries the display centroids used for map placement plus the small `semantic_order` scalar used for semantic hue ordering.

If we use the semantic centroid artifact for color ordering, then we can:

1. compute pairwise similarity between hue-layer clusters in semantic space
2. derive a 1D ordering of those clusters
3. quantize that order into the `8` Flexoki hue slots
4. keep descendants in-family via tone

Good ordering strategies include:

- spectral seriation
- MST / dendrogram leaf ordering
- simple greedy nearest-neighbor order

This would be the first version where color families are truly tied to topic relatedness rather than only map layout.


## Relationship Between Color And Neighboring Logic

A useful target model is:

- raw semantic neighbors: used for search and retrieval
- structural neighbors: used for branch/family coloring
- visual neighbors: used only as a weak proxy when semantic centroids are not available in the active client payload

Color should not try to represent exact nearest-neighbor search behavior.

That would be too much information for `8` hues.

Color should represent:

- branch family
- relative family proximity
- specificity/depth

That is the right compression level for human scanning.


## Current State vs Expected State

### Current state

- clustering is mostly hierarchy/branch driven
- map layout comes from display UMAP
- search neighbors come from raw embeddings
- colors come from Flexoki + hash/branch logic
- tone is order-driven rather than meaning-driven

### Expected state

- clustering remains hierarchy driven
- map layout remains display UMAP
- search neighbors remain raw-embedding based
- colors encode topic family and family proximity
- tone encodes depth and/or specificity
- hierarchy is the required scope shape rather than an optional enhancement


## Recommended Implementation Direction

### Immediate

Change `useClusterColors` to:

- stop using hash-based hue anchors
- order hue-layer nodes by centroid geometry
- assign adjacent Flexoki hues along that order
- assign tones by `layer` and optionally `topic_specificity`

This is the smallest change that will make colors feel meaningfully more aligned with the map.

### Next

Clean root selection in the hierarchy builder used by the frontend so color anchoring happens on a coherent level.

### Stronger version

Add semantic cluster centroid export from the pipeline and use that to derive hue ordering instead of `2D` geometry.


## Design Principle Going Forward

The map should not pretend that color equals exact topic distance.

The right semantic contract is:

- position suggests local neighborhood in the display projection
- hierarchy defines family structure
- search uses raw semantic vectors
- color compresses family structure into a small perceptual palette

If we implement that contract clearly, the product becomes more legible without overclaiming what any one encoding means.


## Appendix: Key Code Paths

### Pipeline and structure

- `latentscope/scripts/embed.py`
- `latentscope/scripts/twitter_import.py`
- `latentscope/scripts/umapper.py`
- `latentscope/scripts/build_hierarchy.py`
- `latentscope/scripts/toponymy_labels.py`
- `latentscope/pipeline/hierarchy.py`
- `latentscope/pipeline/stages/scope_materialize.py`

### Search / semantic neighbors

- `api/src/routes/search.ts`
- `web/src/hooks/useNearestNeighborsSearch.js`

### Frontend hierarchy and label logic

- `web/src/contexts/ScopeContext.tsx`
- `web/src/components/Explore/V2/DeckGLScatter.jsx`

### Color logic

- `web/src/lib/clusterColors.js`
- `web/src/hooks/useClusterColors.js`
- `documentation/flexoki.md`
