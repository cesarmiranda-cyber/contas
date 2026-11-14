#!/usr/bin/env bash
# Deploy do Hub de Clientes no servidor Vibe.
# Variáveis: VIBE_KEY (chave da API, também usada pelo app para ler/escrever o Bitrix24) e SERVER_ID (obrigatórias);
# CHANGELOG (opcional; use em atualizações), BASE_VERSION (opcional). Nada de segredo fica no repositório.
set -euo pipefail
: "${VIBE_KEY:?}" "${SERVER_ID:?}"
cd "$(dirname "$0")"
umask 077
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tar czf "$T/app.tgz" server.js package.json lib public
T="$T" python3 - <<'PY' > "$T/deploy.json"
import base64, json, os
d = {
  "source": {"content": base64.b64encode(open(os.environ["T"]+"/app.tgz","rb").read()).decode()},
  "runtime": os.environ.get("RUNTIME", "node20"), "start": "cd /opt/app && node server.js", "port": 3000,
  "env": {"VIBE_KEY": os.environ["VIBE_KEY"], "DATA_DIR": "/opt/data/state"},
  "dataDirs": ["/opt/data/state"], "healthPath": "/health",
  "displayName": "Hub de Clientes",
  "description": "Hub de gestão de clientes do Bitrix24: registro mensal de contato/reunião, dashboard de acompanhamento e ciclo de 12 meses do funil de contratos ativos.",
}
if os.environ.get("CHANGELOG"): d["changelog"] = os.environ["CHANGELOG"]
if os.environ.get("BASE_VERSION"): d["baseVersionId"] = os.environ["BASE_VERSION"]
print(json.dumps(d))
PY
curl -sS -m 900 -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/deploy" \
  -H @<(printf 'X-Api-Key: %s\n' "$VIBE_KEY") -H "Content-Type: application/json" --data @"$T/deploy.json"
