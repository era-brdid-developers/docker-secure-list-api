import Docker from "dockerode";
import { exec as execCb } from "child_process";
import { promises as fs } from "fs";
import { promisify } from "util";
import crypto from "crypto";

const exec = promisify(execCb);

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

// src/docker.js
/**
 * Devolve as estatísticas de uso de recursos de um contêiner (CPU, memória etc.).
 * Usa a API do Docker com stream:false para retornar apenas um snapshot.
 */
// docker.js

/**
 * Devolve as estatísticas de uso de recursos de um contêiner (CPU, memória etc.).
 * Usa a API do Docker com stream:false para retornar apenas um snapshot.
 */
export async function getContainerStats(docker, containerId) {
  const container = docker.getContainer(containerId);
  // Pede um snapshot (stream:false)
  const data = await container.stats({ stream: false });

  // Se vier como Buffer, converte para string e parseia; caso contrário, retorna direto
  if (Buffer.isBuffer(data)) {
    return JSON.parse(data.toString());
  } else {
    return data;
  }
}


// src/docker.js

/**
 * Converte valores de memória com sufixo (m/M, g/G, k/K) em bytes.
 * Aceita números simples (assumidos como bytes) ou strings tipo "4g", "512m".
 */
function parseMemory(value) {
  if (typeof value === "number") return value;
  const match = /^([0-9.]+)\s*([kKmMgG])?/.exec(String(value).trim());
  if (!match) throw new Error("Invalid memory format");
  const num = parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  switch (unit) {
    case "g":
      return Math.round(num * 1024 ** 3);
    case "m":
      return Math.round(num * 1024 ** 2);
    case "k":
      return Math.round(num * 1024);
    default:
      // sem sufixo assume bytes
      return Math.round(num);
  }
}

/**
 * Atualiza os limites de memória de um contêiner.
 * `memory` e `memorySwap` podem ser strings como "4g", "512m" ou números em bytes.
 * Se `memorySwap` não for fornecido, assume o mesmo valor de `memory`.
 */
export async function updateContainerMemory(docker, containerId, memory, memorySwap) {
  const container = docker.getContainer(containerId);
  const memBytes = parseMemory(memory);
  const swapBytes = parseMemory(memorySwap ?? memory);
  // a API de update espera valores em bytes
  await container.update({
    Memory: memBytes,
    MemorySwap: swapBytes
  });
  return { id: containerId, memory: memBytes, memorySwap: swapBytes };
}


/**
 * Envia um arquivo para dentro do container usando apenas o binário `tar`.
 * Gera nomes únicos em /tmp para evitar colisões entre chamadas paralelas.
 */
export async function putFileInContainer(docker, containerId, destPath, filename, contentBuffer) {
  const safeId = containerId.slice(0, 12);
  const unique = crypto.randomBytes(4).toString("hex");
  const tmpDir = `/tmp/docker-upload-${safeId}-${unique}`;
  const tmpFile = `${tmpDir}/${filename}`;
  const tmpTar  = `${tmpDir}.tar`;

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tmpFile, contentBuffer);

    // Cria o TAR contendo apenas esse arquivo
    await exec(`tar -C ${tmpDir} -cf ${tmpTar} ${filename}`);

    const tarData = await fs.readFile(tmpTar);
    const container = docker.getContainer(containerId);
    await container.putArchive(tarData, { path: destPath.replace(/\/+$/, "") });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(tmpTar, { force: true });
  }
}

/** Executa `pm2 start <ecosystemPath>` dentro do container */
export async function pm2StartEcosystem(docker, containerId, ecosystemPath) {
  const output = await execInContainer(docker, containerId, [
    "pm2", "start", ecosystemPath, "--no-color"
  ]);
  return output.trim();
}



export async function pm2RestartApp(docker, containerId, appName) {
  const output = await execInContainer(docker, containerId, [
    "pm2",
    "restart",
    appName,
    "--no-color"
  ]);
  return output.trim();
}


/**
 * Obtém dados de um certificado X.509: data de expiração, CN e se está válido.
 * @param {Docker} docker - Cliente Docker
 * @param {string} containerId - ID do contêiner
 * @param {string} certPath - Caminho do .crt no contêiner
 * @returns {Promise<{expiresAt: string, subjectCN: string, isValid: boolean}>}
 */
export async function getCertDetails(docker, containerId, certPath) {
  // 1) Data de expiração (reaproveita getCertExpiry)
  const expiryStr = await getCertExpiry(docker, containerId, certPath);
  const expiryDate = new Date(expiryStr);
  const now = new Date();
  const isValid = !isNaN(expiryDate) && expiryDate > now;

  // 2) Extrai o CN do subject
  const subjectOutput = await execInContainer(docker, containerId, [
    "openssl",
    "x509",
    "-subject",
    "-noout",
    "-in",
    certPath
  ]);
  let cn = "";
const m1 = subjectOutput.match(/CN\s*=\s*([^,\/]*)/);
if (m1 && m1[1]) {
  cn = m1[1].trim();
} else {
  // tenta formato /CN=meu.dominio/OU=...
  const m2 = subjectOutput.match(/\/CN=([^\/]+)/);
  if (m2 && m2[1]) {
    cn = m2[1].trim();
  }
}

  return { expiresAt: expiryStr, subjectCN: cn, isValid };
}

export async function getCertExpiry(docker, containerId, certPath) {
  const output = await execInContainer(docker, containerId, [
    "openssl",
    "x509",
    "-enddate",
    "-noout",
    "-in",
    certPath
  ]);
  const match = output.match(/notAfter=(.*)/);
  if (!match) throw new Error("invalid_cert_output");
  return match[1].trim();
}


/**
 * Restaura todos os processos gerenciados pelo PM2 a partir de um dump salvo (pm2 resurrect).
 * Executa `pm2 resurrect` dentro do contêiner e retorna a saída do comando.
 *
 * @param {Docker} docker Instância do cliente Docker
 * @param {string} containerId ID do contêiner onde o PM2 está rodando
 * @returns {Promise<string>} Saída textual da execução do comando
 */
export async function pm2Resurrect(docker, containerId) {
  const output = await execInContainer(docker, containerId, [
    "pm2",
    "resurrect",
    "--no-color"
  ]);
  return output.trim();
}


/**
 * Obtém o nome da imagem (repositório:tag) de um contêiner sem usar `docker inspect`.
 * @param {Docker} docker Instância do cliente Docker
 * @param {string} containerId ID (ou prefixo único) do contêiner
 * @returns {Promise<string>} Nome da imagem do contêiner
 */
export async function getContainerImageTag(docker, containerId) {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();

  const imageId = info.Image; // ID SHA256 da imagem (com prefixo "sha256:")

  try {
    const images = await docker.listImages();
    
    // Procura a imagem pelo ID, considerando que pode vir com ou sem prefixo
    const matchedImage = images.find(img => 
      img.Id === imageId || img.Id.endsWith(imageId.replace("sha256:", ""))
    );

    if (matchedImage?.RepoTags?.[0]) {
      const [repository, tag] = matchedImage.RepoTags[0].split(":");
      return {
        image: repository + ":" + tag,
        tag: tag || "latest"
      };
    }
  } catch (error) {
    console.error("Erro ao listar imagens Docker:", error);
  }

  // Fallback: tenta extrair do Config.Image
  const fullImage = info.Config?.Image || "";
  const [repository, tag] = fullImage.split(":");

  return {
    image: repository,
    tag: tag || "latest"
  };
}
