import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import {
  killProcess,
  listJobs,
  markJobDead,
  readJob,
  startSubprocessJob,
} from "../lib/jobsRuntime.js";

type BodyValue = string | File | File[] | undefined;

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", p.slice(2));
  }
  return p;
}

function getDataDir(): string {
  const dataDir = process.env.LATENT_SCOPE_DATA;
  if (!dataDir) throw new Error("LATENT_SCOPE_DATA must be set");
  return expandHome(dataDir);
}

/** Returns the argv prefix for running a Python module, e.g. ["uv", "run", "python3"]. */
function getPythonPrefix(): string[] {
  const configured =
    process.env.LATENT_SCOPE_PYTHON ??
    process.env.PYTHON ??
    process.env.PYTHON_EXECUTABLE;
  if (configured && configured.trim()) {
    return configured.trim().split(/\s+/);
  }
  return ["uv", "run", "python3"];
}

function sanitizeDatasetId(value: string): string {
  const lowered = value.trim().toLowerCase();
  const normalized = lowered
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Invalid dataset id");
  return normalized;
}

function asString(raw: BodyValue, defaultValue = ""): string {
  if (typeof raw === "string") return raw;
  return defaultValue;
}

function asFirstFile(raw: BodyValue): File | null {
  if (raw instanceof File) return raw;
  if (Array.isArray(raw)) {
    const candidate = raw.find((entry) => entry instanceof File);
    return candidate ?? null;
  }
  return null;
}

function truthyFlag(raw: string | undefined, defaultValue = false): boolean {
  if (raw == null || raw === "") return defaultValue;
  return ["1", "true", "t", "y", "yes", "on"].includes(raw.trim().toLowerCase());
}

function falsyFlag(raw: string | undefined): boolean {
  if (raw == null || raw === "") return false;
  return ["0", "false", "f", "n", "no", "off"].includes(raw.trim().toLowerCase());
}

function ensureInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? Number.parseInt(String(value), 10)
      : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an integer`);
  }
  return parsed;
}

function validateExtractedArchivePayload(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Extracted payload must be a JSON object");
  }
  const obj = payload as Record<string, unknown>;

  if (obj.archive_format !== "x_native_extracted_v1") {
    throw new Error("archive_format must be 'x_native_extracted_v1'");
  }
  if (!obj.profile || typeof obj.profile !== "object" || Array.isArray(obj.profile)) {
    throw new Error("profile must be an object");
  }

  const tweets = obj.tweets;
  const likes = obj.likes;
  if (!Array.isArray(tweets)) throw new Error("tweets must be an array");
  if (!Array.isArray(likes)) throw new Error("likes must be an array");
  if (tweets.length === 0 && likes.length === 0) {
    throw new Error("Extracted payload must include at least one tweet or like");
  }

  for (let i = 0; i < tweets.length; i += 1) {
    const item = tweets[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`tweets[${i}] must be an object`);
    }
    const tweet = (item as Record<string, unknown>).tweet;
    const tweetObj =
      tweet && typeof tweet === "object" && !Array.isArray(tweet)
        ? (tweet as Record<string, unknown>)
        : (item as Record<string, unknown>);
    const tweetId = tweetObj.id_str ?? tweetObj.id;
    const text = tweetObj.full_text ?? tweetObj.text;
    if (!String(tweetId ?? "").trim()) throw new Error(`tweets[${i}] missing id_str/id`);
    if (!String(text ?? "").trim()) throw new Error(`tweets[${i}] missing full_text/text`);
  }

  for (let i = 0; i < likes.length; i += 1) {
    const item = likes[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`likes[${i}] must be an object`);
    }
    const like = (item as Record<string, unknown>).like;
    const likeObj =
      like && typeof like === "object" && !Array.isArray(like)
        ? (like as Record<string, unknown>)
        : (item as Record<string, unknown>);
    const tweetId = likeObj.tweetId ?? likeObj.tweet_id ?? likeObj.id_str ?? likeObj.id;
    if (!String(tweetId ?? "").trim()) throw new Error(`likes[${i}] missing tweetId/tweet_id/id`);
  }

  const tweetCount = ensureInteger(obj.tweet_count, "tweet_count");
  const likesCount = ensureInteger(obj.likes_count, "likes_count");
  const totalCount = ensureInteger(obj.total_count, "total_count");
  if (tweetCount !== tweets.length) throw new Error("tweet_count does not match tweets length");
  if (likesCount !== likes.length) throw new Error("likes_count does not match likes length");
  if (totalCount !== tweetCount + likesCount) {
    throw new Error("total_count must equal tweet_count + likes_count");
  }
}

export const jobsRoutes = new Hono()
  .get("/job", async (c) => {
    const datasetRaw = c.req.query("dataset");
    const jobId = c.req.query("job_id");
    if (!datasetRaw || !jobId) {
      return c.json({ error: "Missing dataset or job_id" }, 400);
    }
    let dataset: string;
    try {
      dataset = sanitizeDatasetId(datasetRaw);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    try {
      const job = await readJob(dataset, jobId);
      return c.json(job);
    } catch {
      return c.json({ status: "not found" }, 404);
    }
  })
  .get("/all", async (c) => {
    const datasetRaw = c.req.query("dataset");
    if (!datasetRaw) return c.json([]);
    let dataset: string;
    try {
      dataset = sanitizeDatasetId(datasetRaw);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    return c.json(await listJobs(dataset));
  })
  .get("/kill", async (c) => {
    const datasetRaw = c.req.query("dataset");
    const jobId = c.req.query("job_id");
    if (!datasetRaw || !jobId) {
      return c.json({ error: "Missing dataset or job_id" }, 400);
    }
    let dataset: string;
    try {
      dataset = sanitizeDatasetId(datasetRaw);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    try {
      if (killProcess(jobId)) {
        const job = await markJobDead(dataset, jobId, "killed");
        return c.json(job);
      }
      const job = await markJobDead(dataset, jobId, "process not found, presumed dead");
      return c.json(job);
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  })
  .post("/import_twitter", async (c) => {
    const disableRaw = (
      process.env.DISABLE_NEW_COLLECTION ??
      process.env.LATENT_SCOPE_DISABLE_NEW_COLLECTION ??
      ""
    ).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(disableRaw)) {
      return c.json({ error: "Collection creation is currently disabled." }, 403);
    }

    const jobId = randomUUID();
    let cleanupPaths: string[] = [];
    try {
      const dataDir = getDataDir();
      const body = (await c.req.parseBody({ all: true })) as Record<string, BodyValue>;

      const dataset = sanitizeDatasetId(asString(body.dataset));
      const sourceType = asString(body.source_type, "community_json").trim().toLowerCase();

      const datasetDir = path.join(dataDir, dataset);
      const uploadsDir = path.join(datasetDir, "uploads");
      await mkdir(uploadsDir, { recursive: true });

      const argv: string[] = [
        ...getPythonPrefix(),
        "-m",
        "latentscope.scripts.twitter_import",
        dataset,
      ];

      if (sourceType === "zip") {
        return c.json(
          {
            error:
              "Raw zip uploads are disabled. Upload extracted JSON payload instead (source_type=community_json).",
          },
          400,
        );
      }

      if (sourceType === "community") {
        const username = asString(body.username).trim();
        if (!username) return c.json({ error: "Missing username" }, 400);
        argv.push("--source", "community", "--username", username);
      } else if (sourceType === "community_json") {
        const file = asFirstFile(body.file);
        if (!file) return c.json({ error: "Missing community JSON file" }, 400);

        const jobUploadDir = path.join(uploadsDir, jobId);
        await mkdir(jobUploadDir, { recursive: true });
        const filePath = path.join(jobUploadDir, `community-extract-${randomUUID().replace(/-/g, "")}.json`);
        const payloadText = Buffer.from(await file.arrayBuffer()).toString("utf-8");
        await writeFile(filePath, payloadText, "utf-8");
        try {
          const payload = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
          validateExtractedArchivePayload(payload);
        } catch (err) {
          await rm(jobUploadDir, { recursive: true, force: true });
          return c.json({ error: `Invalid extracted archive payload: ${String(err)}` }, 400);
        }
        cleanupPaths.push(jobUploadDir);
        argv.push("--source", "community_json", "--input_path", filePath);
      } else {
        return c.json({ error: `Unsupported source_type: ${sourceType}` }, 400);
      }

      const optionalArgs = [
        "year",
        "lang",
        "min_favorites",
        "min_text_length",
        "top_n",
        "sort",
        "text_column",
        "embedding_model",
        "umap_neighbors",
        "umap_min_dist",
        "cluster_samples",
        "cluster_min_samples",
        "cluster_selection_epsilon",
        "hierarchy_min_samples",
        "hierarchy_max_layers",
        "hierarchy_base_min_cluster_size",
        "hierarchy_base_n_clusters",
        "hierarchy_layer_similarity_threshold",
        "toponymy_provider",
        "toponymy_model",
        "toponymy_context",
        "max_concurrent_requests",
        "import_batch_id",
      ];

      for (const key of optionalArgs) {
        const value = asString(body[key]);
        if (value !== "") argv.push(`--${key}`, value);
      }

      if (truthyFlag(asString(body.exclude_replies))) argv.push("--exclude_replies");
      if (truthyFlag(asString(body.exclude_retweets))) argv.push("--exclude_retweets");
      if (falsyFlag(asString(body.build_links))) argv.push("--no-build_links");
      if (truthyFlag(asString(body.include_likes))) argv.push("--include_likes");
      if (falsyFlag(asString(body.hierarchical_labels))) argv.push("--no-hierarchical_labels");
      if (truthyFlag(asString(body.hierarchy_reproducible))) argv.push("--hierarchy_reproducible");
      if (falsyFlag(asString(body.toponymy_adaptive_exemplars))) argv.push("--no-toponymy_adaptive_exemplars");
      const runPipeline = truthyFlag(asString(body.run_pipeline), true);
      if (runPipeline) argv.push("--run_pipeline");
      const incrementalLinks = asString(body.incremental_links);
      if (incrementalLinks && falsyFlag(incrementalLinks)) argv.push("--no-incremental-links");

      await startSubprocessJob({ dataset, jobId, argv, cleanupPaths });
      return c.json({ job_id: jobId, dataset });
    } catch (err) {
      const message = String(err);
      for (const p of cleanupPaths) {
        try {
          await rm(p, { recursive: true, force: true });
        } catch {
          // Best effort
        }
      }
      const status = message.includes("Invalid dataset id") ? 400 : 500;
      return c.json({ error: message }, status);
    }
  });
