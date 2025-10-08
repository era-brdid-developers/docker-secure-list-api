#!/bin/bash
set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Funções auxiliares
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[AVISO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERRO]${NC} $1"
}

# Banner
echo -e "${BLUE}"
cat << "EOF"
╔════════════════════════════════════════════════╗
║   Docker Secure List API - Instalador v1.0    ║
╚════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# Verificar dependências
log_info "Verificando dependências do sistema..."

# 1. Verificar Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js não está instalado!"
    log_info "Por favor, instale Node.js 18 ou superior"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    log_error "Node.js versão $NODE_VERSION detectada"
    log_info "É necessário Node.js versão 18 ou superior"
    exit 1
fi
log_success "Node.js v$(node -v) detectado ✓"

# 2. Verificar npm
if ! command -v npm &> /dev/null; then
    log_error "npm não está instalado!"
    exit 1
fi
log_success "npm v$(npm -v) detectado ✓"

# 3. Verificar Docker
if ! command -v docker &> /dev/null; then
    log_error "Docker não está instalado!"
    log_info "Por favor, instale o Docker primeiro"
    exit 1
fi
log_success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') detectado ✓"

# 4. Verificar openssl
if ! command -v openssl &> /dev/null; then
    log_error "OpenSSL não está instalado!"
    exit 1
fi
log_success "OpenSSL detectado ✓"

# Definir diretório de instalação
INSTALL_DIR="/opt/docker-secure-list-api"
log_info "Diretório de instalação: $INSTALL_DIR"

# Criar diretório de instalação
log_info "Criando estrutura de diretórios..."
sudo mkdir -p "$INSTALL_DIR"
sudo chown -R "$USER:$USER" "$INSTALL_DIR"
log_success "Diretório criado e permissões ajustadas"

# Navegar para o diretório
cd "$INSTALL_DIR"

# Criar estrutura de diretórios
mkdir -p src

# Criar package.json
log_info "Criando package.json..."
cat > package.json << 'EOF'
{
  "name": "docker-secure-list-api",
  "version": "1.0.0",
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js"
  },
  "dependencies": {
    "ajv": "^8.17.1",
    "cors": "^2.8.5",
    "dockerode": "^4.0.2",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "helmet": "^7.1.0",
    "hpp": "^0.2.3",
    "jsonwebtoken": "^9.0.2",
    "morgan": "^1.10.0"
  }
}
EOF
log_success "package.json criado"

# Criar src/server.js
log_info "Criando src/server.js..."
cat > src/server.js << 'EOF'
import "dotenv/config";
import express from "express";
import morgan from "morgan";
import { makeSecurity } from "./security.js";
import { makeAuthMiddleware } from "./auth.js";
import { makeDocker, listContainers } from "./docker.js";

