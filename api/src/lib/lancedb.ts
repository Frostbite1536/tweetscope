/**
 * LanceDB Cloud client.
 * https://docs.lancedb.com/cloud/get-started
 */

import * as lancedb from "@lancedb/lancedb";

let db: lancedb.Connection | null = null;
const tables = new Map<string, lancedb.Table>();
const tableColumns = new Map<string, string[]>();
const tableIndexColumn = new Map<string, string>();

export async function getDb(): Promise<lancedb.Connection> {
  if (db) return db;

  const uri = process.env.LANCEDB_URI;
  if (!uri) {
    throw new Error("LANCEDB_URI must be set");
  }

  const apiKey = process.env.LANCEDB_API_KEY;
  db = apiKey ? await lancedb.connect({ uri, apiKey }) : await lancedb.connect(uri);
  return db;
}

export async function getTable(tableId: string): Promise<lancedb.Table> {
  const cached = tables.get(tableId);
  if (cached) return cached;

  let localError: unknown = null;
  const dataDir = process.env.LATENT_SCOPE_DATA;
  const datasetPrefix = tableId.includes("__") ? tableId.split("__")[0] : null;

  // Local-first for dataset-scoped tables (e.g. {dataset}__{scopeUuid}).
  if (dataDir && datasetPrefix) {
    const expandedDir = dataDir.startsWith("~/")
      ? `${process.env.HOME ?? ""}/${dataDir.slice(2)}`
      : dataDir;
    const localDbPath = `${expandedDir}/${datasetPrefix}/lancedb`;
    try {
      const localConn = await getLocalDb(localDbPath);
      const localTable = await localConn.openTable(tableId);
      tables.set(tableId, localTable);
      return localTable;
    } catch (err) {
      localError = err;
    }
  }

  if (!process.env.LANCEDB_URI) {
    throw localError ?? new Error("LANCEDB_URI must be set");
  }
  if (localError) {
    console.warn(`Local LanceDB open failed for ${tableId}; falling back to cloud`, localError);
  }

  const conn = await getDb();
  const table = await conn.openTable(tableId);
  tables.set(tableId, table);
  return table;
}

export interface SearchResult {
  index: number;
  _distance: number;
}

export async function getTableColumns(tableId: string): Promise<string[]> {
  const cached = tableColumns.get(tableId);
  if (cached) return cached;

  const table = await getTable(tableId);
  const schema = (await table.schema()) as { fields?: Array<{ name?: string }> };
  const cols = (schema.fields ?? [])
    .map((field) => String(field.name ?? ""))
    .filter((name) => name.length > 0);

  tableColumns.set(tableId, cols);
  return cols;
}

