#!/bin/bash
set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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
║   Docker Secure List API - Instalador v2.1    ║
╚════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# Verificar se está no diretório correto
if [ ! -f "package.json" ] || [ ! -d "src" ]; then
    log_error "Execute este script na raiz do projeto!"
    log_info "Certifique-se de que package.json e a pasta src/ existem"
    exit 1
fi

# Obter caminho absoluto do projeto
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="docker-secure-list-api"

log_info "Verificando dependências do sistema..."

# Verificar Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js não está instalado!"
    log_info "Instale Node.js 18+ em: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    log_error "Node.js versão $NODE_VERSION detectada"
    log_info "É necessário Node.js 18 ou superior"
    exit 1
fi
log_success "Node.js $(node -v) ✓"

# Verificar npm
if ! command -v npm &> /dev/null; then
    log_error "npm não está instalado!"
    exit 1
fi
log_success "npm v$(npm -v) ✓"

# Verificar Docker
if ! command -v docker &> /dev/null; then
    log_error "Docker não está instalado!"
    log_info "Instale o Docker em: https://docs.docker.com/get-docker/"
    exit 1
fi
log_success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') ✓"

# Configurar permissões Docker
log_info "Configurando acesso ao Docker..."

if ! getent group docker > /dev/null 2>&1; then
    log_warning "Grupo 'docker' não existe. Criando..."
    sudo groupadd docker
fi

if id -nG "$USER" | grep -qw docker; then
    log_success "Usuário já está no grupo docker"
else
    log_info "Adicionando usuário '$USER' ao grupo docker..."
    sudo usermod -aG docker "$USER"
    log_warning "IMPORTANTE: Você precisa fazer logout/login ou executar: newgrp docker"
fi

# Testar acesso ao Docker
if docker ps >/dev/null 2>&1; then
    log_success "Acesso ao Docker funcionando ✓"
else
    log_warning "Não foi possível acessar o Docker sem sudo"
    log_info "Execute 'newgrp docker' ou faça logout/login"
fi

# Criar arquivo .env se não existir
if [ ! -f ".env" ]; then
    log_info "Criando arquivo .env..."
    
    # Gerar base64 da chave pública JWT
    if [ -f "jwt_public.pem" ]; then
        JWT_PUBLIC_KEY_BASE64=$(base64 -w0 jwt_public.pem 2>/dev/null || base64 jwt_public.pem)
    else
        log_warning "jwt_public.pem não encontrado"
        JWT_PUBLIC_KEY_BASE64=""
    fi
    
    cat > .env << EOF
# Porta da API
PORT=4000

# Origem permitida no CORS (separar por vírgula para múltiplas)
CORS_ORIGINS=https://minhaapp.com

# JWT – verificação RS256 (chave pública)
JWT_ALG=RS256
JWT_PUBLIC_KEY_BASE64=${JWT_PUBLIC_KEY_BASE64}

# Alternativamente (HS256 com segredo compartilhado - não recomendado em prod)
# JWT_ALG=HS256
# JWT_SECRET=seu-segredo-aqui

# Conexão com Docker via socket local
DOCKER_SOCKET=/var/run/docker.sock
EOF
    chmod 600 .env
    log_success "Arquivo .env criado"
    log_warning "EDITE o arquivo .env e configure CORS_ORIGINS!"
else
    log_success "Arquivo .env já existe"
fi

# Instalar dependências
log_info "Instalando dependências npm..."
export NODE_OPTIONS=--dns-result-order=ipv4first
npm install --omit=dev --silent 2>/dev/null || npm install --omit=dev
log_success "Dependências instaladas ✓"

# Criar script de inicialização se não existir
if [ ! -f "start.sh" ]; then
    log_info "Criando script de inicialização..."
    cat > start.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
npm start
EOF
    chmod +x start.sh
    log_success "Script start.sh criado"
fi

# ===== CONFIGURAÇÃO DO SYSTEMD =====
log_info "Configurando serviço systemd..."

# Criar arquivo de serviço
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Detectar arquivo principal (server.js ou index.js)
MAIN_FILE="src/server.js"
if [ ! -f "$PROJECT_DIR/$MAIN_FILE" ]; then
    if [ -f "$PROJECT_DIR/src/index.js" ]; then
        MAIN_FILE="src/index.js"
    elif [ -f "$PROJECT_DIR/index.js" ]; then
        MAIN_FILE="index.js"
    else
        log_error "Não foi possível encontrar o arquivo principal!"
        log_info "Verifique se existe: src/server.js, src/index.js ou index.js"
        exit 1
    fi
fi

log_info "Arquivo principal detectado: $MAIN_FILE"

sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Docker Secure List API
Documentation=https://github.com/seu-repo/docker-secure-list-api
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROJECT_DIR
Environment="NODE_ENV=production"
Environment="PATH=/usr/bin:/usr/local/bin"
ExecStart=$(which node) $PROJECT_DIR/$MAIN_FILE
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Segurança
NoNewPrivileges=true
PrivateTmp=true

# Limites
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

log_success "Arquivo de serviço criado: $SERVICE_FILE"

# Recarregar systemd
log_info "Recarregando systemd..."
sudo systemctl daemon-reload
log_success "Systemd recarregado ✓"

# Habilitar serviço para iniciar no boot
log_info "Habilitando serviço para iniciar automaticamente..."
sudo systemctl enable "$SERVICE_NAME"
log_success "Serviço habilitado para iniciar no boot ✓"

# Verificar se o serviço já está rodando e reiniciar, ou iniciar se não estiver
echo ""
if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    log_info "Serviço já está rodando. Reiniciando..."
    sudo systemctl restart "$SERVICE_NAME"
    sleep 2
    
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        log_success "Serviço reiniciado com sucesso! ✓"
    else
        log_error "Falha ao reiniciar o serviço"
        log_info "Verifique os logs com: sudo journalctl -u $SERVICE_NAME -n 50"
    fi
else
    log_info "Iniciando serviço..."
    sudo systemctl start "$SERVICE_NAME"
    sleep 2
    
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        log_success "Serviço iniciado com sucesso! ✓"
    else
        log_error "Falha ao iniciar o serviço"
        log_info "Verifique os logs com: sudo journalctl -u $SERVICE_NAME -n 50"
    fi
fi

# Resumo final
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Instalação Concluída!                 ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
log_warning "CONFIGURAÇÃO IMPORTANTE:"
echo "  1. Edite o arquivo .env e configure CORS_ORIGINS"
echo "  2. Após editar, reinicie: sudo systemctl restart $SERVICE_NAME"
echo ""
log_info "COMANDOS ÚTEIS:"
echo "  • Iniciar:    sudo systemctl start $SERVICE_NAME"
echo "  • Parar:      sudo systemctl stop $SERVICE_NAME"
echo "  • Reiniciar:  sudo systemctl restart $SERVICE_NAME"
echo "  • Status:     sudo systemctl status $SERVICE_NAME"
echo "  • Logs:       sudo journalctl -u $SERVICE_NAME -f"
echo "  • Desabilitar boot: sudo systemctl disable $SERVICE_NAME"
echo ""
log_info "Teste o healthcheck:"
echo "  curl http://localhost:4000/healthz"
echo ""
