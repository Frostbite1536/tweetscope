# Import UX Redesign (User-First)

## Why This Exists
The previous draft was implementation-heavy. This version is intentionally product and UX focused.

The goal is to answer:
- What is this app for now?
- What do users actually want from `/import`?
- What is confusing today?
- What simple, creative features should we prioritize?

---

## 1. Product Goal (Now)

### Core goal
Help a person turn their X/Twitter archive into a personal insight tool in minutes, not hours.

### In plain language
A user should be able to:
1. Bring in their archive.
2. See what they talk about, when, and with whom.
3. Find important threads, ideas, and patterns.
4. Save/export useful outputs.

### Success feeling
"I uploaded my archive and immediately learned something about myself."

---

## 2. Primary User Jobs

Users are not asking for pipelines. They are trying to do jobs like:

1. "Find my best ideas again."
2. "See how my interests changed over time."
3. "Find threads I should revisit or repurpose."
4. "See who I engage with most and in what context."
5. "Export clean, useful outputs for writing/research."

---

## 3. What Is Wrong With `/import` Today

This is from a user experience perspective, not backend architecture.

1. Product language is too internal.
- Terms like `dataset`, `scope`, `run_pipeline` are system words, not user words.

2. The page asks for technical decisions too early.
- Users are asked for dataset naming and hidden pipeline assumptions before they see value.

3. Two import cards create uncertainty.
- "Native archive" vs "community archive" is technically valid but not decision-friendly.
- Users ask: "Which should I pick? What is safer? Which is complete?"

4. Outcome is unclear before running.
- No clear preview of expected imported size, year span, or what will be created.

5. Progress is not meaningful.
- Job status is visible, but users don’t get clear stage-level confidence: "extracting", "validating", "building map", "ready".

6. First success moment is weak.
- After import, user is routed to explore, but there is no simple "you now have X insights" summary screen.

7. Likes handling is confusing.
- "Import likes as separate dataset" is technical and mentally expensive.
- Users think in terms of "include likes in analysis" rather than data modeling choices.

8. Scope language is especially confusing.
- `scope` sounds like developer vocabulary, not a view users can understand.

---

## 4. New Product Language (Replace Internal Terms)

Use these words in UI copy.

| Current term | Better user term |
|---|---|
| Dataset | Archive |
| Scope | View |
| Run pipeline | Build map |
| Import batch | Import run |
| Cluster labels | Topics |
| Lance table ID | Hidden internal detail |

### Copy principle
If a new user cannot explain the term back in one sentence, it should not be primary UI language.

---

## 5. UX Direction for `/import`

### New page purpose
`/import` should be an **Archive Setup Workspace**, not a technical job launcher.

### Recommended structure

1. Step 1: Choose source
- `Upload X archive (.zip)`
- `Import by @username`
- Simple guidance under each choice:
  - "Best for complete personal history" vs "Best for quick public import"

2. Step 2: Choose what to include
- Include replies
- Include reposts
- Include likes
- Optional year range

3. Step 3: Review preview (before run)
- Estimated records
- Year span
- % replies / % originals
- Likes available: yes/no

4. Step 4: Start import
- Clear CTA: `Import Archive`

5. Step 5: Build map
- `Quick map (faster)`
- `Deep map (better topics)`
- Default recommendation shown

6. Step 6: Success summary
- "Archive ready"
- top 3 stats
- top 3 topics
- quick action buttons

---

## 6. Simple Features Users Will Actually Want

These are intentionally simple and high-impact.

## P0 (ship first)

1. Username-first onboarding
- Ask for `@username` as the first field.
- Auto-suggest archive name from username.

2. Import type clarity card
- A mini comparison card:
  - Coverage
  - Privacy
  - Speed
  - Likes availability

3. Preview before import starts
- Show estimated tweet count and date range after local extraction (for zip path).

4. Stage-based progress
- Visual steps:
  - Extracting
  - Uploading
  - Importing records
  - Building map
  - Finalizing

5. First-run summary screen
- Before sending user into explore, show:
  - total records
  - time span
  - top topic labels
  - top active year/month

6. Rename `Scopes` to `Views` in UI
- Keep backend compatibility, but UI should never lead with `scope`.

## P1 (very practical next)

