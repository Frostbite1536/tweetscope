/**
 * Catalog repository — registry-backed dataset/scope reads.
 *
 * Reads from LanceDB system__datasets and system__scopes tables,
 * with visibility filtering.
 */

import { getCatalogTable } from "./lancedb.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DatasetRow {
  dataset_id: string;
  owner_id: string;
  visibility: string;
  active_scope_id: string;
  row_count: number;
  updated_at: string;
  meta_json: string;
}

export interface ScopeRow {
  scope_pk: string;
  dataset_id: string;
  scope_id: string;
  lancedb_table_id: string;
  is_active: boolean;
  hierarchical_labels: boolean;
  unknown_count: number;
  embedding_model_id: string;
  updated_at: string;
  meta_json: string;
}

export interface ParsedDatasetMeta {
  id: string;
  [key: string]: unknown;
}

export interface ParsedScopeMeta {
  id: string;
  lancedb_table_id?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APP_MODE = process.env.LATENT_SCOPE_APP_MODE ?? "";
const IS_STUDIO = APP_MODE === "studio";

const DATASETS_TABLE = "system__datasets";
const SCOPES_TABLE = "system__scopes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildVisibilityWhere(userId?: string | null): string {
  if (IS_STUDIO) return ""; // Studio mode: no visibility filter
  if (userId) {
    return `visibility = 'public' OR owner_id = ${sqlLiteral(userId)}`;
  }
  return "visibility = 'public'";
}

function parseMeta<T>(metaJson: string): T {
  return JSON.parse(metaJson) as T;
}

function normalizeCount(value: unknown): number {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (value > max) return Number.MAX_SAFE_INTEGER;
    if (value < BigInt(0)) return 0;
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    return Math.floor(value);
  }
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function fullScanLimit(countRaw: unknown): number {
  const count = Number(countRaw);
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.floor(count);
}

