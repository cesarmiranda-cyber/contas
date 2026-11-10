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

## Publicar na sua instância AWS (Ubuntu)
Pré-requisitos: um **domínio** (ex.: `consulta.seudominio.com.br`) apontando para o IP da instância, e as portas **80 e 443** liberadas no Security Group
(a 22 só para o seu IP). O Bitrix24 só abre apps em HTTPS; o Caddy emite o certificado sozinho.

```bash
git clone <repo> && cd contas/consulta-cliente        # na instância
sudo ./deploy/setup.sh consulta.seudominio.com.br ipsis.bitrix24.com.br
```
O script instala Node e Caddy, cria o serviço `consulta` (systemd) e guarda o webhook em `/etc/consulta-cliente.env` (modo 600).

Depois, no Bitrix24: **Aplicativos → Recursos para desenvolvedores → Outro → Aplicativo local** (com servidor):
- URL do manipulador: `https://consulta.seudominio.com.br/`
- URL de instalação: `https://consulta.seudominio.com.br/install`
- Permissões: `crm`, `user` · deixe em "Usar somente API" **desmarcado**, para abrir a interface.

## Login
Ao abrir o app o Bitrix envia `AUTH_ID`/`DOMAIN`; o servidor confirma no portal (`profile`), aceita só o `PORTAL_DOMAIN` configurado e entrega um token assinado (12 h).
Acessar a URL direto, fora do Bitrix, não mostra nada. Quem abre o app precisa ter acesso a ele (Aplicativos → disponibilidade).
