#!/bin/bash
# /home/davis/app/deploy.sh
# Simple deployment script - just restart

set -e

cd /home/davis/app

echo "Pulling latest code..."
# git pull origin main  <-- REMOVE OR COMMENT OUT THIS LINE

echo "Ensuring web-proxy network exists..."
docker network create web-proxy 2>/dev/null || echo "Network web-proxy already exists"

echo "Rebuilding and restarting containers..."
docker compose down
docker compose up -d --build

echo "Waiting for web service to start..."
sleep 5

echo "Checking container status..."
docker compose ps

echo "Checking web container logs..."
echo "--- Last 20 lines of web container logs ---"
docker compose logs --tail=20 web

echo "Checking if web container is healthy..."
if docker compose ps web | grep -q "Up"; then
    echo "✓ Web container is running"
    
    echo "Testing web container connectivity..."
    if docker compose exec -T web curl -f http://localhost:8080/ > /dev/null 2>&1 || \
       docker compose exec -T web wget -q --spider http://localhost:8080/ 2>&1; then
        echo "✓ Web container is responding on port 8080"
    else
        echo "✗ WARNING: Web container is running but not responding on port 8080"
        echo "  Check logs above for startup errors"
    fi
    
    echo "Checking network connectivity..."
    WEB_CONTAINER_ID=$(docker compose ps -q web)
    if [ -n "$WEB_CONTAINER_ID" ]; then
        if docker network inspect web-proxy 2>/dev/null | grep -q "$WEB_CONTAINER_ID"; then
            echo "✓ Web container is connected to web-proxy network"
        else
            echo "✗ WARNING: Web container may not be connected to web-proxy network"
            echo "  Run: docker network connect web-proxy $WEB_CONTAINER_ID"
        fi
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
echo "If you're still getting 502 errors, check:"
echo "  1. OpenResty/nginx config points to 'web:8080' (if on same network) or 'localhost:8080'"
echo "  2. Web container logs for startup errors: docker compose logs web"
echo "  3. Database connectivity: docker compose logs mongo"
echo "  4. Environment variables are set correctly in .env file"