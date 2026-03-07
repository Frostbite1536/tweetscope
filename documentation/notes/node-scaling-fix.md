# Node Scaling Fix — Plan & Rationale

## The Problem (in plain terms)

When you look at the scatter plot, a handful of viral tweets appear as huge circles that visually eat their neighbors. The size difference between a quiet tweet and a viral tweet is so extreme that the map becomes "about the big dots" instead of "about the cluster structure." This happens regardless of account size or dataset size — the scaling formula amplifies engagement differences too aggressively.

---

## How Node Sizing Works Today

There are three stages that determine how big a dot appears on screen.

### Stage 1: Base radius from dataset size

```
calculateBaseRadius(pointCount)
```

This sets a starting dot size based on how many tweets are in the dataset. More tweets = smaller base dot so they don't all overlap.

| Dataset size | Base radius |
|---|---|
| 2,000 tweets | 2.3 px |
| 10,000 tweets | 1.93 px |
| 50,000 tweets | 1.29 px |
| 300,000 tweets | 0.8 px |

**Verdict: This is fine.** It's a gentle curve that gives breathing room to small datasets and keeps large datasets readable.

### Stage 2: Normalizing engagement into a 0-1 signal

Each tweet has an engagement score:

```
engagement = likes + retweets × 0.7 + replies × 0.45
```

Then three transforms happen:
1. **log1p** — compresses the huge numeric range (a tweet with 300K likes and one with 5 likes differ by 60,000x raw, but only ~7x after log)
2. **Winsorization (p3–p97)** — clips outliers at both ends so one mega-viral tweet doesn't warp the whole scale
3. **Percentile rank** — converts to "where does this tweet sit relative to others in this dataset?" (0.0 = bottom, 1.0 = top)

**Verdict: This is fine.** The percentile rank is the key insight — it makes the system self-adapting. A 500-like tweet in a small account lands at the same percentile as a 300K-like tweet in a large account. No tuning needed per account.

### Stage 3: Mapping the signal to a size multiplier (THE PROBLEM)

The normalized signal gets turned into an `importanceFactor` that multiplies the base radius. Currently this uses **three additive terms**:

```js
importanceFactor  = 0.55;                              // floor
importanceFactor += Math.pow(mag01, 0.8) * 1.6;        // Term A: absolute value signal
importanceFactor += pctCurve * 2.2;                     // Term B: percentile rank signal
importanceFactor += Math.pow(tailPct, 1.1) * 2.4;      // Term C: extra bonus for top 10%
```

The range is **0.55 to 6.85** — a **12.5x ratio** in radius.

#### Why this is broken

All three terms measure the same underlying thing (how popular is this tweet) from slightly different angles. But they're not independent — a viral tweet scores high on ALL THREE simultaneously. They compound at the top end:

| Tweet | Term A | Term B | Term C | Total factor |
|---|---|---|---|---|
| p5 (quiet) | 0.08 | 0.04 | 0.00 | **0.67** |
| p50 (median) | 0.93 | 0.86 | 0.00 | **2.34** |
| p99 (viral) | 1.54 | 2.17 | 2.10 | **6.36** |

The viral tweet's radius is **9.5x** the quiet tweet's. Since your eye perceives **area** (circle area = r^2), the viral tweet looks **90x larger**. That's why it dominates the map.

#### Concrete pixel sizes today

| | Quiet tweet (p5) | Median tweet | Viral tweet (p99) |
|---|---|---|---|
| 2k dataset | 1.5 px radius, 3 px diameter | 5.4 px, 11 px | **14.6 px radius, 29 px diameter** |
| 300k dataset | 0.5 px, 1 px | 1.9 px, 4 px | **5.1 px, 10 px** |

A 29-pixel-diameter circle at overview zoom is a blob that covers dozens of neighbors.

---

## The Fix

Two parts: (A) fix the base formula, and (B) optionally add a hybrid zoom-compression layer on top.

### Part A — Replace the importance formula (required)

Replace the three-term formula with a single curve based on percentile rank.

#### New formula

```js
const pct01 = clamp(pct, 0, 1);
const importanceFactor = 0.70 + Math.pow(pct01, 1.25) * 2.10;
// range: 0.70 → 2.80 (4.0x ratio, ~16x area ratio)
```

#### Why this specific curve

- **`pct^1.25`**: A power slightly above 1.0 creates a gentle curve. Most tweets (p20–p60) cluster together in size. Differentiation concentrates in the upper range (p70–p99) where it's meaningful — you want to spot "which tweets stood out," not fine-grade quiet tweets.
- **Floor of 0.70**: Ensures even the quietest tweet is still clearly visible (not a sub-pixel dot).
- **Ceiling of 2.80**: The most viral tweet is 4x the radius of the quietest — noticeable but not dominating.
- **Single term**: No compounding. One input (percentile), one output (factor). Clean and predictable.