export async function getIndexColumn(tableId: string): Promise<string> {
  const cached = tableIndexColumn.get(tableId);
  if (cached) return cached;

  const columns = await getTableColumns(tableId);
  const candidates = ["index", "ls_index", "id"];
  const resolved = candidates.find((name) => columns.includes(name)) ?? "index";
  tableIndexColumn.set(tableId, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Local LanceDB access (for graph tables written by build_links_graph.py)
// ---------------------------------------------------------------------------

const localDbs = new Map<string, lancedb.Connection>();

/**
 * Open the local LanceDB for a dataset. Graph tables ({dataset}__edges,
 * {dataset}__node_stats) live in {DATA_DIR}/{dataset}/lancedb/.
 */
export async function getLocalDb(datasetDir: string): Promise<lancedb.Connection> {
  const cached = localDbs.get(datasetDir);
  if (cached) return cached;
  const conn = await lancedb.connect(datasetDir);
  localDbs.set(datasetDir, conn);
  return conn;
}

/**
 * Open a graph-related table. Tries local DB first (if DATA_DIR is set),
 * then falls back to the cloud connection.
 */
export async function getGraphTable(
  dataset: string,
  tableSuffix: string,
): Promise<lancedb.Table> {
  return getDatasetTable(dataset, tableSuffix);
}

export function resolveDatasetTableId(dataset: string, tableIdOrSuffix: string): string {
  if (tableIdOrSuffix.includes("__")) return tableIdOrSuffix;

  // Allow dataset-scoped suffixes like "edges" / "node_stats".
  if (/^[a-z][a-z0-9_]*$/i.test(tableIdOrSuffix)) {
    return `${dataset}__${tableIdOrSuffix}`;
  }

  throw new Error(
    `Invalid table identifier "${tableIdOrSuffix}". Expected "{dataset}__{id}" or a simple suffix.`,
  );
}

/**
 * Open a dataset-scoped table local-first (if LATENT_SCOPE_DATA is set),
 * else fall back to the cloud connection.
 *
 * Accepts either:
 * - suffix form: "edges" → "{dataset}__edges"
 * - full table id: "{dataset}__{uuid}" → used as-is
 */
export async function getDatasetTable(
  dataset: string,
  tableIdOrSuffix: string,
): Promise<lancedb.Table> {
  const tableId = resolveDatasetTableId(dataset, tableIdOrSuffix);

  const cached = tables.get(tableId);
  if (cached) return cached;

  const dataDir = process.env.LATENT_SCOPE_DATA;
  let localError: unknown = null;
  if (dataDir) {
    const expandedDir = dataDir.startsWith("~/")
      ? `${process.env.HOME ?? ""}/${dataDir.slice(2)}`
      : dataDir;
    const localDbPath = `${expandedDir}/${dataset}/lancedb`;
    try {
      const localConn = await getLocalDb(localDbPath);
      const table = await localConn.openTable(tableId);
      tables.set(tableId, table);
      return table;
    } catch (err) {
      // Table doesn't exist locally, try cloud (if configured).
      localError = err;
    }
  }

  // Fallback: cloud connection
  if (!process.env.LANCEDB_URI) {
    throw localError ?? new Error("LANCEDB_URI must be set");
  }
  if (localError) {
    console.warn(`Local LanceDB open failed for ${dataset}/${tableId}; falling back to cloud`, localError);
  }
  const conn = await getDb();
  const table = await conn.openTable(tableId);
  tables.set(tableId, table);
  return table;
}

// ---------------------------------------------------------------------------
// FTS (Full-Text Search / BM25)
// ---------------------------------------------------------------------------

export interface FtsResult {
  index: number;
  _score: number;
}

const ftsIndexCache = new Map<string, boolean>();

function ftsCacheKey(tableId: string, column: string): string {
  return `${tableId}::${column}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure an FTS index exists on the given column. Creates one lazily if missing.
 * Caches the check per table+column to avoid repeated listIndices() calls.
 */
export async function ensureFtsIndex(
  tableId: string,
  column: string,
): Promise<void> {
  const cacheKey = ftsCacheKey(tableId, column);
  if (ftsIndexCache.get(cacheKey)) return;

  const table = await getTable(tableId);
  let indices = await table.listIndices();
  let ftsIndex = indices.find(
    (i) => i.indexType === "FTS" && i.columns.includes(column),
  );

  if (!ftsIndex) {
    console.warn(`FTS index missing for ${tableId}:${column}, creating lazily`);
    await table.createIndex(column, {
      config: lancedb.Index.fts({ withPosition: true }),
    });

    // createIndex is async. Wait briefly for index registration and first stats.
    const maxAttempts = 40;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(250);
      indices = await table.listIndices();
      ftsIndex = indices.find(
        (i) => i.indexType === "FTS" && i.columns.includes(column),
      );
      if (ftsIndex) break;
    }
  }

  if (!ftsIndex) {
    throw new Error(`Failed to create/find FTS index for ${tableId}:${column}`);
  }

  // Wait for indexing to finish so first query is deterministic.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const stats = await table.indexStats(ftsIndex.name);
    if (stats && stats.numUnindexedRows === 0) {
      ftsIndexCache.set(cacheKey, true);
      return;
    }
    await sleep(250);
  }

  throw new Error(`FTS index not ready yet for ${tableId}:${column}; try again shortly`);
}

/**
 * Full-text (BM25) search. Returns results ordered by _score (higher = better).
 */
export async function ftsSearch(
  tableId: string,
  query: string,
  opts: { column: string; limit?: number; where?: string } = { column: "text" },
): Promise<FtsResult[]> {
  const tableColumns = await getTableColumns(tableId);
  const requestedColumn = opts.column;
  const resolvedColumn = tableColumns.includes(requestedColumn)
    ? requestedColumn
    : (tableColumns.includes("text") ? "text" : null);
  if (!resolvedColumn) {
    throw new Error(
      `No valid FTS text column found for ${tableId}; requested "${requestedColumn}"`,
    );
  }

  await ensureFtsIndex(tableId, resolvedColumn);

  const table = await getTable(tableId);
  const indexCol = await getIndexColumn(tableId);

  let q = table
    .search(query, "fts", resolvedColumn)
    .select([indexCol])
    .limit(opts.limit ?? 100);

  if (opts.where) {
    q = q.where(opts.where);
  }

  const results = await q.toArray();
  return results.map((r: Record<string, unknown>) => ({
    index: Number(r[indexCol] ?? r.index ?? 0),
    _score: Number(r._score ?? 0),
  }));
}

export async function vectorSearch(
  tableId: string,
  embedding: number[],
  opts: { limit?: number; where?: string } = {}
): Promise<SearchResult[]> {
  const table = await getTable(tableId);
  const indexCol = await getIndexColumn(tableId);
  // table.search() with a vector returns VectorQuery | Query union.
  // Casting to VectorQuery to access distanceType().
  let query = (table.search(embedding) as lancedb.VectorQuery)
    .distanceType("cosine")
    .select([indexCol])
    .limit(opts.limit ?? 100);

  if (opts.where) {
    query = query.where(opts.where) as lancedb.VectorQuery;
  }

  const results = await query.toArray();
  return results.map((r: Record<string, unknown>) => ({
    index: Number(r[indexCol] ?? r.index ?? 0),
    _distance: Number(r._distance ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Catalog registry LanceDB (system__datasets, system__scopes)
// ---------------------------------------------------------------------------

let catalogDb: lancedb.Connection | null = null;
const catalogTables = new Map<string, lancedb.Table>();

/**
 * Open the catalog LanceDB connection.
 * Local: ${LATENT_SCOPE_DATA}/_catalog/lancedb
 * Cloud: LANCEDB_CATALOG_URI (falls back to LANCEDB_URI)
 */
export async function getCatalogDb(): Promise<lancedb.Connection> {
  if (catalogDb) return catalogDb;

  const catalogUri = process.env.LANCEDB_CATALOG_URI;
  const catalogApiKey = process.env.LANCEDB_CATALOG_API_KEY;

  if (catalogUri) {
    catalogDb = catalogApiKey
      ? await lancedb.connect({ uri: catalogUri, apiKey: catalogApiKey })
      : await lancedb.connect(catalogUri);
    return catalogDb;
  }

  // Local catalog
  const dataDir = process.env.LATENT_SCOPE_DATA;
  if (!dataDir) {
    throw new Error(
      "LANCEDB_CATALOG_URI or LATENT_SCOPE_DATA must be set for catalog access",
    );
  }
  const expandedDir = dataDir.startsWith("~/")
    ? `${process.env.HOME ?? ""}/${dataDir.slice(2)}`
    : dataDir;
  const catalogSubdir = process.env.LATENT_SCOPE_CATALOG_LOCAL_PATH ?? "_catalog/lancedb";
  const localPath = `${expandedDir}/${catalogSubdir}`;
  catalogDb = await lancedb.connect(localPath);
  return catalogDb;
}

/**
 * Open a catalog registry table (system__datasets or system__scopes).
 */
export async function getCatalogTable(
  tableName: string,
): Promise<lancedb.Table> {
  const cached = catalogTables.get(tableName);
  if (cached) return cached;

  const conn = await getCatalogDb();
  const table = await conn.openTable(tableName);
  catalogTables.set(tableName, table);
  return table;
}
