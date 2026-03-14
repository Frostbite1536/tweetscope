# Semantic Color Mapping Plan

Date: 2026-03-13

Status: Planning document

## Purpose

This document proposes a replacement for the current cluster-coloring approach.

The goal is to keep meaningful global color semantics while restoring stronger local differentiation between sub-clusters in the same family. The design is based on the paper _Semantic Color Mapping: A Pipeline for Assigning Meaningful Colors to Text_, the current Latent Scope import and rendering pipeline, real local-corpus calibration including `patio11-tweets`, and the product-specific browsing behavior of the app.

This is a planning document, not an implementation diff.

## Executive Summary

The main problem today is not clustering. It is where color semantics are decided.

Today:

- the import pipeline computes structure, labels, display centroids, and semantic centroids
- the served scope drops the full semantic centroids for size reasons
- the frontend then invents colors from hierarchy shape plus a small amount of semantic ordering

That means color is currently a frontend heuristic rather than a first-class semantic artifact.

This is why the current system gets one part right and one part wrong:

- it gives reasonable global hue meaning
- it does not give enough differentiation between siblings inside one hue family

The paper suggests the right architectural shift:

- choose the unit of analysis for color explicitly
- derive color semantics from stable semantic signals rather than UI heuristics
- persist the important semantic decisions
- render from that result consistently

For Latent Scope, the recommended target is:

1. make semantic color decisions an import-stage artifact after hierarchy collapse and renumbering
2. persist the chosen anchor layer and family ordering instead of selecting them ad hoc in the browser
3. use a hybrid mapping:
   - global hue family encodes stable high-level semantic grouping
   - local variation inside that family differentiates sibling or subfamily groups
4. use OKLCH as the computational space, with Flexoki acting as the bounded gamut and brand constraint
5. keep the first implementation simpler than the full paper pipeline unless evaluation proves a richer projection is necessary

## The Paper: Key Details That Matter

The paper argues that text visualization systems usually treat color as a categorical afterthought, even though color can help users compare related concepts, keywords, topics, and groups.

The key parts of the paper are:

### 1. Semantic color is a pipeline, not a final palette choice

The paper's pipeline is:

1. aggregate text at the right level
2. choose a vector representation
3. choose the unit of analysis
4. project the data into low-dimensional space
5. map the projected space into a color space

The important consequence is that color assignment is downstream of representation design. If the semantic object being colored is poorly chosen, the final colors will not be meaningful.

### 2. Unit of analysis is task-dependent

The paper treats unit-of-analysis choice as central.

Examples:

- document-level colors support corpus-wide thematic browsing
- topic-level colors support topic comparison
- keyword-level colors support descriptor analysis

For Latent Scope, the relevant units are hierarchical cluster nodes, because the app is a topic browser rather than a keyword cloud.

### 3. A 1D ordering may be enough for current anchor-layer sizes

The paper explicitly recommends a low-dimensional projection before color mapping. That matters here because the current system mostly reduces semantics to a 1D within-layer order, then spreads that order across a limited set of hues.

However, current anchor candidates are usually very small, often `3-11` groups. For those sizes, a deterministic `1D` semantic ordering can be sufficient for global hue assignment, especially because the repo already computes a semantic layer ordering from centroids.

That means:

- `1D` ordering is probably enough for the first anchor-layer implementation
- a richer `2D` projection should be treated as an optional later refinement, not a mandatory first step

### 4. Projection and color space must match when projection is used

The paper notes that if the projection shape and the color-space shape do not align, the system wastes the available color gamut and clusters bunch into visually weak regions.

That directly applies here when we choose to project. But it does not force every version of the system to use a `2D` projection. For the first version, the more important decision is to move out of frontend heuristics and into an explicit OKLCH-based family + subdivision model.

### 5. Local discriminability and global consistency trade off

The paper contrasts local methods like UMAP and t-SNE with more global methods like PCA and MDS. The practical takeaway is not that one is always better. It is that the color pipeline must support the task.

For us, that means the right design is hybrid:

- stable global semantics for browsing across the whole map
- stronger local discriminability among siblings

### 6. Color perception matters as much as semantic distance

The paper calls out:

- just noticeable difference issues
- uneven perceived saturation across hues
- cultural and accessibility concerns
- the need for user-selectable colormaps in some cases

For Latent Scope, this means we cannot say "semantic distance is enough". We need explicit contrast, legibility, and CVD-aware constraints.

### 7. Streaming and incremental stability matter when colors should persist

The paper recommends that if data is added over time, one should prefer stable projection strategies and sometimes aggregate projected coordinates instead of raw vectors to reduce color jumps.

Latent Scope is primarily offline today, so we do not need streaming-first design. But we do need rerun-to-rerun stability, because users build a mental model of topic families by color.

## Current Latent Scope Pipeline

### Current structural pipeline

The current structure is broadly sound.

Relevant references:

- `latentscope/scripts/build_hierarchy.py`
- `latentscope/pipeline/hierarchy.py`
- `latentscope/scripts/toponymy_labels.py`
- `documentation/cluster-labeling-and-toponymy-design.md`

Important current facts:

