# Contas a Receber (Bitrix24 funil 90 + Asaas)

Cada deal do funil **Contas** (categoria 90) é um título a receber (uma parcela/cobrança).
O app emite a cobrança no Asaas, concilia o status e move a deal entre as etapas:
Em aberto → Próximo do vencimento → Atrasado → Pago / Cancelado.

- **Régua de cobrança**: grava o gatilho (D-3, D0, D+1, D+5, D+15) na deal e na linha do tempo; um robô do Bitrix envia e-mail/WhatsApp. Desligada por padrão.
- **Pendências**: deals sem cliente, valor, vencimento, CPF/CNPJ, cobrança emitida, valor divergente do Asaas, vencidas fora da etapa certa.
- **Gerar parcelas**: cria N deals (parcelado, à vista ou recorrente mensal) no funil.
- Campos criados na deal: `UF_CRM_CR_*` (não usa os campos `ASAAS_*`/`M4A_*` do app já instalado).

## Contas a pagar, parceiros e repasses
- **Parceiros/fornecedores** são empresas do Bitrix (tipo Parceiro/Fornecedor) com campos próprios (`UF_CRM_PAR_*`): walletId do Asaas, regra padrão (% ou R$), base (bruto/líquido), prazo de repasse, chave Pix e dados bancários.
- **Contas a pagar** vivem no funil **Contas a Pagar** (criado pelo app): Aguardando recebimento → A pagar → Vence em breve → Atrasado → Pago/Cancelado (`UF_CRM_CP_*`).
- **Ligação com o contas a receber:** o campo `CR · Split` de uma cobrança (ex.: `Parceiro A=30%; Parceiro B=R$ 50,00`) gera um título por parceiro, preso ao recebimento. Parceiro com walletId = split automático no Asaas (título só de registro; fecha quando o split é concluído); sem walletId = repasse manual (liberado quando o cliente paga, vence em recebimento + prazo). Cancelamento/estorno da cobrança cancela os repasses abertos.
- **Título consolidado:** em *Contas a pagar*, marque 2 ou mais títulos do mesmo parceiro/fornecedor e clique em **Gerar título consolidado** (vencimento, forma e Pix editáveis). Os títulos vão para a etapa *Em consolidado* (não somam duas vezes) e o consolidado guarda a lista (`CP_ITENS`). Clique em *Consolidado · N títulos · ver quais* para ver cliente/cobrança de origem, regra e valor de cada título; dá para remover um título, desfazer a consolidação ou registrar o pagamento (o valor pago é distribuído proporcionalmente entre os títulos).
- **E-mail detalhado:** do consolidado ou do extrato do parceiro, com prévia, Cc, mensagem e planilha CSV anexa. Configure o SMTP em *Configurações → E-mail (SMTP)* (Gmail/Microsoft 365 pedem senha de app); a senha fica só no servidor.
- Fluxo de caixa (entradas × saídas) e margem por venda no painel financeiro. O app **não movimenta dinheiro**: registra pagamentos feitos no banco.

## Estrutura de gestão (Receber × Pagar × Resultado)
- **Contas a receber** (funil Contas): vendas **com comissão** a parceiro, vendas **sem comissão** (100% Manda4) e **recebimentos manuais** (sem Asaas: Pix/TED direto, comissões recebidas de terceiros). Manual tem baixa à mão (*Receber*) e nunca emite cobrança.
- **Contas a pagar** (funil Contas a Pagar): **repasses** (nascem da venda com comissão, liberados quando o cliente paga) e **despesas** (sem parceiro/venda: aluguel, fornecedores, impostos, pessoas…). Dá para filtrar por tipo.
- **Resultado (DRE gerencial)** em `GET /api/gestao?mes=AAAA-MM&regime=caixa|competencia`: receita bruta (por origem) − taxas Asaas − comissões = **margem da Manda4** − despesas por categoria = **resultado**; evolução de 6 meses e posição de hoje. Cálculo em `lib/gestao.js` (consolidados não contam em dobro).

