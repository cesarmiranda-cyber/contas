# RH · Original Locações

Portal de RH para Bitrix24 (Vibecode): **tela inicial por módulos**, **controle de acesso por usuário do Bitrix24** e o 1º módulo, **Recepção de currículos**.
Sem dependências (Node ≥ 20): `node server.js` · `npm test` · deploy: `./deploy.sh`.

- **Acesso** (`lib/acl.js`): identidade vem do gateway (`X-Vibe-User-Id`, não forjável). Nega por padrão. *Administradores* configuram acessos e veem tudo; os demais só os módulos liberados, com nível *consulta* (ver) ou *gestor* (alterar/excluir). Usuários são buscados no Bitrix24 (`GET /v1/users`) e o servidor confere que o ID existe. Toda mudança de acesso e todo acesso a dado de candidato vai para a auditoria.
- **Canal externo**: o site envia a ficha por `POST /public/candidaturas` via API externa da Vibecode. Essa rota só responde ao canal externo; nenhuma outra rota atende esse canal. Ficha de campos em `docs/ficha-de-cadastro.md` (e na aba *Integração*).
- **Novo módulo**: incluir em `lib/modules.js` (status `ativo`), criar as rotas em `server.js` com `acl.exige(user, '<id>')`.
- Variáveis: `VIBE_APP_KEY`, `VIBE_APPLICATION_ID`, `DATA_DIR`, `INTAKE_KEY_IDS` (opcional), `PORT`.
