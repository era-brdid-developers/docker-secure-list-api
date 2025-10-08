import "dotenv/config";
import express from "express";
import morgan from "morgan";
import { makeSecurity } from "./security.js";
import { makeAuthMiddleware } from "./auth.js";
// import { makeDocker, listContainers, pm2Status } from "./docker.js";
import {
  makeDocker,
  listContainers,
  pm2Status,
  restartContainers,
  pm2RestartAll,
  pm2LogsContains
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


app.get(
  "/v1/containers/:id/pm2/logs/redis-error",
  auth,
  async (req, res) => {
    const { id } = req.params;
    try {
      const search = "Redis Client Error Error: getaddrinfo ENOTFOUND redis";
      const found = await pm2LogsContains(docker, id, search);
      res.json({ found });
    } catch (e) {
      res.status(500).json({ error: e.message || "pm2_logs_error" });
    }
  }
);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API segura ouvindo em :${port}`));