- embeddings are produced upstream and can already incorporate context using `voyage-context-3`
- hierarchy is built from a clustering manifold, not from the display `2D` UMAP
- Toponymy is naming-only on top of the saved hierarchy
- cluster labels persist hierarchy relationships, display centroids, semantic centroids, and a lightweight `semantic_order`

Concrete refs:

- hierarchy is built from `dim_*` clustering-manifold vectors in `latentscope/scripts/build_hierarchy.py:77-96`
- semantic ordering is computed in `latentscope/scripts/toponymy_labels.py:622-687`
- display and semantic centroids are stored in `latentscope/scripts/toponymy_labels.py:748-788`

### Current color pipeline

The current color pipeline is not import-stage semantic color mapping. It is client-side color inference.

Relevant references:

- `web/src/hooks/useClusterColors.js`
- `web/src/lib/clusterColors.js`
- `latentscope/pipeline/stages/scope_labels.py`

Important current facts:

- the full `semantic_centroid` is intentionally dropped from the served scope lookup in `latentscope/pipeline/stages/scope_labels.py:42-46`
- the frontend chooses the hierarchy layer whose cluster count is closest to the available hue count in `web/src/hooks/useClusterColors.js:74-107`
- that chosen layer is ordered by `semantic_order` if available, otherwise by display geometry or stable hash in `web/src/hooks/useClusterColors.js:110-150`
- colors are assigned by spreading that layer across eight hue slots in `web/src/hooks/useClusterColors.js:152-172`
- descendants inherit hue, and tone is mostly determined by depth plus a small `topic_specificity` shift in `web/src/hooks/useClusterColors.js:174-206`

That means:

- global hue meaning exists
- local sibling differentiation is weak whenever siblings share the same inherited hue family and similar depth

### Current render behavior

Relevant references:

- `web/src/components/Explore/V2/DeckGLScatter.jsx`
- `web/src/contexts/ScopeContext.tsx`

Important current facts:

- point fill colors come directly from `resolveClusterColor(...)` in `web/src/components/Explore/V2/DeckGLScatter.jsx:1406-1432`
- hull outlines use the same cluster color in `web/src/components/Explore/V2/DeckGLScatter.jsx:1455-1473`
- labels are mostly neutral text and only use cluster color when active in `web/src/components/Explore/V2/DeckGLScatter.jsx:1498-1508`
- the map shows one hierarchy cut at a time depending on zoom, not all levels at once
- top-level roots are important elsewhere in the product, not just on the map

## Business Logic The Color System Must Support

This is not a generic scatterplot. Color has to fit actual product behavior.

### 1. The map is a semantic browser

Relevant references:

- `web/src/components/Explore/V2/DeckGLScatter.jsx`
- `documentation/cluster-labeling-and-toponymy-design.md`

The map:

- shows one hierarchy cut based on zoom
- places only a subset of labels due to collision handling
- uses cumulative likes and counts to prioritize visible labels
- hard-hides points under some filters

Implication:

- color must remain meaningful when only some layers are visible
- color must survive label collision and partial visibility
- color must not depend on the currently visible subset

### 2. Selecting a topic means selecting its full descendant subtree

Relevant references:

- `web/src/hooks/useClusterFilter.js`

This is a core business rule, not a UI convenience.

Implication:

- a parent cluster and its descendants should visibly read as a family
- sibling differentiation must not break family resemblance

### 3. Topic directory and carousel are root-driven browse surfaces

Relevant references:

- `web/src/hooks/useTopicDirectoryData.js`
- `web/src/hooks/useCarouselData.js`
- `web/src/contexts/ScopeContext.tsx`

These features treat top-level roots as browseable topic groups and load per-root feeds.

Implication:

- top-level or browse-layer color meaning must be stable and not arbitrary
- if global hue meaning shifts per rerun, the directory and carousel become harder to learn

### 4. Thread-aware browsing is a first-class mode

Relevant references:

- `web/src/hooks/useNodeStats.ts`
- `web/src/lib/groupRowsByThread.js`
- `web/src/contexts/FilterContext.jsx`
- `web/src/components/Explore/V2/VisualizationPane.jsx`

The app supports a `Threads only` filter and thread grouping.

Implication:

- colors must remain stable under subset filtering
- colors cannot be recomputed from only the currently visible points
- labels and hulls must still make sense when thread filtering hides many nodes

### 5. Unknown or unclustered points are explicit

Relevant references:

- `latentscope/pipeline/stages/scope_labels.py`
- `web/src/lib/clusterColors.js`

Implication:

- `unknown` must remain visually distinct from semantic families
- `unknown` should not consume a meaningful hue family

## Why We Use Flexoki, And What Must Be Preserved

Relevant reference:

- `documentation/flexoki.md`

Important Flexoki principles from the doc:

- it is inky, warm, and paper-oriented, not neon or synthetic
- it is designed for reading and writing on screens
- it is minimalistic and high-contrast
- it aims for perceptual balance across light and dark modes
- it is derived from Oklab-style perceptual relationships, not arbitrary RGB picks
- it avoids the trap of perfect evenness if that makes colors washed out and hard to parse

Concrete refs:

- the palette is described as inky and paper-inspired in `documentation/flexoki.md:5-8`
- the palette is described as perceptually balanced across light and dark in `documentation/flexoki.md:7-8`
- the "Why?" section explicitly mentions CIELAB/Oklab and the tradeoff between perceptual consistency and practical distinctiveness in `documentation/flexoki.md:167-172`

