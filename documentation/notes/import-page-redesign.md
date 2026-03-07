# Import Page Redesign — Design Document

## Context

The `/import` page is the front door to the whole app. It's currently structured around the old latent-scope project's assumptions: generic CSV ingestion, manual pipeline steps, and "datasets" as a bare technical concept. We've since evolved into a Twitter/X knowledge explorer where the import is the beginning of a specific user journey — but the page doesn't reflect that yet.

This doc proposes how to rethink the import page for the current product, with an eye toward future extensibility.

---

## What's Wrong Today

### 1. Wrong mental model in the language

The page says "Import your X archive" and "Dataset name" — but what the user is actually doing is **creating a knowledge base from their writing**. The word "dataset" is a data-science term that doesn't match the user's intent. They're not importing data. They're building a map of their mind.

The word "import" itself is transactional and dry. It describes a mechanical step, not the outcome.

### 2. The page conflates two very different things

The top half is an import form. The bottom half is a dataset browser. These serve completely different purposes:
- **New user**: needs onboarding, context, and a clear path forward
- **Returning user**: wants to jump back into an existing scope quickly

Both are crammed into one scrollable page with no hierarchy between them.

### 3. The pipeline is invisible

After clicking "Import Archive", the user sees raw subprocess logs scrolling in a `<pre>` tag. They have no idea what's happening — embedding, UMAP, clustering, labeling — it's all a black box. There's no way to know "is this 20% done or 90% done?" and no way to understand what went wrong if it fails.

### 4. No progressive disclosure

Every option is visible at once: dataset name, year filter, include likes checkbox, file upload. A first-time user has to process all of this before they can do anything. There's no guided flow.

### 5. Community Archive is a second-class citizen that gets equal billing

