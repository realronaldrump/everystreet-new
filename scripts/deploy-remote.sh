#!/bin/bash
set -e

# Configuration
REMOTE_HOST="100.96.182.111"
REMOTE_DIR="/home/davis/app"
REMOTE_USER="root" # Defaulting to root based on previous context, but can be overridden

# Check if we can connect
echo "Checking connection to $REMOTE_HOST..."
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_HOST" echo "Connection OK" &>/dev/null; then
  echo "⚠️  Cannot connect to $REMOTE_HOST directly."
  echo "   Trying with user 'root'..."
  if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$REMOTE_HOST" echo "Connection OK" &>/dev/null; then
     echo "❌ Failed to connect to $REMOTE_HOST. Make sure you have SSH access."
     exit 1
  else
     REMOTE_USER="root"
  fi
else
  # If generic connection works, use implied user (likely from config)
  REMOTE_USER=""
fi

TARGET="$REMOTE_HOST"
if [ -n "$REMOTE_USER" ]; then
  TARGET="$REMOTE_USER@$REMOTE_HOST"
fi

echo "🚀 Deploying to $TARGET:$REMOTE_DIR..."

# 1. Sync configuration files and source code
echo "📂 Syncing source code..."
rsync -avz --progress \
  --exclude 'venv' \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude 'node_modules' \
  --exclude 'osm_extracts' \
  --exclude 'everystreet-data' \
  --exclude '.DS_Store' \
  ./ \
  "$TARGET:$REMOTE_DIR/"

# 2. Fix permissions for Valhalla (runs as uid 59999)
echo "🔒 Ensuring correct permissions for Valhalla volume..."
ssh "$TARGET" "docker run --rm -v app_valhalla_tiles:/custom_files busybox chown -R 59999:59999 /custom_files || echo 'Volume might not exist yet, skipping permission fix'"

# 3. Update and restart services
echo "🔄 Updating services..."

ssh "$TARGET" "cd $REMOTE_DIR && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d"

echo "✅ Deployment complete!"
echo "   - Valhalla and Nominatim should be starting up."
echo "   - Check status with: ssh $TARGET \"cd $REMOTE_DIR && docker compose ps\""
