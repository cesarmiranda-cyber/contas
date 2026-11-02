# Financeiro Nutrimix (Bitrix24 + Asaas) — mapa do app

**Tela inicial em `/`**: depois do login, dois cartões — **Contas** (o financeiro, em `/financeiro.html`) e **Processos de negócios** (`/processos.html`, lista de processos; o primeiro será o **BK**).

| Grupo | Menu | Para que serve |
|---|---|---|
| **Visão geral** | Painel | Duas páginas: **Visão financeira** e **Contratos** (indicadores, vencimentos por mês, situação, maiores clientes, responsáveis, cobranças geradas, pendências de cadastro e tabela, tudo com filtro cruzado). Painel estilo BI: período, filtros e visuais clicáveis com filtro cruzado (clique em um mês, categoria, cliente, fornecedor ou conta e todo o painel se ajusta), indicadores que abrem a lista correspondente e tabela dos lançamentos do filtro |
| **Receitas** | A receber · Emitir cobranças · Contratos | Títulos (funil do Bitrix + manuais), ações no Asaas (emitir, lembrar, receber em dinheiro, estornar), nova cobrança/assinatura/link, **gerar cobranças do contrato**, aviso de vencimento |
| **Despesas** | A pagar · Notas de entrada · Contas fixas | Lançamentos com parcelas e anotações, **importação de XML de NF-e** (títulos + estoque), recorrências sem fim |
| **Tesouraria** | Fluxo de caixa · Bancos e contas · Conciliação | Projeção por empresa/conta, saldos, extrato, transferências, conciliação por OFX |
| **Estoque e pessoas** | Estoque · Folha de pagamento | Saldo e custo médio, movimentos; lançamento mensal da folha |
| **Análise** | Relatórios | Central de relatórios (a receber, a pagar, DRE, fluxo, inadimplência, extrato, folha, estoque, notas) com CSV |
| **Administração** | Cadastros · Configurações | **Cadastros** (dados mestres): empresas, contas bancárias, fornecedores, funcionários, produtos, plano de contas, centros de custo. **Configurações** (regras): integrações (Bitrix, Asaas, split), formas e condições de pagamento, cobrança e automações, contratos, rotinas, atividades (auditoria) |

**Gerar cobranças do contrato (funil 15)**: na tela do contrato, informe valor, parcelas, 1º vencimento e forma. O app cria os títulos no funil de cobranças (herdando cliente, responsável, empresa e “minha empresa” do contrato) — eles aparecem em A receber — e, se marcado, emite no Asaas em seguida. Uma vez por contrato.

# Contas a Receber (Bitrix24 funil 90 + Asaas)

Cada deal do funil **Contas** (categoria 90) é um título a receber (uma parcela/cobrança).
O app emite a cobrança no Asaas, concilia o status e move a deal entre as etapas:
Em aberto → Próximo do vencimento → Atrasado → Pago / Cancelado.

- **Régua de cobrança**: grava o gatilho (D-3, D0, D+1, D+5, D+15) na deal e na linha do tempo; um robô do Bitrix envia e-mail/WhatsApp. Desligada por padrão.
- **Pendências**: deals sem cliente, valor, vencimento, CPF/CNPJ, cobrança emitida, valor divergente do Asaas, vencidas fora da etapa certa.
- **Gerar parcelas**: cria N deals (parcelado, à vista ou recorrente mensal) no funil.
- Campos criados na deal: `UF_CRM_CR_*` (não usa os campos `ASAAS_*`/`M4A_*` do app já instalado).

