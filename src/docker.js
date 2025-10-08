import Docker from "dockerode";

/** Mantém o código existente… */
export function makeDocker(env) {
  const socket = env.DOCKER_SOCKET || "/var/run/docker.sock";
  return new Docker({ socketPath: socket });
}
export async function listContainers(docker) {
  const containers = await docker.listContainers({ all: true });
  return containers.map(c => ({
    id: c.Id.slice(0, 12),
    name: (c.Names?.[0] || "").replace(/^\//, "")
  }));
}

/**
 * Executa um comando dentro de um contêiner e retorna a saída (stdout+stderr).
 */
export async function execInContainer(docker, containerId, cmdArgs) {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmdArgs,
    AttachStdout: true,
    AttachStderr: true
  });
  return new Promise((resolve, reject) => {
    exec.start((err, stream) => {
      if (err) return reject(err);
      let output = "";
      stream.on("data", chunk => (output += chunk.toString()));
      stream.on("end", () => resolve(output.trim()));
    });
  });
}

/**
 * Retorna a lista de processos do PM2 em formato estruturado.
 * Usa `pm2 jlist` para obter JSON e mapeia os principais campos.
 */


export async function pm2Status(docker, containerId) {
  // Executa pm2 status dentro do container e remove códigos de cor
  const output = await execInContainer(docker, containerId, [
    "pm2",
    "status",
    "--no-color"
  ]);
  // Divide a saída em linhas e remove linhas vazias
  return output.trim().split(/\r?\n/).filter(Boolean);
}

/**
 * Reinicia vários containers pelo ID.
 * Espera um array com **exatamente 4 IDs**.
 * Retorna um array com o status de cada tentativa.
 */
export async function restartContainers(docker, ids) {
  if (!Array.isArray(ids) || ids.length !== 4) {
    throw new Error("invalid_ids");
  }
  const results = [];
  for (const id of ids) {
    const container = docker.getContainer(id);
    try {
      await container.restart();
      results.push({ id, status: "restarted" });
    } catch (err) {
      results.push({ id, status: "error", error: err.message });
    }
  }
  return results;
}

/**
 * Executa `pm2 restart all` dentro de um container.
 * Devolve a saída bruta do comando.
 */
export async function pm2RestartAll(docker, containerId) {
  // Usa execInContainer definido anteriormente
  const output = await execInContainer(docker, containerId, [
    "pm2",
    "restart",
    "all",
    "--no-color"
  ]);
  return output.trim();
}


/**
 * Verifica se determinada string aparece nos logs do PM2 em um contêiner.
 * Escuta logs por 3 segundos e retorna true/false.
 */
export async function pm2LogsContains(docker, containerId, searchString) {
  // 1) opcional: esvaziar logs para garantir que só venham mensagens novas
  await execInContainer(docker, containerId, ["pm2", "flush"]);

  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    // 2) solicitar 0 linhas prévias e remover códigos de cor
    Cmd: ["pm2", "logs", "--no-color", "--lines", "0"],
    AttachStdout: true,
    AttachStderr: true
  });

  return new Promise((resolve, reject) => {
    let found = false;
    exec.start((err, stream) => {
      if (err) return reject(err);
      // ler apenas logs que surgirem após o flush/--lines 0
      stream.on("data", chunk => {
        if (!found && chunk.toString().includes(searchString)) {
          found = true;
        }
      });
      setTimeout(() => {
        stream.removeAllListeners();
        resolve(found);
      }, 3000);
      stream.on("error", e => {
        stream.removeAllListeners();
        reject(e);
      });
    });
  });
}
