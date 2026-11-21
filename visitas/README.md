# Registro de Visitas (Bitrix24 · Vibe+)

Aplicativo que mantém a **fila de visitas comerciais** (SPA 1036) e o **registro das visitas** (SPA 1032) por cliente, segmento e cargo.
Servidor Node 20 sem dependências, interface web em `public/`, estado em `/opt/data/state/state.json`. Nada de segredo no repositório.

## O ciclo
1. **Fila:** para cada cliente, segmento e cargo (a *Alçada* do card) com pessoa e classe no cadastro da empresa, existe um card na fila, com a data da próxima visita.
2. **Visita:** o vendedor clica em **Registrar**. O app cria (ou atualiza, se a automação já criou o modelo vazio) o registro no SPA 1032, ligado ao card pelo campo *ID Fila*.
3. **Etapa:** o card vai para **Finalizado**.
4. **Próximo ciclo:** o app cria o próximo card (mesmo cargo e responsável, data = visita + prazo da classe) e grava *Última* e *Próxima visita* na empresa.
5. **Tela:** lista, dashboard e registros atualizam na hora.
Registro preenchido direto no Bitrix também finaliza o card (reconciliação a cada 5 min com a fila ligada). **Registro vazio não conta como visita feita.**

## Regras principais
- Prazos: A 30 dias, B 60, C 90, E 6 meses, sempre em dia útil (sem fim de semana/feriado). Configurável.
- **Só aparece quem tem "Última visita" no cadastro da empresa** (por segmento). Exceções: cards já agendados para o futuro, admitidos por ação explícita; lista "Preencher Última visita".
- **Visibilidade:** cada responsável vê somente os próprios registros. Só quem está em *Quem vê tudo* vê todos (enquanto a lista estiver vazia, administradores do portal veem tudo).
- **O app nunca remove cards sozinho.** Só o botão Excluir (quem tem permissão) e a correção explícita de duplicados movem para Removido, e ambos são restauráveis.
- Etapas: o SPA pode ter só *Aguardando*, *Dia da Visita*, *Finalizado*, *Removido*. Sem *Atrasada* o atraso é calculado pela data; sem *Não realizada* o app não mexe em cards de meses passados.

## Campos
Tudo é descoberto pelo **rótulo** (empresa: `[Motores] Vendedor Responsável`, `Classe Motores`, `[Motores] Última Visita`...; Fila: Classe, **Alçada = cargo**, Data da visita (texto `dd/mm/aaaa hh:mm:ss`), Segmento, Usuário, ID Empresa; Registro: Fatos e dados..., ID Fila, Alçada...).
Se algum rótulo for diferente, ajuste em **Configurações → Campos usados pelo app**. Campos extras do SPA de registros aparecem no formulário e na tabela.

## Operação (Configurações)
- **Fila automática** liga/desliga o que roda sozinho: cria cards que faltam, muda a etapa pela data, reconcilia registros preenchidos. Use a **Prévia** antes de ligar.
- **Auditoria do processo** confere o ciclo (registro preenchido x card aberto, duplicados, ciclo quebrado, cards sem responsável...) e oferece correções seguras.
- **Desfazer remoções feitas pelo app** restaura, com prévia, cards que o próprio app moveu para Removido (nunca os removidos de propósito).
- **Diagnóstico das datas** mostra como estão Última/Próxima visita no cadastro.
- Tarefas longas rodam em segundo plano com acompanhamento de progresso.

## Deploy
```bash
export VIBE_APP_KEY=<chave-do-app> SERVER_ID=<id-do-servidor>
./deploy.sh        # opcionais: BITRIX_WEBHOOK, ATIVAR=1|0, PREPARAR=1, MANUTENCAO="restaurar=AAAA-MM-DD;duplicados;reconciliar;auditoria", CHANGELOG
```
O webhook também pode ser salvo em Configurações (arquivo 0600 no servidor, nunca devolvido ao navegador). O servidor deve ficar sempre ligado.

## Segurança
Identidade vinda do gateway; CSP sem script inline; limite de requisições por usuário; entradas validadas; rotas de administração restritas; ações de escrita nunca repetidas automaticamente.

## Testes
`npm test` (Bitrix simulado, incluindo o modelo real do portal: 4 etapas, data em texto, Alçada como cargo, vários cards por cliente).
