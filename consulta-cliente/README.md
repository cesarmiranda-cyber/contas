# Consulta de cliente (Bitrix24)

Tela simples: digita o nome → mostra **nome, responsável, negócios (total + último) e atividades (total + última)**.

## Como resolve o acesso
Quem consulta **não precisa de permissão no CRM**. O navegador chama só este app (`/api/consulta`); o **servidor** lê o CRM
pelo webhook de entrada (usuário com acesso) e devolve apenas o resumo acima — nada de telefone, valores totais, e-mails ou
histórico completo. O webhook nunca vai para o navegador.

- Só entra quem está logado no Bitrix24 (cabeçalho `X-Vibe-User-Id` do gateway da Vibecode; sem ele → 401).
- Somente leitura (`crm.*.list`, `user.get`, `batch`).
- Busca: empresas por parte do título; contatos por nome/sobrenome. Mostra até 15 resultados, mínimo 3 letras.
- Negócios do cliente = `COMPANY_ID`/`CONTACT_ID`; última atividade considera as do cadastro **e** as dos negócios dele.

## Webhook
Crie um webhook de entrada com **somente** os escopos `crm` e `user`, de um usuário que enxergue todos os cadastros.
Guarde em `BITRIX_WEBHOOK` (variável de ambiente ou `.env`, que é ignorado pelo git). **Nunca** commite o endereço.

## Rodar / testar
```bash
BITRIX_WEBHOOK='https://SEU.bitrix24.com.br/rest/1/TOKEN/' AUTH_DISABLED=1 node server.js   # AUTH_DISABLED só em desenvolvimento
npm test
```

## Publicar como app local do Bitrix24
Hospede como o app *Contas a Receber* deste repositório (`../deploy.sh`, ajustando os arquivos: `server.js lib.js package.json public`),
e cadastre a URL em Aplicativos → Desenvolvedores → Aplicativo local (somente interface). Libere os usuários que vão consultar na política de acesso do servidor.
