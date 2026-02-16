import { Hono } from "hono";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  DATA_DIR,
  RAW_DATA_URL,
  buildFileUrl,
  ensureSafeRelativePath,
  fileExists,
} from "./dataShared.js";
import {
  listDatasets as registryListDatasets,
  getDataset as registryGetDataset,
  listScopes as registryListScopes,
  getScope as registryGetScope,
} from "../lib/catalogRepo.js";

export const catalogRoutes = new Hono()
  .get("/datasets/:dataset/meta", async (c) => {
    const dataset = c.req.param("dataset");
    try {
      const meta = await registryGetDataset(dataset);
      if (meta) return c.json(meta);
      return c.json({ error: "Dataset metadata not found" }, 404);
    } catch (err) {
      console.error("catalogRepo.getDataset failed:", err);
      return c.json({ error: "Dataset metadata not found" }, 404);
    }
  })
  .get("/datasets/:dataset/scopes", async (c) => {
    const dataset = c.req.param("dataset");
    try {
      const scopes = await registryListScopes(dataset);
      return c.json(scopes);
    } catch (err) {
      console.error("catalogRepo.listScopes failed:", err);
      return c.json({ error: "Scopes not found" }, 404);
    }
  })
  .get("/datasets/:dataset/scopes/:scope", async (c) => {
    const { dataset, scope } = c.req.param();
    try {
      const scopeMeta = await registryGetScope(dataset, scope);
      if (scopeMeta) return c.json(scopeMeta);
      return c.json({ error: "Scope not found" }, 404);
    } catch (err) {
      console.error("catalogRepo.getScope failed:", err);
      return c.json({ error: "Scope not found" }, 404);
    }
  })
  .get("/tags", async (c) => {
    return c.json({});
  })
  .get("/models/embedding_models", async (c) => {
    return c.json([] as string[]);
  })
  .get("/files/:filePath{.+}", async (c) => {
    const filePath = ensureSafeRelativePath(c.req.param("filePath"));

    if (DATA_DIR) {
      const fullPath = path.join(DATA_DIR, filePath);
      if (await fileExists(fullPath)) {
        const buffer = await readFile(fullPath);
        return new Response(buffer, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
    }

    if (RAW_DATA_URL) {
      const res = await fetch(buildFileUrl(filePath));
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    return c.json({ error: "File not found" }, 404);
  })
  .get("/datasets", async (c) => {
    try {
      const datasets = await registryListDatasets();
      return c.json(datasets);
    } catch (err) {
      console.error("catalogRepo.listDatasets failed:", err);
      return c.json([] as string[]);
    }
  });
