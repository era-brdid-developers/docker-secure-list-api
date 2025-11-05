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


export async function updateDockerInstance(domain) {
  return new Promise((resolve, reject) => {
    if (!domain) return reject("Domínio não informado.");

    const instancePath = `/instances/${domain}`;
    
    // Buscar credenciais do .env
    const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const awsRegion = process.env.AWS_REGION || "us-west-2";
    const ecrRegistry = process.env.ECR_REGISTRY;

    if (!awsAccessKeyId || !awsSecretAccessKey || !ecrRegistry) {
      return reject("Credenciais AWS não configuradas no .env");
    }

    // Escapa caracteres especiais para bash usando aspas simples
    const escapedSecret = awsSecretAccessKey.replace(/'/g, "'\\''");
    const escapedKey = awsAccessKeyId.replace(/'/g, "'\\''");

    const awsAndDockerCmd = `
      aws configure set aws_access_key_id '${escapedKey}' &&
      aws configure set aws_secret_access_key '${escapedSecret}' &&
      aws configure set region '${awsRegion}' &&
      aws ecr get-login-password --region ${awsRegion} | docker login --username AWS --password-stdin ${ecrRegistry} &&
      cd ${instancePath} &&
      docker-compose pull &&
      docker-compose down &&
      docker-compose up -d
    `;

    exec(awsAndDockerCmd, { shell: "/bin/bash" }, (error, stdout, stderr) => {
      if (error) {
        reject(stderr || error.message);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Lê conteúdo de um arquivo dentro do container.
 * @param {Docker} docker - Cliente Docker
 * @param {string} containerId - ID do container
 * @param {string} filePath - Caminho completo do arquivo dentro do container
 * @returns {Promise<string>} Conteúdo do arquivo
 */
export async function readFileFromContainer(docker, containerId, filePath) {
  const output = await execInContainer(docker, containerId, ["cat", filePath]);
  // Remove todos os caracteres inválidos até encontrar { ou [
  const cleanOutput = output.replace(/^[\s\S]*?([{\[])/i, "$1");
  return cleanOutput;
}

/**
 * Lê os arquivos versao.json e versao_log.json do container.
 * @param {Docker} docker - Cliente Docker
 * @param {string} containerId - ID do container
 * @returns {Promise<{versao: object, versaoLog: object}>}
 */
export async function getVersionFiles(docker, containerId) {
  const basePath = "/app/app.chat";
  
  const versaoPath = `${basePath}/versao.json`;
  const versaoLogPath = `${basePath}/versao_log.json`;

  try {
    const versaoContent = await readFileFromContainer(docker, containerId, versaoPath);
    const versaoLogContent = await readFileFromContainer(docker, containerId, versaoLogPath);

    return {
      versao: JSON.parse(versaoContent),
      versaoLog: JSON.parse(versaoLogContent)
    };
  } catch (error) {
    throw new Error(`Failed to read version files: ${error.message}`);
  }
}


/**
 * Lê os arquivos versao.json e versao_log.json do host.
 * @returns {Promise<{versao: object, versaoLog: object}>}
 */
export async function getVersionFilesHost() {
  const basePath = "/home/omni_last_version/git/app.chat";
  
  const versaoPath = `${basePath}/versao.json`;
  const versaoLogPath = `${basePath}/versao_log.json`;

  try {
    const versaoContent = await fs.readFile(versaoPath, "utf-8");
    const versaoLogContent = await fs.readFile(versaoLogPath, "utf-8");

    // Remove caracteres inválidos
    const cleanVersao = versaoContent.replace(/^[\s\S]*?([{\[])/i, "$1");
    const cleanVersaoLog = versaoLogContent.replace(/^[\s\S]*?([{\[])/i, "$1");

    return {
      versao: JSON.parse(cleanVersao),
      versaoLog: JSON.parse(cleanVersaoLog)
    };
  } catch (error) {
    throw new Error(`Failed to read version files from host: ${error.message}`);
  }
}







/**
 * Encontra um container pelo domain (procura por docker_domain_chat)
 * @param {Docker} docker - Cliente Docker
 * @param {string} domain - Domain/nome da instância
 * @returns {Promise<string>} ID do container (primeiros 12 chars)
 */
async function findContainerByDomain(docker, domain) {
  const containers = await docker.listContainers({ all: true });
  const containerPattern = `docker_${domain}_chat`;
  const found = containers.find(c => 
    c.Names?.some(n => n.replace(/^\//, "") === containerPattern)
  );
  if (!found) throw new Error(`Container "${containerPattern}" não encontrado`);
  return found.Id.slice(0, 12);
}

/**
 * Faz update completo com backup e restore de arquivos críticos
 * @param {Docker} docker - Cliente Docker
 * @param {string} domain - Domain/nome da instância (ex: chat-testethales.uc2bbh.com.br)
 * @returns {Promise<{status: string, backupDir: string, log: string}>}
 */
export async function updateDockerInstanceWithBackup(docker, domain) {
  const backupDir = `/tmp/${domain}`;
  let oldContainerId;

  try {
    // 1) Encontra o container pelo domain
    oldContainerId = await findContainerByDomain(docker, domain);
    console.log(`Container encontrado: ${oldContainerId}`);

    // 2) Cria diretório de backup
    await exec(`mkdir -p ${backupDir}`);
    console.log(`Diretório de backup criado: ${backupDir}`);

    // 3) Backup dos 3 arquivos
    console.log("Iniciando backup dos arquivos...");
    
    await exec(`docker cp ${oldContainerId}:/etc/nginx/myuc2b.com.crt ${backupDir}/`);
    console.log("✓ Certificado (.crt) copiado");
    
    await exec(`docker cp ${oldContainerId}:/etc/nginx/myuc2b.com.key ${backupDir}/`);
    console.log("✓ Chave (.key) copiada");
    
    await exec(`docker cp ${oldContainerId}:/app/app.hubot/node_modules/@rocket.chat/sdk/dist/lib/settings.js ${backupDir}/`);
    console.log("✓ Settings.js copiado");

    // 4) Faz o update
    console.log("Iniciando atualização do Docker...");
    const updateLog = await updateDockerInstance(domain);
    console.log("✓ Update concluído");

    // 5) Encontra o novo container (pode ter mudado de ID)
    let newContainerId;
    let retries = 0;
    while (retries < 10) {
      try {
        newContainerId = await findContainerByDomain(docker, domain);
        break;
      } catch (e) {
        retries++;
        if (retries === 10) throw new Error("Timeout esperando novo container aparecer");
        await new Promise(r => setTimeout(r, 1000)); // Espera 1s
      }
    }
    console.log(`Novo container encontrado: ${newContainerId}`);

    // 6) Restaura os 3 arquivos
    console.log("Restaurando arquivos...");
    
    await exec(`docker cp ${backupDir}/myuc2b.com.crt ${newContainerId}:/etc/nginx/`);
    console.log("✓ Certificado restaurado");
    
    await exec(`docker cp ${backupDir}/myuc2b.com.key ${newContainerId}:/etc/nginx/`);
    console.log("✓ Chave restaurada");
    
    await exec(`docker cp ${backupDir}/settings.js ${newContainerId}:/app/app.hubot/node_modules/@rocket.chat/sdk/dist/lib/`);
    console.log("✓ Settings.js restaurado");

    // 7) Reinicia todos os apps
    console.log("Reiniciando aplicativos...");
    const restartOutput = await execInContainer(docker, newContainerId, [
      "pm2",
      "restart",
      "all",
      "--no-color"
    ]);
    console.log("✓ PM2 restart executado");

    // 8) Limpeza (opcional - manter backup por segurança)
    // await exec(`rm -rf ${backupDir}`);

    return {
      status: "success",
      oldContainerId,
      newContainerId,
      backupDir,
      domain,
      message: "Update completo com sucesso",
      updateLog,
      restartOutput
    };

  } catch (error) {
    console.error("Erro no update:", error.message);
    throw new Error(`Falha no update: ${error.message}`);
  }
}



// import { promises as dns } from "dns";

// /**
//  * Consulta apps configurados no MongoDB dentro do container
//  * @param {Docker} docker - Cliente Docker
//  * @param {string} containerId - ID do container
//  * @returns {Promise<Array>} Array de apps com DNS resolvido
//  */
// export async function getContainerAppsConfig(docker, containerId) {
//   // 1) Executa a query no MongoDB
//   const mongoQuery = `
//     use mytuite;
//     db.mytuite_apps.find(
//       {},
//       {
//         "configs.Chat_Domain_Uuid": 1,
//         "configs.Chat_Domain_Name": 1,
//         _id: 0
//       }
//     )
//   `;

//   const output = await execInContainer(docker, containerId, [
//     "mongo",
//     "--eval",
//     mongoQuery
//   ]);

//   // 2) Parseia a resposta e filtra apps com configs válidas
//   const lines = output.split("\n").filter(line => line.trim().startsWith("{"));
  
//   const apps = [];
//   for (const line of lines) {
//     try {
//       const doc = JSON.parse(line);
      
//       // Verifica se tem Chat_Domain_Name (configs não vazias)
//       if (doc.configs?.Chat_Domain_Name) {
//         const domainName = doc.configs.Chat_Domain_Name;
        
//         // 3) Resolve o DNS
//         let ipAddress = null;
//         try {
//           const addresses = await dns.resolve4(domainName);
//           ipAddress = addresses[0]; // Pega o primeiro IP
//         } catch (dnsError) {
//           console.warn(`Erro ao resolver DNS para ${domainName}:`, dnsError.message);
//           ipAddress = null;
//         }

//         apps.push({
//           configs: {
//             Chat_Domain_Uuid: doc.configs.Chat_Domain_Uuid,
//             Chat_Domain_Name: domainName,
//             Resolved_IP: ipAddress
//           }
//         });
//       }
//     } catch (parseError) {
//       // Ignora linhas que não são JSON válido
//       continue;
//     }
//   }

//   return apps;
// }



import { promises as dns } from "dns";

/**
 * Consulta apps configurados no MongoDB dentro do container
 * @param {Docker} docker - Cliente Docker
 * @param {string} containerId - ID do container
 * @returns {Promise<Array>} Array de apps com DNS resolvido
 */
export async function getContainerAppsConfig(docker, containerId) {
  // 1) Executa a query no MongoDB usando sintaxe JavaScript para --eval
  const mongoQuery = `
    db.getMongo().getDB("mytuite").mytuite_apps.find(
      {},
      {
        "configs.Chat_Domain_Uuid": 1,
        "configs.Chat_Domain_Name": 1,
        _id: 0
      }
    ).forEach(function(doc) {
      print(JSON.stringify(doc));
    });
  `;

  console.log("🔍 Executando query no MongoDB...");
  const output = await execInContainer(docker, containerId, [
    "mongo",
    "--eval",
    mongoQuery
  ]);

  console.log("📦 Output bruto do MongoDB:");
  console.log(output);
  console.log("---");

  // 2) Parseia a resposta e filtra apps com configs válidas
  const lines = output.split("\n");
  console.log(`📊 Total de linhas recebidas: ${lines.length}`);
  
  const apps = [];
  let validLines = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    
    // Remove caracteres inválidos (BOM e outros) até encontrar {
    line = line.replace(/^[\s\S]*?([{\[])/i, "$1");
    
    console.log(`Linha ${i}: "${line.substring(0, 80)}${line.length > 80 ? "..." : ""}"`);

    if (!line.startsWith("{")) {
      console.log(`  ❌ Não começa com {, pulando`);
      continue;
    }

    try {
      const doc = JSON.parse(line);
      validLines++;
      console.log(`  ✓ JSON parseado:`, JSON.stringify(doc).substring(0, 100));
      
      // Verifica se tem Chat_Domain_Name (configs não vazias)
      if (doc.configs?.Chat_Domain_Name) {
        const domainName = doc.configs.Chat_Domain_Name;
        console.log(`  ✓ Encontrado domínio: ${domainName}`);
        
        // 3) Resolve o DNS
        let ipAddress = null;
        try {
          const addresses = await dns.resolve4(domainName);
          ipAddress = addresses[0]; // Pega o primeiro IP
          console.log(`  ✓ DNS resolvido: ${domainName} -> ${ipAddress}`);
        } catch (dnsError) {
          console.warn(`  ⚠️ Erro ao resolver DNS para ${domainName}:`, dnsError.message);
          ipAddress = null;
        }

        apps.push({
          configs: {
            Chat_Domain_Uuid: doc.configs.Chat_Domain_Uuid,
            Chat_Domain_Name: domainName,
            Resolved_IP: ipAddress
          }
        });
      } else {
        console.log(`  ⚠️ Configs vazias ou sem Chat_Domain_Name`);
      }
    } catch (parseError) {
      console.log(`  ❌ Erro ao parsear JSON:`, parseError.message);
      continue;
    }
  }

  console.log(`\n📈 Resumo: ${validLines} linhas parseadas, ${apps.length} apps com domínio encontrados`);

  return apps;
}