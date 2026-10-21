# Fila de Visitas — DLC (réplica da Odin)

Fila de visitas por empresa + segmento + cargo, registro de visita com um toque, reprogramação
com motivo (limitada ao mês) e data da visita imutável. Fonte da verdade: SPAs do Bitrix24
**1036 (Fila)** e **1032 (Registro de Visita)** e a Empresa. Sem dependências (Node ≥ 20).

- Backend: `server.js`, `lib/` (regras puras em `rules.js`, descoberta de campos por nome em `fields.js`, fluxos em `service.js`).
- Varredura a cada 60 s (sincroniza empresas alteradas, reverte edições diretas, roda o job diário a partir das 07h).
  `POST /events` (opcional, `?token=EVENT_TOKEN`) antecipa a varredura quando o Bitrix envia eventos.
- Banco do app (`DATA_DIR/state.json`): configurações, histórico de reprogramações, log, bloqueios, chaves anti-duplicidade.
- Interface mobile-first em `public/index.html` (Minhas visitas, Equipe, Reprogramações, Auditoria, Configurações).

## Variáveis
`BITRIX_WEBHOOK` (webhook de entrada, escopos crm, user, department, im, task) · `DATA_DIR` · `VIBE_APP_KEY` (identifica o usuário logado via gateway) · `EVENT_TOKEN` · `PORT`

## Premissas
Sem campo customizado de data na Fila (1036) / Registro (1032) o app usa `closedate` / `begindate`. Registrar visita de um cargo
não empurra os cards dos outros cargos (só mudança de classe/última visita feita no Bitrix recalcula).

`npm test` · deploy: `VIBE_APP_KEY=… SERVER_ID=… ./deploy.sh`
