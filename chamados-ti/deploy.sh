#!/usr/bin/env bash
# Deploy no servidor Vibe. Variáveis obrigatórias: VIBE_API_KEY (a mesma chave usada pelo app em runtime), SERVER_ID.
set -euo pipefail
: "${VIBE_API_KEY:?}" "${SERVER_ID:?}"
cd "$(dirname "$0")"
tar czf /tmp/chamados-ti.tgz server.js package.json public
python3 - <<PY > /tmp/chamados-ti-deploy.json
import base64, json, os
print(json.dumps({
  "source": {"content": base64.b64encode(open("/tmp/chamados-ti.tgz","rb").read()).decode()},
  "runtime": "node20", "start": "cd /opt/app && node server.js", "port": 3000,
  "env": {"VIBE_API_KEY": os.environ["VIBE_API_KEY"], "SPA_TYPE_ID": "1074"},
  "healthPath": "/health",
  "displayName": "Portal de Chamados de TI",
  "description": "Abertura e acompanhamento de chamados de TI; os chamados são gravados no SPA Portal TI do Bitrix24.",
  "changelog": os.environ.get("CHANGELOG", "Atualização do app")}))
PY
curl -sS -m 900 -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/deploy" \
  -H "X-Api-Key: $VIBE_API_KEY" -H "Content-Type: application/json" --data @/tmp/chamados-ti-deploy.json
