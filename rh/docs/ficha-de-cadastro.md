# Ficha de cadastro do candidato — dados de entrada para o site de carreiras

Modelo inspirado nos grandes players (Gupy, Vagas.com, LinkedIn "candidatura simplificada"): **uma tela, ~1 minuto**.
Obrigatório = contato + área + **currículo OU LinkedIn** + aceite da LGPD. O resto é opcional e fica sob "Quer contar mais?".
Propositalmente **não** coletamos idade, sexo, raça, estado civil nem foto (evita viés/discriminação e reduz risco de LGPD).

## Envio (site → app)
`POST https://vibecode.bitrix24.com/v1/applications/cmwotbdkc00814bo6g4nsvnh1/api/public/candidaturas`
Cabeçalhos: `X-Api-Key: <chave de API externa do app>` e `Content-Type: application/json`.
Corpo máximo 4 MiB (currículo até **3 MB**, enviado em base64). Limite: 120 chamadas/min por chave.

Respostas: `201 {"success":true,"protocolo":"A1B2C3D4"}` · `422 {"error":"…","erros":{"email":"Informe um e-mail válido."}}` (mostre cada mensagem junto ao campo) · `429` muitas tentativas.
Reenviar o mesmo e-mail para a mesma vaga **atualiza** a ficha (não duplica).

## Vagas do site (RH cadastra, site exibe)
O RH cadastra e publica as vagas no app (aba **Vagas**). O site só **lê** as vagas abertas e envia a candidatura com o código da vaga.

- `GET https://vibecode.bitrix24.com/v1/applications/cmwotbdkc00814bo6g4nsvnh1/api/public/vagas` — lista só as **vagas abertas**: `codigo`, `titulo`, `area`, `cidade`, `tipoContrato`, `modelo`, `faixaSalarial` (vazia, a menos que o RH marque "mostrar no site"), `encerraEm` (AAAA-MM-DD), `descricao` (resumo).
- `GET …/api/public/vagas/{codigo}` — detalhe com `descricao` e `requisitos` completos. `404` se a vaga já fechou (mostre "vaga encerrada" e a lista de outras vagas).
- `POST …/api/public/candidaturas` com `"vaga": "<codigo>"` — a ficha segue o fluxo normal e o RH a enxerga como **"Vaga do RH"**, com prioridade na triagem (aparece primeiro e o prazo de cada etapa é metade).
- Se a vaga fechar entre o candidato abrir a página e enviar, volta `422` com `erros.vaga` (texto pronto para exibir). Sem o campo `vaga`, a candidatura é espontânea.

**A vaga sai do site sozinha** quando acontecer o que vier primeiro: o **prazo** termina (obrigatório para publicar, máx. 120 dias), o **limite de candidaturas** é atingido, ou as **posições** são preenchidas (candidatos marcados como *Contratado*). Também pode ser **agendada** para abrir numa data. O site nunca precisa "tirar" vaga: basta listar o que o endpoint devolve a cada visita (não faça cache longo).

## Campos
| Campo (JSON) | Rótulo | Obrigatório | Formato |
|---|---|---|---|
| `nome` | Nome completo | sim | 3–120 caracteres |
| `email` | E-mail | sim | e-mail válido |
| `telefone` | Celular / WhatsApp | sim | DDD + número (10 ou 11 dígitos; aceita +55) |
| `cidade` | Cidade | sim | até 80 |
| `uf` | Estado | sim | sigla (MG, SP…) |
| `area` | Área de interesse | sim | Operações e logística · Manutenção e mecânica · Comercial e vendas · Atendimento ao cliente · Administrativo · Financeiro e contábil · Recursos humanos · Tecnologia · Segurança do trabalho · Motorista e transporte · Outra |
| `curriculo` | Currículo | **um dos dois** | `{ "nome": "cv.pdf", "base64": "…" }` — PDF, DOC ou DOCX até 3 MB (tipo conferido pelo conteúdo) |
| `linkedin` | Perfil do LinkedIn | **um dos dois** | `linkedin.com/in/seu-perfil` |
| `consentimento` | Li e aceito a Política de Privacidade | sim | `true` (link para a política da Original) |
| `cargo` | Cargo / vaga de interesse | não | até 80 |
| `escolaridade` | Escolaridade | não | Fundamental · Médio · Técnico · Superior incompleto · Superior completo · Pós-graduação |
| `experiencia` | Tempo de experiência | não | Sem experiência · Até 1 ano · 1 a 3 anos · 3 a 5 anos · 5 a 10 anos · Mais de 10 anos |
| `disponibilidade` | Disponibilidade para início | não | Imediata · Em até 15 dias · Em até 30 dias · Mais de 30 dias |
| `modelo` | Modelo de trabalho | não | lista com Presencial · Híbrido · Remoto |
| `pretensao` | Pretensão salarial (R$) | não | número |
| `sobre` | Fale um pouco sobre você | não | até 600 caracteres |
| `portfolio` | Portfólio / site | não | URL |
| `pcd` | Pessoa com deficiência | não | `true/false`, voluntário |
| `origem` | Como conheceu a Original | não | Site da Original · LinkedIn · Indicação · Instagram · Outro |
| `vaga` | (oculto) código da vaga | não | vem da URL `?vaga=…` / da página da vaga; deve estar aberta |
| `utm` | (oculto) campanha | não | `{source, medium, campaign}` |
| `website` | (oculto) campo isca anti-robô | — | **deve ir vazio** |

## LinkedIn
Nesta fase o candidato **cola o link do perfil** (validado e padronizado para `https://www.linkedin.com/in/…`), como alternativa ao currículo.
Importar o perfil automaticamente ("Entrar com LinkedIn") exige um app registrado no LinkedIn e só devolve nome, e-mail e foto — não o histórico profissional —; fica como evolução.

## Como montar a página no site Bitrix24
1. Bloco HTML personalizado com o formulário (paleta Original: verde `#118042`, verde-claro `#5ecb71`, grafite `#34383b`).
2. Ler o arquivo com `FileReader.readAsDataURL` e enviar o resultado em `curriculo.base64` (o prefixo `data:` é aceito).
3. Enviar o JSON com `fetch` (POST) ao endereço acima. A chave externa fica visível no navegador: use uma **chave exclusiva do site** (e informe o id dela em `INTAKE_KEY_IDS` no deploy) para poder revogá-la sem afetar mais nada.
4. Exibir o `protocolo` na tela de confirmação.
