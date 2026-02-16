# Public Datasets + Auth + Catalog Cutover Plan

Date: 2026-02-15

## 1. Objective

Move from mode-based deployment splits to policy-based access:

1. `visakanv-tweets` and `patrick-tweets` are public and readable by everyone.
2. Only authenticated users can import/create datasets.
3. Catalog/scope discovery is served from Lance metadata registry (not JSON sidecars).
4. Collapse from 4 deployments (`web-demo`, `api-demo`, `web-app`, `api-app`) to 2 (`web`, `api`).

### Service Topology by Phase

| Phase | Services | Notes |
|-------|----------|-------|
| Phase 1 (catalog migration) | `web` + `api` (TS/Hono) + `flask` (Python) | Flask handles import/jobs. TS API handles catalog, views, search. |
| Phase 2 (auth hardening + import bridge) | `web` + `api` (TS/Hono) + `flask` (Python) | Auth middleware on Flask `/jobs/*`. TS API gets catalog auth. Import still served by Flask. |
| Phase 3 (import migration + collapse) | `web` + `api` (TS/Hono) | Import ported to TS API. Flask retired. |

## 2. Guiding Principles

1. Single source of truth for catalog metadata: Lance registry.
2. Fail-closed auth for write routes (import/create/delete/update).
3. Dual-write before cutover: write JSON + Lance during migration.
4. Backward compatibility first: keep current `/import` JSON payload initially.
5. Incremental rollout with explicit rollback switches.

## 3. Current State (Code Anchors)

1. Import page posts browser-extracted JSON (`community_json`):
   - `web/src/components/Home.jsx`
   - `web/src/lib/twitterArchiveParser.js`
2. Backend import endpoint accepts/validates extracted JSON:
   - `latentscope/server/jobs_routes.py`
3. Pipeline writes Lance tables for scope rows but still emits JSON metadata:
   - `latentscope/scripts/twitter_import.py`
   - `latentscope/pipeline/scope_runner.py`
4. Catalog/scope discovery still reads JSON sidecars:
   - `api/src/routes/catalog.ts`
   - `api/src/routes/dataShared/storage.ts`
5. Import visibility currently tied to mode/read-only flags:
   - `api/src/index.ts`
6. Deployment docs still describe 4-project topology:
   - `documentation/vercel-deployment.md`

## 4. Target Registry Schema

Use typed columns for filtering/joining + `meta_json` for full payload.

### 4.1 `system__datasets`

Required columns:

1. `dataset_id` (string, primary key)
2. `owner_id` (string, nullable)
3. `visibility` (string enum: `public|private`)
4. `active_scope_id` (string, nullable)
5. `row_count` (int, nullable)
6. `updated_at` (timestamp/string)
7. `meta_json` (string JSON blob)

### 4.2 `system__scopes`

Required columns:

1. `scope_pk` (string, primary key: `"{dataset_id}:{scope_id}"` — globally unique since scope_id like `scopes-001` repeats across datasets)
2. `dataset_id` (string)
3. `scope_id` (string)
4. `lancedb_table_id` (string)
5. `is_active` (bool)
6. `hierarchical_labels` (bool, nullable)
7. `unknown_count` (int, nullable)
8. `embedding_model_id` (string, nullable)
9. `updated_at` (timestamp/string)
10. `meta_json` (string JSON blob, full scope metadata)

Notes:

1. `meta_json` includes `cluster_labels_lookup`, nested embedding config, cluster/umap IDs, and other scope metadata used by frontend bootstrap.
2. Keep typed columns minimal but sufficient for filters and joins.
3. `active_scope_id` lifecycle: auto-set to the latest scope on pipeline completion (in `scope_runner.py` after export). For public datasets, `active_scope_id` changes require explicit operator action (backfill flag or admin endpoint) to prevent unexpected public view flips. No user-selectable override in phase 1.
4. Visibility policy (fail-closed, consistent with principle 2.2):
   - **Default (hosted/prod)**: unauthenticated sees only `visibility = 'public'`. Authenticated sees `visibility = 'public'` OR `owner_id = <self>`. `catalogRepo.ts` must never return private datasets to unauthenticated callers.
   - **Exception (local dev only)**: when `LATENT_SCOPE_APP_MODE=studio`, visibility filter is bypassed — all datasets visible. This mode is never deployed to production.

