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

## Registro de alterações (auditoria)
- Cada alteração grava **quem, quando, o quê e de → para** (datas, andamento, responsável, dependências, dados do projeto, acesso de clientes, chamados) e também os acessos do cliente (abriu projeto/atividade/Suporte, downloads, login). Atividades reagendadas por dependência ganham um registro próprio com o motivo.
- **Aba Histórico** em cada projeto: a equipe vê tudo (com filtros); o cliente vê só o que mudou no cronograma e nos dados públicos e o que foi enviado — nunca atividades internas, valor, observações internas, acessos ou a lista de clientes.
- **Acessos e log** (equipe): filtros por projeto, perfil, categoria, período e busca; exporta CSV (protegido contra fórmulas do Excel).
- Os registros ficam em `db.json` (últimos 20 mil) e em `DATA_DIR/auditoria.jsonl` (append-only, nunca apagado).

## Gantt (equipe)
Arrastar o bloco move as datas; as pontas mudam início/término; arrastar do círculo de uma atividade até outra cria a dependência (círculo do fim = termina→começa; círculo do início = começam juntas); clicar na seta altera a defasagem, troca o tipo ou remove. As atividades seguintes só são empurradas para frente.

## Dados
`DATA_DIR` (padrão `./data`): `db.json` (JSON atômico), `files/`, `secret` (assinatura de sessões/links), `secrets.json`. Faça backup desse diretório.

## Segurança do portal do cliente

- **Senha**: mínimo de 8 caracteres com letra, número e caractere especial. A tela de cadastro e a troca de senha mostram os requisitos ao vivo; o servidor valida do mesmo jeito (`lib/auth.js`, `validarSenha`).
- **Sessão**: 40 minutos desde o login, sem renovação. O cookie expira junto (HttpOnly, Secure, SameSite=Lax), o token é assinado com validade e sair (ou trocar a senha) revoga o cookie anterior. A tela avisa 2 minutos antes e desconecta sozinha.
- **Bloqueio**: 3 senhas erradas bloqueiam o acesso até a equipe liberar (Clientes → “Liberar acesso”). Para e-mails sem conta a resposta é idêntica, sem revelar quem é cliente. Há também um limite por endereço (30 logins e 10 cadastros por janela). Em testes use `SEM_LIMITE_IP=1`.
- **Esqueci a senha**: a equipe gera uma senha provisória (Clientes → “Nova senha”), exibida uma vez; o cliente é obrigado a trocá-la antes de usar o portal.
- **Visibilidade**: o cliente só vê o que a equipe marcar. Atividades novas (e as criadas por modelo) nascem **ocultas**; marque “Visível ao cliente” ou use “Mostrar ao cliente” no projeto. Comentários e anexos têm “Só a equipe vê”. O histórico antigo de atividade oculta também some para o cliente.
- Cabeçalhos: HSTS, CSP (sem objetos, `base-uri` e `form-action` fechados), Permissions-Policy, COOP e `nosniff`.
