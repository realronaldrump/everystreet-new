#!/bin/bash
# =============================================================================
# Cloudflare Tunnel Setup Script for Watchtower Webhook
# Run this on your Linux mini PC
# =============================================================================

set -e

TUNNEL_NAME="everystreet-deploy"
HOSTNAME="deploy.everystreet.me"
WATCHTOWER_PORT=8090

echo "=========================================="
echo "Cloudflare Tunnel Setup for Watchtower"
echo "=========================================="
echo ""

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "[1/5] Installing cloudflared..."

    # Detect architecture
    ARCH=$(uname -m)
    if [ "$ARCH" = "x86_64" ]; then
        CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
    elif [ "$ARCH" = "aarch64" ]; then
        CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb"
    else
        echo "Unsupported architecture: $ARCH"
        exit 1
    fi

    curl -L --output /tmp/cloudflared.deb "$CLOUDFLARED_URL"
    sudo dpkg -i /tmp/cloudflared.deb
    rm /tmp/cloudflared.deb
    echo "cloudflared installed successfully!"
else
    echo "[1/5] cloudflared already installed, skipping..."
fi

echo ""
echo "[2/5] Authenticating with Cloudflare..."
echo "This will open a browser window (or provide a URL to visit)."
echo ""
cloudflared tunnel login

echo ""
echo "[3/5] Creating tunnel '$TUNNEL_NAME'..."

# Check if tunnel already exists
if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    echo "Tunnel '$TUNNEL_NAME' already exists, using existing tunnel..."
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
else
    cloudflared tunnel create "$TUNNEL_NAME"
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
fi

echo "Tunnel ID: $TUNNEL_ID"

echo ""
echo "[4/5] Configuring tunnel..."

# Create config directory
mkdir -p ~/.cloudflared

# Find the credentials file
CREDS_FILE=$(find ~/.cloudflared -name "*.json" -type f | head -1)

if [ -z "$CREDS_FILE" ]; then
    echo "Error: Could not find credentials file"
    exit 1
fi

# Create config file
cat > ~/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDS_FILE

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$WATCHTOWER_PORT
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF

echo "Config written to ~/.cloudflared/config.yml"

echo ""
echo "[5/5] Setting up DNS and systemd service..."

# Create DNS record
echo "Creating DNS record for $HOSTNAME..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || echo "DNS record may already exist, continuing..."

# Install as systemd service
echo "Installing as systemd service..."
sudo cloudflared service install || echo "Service may already be installed, continuing..."

# Enable and start the service
sudo systemctl enable cloudflared
sudo systemctl restart cloudflared

echo ""
echo "=========================================="
echo "SETUP COMPLETE!"
echo "=========================================="
echo ""
echo "Your Watchtower webhook is now available at:"
echo ""
echo "  https://$HOSTNAME/v1/update"
echo ""
echo "Next steps:"
echo "1. Add these GitHub repository secrets:"
echo "   - WATCHTOWER_URL = https://$HOSTNAME"
echo "   - WATCHTOWER_TOKEN = (your token from .env on this machine)"
echo ""
echo "To check tunnel status:"
echo "  sudo systemctl status cloudflared"
echo "  cloudflared tunnel info $TUNNEL_NAME"
echo ""
echo "To view logs:"
echo "  sudo journalctl -u cloudflared -f"
echo ""
