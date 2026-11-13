# Hub do Escritório

Tela inicial (hub) para o cliente escolher a ferramenta que vai usar. O primeiro módulo é o **Validador de Cadastro**.

## Validador de Cadastro
- **Novo cadastro (3 passos):** digita o CNPJ → valida os dígitos → consulta a Receita Federal (BrasilAPI, com ReceitaWS de reserva) e preenche razão social, nome, situação cadastral, CNAE, porte, natureza jurídica, abertura, endereço, telefone e e-mail → vincula contatos → revisão → grava no Bitrix24.
- **Contatos:** cadastra novo (com CPF validado), **vincula um contato já existente** ou adiciona com um toque os **sócios/administradores** retornados pela Receita.
- **Anti-duplicidade:** se o CNPJ já existe no Bitrix24, o app avisa e leva ao cadastro existente. Todo o conteúdo é validado antes de gravar (um CPF inválido não deixa empresa órfã); falha parcial em contatos é relatada ao final.
- **Clientes (consulta):** busca por nome, razão social ou CNPJ; gaveta com dados, situação, contatos; vincular/desvincular contatos; abrir no Bitrix24.
- Alerta visível quando a situação cadastral não é "Ativa" (suspensa, inapta, baixada…).

## Dados no Bitrix24
Entidades **Empresa** e **Contato** (API Vibe `/v1/companies`, `/v1/contacts`). O app **não cria campos**: localiza pelo nome de exibição os campos que já existem no portal (CNPJ, Razão social, Situação cadastral, CNAE, Porte, Natureza jurídica, Data de abertura, Endereço; CPF no contato), preferindo os que não são `ufCrmHub*`. Campos que não existirem não são gravados e o app avisa. O formulário de edição mostra só os campos visíveis no layout do cartão (pessoal, senão comum), na ordem e por seção.

## Segurança
- A identidade vem do gateway da Vibecode (`X-Vibe-*`); o token da sessão nunca chega ao navegador. Sem identidade → 401.
- Escritas exigem o cabeçalho `X-Hub: 1` (anti-CSRF). A política de acesso do servidor não é alterada pelo deploy.
- `VIBE_APP_KEY` fica só no ambiente do servidor; nada de segredo no repositório.

## Rodar / testar / publicar
```bash
npm test                       # testes (sem dependências)
MOCK=1 npm start               # demonstração com CRM e Receita simulados
VIBE_APP_KEY=… SERVER_ID=… BITRIX_PORTAL=empresa.bitrix24.com.br ./deploy.sh
```
Variáveis do servidor: `VIBE_APP_KEY` (obrigatória), `BITRIX_PORTAL` (para o botão "Abrir no Bitrix24"), `VIBE_API_KEY` (opcional: chave pessoal para uso sem sessão), `PORT`.

## Estrutura
`server.js` (HTTP + rotas `/api/*`) · `lib/cnpj.js` (validação + Receita) · `lib/crm.js` (regras de empresas/contatos) · `lib/vibe.js` (cliente da API) · `lib/mock.js` (CRM/Receita simulados) · `public/` (interface) · `test/`.

Novos módulos entram como mais um cartão em `renderHub()` (`public/app.js`) + rotas em `server.js`.