## Recorrências (pagar e receber)
- Despesas e recebimentos manuais podem repetir: semanal, quinzenal, mensal, bimestral, trimestral, semestral ou anual, **sem fim**, por **quantidade** ou até uma **data**. Mensal+ preserva o dia do mês (dia 31 cai no fim do mês, sem derrapar).
- A regra fica no app (`lib/recorrencia.js`); cada ocorrência é um título comum no Bitrix, marcado em `CP_RECOR`/`CR_RECOR`. O app mantém **12 meses à frente** e completa a cada sincronização, sem duplicar.
- Tela **Recorrências**: pausar/retomar, editar valor/descrição (vale para as futuras não pagas) e encerrar (opcionalmente cancelando as futuras). Cobranças pelo Asaas seguem em *Assinaturas*.

## Parcelas agrupadas e vínculo com cliente/venda
- Parcelamentos, assinaturas e recorrências aparecem em **uma linha** (cliente, “2 de 6 pagas”, barra de status, total e próxima data). Clique para abrir as parcelas; clique numa parcela para editar. O botão **Parcelas agrupadas** liga/desliga.
- O agrupamento usa `CR_GRUPO` (parcelamento/assinatura de origem no Asaas), preenchido nas novas cobranças e, uma vez, nas já importadas (*Mais ações → Organizar parcelas do Asaas* refaz sob demanda).
- **Vincular a cliente / venda**: em qualquer cobrança (ou grupo inteiro) escolha a empresa/contato do Bitrix e, opcionalmente, o negócio de venda (`CR_VENDA`). “Lembrar” grava o cliente do Asaas para as próximas importações.

## Painel financeiro
- **Geral** (aba *Dashboard* e gaveta lateral *Painel financeiro*) e **do cliente** (aba dentro da deal): nota de saúde 0–100 com as partes à mostra, previsão de recebimento (30/60/90 dias e por mês), recebido, atraso por faixa, maiores devedores, próximas cobranças, concentração e alertas.
- Cálculo em `lib/dashboard.js` (função pura, testada). Atrasos antigos pesam na nota e a limitam (máx. 84 com atraso > 60 dias, 69 > 90). Pagamento até 2 dias após o vencimento conta como no prazo.
- Gráficos em SVG com tooltip, tabela equivalente e paleta validada (daltonismo); janela de 3, 6 ou 12 meses.

## Cobrança completa (Asaas)
- **Nova cobrança**: avulsa, parcelada (parcelamento do Asaas), assinatura (ciclo, término, máximo de cobranças) e link de pagamento reutilizável; com forma (boleto/Pix/cartão/cliente escolhe), desconto, multa/juros e **split**.
- Cartão: o cliente paga na página segura do Asaas; o app nunca coleta dados de cartão.
- Link, boleto (PDF), linha digitável e Pix copia-e-cola ficam gravados na deal (`CR · Link/Boleto/Linha/Pix`) e o contrato guarda o link da próxima cobrança em aberto.
- **Ver cobrança**: detalhes, copiar link/Pix, split, receber em dinheiro e estornar. **Assinaturas**: listar, editar valor/vencimento/ciclo/forma, pausar e cancelar. **Links**: criar, copiar e remover.
- **Split**: cadastre recebedores (nome + walletId) em Configurações; na deal use o campo `CR · Split` (ex.: `Parceiro A=30%; Parceiro B=R$ 50,00`).

## Configurações (tela do app)
Chave do Asaas (sandbox/produção, com teste de conexão e confirmação para produção), webhook do Bitrix24, verificação de campos/etapas do funil e regras da automação/régua.
As credenciais salvas pelo painel ficam em `DATA_DIR/secrets.json` (modo 0600), têm prioridade sobre as variáveis de ambiente e nunca voltam inteiras ao navegador.

## Variáveis de ambiente (opcionais se usar a tela de Configurações)
`BITRIX_WEBHOOK` · `ASAAS_API_KEY` · `ASAAS_ENV=sandbox|production` · `DATA_DIR` · `SYNC_MINUTES` (10) · `PORT`

## Rodar / testar
`node server.js` · `npm test` (Node ≥ 20, sem dependências). Deploy: `./deploy.sh`.