### 4.3 Registry Indexes

LanceDB only supports single-column scalar indexes (no composite indexes).
Create separate indexes and let LanceDB combine them at query time.

1. `system__datasets`: BTREE on `dataset_id`; BITMAP on `visibility` (low-cardinality)
2. `system__scopes`: BTREE on `scope_pk`, BTREE on `dataset_id`, BTREE on `lancedb_table_id`

Index types:
- BTREE: columns with many unique values (IDs, timestamps)
- BITMAP: columns with few unique values (visibility, is_active)

Ref: https://docs.lancedb.com/indexing/scalar-index

## 5. Local + Cloud Catalog Storage

### 5.1 Local

Use a dedicated catalog DB root (new):

1. `${LATENT_SCOPE_DATA}/_catalog/lancedb`

Do not place `system__*` in per-dataset DB paths (`${LATENT_SCOPE_DATA}/{dataset}/lancedb`).

### 5.2 Cloud

1. Default to `LANCEDB_URI`
2. Optional override via `LANCEDB_CATALOG_URI` and `LANCEDB_CATALOG_API_KEY`

## 6. Environment Variables

1. `LATENT_SCOPE_CATALOG_ENABLED=1`
2. `LATENT_SCOPE_CATALOG_JSON_FALLBACK=1` (temporary migration fallback)
3. `LATENT_SCOPE_CATALOG_LOCAL_PATH=_catalog/lancedb`
4. `LANCEDB_CATALOG_URI` (optional override)
5. `LANCEDB_CATALOG_API_KEY` (optional override)
6. `LATENT_SCOPE_AUTH_MODE=header|none` (start with `header`)
7. `LATENT_SCOPE_AUTH_HEADER=x-user-id` (if header mode)
8. `LATENT_SCOPE_AUTH_TRUSTED_SIGNATURE_HEADER=x-gateway-signature`
9. `LATENT_SCOPE_AUTH_TRUSTED_SIGNATURE_SECRET=<shared-secret-or-key-id>`
10. `LATENT_SCOPE_AUTH_TRUSTED_PROXY_CIDRS=<comma-separated-cidrs>` (optional, if network-level allowlist is available)

Auth security requirement: header mode (`x-user-id`) is ONLY safe behind a trusted gateway (Vercel Edge, Cloudflare) that:
- Strips any client-supplied `x-user-id` header before proxying
- Injects verified identity from its own auth layer
- API must reject requests where `x-user-id` is present but no trusted gateway signature is found

If the API is ever exposed without a trusted gateway, switch to `LATENT_SCOPE_AUTH_MODE=none` (all writes blocked) or implement JWT verification as a future mode.

## 7. File-Level Implementation Plan

### 7.1 Python Write Path

1. Add `latentscope/pipeline/catalog_registry.py`
   - `ensure_catalog_tables()` — open or create `system__datasets` / `system__scopes`
   - `upsert_dataset_meta()` — uses `merge_insert("dataset_id")`
   - `upsert_scope_meta()` — uses `merge_insert("scope_pk")` where `scope_pk = f"{dataset_id}:{scope_id}"` (scope_id like `scopes-001` repeats across datasets; must join on a globally unique key)
   - Serialize with `json.dumps(meta, allow_nan=False)` — no `default=str`; raise on unexpected types to surface schema bugs at write time rather than silently stringifying
   - Add explicit pre-write validation: assert no NaN/Inf floats, assert required fields present
   - Create scalar indexes on first table creation (BTREE on IDs, BITMAP on visibility/is_active)
2. Update `latentscope/pipeline/scope_runner.py`
   - upsert scope registry row after scope finalize/export
