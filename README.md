# 🐳 Docker Secure List API

API RESTful segura para listar containers Docker com autenticação JWT e controle de acesso baseado em escopos.

## 🔒 Por que é segura?

- **Sem execução de shell** - usa Docker SDK (dockerode) via socket local
- **Somente leitura** - retorna apenas ID e nome dos containers
- **Autenticação JWT** - suporta RS256 (recomendado) e HS256
- **RBAC** - requer escopo `docker:list` no token
- **Hardening completo**:
  - Helmet (proteção de headers)
  - CORS estrito e configurável
  - Rate limiting (60 req/min por IP)
  - HPP (proteção contra poluição de parâmetros)
  - Logs estruturados (Morgan)

## 📋 Requisitos

- Node.js 18+
- npm 9+
- Docker
- Acesso ao socket Docker (`/var/run/docker.sock`)

## 🚀 Instalação

### 1. Clone o repositório

```bash
git clone https://github.com/seu-usuario/docker-secure-list-api.git
cd docker-secure-list-api
```

### 2. Execute o instalador

```bash
chmod +x install.sh
./install.sh
```

O instalador irá:
- ✅ Verificar dependências (Node.js, Docker, npm)
- ✅ Instalar pacotes npm
- ✅ Configurar permissões Docker (adicionar usuário ao grupo `docker`)
- ✅ Criar arquivo `.env` com configurações padrão
- ✅ Criar script de inicialização `start.sh`

### 3. Configure as variáveis de ambiente

Edite o arquivo `.env`:

```bash
nano .env
```

**Configurações importantes:**
- `CORS_ORIGINS`: domínios permitidos (ex: `https://app.exemplo.com`)
- `JWT_PUBLIC_KEY_BASE64`: chave pública RSA em Base64 (para RS256)
- `JWT_SECRET`: segredo compartilhado (se usar HS256)

### 4. Inicie a API

```bash
npm start
# ou
./start.sh
```

## 🔑 Autenticação JWT

### Gerando um token de teste (RS256)

```bash
# Gerar par de chaves (se não tiver)
openssl genrsa -out jwt_private.pem 2048
openssl rsa -in jwt_private.pem -pubout -out jwt_public.pem

# Gerar token com escopo docker:list (válido por 1 hora)
node -e "
const jwt = require('jsonwebtoken');
const fs = require('fs');
const privateKey = fs.readFileSync('jwt_private.pem');
const token = jwt.sign(
  { sub: 'user123', scopes: ['docker:list'] },
  privateKey,
  { algorithm: 'RS256', expiresIn: '1h' }
);
console.log(token);
"
```

### Estrutura do token JWT

```json
{
  "sub": "user123",
  "scopes": ["docker:list"],
  "iat": 1234567890,
  "exp": 1234571490
}
```

## 📡 Endpoints

### `GET /healthz`
Verifica se a API está online (não requer autenticação).

```bash
curl http://localhost:4000/healthz
```

**Resposta:**
```json
{
  "ok": true
}
```

### `GET /v1/containers`
Lista containers Docker (requer autenticação + escopo `docker:list`).

```bash
curl -H "Authorization: Bearer SEU_TOKEN_JWT" \
     http://localhost:4000/v1/containers
```

**Resposta:**
```json
{
  "items": [
    {
      "id": "a1b2c3d4e5f6",
      "name": "nginx-proxy"
    },
    {
      "id": "f6e5d4c3b2a1",
      "name": "redis-cache"
    }
  ]
}
```

**Possíveis erros:**
- `401 Unauthorized` - Token ausente ou inválido
- `403 Forbidden` - Token válido mas sem escopo `docker:list`
- `500 Internal Server Error` - Erro ao comunicar com Docker

## 🛠️ Desenvolvimento

```bash
# Modo watch (reinicia automaticamente)
npm run dev

# Produção
npm start
```

## 📦 Estrutura do projeto

```
.
├── src/
│   ├── auth.js         # Middleware de autenticação JWT
│   ├── docker.js       # Cliente Docker (dockerode)
│   ├── security.js     # Hardening (Helmet, CORS, rate limit)
│   └── server.js       # Servidor Express principal
├── .env                # Variáveis de ambiente (não versionado)
├── .env.example        # Template de configuração
├── .gitignore          # Arquivos ignorados pelo Git
├── install.sh          # Script de instalação
├── jwt_public.pem      # Chave pública RSA (para RS256)
├── openapi.yaml        # Especificação OpenAPI 3.0
├── package.json        # Dependências e scripts
├── README.md           # Este arquivo
└── start.sh            # Script de inicialização
```

## 🔐 Segurança

### Recomendações para produção

1. **Use RS256** em vez de HS256
2. **Reverse proxy** com HTTPS (Nginx/Traefik)
3. **mTLS** para autenticação cliente-servidor (opcional)
4. **Firewall** - restrinja acesso à porta da API
5. **Least privilege** - execute com usuário sem privilégios (apenas no grupo `docker`)
6. **Monitore** - configure logs e alertas
7. **Rate limiting** - ajuste conforme necessidade

### Permissões mínimas necessárias

```bash
# Usuário precisa estar no grupo docker (somente leitura)
sudo usermod -aG docker $USER

# Socket Docker precisa ser acessível
ls -la /var/run/docker.sock
# srw-rw---- 1 root docker 0 ... /var/run/docker.sock
```

## 🐛 Troubleshooting

### "Permission denied" ao acessar Docker

```bash
# Opção 1: Aplicar grupo docker (recomendado)
newgrp docker

# Opção 2: Logout/login para aplicar mudanças de grupo
```

### "Cannot find module 'dockerode'"

```bash
# Reinstalar dependências
rm -rf node_modules package-lock.json
npm install
```

### CORS bloqueando requisições

Verifique `CORS_ORIGINS` no `.env`:
```bash
CORS_ORIGINS=https://app.exemplo.com,https://outro.exemplo.com
```

## 📄 Licença

MIT

## 🤝 Contribuindo

Pull requests são bem-vindos! Para mudanças importantes, abra uma issue primeiro.

---

**Nota**: Esta API **não executa comandos** no Docker, apenas lista containers via SDK. O socket Docker é usado apenas para comunicação IPC local.