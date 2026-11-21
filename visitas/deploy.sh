#!/usr/bin/env bash
# Deploy no servidor Vibe+. Obrigatórias: VIBE_APP_KEY, SERVER_ID. Opcionais: BITRIX_WEBHOOK (pode ser definido depois em
# Configurações), PREPARAR=1 (cria etapas/campos faltantes no 1º deploy), ATIVAR=1|0, CHANGELOG, BASE_VERSION, RUNTIME.
# Nada de segredo fica no repositório.
set -euo pipefail
: "${VIBE_APP_KEY:?}" "${SERVER_ID:?}"
cd "$(dirname "$0")"
umask 077
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tar czf "$T/app.tgz" server.js package.json lib public
T="$T" python3 - <<'PY' > "$T/deploy.json"
import base64, json, os
env = {"DATA_DIR": "/opt/data/state"}
for k in ("BITRIX_WEBHOOK", "PREPARAR", "ATIVAR", "SPA_FILA", "SPA_VISITA", "MANUTENCAO"):
    if os.environ.get(k): env[k] = os.environ[k]
print(json.dumps({
  "source": {"content": base64.b64encode(open(os.environ["T"]+"/app.tgz","rb").read()).decode()},
  "runtime": os.environ.get("RUNTIME", "node20"), "start": "cd /opt/app && node server.js", "port": 3000,
  "env": env, "dataDirs": ["/opt/data/state"], "healthPath": "/health",
  "displayName": "Registro de Visitas", "description": "Fila automática e registro de visitas comerciais por empresa, segmento e vendedor (Bitrix24).",
  "changelog": os.environ.get("CHANGELOG", "Atualização do app"),
  **({"baseVersionId": os.environ["BASE_VERSION"]} if os.environ.get("BASE_VERSION") else {})}))
PY
curl -sS -m 900 -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/deploy" \
  -H @<(printf 'X-Api-Key: %s\n' "$VIBE_APP_KEY") -H "Content-Type: application/json" --data @"$T/deploy.json"
