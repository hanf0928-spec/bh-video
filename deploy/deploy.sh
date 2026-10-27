#!/usr/bin/env bash
# BH Video — one-shot deploy helper for Ubuntu / Debian cloud servers.
#
# Usage (on the server, as root or with sudo):
#   DOMAIN=video.example.com bash deploy/deploy.sh
#
# What it does:
#   1. installs python3 / nginx / certbot / COS SDK;
#   2. installs this project to /opt/bh-video (if run from another dir, copies files);
#   3. drops the systemd unit and starts the service on port 8765 (loopback-only via Nginx);
#   4. drops an Nginx reverse-proxy and reloads it;
#   5. optionally runs certbot to obtain an HTTPS certificate when DOMAIN is set.

set -euo pipefail

PROJECT_DIR_DEFAULT="/opt/bh-video"
PROJECT_DIR="${PROJECT_DIR:-$PROJECT_DIR_DEFAULT}"
DOMAIN="${DOMAIN:-}"
PORT="${PORT:-8765}"

echo "==> Installing system packages (nginx, python3, certbot)…"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    python3 python3-pip nginx certbot python3-certbot-nginx rsync

echo "==> Installing Tencent COS SDK…"
pip3 install -U cos-python-sdk-v5

# If this script is run from a working copy somewhere else, sync it into
# the project dir. Otherwise assume PROJECT_DIR already contains the code.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ "$SOURCE_ROOT" != "$PROJECT_DIR" ]; then
    echo "==> Syncing source into $PROJECT_DIR …"
    mkdir -p "$PROJECT_DIR"
    rsync -a --delete \
        --exclude '.git' \
        --exclude 'views.json' \
        --exclude 'videos.local.json' \
        --exclude 'ads_stats.json' \
        --exclude 'visits.json' \
        --exclude 'cos_config.json' \
        "$SOURCE_ROOT/" "$PROJECT_DIR/"
fi

chown -R www-data:www-data "$PROJECT_DIR"

echo "==> Installing systemd unit…"
install -m 0644 "$PROJECT_DIR/deploy/bh-video.service" /etc/systemd/system/bh-video.service
# Rewrite the hardcoded port in case the operator passed a custom one.
sed -i "s|server.py 8765|server.py ${PORT}|g" /etc/systemd/system/bh-video.service

systemctl daemon-reload
systemctl enable --now bh-video.service
systemctl status bh-video.service --no-pager | head -n 15 || true

echo "==> Installing Nginx config…"
install -m 0644 "$PROJECT_DIR/deploy/nginx-bh-video.conf" /etc/nginx/sites-available/bh-video.conf
if [ -n "$DOMAIN" ]; then
    sed -i "s/YOUR_DOMAIN/${DOMAIN}/g" /etc/nginx/sites-available/bh-video.conf
fi
# Also rewrite the upstream port if customised.
sed -i "s|http://127.0.0.1:8765;|http://127.0.0.1:${PORT};|g" /etc/nginx/sites-available/bh-video.conf
ln -sf /etc/nginx/sites-available/bh-video.conf /etc/nginx/sites-enabled/bh-video.conf

# Remove the default Nginx welcome site so it doesn't shadow us.
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

if [ -n "$DOMAIN" ]; then
    echo "==> Requesting HTTPS certificate for $DOMAIN via certbot…"
    certbot --nginx --non-interactive --agree-tos \
        --register-unsafely-without-email \
        -d "$DOMAIN" || echo "(certbot failed, you can retry manually: certbot --nginx -d $DOMAIN)"
fi

PUBLIC_IP="$(curl -s --max-time 4 http://ifconfig.me || echo '<公网IP>')"
echo ""
echo "==> Done."
if [ -n "$DOMAIN" ]; then
    echo "   Home :  https://${DOMAIN}/"
    echo "   Admin:  https://${DOMAIN}/admin.html"
else
    echo "   Home :  http://${PUBLIC_IP}/"
    echo "   Admin:  http://${PUBLIC_IP}/admin.html"
fi
echo "   Backend logs: tail -f /var/log/bh-video.log"