### What this means for cluster colors

Using Flexoki "in principle" should mean:

- preserve the warm paper/ink feel
- preserve good light/dark mode correspondence
- preserve readable contrast against backgrounds
- preserve family resemblance of the named hues
- avoid drifting into generic saturated rainbow colors

It should not mean:

- we are forced to use only a fixed hard-coded `6 x 8` table forever
- we are forbidden from deriving additional in-family colors inside a constrained Flexoki-compatible Oklab/OKLCH region

The important distinction is:

- Flexoki as brand and perceptual design constraint: yes
- Flexoki as an immutable 48-cell category table: no

### Practical Flexoki constraints for this project

1. The eight named hue families remain the global anchors.
2. Backgrounds stay neutral and warm, not colorized.
3. Label text should remain neutral unless contrast is explicitly validated.
4. Cluster colors should be generated in a perceptual space, then checked against light and dark backgrounds.
5. `unknown` remains neutral or warm-stone, not semantically loaded.

## General Color Design Requirements

These are not unique to the paper, but they need to be explicit in the implementation plan.

### 1. Text contrast

For any text that uses cluster color directly:

- normal text must target at least `4.5:1` contrast against its background
- large text can target `3:1`, but DeckGL labels are often not large enough to rely on that

Implication:

- keep default label text neutral
- if cluster color is used in labels, use it as a chip, bullet, underline, or accent first
- only use colored text when the specific foreground/background pair passes contrast checks

### 2. Non-text contrast

For hull strokes, swatches, and any other non-text element relied on for meaning:

- target at least `3:1` contrast against the immediate background where possible

Implication:

- some Flexoki yellows and lighter tones will not be strong enough for fine strokes on paper backgrounds unless darkened or outlined

### 3. Do not rely on hue alone for state

Selection, hover, and active state should stay orthogonal to semantic color.

That is already mostly true today:

- hover uses outline/stroke
- highlight uses a separate blue outline
- alpha changes reflect filtering state

Implication:

- semantic cluster color should not also carry transient interaction state

### 4. Local discrimination must survive alpha blending

Scatterplots are dense and semi-transparent. Colors that look distinct as swatches can collapse visually when:

- alpha is low
- points overlap heavily
- points are small
- hull strokes are thin

Implication:

- evaluate colors in rendered density conditions, not just as isolated palette chips
- reserve the weakest tones for larger marks or secondary roles

### 5. Family resemblance and sibling separability are both required

This is the core design tension:

- parent and child should read as related
- siblings should still be tellable apart

The current system overweights family resemblance.
The old system over-weighted local separability.
The target system must do both.

### 6. Color vision deficiency must be considered

Implication:

- avoid relying on red vs green alone for critical distinctions
- use lightness/chroma differences inside a family, not just tiny hue differences
- where needed, pair color with a secondary cue on labels or hulls

### 7. Stability matters

Users learn families by color over time.

Implication:

- minor reruns should not randomly reshuffle all colors
- the mapping must be deterministic and seeded from stable lineage inputs

## Proposed Target Architecture

## Principle

Color becomes a precomputed semantic artifact generated offline from the final hierarchy, not a client-only heuristic.

### High-level design

1. build the final hierarchy as today
2. build the final named hierarchy as today
3. after collapse and renumbering, compute semantic color coordinates for the final surviving hierarchy nodes
4. persist those coordinates and the resolved cluster color metadata
5. serve lightweight color fields in `cluster_labels_lookup`
6. make the frontend consume color metadata rather than derive it from scratch

### Why after collapse and renumbering

The UI browses the post-collapse hierarchy, not the raw pre-collapse hierarchy.

If color is computed before collapse:

- colors may be assigned to nodes the user never sees
- parent/child relationships used by the color logic may not match the final structure

Therefore the color stage should run on the final cluster-label artifact after collapse and renumbering.

## Data Calibration Against Real Corpora

The plan needs to match the actual corpus range we expect, not just the paper.

The stated product range is roughly `2k` to `300k` tweets.

I manually checked the currently available local generated scopes plus the existing large-scale `visakanv` baseline documented elsewhere in the repo.

### Local generated scopes checked

Data root:

- `/Users/sheikmeeran/latent-scope-data`

Datasets with generated hierarchy + labels + scope:

- `ivanvendrov`
- `cube_flipper`
- `defenderofbasic`
- `patio11-tweets`

Observed scope sizes:

- `ivanvendrov`: `1,349` rows
- `cube_flipper`: `6,649` rows
- `defenderofbasic`: `23,295` rows
- `patio11-tweets`: `62,058` rows

Observed final served hierarchy shapes after collapse:

- `ivanvendrov`: `{0: 41, 1: 5, 2: 5}`
- `cube_flipper`: `{0: 171, 1: 32, 2: 11, 3: 5}`
- `defenderofbasic`: `{0: 512, 1: 47, 2: 56, 3: 25, 4: 6}`
- `patio11-tweets`: `{0: 1381, 1: 206, 2: 40, 3: 9, 4: 3}`

Observed top/max-layer root counts in the served scopes:

- `ivanvendrov`: `5`
- `cube_flipper`: `5`
- `defenderofbasic`: `6`
- `patio11-tweets`: `3`

Observed `unknown` rates in the served scopes:

- `ivanvendrov`: `272 / 1,349` (`20.2%`)
- `cube_flipper`: `1,131 / 6,649` (`17.0%`)
- `defenderofbasic`: `5,621 / 23,295` (`24.1%`)

Observed leaf-cluster occupancy:

- `ivanvendrov`: median `13`, p90 `46.4`, max `166`
- `cube_flipper`: median `16`, p90 `39.4`, max `527`
- `defenderofbasic`: median `17`, p90 `45.3`, max `1,075`

Observed widest sibling groups:

- `ivanvendrov`: `8`
- `cube_flipper`: `13`
- `defenderofbasic`: `22`
- `patio11-tweets`: `82`

Observed patio11-specific browse pressure:

- the `3` top-layer roots are semantically plausible: `Japan banking`, `Thanks & Confirmations`, `Bootstrapped SaaS`
- those roots have attached child counts of `82`, `33`, and `60`
- layer `3` contains `9` nodes and is a more practical color-anchor candidate than the `3`-node root layer
- two layer-`3` nodes are detached from any top-layer root: `VaccinateCA: California vaccine availability` and `Strategy and simulation games`

These numbers matter for color design:

- root/family count is small on several corpora, but that does not mean the root layer is always the best color anchor
- `patio11-tweets` is the important counterexample: a semantically correct `3`-root hierarchy still underuses the available hue space
- the real pressure points are both:
  - under-full root layers that waste hue families
  - very wide sibling sets inside one family
- the `82`-child patio11 case means color cannot encode unique identity for every sibling under one parent

### Large-scale baseline already documented in the repo

Relevant reference:

- `documentation/cluster-labeling-and-toponymy-design.md`

Documented `visakanv` baseline:

- dataset size: `259,083`
- post-collapse hierarchy counts: `{0: 4874, 1: 729, 2: 145, 3: 37, 4: 11, 5: 4, 6: 1}`
- `unknown`: `146,315` rows (`56.47%`)

Important correction:

- those `visakanv` numbers are explicitly documented elsewhere in the repo as the pre-PLSCAN baseline being replaced
- they are useful as evidence about large-corpus scale pressure, over-fragmentation, and `unknown`
- they should not be treated as evidence that the current post-refactor PLSCAN root policy should or will collapse to a single root

So the correct takeaway is narrower:

- the old baseline shows that large corpora can create severe color pressure at lower layers
- it does not imply that the color anchor must always be the final root layer

### Resulting implementation guidance from the data

1. Root-level global families are often a good default, but they are not a safe invariant.
2. The system needs an explicit persisted anchor-layer policy that scores every surviving layer after collapse.
3. A semantically correct root layer may still be a poor color anchor; patio11 is the motivating case.
4. Tone-only sibling differentiation is not enough for the observed wide sibling groups:
   - `8` siblings already fully consume the available named hue families if we try to separate them categorically
   - `13` and `22` siblings are beyond what a simple fixed lightness ladder can clearly separate
   - `82` siblings are beyond what color alone can represent as unique identities
5. The local mapping must therefore support:
   - lightness variation
   - chroma variation
   - narrow intra-family hue drift when sibling counts are high
   - explicit fallback from sibling identity to family/subfamily meaning when fanout is extreme
   - secondary UI cues for the widest sibling groups

## Proposed Semantic Units

### Global color unit

The global color unit should be an explicit `color anchor layer`, persisted in metadata.

This should usually be:

- the highest browse layer with a practical number of semantic families, ideally around `4-10`

It should not be:

- "whichever layer happens to be closest to eight hues" in the browser

Data-calibrated rule:

- score every surviving layer after collapse and renumbering
- prefer layers with `4-10` connected, semantically meaningful browse groups
- prefer layers that are stable across reruns and not dominated by detached nodes
- prefer the final root layer only when it actually satisfies those constraints
- allow a lower persisted anchor layer without treating the root structure as automatically wrong

If necessary, hierarchy tuning should be used to make this layer product-appropriate.

### Local color unit

The local color unit should be the set of sibling clusters under a single parent.

This solves the actual sub-cluster problem:

- parent gives stable family meaning
- sibling-local projection gives within-family differentiation

Important refinement:

- when a parent has extreme fanout, color should be allowed to encode family or subfamily, not unique identity for every child
- a denser descendant layer may be used as a practical subfamily anchor when the direct sibling set is too wide

## Proposed Data Model

Because backward compatibility is not required, the data contract can be cleaned up.

Each final cluster label should carry:

- `color_anchor_layer`: integer, dataset-level
- `color_family_id`: stable integer or token for the global Flexoki hue family
- `color_family_rank`: normalized position within the global semantic ordering
- `color_local_rank`: optional normalized rank within the parent family or subfamily
- `color_subfamily_id`: optional stable token for high-fanout parents
- `color_oklch_l`
- `color_oklch_c`
- `color_oklch_h`
- `color_light_rgb`
- `color_dark_rgb`
- `color_version`

Optional debug-only fields:

- `color_anchor_source`
- `color_parent_family_id`
- `color_assignment_method`
- `color_contrast_flags`

