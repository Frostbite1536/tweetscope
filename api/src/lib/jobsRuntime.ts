import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, readFile, rm, stat, unlink, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

/** Repo root: three levels up from api/src/lib/ */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", p.slice(2));
  }
  return p;
}

function getDataDir(): string {
  const dataDir = process.env.LATENT_SCOPE_DATA;
  if (!dataDir) {
    throw new Error("LATENT_SCOPE_DATA must be set");
  }
  return expandHome(dataDir);
}

function now(): string {
  return new Date().toISOString();
}

function parseTimeoutMs(): number {
  const raw = process.env.LATENT_SCOPE_JOB_TIMEOUT_SEC;
  const seconds = raw ? Number.parseInt(raw, 10) : 60 * 30;
  if (!Number.isFinite(seconds) || seconds <= 0) return 60 * 30 * 1000;
  return seconds * 1000;
}

export interface JobRecord {
  id: string;
  dataset: string;
  job_name: string;
  command: string;
  status: "running" | "completed" | "error" | "dead";
  last_update: string;
  progress: string[];
  times: string[];
  kind: "subprocess";
  argv: string[];
  run_id?: string;
  scope_id?: string;
  imported_rows?: number | string;
  likes_dataset_id?: string;
  cause_of_death?: string;
}

interface RunningProcess {
  proc: ChildProcessByStdio<null, Readable, Readable>;
  killed: boolean;
}

const PROCESSES = new Map<string, RunningProcess>();

function jobNameFromArgv(argv: string[]): string {
  // Look for `-m module.name` pattern (e.g. python3 -m latentscope.scripts.twitter_import)
  const mIdx = argv.indexOf("-m");
  if (mIdx >= 0 && mIdx + 1 < argv.length) {
    const mod = argv[mIdx + 1] ?? "";
    // Use the last segment: "latentscope.scripts.twitter_import" → "twitter_import"
    const last = mod.split(".").pop() ?? mod;
    return last;
  }
  const first = argv[0] ?? "job";
  return first.startsWith("ls-") ? first.slice(3) : first;
}