function projectScopeListItem(row: ScopeRow): ParsedScopeMeta {
  // Scope cards only need a small subset for listing.
  const meta = parseMeta<Record<string, unknown>>(row.meta_json);
  return {
    id: row.scope_id,
    lancedb_table_id: row.lancedb_table_id,
    is_active: row.is_active,
    label: typeof meta.label === "string" ? meta.label : row.scope_id,
    description: typeof meta.description === "string" ? meta.description : undefined,
    umap_id: typeof meta.umap_id === "string" ? meta.umap_id : undefined,
    cluster_id: typeof meta.cluster_id === "string" ? meta.cluster_id : undefined,
    ignore_hulls: Boolean(meta.ignore_hulls),
    row_count:
      typeof meta.length === "number" && Number.isFinite(meta.length)
        ? meta.length
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all datasets visible to the current user.
 */
export async function listDatasets(
  userId?: string | null,
): Promise<ParsedDatasetMeta[]> {
  const table = await getCatalogTable(DATASETS_TABLE);
  const where = buildVisibilityWhere(userId);

  let query = table
    .query()
    .select(["dataset_id", "visibility", "active_scope_id", "row_count", "meta_json"]);

  if (where) {
    query = query.where(where);
  }
  const limit = fullScanLimit(await table.countRows());

  const rows = (await query.limit(limit).toArray()) as Array<
    Pick<DatasetRow, "dataset_id" | "visibility" | "active_scope_id" | "row_count" | "meta_json">
  >;

  return rows.map((row) => {
    const meta = row.meta_json ? parseMeta<Record<string, unknown>>(row.meta_json) : {};
    const profile = meta.profile as Record<string, string> | undefined;
    return {
      id: row.dataset_id,
      visibility: row.visibility,
      active_scope_id: row.active_scope_id || null,
      row_count: normalizeCount(row.row_count),
      // keep legacy frontend key until all callers switch to row_count
      length: normalizeCount(row.row_count),
      profile: profile ? {
        username: profile.username ?? undefined,
        display_name: profile.display_name ?? undefined,
        avatar_url: profile.avatar_url ?? undefined,
      } : undefined,
    };
  });
}

/**
 * Get a single dataset's full metadata.
 * Returns null if not found or not visible.
 */
export async function getDataset(
  datasetId: string,
  userId?: string | null,
): Promise<ParsedDatasetMeta | null> {
  const table = await getCatalogTable(DATASETS_TABLE);
  const parts = [`dataset_id = ${sqlLiteral(datasetId)}`];
  const vis = buildVisibilityWhere(userId);
  if (vis) parts.push(`(${vis})`);

  const rows = (await table
    .query()
    .where(parts.join(" AND "))
    .limit(1)
    .toArray()) as DatasetRow[];

  if (rows.length === 0) return null;

  const meta = parseMeta<ParsedDatasetMeta>(rows[0].meta_json);
  meta.id = rows[0].dataset_id;
  return meta;
}

/**
 * List scopes for a dataset, visible to the current user.
 */
export async function listScopes(
  datasetId: string,
  userId?: string | null,
): Promise<ParsedScopeMeta[]> {
  // First verify dataset visibility
  const dataset = await getDataset(datasetId, userId);
  if (!dataset) return [];

  const table = await getCatalogTable(SCOPES_TABLE);
  const limit = fullScanLimit(await table.countRows());
  const rows = (await table
    .query()
    .select(["scope_id", "lancedb_table_id", "is_active", "meta_json"])
    .where(`dataset_id = ${sqlLiteral(datasetId)}`)
    .limit(limit)
    .toArray()) as ScopeRow[];

  return rows.map(projectScopeListItem);
}

/**
 * Get a single scope's full metadata.
 * Returns null if not found or dataset not visible.
 */
export async function getScope(
  datasetId: string,
  scopeId: string,
  userId?: string | null,
): Promise<ParsedScopeMeta | null> {
  // First verify dataset visibility
  const dataset = await getDataset(datasetId, userId);
  if (!dataset) return null;

  const scopePk = `${datasetId}:${scopeId}`;
  const table = await getCatalogTable(SCOPES_TABLE);
  const rows = (await table
    .query()
    .where(`scope_pk = ${sqlLiteral(scopePk)}`)
    .limit(1)
    .toArray()) as ScopeRow[];

  if (rows.length === 0) return null;

  const meta = parseMeta<ParsedScopeMeta>(rows[0].meta_json);
  meta.id = rows[0].scope_id;
  meta.lancedb_table_id = rows[0].lancedb_table_id;
  (meta as Record<string, unknown>).is_active = rows[0].is_active;
  return meta;
}

/**
 * Get the active scope's full metadata for a dataset.
 * Falls back to first scope when no explicit active row exists.
 */
export async function getActiveScope(
  datasetId: string,
  userId?: string | null,
): Promise<ParsedScopeMeta | null> {
  const dataset = await getDataset(datasetId, userId);
  if (!dataset) return null;

  const table = await getCatalogTable(SCOPES_TABLE);
  const activeRows = (await table
    .query()
    .select(["scope_id", "lancedb_table_id", "is_active", "meta_json"])
    .where(`dataset_id = ${sqlLiteral(datasetId)} AND is_active = true`)
    .limit(1)
    .toArray()) as ScopeRow[];

  const rows =
    activeRows.length > 0
      ? activeRows
      : ((await table
          .query()
          .select(["scope_id", "lancedb_table_id", "is_active", "meta_json"])
          .where(`dataset_id = ${sqlLiteral(datasetId)}`)
          .limit(1)
          .toArray()) as ScopeRow[]);

  if (rows.length === 0) return null;
  const row = rows[0];
  const meta = parseMeta<ParsedScopeMeta>(row.meta_json);
  meta.id = row.scope_id;
  meta.lancedb_table_id = row.lancedb_table_id;
  (meta as Record<string, unknown>).is_active = row.is_active;
  return meta;
}

/**
 * Resolve a scope's LanceDB table ID from the registry.
 */
export async function resolveScopeLanceTableId(
  datasetId: string,
  scopeId: string,
): Promise<string> {
  const scopePk = `${datasetId}:${scopeId}`;
  const table = await getCatalogTable(SCOPES_TABLE);
  const rows = (await table
    .query()
    .select(["lancedb_table_id"])
    .where(`scope_pk = ${sqlLiteral(scopePk)}`)
    .limit(1)
    .toArray()) as Pick<ScopeRow, "lancedb_table_id">[];

  if (rows.length === 0) {
    throw new Error(`Scope not found in catalog registry: ${scopePk}`);
  }

  const tableId = rows[0].lancedb_table_id;
  if (typeof tableId !== "string" || !tableId.trim()) {
    throw new Error(`Missing lancedb_table_id in catalog registry for scope: ${scopePk}`);
  }
  return tableId;
}