The served scope lookup should include the lightweight fields needed for rendering and debugging, not the full semantic centroid vectors.

## Proposed Color Algorithm

The recommended `v1` is intentionally simpler than the paper's full projection pipeline. Current anchor candidates are small, and the main product problem is local sibling discrimination, not recovering a rich global geometry for dozens of families.

### Stage 1. Start from final hierarchy nodes and existing semantic signals

Start from the final surviving hierarchy nodes after collapse and renumbering.

Preferred semantic inputs:

- the cluster semantic centroid already available from the embedding space
- the existing per-layer `semantic_order` already computed from those centroids

Initial recommendation:

- use the existing semantic centroids first
- use existing `semantic_order` as the default global ordering signal
- do not add keyword-embedding color as a first implementation dependency

### Stage 2. Choose and persist the anchor layer

Persist a single explicit layer for global family assignment.

Scoring rule:

- score every surviving layer after collapse
- prefer a layer with `4-10` connected, semantically meaningful browse groups
- prefer layers already used as primary browse groups in the product
- prefer low orphan pressure and rerun stability over perfect hue utilization
- prefer the final root layer only when it actually scores well

Why this is necessary:

- patio11 has a semantically plausible `3`-root top layer that is too small to use the available hue space well
- the current frontend would choose layer `3` there because `9` groups are closer to the eight available hue families than `3`

### Stage 3. Assign global hue families

Map the chosen anchor-layer order to the eight Flexoki hue families.

Recommended `v1` ordering:

- sort anchor nodes by `semantic_order` when available
- if `semantic_order` is missing or obviously poor for a dataset, derive a deterministic `1D` order from semantic centroids using PCA or seriation
- keep the mapping stable and monotonic across that order

It should not be:

- hash-based
- arbitrary by cluster id
- dependent on the current visible subset

Optional later evaluation:

- only add a richer `2D` anchor projection plus shape fitting if `1D` ordering repeatedly produces bad semantic adjacency on real corpora

### Stage 4. Subdivide inside each family in OKLCH

Use OKLCH as the explicit computational color space.

Design rule:

- treat Flexoki as the bounded OKLCH gamut and anchor-hue system
- keep the parent family hue as the base hue
- vary lightness and chroma first
- allow only narrow hue drift inside a family wedge when needed

Recommended `v1` subdivision strategy:

- use a tree-aware recursive subdivision scheme, such as Tree Colors or an equivalent bounded OKLCH variant
- preserve family resemblance by construction
- keep the implementation simple enough to compare against current behavior without introducing a full projection pipeline first

Data-calibrated sibling rule:

- if a parent has `<= 6` children, stay within lightness/chroma whenever possible
- if a parent has `7-12` children, expect to use a small amount of intra-family hue drift
- if a parent has `> 12` children, treat color as under strain and plan on both wider intra-family spread and secondary cues
- if a parent has very large fanout, such as patio11's `82`-child case, do not expect color to uniquely identify every sibling; use color for family or subfamily meaning instead

### Stage 5. Resolve final colors for light and dark mode

The semantic identity should be mode-agnostic.

`v1` recommendation:

- persist both OKLCH coordinates and resolved `color_light_rgb` / `color_dark_rgb`
- derive the RGB variants offline from the same semantic coordinates used everywhere else

Why choose this for `v1`:

- DeckGL and the current UI already expect RGB arrays in many places
- it keeps the frontend transition small
- it avoids introducing a new JS color-conversion dependency during the first rollout

Constraint:

- theme switching must preserve family identity because both modes come from the same semantic coordinates

### Stage 6. Validate contrast and separation

For every resolved color:

- check text-safe contrast if it will ever be used for text
- check non-text contrast for hulls and swatches
- check minimum sibling separation within the same family
- check minimum family separation at the anchor layer
- check real map conditions such as alpha blending and dense overplotting

If a color fails:

- adjust local `L/C` placement
- widen the allowed family spread within bounds
- clamp to a more contrast-safe subrange
- or explicitly fall back to secondary cues because the fanout exceeds what color can represent

## Frontend Changes

The frontend should stop inventing semantic color structure.

### What the frontend should still do

- read precomputed semantic color metadata
- optionally resolve final theme-specific RGB from persisted OKLCH coordinates in the first implementation
- apply interaction state on top of semantic color
- render points, hulls, swatches, and active label accents
- preserve label readability by keeping default label text neutral

### What the frontend should stop doing

- choosing the anchor layer dynamically
- assigning semantic families from client-only heuristics
- falling back to hash-like semantic assignment for disconnected nodes
- deriving most meaning from depth-only tone shifts

### Recommended label treatment

Keep normal label text neutral for readability.

Use cluster color for:

- active label text if contrast-safe
- label chip background if contrast-safe
- a left rule, bullet, or swatch beside the label

This preserves the paper/ink reading feel while still making the semantic family visible.

## Edge Cases And Failure Modes

### 1. Too few anchor-layer groups

If the anchor layer has only `1-3` groups:

- global hue semantics will underuse the available hue families
- local subcluster differences will carry more of the burden

Mitigation:

- do not treat this as automatically wrong
- allow a lower persisted anchor layer if it gives a better `4-10` group browse cut
- roots can remain the top-level browse units even when the color anchor is lower

### 2. Too many anchor-layer groups

If the anchor layer has far more than eight groups:

- some semantic families will have to share a Flexoki hue family

Mitigation:

- use hierarchy tuning to produce a practical browse layer
- if necessary, let the anchor layer be distinct from the absolute top layer

### 3. Parents with many children

If a parent has many siblings in one family:

- lightness/chroma spacing may be too tight
- some siblings will remain hard to distinguish
- at extreme fanout, color cannot encode unique identity for every child

Mitigation:

- allow narrow hue drift within the family wedge
- optionally derive coarse subfamilies from a denser descendant layer
- reserve stronger variation for visible or important siblings
- use a secondary cue for label chips or hulls if required

Data note:

- this is not hypothetical; current local scopes already contain sibling groups of `8`, `13`, `22`, and `82`
- the `22`-child case means a pure fixed-tone strategy is already known to be inadequate
- the `82`-child patio11 case means color must degrade to family or subfamily meaning rather than pretend to carry unique identity

### 4. Single-child chains

These should not consume local color logic after collapse.

Mitigation:

- compute colors only after collapse and renumbering

### 5. Uneven hierarchy depths

Some branches may skip levels after collapse.

Mitigation:

- color inheritance must be based on actual parent relationships in the final hierarchy, not assumed depth symmetry

### 6. Orphan or malformed hierarchy nodes

The repo already has logic for orphan handling and detached roots.

Mitigation:

- color logic must tolerate detached roots
- anchor selection should operate on the persisted final hierarchy, not ad hoc client root inference
- any node without a valid parent should either become an explicit fallback family or inherit from a persisted subfamily rule, rather than silently poisoning anchor selection

### 7. Missing semantic vectors

Some nodes may lack semantic centroids in exceptional cases.

Mitigation:

- fallback to deterministic placement based on label id
- mark such clusters as low-confidence in debug output

### 8. Unknown cluster

`unknown` must not join a semantic family.

Mitigation:

- keep `unknown` on a neutral or warm-stone track outside the semantic family mapping

### 9. Thread-only and subset filtering

Visible subsets should not change color assignment.

Mitigation:

- semantic color assignments are derived from the full scope hierarchy and persisted before rendering
- frontend filters only hide/show, never recolor

### 10. Alpha and dense overplotting

Some sibling differences may disappear on the actual map.

Mitigation:

- test palette separation under real alpha and point-size conditions
- use hulls and label accents as higher-salience family markers

### 11. Light and dark mode mismatch

A color that works on paper may wash out on dark ink backgrounds, or vice versa.

Mitigation:

- derive final mode-specific colors from the same semantic coordinates
- validate contrast and visual spread in both themes independently

### 12. Interaction-state collisions

Current highlight uses a blue accent and hover uses stroke changes.

Mitigation:

- keep selection and highlight styling orthogonal to semantic cluster color
- ensure no semantic family looks too similar to the active highlight stroke

## Potential Regressions

### 1. Global meaning gets weaker again

If local sibling variation is too strong, the family relationship can disappear.

Guardrail:

- keep hue family stable and dominant
- put most local variation into lightness/chroma before hue drift

### 2. Rerun instability

If the projection or fitting is not deterministic, colors may reshuffle between imports.

Guardrail:

- deterministic projection
- deterministic normalization
- deterministic family assignment
- seed from stable lineage ids where needed

### 3. Over-designed palette that stops feeling like Flexoki

If the local color generation roams too far, the app will lose its visual identity.

Guardrail:

- define a bounded Flexoki-compatible color volume
- validate new colors against the existing theme surfaces

### 4. Frontend complexity moves instead of shrinking

If the browser still keeps a lot of fallback inference logic, the system will remain hard to reason about.

Guardrail:

- move semantics offline
- keep the frontend as a consumer and renderer

### 5. Artifact size grows too much

If we persist too much debug geometry or full centroids in served scope JSON, payloads will grow unnecessarily.

Guardrail:

- serve only lightweight color metadata
- keep full semantic vectors only in offline artifacts

### 6. Text readability degrades

If label text becomes colorized too aggressively, yellow/orange families may fail contrast on paper backgrounds.

Guardrail:

- default neutral text
- colorized chips/swatch accents first

## Validation Plan

### Quantitative checks

1. Measure minimum pairwise distance between sibling colors within each parent family.
2. Measure minimum pairwise distance between anchor-layer family colors.
3. Check text contrast for any label/text usage.
4. Check non-text contrast for hull strokes and chips.
5. Compute rerun stability on the same dataset and params.
6. Report sibling-group size versus achieved color separation, especially for parents with `> 6` children.
7. Report anchor-layer family count and whether the chosen anchor is the final root layer or a lower persisted layer.
8. Report why the chosen anchor differs from the final root layer when that happens.

### Product checks

1. Can a user quickly identify that two visible subclusters belong to the same top-level family?
2. Can a user tell siblings apart without clicking?
3. Does the topic directory feel globally learnable by color?
4. Does `Threads only` preserve color meaning?
5. Does dark mode preserve the same family relationships?

### Visual checks

Use at least:

- overview zoom
- mid zoom where one hierarchy cut dominates
- deep zoom with many sibling clusters visible
- dense cluster regions with alpha blending
- sparse regions with hulls and labels

Use at least these corpus sizes:

- small: `ivanvendrov` (`1,349`)
- medium: `cube_flipper` (`6,649`)
- larger current local: `defenderofbasic` (`23,295`)
- large current local: `patio11-tweets` (`62,058`)
- optional large baseline from existing reports/docs: `visakanv` (`259,083`)

## Detailed Implementation Plan

### Phase 0. Lock the `v1` contract before coding

Make the following `v1` decisions explicit so implementation does not stall on open design churn:

- anchor-layer target range: keep `4-10` groups as the preferred band
- sibling thresholds: keep the existing `<= 6` and `7-12` policy, and add an explicit high-fanout fallback tier above that
- RGB strategy: persist both OKLCH and resolved light/dark RGB in the label artifact and served scope lookup
- fallback strategy: keep legacy client-side coloring only for scopes that have not yet been regenerated with semantic color metadata

This phase should produce:

- one versioned config object for color generation
- one versioned list of served label fields
- one short calibration note for why patio11 selects a lower anchor layer than its `3`-root top layer

### Phase 1. Add a pure Python semantic-color module

Add a new backend module, preferably `latentscope/pipeline/colors.py`, so the color algorithm lives outside `toponymy_labels.py` and can be tested independently.

The module should expose pure functions for:

- loading the final hierarchy rows into parent/child and layer indexes
- scoring layers and selecting the persisted anchor layer
- assigning anchor families from `semantic_order`, with PCA or seriation fallback only when needed
- subdividing within a family in bounded OKLCH
- resolving light and dark RGB variants
- validating separation and contrast, returning flags rather than mutating UI code

Implementation constraint:

- keep the API DataFrame-in/DataFrame-out or list-of-dicts-in/list-of-dicts-out so it can be called from `toponymy_labels.py` without changing the rest of the labeling pipeline

### Phase 2. Integrate color generation into cluster-label artifact writing

The natural insertion point is in `latentscope/scripts/toponymy_labels.py` after `build_hierarchical_labels(...)` returns collapsed and renumbered rows, but before `save_hierarchical_labels(...)` writes the parquet and JSON artifacts.

Concrete steps:

- keep `build_hierarchical_labels(...)` responsible for structural fields and semantic centroids
- add a post-processing call such as `apply_semantic_colors(hierarchical_labels, color_config)`
- write the resulting per-cluster `color_*` fields into the parquet artifact
- extend the cluster-label metadata JSON written by `save_hierarchical_labels(...)` with dataset-level color metadata such as:
  - `color_version`
  - `color_anchor_layer`
  - `color_anchor_reason`
  - `color_algorithm`
  - `color_config`

Important constraint:

- do not drop `semantic_centroid` from the parquet artifact, because it remains the offline source of truth for future recalculation and debugging

### Phase 3. Pass the new fields through scope serving with minimal churn

The serving path already reads the cluster-label parquet in `latentscope/pipeline/scope_runner.py` and turns it into `cluster_labels_lookup` through `latentscope/pipeline/stages/scope_labels.py`.

Concrete steps:

- keep dropping `indices` and `semantic_centroid` in `build_cluster_labels_lookup(...)`
- preserve the new `color_*` fields in the served lookup rows
- keep dataset-level color metadata in the existing `scope_meta["cluster_labels"]` object unless a second top-level block becomes necessary
- do not add color data to the scope input parquet; this change only needs label lookup metadata

This keeps the serving cutover small:

- point rows continue to carry only `cluster` and `label`
- all cluster-color semantics stay attached to the label lookup where hierarchy data already lives

### Phase 4. Replace frontend inference with a lookup-based color map

The main frontend cutover point is `web/src/hooks/useClusterColors.js`. It should stop choosing layers and assigning hues, and instead build a map from persisted `color_light_rgb` / `color_dark_rgb`.

Concrete steps:

- extend `web/src/api/types.ts` `ClusterLabel` with the new `color_*` fields
- rewrite `useClusterColors(...)` so its primary path is:
  - read persisted color metadata from `clusterLabels`
  - build `colorMap`
  - fall back to the legacy heuristic only if the metadata is absent
- keep the existing `resolveClusterColor(...)` interface so call sites in:
  - `web/src/components/Explore/V2/DeckGLScatter.jsx`
  - `web/src/pages/V2/FullScreenExplore.jsx`
  - `web/src/components/Explore/V2/TopicDirectory/TopicDirectory.jsx`
  - `web/src/components/Explore/V2/Search/SearchResults.jsx`
  - `web/src/components/Explore/V2/TweetFeed/TweetCard.jsx`
  do not need structural changes
- keep `web/src/lib/clusterColors.js` only as the legacy fallback and `unknown` color source during the transition

### Phase 5. Keep old scopes rendering while new scopes are regenerated

Because existing scopes do not yet carry `color_*` fields, the rollout should be deliberately two-stage.

Stage A:

- land backend generation and frontend read-path with fallback still enabled
- regenerate representative scopes
- verify that newly generated scopes use persisted color metadata while old scopes still render through the legacy path

Stage B:

- once the active scopes have been regenerated, remove dynamic semantic family inference from the browser
- leave only a narrow non-semantic fallback for malformed or incomplete label payloads

This avoids a flag day and prevents the doc's new policy from requiring immediate bulk migration before the UI still works.

### Phase 6. Add focused tests around the pure functions and pass-through logic

Backend tests should be expanded in three places:

- add a new test file, preferably `latentscope/tests/test_semantic_colors.py`, for:
  - anchor-layer scoring
  - family assignment from `semantic_order`
  - high-fanout fallback behavior
  - OKLCH-to-RGB resolution and contrast flags
- extend `latentscope/tests/test_toponymy_labels.py` to verify that color metadata is attached after collapse and renumbering
- extend `latentscope/tests/test_scope_labels.py` to verify that `semantic_centroid` is still dropped but `color_*` fields survive into `cluster_labels_lookup`

Frontend tests should stay lightweight:

- add a small test next to `web/src/hooks/useClusterColors.js` or a tiny helper module extracted from it
- cover the persisted-color happy path and the legacy-fallback path

### Phase 7. Regenerate and validate the calibration scopes

Before removing the legacy allocator, rerun the pipeline for:

- `ivanvendrov`
- `cube_flipper`
- `defenderofbasic`
- `patio11-tweets`

For each regenerated scope, capture:

- chosen anchor layer
- number of anchor groups
- widest sibling group
- number of high-fanout parents that fell back to subfamily treatment
- a small screenshot set for light and dark mode

`patio11-tweets` is the required gate here. If the regenerated scope still fails obvious browse-level sanity checks, do not proceed to cleanup.

## Rollout Plan

### Phase 1. Design and calibration

- add patio11-based calibration to the decision rules
- finalize the anchor-layer scoring policy
- define the Flexoki-bounded OKLCH volume and contrast gates

### Phase 2. Lightweight prototype

- prototype anchor selection plus OKLCH family subdivision against current scopes
- reuse existing `semantic_order` first before adding richer projection machinery
- compare against current behavior on representative corpora, including patio11

### Phase 3. Persist semantic metadata

- write anchor-layer and family metadata from final hierarchy nodes
- persist OKLCH coordinates plus resolved light/dark RGB
- keep the served label contract small, but make `v1` fully consumable without frontend color conversion

### Phase 4. Frontend integration

- remove client-side semantic family inference
- consume persisted semantic color metadata
- keep interaction-state rendering

### Phase 5. Validation and tuning

- evaluate family coherence
- evaluate sibling discriminability
- tune lightness/chroma bounds and any narrow hue drift policy

### Phase 6. Cleanup

- remove obsolete `semantic_order`-driven color heuristics from the browser
- keep only the debug fields still useful for inspection

## Explicit Decisions Recommended For Implementation

1. Make import-stage semantic color metadata the source of truth.
2. Compute semantic color decisions after hierarchy collapse and renumbering.
3. Persist an explicit anchor layer rather than selecting it in the browser.
4. Allow the anchor layer to differ from the top-level roots when the data warrants it.
5. Use OKLCH as the computational space and Flexoki as the bounded perceptual gamut.
6. Persist both OKLCH coordinates and resolved light/dark RGB in `v1`.
7. Use global family semantics plus sibling or subfamily differentiation.
8. Treat extreme fanout as a design limit, not as something color alone can solve.
9. Keep default label text neutral unless contrast-safe.
10. Keep `unknown` outside semantic family assignment.

## Open Questions

1. Is Tree Colors-style subdivision sufficient, or do some corpora later justify a richer local projection step?
2. What explicit fanout thresholds should switch the meaning from sibling identity to family or subfamily identity?
3. Do we want to expose alternate semantic colormaps later for accessibility, or keep Flexoki-only for now?
4. Should label chips or bullets become the default way to expose cluster color in text surfaces?
5. After the transition, should we keep both OKLCH and RGB in the served payload, or trim one if size becomes a problem?

## References

### Paper

- _Semantic Color Mapping: A Pipeline for Assigning Meaningful Colors to Text_
- Especially relevant sections:
  - Abstract
  - Section 3.1 Aggregation Level & Vector Representations
  - Section 3.2 Unit of Analysis & Projection Methods
  - Section 3.3 Color Mapping
  - Section 5.1 Design Considerations
  - Section 5.2 Best Practices

### Local docs

- `documentation/flexoki.md`
- `documentation/cluster-labeling-and-toponymy-design.md`
- `documentation/voyage-context.md`

### Pipeline and serving code

- `latentscope/scripts/build_hierarchy.py`
- `latentscope/pipeline/hierarchy.py`
- `latentscope/scripts/toponymy_labels.py`
- `latentscope/pipeline/stages/scope_labels.py`

### Frontend behavior

- `web/src/hooks/useClusterColors.js`
- `web/src/lib/clusterColors.js`
- `web/src/components/Explore/V2/DeckGLScatter.jsx`
- `web/src/contexts/ScopeContext.tsx`
- `web/src/hooks/useClusterFilter.js`
- `web/src/hooks/useTopicDirectoryData.js`
- `web/src/hooks/useCarouselData.js`
- `web/src/hooks/useNodeStats.ts`
- `web/src/lib/groupRowsByThread.js`