1. Basic archive health stats
- Missing years
- Empty-text rows
- reply-heavy vs original-heavy ratio

2. Build presets
- `Quick`, `Balanced`, `Deep`
- One-line explanation + expected time

3. Simple visual cards on import success
- Timeline of posts per month
- Topic share donut/bar
- Reply vs original split
- Likes over time

4. "Open a guided tour" button
- Highlights topic tree, search, and thread view in 30 seconds.

5. "What changed since last import?"
- New records
- New topics
- Topic growth/decline

## P2 (creative but still simple)

1. "Your archive in one minute"
- Auto-generated story cards:
  - Most active month
  - Most discussed theme
  - Most replied-to person
  - Longest thread

2. "Idea resurfacer"
- Finds old high-signal tweets with low engagement.

3. "Thread opportunities"
- Detect unfinished threads and suggest revisits.

4. "Conversation map"
- Simple network card of top interactions by account.

5. "Mood and voice over time" (lightweight)
- Basic sentiment/tonality trend by month.

---

## 7. Minimal First-Run Visualizations (Keep It Light)

These should be available right after import/build.

1. Activity timeline
- Posts by week/month.

2. Topic distribution
- Top 10 topic labels by count.

3. Content mix
- Original vs reply vs repost vs like.

4. Engagement snapshot
- Median likes/retweets over time.

5. Thread depth distribution
- How often user writes multi-step threads.

All of these are easy to understand and immediately useful.

---

## 8. UX Flow Proposal (Simple)

1. Landing on `/import`
- Headline: `Turn your archive into an insight map`
- Subhead: `Upload once. Explore patterns in minutes.`

2. Configure import
- Source + include options + optional year range.

3. Confirm preview
- "You are importing ~14,989 records from 2024."

4. Live progress
- Clear stages with estimated remaining time.

5. Success screen
- "Archive ready"
- Quick stats + `Open Map` + `View Summary`

6. Explore entry
- Default to latest view (label this as `Latest View`, not `scopes-00x`).

---

## 9. Constraints to Respect (User-Facing Interpretation)

1. Privacy
- Zip extraction should stay browser-local in hosted mode.
- Explain this clearly near upload CTA.

2. App modes
- If import is disabled in mode, show friendly read-only messaging.

3. Performance
- Large archives should set expectation: "This can take several minutes."

4. Reliability
- If build fails, keep imported archive and offer retry for build only.

---

## 10. Naming and IA Recommendations

### Navigation
- `/import` -> label as `Import`
- Dataset list section -> label as `Your Archives`
- Scope cards -> label as `Views`

### Buttons
- `Import Archive`
- `Build Map`
- `Open Latest View`
- `See Summary`

### Avoid in primary UI
- `scope`
- `pipeline`
- `cluster_labels_id`
- `lancedb_table_id`

---

## 11. Prioritized Improvements (90-Day)

## Month 1
1. Language cleanup (`dataset/scope` -> `archive/view` in UI copy)
2. Import source clarity + comparison hints
3. Stage-based progress component
4. First-run summary screen

## Month 2
1. Build presets (Quick/Balanced/Deep)
2. Basic stats + mini visual cards post-import
3. Retry build without re-import

## Month 3
1. "What changed since last import" summary
2. Idea resurfacer and thread opportunity cards
3. Guided explore onboarding

---

## 12. UX Success Metrics

1. Import completion rate
2. Time to first insight (import start -> first summary viewed)
3. % users who open explore after import
4. % users who return for second session
5. Reduction in user confusion events around naming (`scope`, import type, likes)

---

## 13. Open Product Questions

1. Should likes be included by default or opt-in?
2. Is a single archive allowed to contain both tweets and likes in one "view" model, while still preserving separate storage internally?
3. How much advanced control should be exposed to regular users vs hidden behind "Advanced"?
4. Should first-run summary be skippable for power users?
5. Should we keep `/import` as the home route in hosted mode long-term, or switch to a dashboard once user has an archive?

---

## Recommendation
Prioritize a UX rewrite of `/import` around user jobs and language first, then evolve backend surface as needed.

In short:
- First fix language, flow, and confidence.
- Then expand simple insights and visuals.
- Keep technical complexity behind the scenes.
