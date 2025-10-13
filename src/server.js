import "dotenv/config";
import express from "express";
import morgan from "morgan";
import { makeSecurity } from "./security.js";
import { makeAuthMiddleware } from "./auth.js";
import Ajv from "ajv";

import {
  makeDocker,
  listContainers,
  pm2Status,
  restartContainers,
  pm2RestartAll,
  // pm2LogsContains,
  getContainerStats,
  updateContainerMemory,
  putFileInContainer,
  pm2StartEcosystem,
  pm2RestartApp
} from "./docker.js";

const app = express();
makeSecurity(app, { corsOrigins: process.env.CORS_ORIGINS });
app.use(morgan("combined"));
app.use(express.json()); // habilita parsing de JSON

const auth = makeAuthMiddleware(process.env);
const docker = makeDocker(process.env);

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/v1/containers", auth, async (_req, res) => {
  try {
    const items = await listContainers(docker);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: "docker_error" });
  }
});

app.get("/v1/containers/:id/pm2status", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const items = await pm2Status(docker, id);
    res.json({ items });
  } catch (e) {
    // Se o contêiner não existir ou não tiver pm2, devolva erro adequado
    res.status(500).json({ error: e.message || "pm2_error" });
  }
});

app.post("/v1/containers/restart", auth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length !== 4) {
    return res.status(400).json({
      error: "É necessário fornecer exatamente 4 IDs de containers"
    });
  }
  try {
    const result = await restartContainers(docker, ids);
    res.json({ result });
  } catch (e) {
    res
      .status(500)
      .json({ error: e.message || "docker_restart_error" });
  }
});

app.post("/v1/containers/:id/pm2/restart", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const output = await pm2RestartAll(docker, id);
    res.json({ output });
  } catch (e) {
    res
      .status(500)
      .json({ error: e.message || "pm2_restart_error" });
  }
});


// app.get(

// "/v1/containers/:id/pm2/logs/redis-error",

  // auth,

  // async (req, res) => {

    // const { id } = req.params;

    // try {

      // const search = "Redis Client Error Error: getaddrinfo ENOTFOUND redis";

      // const found = await pm2LogsContains(docker, id, search);

      // res.json({ found });

    // } catch (e) {

      // res.status(500).json({ error: e.message || "pm2_logs_error" });

    // }

  // }

// );


app.get("/v1/containers/:id/stats", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const stats = await getContainerStats(docker, id);
    res.json(stats);
  } catch (e) {
    res
      .status(500)
      .json({ error: e.message || "docker_stats_error" });
  }
});

app.post("/v1/containers/:id/memory", auth, async (req, res) => {
  const { id } = req.params;
  const { memory, memorySwap } = req.body || {};
  if (!memory) {
    return res.status(400).json({ error: "É necessário informar o limite de memória" });
  }
  try {
    const result = await updateContainerMemory(docker, id, memory, memorySwap);
    res.json({ updated: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message || "docker_update_error" });
  }
});

//Nova rota para iniciar ecossistema PM2
const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });

// Permite scripts em /app/... e logs em /var/log/...
const pathRegex = "^/(app|var)/(log|app|[^\\s]+).*$";

const ecosystemSchema = {
  type: "object",
  required: ["apps"],
  additionalProperties: false,
  properties: {
    apps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          script: { type: "string", pattern: pathRegex },
          watch: { type: "boolean" },
          ignore_watch: {
            type: "array", maxItems: 50,
            items: { type: "string", maxLength: 200 }
          },
          autorestart: { type: "boolean" },
          instances: { type: "integer", minimum: 1, maximum: 64 },
          max_memory_restart: { type: "string", pattern: "^[0-9]+(K|M|G|k|m|g)$" },
          exec_mode: { type: "string", enum: ["fork", "cluster"] },
          interpreter: { type: "string", maxLength: 300 },
          env: {
            type: "object",
            additionalProperties: { type: ["string", "number", "boolean"] }
          },
          out_file: { type: "string", pattern: "^/var/log/.*" },
          error_file: { type: "string", pattern: "^/var/log/.*" },
          log_date_format: { type: "string", maxLength: 100 }
        },
        required: ["name", "script", "instances", "exec_mode"]
      }
    }
  }
};
const validateEcosystem = ajv.compile(ecosystemSchema);

app.post("/v1/containers/:id/pm2/ecosystem/start", auth, async (req, res) => {
  const { id } = req.params;
  const { ecosystem, destDir = "/app/pm2", filename = "ecosystem.json" } = req.body || {};

  if (!ecosystem || typeof ecosystem !== "object") {
    return res.status(400).json({ error: "missing_ecosystem_json" });
  }

  const ok = validateEcosystem(ecosystem);
  if (!ok) {
    return res.status(400).json({
      error: "invalid_ecosystem",
      details: validateEcosystem.errors
    });
  }

  try {
    const jsonStr = JSON.stringify(ecosystem);
    await putFileInContainer(docker, id, destDir, filename, Buffer.from(jsonStr, "utf8"));
  } catch (e) {
    return res.status(500).json({ error: "put_archive_error", details: e.message });
  }

  const inContainerPath = `${destDir.replace(/\/+$/, "")}/${filename}`;
  try {
    const output = await pm2StartEcosystem(docker, id, inContainerPath);
    return res.json({ ok: true, path: inContainerPath, output });
  } catch (e) {
    return res.status(500).json({ error: "pm2_start_error", details: e.message });
  }
});


// Exemplo de uso: POST /v1/containers/94e010669ad7/pm2/restart/app.chat
app.post("/v1/containers/:id/pm2/restart/:appName", auth, async (req, res) => {
  const { id, appName } = req.params;
  try {
    const output = await pm2RestartApp(docker, id, appName);
    res.json({ output });
  } catch (e) {
    res.status(500).json({ error: e.message || "pm2_restart_error" });
  }
});


const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API segura ouvindo em :${port}`));