#### New pixel sizes (Part A alone)

| | Quiet tweet (p5) | Median tweet | Viral tweet (p99) |
|---|---|---|---|
| 2k dataset | 1.7 px radius, 3.4 px dia | 3.5 px, 7 px | **6.4 px radius, 12.9 px dia** |
| 300k dataset | 0.56 px, 1.1 px | 1.2 px, 2.4 px | **2.2 px, 4.5 px dia** |

The viral tweet at 2k drops from 29 px diameter to 13 px — still clearly the biggest dot, but it doesn't eat the map. At 300k it drops from 10 px to 4.5 px — a subtle bump, appropriate for a map where you're reading cluster density, not individual dots.

---

### Part B — Hybrid zoom-compression (optional enhancement)

#### The idea

At overview zoom, you're reading cluster structure — individual dot sizes are less important and big dots are more harmful (they occlude neighbors). At detail zoom, you're inspecting individual tweets — size differentiation is useful and big dots have room to breathe.

A hybrid strategy **compresses the size range at overview zoom and opens it up at detail zoom**. Crucially, it compresses big dots more than small dots — small dots stay stable, big dots shrink toward the floor. This is "differential compression."

#### What the Deck.GL SDK gives us

From the [ScatterplotLayer docs](https://deck.gl/docs/api-reference/layers/scatterplot-layer) and [coordinate system docs](https://deck.gl/docs/developer-guide/coordinate-systems):

| Property | What it does |
|---|---|
| `radiusUnits: 'pixels'` | Radius is screen-space. Dot stays same size regardless of zoom. **Current setting.** |
| `radiusUnits: 'common'` | Radius is in Deck.GL common units. `1 common unit = 2^zoom pixels`. Dots scale with zoom — shrink when zoomed out, grow when zoomed in. |
| `radiusMinPixels` | Hard floor (global, same for all dots). Prevents any dot from going below N pixels. |
| `radiusMaxPixels` | Hard ceiling (global, same for all dots). |
| `getRadius` | Per-point accessor function. Can contain arbitrary logic. |

#### Why `radiusUnits: 'common'` doesn't work for us

Switching to `common` units seems like the natural answer — dots shrink at overview zoom. And `radiusMinPixels` would catch small dots before they disappear. But there are two problems:

1. **Our OrthographicView zoom is high (~8.5).** The formula is `pixels = common_units * 2^zoom`. At zoom 8.5, 1 common unit = 362 pixels. We'd need to set `getRadius` to tiny values like 0.005 to get reasonable dot sizes. Awkward and fragile.

2. **`radiusMinPixels` is global, not per-point.** At some zoom level, ALL dots hit the min pixel floor and become the same size. You lose ALL differentiation at overview zoom — the opposite of what we want. We want *reduced* differentiation, not *zero*.

```
Example with radiusUnits: 'common', radiusMinPixels: 1:

Zoom out 2x: big dot 8px → 4px, small dot 2px → 1px (clamped). Ratio 4:1 → 4:1. OK.
Zoom out 4x: big dot 8px → 2px, small dot 2px → 0.5px → 1px (clamped). Ratio 4:1 → 2:1.
Zoom out 8x: big dot 8px → 1px (clamped), small dot → 1px (clamped). Ratio 4:1 → 1:1. No differentiation.
```

#### The hybrid approach: accessor-based differential compression

Instead of switching `radiusUnits`, keep `'pixels'` and apply zoom-dependent compression inside the `getRadius` accessor. This gives us full control over the behavior at every zoom level.

The key insight: **compress each dot's radius toward a floor value, with the compression strength depending on zoom level.** Big dots have more distance above the floor, so they compress more. Small dots are already near the floor, so they barely change.

```js
getRadius: d => {
  const zoom = currentViewState?.zoom ?? initialZoom;
  const zoomNorm = clamp((zoom - minZoom) / (maxZoom - minZoom), 0, 1);

  let r = pointRadii[d.index] || 1.2;

  // Floor = the radius of the quietest tweet (baseRadius * 0.70)
  const floorR = baseRadius * 0.70;

  // At overview zoom, compress toward the floor.
  // At detail zoom, show full differentiation.
  // compression: 0.5 at minZoom → 1.0 at maxZoom
  const compression = 0.5 + zoomNorm * 0.5;
  r = floorR + (r - floorR) * compression;

  // ... hover/highlight/activation boosts applied after ...
  return r;
}
```

#### How compression affects different dots

**At overview zoom** (zoomNorm ~ 0, compression = 0.5):

| Tweet | Base radius | Compressed radius | Change |
|---|---|---|---|
| Quiet (p5) | 1.7 px | 1.6 + (1.7-1.6)*0.5 = **1.65 px** | barely moved |
| Median (p50) | 3.5 px | 1.6 + (3.5-1.6)*0.5 = **2.55 px** | shrank 27% |
| Viral (p99) | 6.4 px | 1.6 + (6.4-1.6)*0.5 = **4.0 px** | shrank 37% |
| **Ratio (viral:quiet)** | 3.8x | **2.4x** | tighter |

**At detail zoom** (zoomNorm ~ 1, compression = 1.0):

| Tweet | Compressed radius | Change |
|---|---|---|
| Quiet (p5) | **1.7 px** | unchanged |
| Viral (p99) | **6.4 px** | unchanged |
| **Ratio** | **3.8x** | full differentiation |

This is the hybrid the question asked about: big dots shrink more, small dots stay stable, and the effect scales smoothly with zoom.

#### Performance consideration

The `getRadius` accessor runs once per point. With 300k points and zoom changing during a pinch gesture, that's 300k function calls per frame — just a multiply and add per point, so <2ms on modern hardware.

To avoid unnecessary recalculation during smooth zoom animations, we quantize the zoom value in `updateTriggers` so Deck.GL only re-evaluates the accessor at discrete zoom steps (e.g., every 0.5 zoom units, ~20 steps across the full range):

```js
// In the component body:
const quantizedZoom = Math.round((currentViewState?.zoom ?? initialZoom) * 2) / 2;

// In updateTriggers:
updateTriggers: {
  getRadius: [pointRadii, featureIsSelected, highlightIndexSet, quantizedZoom],
}
```

This means during a smooth pinch-to-zoom, the dot sizes "step" through ~20 discrete levels instead of continuously animating. At 0.5-zoom-unit steps, the size changes are small enough (a few percent) that the stepping is imperceptible.

#### Should we do Part B?

**Part A (the formula fix) is required.** It solves the core problem — 90x area ratio → 16x area ratio.

**Part B (zoom compression) is a nice-to-have** that further refines the experience. It's ~15 lines of code and doesn't add conceptual complexity — the behavior is intuitive (zoomed out = more uniform, zoomed in = more differentiated). But it's separable from Part A and can be added later after validating that Part A alone feels right.

**Recommendation: Ship Part A first. If the overview zoom still feels cluttered, add Part B.**

---

## Supporting changes (both parts)

### Reduce maxRadius clamp

```js
// Before
const maxRadius = 20.0;

// After
const maxRadius = 12.0;
```

Safety net. With the new formula, no tweet naturally exceeds ~6.4 px base radius, but the selection/highlight boosts in `getRadius` can multiply further. Capping at 12.0 prevents any dot from becoming a blob even under those boosts.

### Tighten interactive-state clamps

The `getRadius` accessor applies additional multipliers for hover, highlight, and feature-selection states. Their current clamps (28.0 and 34.0 px) were set for the old aggressive scaling and should come down proportionally:

```js
// Feature selection boost — was clamped at 28.0
r = clamp(r * activationBoost, 0.45, 16.0);

// Highlight boost — was clamped at 34.0
r = clamp(r * 1.35 + 0.6, 0.6, 18.0);

// Hover boost — was clamped at 34.0
return isHovered ? clamp(r + 2, 0.6, 18.0) : r;
```

### Reduce radiusMaxPixels

On the ScatterplotLayer itself, reduce the hard GPU-level cap:

```js
// Before
radiusMaxPixels: 36,

// After
radiusMaxPixels: 20,
```

This is the absolute last line of defense — even if all the multipliers stack up, no dot ever exceeds 20 CSS pixels radius on screen.

---

## What code changes

All changes are in one file: `web/src/components/Explore/V2/DeckGLScatter.jsx`.

### Change 1: maxRadius clamp (line 459)
```
20.0 → 12.0
```

### Change 2: importanceFactor formula (lines 493-508)
Delete: `mag01` computation, `pctCurve`, `tailPct`, all three additive terms.
Replace with single percentile curve.

### Change 3: getRadius clamps (lines 1151-1160)
Reduce interactive-state clamps from 28/34 to 16/18.

### Change 4: radiusMaxPixels (line 1141)
```
36 → 20
```

### Change 5 (optional, Part B): zoom compression in getRadius accessor
Add `quantizedZoom`, `floorR`, `compression` logic.
Add `quantizedZoom` to `updateTriggers`.

---

## What does NOT change

- `calculateBaseRadius()` — dataset-size adaptation stays as-is
- `engagementScoreFromRow()` — the engagement formula stays as-is
- `log1p` + winsorization + percentile rank pipeline — the normalization stays as-is
- `radiusUnits: 'pixels'` — dots stay screen-space sized (the hybrid approach keeps pixels and adds compression in JS, not by switching to common units)
- `calculateBaseAlpha()` and `alphaScale` — opacity logic stays as-is
- Label placement, hull outlines, edge rendering — untouched
- No dataset-size adaptation in the importance factor — `calculateBaseRadius` already handles this; adding a second layer would create confusing interactions
- No changes to the engagement formula weights — `likes + RT*0.7 + replies*0.45` is a product decision, not a scaling fix

---

## Constraints & edge cases

### Uniform engagement datasets
If every tweet has roughly the same engagement (e.g., a bot account or a new account where everything has 0-2 likes), all percentile ranks cluster together and all dots end up roughly the same size. **This is correct behavior** — there's no meaningful engagement signal to visualize, so uniform sizing is honest.

### Very small datasets (< 1000 tweets)
The `calculateBaseRadius` formula gives 2.3 px for anything under ~5k. With the new factor range (0.70–2.80), the smallest dot is 1.6 px and the largest is 6.4 px. Both are comfortably visible. No special casing needed.

### Very large datasets (> 100k tweets)
Base radius clamps at 0.8 px. The smallest dot is 0.56 px (just barely visible as a pixel). The largest is 2.24 px. At this scale, you're reading cluster shapes and density gradients, not individual dot sizes — which is the correct UX. Individual dots become meaningful only when you zoom in, at which point fewer dots are on screen and the differentiation is readable. If Part B (zoom compression) is enabled, zooming in also increases the differentiation, making individual dot sizing more pronounced exactly when it's useful.

### Mixed engagement distributions
Some accounts have a bimodal distribution: lots of 0-like tweets (drafts, replies) and a cluster of 1K+ tweets. The percentile rank naturally handles this — the 0-like tweets are at p0–p40, the 1K+ tweets are at p60–p99. The curve gives gentle differentiation across the whole range without the bimodal gap causing weird scaling artifacts.

### Interaction with feature selection / search highlights
When a user selects a feature or searches, matching tweets get an `activationBoost` (up to 2.35x). Under the old system, a viral tweet with activation could reach 28 px radius (56 px diameter). Under the new system with the tightened clamp, it maxes at 16 px (32 px diameter) — still prominently highlighted but not a black hole.

### Interaction with carousel / sidebar modes
The scatter's `contentPaddingRight` shifts the view but doesn't affect sizing. No interaction with this change.

### Interaction with Part B zoom compression
If both Part A and Part B are active, the zoom compression operates on the already-compressed factor range. At overview zoom the effective ratio narrows from 4x to ~2.4x. At detail zoom the full 4x ratio is available. The compression is multiplicative with the interactive boosts (hover/highlight/activation) — a hovered viral tweet at overview zoom would be smaller than a hovered viral tweet at detail zoom, which feels natural.

---

## Consensus

Both Claude (Opus 4.6) and Codex (GPT-5.3, xhigh reasoning) independently analyzed the code and agreed:

1. The three-term compounding is the core issue — not the normalization, not the base radius
2. A single percentile-based power curve is the right fix
3. No dataset-size adaptation needed in the importance factor
4. `radiusUnits: 'pixels'` should stay

Codex proposed slightly higher coefficients (0.70 floor, 2.10 scale, 1.25 exponent → max 2.80) vs Claude's initial (0.65, 1.85, 1.20 → max 2.50). The final plan uses Codex's numbers for slightly more headroom at 300k-point views.

---

## How to verify

After the change, check these scenarios:

1. **2k tweet dataset, small account**: No dot should exceed ~13 px diameter at default zoom. Viral tweets should be clearly larger but not dominating.
2. **300k tweet dataset, large account**: Most dots should be ~1-2 px. Viral tweets should be ~4-5 px. Cluster structure should be the primary visual signal.
3. **Zoom in close on a cluster**: Individual dot differentiation should be readable — you can tell which tweets are more popular.
4. **Select a feature / search**: Highlighted dots should pop but not blob out.
5. **Hover**: Hovered dot should grow by ~2 px and get a border — still works fine with new clamps.
6. **(If Part B enabled) Zoom out to overview**: All dots should be more uniform. Big dots should shrink more than small dots. Cluster shapes should dominate over individual dot sizes.
7. **(If Part B enabled) Zoom in to detail**: Differentiation should smoothly increase. At full zoom, you should see the full 4x ratio between quiet and viral tweets.
