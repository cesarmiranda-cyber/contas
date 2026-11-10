#!/usr/bin/env bash
# Roda NA instância (Ubuntu 22.04/24.04), como root: sudo ./deploy/setup.sh consulta.seudominio.com.br ipsis.bitrix24.com.br
set -euo pipefail
DOM="${1:?domínio da instância (ex.: consulta.seudominio.com.br)}"; PORTAL="${2:?portal Bitrix (ex.: ipsis.bitrix24.com.br)}"
cd "$(dirname "$0")/.."
apt-get update -y && apt-get install -y curl debian-keyring debian-archive-keyring apt-transport-https gnupg
command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }
command -v caddy >/dev/null || { apt-get install -y caddy; }
id consulta >/dev/null 2>&1 || useradd --system --home /opt/consulta-cliente consulta
mkdir -p /opt/consulta-cliente && cp -r ./*.js package.json public /opt/consulta-cliente/ && chown -R consulta /opt/consulta-cliente
if [ ! -f /etc/consulta-cliente.env ]; then
  read -rsp "Cole o webhook do Bitrix24 (não aparece na tela): " WH; echo
  umask 077
  printf 'BITRIX_WEBHOOK=%s\nPORTAL_DOMAIN=%s\nSESSION_SECRET=%s\nPORT=3000\n' "$WH" "$PORTAL" "$(head -c 32 /dev/urandom | base64 | tr -d '=+/')" > /etc/consulta-cliente.env
fi
cp deploy/consulta.service /etc/systemd/system/
printf '%s {\n  reverse_proxy 127.0.0.1:3000\n}\n' "$DOM" > /etc/caddy/Caddyfile
systemctl daemon-reload && systemctl enable --now consulta && systemctl restart consulta caddy
echo "Pronto: https://$DOM/health"
