/**
 * Standalone test: discover threads from sheik-tweets LanceDB edges table.
 * Run: cd api && LATENT_SCOPE_DATA=~/latent-scope-data npx tsx test_threads.ts
 */
import * as lancedb from "@lancedb/lancedb";
import * as path from "path";
import * as os from "os";

const DATA_DIR = process.env.LATENT_SCOPE_DATA
  ? process.env.LATENT_SCOPE_DATA.replace(/^~/, os.homedir())
  : path.join(os.homedir(), "latent-scope-data");
const DATASET = process.env.DATASET ?? "sheik-tweets";

interface EdgeRow {
  edge_kind: string;
  src_tweet_id: string;
  dst_tweet_id: string;
  src_ls_index: number | null;
  dst_ls_index: number | null;
}

async function main() {
  const dbPath = path.join(DATA_DIR, DATASET, "lancedb");
  console.log(`Connecting to ${dbPath}`);
  const db = await lancedb.connect(dbPath);

  const edgesTable = await db.openTable(`${DATASET}__edges`);
  const rowCount = await edgesTable.countRows();
  console.log(`Edges table: ${rowCount} rows`);

  // Get all reply edges
  const replyRows = await edgesTable
    .query()
    .where("edge_kind = 'reply'")
    .limit(rowCount)
    .toArray();
  console.log(`Reply edges: ${replyRows.length}`);

  // Filter to internal edges (both src and dst have valid ls_index)
  const internalEdges: EdgeRow[] = [];
  for (const row of replyRows) {
    const src = Number(row.src_ls_index);
    const dst = Number(row.dst_ls_index);
    if (src >= 0 && dst >= 0 && Number.isFinite(src) && Number.isFinite(dst)) {
      internalEdges.push({
        edge_kind: String(row.edge_kind),
        src_tweet_id: String(row.src_tweet_id),
        dst_tweet_id: String(row.dst_tweet_id),
        src_ls_index: src,
        dst_ls_index: dst,
      });
    }
  }
  console.log(`Internal reply edges: ${internalEdges.length}`);

  // Build parent map: child → parent (by ls_index)
  const parentMap = new Map<number, number>();
  const tweetIdByIndex = new Map<number, string>();

  for (const edge of internalEdges) {
    if (!parentMap.has(edge.src_ls_index!)) {
      parentMap.set(edge.src_ls_index!, edge.dst_ls_index!);
    }
    tweetIdByIndex.set(edge.src_ls_index!, edge.src_tweet_id);
    tweetIdByIndex.set(edge.dst_ls_index!, edge.dst_tweet_id);
  }

  // Collect all nodes
  const allNodes = new Set<number>();
  for (const edge of internalEdges) {
    allNodes.add(edge.src_ls_index!);
    allNodes.add(edge.dst_ls_index!);
  }
  console.log(`Unique nodes in internal edges: ${allNodes.size}`);

  // Walk to roots
  const rootCache = new Map<number, number>();
  const depthCache = new Map<number, number>();

  function resolve(node: number): [number, number] {
    if (rootCache.has(node)) return [rootCache.get(node)!, depthCache.get(node)!];

    const visited: number[] = [];
    const visitedSet = new Set<number>();
    let current = node;

    while (true) {
      if (rootCache.has(current)) {
        const cachedRoot = rootCache.get(current)!;
        const cachedDepth = depthCache.get(current)!;
        let depth = cachedDepth + visited.length;
        for (const v of visited) {
          rootCache.set(v, cachedRoot);
          depthCache.set(v, depth);
          depth--;
        }
        return [rootCache.get(node)!, depthCache.get(node)!];
      }

      if (visitedSet.has(current)) {
        let depth = visited.length - 1;
        for (const v of visited) {
          rootCache.set(v, current);
          depthCache.set(v, depth);
          depth--;
        }
        return [rootCache.get(node)!, depthCache.get(node)!];
      }

      visited.push(current);
      visitedSet.add(current);

      const parent = parentMap.get(current);
      if (parent === undefined) {
        let depth = visited.length - 1;
        for (const v of visited) {
          rootCache.set(v, current);
          depthCache.set(v, depth);
          depth--;
        }
        return [rootCache.get(node)!, depthCache.get(node)!];
      }

      current = parent;
    }
  }

  for (const node of allNodes) {
    resolve(node);
  }

  // Group by root
  const threadMembers = new Map<number, number[]>();
  for (const node of allNodes) {
    const root = rootCache.get(node)!;
    const members = threadMembers.get(root) ?? [];
    members.push(node);
    threadMembers.set(root, members);
  }

  // Filter to size >= 2
  const threads: Array<{ root: number; size: number; members: number[] }> = [];
  for (const [root, members] of threadMembers) {
    if (members.length < 2) continue;
    members.sort((a, b) => (depthCache.get(a) ?? 0) - (depthCache.get(b) ?? 0));
    threads.push({ root, size: members.length, members });
  }

  // Sort
  threads.sort((a, b) => {
    const aPri = a.size >= 3 ? 1 : 0;
    const bPri = b.size >= 3 ? 1 : 0;
    if (aPri !== bPri) return bPri - aPri;
    return b.size - a.size;
  });

  console.log(`\n=== THREADS (size >= 2): ${threads.length} ===`);
  for (const t of threads.slice(0, 15)) {
    console.log(`  root_idx=${t.root} (tweet ${tweetIdByIndex.get(t.root) ?? '?'}), size=${t.size}`);
    console.log(`    members: [${t.members.slice(0, 8).join(', ')}${t.size > 8 ? '...' : ''}]`);
    console.log(`    depths: [${t.members.slice(0, 8).map(m => depthCache.get(m) ?? '?').join(', ')}${t.size > 8 ? '...' : ''}]`);
  }

  // Stats
  const sizeCounts = new Map<number, number>();
  for (const t of threads) {
    sizeCounts.set(t.size, (sizeCounts.get(t.size) ?? 0) + 1);
  }
  console.log(`\n=== SIZE DISTRIBUTION ===`);
  for (const [size, count] of [...sizeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  size=${size}: ${count} threads`);
  }

  // Read input.parquet to verify root tweet texts
  console.log(`\n=== ROOT TWEET PREVIEWS (top 10) ===`);
  // We can't easily read parquet from TS, but we can show the indices for cross-reference
  for (const t of threads.slice(0, 10)) {
    console.log(`  Thread root_idx=${t.root}: ${t.size} tweets`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
