import { resolveScopeLanceTableId } from './src/lib/catalogRepo.ts';
import { getDatasetTable } from './src/lib/lancedb.ts';
import { normalizeIndex, attachIndexFields, jsonSafe, sqlIdentifier } from './src/routes/dataShared.ts';

(async () => {
  try {
    const dataset = 'sheik-tweets';
    const scope = 'scopes-001';
    const tableId = await resolveScopeLanceTableId(dataset, scope);
    const table = await getDatasetTable(dataset, tableId);
    const schema = (await table.schema()) as { fields?: Array<{ name?: string }> };
    const cols = (schema.fields ?? []).map((f) => String(f.name ?? '')).filter(Boolean);
    const indexColumn = ['index', 'ls_index', 'id'].find((c) => cols.includes(c)) ?? 'index';
    const requested = [1];
    const selected = Array.from(new Set(cols.filter((c) => c !== 'vector').concat(indexColumn)));
    const where = `${sqlIdentifier(indexColumn)} IN (${requested.join(', ')})`;
    const rowsRaw = await table
      .query()
      .where(where)
      .select(selected)
      .limit(Math.max(requested.length, 1))
      .toArray();

    const rowByIndex = new Map<number, Record<string, unknown>>();
    for (const row of rowsRaw as Record<string, unknown>[]) {
      const idx = normalizeIndex(row[indexColumn]);
      if (idx === null) continue;
      rowByIndex.set(idx, attachIndexFields(jsonSafe(row) as Record<string, unknown>, indexColumn));
    }
    const ordered = requested
      .map((idx) => rowByIndex.get(idx))
      .filter((row): row is Record<string, unknown> => Boolean(row));

    console.log({ tableId, indexColumn, where, rowsRaw: rowsRaw.length, ordered: ordered.length });
  } catch (e) {
    console.error(e);
  }
})();
