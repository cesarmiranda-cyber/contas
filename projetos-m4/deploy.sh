#!/usr/bin/env bash
# Deploy no servidor Vibe. Variáveis: VIBE_APP_KEY e SERVER_ID (obrigatórias). Nada de segredo no repositório.
set -euo pipefail
: "${VIBE_APP_KEY:?}" "${SERVER_ID:?}"
cd "$(dirname "$0")"; umask 077
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tar czf "$T/app.tgz" server.js nucleo.js package.json lib rotas public
T="$T" python3 - <<'PY' > "$T/deploy.json"
import base64, json, os
print(json.dumps({"source": {"content": base64.b64encode(open(os.environ["T"]+"/app.tgz","rb").read()).decode()},
  "runtime": "node20", "start": "cd /opt/app && node server.js", "port": 3000,
  "env": {"DATA_DIR": "/opt/data/state", "PUBLIC_URL": os.environ.get("PUBLIC_URL", ""), "SUPORTE_ATIVO": os.environ.get("SUPORTE_ATIVO", "1")}, "dataDirs": ["/opt/data/state"], "healthPath": "/health",
  "displayName": "Projetos M4", "description": "Portal do cliente: projetos, cronograma Gantt, status e documentos.",
  "changelog": os.environ.get("CHANGELOG", "Atualização do app")}))
PY
curl -sS -m 900 -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/deploy" \
  -H @<(printf 'X-Api-Key: %s\n' "$VIBE_APP_KEY") -H "Content-Type: application/json" --data @"$T/deploy.json"
