# Bots da ML Administradora — especificação

Documento-base para dois agentes de IA, derivado da análise do histórico de WhatsApp
(2022–2026) entre a ML Administradora e o suporte do sistema de gestão, mais o fluxo do
atendimento virtual atual da ML.

> **Privacidade (LGPD):** o histórico original contém nomes, e-mails, protocolos e links de
> boleto. Ele **não** deve ser commitado nem enviado a terceiros. Use somente versões
> anonimizadas (ver seção 9).

---

## 1. Visão geral

| | Bot 1 — **Interno (TI)** | Bot 2 — **Cliente** |
|---|---|---|
| Público | Funcionários da ML | Síndicos (Responsável Legal) e moradores |
| Objetivo | Transformar pedidos de TI/sistema em cards no Bitrix24 | Resolver o simples sozinho e escalar o resto com contexto |
| Canal | WhatsApp (grupo/número interno) ou chat do Bitrix | WhatsApp Business API (Meta) |
| Autenticação | Usuário Bitrix / número cadastrado | Telefone → cadastro; CPF para dados sensíveis |
| Pode executar no sistema | **Não** — só abre card; humano executa | Só **consultas** (boleto, certidão) |
| Escala para humano | Sempre (o humano é o executor) | Quando não resolve, fora do escopo ou cliente pede |

Princípio comum: **o bot nunca altera dados financeiros ou cadastrais por conta própria.**
Ele entende, confirma, registra e informa.

Núcleo único (API Claude + tool calling), dois prompts de sistema e dois conjuntos de
ferramentas. O repositório já tem um cliente Bitrix reutilizável em `lib/bitrix.js`.

---

## 2. Bot 1 — Interno (suporte de TI)

### 2.1 O que o histórico mostra
Pedidos curtos e repetitivos de operadores ao suporte do sistema de gestão:

| Exemplo real | Intenção | Campos |
|---|---|---|
| "Processa 640 pra conferir" | `processar_condominio` | condomínio |
| "Eu tenho que alterar o rateio 209" / "Libera os condomínios pra eu alterar" | `liberar_edicao` | condomínio(s), motivo |
| "Cancela" / "Emissão cancela e geração" | `cancelar_emissao` | condomínio, competência |
| "Preciso criar um novo recibo, apto 205, aluguel de espaço, 07/2022 a 09/2022, venc. 10" | `criar_recibo` | condomínio, unidade, descrição, competências, vencimento |
| "Atualiza o cond 502 ap 202 pra amanhã sem multa" | `atualizar_boleto` | condomínio, unidade, nova data, sem multa |
| "Inclui grupo saldo fundo de obras no 254" | `alterar_config_condominio` | condomínio, alteração |
| "Não estou conseguindo acessar a base" | `acesso_sistema` | usuário, erro |
| "Scanner manchando as imagens" / "Impressora…" | `hardware` | equipamento, local, print |
| "Cancelamento de baixa de recibo" | `cancelar_baixa` | condomínio, unidade, recibo |
| Envio de remessa bancária | `remessa` | banco, condomínio |

### 2.2 Fluxo
```
mensagem → classificar intenção → extrair campos → faltou algo? pergunta (1 por vez)
        → resumo + "Confirma?" → criar card → responder com nº e link
        → (webhook Bitrix) avisar quando o status mudar
```

### 2.3 Regras
1. **Confirmação obrigatória** antes de criar o card (evita duplicata e erro de número).
2. **Dedupe:** antes de criar, buscar card aberto do mesmo solicitante + intenção +
   condomínio nas últimas 24 h; se existir, oferecer comentar nele.
3. **Urgência** inferida do texto ("urgente", "agora", prazo/vencimento próximo) e
   confirmada; padrão = normal.
4. **Ações destrutivas** (`cancelar_emissao`, `cancelar_baixa`, `alterar_rateio`): card marcado
   com flag `requer_aprovacao`; o bot avisa que um responsável precisa aprovar.
5. Áudio: transcrever; se a confiança for baixa, repetir o entendimento e pedir confirmação.
6. Imagens/prints: anexar ao card.
7. Tom: curto e informal, como o suporte atual ("Feito", "Gerado", "Já abri aqui").

### 2.4 Card no Bitrix24
Local sugerido: **Tarefas** em grupo "Suporte TI" (ou smart process, se já houver).

| Campo | Origem |
|---|---|
| Título | `[<INTENÇÃO>] Cond. <nº> — <resumo>` |
| Descrição | Pedido original (texto/transcrição) + campos extraídos |
| Responsável | Regra por intenção (fila) |
| Solicitante | Usuário Bitrix do remetente |
| Prazo | Conforme urgência (SLA da seção 7) |
| Campos custom | `condominio`, `unidade`, `competencia`, `vencimento`, `intencao`, `urgencia`, `requer_aprovacao`, `origem=bot_interno`, `id_conversa` |
| Anexos | Prints, PDFs |