The Community Archive import is a niche feature (fetching someone else's public archive). It sits side-by-side with the primary "import your own archive" flow, which dilutes the primary action.

### 6. No re-import or update story

The page doesn't explain what happens when you import into an existing dataset name. The backend supports incremental upsert (merge new tweets, deduplicate, preserve `ls_index`), but the UI has no concept of "updating" a knowledge base — only "creating" one. A warning says "name taken" as if it's an error, when it could be an intentional update.

### 7. Hardcoded to Twitter

The entire page is structurally bound to Twitter import. There's no path to support other social platforms (Bluesky, Mastodon) without a complete rewrite.

---

## Ontology: What Are We Actually Building?

Before proposing UI, we need the right words.

| Old Term | Problem | Proposed Term | Why |
|----------|---------|---------------|-----|
| Dataset | Technical, generic | **Archive** or **Collection** | What the user actually has — a body of writing |
| Import | Mechanical, transactional | **Build** or **Create** | The user is building something, not loading a file |
| Scope | Internal pipeline artifact | **Map** or **View** | What the user sees — a visual map of their knowledge |
| Cluster | ML jargon | **Topic** or **Region** | What it means to the user — a group of related ideas |
| Embed / UMAP / Cluster | Pipeline internals | (hidden or named by outcome) | Users don't care about the technique, only the result |

**Candidate naming schemes:**

- **Option A — "Archive" language**: "Create archive" → "Building your archive" → "Explore your archive". Feels natural for Twitter exports. Might be confusing since the zip itself is called an "archive."
- **Option B — "Collection" language**: "New collection" → "Building your collection" → "Explore your collection". More generic, works for non-Twitter sources too. Clear that it's *your* curated body of work.
- **Option C — "Map" language**: "Build your knowledge map" → "Mapping your ideas" → "Explore your map". Emphasizes the visual output. Might overpromise if the map isn't great.

**Recommendation**: Use **"Collection"** for the data container and **"Map"** for the explorable view. This gives us: "Create a new collection" → "Building your knowledge map" → "Explore".

---

## Proposed Structure

### Page Layout: Two Modes

The page should feel different for new users vs. returning users.

**If no collections exist** → Full-screen onboarding / creation flow
**If collections exist** → Collection browser with a "New collection" action

This is the single biggest structural change. Today both states render the same page.

---

### Option A: Single-Page With Contextual Sections

Keep everything on one page, but with clear visual hierarchy:

```
┌─────────────────────────────────────────────┐
│  [if returning user]                        │
│  Your Collections                           │
│  ┌──────┐ ┌──────┐ ┌──────────────┐       │
│  │visakanv│ │sheik │ │ + New        │       │
│  │ 50k   │ │ 12k  │ │ Collection   │       │
│  └──────┘ └──────┘ └──────────────┘       │
│                                             │
│  [if new user OR expanded creation]         │
│  ┌─────────────────────────────────────┐   │
│  │  Create a New Collection             │   │
│  │  Step 1: Choose source               │   │
│  │  Step 2: Name & configure            │   │
│  │  Step 3: Build                       │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

**Pros**: Simple, no routing changes, fast to build
**Cons**: Can feel crowded, harder to add more sources later

### Option B: Split Into Dashboard + Creation Flow

Two distinct routes:

- `/` → **Dashboard** (collection browser, quick access to maps)
- `/new` → **Creation flow** (stepped, focused)

```
DASHBOARD (/):
┌─────────────────────────────────────────────┐
│  Knowledge Explorer                         │
│                                             │
│  Your Collections                           │
│  ┌────────────────┐  ┌────────────────┐    │
│  │ visakanv-2024  │  │ sheik-tweets   │    │
│  │ 50,231 tweets  │  │ 12,003 tweets  │    │
│  │ 847 topics     │  │ 156 topics     │    │
│  │ Last updated   │  │ Last updated   │    │
│  │ Feb 19         │  │ Feb 14         │    │
│  │ [Explore →]    │  │ [Explore →]    │    │
│  └────────────────┘  └────────────────┘    │
│                                             │
│  ┌────────────────────────────────────┐    │
│  │  + Create New Collection            │    │
│  └────────────────────────────────────┘    │
└─────────────────────────────────────────────┘

CREATION FLOW (/new):
┌─────────────────────────────────────────────┐
│  ← Back                                    │
│                                             │
│  Create a New Collection                    │
│                                             │
│  Where's your data?                         │
│  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
│  │ X Archive│  │ Community│  │ (more   │  │
│  │ .zip file│  │ Archive  │  │ coming) │  │
│  └──────────┘  └──────────┘  └─────────┘  │
│                                             │
│  [Source-specific form appears below]       │
│                                             │
└─────────────────────────────────────────────┘
```

**Pros**: Clean separation of concerns, creation flow can grow without cluttering the dashboard, scales to many sources
**Cons**: Extra route, slightly more navigation

### Option C: Drawer / Modal Creation

Dashboard stays at `/`. Clicking "New Collection" opens a slide-over drawer or modal with the creation flow.

**Pros**: No route change, keeps context, feels lightweight
**Cons**: Modals can feel cramped for a multi-step flow, harder to deep-link to

---

### Recommendation: Option B (Split Routes)

The creation flow will only get more complex over time (more sources, more options, pipeline progress). Giving it its own page is the right investment. The dashboard becomes cleaner and more useful.

---

## Creation Flow: Detailed Design

### Step 1: Choose Source

```
Where's your data?

┌─────────────────────┐  ┌─────────────────────┐
│  📦 X/Twitter        │  │  🌐 Community        │
│  Archive             │  │  Archive             │
│                      │  │                      │
│  Upload your native  │  │  Fetch a public      │
│  X export .zip       │  │  archive by username  │
└─────────────────────┘  └─────────────────────┘

  Future slots:
  - Bluesky (AT Protocol, public API)
  - Mastodon (maybe — ActivityPub export)
```

Selecting a source reveals the source-specific form below (accordion or replace).

### Step 2: Configure (Source-Specific)

**For X Archive:**
```
┌─────────────────────────────────────────────┐
│  Upload your archive                        │
│  ┌────────────────────────────────────┐    │
│  │  Drop your .zip file here          │    │
│  │  or click to browse                │    │
│  └────────────────────────────────────┘    │
│                                             │
│  Collection name: [visakanv-2024      ]    │
│  (auto-filled from zip, editable)           │
│                                             │
│  ▸ Advanced options                         │
│    Year filter: [    ]                      │
│    Include likes: [✓]                       │
│    Exclude replies: [ ]                     │
│    Exclude retweets: [ ]                    │
│                                             │
│  [Build Collection →]                       │
└─────────────────────────────────────────────┘
```

Key changes from today:
- Advanced options collapsed by default (progressive disclosure)
- "Build Collection" instead of "Import Archive"
- The file upload area is the dominant element
- Name auto-fills — most users won't change it

**For Community Archive:**
```
┌─────────────────────────────────────────────┐
│  Fetch a public archive                     │
│                                             │
│  Username: [@visakanv              ]        │
│  Collection name: [visakanv-2024   ]        │
│  (auto-fills from username)                 │
│                                             │
│  ▸ Advanced options                         │
│    Year filter: [    ]                      │
│                                             │
│  [Build Collection →]                       │
└─────────────────────────────────────────────┘
```

### Step 3: Building (Pipeline Progress)

This is the biggest UX gap today. Replace the raw log output with a structured progress view.

```
┌─────────────────────────────────────────────┐
│  Building your knowledge map...             │
│                                             │
│  ████████████░░░░░░░░░░░░░  48%            │
│                                             │
│  ✓ Loaded 50,231 tweets                    │
│  ✓ Removed 312 duplicates                  │
│  ✓ Generated embeddings                    │
│  ● Arranging the map...                    │
│  ○ Finding topics                          │
│  ○ Naming topics                           │
│  ○ Building conversation threads           │
│                                             │
│  ▸ Show detailed logs                      │
│                                             │
│  This usually takes 2-5 minutes for        │
│  50k tweets.                               │
└─────────────────────────────────────────────┘
```

Key design decisions:
- **Named stages in plain language**: "Arranging the map" not "Running UMAP". "Finding topics" not "HDBSCAN clustering".
- **Progress indicator**: Even approximate progress is better than a spinning cursor
- **Detailed logs hidden by default**: Power users can expand them
- **Contextual time estimate**: Based on row count (we know roughly how long each stage takes per 10k rows)

The pipeline stages map to user-facing names:

| Backend Stage | User-Facing Name | Icon/Status |
|--------------|-----------------|-------------|
| `ingest` | "Loading your archive" | ✓ Loaded N tweets |
| `deduplicate` | (folded into loading) | ✓ Removed N duplicates |
| `embed` | "Reading and understanding your writing" | ● / ✓ |
| `umap (display)` | "Arranging the map" | ● / ✓ |
| `umap (cluster)` | (hidden, folded into "finding topics") | — |
| `cluster` | "Finding topics" | ● / ✓ |
| `scope` | (hidden, infrastructure) | — |
| `toponymy_labels` | "Naming topics" | ● / ✓ |
| `build_links` | "Building conversation threads" | ● / ✓ |
| `export_lance` | (hidden, infrastructure) | — |

### Step 4: Done → Auto-Navigate

On completion, automatically navigate to `/datasets/:id/explore/:scope`. No intermediate "success" page needed — the explore view IS the reward.

If there's an error, show it inline in the progress view with:
- Plain-language description of what went wrong
- The raw error for debugging
- A "Try Again" button

---

## Update / Re-Import Flow

When a user has an existing collection and wants to add more data (new archive export with recent tweets), the current UX is broken — it shows "name taken" as a warning.

### Proposed: Detect and offer merge

When the user enters a collection name that already exists:

```
┌─────────────────────────────────────────────┐
│  "visakanv-2024" already exists             │
│  (50,231 tweets, last updated Feb 19)       │
│                                             │
│  ○ Update this collection                   │
│    New tweets will be merged in.            │
│    Duplicates are automatically removed.    │
│                                             │
│  ○ Create a new collection                  │
│    Name: [visakanv-2024-v2        ]        │
│                                             │
└─────────────────────────────────────────────┘
```

This acknowledges the incremental import feature that already exists in the backend but is completely hidden from users.

---

## Dashboard: Collection Cards

Each collection card should surface the information users actually care about:

```
┌────────────────────────────────────────┐
│  visakanv-2024                         │
│  50,231 tweets · 847 topics            │
│  Last updated Feb 19, 2026             │
│                                        │
│  [map thumbnail image]                 │
│                                        │
│  [Explore →]  [Update ↻]              │
└────────────────────────────────────────┘
```

The "Update" button goes directly to the creation flow with the source pre-selected and name pre-filled, for incremental import.

---

## Explore Page: Context Pill (SubNav)

The floating pill in the top-left of the explore view currently reads:

```
┌──────────────────────────────────────────────┐
│  Archive  visakanv-2024  [ Switch Archive ]  │
└──────────────────────────────────────────────┘
```

This has several problems:
- **"Archive"** is a label for the data container, but you're looking at a *map* of that data
- **"Switch Archive"** links to `/import`, which is the wrong destination if we split into Dashboard (`/`) and Creation (`/new`)
- The pill doesn't show which *map* (scope) you're viewing — just the dataset name
- There's no way to switch scopes without leaving the explore view entirely

### Proposed

```
┌──────────────────────────────────────────┐
│  visakanv-2024           [ All Maps ↗ ]  │
└──────────────────────────────────────────┘
```

Changes:
- **Drop the "Archive" label** — the dataset name is self-evident, the label wastes space
- **"All Maps"** instead of "Switch Archive" — links to the dashboard (`/`), where you can pick a different collection *or* a different map within this one. Short, clear, non-destructive language ("all maps" not "switch" or "exit")
- **Link target**: `/` (dashboard), not `/import` or `/new`

If we later support multiple scopes per collection, the pill could expand to include a scope dropdown:

```
┌──────────────────────────────────────────────────────┐
│  visakanv-2024  ▸ Core Threads ▾     [ All Maps ↗ ] │
└──────────────────────────────────────────────────────┘
```

Where clicking "Core Threads ▾" shows a dropdown of available scopes for this collection — no page navigation needed.

### Files to Change
- `web/src/components/SubNav.jsx` — update text, link target
- `web/src/components/SubNav.module.css` — minor (no structural changes needed)

---

## Constraints & Requirements

### Must Preserve
- **Local-first processing**: Zip extraction happens in the browser. Only the extracted JSON payload is sent to the server. This is a privacy feature we should highlight, not hide in small text.
- **Incremental import semantics**: The backend's ID-based upsert, deduplication, and `ls_index` preservation must be maintained.
- **Automated pipeline**: The one-click "build everything" flow (import → embed → UMAP → cluster → label → export) should remain the default. Don't force users through manual pipeline steps.
- **Job polling architecture**: The current async job model (submit → poll → complete) works fine. The frontend change is purely presentational (structured progress instead of raw logs).

### Must Not Break
- **Existing datasets**: Renaming "dataset" to "collection" in the UI should not require renaming anything on disk or in the API. This is a UI-only vocabulary change.
- **Single-profile mode**: The `isSingleProfile` / `publicPath` routing in `App.jsx` must continue to work (this mode bypasses the import page entirely).
- **Read-only mode**: The `readonly` flag should hide creation features.
- **Likes as separate dataset**: The `{name}-likes` convention and the include-likes checkbox must be preserved.

### Backend Changes Needed
- **Structured progress events**: The Python pipeline scripts need to emit structured progress (stage name, percentage, counts) instead of just print statements. Could be JSON lines to stdout that the TS API parses, or a progress file the API polls.
- **Stage timing data**: To show estimated time remaining, we need historical timing data per stage per dataset size. Could be stored in the import batch manifest.

### Future Extensibility
The architecture should make it easy to add:
- **Bluesky**: AT Protocol export or public API fetch. Same data shape as Twitter — posts, timestamps, engagement, threads, quotes. Should slot in as another source card with its own form (handle input instead of zip upload). The pipeline from embed onward is identical.
- **Mastodon**: ActivityPub export (`.tar.gz` with `outbox.json`). Similar shape but federated — posts live on different servers, threading uses `inReplyTo` URIs instead of IDs. Possible but adds complexity around ID resolution.
- **Pipeline customization**: Advanced users might want to choose embedding model, adjust cluster sensitivity, or skip toponymy. These belong in an "Advanced" panel within the creation flow, not on the main path.
- **Multi-map per collection**: A single collection (input data) can have multiple maps (scopes) with different parameters. The dashboard should eventually show these as sub-cards within each collection.
- **Collaboration**: If collections become shareable, the dashboard needs visibility controls and sharing UI.

---

## Implementation Phases

### Phase 1: Vocabulary + Layout
- Rename "Import" → "New Collection" / "Build" in all user-facing text
- Split into Dashboard (`/`) and Creation (`/new`) routes
- Collapse advanced options behind a toggle
- Better collection cards on the dashboard (topic count, last updated, thumbnail)
- No backend changes needed

### Phase 2: Progress UI
- Add structured progress to the creation flow
- Backend: emit JSON progress events from pipeline stages
- Frontend: parse and display named stages with checkmarks
- Hide raw logs behind "Show details" toggle
- Add approximate time remaining based on row count

### Phase 3: Update Flow
- Detect existing collection name and offer merge vs. new
- Show diff summary after update ("Added 1,203 new tweets, removed 45 duplicates")
- "Update" button on dashboard collection cards

### Phase 4: Bluesky Support
- Add Bluesky as a second source (AT Protocol public API or export)
- Abstract the source selection into a pluggable pattern
- Each source provides: icon, label, description, form component, and a `preparePayload()` function
- Shared pipeline from embed onward — source-specific logic only in the ingest/flatten step

---

## Open Questions

1. **Should "collection" be the final word?** Other candidates: "archive" (overloaded with zip), "library" (too static), "corpus" (too academic), "space" (too vague). Need to test with actual users.

2. **How much pipeline visibility is too much?** Some users want to see every step. Others just want a spinner. The collapsible detail view tries to serve both, but we should test whether the named stages actually reduce anxiety or just add noise.

3. **Should the dashboard show collections or maps?** If a collection has 3 different maps (scopes), does the dashboard show 1 card or 3? Currently it shows 1 dataset card with N scope thumbnails inside. This might be fine, or it might obscure the fact that different maps exist.

4. **Do we want the creation flow to support "draft" state?** i.e., the user fills in the form but doesn't submit yet — can they come back to it? Probably not for v1, but worth thinking about if we add more configuration options.

5. **Naming the pipeline stages**: The mapping from technical names to user-facing names (above) is a first draft. "Reading and understanding your writing" for embedding is evocative but might overpromise. "Processing text" is honest but boring. This needs wordsmithing.

6. **Should tweets and likes be grouped under one card?** Currently the backend creates two separate datasets (`visakanv-2024` and `visakanv-2024-likes`) from one zip upload. On the dashboard, these would naively render as two unrelated cards. But the user uploaded one archive — they think of it as one person's data. Options:

   **Option A — Group by source**: One card per person, with tweets and likes as sub-maps inside it. Requires a `parent_dataset` or `group_id` field linking them. The dashboard card shows both:
   ```
   visakanv-2024
   50,231 tweets · 8,402 likes · 847 topics
   [Tweets Map →]  [Likes Map →]  [Update ↻]
   ```

   **Option B — Keep them flat**: Two cards, but use naming convention (`{name}-likes`) to visually associate them. Simpler, no backend changes, but feels disjointed.

   **Option C — Treat likes as a tab/view within the same collection**: Don't create a separate dataset at all — include likes in the same scope table with a `is_like` filter, and let the explore UI toggle between "your tweets" and "your likes" views. This is the cleanest UX but requires rethinking how likes interact with the cluster/topic pipeline (likes have different text — someone else's words, not yours).

   Leaning toward **Option A** for the dashboard grouping, keeping the backend's separate-dataset approach intact. The grouping is purely a UI concern — the `{name}-likes` naming convention is already enough to detect the relationship on the frontend without new backend fields.

---

## Progress UI — Detailed Implementation Design

The goal: replace the raw `<pre>` log with a clean stage list, without over-engineering the protocol. The whole thing should be ~150 lines of React and ~20 lines of Python changes.

### The Protocol: One Line Per Stage Transition

Python scripts already print to stdout. The API already parses stdout line-by-line in `updateJobFromOutputLine()`. We extend that same pattern with a single new prefix: `STAGE:`.

**Python side** — add one print per stage boundary in `twitter_import.py`:

```python
# The full vocabulary. Each script prints exactly one STAGE line on entry.
print("STAGE: ingest")          # twitter_import.py, before calling ingest()
print("STAGE: embed")           # twitter_import.py, before calling embed
print("STAGE: map")             # twitter_import.py, before display UMAP
print("STAGE: topics")          # twitter_import.py, before cluster.py
print("STAGE: labels")          # twitter_import.py, before toponymy_labels
print("STAGE: threads")         # twitter_import.py, before build_links_graph
print("STAGE: done")            # twitter_import.py, at the very end
```

That's 7 print statements added to one file. No changes to embed.py, umapper.py, cluster.py, etc. The orchestrator (`twitter_import.py`) already calls them sequentially, so it owns the stage transitions.

Row count comes from the existing `IMPORTED_ROWS:` signal (already parsed).

**API side** — extend `updateJobFromOutputLine()` in `jobsRuntime.ts`:

```typescript
// Add to JobRecord interface:
stage?: string;          // current stage key
stages_seen?: string[];  // ordered list of completed stage keys

// Add to updateJobFromOutputLine():
if (line.startsWith("STAGE:")) {
  const stage = line.slice(6).trim();
  if (!job.stages_seen) job.stages_seen = [];
  if (job.stage && job.stage !== stage) {
    job.stages_seen.push(job.stage);
  }
  job.stage = stage;
}
```

~10 lines of TS. The job JSON file (already polled at 500ms) now carries `stage` and `stages_seen`. No new endpoints, no new polling, no new file format.

**Frontend side** — a compact `BuildProgress` component:

```
STAGE_META (constant, ~15 lines):
  ingest  → "Loading your archive"
  embed   → "Understanding your writing"
  map     → "Arranging the map"
  topics  → "Finding topics"
  labels  → "Naming topics"
  threads → "Connecting conversations"
  done    → "Done"
```

The component renders a flat list. Each stage is one of three states derived from `job.stage` and `job.stages_seen`:
- **completed** (in `stages_seen`): muted text + checkmark
- **active** (equals `job.stage`): normal text + spinner
- **pending** (not yet seen): dimmed text + empty circle

```
┌───────────────────────────────────────────┐
│  Building your knowledge map              │
│                                           │
│  ✓  Loaded 50,231 tweets                 │  ← completed (has imported_rows)
│  ✓  Understanding your writing            │  ← completed
│  ●  Arranging the map                     │  ← active (spinner)
│  ○  Finding topics                        │  ← pending
│  ○  Naming topics                         │  ← pending
│  ○  Connecting conversations              │  ← pending
│                                           │
│  ▸ Show logs                   2m 14s     │
│                                           │
└───────────────────────────────────────────┘
```

That's it. The entire component is:
1. Map over `STAGE_META` (ordered array)
2. For each, check if it's in `stages_seen` (done), equals `job.stage` (active), or neither (pending)
3. Render the right icon + text
4. A collapsible `<pre>` for raw logs (the existing `job.progress` array)
5. Elapsed time from `job.times[0]`

No progress bar needed. The stage list *is* the progress indicator — you can see how many are done vs. remaining. A bar would require estimating percentages per stage, which adds complexity for marginal value.

### Why This Is Enough

- **7 Python prints** — trivial to add, trivial to maintain
- **10 lines of TS parsing** — same pattern as existing `RUNNING:` / `IMPORTED_ROWS:`
- **~100 lines of React** — stateless, derived entirely from `job.stage` + `job.stages_seen`
- **No new endpoints, no new polling, no new files** — rides the existing 500ms job poll
- **Graceful degradation** — if `stage` is undefined (old jobs, non-twitter imports), the component falls back to the existing raw `<pre>` log

### Error Handling

If the job fails mid-stage, `job.status === "error"` and `job.stage` tells you which stage it was in. The component shows:

```
  ✓  Loaded 50,231 tweets
  ✓  Understanding your writing
  ✗  Arranging the map — failed          ← red, with last few log lines visible
  ○  Finding topics
  ○  Naming topics
  ○  Connecting conversations

  [Show full logs]  [Try Again]
```

The active stage flips to an error icon. The last 3-5 lines of `job.progress` are shown inline (not collapsed) so the user sees what went wrong without manually expanding.

---

## Dashboard Stats & Visualizations

We already have rich per-tweet metadata in the scope table. The question is which stats are *worth showing* on the dashboard, and which are just noise.

### What Data We Actually Have Per-Tweet

| Column | Type | Example |
|--------|------|---------|
| `created_at` | ISO timestamp | `2024-06-15T14:30:00Z` |
| `favorites` | int | 42 |
| `retweets` | int | 7 |
| `replies` | int | 3 |
| `tweet_type` | string | `"tweet"`, `"note_tweet"`, `"like"` |
| `is_reply` | bool | false |
| `is_retweet` | bool | false |
| `cluster` / `label` | string | `"Career & Learning"` |
| `urls_json` | JSON array | `["https://example.com"]` |
| `media_urls_json` | JSON array | `["https://pbs.twimg.com/..."]` |
| `lang` | string | `"en"` |

Plus from the **links graph** (`node_link_stats`):
| Column | Type | Meaning |
|--------|------|---------|
| `thread_depth` | int | How deep in a reply chain |
| `thread_size` | int | Total tweets in thread |
| `thread_root_id` | string | Root of the conversation |
| `reply_child_count` | int | Direct replies received |

Plus **cluster metadata** (from scope JSON):
- Number of clusters, hierarchy depth, cluster sizes, `unknown_count`

### Tier 1: Collection Card Stats (Always Visible)

These appear on each collection card on the dashboard. Must be derivable with a single pass or pre-computed at build time.

```
┌────────────────────────────────────────────────┐
│                                                │
│  visakanv-2024                                 │
│  50,231 tweets · 847 topics · 2018–2024        │
│                                                │
│  [map thumbnail]                               │
│                                                │
│  ▪ 12,408 original · 31,204 replies · 6,619 RT │
│                                                │
│  [Explore →]                    [Update ↻]     │
│                                                │
└────────────────────────────────────────────────┘
```

- **Row count** — already in `meta.json` (`length`)
- **Topic count** — from scope JSON (`cluster_labels_lookup` length or `n_clusters`)
- **Date range** — from `created_at` extent in `column_metadata`
- **Type breakdown** — count of `is_reply=false, is_retweet=false` (original), `is_reply=true`, `is_retweet=true`

All of these are cheap. Most are already computed at ingest time or derivable from `meta.json` column metadata.

### Tier 2: Collection Detail Stats (On Click / Expanded View)

When a user clicks into a collection (before exploring the map), or shown on a dedicated stats panel. These require a query over the scope table but not a full scan — LanceDB can handle them.

#### A. Writing Streak / Activity Heatmap

GitHub-style contribution calendar. Each cell = one day, color intensity = tweet count.

```
        Jan        Feb        Mar        Apr
  Mon   ░░▓▓░░░   ░▓▓▓░░░   ░░░▓▓░░   ░▓░░▓░░
  Wed   ▓▓▓░░░░   ░░▓░▓▓░   ▓▓░░░▓░   ░░▓▓░░░
  Fri   ░▓▓▓▓░░   ▓░░░▓▓▓   ░▓▓░░░░   ▓▓░░▓▓░

  Longest streak: 47 days (Mar 3 – Apr 18, 2023)
  Most active day: Nov 14, 2022 (127 tweets)
  Average: 8.3 tweets/day on active days
```

**Data needed**: `created_at` grouped by date. A single `SELECT date(created_at), count(*) GROUP BY date(created_at)` over the scope table. Or pre-aggregate at build time into a `daily_counts` JSON in the scope metadata.

This is the single highest-value viz for the dashboard. It immediately tells a story about someone's relationship with the platform — periods of intensity, breaks, comebacks.

#### B. Topic Treemap

Visual weight of each top-level topic, sized by tweet count. Already have the data: each cluster has a `count` and `label` in the cluster labels lookup.

```
┌──────────────────┬───────────┬──────────┐
│                  │           │ Music &  │
│  Tech & Startups │  Writing  │ Culture  │
│     (8,420)      │  (5,102)  │ (3,891)  │
│                  │           │          │
├──────────┬───────┼───────────┤──────────┤
│ Parenting│ Books │  Health   │  Travel  │
│ (2,340)  │(1,890)│  (1,650)  │  (980)   │
└──────────┴───────┴───────────┴──────────┘
```

**Data needed**: Already in `scope.json → cluster_labels_lookup`. Zero additional queries. Just render the top-level layer (layer 0 parent clusters) sized by count.

#### C. Engagement Distribution

Most tweets get 0-5 likes. A few get thousands. Show this as a log-scale histogram or a simple "your hits" summary:

```
  Your writing by reach:

  ★★★  12 tweets with 1,000+ likes     (top 0.02%)
  ★★   89 tweets with 100-999 likes    (top 0.2%)
  ★    1,204 tweets with 10-99 likes   (top 2.6%)
       48,926 tweets with < 10 likes
```

**Data needed**: `favorites` column. A few range-count queries, or a histogram bucket at build time.

Simple, immediately meaningful, doesn't require a chart library.

#### D. Thread Depth Profile

How the person uses threads. Self-reply chains are a distinct writing style — some people never thread, others write 50-tweet threads regularly.

```
  Conversation style:

  Single tweets:        32,410  (64%)
  Short threads (2-5):   8,230  (16%)
  Long threads (6-20):   2,102  (4%)
  Mega-threads (20+):      89   (0.2%)
  Replies to others:     7,400  (15%)
```

**Data needed**: `thread_size` and `thread_depth` from `node_link_stats`. Group by bucket. Could also surface "longest thread" (max `thread_size` where `thread_depth=0`, meaning the user started it).

#### E. Top Domains Shared

From `urls_json`, extract domains and count.

```
  Most shared links:

  youtube.com          1,204
  substack.com           892
  twitter.com/i/spaces   340
  github.com             201
  goodreads.com          156
```

**Data needed**: Parse `urls_json` for each row, extract hostname, count. Heavier query but very interesting — shows what sources someone draws from.

### Tier 3: Fun / Novelty (Low Priority, High Delight)

These are "nice to have" stats that could appear on a profile or stats page. Not dashboard-critical, but they make the product feel alive.

- **Vocabulary richness**: Unique words / total words. Compare across collections. ("visakanv uses 12,400 unique words across 50k tweets — top 2% of archives we've seen")
- **Peak hours**: Heatmap of hour-of-day × day-of-week. Shows when someone does their best thinking.
- **Quote web**: Who do they quote most? (from `quoted_status_id` → `in_reply_to_screen_name`). A mini social graph.
- **Topic evolution timeline**: When did each topic first appear and peak? A stacked area chart with topics over years. ("You started writing about AI in 2021, it became your #1 topic by 2023")
- **"First tweet about X"**: For each top-level topic, find the earliest tweet. A fun archaeology feature.
- **Media ratio over time**: How has their use of images/video changed? (from `media_urls_json` being non-empty)

### What to Pre-Compute vs. Query Live

| Stat | When to Compute | Where to Store |
|------|----------------|---------------|
| Row count, date range, type breakdown | At ingest time | `meta.json` |
| Topic counts, hierarchy depth | At scope creation | `scope.json` |
| Daily tweet counts (for heatmap) | At scope creation | `scope.json` or new `stats.json` |
| Engagement buckets | At scope creation | `scope.json` or `stats.json` |
| Thread depth distribution | At links graph build | `links/meta.json` |
| Top domains | At ingest time (parse urls_json) | `meta.json` or `stats.json` |
| Longest streak, most active day | Derived from daily counts | Computed client-side from daily counts |

The key insight: **almost everything can be pre-aggregated at build time** and stored as a small JSON blob. The dashboard never needs to scan the full scope table for stats. The pipeline already touches every row during ingest/embed/cluster — adding a stats aggregation pass is trivial.

### Implementation: One New Pipeline Step

Add a `compute_stats` step to the pipeline (between scope creation and LanceDB export). It reads `input.parquet` + `scope-input.parquet` + `node_link_stats.parquet` and writes a `stats.json`:

```json
{
  "daily_counts": { "2024-01-15": 12, "2024-01-16": 8, ... },
  "type_counts": { "original": 12408, "reply": 31204, "retweet": 6619 },
  "engagement_buckets": { "0-9": 48926, "10-99": 1204, "100-999": 89, "1000+": 12 },
  "thread_buckets": { "single": 32410, "short": 8230, "long": 2102, "mega": 89, "reply_to_others": 7400 },
  "top_domains": [["youtube.com", 1204], ["substack.com", 892], ...],
  "streak": { "longest": 47, "start": "2023-03-03", "end": "2023-04-18" },
  "most_active_day": { "date": "2022-11-14", "count": 127 },
  "avg_daily_active": 8.3
}
```

One Python script (~80 lines), one JSON file, served as a static file via the existing `/files/` endpoint. The frontend fetches it once and renders everything client-side. No LanceDB queries needed for dashboard stats.