const app = express();
makeSecurity(app, { corsOrigins: process.env.CORS_ORIGINS });
app.use(morgan("combined"));

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

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API segura ouvindo em :${port}`));
EOF
log_success "src/server.js criado"

# Criar src/security.js
log_info "Criando src/security.js..."
cat > src/security.js << 'EOF'
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import hpp from "hpp";

export function makeSecurity(app, { corsOrigins }) {
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));

  const origins = (corsOrigins || "").split(",").map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin: origins.length ? origins : false,
    methods: ["GET"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600
  }));

  app.use(hpp());
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false
  }));
}
EOF
log_success "src/security.js criado"

# Criar src/auth.js
log_info "Criando src/auth.js..."
cat > src/auth.js << 'EOF'
import jwt from "jsonwebtoken";

export function makeAuthMiddleware(env) {
  const alg = env.JWT_ALG || "RS256";
  const verifyOpts = { algorithms: [alg] };
  let key;

  if (alg === "RS256") {
    const pubB64 = env.JWT_PUBLIC_KEY_BASE64;
    if (!pubB64) throw new Error("JWT_PUBLIC_KEY_BASE64 ausente");
    key = Buffer.from(pubB64, "base64").toString("utf8");
  } else if (alg === "HS256") {
    key = env.JWT_SECRET;
    if (!key) throw new Error("JWT_SECRET ausente");
  } else {
    throw new Error("Algoritmo JWT não suportado");
  }

  return function auth(req, res, next) {
    try {
      const raw = req.headers.authorization || "";
      const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
      if (!token) return res.status(401).json({ error: "missing_token" });

      const payload = jwt.verify(token, key, verifyOpts);
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
      
      if (!scopes.includes("docker:list")) {
        return res.status(403).json({ error: "forbidden" });
      }

      req.user = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: "invalid_token" });
    }
  };
}
EOF
log_success "src/auth.js criado"

# Criar src/docker.js
log_info "Criando src/docker.js..."
cat > src/docker.js << 'EOF'
import Docker from "dockerode";

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
EOF
log_success "src/docker.js criado"

# Criar openapi.yaml
log_info "Criando openapi.yaml..."
cat > openapi.yaml << 'EOF'
openapi: 3.0.3
info:
  title: ERA Docker Secure List API
  version: 1.0.0
servers:
  - url: https://api.exemplo.com
paths:
  /v1/containers:
    get:
      summary: Lista containers Docker (id e nome)
      security: [{ bearerAuth: [] }]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
                    items:
                      type: object
                      properties:
                        id: { type: string }
                        name: { type: string }
        '401': { description: Unauthorized }
        '403': { description: Forbidden }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
EOF
log_success "openapi.yaml criado"

# Criar README.md
log_info "Criando README.md..."
cat > README.md << 'EOF'
# API segura para listar containers Docker (execução direta no host)

## Por que é segura?
- **Sem shell**: usa Docker SDK (dockerode) via **socket local**.
- **Somente leitura**: apenas lista containers (id + nome).
- **JWT + RBAC**: exige escopo `docker:list`.
- **Hardening**: Helmet, CORS estrito, rate limit, usuário sem privilégios.

## Uso
1. Configure o arquivo .env com suas credenciais
2. Execute: `npm start`
3. Gere um JWT com escopo `docker:list`
4. Teste: `curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/containers`

## Observações
- **Sem containers**: execução direta no host, usando o socket local `/var/run/docker.sock`.
- **Segurança**: mantenha atrás de reverse proxy (mTLS opcional), use JWT RS256 e restrinja CORS.
- **Least privilege**: execute com usuário sem privilégios, apenas no grupo `docker`.
EOF
log_success "README.md criado"

# Criar chave pública JWT
log_info "Criando chave pública JWT..."
cat > jwt_public.pem << 'EOFKEY'
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAh4ppLY+McE7Rpeu+noZM
SvRQ6Qud/hJaIENi1Hu9Ql6ADLHFTNZrHPcTd0jwtvKU+MFuKNbsWYPxvRHtuJZA
7HJ7qdusqJKIHMmhzkCLuj/I2O4YGWMPSRqqOFMKJYQruYT1u6gahbLdgjkhX0l7
jiheHHGJ/d5Jj7rB7OEWuwIO82EPI6Bm5qalKHIv9xg+DUtN+zzE5sYEaizN2q/9
c15Oa42tg5bdWkW6VTEexZWPiLYylrgg94SY7Av0amU535/661VCINtnGdy0g4kY
edSP/XbSkkRir46EA4T872Np7hve/4RqQFaFa1js68IkkNSPGaUQhTj19cuj6WpI
QQIDAQAB
-----END PUBLIC KEY-----
EOFKEY

JWT_PUBLIC_KEY_BASE64=$(base64 -w0 jwt_public.pem)
log_success "Chave pública JWT configurada"

# Criar arquivo .env
log_info "Criando arquivo .env..."
cat > .env << EOF
# Porta da API
PORT=4000

# Origem permitida no CORS (separar por vírgula para múltiplas)
CORS_ORIGINS=https://minhaapp.com

# Cabeçalhos aceitos pelo CORS (opcional)
CORS_HEADERS=Authorization,Content-Type

# JWT – verificação RS256 (chave pública)
JWT_ALG=RS256
JWT_PUBLIC_KEY_BASE64=${JWT_PUBLIC_KEY_BASE64}

# Alternativamente (não recomendado em prod): HS256 com segredo compartilhado
# JWT_ALG=HS256
# JWT_SECRET=

# Conexão com Docker – via socket local (host)
DOCKER_SOCKET=/var/run/docker.sock
EOF
log_success "Arquivo .env criado"

# Configurar permissões Docker
log_info "Configurando acesso ao Docker sem root..."

# Verificar se o grupo docker existe
if ! getent group docker > /dev/null 2>&1; then
    log_warning "Grupo 'docker' não existe. Criando..."
    sudo groupadd docker
fi

# Adicionar usuário ao grupo docker
if id -nG "$USER" | grep -qw docker; then
    log_success "Usuário já está no grupo docker"
else
    log_info "Adicionando usuário '$USER' ao grupo docker..."
    sudo usermod -aG docker "$USER"
    log_warning "IMPORTANTE: Você precisa fazer logout e login novamente para aplicar as mudanças"
    log_warning "Ou execute: newgrp docker"
fi

# Testar acesso ao Docker
log_info "Testando acesso ao Docker..."
if docker ps >/dev/null 2>&1; then
    log_success "Acesso ao Docker funcionando ✓"
else
    log_warning "Não foi possível acessar o Docker sem sudo"
    log_info "Execute 'newgrp docker' ou faça logout/login"
fi

# Instalar dependências npm
log_info "Instalando dependências npm (somente produção)..."
export=NODE_OPTIONS=--dns-result-order=ipv4first
npm install --omit=dev --silent 2>/dev/null || npm install --omit=dev
log_success "Dependências instaladas"

# Criar script de inicialização
log_info "Criando script de inicialização..."
cat > start.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
npm start
EOF
chmod +x start.sh
log_success "Script start.sh criado"

# Ajustar permissões finais
chmod 644 jwt_public.pem
chmod 600 .env

# Resumo final
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Instalação Concluída com Sucesso!     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
log_info "Localização: $INSTALL_DIR"
log_info "Chave pública JWT configurada em: jwt_public.pem"
echo ""
log_warning "PRÓXIMOS PASSOS:"
echo "  1. Edite o arquivo .env e configure CORS_ORIGINS"
echo "  2. Se necessário, execute: newgrp docker"
echo "  3. Inicie a API: cd $INSTALL_DIR && npm start"
echo "  4. Ou use: $INSTALL_DIR/start.sh"
echo ""
log_info "Para testar o healthcheck:"
echo "  curl http://localhost:4000/healthz"
echo ""
log_info "Documentação completa em: $INSTALL_DIR/README.md"
echo ""#!/bin/bash
set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Funções auxiliares
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[AVISO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERRO]${NC} $1"
}

# Banner
echo -e "${BLUE}"
cat << "EOF"
╔════════════════════════════════════════════════╗
║   Docker Secure List API - Instalador v1.0    ║
╚════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# Verificar dependências
log_info "Verificando dependências do sistema..."

# 1. Verificar Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js não está instalado!"
    log_info "Por favor, instale Node.js 18 ou superior"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    log_error "Node.js versão $NODE_VERSION detectada"
    log_info "É necessário Node.js versão 18 ou superior"
    exit 1
fi
log_success "Node.js v$(node -v) detectado ✓"

# 2. Verificar npm
if ! command -v npm &> /dev/null; then
    log_error "npm não está instalado!"
    exit 1
fi
log_success "npm v$(npm -v) detectado ✓"

# 3. Verificar Docker
if ! command -v docker &> /dev/null; then
    log_error "Docker não está instalado!"
    log_info "Por favor, instale o Docker primeiro"
    exit 1
fi
log_success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') detectado ✓"

# 4. Verificar openssl
if ! command -v openssl &> /dev/null; then
    log_error "OpenSSL não está instalado!"
    exit 1
fi
log_success "OpenSSL detectado ✓"

# Definir diretório de instalação
INSTALL_DIR="/opt/docker-secure-list-api"
log_info "Diretório de instalação: $INSTALL_DIR"

# Criar diretório de instalação
log_info "Criando estrutura de diretórios..."
sudo mkdir -p "$INSTALL_DIR"
sudo chown -R "$USER:$USER" "$INSTALL_DIR"
log_success "Diretório criado e permissões ajustadas"

# Navegar para o diretório
cd "$INSTALL_DIR"

# Criar estrutura de diretórios
mkdir -p src

# Criar package.json
log_info "Criando package.json..."
cat > package.json << 'EOF'
{
  "name": "docker-secure-list-api",
  "version": "1.0.0",
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js"
  },
  "dependencies": {
    "ajv": "^8.17.1",
    "cors": "^2.8.5",
    "dockerode": "^4.0.2",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "helmet": "^7.1.0",
    "hpp": "^0.2.3",
    "jsonwebtoken": "^9.0.2",
    "morgan": "^1.10.0"
  }
}
EOF
log_success "package.json criado"

# Criar src/server.js
log_info "Criando src/server.js..."
cat > src/server.js << 'EOF'
import "dotenv/config";
import express from "express";
import morgan from "morgan";
import { makeSecurity } from "./security.js";
import { makeAuthMiddleware } from "./auth.js";
import { makeDocker, listContainers } from "./docker.js";

const app = express();
makeSecurity(app, { corsOrigins: process.env.CORS_ORIGINS });
app.use(morgan("combined"));

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

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API segura ouvindo em :${port}`));
EOF
log_success "src/server.js criado"

