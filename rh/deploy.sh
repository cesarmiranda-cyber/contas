#!/usr/bin/env bash
# Deploy do RH no servidor Vibe. Variáveis obrigatórias: VIBE_APP_KEY, SERVER_ID, VIBE_APPLICATION_ID.
# Opcionais: SEED_DEMO=1 (dados de exemplo), INTAKE_KEY_IDS (ids das chaves externas autorizadas a enviar candidaturas), RUNTIME, CHANGELOG, BASE_VERSION.
# A chave é passada ao servidor por variável de ambiente (necessária para buscar usuários do Bitrix24); nada de segredo no repositório.
set -euo pipefail
: "${VIBE_APP_KEY:?}" "${SERVER_ID:?}" "${VIBE_APPLICATION_ID:?}"
cd "$(dirname "$0")"
umask 077
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# pdf-parse usa só a versão v1.10.100 do pdf.js; as outras (~29 MB) ficam de fora do pacote
mkdir "$T/pkg" && cp -r server.js package.json lib public node_modules "$T/pkg/"
find "$T/pkg/node_modules/pdf-parse/lib/pdf.js" -mindepth 1 -maxdepth 1 -type d ! -name v1.10.100 -exec rm -rf {} +
rm -rf "$T/pkg/node_modules/pdf-parse/test" "$T/pkg/node_modules/pdf-parse/.git"* 2>/dev/null || true
tar czf "$T/app.tgz" -C "$T/pkg" .
T="$T" python3 - <<'PY' > "$T/deploy.json"
import base64, json, os
env = {"VIBE_APP_KEY": os.environ["VIBE_APP_KEY"], "VIBE_APPLICATION_ID": os.environ["VIBE_APPLICATION_ID"], "DATA_DIR": "/opt/data/state"}
if os.environ.get("INTAKE_KEY_IDS"): env["INTAKE_KEY_IDS"] = os.environ["INTAKE_KEY_IDS"]
if os.environ.get("SEED_DEMO"): env["SEED_DEMO"] = os.environ["SEED_DEMO"]   # 1 = cria vagas e candidaturas fictícias se o módulo estiver vazio
print(json.dumps({
  "source": {"content": base64.b64encode(open(os.environ["T"]+"/app.tgz","rb").read()).decode()},
  "runtime": os.environ.get("RUNTIME", "node20"), "start": "cd /opt/app && node server.js", "port": 3000,
  "env": env, "dataDirs": ["/opt/data/state"], "healthPath": "/health",
  "displayName": "RH · Original Locações", "description": "Portal de RH: módulos com controle de acesso por usuário do Bitrix24 e recepção de currículos.",
  "changelog": os.environ.get("CHANGELOG", "Atualização do app"),
  **({"baseVersionId": os.environ["BASE_VERSION"]} if os.environ.get("BASE_VERSION") else {})}))
PY
curl -sS -m 900 -X POST "https://vibecode.bitrix24.com/v1/infra/servers/$SERVER_ID/deploy" \
  -H @<(printf 'X-Api-Key: %s\n' "$VIBE_APP_KEY") -H "Content-Type: application/json" --data @"$T/deploy.json"