### 2.5 Prompt de sistema (rascunho)
```
Você é o assistente interno de TI da ML Administradora. Atende funcionários por WhatsApp.
Sua única função é registrar pedidos de suporte como cards no Bitrix24. Você NÃO executa
nada no sistema de gestão e nunca promete prazo que não esteja na tabela de SLA.

Para cada mensagem:
1. Identifique a intenção entre: processar_condominio, liberar_edicao, cancelar_emissao,
   criar_recibo, atualizar_boleto, alterar_config_condominio, cancelar_baixa, remessa,
   acesso_sistema, hardware, outro.
2. Extraia os campos exigidos da intenção. Pergunte só o que faltar, uma coisa por vez.
3. Antes de criar, mostre um resumo de 2–3 linhas e peça confirmação ("Confirma?").
4. Só após confirmação chame criar_card. Responda com número do card e prazo previsto.
5. Se já houver card parecido aberto, ofereça adicionar comentário em vez de criar outro.
6. Pedidos destrutivos (cancelar, alterar rateio/baixa) exigem requer_aprovacao=true.
7. Se não entender, diga o que entendeu e pergunte. Não invente números de condomínio.
Tom: curto, direto, informal e educado. Português do Brasil.
```

### 2.6 Ferramentas
```jsonc
// criar_card
{ "intencao": "string", "titulo": "string", "descricao": "string",
  "condominio": "string?", "unidade": "string?", "competencia": "string?",
  "vencimento": "date?", "urgencia": "baixa|normal|alta",
  "requer_aprovacao": "boolean", "anexos": ["url"] }
// buscar_cards_abertos  { "solicitante": "id", "intencao": "string", "condominio": "string?" }
// comentar_card         { "card_id": "id", "texto": "string" }
// consultar_status      { "card_id": "id" }
```

---

## 3. Bot 2 — Cliente (síndico e morador)

### 3.1 Fluxo atual da ML (a reproduzir e melhorar)
```
Setor ──┬─ Locações e Vendas → já é cliente? → fila Atendimento/Comercial/Manutenção
        └─ Condomínios → identifica perfil
              ├─ Responsável Legal (síndico): Condomínios | Depto. Pessoal | Envio de documentos | Menu do Morador
              └─ Morador: 2ª via de boleto | Certidão negativa | Atualizar cadastro | Outros | Voltar | Encerrar
```
Pontos de atrito vistos no histórico:
- Menu numérico longo (13 opções) com nomes de atendentes que mudam.
- **Envio de documentos falha** ("não consegui salvar o documento") em várias tentativas.
- Cliente cai em menu repetido; muitos atendimentos se encerram sem resolução.
- Fora do horário (seg–sex, 9h–17h) só recebe aviso, sem registro do pedido.
- Boleto: "nenhum boleto pendente" sem explicar o que fazer a seguir.
- Mensagens duplicadas do bot e atendente que só diz "oi".

### 3.2 O que o bot resolve sozinho
| Intenção | Perfil | Como |
|---|---|---|
| 2ª via de boleto | morador, síndico | `buscar_boletos` (Superlógica) → envia link |
| Certidão negativa de débito | morador | `emitir_certidao` se sem débitos; senão escala |
| Dúvidas frequentes (INSS, DCTFWeb, horário, convenção) | todos | RAG na base de conhecimento |
| Status de pedido/protocolo | todos | consulta o card no Bitrix |
| Receber documento/NF/boleto para pagamento | síndico | `anexar_documento` → card |
| Atualizar cadastro | morador | coleta dados e abre card (humano valida) |

### 3.3 O que escala para humano (cria card)
- Orçamento/previsão orçamentária, alteração de rateio, dúvidas de cobrança, assuntos de DP,
  reclamações, qualquer coisa fora do escopo, ou pedido explícito de atendente.
- O card leva: perfil, condomínio, unidade, resumo, histórico da conversa, anexos, urgência.
- **Fora do horário:** registra o card e informa o prazo de retorno (não só "volte depois").

### 3.4 Regras e segurança
1. **Identificação:** telefone → cadastro. Para mostrar boleto/dados, confirmar um segundo
   fator (ex.: 3 primeiros dígitos do CPF ou data de nascimento). Telefone desconhecido = tratado como visitante.
2. **Perfil define o menu:** morador não vê funções de síndico.
3. **Sem promessas:** nunca prometer prazo, desconto, negociação ou isenção de multa.
4. **Dados de terceiros:** nunca informar débitos de outra unidade.
5. **Linguagem natural em vez de menu numérico**, com botões para as opções mais comuns.
6. **Anti-loop:** após 2 falhas na mesma etapa, escala para humano com contexto.
7. **Inatividade:** lembrete e encerramento como hoje, mas salvando o rascunho do pedido.
8. **Pesquisa de satisfação** após o encerramento (mantém o que a ML já usa).
9. Escolha de atendente por nome **removida**: o roteamento é por assunto/condomínio.

