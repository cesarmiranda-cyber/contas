# Projetos M4 — Área de Projetos e Suporte (portal do cliente Manda4)

Portal em que a equipe (usuários do Bitrix24) gerencia projetos e o cliente acompanha só o que é dele.
Node >= 20, sem dependências. `npm start` · `npm test` · `./deploy.sh` (veja as variáveis no topo do script; `PUBLIC_URL` = endereço público do app).

- **Equipe**: abre o app dentro do Bitrix24; a identidade vem dos cabeçalhos do gateway Vibecode (`X-Vibe-User-Id` numérico). Administrador = papel `ADMIN` do Bitrix24.
- **Cliente**: cria conta no portal (e-mail + senha, `scrypt`, sessão em cookie assinado). Só vê projetos em que a equipe o vinculou ("Ativar acesso"). Sem vínculo: "Aguardando ativação".
- **Projeto**: código, tipo, prioridade, cliente contratante, prazos, escopo, valor/observações internas (o cliente não vê), atividades com dependências (termina→começa, começa junto), Gantt com status verde/amarelo/vermelho.
- **Precisamos de você**: a equipe marca uma atividade como "aguardando o cliente" com um pedido; aparece no início do cliente e no Gantt.
- **Suporte**: o chamado do cliente vira um card (negócio) no funil de suporte do Bitrix24.

## Integração com o funil de suporte (Bitrix24)
1. No Bitrix24 crie um **webhook de entrada** com permissão em CRM.
2. No app: **Integração** (somente administradores) → cole o webhook → "Conectar e carregar funis" → escolha funil e etapa inicial → salvar.
3. O webhook fica em `DATA_DIR/secrets.json` (0600) e nunca volta ao navegador. Só aceita hosts `*.bitrix24.*` (ou `ALLOWED_BITRIX_HOSTS`).

O card leva protocolo, cliente, empresa, e-mail, telefone, projeto, categoria, prioridade, assunto e descrição. O contato é criado/reaproveitado pelo e-mail.
Mensagens e anexos do chamado viram comentários na linha do tempo do card (anexo = link assinado, válido por 30 dias). A etapa do card volta ao portal (consulta a cada 2 min e ao abrir Suporte, no máx. 1/min). Etapa de sucesso = chamado concluído (libera a avaliação do cliente).
Falha ou webhook ausente: o chamado fica na fila e é reenviado (até 8 vezes) ou pelo botão "Reenviar ao Bitrix24". Criar o card é idempotente (procura o protocolo antes).

## Dados
`DATA_DIR` (padrão `./data`): `db.json` (JSON atômico), `files/`, `secret` (assinatura de sessões/links), `secrets.json`. Faça backup desse diretório.
