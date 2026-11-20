# Página "Trabalhe conosco" (bloco HTML do Bitrix24 Sites)

Arquivo: `trabalhe-conosco.html` — **cole o conteúdo inteiro** em um bloco "Código HTML" da página.
Em `CFG` (no topo do `<script>`) ajuste só: `API` (endereço do app de RH) e `POLITICA` (link da Política de Privacidade).

A página mostra as **vagas abertas** (lidas do app a cada visita; vaga encerrada some sozinha) e a opção **Enviar currículo**.
Quem se candidata a uma vaga chega no app como "Vaga do RH" (prioridade); o currículo avulso entra como espontâneo.

## Como a página fala com o app
O navegador chama diretamente o endereço do app (`/public/vagas`, `/public/vagas/{codigo}`, `/public/candidaturas`).
Isso exige que o endereço do app esteja em modo **PÚBLICO** (política de acesso da Vibecode). O app continua protegido por dentro:
- `/api/*` (a área do RH) só responde a quem o Bitrix24 identifica; visitante anônimo recebe 401;
- o CORS só libera `originallocadora.com.br`, `www.originallocadora.com.br` e pré-visualizações `*.bitrix24.site` (env `SITE_ORIGINS` para mudar);
- limites: 5 envios/hora por e-mail, 60 candidaturas/min no total, campo-isca anti-robô, currículo conferido pelo conteúdo (PDF/DOC/DOCX até 3 MB);
- o servidor precisa ficar **ligado** (sem auto-sleep), senão a primeira visita após o sono pode falhar.

## Testar antes de publicar
`https://<endereço-do-app>/carreiras` mostra a mesma página servida pelo próprio app (também pode ser usada em iframe no site).
Parâmetros úteis: `?vaga=<codigo>` abre direto a candidatura daquela vaga; `utm_source/medium/campaign` são gravados na ficha.

## Cuidado ao editar o bloco (aprendido na prática)
O editor do Bitrix24 Sites **decodifica entidades HTML dentro do `<script>` ao salvar** (`&amp;`→`&`, `&quot;`→`"`, `&lt;`→`<`…).
Uma entidade escrita dentro de uma string de JavaScript vira aspas soltas e **quebra o script inteiro** (a página fica em "Carregando…").
Por isso o script usa `\uXXXX` no lugar de entidades; há um teste automático (`test/publico.test.js`) que falha se alguma entidade voltar.
Depois de colar o bloco: **Publicar** e abrir o endereço publicado (scripts não rodam no editor). Abra com `?debug=1` para ver o que a página está fazendo.
