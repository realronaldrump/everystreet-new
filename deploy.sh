#!/bin/bash
# /home/davis/app/deploy.sh
# Simple deployment script for Cloudflare Tunnel setup (production)

set -e

cd /home/davis/app

if [ -d ".git" ]; then
    echo "Pulling latest code..."
    git pull origin main
else
    echo "⚠️  Not a git repo. This script expects /home/davis/app to be a git clone."
    echo "   - Option A: git clone the repo into /home/davis/app"
    echo "   - Option B: run scripts/deploy-remote.sh from your Mac to rsync files"
    echo ""
fi

if [ ! -f "docker-compose.prod.yml" ]; then
    echo "❌ Missing docker-compose.prod.yml. Update this directory from GitHub or rsync first."
    exit 1
fi

echo "Pulling latest images and restarting containers..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

echo "Waiting for web service to start..."
sleep 5

echo "Checking container status..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

echo "Checking web container logs..."
echo "--- Last 20 lines of web container logs ---"
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=20 web

echo "Checking if web container is healthy..."
if docker compose -f docker-compose.yml -f docker-compose.prod.yml ps web | grep -q "Up"; then
    echo "✓ Web container is running"

    echo "Testing web container connectivity..."
    if curl -sf http://localhost:8080/ > /dev/null 2>&1; then
        echo "✓ Web container is responding on port 8080"
    else
        echo "⚠ Web container is running but not responding yet (may still be starting)"
    fi
else
    echo "✗ ERROR: Web container is not running!"
    echo "  Check logs above for startup errors"
fi

echo "Cleaning up old images..."
docker image prune -f

echo ""
echo "Deployment complete!"
echo ""
echo "Your app should be accessible at: https://everystreet.me"
echo ""
echo "If issues occur, check:"
echo "  1. Web container logs: docker compose logs web"
echo "  2. Database connectivity: docker compose logs mongo"
echo "  3. Cloudflare tunnel: sudo systemctl status cloudflared"