## Financeiro multiempresa (`/financeiro.html`)
- **Empresas**: cadastro com CNPJ e **chave do Asaas própria** (sandbox/produção, com teste); sem chave usa a conta padrão. A empresa de cada deal vem do campo de lista **CR · Empresa** (criado/atualizado no Bitrix pelo botão *Atualizar campo no Bitrix*; vale para os funis 90 e 15).
- **A receber**: cobranças do funil 90 (sincronizadas com o Asaas) + recebimentos manuais, filtrados por empresa.
- **A pagar**: contas com parcelas, forma (Pix, boleto, cartão, transferência, dinheiro), categoria, baixa e cancelamento. *Pagar pelo Asaas* (boleto por linha digitável / Pix) só com confirmação explícita — movimenta dinheiro real.
- **Folha**: funcionários (salário bruto, descontos, benefícios e encargos informados à mão). A folha da competência vira contas a pagar (salário líquido, benefícios, encargos) com vencimento no mês seguinte, automaticamente todo mês (idempotente); identificadas como *Folha*.
- **Fluxo de caixa**: realizado + previsto por mês, saldo acumulado a partir do saldo inicial da empresa, alerta de caixa negativo.
- **Contratos (funil 15)**: contratos ativos com vencimento (campo configurável; padrão = data de fechamento), cliente da empresa/contato do Bitrix e parcelas do cliente. O responsável da deal recebe notificação no Bitrix nos marcos de 60/30/15/7/0 dias e se vencer (cada marco uma vez). Dentro da deal use `/financeiro.html?deal=ID`: só contrato e cliente.
- **Relatórios**: a receber, a pagar e folha, com período, CSV e impressão. **Painel**: indicadores, caixa projetado, despesas por categoria e alertas.
- **Configurações** (cadastros): contas bancárias (banco, agência, conta, saldo inicial, conta padrão), formas de pagamento (prazo de crédito em dias corridos/úteis e taxa), condições de pagamento (vencimentos automáticos: 30/60/90, entrada + parcelas…), categorias (plano de contas), centros de custo e fornecedores. Já vêm com padrões editáveis.
- **Lançamentos** (a pagar e a receber): título, anotações, categoria, centro de custo, forma, conta, parcelamento ou recorrência com vencimentos automáticos (dia útil opcional) e edição parcela a parcela (vencimento, valor, título e anotação). **Baixa** com juros, multa, desconto e baixa parcial (o saldo restante vira novo lançamento). Cartão/boleto: o fluxo de caixa usa a data de crédito prevista e o valor líquido.
- **Bancos e contas**: saldo por conta, extrato e transferências entre contas. **DRE** por categoria (regime de caixa ou competência).
- **Conciliação bancária**: importe o extrato OFX do banco; o app sugere o lançamento de cada linha (valor, data e nome), concilia sozinho o que bate exato, baixa na conta com a data e o valor do banco (diferença vira juros, desconto da taxa do cartão ou baixa parcial), cria lançamento para tarifas e rendimentos e permite desfazer. Confere o saldo do app com o do extrato.
- **Recorrências sem fim**: marque “Repetir todo mês” ao lançar; o app gera sozinho os próximos 3 meses, permite pausar, reajustar (inclusive as parcelas futuras) e encerrar.
- **Anexos** nos lançamentos (PDF, imagem, XML, planilha, Word, CSV, TXT até 8 MB; sempre baixados, nunca abertos no navegador). Ficam em `DATA_DIR/anexos`.
- **Importar XML da NF-e (contas a pagar)**: lê o XML do fornecedor (sem dependências, protegido contra XML malicioso), mostra o que vai ser lançado e confirma. Cria o fornecedor (se novo), os **títulos a pagar pelas duplicatas** (editáveis; ou por condição de pagamento), a **nota de entrada** com o XML original anexado e a **entrada no estoque** a custo de aquisição (produto − desconto + frete + seguro + outras + IPI + ICMS-ST, com o que está só no cabeçalho rateado). Sugere a empresa pelo CNPJ do destinatário, barra nota já importada (pela chave de acesso) e vincula o código do fornecedor ao produto para as próximas notas. Cancelar a nota estorna títulos e estoque (bloqueia se algum título foi pago ou o estoque já foi consumido).
- **Estoque**: produtos por empresa, saldo e **custo médio móvel**, saída/ajuste/entrada avulsa (nunca deixa o saldo negativo), estoque mínimo e histórico.
- API em `/api/fin/*`; dados em `DATA_DIR/financeiro.json`; chaves por empresa em `secrets.json` (0600).
- Menu do Bitrix: registre o app (menu / aba da deal) apontando para `/financeiro.html` e `/financeiro.html?deal=#ID#`.

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


## Segurança (revisão)
- Sem login próprio: o acesso é controlado pela plataforma (servidor com acesso restrito a usuários nomeados). Dentro do app não há perfis.
- **CSRF**: pedidos que alteram dados exigem `application/json` e são recusados quando o navegador indica que vieram de outro site (`Sec-Fetch-Site`).
- **Cabeçalhos**: `Content-Security-Policy` (só o próprio site; o app só pode ser embutido em domínios Bitrix24), `X-Content-Type-Options`, `Referrer-Policy`.
- **XSS**: todo texto vindo do Bitrix/Asaas/XML/OFX é escapado; links externos só `http(s)`.
- **XML (NF-e)**: leitor próprio que recusa `<!ENTITY>`/DOCTYPE e limita tamanho e profundidade. **OFX** com limite de tamanho e linhas.
- **Anexos**: tipos permitidos por extensão, 8 MB, nome sanitizado, guardados por id aleatório e sempre baixados (nunca abertos no navegador).
- **SSRF**: o webhook do Bitrix só aceita `https`, sem usuário/porta e sem endereços internos.
- Chaves do Asaas e o webhook ficam em `secrets.json` (0600) e nunca voltam inteiros para a tela.

## Dados de demonstração
Configurações → Demonstração carrega 2 empresas fictícias com histórico (todos os processos) e remove tudo depois. Nada vai ao Bitrix/Asaas; as empresas demo não entram no campo “CR · Empresa”.