function shellQuote(arg: string): string {
  if (!arg || /[^A-Za-z0-9_./:-]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  return arg;
}

function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

function updateJobFromOutputLine(job: JobRecord, line: string): void {
  if (line.includes("RUNNING:")) {
    const runId = line.split("RUNNING:")[1]?.trim();
    if (runId) job.run_id = runId;
  }
  if (line.includes("FINAL_SCOPE:")) {
    const scopeId = line.split("FINAL_SCOPE:")[1]?.trim();
    if (scopeId) job.scope_id = scopeId;
  }
  if (line.includes("IMPORTED_ROWS:")) {
    const raw = line.split("IMPORTED_ROWS:")[1]?.trim();
    if (!raw) return;
    const parsed = Number.parseInt(raw, 10);
    job.imported_rows = Number.isFinite(parsed) ? parsed : raw;
  }
  if (line.includes("LIKES_DATASET_ID:")) {
    const id = line.split("LIKES_DATASET_ID:")[1]?.trim();
    if (id) job.likes_dataset_id = id;
  }
}

function safeDatasetRoot(dataDir: string, dataset: string): string {
  return path.resolve(dataDir, dataset);
}

function isSafeDatasetPath(dataDir: string, dataset: string, candidatePath: string): boolean {
  const root = safeDatasetRoot(dataDir, dataset);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function ensureJobDir(dataset: string): Promise<string> {
  const dataDir = getDataDir();
  const jobDir = path.join(dataDir, dataset, "jobs");
  await mkdir(jobDir, { recursive: true });
  return jobDir;
}

function jobProgressPath(dataset: string, jobId: string): string {
  const dataDir = getDataDir();
  return path.join(dataDir, dataset, "jobs", `${jobId}.json`);
}

export async function writeJob(dataset: string, jobId: string, job: JobRecord): Promise<void> {
  await ensureJobDir(dataset);
  const p = jobProgressPath(dataset, jobId);
  await writeFile(p, JSON.stringify(job), "utf-8");
}

export async function readJob(dataset: string, jobId: string): Promise<JobRecord> {
  const p = jobProgressPath(dataset, jobId);
  try {
    const text = await readFile(p, "utf-8");
    return JSON.parse(text) as JobRecord;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const text = await readFile(p, "utf-8");
    return JSON.parse(text) as JobRecord;
  }
}

export async function listJobs(dataset: string): Promise<JobRecord[]> {
  const dataDir = getDataDir();
  const jobDir = path.join(dataDir, dataset, "jobs");
  try {
    const entries = await readdir(jobDir);
    const jobs: JobRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const text = await readFile(path.join(jobDir, entry), "utf-8");
      jobs.push(JSON.parse(text) as JobRecord);
    }
    return jobs;
  } catch {
    return [];
  }
}

async function removePathIfExists(p: string): Promise<void> {
  const s = await stat(p);
  if (s.isDirectory()) {
    await rm(p, { recursive: true, force: false });
  } else {
    await unlink(p);
  }
}

export function killProcess(jobId: string): boolean {
  const running = PROCESSES.get(jobId);
  if (!running) return false;
  running.killed = true;
  return running.proc.kill();
}

export async function markJobDead(
  dataset: string,
  jobId: string,
  causeOfDeath: string,
): Promise<JobRecord> {
  const job = await readJob(dataset, jobId);
  job.status = "dead";
  job.cause_of_death = causeOfDeath;
  job.last_update = now();
  await writeJob(dataset, jobId, job);
  return job;
}

export async function startSubprocessJob(opts: {
  dataset: string;
  jobId: string;
  argv: string[];
  cleanupPaths?: string[];
}): Promise<void> {
  const { dataset, jobId, argv, cleanupPaths = [] } = opts;
  const job: JobRecord = {
    id: jobId,
    dataset,
    job_name: jobNameFromArgv(argv),
    command: shellJoin(argv),
    status: "running",
    last_update: now(),
    progress: [],
    times: [],
    kind: "subprocess",
    argv,
  };
  await writeJob(dataset, jobId, job);

  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  const proc = spawn(argv[0] ?? "", argv.slice(1), {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running: RunningProcess = { proc, killed: false };
  PROCESSES.set(jobId, running);

  const timeoutMs = parseTimeoutMs();
  let timedOut = false;
  let inactivityTimer: NodeJS.Timeout | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  const queueWrite = (fn: () => Promise<void>): void => {
    writeQueue = writeQueue.then(fn).catch((err) => {
      console.error("jobsRuntime write failure:", err);
    });
  };

  const bumpTimeout = (): void => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      running.killed = false;
      queueWrite(async () => {
        const line = `Timeout: No output for more than ${Math.floor(timeoutMs / 1000)} seconds.`;
        job.progress.push(line);
        job.times.push(now());
        job.last_update = now();
        job.status = "error";
        await writeJob(dataset, jobId, job);
      });
      proc.kill();
    }, timeoutMs);
  };

  const appendLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line) return;
    queueWrite(async () => {
      updateJobFromOutputLine(job, line);
      job.progress.push(line);
      job.times.push(now());
      job.last_update = now();
      await writeJob(dataset, jobId, job);
    });
    bumpTimeout();
  };

  const bindStream = (stream: NodeJS.ReadableStream): void => {
    let buffer = "";
    stream.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) appendLine(line);
    });
    stream.on("end", () => {
      if (buffer.trim()) appendLine(buffer);
      buffer = "";
    });
  };

  bindStream(proc.stdout);
  bindStream(proc.stderr);
  bumpTimeout();

  proc.on("error", (err) => {
    queueWrite(async () => {
      job.progress.push(`Process error: ${String(err)}`);
      job.times.push(now());
      job.last_update = now();
      job.status = "error";
      await writeJob(dataset, jobId, job);
    });
  });

  proc.on("close", (code) => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    void (async () => {
      await writeQueue;

      if (running.killed) {
        job.status = "dead";
        job.cause_of_death = "killed";
      } else if (timedOut) {
        job.status = "error";
      } else {
        job.status = code === 0 ? "completed" : "error";
      }

      const dataDir = getDataDir();
      const cleanupSkipped: string[] = [];
      const cleanupErrors: string[] = [];
      for (const p of cleanupPaths) {
        if (!p) continue;
        if (!isSafeDatasetPath(dataDir, dataset, p)) {
          cleanupSkipped.push(`${p}: outside dataset root`);
          continue;
        }
        try {
          await removePathIfExists(p);
        } catch (err) {
          cleanupErrors.push(`${p}: ${String(err)}`);
        }
      }
      if (cleanupSkipped.length > 0) {
        job.progress.push("Cleanup skipped:");
        job.progress.push(...cleanupSkipped);
      }
      if (cleanupErrors.length > 0) {
        job.progress.push("Cleanup errors:");
        job.progress.push(...cleanupErrors);
      } else if (cleanupPaths.length > 0) {
        job.progress.push("Cleaned up temporary upload files.");
      }

      job.last_update = now();
      await writeJob(dataset, jobId, job);
      PROCESSES.delete(jobId);
    })().catch((err) => {
      console.error("jobsRuntime finalize failure:", err);
      PROCESSES.delete(jobId);
    });
  });
}
