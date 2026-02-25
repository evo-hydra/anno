#!/usr/bin/env bash
# Anno Production Server Setup
# Run on a fresh Ubuntu 24.04 Hetzner server
# Usage: curl -sSL <raw-url> | bash
#   or:  bash setup-server.sh

set -euo pipefail

ANNO_REPO="https://github.com/evointel/anno.git"
ANNO_DIR="/opt/anno"
LANDING_DIR="/var/www/landing"

echo "============================================"
echo "  Anno Production Server Setup"
echo "  Ubuntu 24.04 LTS"
echo "============================================"
echo ""

# --- System updates ---
echo "[1/6] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl git ufw fail2ban

# --- Firewall ---
echo "[2/6] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow http
ufw allow https
echo "y" | ufw enable

# --- Docker ---
echo "[3/6] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

# Docker Compose plugin (comes with Docker now, but ensure it's there)
if ! docker compose version &> /dev/null; then
    apt-get install -y -qq docker-compose-plugin
fi

# --- Caddy ---
echo "[4/6] Installing Caddy..."
if ! command -v caddy &> /dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
fi

# Create log directory for Caddy
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# --- Clone Anno ---
echo "[5/6] Setting up Anno..."
if [ -d "$ANNO_DIR" ]; then
    echo "  Anno directory exists, pulling latest..."
    cd "$ANNO_DIR"
    git pull
else
    git clone "$ANNO_REPO" "$ANNO_DIR"
    cd "$ANNO_DIR"
fi

# --- Generate API Key ---
echo "[6/6] Generating configuration..."
cd "$ANNO_DIR/deploy"

if [ ! -f .env.production ] || grep -q "CHANGE_ME" .env.production; then
    # Copy template
    if [ -f .env.production.template ]; then
        cp .env.production.template .env.production
    fi

    # Generate API keys
    DEMO_KEY=$(openssl rand -hex 32)
    NIC_KEY=$(openssl rand -hex 32)

    # Replace placeholder
    sed -i "s/CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32/${DEMO_KEY},${NIC_KEY}/" .env.production

    echo ""
    echo "============================================"
    echo "  API KEYS GENERATED — SAVE THESE NOW!"
    echo "============================================"
    echo ""
    echo "  Demo Key:  ${DEMO_KEY}"
    echo "  Admin Key: ${NIC_KEY}"
    echo ""
    echo "  These keys are stored in:"
    echo "  ${ANNO_DIR}/deploy/.env.production"
    echo "============================================"
    echo ""
fi

# --- Landing page directory ---
mkdir -p "$LANDING_DIR"
if [ -d "$ANNO_DIR/deploy/landing" ]; then
    cp -r "$ANNO_DIR/deploy/landing/"* "$LANDING_DIR/"
fi

# --- Install Caddy config ---
cp "$ANNO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Point your DNS:"
echo "     anno.evolvingintelligence.ai  → $(curl -s ifconfig.me)"
echo "     evolvingintelligence.ai       → $(curl -s ifconfig.me)"
echo "     www.evolvingintelligence.ai   → $(curl -s ifconfig.me)"
echo ""
echo "  2. Edit API keys if needed:"
echo "     nano ${ANNO_DIR}/deploy/.env.production"
echo ""
echo "  3. Start Anno:"
echo "     cd ${ANNO_DIR}/deploy"
echo "     docker compose -f docker-compose.prod.yml up -d --build"
echo ""
echo "  4. Restart Caddy to pick up config:"
echo "     systemctl restart caddy"
echo ""
echo "  5. Verify:"
echo "     curl https://anno.evolvingintelligence.ai/health"
echo ""
echo "============================================"
