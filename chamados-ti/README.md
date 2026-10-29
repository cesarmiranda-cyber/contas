# Portal de Chamados de TI (Bitrix24 SPA "Portal TI" · entityTypeId 1074)

Usuários abrem e acompanham chamados; cada chamado vira um item do SPA (funil padrão, etapa inicial "Iniciar"), visível no kanban do Bitrix24.

- `server.js` — API + estáticos (Node ≥ 20, sem dependências). Env: `VIBE_API_KEY` (obrigatória), `SPA_TYPE_ID` (1074), `PORT`.
- `setup.js` — cria, de forma idempotente, os campos do SPA: Solicitante, E-mail, Setor, Categoria, Prioridade e Descrição (`UF_CRM_19_TI_*`).
- `deploy.sh` — publica no servidor Vibe (`VIBE_API_KEY` e `SERVER_ID`).
- A situação exibida em "Meus chamados" é a etapa do item no kanban; a equipe de TI atende movendo o card.