## Controle de acesso
- **Nada é público**: toda a API exige login (só `/health` responde sem). As páginas HTML são apenas o código da tela; antes do login não mostram nem consultam dado algum.
- Usuários e senhas do próprio app (`DATA_DIR/usuarios.json`, 0600). Senha com scrypt + sal; mínimo de 10 caracteres com letras e números; bloqueio de 15 min após 5 erros; limite de tentativas por IP; sessão assinada de 10 h (renova sozinha), derrubada na hora ao trocar a senha, desativar ou rebaixar o usuário.
- **Perfis**: Administrador (tudo, inclusive usuários, integrações, chaves, empresas, configurações e atividades), Financeiro (opera; não administra) e Somente consulta (só lê). Gestão em Contas → Configurações → Usuários e acessos.
- **Administrador inicial**: vem do ambiente do servidor — `ADMIN_USER` e `ADMIN_HASH` (hash scrypt, nunca a senha) — e é obrigado a trocar a senha no 1º acesso. Sem essas variáveis e sem usuários, ninguém entra. Recuperação: novo `ADMIN_HASH` + novo valor em `ADMIN_RESET` no deploy.
- Para gerar o hash: `node -e "require('./lib/auth').hashSenha(process.argv[1]).then(console.log)" 'SenhaProvisoria123'`.


## Processos de negócios → BK

`/processos.html` lista os processos; o primeiro é o **BK** (`/bk.html`, API `/api/bk/*`, dados em `bk.json`):

- **Unidades, RT e licença**: cadastro por BKN (CNPJ, RT/CRN, licença e validade, previsão de virada), importação por CSV (Excel → Salvar como CSV; colunas reconhecidas pelo título), situação e pendências calculadas.
- **Alertas**: notificação no Bitrix ao responsável (por unidade ou padrão) nos marcos configurados (60/30/15/7/0 dias e vencido) para licença, RT, virada e prazo de protocolo; cada marco só uma vez; rotina horária.
- **Esteira de protocolos**: aguardando → enviado → reenviado → em análise → aguarda licença → deferido / desligado, com histórico e prazo.
- **Medição mensal**: gera um título em A Receber por unidade ativa (valor da unidade ou padrão), uma vez por competência; pode ser desfeita enquanto os títulos estiverem em aberto.
- Dados de demonstração fictícios em Configurações do BK.

## Login com Bitrix24

- Abrindo o app pelo menu do Bitrix24, o portal envia `AUTH_ID`/`DOMAIN` por POST; o servidor confirma o token no próprio portal (`user.current`, só para o domínio do webhook conectado) e abre a sessão.
- Fora do Bitrix24, o botão "Entrar com Bitrix24" usa OAuth (tela de login do Bitrix24). Requer um aplicativo local no portal; Client ID/Secret em Configurações → Usuários e acessos, com a URL de retorno `<endereço do app>/auth/bitrix/callback`.
- Em ambos os casos só entra quem o administrador liberou (Configurações → Usuários e acessos → Liberar usuário do Bitrix24), com um perfil. Usuário e senha ficam para o administrador.

## Processos de negócios → Cronograma (Assessoria Recorrente / RT)

`/cronograma.html`, API `/api/cron/*`, dados em `cron.json`; ligado ao funil **Assessoria Recorrente / RT** (categoria 6).
- **Clientes** vêm do cadastro de empresas do Bitrix24 (`crm.company`), vinculados sem duplicar; o BK usa a mesma origem (`/api/bk/empresas`, vínculo por CNPJ completo e único, criação no Bitrix24 só depois de checar CNPJ/nome iguais).
- **Consultoras** são usuários do Bitrix24 (perfil “Consultora (cronograma)”: só vê e altera a própria agenda; sem acesso ao financeiro).
- **Feriados** por cidade/UF do cliente: nacionais calculados (Páscoa, Carnaval e Corpus Christi como facultativos), estaduais e municipais de uma tabela interna, mais os cadastrados à mão. Ao gerar a semana, visita em feriado vai para o próximo dia útil; nas existentes há aviso e remarcação em um clique.
- **Funil**: “Sincronizar com o funil” cria um negócio por cliente vinculado (consultora como responsável), sem duplicar os que já existem; mostra a simulação antes de criar. Visita realizada ou que não aconteceu vira comentário no negócio.
- Carga inicial (uma vez): semanas de outubro/2026 importadas do PDF, de `seed/cron-outubro.json` (fora do repositório).
- **Vínculos do cliente**: cada cliente do cronograma liga *empresa* (`crm.company`), *contato* (`crm.contact` da empresa) e *negócio* (funil Assessoria Recorrente / RT); o contato vai no negócio criado pela sincronização.
- **Lista de conferência mensal** (aba “Conferência mensal”): consultora, horas, frequência e semanas marcadas por estabelecimento e mês; carga inicial de maio a outubro/2026 em `seed/cron-conferencia.json` (fora do repositório). Cada linha abre/edita no painel lateral e leva ao cliente com os vínculos.
