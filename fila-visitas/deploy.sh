#!/usr/bin/env bash
# Deploy no servidor Vibe. Obrigatórias: VIBE_APP_KEY, SERVER_ID. BITRIX_WEBHOOK (webhook de entrada do Bitrix24) pode ser definido depois.
# Opcionais: EVENT_TOKEN, CHANGELOG, BASE_VERSION. Nenhum segredo fica no repositório.
set -euo pipefail
: "${VIBE_APP_KEY:?}" "${SERVER_ID:?}"
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}"
tar czf "$OUT/fila-app.tgz" server.js package.json lib public
python3 - "$OUT" <<PY > "$OUT/fila-deploy.json"
import base64, json, os, sys
out = sys.argv[1]
env = {"DATA_DIR": "/opt/data/state", "VIBE_APP_KEY": os.environ["VIBE_APP_KEY"]}
if os.environ.get("BITRIX_WEBHOOK"): env["BITRIX_WEBHOOK"] = os.environ["BITRIX_WEBHOOK"]
if os.environ.get("ANALISE_DUPLICADOS"): env["ANALISE_DUPLICADOS"] = "1"
if os.environ.get("APAGAR_CAMPOS"): env["APAGAR_CAMPOS"] = os.environ["APAGAR_CAMPOS"]
if os.environ.get("PREPARAR"): env["PREPARAR"] = "1"
if os.environ.get("ATIVAR"): env["ATIVAR"] = os.environ["ATIVAR"]
if os.environ.get("SYNC_EMPRESA"): env["SYNC_EMPRESA"] = os.environ["SYNC_EMPRESA"]
if os.environ.get("DIAG_DEPTS"): env["DIAG_DEPTS"] = os.environ["DIAG_DEPTS"]
if os.environ.get("DIAG_TIPO"): env["DIAG_TIPO"] = "1"
if os.environ.get("SPA_DUPLICADOS"): env["SPA_DUPLICADOS"] = os.environ["SPA_DUPLICADOS"]
if os.environ.get("DIAG_OPORT"): env["DIAG_OPORT"] = "1"
if os.environ.get("EVENT_TOKEN"): env["EVENT_TOKEN"] = os.environ["EVENT_TOKEN"]
print(json.dumps({
  "source": {"content": base64.b64encode(open(out + "/fila-app.tgz","rb").read()).decode()},
  "runtime": "node20", "start": "cd /opt/app && node server.js", "port": 3000,
  "env": env, "dataDirs": ["/opt/data/state"], "healthPath": "/health",
  "displayName": "Fila de Visitas", "description": "Fila e registro de visitas comerciais da DLC (SPAs 1036 e 1032).",
  "changelog": os.environ.get("CHANGELOG", "Atualização do app"),
  **({"baseVersionId": os.environ["BASE_VERSION"]} if os.environ.get("BASE_VERSION") else {})}))
PY
curl -sS -m 900 -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/deploy" \
  -H "X-Api-Key: $VIBE_APP_KEY" -H "Content-Type: application/json" --data @"$OUT/fila-deploy.json"