# Criar src/security.js
log_info "Criando src/security.js..."
cat > src/security.js << 'EOF'
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import hpp from "hpp";

export function makeSecurity(app, { corsOrigins }) {
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));

  const origins = (corsOrigins || "").split(",").map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin: origins.length ? origins : false,
    methods: ["GET"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600
  }));

  app.use(hpp());
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false
  }));
}
EOF
log_success "src/security.js criado"

# Criar src/auth.js
log_info "Criando src/auth.js..."
cat > src/auth.js << 'EOF'
import jwt from "jsonwebtoken";

export function makeAuthMiddleware(env) {
  const alg = env.JWT_ALG || "RS256";
  const verifyOpts = { algorithms: [alg] };
  let key;

  if (alg === "RS256") {
    const pubB64 = env.JWT_PUBLIC_KEY_BASE64;
    if (!pubB64) throw new Error("JWT_PUBLIC_KEY_BASE64 ausente");
    key = Buffer.from(pubB64, "base64").toString("utf8");
  } else if (alg === "HS256") {
    key = env.JWT_SECRET;
    if (!key) throw new Error("JWT_SECRET ausente");
  } else {
    throw new Error("Algoritmo JWT não suportado");
  }

  return function auth(req, res, next) {
    try {
      const raw = req.headers.authorization || "";
      const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
      if (!token) return res.status(401).json({ error: "missing_token" });

      const payload = jwt.verify(token, key, verifyOpts);
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
      
      if (!scopes.includes("docker:list")) {
        return res.status(403).json({ error: "forbidden" });
      }

      req.user = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: "invalid_token" });
    }
  };
}
EOF
log_success "src/auth.js criado"