3. Update `latentscope/scripts/twitter_import.py`
   - upsert dataset row on success
   - `active_scope_id` auto-refresh: only for `visibility = 'private'` datasets. For `visibility = 'public'` datasets, `active_scope_id` is never auto-updated — requires explicit operator action via backfill script (`--set-active-scope`) or future admin endpoint.

Upsert pattern (from LanceDB docs):
```python
# scope_pk is globally unique: "sheik-tweets:scopes-002"
table.merge_insert("scope_pk") \
    .when_matched_update_all() \
    .when_not_matched_insert_all() \
    .execute(new_data)
# Returns MergeResult(version, num_updated_rows, num_inserted_rows, ...)
```

Requires scalar index on join column for performance. Cloud has 10K unindexed row limit.
Ref: https://docs.lancedb.com/tables/update

### 7.2 Backfill

1. Add `tools/backfill_catalog_registry.py`
   - idempotent
   - dry-run default
   - reads `meta.json` + `scopes/*.json`
   - supports `--public-datasets visakanv-tweets,patrick-tweets`
   - supports `--verify`

### 7.3 TS API Read Path

1. Update `api/src/lib/lancedb.ts`
   - add `getCatalogDb()` and `getCatalogTable()`
2. Add `api/src/lib/catalogRepo.ts`
   - registry-backed list/get operations with visibility filtering
3. Update `api/src/routes/catalog.ts`
   - switch dataset/scope endpoints to registry (with temporary fallback flag)
4. Update `api/src/routes/dataShared/storage.ts`
   - resolve scope metadata/table IDs from registry first

### 7.3.1 views.ts Endpoints — Scope vs. Stay

Endpoints in `api/src/routes/views.ts` break into three categories:

**Move to catalog registry (reads scope metadata JSON):**
- `GET /views/:view/meta` — returns full scope metadata; used by ScopeContext on every explore load

**Delete (dead code):**
- `GET /views/:view/cluster-tree` — unused; frontend builds tree from `scope.cluster_labels_lookup` directly in ScopeContext
- `GET /clusters/:cluster/labels/:labelId` — already returns 410

**Deprecate (still functional but redundant):**
- `GET /scopes/:scope/parquet` — currently serves rows identical to `/views/:view/rows` (views.ts:138). Mark deprecated, add deprecation header, remove in phase 2 after confirming no callers.

**Keep in views.ts (data serving from LanceDB, not metadata):**
- `GET /views/:view/rows` — full serving rows; used by ScopeContext
- `GET /views/:view/points` — sparse coords for Deck.GL scatter

**Migrate to registry-backed (used in ScopeContext bootstrap):**
- `GET /embeddings` — lists embedding configs; called by `catalogClient.fetchEmbeddings()` in `ScopeContext.tsx:124`. In hosted mode without `PUBLIC_SCOPE` or local JSON listing, currently degrades to empty `[]`.
- `GET /clusters` — lists cluster configs; same degradation risk.
- `GET /clusters/:cluster/labels_available` — label version listing; same degradation risk.

Phase 1 fix: `catalogRepo.ts` extracts embedding/cluster metadata from `system__scopes.meta_json` for the active scope. The scope JSON blob already contains nested `embedding`, `cluster`, and `cluster_labels` objects — `catalogRepo` returns `[scope.embedding]`, `[scope.cluster]`, `[scope.cluster_labels]` respectively.

Intentional behavior change for `labels_available`: in current `PUBLIC_SCOPE` fallback, this endpoint ignores the `:cluster` param and returns labels for the active scope's cluster only. The registry-backed version preserves this behavior. Historical label versions and per-cluster filtering are only available in studio mode (via `listJsonObjects()`). This is acceptable because the explore view only uses the active scope's labels — it never requests label versions for other clusters.

