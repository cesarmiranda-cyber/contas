#!/usr/bin/env bash
# Deploy no servidor Vibe. Variáveis: VIBE_APP_KEY, SERVER_ID, BITRIX_WEBHOOK (obrigatórias);
# BASE_VERSION (ex.: v1, a versão em que o código se baseia; exigido em servidores com time),
# ASAAS_API_KEY e ASAAS_ENV (sandbox|production) opcionais. Nada de segredo fica no repositório.
set -euo pipefail
: "${VIBE_APP_KEY:?}" "${SERVER_ID:?}" "${BITRIX_WEBHOOK:?}"
cd "$(dirname "$0")"
tar czf /tmp/contas-app.tgz server.js package.json lib public
python3 - <<PY > /tmp/contas-deploy.json
import base64, json, os
env = {"BITRIX_WEBHOOK": os.environ["BITRIX_WEBHOOK"], "DATA_DIR": "/opt/data/state", "ASAAS_ENV": os.environ.get("ASAAS_ENV", "sandbox")}
if os.environ.get("ASAAS_API_KEY"): env["ASAAS_API_KEY"] = os.environ["ASAAS_API_KEY"]
print(json.dumps({
  "source": {"content": base64.b64encode(open("/tmp/contas-app.tgz","rb").read()).decode()},
  "runtime": "node20", "start": "cd /opt/app && node server.js", "port": 3000,
  "env": env, "dataDirs": ["/opt/data/state"], "healthPath": "/health",
  "displayName": "Contas a Receber", "description": "Contas a receber do funil Contas (Bitrix24) integrado ao Asaas, com régua de cobrança automática.",
  "changelog": os.environ.get("CHANGELOG", "Atualização do app"),
  **({"baseVersionId": os.environ["BASE_VERSION"]} if os.environ.get("BASE_VERSION") else {})}))
PY
curl -sS -m 900 -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/deploy" \
  -H "X-Api-Key: $VIBE_APP_KEY" -H "Content-Type: application/json" --data @/tmp/contas-deploy.json