# Criar src/docker.js
log_info "Criando src/docker.js..."
cat > src/docker.js << 'EOF'
import Docker from "dockerode";

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
EOF
log_success "src/docker.js criado"

# Criar openapi.yaml
log_info "Criando openapi.yaml..."
cat > openapi.yaml << 'EOF'
openapi: 3.0.3
info:
  title: ERA Docker Secure List API
  version: 1.0.0
servers:
  - url: https://api.exemplo.com
paths:
  /v1/containers:
    get:
      summary: Lista containers Docker (id e nome)
      security: [{ bearerAuth: [] }]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
                    items:
                      type: object
                      properties:
                        id: { type: string }
                        name: { type: string }
        '401': { description: Unauthorized }
        '403': { description: Forbidden }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
EOF
log_success "openapi.yaml criado"

# Criar README.md
log_info "Criando README.md..."
cat > README.md << 'EOF'
# API segura para listar containers Docker (execução direta no host)

## Por que é segura?
- **Sem shell**: usa Docker SDK (dockerode) via **socket local**.
- **Somente leitura**: apenas lista containers (id + nome).
- **JWT + RBAC**: exige escopo `docker:list`.
- **Hardening**: Helmet, CORS estrito, rate limit, usuário sem privilégios.

## Uso
1. Configure o arquivo .env com suas credenciais
2. Execute: `npm start`
3. Gere um JWT com escopo `docker:list`
4. Teste: `curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/containers`

## Observações
- **Sem containers**: execução direta no host, usando o socket local `/var/run/docker.sock`.
- **Segurança**: mantenha atrás de reverse proxy (mTLS opcional), use JWT RS256 e restrinja CORS.
- **Least privilege**: execute com usuário sem privilégios, apenas no grupo `docker`.
EOF
log_success "README.md criado"