Studio mode continues using `listJsonObjects()` to enumerate all available embeddings/clusters/label versions (not just the active scope's).

### 7.4 Canonical Import Endpoint + Auth Boundary

Today the import path is split:
- **Frontend** (`Home.jsx`) posts to `${apiUrl}/jobs/import_twitter` — this hits the **Flask** server (`latentscope/server/jobs_routes.py`), not the TS API.
- **TS API** (`api/src/index.ts`) has no jobs/import routes. It only serves catalog, views, search, and resolve-url.

Decision for phase 1: keep import on Flask. Auth middleware goes on Flask's `/jobs/*` routes.
Decision for phase 3 (post-soak): migrate import to TS API as `/api/jobs/import_twitter`, add auth middleware there, retire Flask import route.

Import host routing by phase:

| Phase | `VITE_API_URL` | Import endpoint | Auth on |
|-------|----------------|-----------------|---------|
| Phase 1 | `http://localhost:3000` (TS API) | Frontend posts to Flask at `${VITE_FLASK_URL}/api/jobs/import_twitter` — **separate env var** `VITE_FLASK_URL` (e.g., `http://localhost:5001`) | Flask |
| Phase 2 (hosted) | `https://api.latentscope.com` | Frontend posts to Flask at `${VITE_FLASK_URL}/api/jobs/import_twitter` | Flask behind gateway |
| Phase 3 (collapsed) | `https://api.latentscope.com` | Frontend posts to `${VITE_API_URL}/api/jobs/import_twitter` (TS API) | TS API behind gateway |

Note: In phase 1-2, `Home.jsx` import form must use `VITE_FLASK_URL` (not `apiUrl`) for `/jobs/*` routes. Currently it uses `apiUrl` which only works if both servers share the same origin or `apiUrl` points to Flask. This must be explicit.

### 7.5 Auth Enforcement

1. Add auth middleware to **Flask** `latentscope/server/jobs_routes.py` for `/jobs/*` write routes (phase 1 target).
2. Add auth middleware to **TS API** `api/src/` for future write routes (phase 2).
3. Update `api/src/index.ts` to stop treating `read_only` as authorization control.
4. Auth check: reject if no valid auth context AND `LATENT_SCOPE_APP_MODE != studio`.

### 7.6 API Response Projection

List endpoints (`GET /datasets`, `GET /datasets/:dataset/scopes`) must NOT return raw `meta_json` blobs (which include full `cluster_labels_lookup` with hull arrays — can be 100KB+ per scope).

- **List responses**: project slim typed columns only (`dataset_id`, `visibility`, `active_scope_id`, `row_count`, `label`, `description` for datasets; `scope_id`, `label`, `is_active`, `row_count` for scopes).
- **Detail responses** (`GET /datasets/:dataset/scopes/:scope`): return full `meta_json` parsed as JSON object (same shape as current scope JSON).
- `catalogRepo.ts` must enforce this projection at the query level (LanceDB `.select()`) not post-hoc.

### 7.7 Frontend

1. Update `web/src/components/Home.jsx`
   - always show public explore list
   - import forms visible only when authenticated
   - keep local extract + JSON upload path unchanged in phase 1

### 7.8 Docs/Deploy

1. Update `documentation/vercel-deployment.md`
   - replace 4-project split with 2-project policy-driven architecture

## 8. Rollout Sequence and Rollback

### 8.1 Rollout

1. Deploy registry tables + dual-write from pipeline.
2. Run backfill and verify parity.
3. Switch catalog reads to registry, keep JSON fallback on.
4. Enable auth enforcement for import/create (on Flask `/jobs/*`).
5. Soak period: verify registry parity, auth correctness, visibility filtering.
6. Disable JSON fallback; remove hosted/prod JSON read paths from TS API. Keep studio-only JSON listing paths used by local development.
7. Migrate `/jobs/import_twitter` from Flask to TS API. Add auth middleware on TS API side.
8. Retire Flask import routes. Verify no remaining Flask dependencies.
9. Collapse deployments from 3 services to 2 (`web` + `api`).

### 8.2 Rollback

1. Set `LATENT_SCOPE_CATALOG_JSON_FALLBACK=1` to restore JSON reads.
2. Keep JSON sidecar writes until post-soak confidence.
3. Revert auth middleware enforcement while preserving read access behavior if needed.

## 9. Transport Decision (`/import`)

Short-term: keep JSON payload transport.

Rationale:

1. Current extracted payload path is stable and validated.
2. Main architectural risk/reward is metadata/auth/deployment cutover, not payload format.
3. Revisit Arrow/Parquet upload as a separate optimization after policy cutover.

## 10. Key References

LanceDB and Lance docs:

1. Schema evolution: https://docs.lancedb.com/tables/schema
2. Updates/modifications: https://docs.lancedb.com/tables/update
3. Consistency: https://docs.lancedb.com/tables/consistency
4. Versioning: https://docs.lancedb.com/tables/versioning
5. Scalar indexes: https://docs.lancedb.com/indexing/scalar-index
6. Reindexing: https://docs.lancedb.com/indexing/reindexing
7. Merge-insert (upsert): https://docs.lancedb.com/tables/update (see "Merge Insert" section)
8. REST create scalar index: https://docs.lancedb.com/api-reference/rest/table/create-a-scalar-index-on-a-table.md
9. Lance blob guidance: https://lance.org/guide/blob/

Claude docs index reference:

1. https://code.claude.com/docs/llms.txt

## 11. Test Checklist

### Visibility Filtering
- [ ] Unauthenticated request to `GET /datasets` in hosted mode returns only `visibility = 'public'` datasets
- [ ] Unauthenticated request returns 0 datasets if none are public
- [ ] Studio mode (`LATENT_SCOPE_APP_MODE=studio`) returns all datasets regardless of visibility
- [ ] Authenticated request returns public + own datasets (no other users' private datasets)

### Scope Key Uniqueness
- [ ] Two datasets with `scopes-001` each get distinct `scope_pk` values (`ds1:scopes-001`, `ds2:scopes-001`)
- [ ] Upserting `ds1:scopes-001` does not overwrite `ds2:scopes-001`
- [ ] Backfill produces correct `scope_pk` for all existing scopes

### Registry vs JSON Parity
- [ ] `GET /datasets/:dataset/scopes` returns identical data from registry as from JSON files
- [ ] `GET /datasets/:dataset/scopes/:scope` returns identical scope metadata from registry
- [ ] Scope detail response includes `cluster_labels_lookup`, nested `embedding`, `dataset`, `umap`, `cluster` objects
- [ ] List response does NOT include `meta_json` / `cluster_labels_lookup` (projection enforced)

### Import Auth
- [ ] Unauthenticated `POST /api/jobs/import_twitter` returns 401 in hosted mode
- [ ] Authenticated `POST /api/jobs/import_twitter` succeeds and creates dataset + scope registry rows
- [ ] Studio mode import works without auth (bypass)

### Auth Gateway Hardening
- [ ] Request with forged `x-user-id` header but no trusted gateway signature is rejected (401)
- [ ] Request with valid gateway signature but no `x-user-id` is treated as unauthenticated (public only)
- [ ] Request with valid gateway signature + `x-user-id` is accepted as authenticated
- [ ] Direct request to API (bypassing gateway) with `x-user-id` header is rejected

### NaN / Schema Validation
- [ ] Pipeline write with `topic_specificity = float('nan')` raises at write time (not silently stored)
- [ ] Pipeline write with unexpected type in metadata raises (no silent `str()` conversion)

### Public Active Scope Stability
- [ ] Pipeline run for `visibility='public'` dataset does NOT auto-update `active_scope_id`
- [ ] `active_scope_id` for public dataset changes only via explicit operator action (`--set-active-scope` / admin endpoint)

### Rollback
- [ ] Setting `LATENT_SCOPE_CATALOG_JSON_FALLBACK=1` restores JSON-based catalog reads
- [ ] JSON sidecar dual-writes continue during fallback
