#!/bin/bash
# /home/davis/app/deploy.sh
# Simple deployment script - just restart

set -e

cd /home/davis/app

echo "Pulling latest code..."
# git pull origin main  <-- REMOVE OR COMMENT OUT THIS LINE

echo "Rebuilding and restarting containers..."
docker compose down
docker compose up -d --build

echo "Cleaning up old images..."
docker image prune -f

echo "Deployment complete!"
docker compose ps