# Criar chave pública JWT
log_info "Criando chave pública JWT..."
cat > jwt_public.pem << 'EOFKEY'
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAh4ppLY+McE7Rpeu+noZM
SvRQ6Qud/hJaIENi1Hu9Ql6ADLHFTNZrHPcTd0jwtvKU+MFuKNbsWYPxvRHtuJZA
7HJ7qdusqJKIHMmhzkCLuj/I2O4YGWMPSRqqOFMKJYQruYT1u6gahbLdgjkhX0l7
jiheHHGJ/d5Jj7rB7OEWuwIO82EPI6Bm5qalKHIv9xg+DUtN+zzE5sYEaizN2q/9
c15Oa42tg5bdWkW6VTEexZWPiLYylrgg94SY7Av0amU535/661VCINtnGdy0g4kY
edSP/XbSkkRir46EA4T872Np7hve/4RqQFaFa1js68IkkNSPGaUQhTj19cuj6WpI
QQIDAQAB
-----END PUBLIC KEY-----
EOFKEY

JWT_PUBLIC_KEY_BASE64=$(base64 -w0 jwt_public.pem)
log_success "Chave pública JWT configurada"

# Criar arquivo .env
log_info "Criando arquivo .env..."
cat > .env << EOF
# Porta da API
PORT=4000

# Origem permitida no CORS (separar por vírgula para múltiplas)
CORS_ORIGINS=https://minhaapp.com

# Cabeçalhos aceitos pelo CORS (opcional)
CORS_HEADERS=Authorization,Content-Type

# JWT – verificação RS256 (chave pública)
JWT_ALG=RS256
JWT_PUBLIC_KEY_BASE64=${JWT_PUBLIC_KEY_BASE64}

# Alternativamente (não recomendado em prod): HS256 com segredo compartilhado
# JWT_ALG=HS256
# JWT_SECRET=

# Conexão com Docker – via socket local (host)
DOCKER_SOCKET=/var/run/docker.sock
EOF
log_success "Arquivo .env criado"

# Configurar permissões Docker
log_info "Configurando acesso ao Docker sem root..."

# Verificar se o grupo docker existe
if ! getent group docker > /dev/null 2>&1; then
    log_warning "Grupo 'docker' não existe. Criando..."
    sudo groupadd docker
fi

# Adicionar usuário ao grupo docker
if id -nG "$USER" | grep -qw docker; then
    log_success "Usuário já está no grupo docker"
else
    log_info "Adicionando usuário '$USER' ao grupo docker..."
    sudo usermod -aG docker "$USER"
    log_warning "IMPORTANTE: Você precisa fazer logout e login novamente para aplicar as mudanças"
    log_warning "Ou execute: newgrp docker"
fi

# Testar acesso ao Docker
log_info "Testando acesso ao Docker..."
if docker ps >/dev/null 2>&1; then
    log_success "Acesso ao Docker funcionando ✓"
else
    log_warning "Não foi possível acessar o Docker sem sudo"
    log_info "Execute 'newgrp docker' ou faça logout/login"
fi

# Instalar dependências npm
log_info "Instalando dependências npm (somente produção)..."
npm install --omit=dev --silent 2>/dev/null || npm install --omit=dev
log_success "Dependências instaladas"

# Criar script de inicialização
log_info "Criando script de inicialização..."
cat > start.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
npm start
EOF
chmod +x start.sh
log_success "Script start.sh criado"

# Ajustar permissões finais
chmod 644 jwt_public.pem
chmod 600 .env

# Resumo final
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Instalação Concluída com Sucesso!     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
log_info "Localização: $INSTALL_DIR"
log_info "Chave pública JWT configurada em: jwt_public.pem"
echo ""
log_warning "PRÓXIMOS PASSOS:"
echo "  1. Edite o arquivo .env e configure CORS_ORIGINS"
echo "  2. Se necessário, execute: newgrp docker"
echo "  3. Inicie a API: cd $INSTALL_DIR && npm start"
echo "  4. Ou use: $INSTALL_DIR/start.sh"
echo ""
log_info "Para testar o healthcheck:"
echo "  curl http://localhost:4000/healthz"
echo ""
log_info "Documentação completa em: $INSTALL_DIR/README.md"
echo ""