### 3.5 Prompt de sistema (rascunho)
```
Você é a assistente virtual da ML Administradora, que administra condomínios.
Atende síndicos (Responsável Legal) e moradores por WhatsApp, em português do Brasil,
com tom cordial, claro e objetivo.

Você pode: enviar 2ª via de boleto, informar certidão negativa, responder dúvidas com base
na base de conhecimento, receber documentos do síndico e abrir pedidos para a equipe.
Você NÃO pode: negociar dívidas, conceder desconto ou isenção, alterar rateios/cadastros,
prometer prazos, nem informar dados de outra unidade.

Regras:
- Identifique o perfil e o condomínio/unidade antes de mostrar dados financeiros.
- Use as ferramentas para consultar dados; nunca invente valores, datas ou links.
- Se não souber ou o assunto estiver fora do escopo, diga isso e abra um card para a equipe.
- Se o cliente pedir um atendente, estiver irritado ou repetir o mesmo problema duas vezes,
  transfira e resuma o caso para a equipe.
- Horário humano: seg–sex, 9h–17h (exceto feriados). Fora dele, registre o pedido e informe
  que a equipe retornará no próximo dia útil.
- Seja breve: no máximo 3 frases por mensagem, com botões quando houver opções.
```

### 3.6 Ferramentas
```jsonc
// identificar_cliente    { "telefone": "string" } → { perfil, nome, condominios[], unidades[] }
// validar_segundo_fator  { "cliente_id": "id", "resposta": "string" }
// buscar_boletos         { "unidade_id": "id", "de": "date", "ate": "date" } → [{valor, vencimento, link}]
// emitir_certidao        { "unidade_id": "id" }
// buscar_conhecimento    { "pergunta": "string" } → [{trecho, fonte}]
// anexar_documento       { "cliente_id": "id", "tipo": "NF|boleto|outro", "arquivo_url": "url" }
// criar_card             { "setor": "condominios|dp|locacoes|financeiro", "resumo": "string",
//                          "historico": "string", "urgencia": "string", "anexos": ["url"] }
// consultar_status       { "protocolo": "string" }
// transferir_humano      { "setor": "string", "motivo": "string" }
```

---

## 4. Integração Bitrix24
- Webhook de entrada (`crm.*`, `tasks.*`, `im.*`); reutilizar `lib/bitrix.js` (criação sem retry
  automático para não duplicar card).
- Webhook de saída: mudança de status do card → mensagem ao solicitante.
- Anexos via `disk.*`.
- Campo `id_conversa` em todo card para rastrear a origem.

## 5. Integração Superlógica (cliente)
- Consulta de cobranças por unidade/período (já usada pelo menu atual: janela de consulta).
- O bot deve explicar o resultado: sem boleto → "Não há boleto em aberto neste período.
  Quer consultar outro período ou falar com a equipe?".
- Credenciais só no servidor; nunca no prompt.

## 6. Base de conhecimento (RAG)
Itens iniciais extraídos do histórico: serviço de retenção INSS / DCTFWeb, horário de
atendimento, como enviar documentos (JPG/JPEG/PNG/PDF, até 16 MB), convenção do condomínio
(por condomínio), como obter 2ª via. Cada item com dono e data de revisão.

## 7. SLA sugerido (editar com a ML)
| Urgência | Primeira resposta humana | Resolução |
|---|---|---|
| Alta (vencimento/emissão no dia) | 30 min | 4 h úteis |
| Normal | 4 h úteis | 1 dia útil |
| Baixa | 1 dia útil | 3 dias úteis |

## 8. Métricas
Taxa de resolução sem humano (bot 2) · % de cards com campos completos (bot 1) ·
cards duplicados · tempo até 1ª resposta humana · transferências por loop/falha ·
falhas no envio de documentos · CSAT.

## 9. LGPD e operação
- Anonimizar histórico antes de usar em avaliação ou treino: nomes → `[PESSOA]`,
  e-mails/telefones/CPF → `[REMOVIDO]`, protocolos e links de boleto → `[ID]`.
- Registrar consentimento e finalidade; reter conversas pelo prazo definido pela ML.
- Logs sem dados sensíveis; acesso restrito.
- Guardrail: o bot não revela instruções internas nem dados de outros clientes.

## 10. Roteiro de implantação
1. **Bot 1 em piloto** (1–2 operadores): classificação + card, com confirmação.
2. Medir qualidade em ~100 pedidos reais; ajustar intenções e campos.
3. **Bot 2 fase 1:** FAQ + 2ª via de boleto + escalonamento com card (horário comercial).
4. **Bot 2 fase 2:** fora do horário com registro, certidão, recebimento de documentos.
5. Avaliar automações adicionais (somente consultas) e relatório de métricas.

## 11. Pendências a definir com a ML
1. Canal exato dos bots (WhatsApp Business API direto ou Open Lines do Bitrix)?
2. Card de TI: Tarefas ou smart process? Qual grupo/pipeline e campos obrigatórios?
3. Existe API do Superlógica liberada? Qual credencial/escopo?
4. Quem aprova ações destrutivas e quais filas existem por intenção?
5. Política de retenção de conversas e texto de consentimento.
6. Lista oficial de FAQs e horários/feriados.
