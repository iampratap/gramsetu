#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="${GRAMSETU_DOMAIN:-app.mahagramvani.in}"

echo "==> Building frontend"
npm install --prefix "$ROOT/frontend"
npm run build --prefix "$ROOT/frontend"

echo "==> Publishing static files to nginx root"
sudo rsync -a --delete "$ROOT/frontend/dist/" /var/www/gramsetu/

echo "==> Packaging the Raspberry Pi speaker installer"
BUNDLE_DIR="$(mktemp -d)"
mkdir -p "$BUNDLE_DIR/gramsetu-speaker"
rsync -a --exclude '__pycache__' "$ROOT/speaker/" "$BUNDLE_DIR/gramsetu-speaker/"
sudo mkdir -p /var/www/gramsetu/downloads
sudo tar -czf /var/www/gramsetu/downloads/gramsetu-speaker.tar.gz -C "$BUNDLE_DIR" gramsetu-speaker
rm -rf "$BUNDLE_DIR"
sudo chown -R www-data:www-data /var/www/gramsetu

echo "==> Updating nginx config for $DOMAIN"
LE_DIR="/etc/letsencrypt/live/$DOMAIN"
link_certificate() {
  if sudo test -f "$LE_DIR/fullchain.pem"; then
    sudo ln -sfn "$LE_DIR/fullchain.pem" /etc/nginx/ssl/site.crt
    sudo ln -sfn "$LE_DIR/privkey.pem" /etc/nginx/ssl/site.key
  else
    sudo ln -sfn /etc/nginx/ssl/gramsetu.crt /etc/nginx/ssl/site.crt
    sudo ln -sfn /etc/nginx/ssl/gramsetu.key /etc/nginx/ssl/site.key
  fi
}
# Served to HTTPS requests by IP address, and to the domain until Let's Encrypt issues a certificate.
if [ ! -f /etc/nginx/ssl/gramsetu.crt ]; then
  sudo mkdir -p /etc/nginx/ssl
  sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /etc/nginx/ssl/gramsetu.key -out /etc/nginx/ssl/gramsetu.crt \
    -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" 2>/dev/null
  sudo chmod 600 /etc/nginx/ssl/gramsetu.key
fi
link_certificate
sudo mkdir -p /var/www/certbot
for part in locations proxy ws; do
  sudo install -m 644 "$ROOT/deploy/nginx-gramsetu-$part.conf" "/etc/nginx/snippets/gramsetu-$part.conf"
done
sed "s/__DOMAIN__/$DOMAIN/g" "$ROOT/deploy/nginx-gramsetu.conf" | sudo tee /etc/nginx/sites-available/gramsetu >/dev/null
sudo nginx -t
sudo systemctl reload nginx

if ! sudo test -f "$LE_DIR/fullchain.pem"; then
  echo "==> Requesting a Let's Encrypt certificate for $DOMAIN"
  if [ -n "${LETSENCRYPT_EMAIL:-}" ]; then contact=(--email "$LETSENCRYPT_EMAIL"); else contact=(--register-unsafely-without-email); fi
  sudo certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos "${contact[@]}"
  link_certificate
fi
# certbot.timer renews the certificate; nginx has to reload to pick it up.
sudo install -D -m 755 /dev/stdin /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK

echo "==> Rebuilding and starting API + Postgres"
sudo docker compose -f "$ROOT/docker-compose.yml" up -d --build db api
sudo systemctl reload nginx

echo "==> Health check"
for _ in $(seq 1 30); do
  curl -sf "https://$DOMAIN/api/health" --resolve "$DOMAIN:443:127.0.0.1" && echo && break
  sleep 2
done
echo "Deployed. Open https://$DOMAIN/"
