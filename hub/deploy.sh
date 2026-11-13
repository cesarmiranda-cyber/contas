#!/usr/bin/env bash
# Deploy do Hub no servidor Vibe (Black Hole). Nada de segredo fica no repositório.
# Obrigatórias: VIBE_APP_KEY (chave do app, vira env do servidor), SERVER_ID, BITRIX_PORTAL (ex.: empresa.bitrix24.com.br)
# Opcionais: BASE_VERSION (vN em que o código se baseia), CHANGELOG
set -euo pipefail
: "${VIBE_APP_KEY:?}" "${SERVER_ID:?}" "${BITRIX_PORTAL:?}"
cd "$(dirname "$0")"
umask 077
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tar czf "$T/app.tgz" server.js package.json lib public
T="$T" python3 - <<'PY' > "$T/deploy.json"
import base64, json, os
print(json.dumps({
  "source": {"content": base64.b64encode(open(os.environ["T"] + "/app.tgz", "rb").read()).decode()},
  "runtime": os.environ.get("RUNTIME", "node24"), "start": "cd /opt/app && node server.js", "port": 3000,
  "env": {"VIBE_APP_KEY": os.environ["VIBE_APP_KEY"], "BITRIX_PORTAL": os.environ["BITRIX_PORTAL"]},
  "healthPath": "/health",
  "displayName": "Hub do Escritório",
  "description": "Hub de ferramentas do escritório. Módulo Validador de Cadastro: cadastra empresas pelo CNPJ (Receita Federal), vincula contatos e consulta clientes.",
  "changelog": os.environ.get("CHANGELOG", "Atualização do app"),
  **({"baseVersionId": os.environ["BASE_VERSION"]} if os.environ.get("BASE_VERSION") else {})}))
PY
curl -sS -m 700 -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/deploy" \
  -H @<(printf 'X-Api-Key: %s\n' "$VIBE_APP_KEY") -H "Content-Type: application/json" --data @"$T/deploy.json"
echo
curl -sS -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/icon" \
  -H @<(printf 'X-Api-Key: %s\n' "$VIBE_APP_KEY") -F "file=@icon.svg;type=image/svg+xml"
echo
