# Hub de Clientes (Bitrix24)

Hub com várias funções para gerir clientes. Primeira função: **Registro de Cliente**.

## Registro de Cliente
Funil **Negócios · categoria 0** (clientes em contrato ativo). Cada card é um cliente e a etapa é o mês de uso: **Mês 0 … Mês 12**, mais *Assinado* e *CANCELADOS*.

- **Registro mensal obrigatório**: para cada cliente e mês registra-se *reunião realizada*, *só contato* ou *sem contato* (com motivo), data, canal, participantes, resumo, próximos passos, saúde (verde/amarelo/vermelho), intenção de renovar e próximo contato. Salvar de novo no mesmo mês atualiza.
- **Fica no card**: cada registro vira um comentário na linha do tempo do negócio no Bitrix24 (e o histórico completo fica no app).
- **Situação do mês**: *Reunião feita*, *Só contato*, *Sem contato*, *Pendente* (até o dia 19) e *Atrasado* (a partir do dia 20 ou meses anteriores sem registro).
- **Telas**: Dashboard (cobertura de contato, % de reuniões, por etapa, por responsável, saúde, série de 6 meses, alertas), Kanban por etapa e Lista; navegação por mês.
- **Ciclo de 12 meses**: o app sugere *avançar de mês* (30+ dias na etapa) e, no Mês 12, *decidir*: **Renovou → Mês 0** ou **Cancelar → CANCELADOS**. Mover é sempre uma ação manual com confirmação (muda a etapa do negócio e comenta no card).
- Nome do cliente = empresa do card; sem empresa, o contato (cards de "Script de venda recorrente" usam o contato).

## Técnico
Node ≥ 20 sem dependências. Lê/escreve o CRM pela API Vibecode (`/v1/deals`, `/statuses`, `/companies`, `/contacts`, `/users`, `/timelines`) com a chave `VIBE_KEY`. Registros ficam em `DATA_DIR/registros.json`. Acesso: só com a identidade do gateway (`X-Vibe-User-Id`).
Variáveis: `VIBE_KEY` · `DATA_DIR` · `PORT` · `CATEGORY_ID` (0) · `PORTAL_HOST`.
`npm test` · deploy: `VIBE_KEY=… SERVER_ID=… ./deploy.sh`.
