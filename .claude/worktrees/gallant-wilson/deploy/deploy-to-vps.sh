#!/bin/bash
set -e

# Voice Interface - VPS Deployment Script
# Usage: ./deploy-to-vps.sh [domain] [email]

DOMAIN=${1:-voice.yourdomain.com}
EMAIL=${2:-your-email@example.com}
VPS_HOST="38.242.132.60"
VPS_USER="agentzero"
SSH_KEY="/root/.ssh/agentzero_vps"
PROJECT_DIR="/home/agentzero/workspace/projects/voice-interface"

echo "🚀 Deploying Voice Interface to VPS"
echo "Domain: $DOMAIN"
echo "Email: $EMAIL"

# Check SSH connection
echo "📡 Checking SSH connection..."
ssh -i $SSH_KEY $VPS_USER@$VPS_HOST "echo '✅ SSH connection successful'" || {
    echo "❌ SSH connection failed"
    exit 1
}

# Create project directory
echo "📁 Setting up project directory..."
ssh -i $SSH_KEY $VPS_USER@$VPS_HOST "mkdir -p $PROJECT_DIR"

# Sync project files
echo "📦 Syncing project files..."
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'venv' --exclude '__pycache__' \
    -e "ssh -i $SSH_KEY" \
    ./ $VPS_USER@$VPS_HOST:$PROJECT_DIR/

# Update Caddyfile with actual domain
echo "🔧 Updating Caddyfile..."
ssh -i $SSH_KEY $VPS_USER@$VPS_HOST << REMOTE_EOF
cat > $PROJECT_DIR/deploy/caddy/Caddyfile << 'CADDY_EOF'
$DOMAIN {
    reverse_proxy backend:8000
    tls $EMAIL
    
    header {
        Strict-Transport-Security "max-age=31536000; include-subdomains; preload"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    
    log {
        output file /var/log/caddy/voice-api.log
        format json
    }
}
CADDY_EOF
REMOTE_EOF

# Create .env file
echo "🔐 Creating environment file..."
ssh -i $SSH_KEY $VPS_USER@$VPS_HOST << REMOTE_EOF
if [ ! -f $PROJECT_DIR/.env ]; then
    cat > $PROJECT_DIR/.env << 'ENV_EOF'
TELEGRAM_BOT_TOKEN=
AGENT_ZERO_URL=http://localhost:50001
OPENCLAW_URL=http://localhost:8080
JWT_SECRET_KEY=$(openssl rand -hex 32)
REDIS_URL=redis://redis:6379/0
DOMAIN=$DOMAIN
EMAIL=$EMAIL
ENV_EOF
    echo "⚠️  Please edit $PROJECT_DIR/.env and add your tokens"
fi
REMOTE_EOF

# Start services
echo "🐳 Starting Docker services..."
ssh -i $SSH_KEY $VPS_USER@$VPS_HOST << 'REMOTE_EOF'
cd $PROJECT_DIR
docker compose down 2>/dev/null || true
docker compose up -d --build

echo "⏳ Waiting for services to start..."
sleep 10

# Check health
curl -sf http://localhost:8000/health && echo "\n✅ Backend is healthy" || echo "\n⚠️  Backend health check failed"
REMOTE_EOF

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. SSH to VPS: ssh -i $SSH_KEY $VPS_USER@$VPS_HOST"
echo "2. Edit .env: nano $PROJECT_DIR/.env"
echo "3. Restart: cd $PROJECT_DIR && docker compose restart"
echo "4. Check logs: cd $PROJECT_DIR && docker compose logs -f"
echo ""
echo "API will be available at: https://$DOMAIN"
