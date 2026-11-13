'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm4-')); process.env.INSECURE_COOKIE = '1'; process.env.PUBLIC_URL = 'https://app.example.com';
const { server, store } = require('../server');
let base; test.before(() => new Promise(ok => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; ok(); })));
test.after(() => { server.close(); store.flush(); });
const EQ = { 'x-vibe-user-id': '7', 'x-vibe-user-name-encoded': 'Ana%20Souza', 'x-vibe-user-role': 'ADMIN' };
const call = async (m, u, body, headers = {}) => { const r = await fetch(base + u, { method: m, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})), c: r.headers.get('set-cookie') }; };

test('fluxo completo equipe x clientes', async () => {
  const c1 = await call('POST', '/api/auth/cadastro', { nome: 'Cli Um', email: 'um@x.com', senha: 'senha1234' }), c2 = await call('POST', '/api/auth/cadastro', { nome: 'Cli Dois', email: 'dois@x.com', senha: 'senha1234' });
  assert.strictEqual(c1.s, 201); const k1 = { cookie: c1.c.split(';')[0] }, k2 = { cookie: c2.c.split(';')[0] };
  assert.strictEqual((await call('POST', '/api/auth/cadastro', { nome: 'x', email: 'um@x.com', senha: 'senha1234' })).s, 409);
  assert.strictEqual((await call('POST', '/api/projetos', { nome: 'P' }, k1)).s, 403); // cliente não cria projeto
  const clientes = (await call('GET', '/api/clientes', null, EQ)).j.clientes; const id1 = clientes.find(c => c.email === 'um@x.com').id;
  assert.strictEqual((await call('GET', '/api/painel', null, EQ)).j.aguardando, 2); // ninguém vinculado ainda
  const p = (await call('POST', '/api/projetos', { nome: 'Implantação Bitrix' }, EQ)).j.projeto;
  await call('PATCH', '/api/projetos/' + p.id, { clientes: [id1] }, EQ);
  assert.strictEqual((await call('GET', '/api/painel', null, EQ)).j.aguardando, 1);
  const a = await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Levantamento', inicio: '2026-01-05', fim: '2026-01-09' }, EQ);
  const b = await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Configuração', inicio: '2026-01-06', fim: '2026-01-08', deps: [{ de: a.j.tarefa, tipo: 'FS', lag: 0 }] }, EQ);
  assert.deepStrictEqual(b.j.reagendadas, [b.j.tarefa]);
  await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Reunião interna', inicio: '2026-01-05', fim: '2026-01-05', interna: true }, EQ);
  assert.strictEqual((await call('PATCH', '/api/tarefas/' + a.j.tarefa, { deps: [{ de: b.j.tarefa }] }, EQ)).s, 400); // ciclo
  const v1 = (await call('GET', '/api/projetos/' + p.id, null, k1)).j.projeto; assert.strictEqual(v1.tarefas.length, 2); assert.strictEqual(v1.tarefas.find(t => t.nome === 'Configuração').inicio, '2026-01-10');
  assert.strictEqual((await call('GET', '/api/projetos/' + p.id, null, k2)).s, 404); assert.strictEqual((await call('GET', '/api/projetos', null, k2)).j.projetos.length, 0);
  assert.strictEqual((await call('GET', `/api/tarefas/${a.j.tarefa}/itens`, null, k2)).s, 404);
  const up = await call('POST', `/api/tarefas/${a.j.tarefa}/itens`, { texto: 'Segue contrato', arquivo: { nome: 'c.txt', base64: Buffer.from('oi').toString('base64') } }, k1); assert.strictEqual(up.s, 201);
  const it = (await call('GET', `/api/tarefas/${a.j.tarefa}/itens`, null, EQ)).j.itens[0]; const dl = await fetch(base + '/api/arquivos/' + it.arquivo.id, { headers: k1 }); assert.strictEqual(await dl.text(), 'oi');
  assert.strictEqual((await fetch(base + '/api/arquivos/' + it.arquivo.id, { headers: k2 })).status, 404);
  assert.ok((await call('GET', '/api/logs', null, EQ)).j.logs.some(l => l.acao === 'enviou_arquivo'));
  assert.strictEqual((await call('GET', '/api/logs', null, k1)).s, 403);
  assert.strictEqual((await call('GET', '/api/projetos')).s, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 'um@x.com', senha: 'errada' })).s, 401);
  assert.strictEqual((await call('GET', '/api/projetos', null, { 'x-vibe-user-id': 'share:abc' })).s, 401); // id não numérico não é equipe
});

test('campos do projeto: validação, código automático e campos internos ocultos ao cliente', async () => {
  const c = await call('POST', '/api/auth/cadastro', { nome: 'Cli Tres', email: 'tres@x.com', senha: 'senha1234' }); const k = { cookie: c.c.split(';')[0] };
  const id = (await call('GET', '/api/clientes', null, EQ)).j.clientes.find(x => x.email === 'tres@x.com').id;
  assert.strictEqual((await call('POST', '/api/projetos', { nome: 'X', link: 'javascript:alert(1)' }, EQ)).s, 400);
  assert.strictEqual((await call('POST', '/api/projetos', { nome: 'X', inicioPrevisto: '2026-05-10', fimPrevisto: '2026-05-01' }, EQ)).s, 400);
  assert.strictEqual((await call('POST', '/api/projetos', { nome: 'X', tipo: 'Inexistente' }, EQ)).s, 400);
  assert.strictEqual((await call('POST', '/api/projetos', { nome: 'X', negocioBitrix: 'abc' }, EQ)).s, 400);
  const r = await call('POST', '/api/projetos', { nome: 'Projeto Completo', tipo: 'Implantação Bitrix24', prioridade: 'alta', empresa: 'Acme', contatoNome: 'Maria', contatoEmail: 'm@acme.com', inicioPrevisto: '2026-01-05', fimPrevisto: '2026-01-20', valor: '12500.50', negocioBitrix: '321', link: 'https://drive.example.com/p', obsInternas: 'margem apertada', descricao: 'Escopo' }, EQ);
  assert.strictEqual(r.s, 201); const p = r.j.projeto; assert.match(p.codigo, /^PRJ-\d{4}$/); assert.strictEqual(p.valor, 12500.5);
  assert.strictEqual((await call('POST', '/api/projetos', { nome: 'Dup', codigo: p.codigo }, EQ)).s, 409);
  await call('PATCH', '/api/projetos/' + p.id, { clientes: [id] }, EQ);
  await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'T', inicio: '2026-01-05', fim: '2026-01-25' }, EQ);
  const eq = (await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto, cli = (await call('GET', '/api/projetos/' + p.id, null, k)).j.projeto;
  assert.strictEqual(eq.valor, 12500.5); assert.strictEqual(eq.obsInternas, 'margem apertada'); assert.strictEqual(eq.desvioDias, 5); assert.notStrictEqual(eq.resumo.cor, 'verde'); // previsão além do prazo contratado (com datas antigas a atividade também está atrasada)
  for (const campo of ['valor', 'obsInternas', 'negocioBitrix']) assert.ok(!(campo in cli), campo + ' vazou para o cliente');
  assert.strictEqual(cli.empresa, 'Acme'); assert.strictEqual(cli.link, 'https://drive.example.com/p');
  assert.strictEqual((await call('PATCH', '/api/projetos/' + p.id, { fimPrevisto: '2025-01-01' }, EQ)).s, 400); // antes do início
  assert.strictEqual((await call('PATCH', '/api/projetos/' + p.id, { prioridade: 'baixa' }, EQ)).j.projeto.prioridade, 'baixa');
});

// ---------- Bitrix24 simulado ----------
const { suporte, bitrix } = require('../server');
let SEQ = 500; // IDs de card únicos entre testes
function fakeBitrix() {
  const f = { deals: [], contatos: [], comentarios: [], etapaDe: {}, chamadas: [], falhar: null };
  bitrix.call = async (m, p) => {
    f.chamadas.push([m, p]); if (f.falhar) throw Object.assign(new Error(f.falhar), { rede: true });
    if (m === 'crm.category.list') return { result: { categories: [{ id: 5, name: 'Suporte' }] } };
    if (m === 'crm.status.list') return { result: [{ STATUS_ID: 'C5:NEW', NAME: 'Novo chamado' }, { STATUS_ID: 'C5:PROGRESS', NAME: 'Em atendimento', SEMANTICS: 'P' }, { STATUS_ID: 'C5:WON', NAME: 'Resolvido', SEMANTICS: 'S' }, { STATUS_ID: 'C5:LOSE', NAME: 'Cancelado', SEMANTICS: 'F' }] };
    if (m === 'crm.contact.list') return { result: f.contatos.filter(c => c.EMAIL[0].VALUE === p.filter.EMAIL).map(c => ({ ID: c.ID })) };
    if (m === 'crm.contact.add') { const c = { ID: 100 + f.contatos.length, ...p.fields }; f.contatos.push(c); return { result: c.ID }; }
    if (m === 'crm.deal.list' && p.filter.ID) return { result: p.filter.ID.map(id => ({ ID: id, STAGE_ID: f.etapaDe[id] || 'C5:NEW' })) };
    if (m === 'crm.deal.list') { const t = p.filter['%TITLE']; return { result: f.deals.filter(d => d.TITLE.includes(t)).map(d => ({ ID: d.ID })) }; }
    if (m === 'crm.deal.add') { const d = { ID: SEQ++, ...p.fields }; f.deals.push(d); return { result: d.ID }; }
    if (m === 'crm.timeline.comment.add') { f.comentarios.push(p.fields); return { result: 1 }; }
    throw new Error('método inesperado ' + m);
  };
  return f;
}
const MEMBRO = { ...EQ, 'x-vibe-user-role': 'MEMBER' };
const aguarda = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } return fn(); };

test('chamado de suporte vira card no funil: configuração, conteúdo, idempotência, erro e reenvio', async () => {
  const f = fakeBitrix();
  const c = await call('POST', '/api/auth/cadastro', { nome: 'Joana Lima', email: 'joana@acme.com', senha: 'senha1234', empresa: 'Acme' }); const k = { cookie: c.c.split(';')[0] };
  // permissões da configuração
  assert.strictEqual((await call('GET', '/api/config/suporte', null, k)).s, 403);
  assert.strictEqual((await call('GET', '/api/config/suporte', null, MEMBRO)).s, 403);
  assert.strictEqual((await call('POST', '/api/config/suporte/testar', { webhook: 'https://evil.example.com/rest/1/x/' }, EQ)).s, 400); // só portais Bitrix24
  // 1) chamado antes de configurar: fica na fila
  const r = await call('POST', '/api/solicitacoes', { assunto: 'Erro ao <b>entrar</b>', texto: 'Aparece <script>alert(1)</script>\nlinha 2', categoria: 'problema', prioridade: 'alta', telefone: '(11) 99999-1111' }, k);
  assert.strictEqual(r.s, 201); assert.match(r.j.protocolo, /^SUP-\d{4}$/);
  const lista = () => db().solicitacoes.find(s => s.protocolo === r.j.protocolo); const db = () => require('../server').store.db;
  await aguarda(() => lista().bitrix.status === 'nao_configurado'); assert.strictEqual(lista().bitrix.status, 'nao_configurado'); assert.strictEqual(f.deals.length, 0);
  // 2) admin escolhe webhook, funil e etapa
  const t = await call('POST', '/api/config/suporte/testar', { webhook: 'https://portal.bitrix24.com.br/rest/1/abc123/' }, EQ);
  assert.strictEqual(t.s, 200); assert.strictEqual(t.j.funis.find(x => x.id === 5).etapas[0].id, 'C5:NEW');
  const salvo = await call('POST', '/api/config/suporte', { webhook: 'https://portal.bitrix24.com.br/rest/1/abc123/', categoriaId: 5, estagioId: 'C5:NEW', funilNome: 'Suporte', etapaNome: 'Novo chamado' }, EQ);
  assert.strictEqual(salvo.s, 200); assert.strictEqual(salvo.j.reenviados, 1); assert.strictEqual(salvo.j.dica, '••••c123'); // só o final do código
  assert.ok(!JSON.stringify(salvo.j).includes('abc123/rest')); assert.ok(!JSON.stringify((await call('GET', '/api/config/suporte', null, EQ)).j).includes('https://portal'));
  // 3) conteúdo do card
  assert.strictEqual(f.deals.length, 1); const d = f.deals[0];
  assert.strictEqual(d.CATEGORY_ID, 5); assert.strictEqual(d.STAGE_ID, 'C5:NEW'); assert.match(d.TITLE, new RegExp(`^\\[${r.j.protocolo}\\]\\[Alta\\] Erro ao`)); assert.match(d.TITLE, /Joana Lima \(Acme\)/);
  for (const trecho of ['Joana Lima', 'joana@acme.com', '(11) 99999-1111', 'Acme', 'Problema / erro', 'Alta', 'Geral (sem projeto)', 'linha 2']) assert.ok(d.COMMENTS.includes(trecho), trecho + ' faltando no card');
  assert.ok(!d.COMMENTS.includes('<script>') && d.COMMENTS.includes('&lt;script&gt;')); assert.ok(d.COMMENTS.includes('<br>')); // escapado, com quebra de linha
  assert.strictEqual(f.contatos.length, 1); assert.strictEqual(d.CONTACT_ID, f.contatos[0].ID); assert.strictEqual(f.contatos[0].PHONE[0].VALUE, '(11) 99999-1111');
  assert.strictEqual(lista().bitrix.status, 'enviado'); assert.strictEqual(lista().bitrix.dealId, d.ID);
  // 4) idempotente: reenviar não duplica o card
  await suporte.enviar(lista()); assert.strictEqual(f.deals.length, 1);
  // 5) o cliente não vê detalhes do Bitrix24; a equipe vê o link do card
  const vc = (await call('GET', '/api/solicitacoes', null, k)).j.solicitacoes[0]; assert.ok(!('bitrix' in vc)); assert.strictEqual(vc.protocolo, r.j.protocolo);
  const ve = (await call('GET', '/api/solicitacoes', null, EQ)).j.solicitacoes.find(x => x.protocolo === r.j.protocolo); assert.strictEqual(ve.bitrix.url, `https://portal.bitrix24.com.br/crm/deal/details/${d.ID}/`);
  // 6) Bitrix24 fora do ar: o chamado não se perde e é reenviado depois
  f.falhar = 'Bitrix24 indisponível (ECONNRESET).';
  const r2 = await call('POST', '/api/solicitacoes', { assunto: 'Segundo', texto: 'texto', categoria: 'duvida' }, k);
  const s2 = () => db().solicitacoes.find(s => s.protocolo === r2.j.protocolo); await aguarda(() => s2().bitrix.status === 'erro');
  assert.strictEqual(s2().bitrix.status, 'erro'); assert.strictEqual(s2().bitrix.tentativas, 1); assert.strictEqual(f.deals.length, 1);
  f.falhar = null; assert.strictEqual(await suporte.processarPendentes(), 1); assert.strictEqual(s2().bitrix.status, 'enviado'); assert.strictEqual(f.deals.length, 2);
  // validações do formulário
  assert.strictEqual((await call('POST', '/api/solicitacoes', { assunto: 'x', texto: 'y', categoria: 'inexistente' }, k)).s, 400);
  assert.strictEqual((await call('POST', '/api/solicitacoes', { assunto: '', texto: 'y' }, k)).s, 400);
});

test('ativação do cliente: aguardando → vinculado → removido → bloqueado', async () => {
  const c = await call('POST', '/api/auth/cadastro', { nome: 'Pedro Alves', email: 'pedro@x.com', senha: 'senha1234' }); const k = { cookie: c.c.split(';')[0] };
  const lista = async () => (await call('GET', '/api/clientes', null, EQ)).j.clientes; const cli = (await lista()).find(x => x.email === 'pedro@x.com');
  assert.strictEqual(cli.projetoIds.length, 0); assert.strictEqual((await call('GET', '/api/projetos', null, k)).j.projetos.length, 0); // aguardando ativação
  const p1 = (await call('POST', '/api/projetos', { nome: 'Projeto A' }, EQ)).j.projeto, p2 = (await call('POST', '/api/projetos', { nome: 'Projeto B' }, EQ)).j.projeto;
  assert.strictEqual((await call('POST', `/api/clientes/${cli.id}/projetos`, { projetos: [p1.id] }, k)).s, 403); // cliente não se ativa
  assert.strictEqual((await call('POST', `/api/clientes/${cli.id}/projetos`, { projetos: ['ffffffffffffffff'] }, EQ)).s, 400);
  assert.strictEqual((await call('POST', `/api/clientes/${cli.id}/projetos`, { projetos: [p1.id, p2.id] }, EQ)).s, 200);
  assert.deepStrictEqual((await call('GET', '/api/projetos', null, k)).j.projetos.map(p => p.nome).sort(), ['Projeto A', 'Projeto B']);
  await call('POST', `/api/clientes/${cli.id}/projetos`, { projetos: [p2.id] }, EQ); // tira o A
  assert.deepStrictEqual((await call('GET', '/api/projetos', null, k)).j.projetos.map(p => p.nome), ['Projeto B']); assert.strictEqual((await call('GET', '/api/projetos/' + p1.id, null, k)).s, 404);
  const novo = (await call('POST', '/api/projetos', { nome: 'Já com cliente', clientes: [cli.id] }, EQ)).j.projeto; assert.strictEqual(novo.clientes.length, 1); // criar projeto já vinculado
  assert.ok((await call('GET', '/api/logs', null, EQ)).j.logs.some(l => l.acao === 'alterou_acesso_cliente'));
  await call('PATCH', '/api/clientes/' + cli.id, { ativo: false }, EQ); assert.strictEqual((await call('GET', '/api/projetos', null, k)).s, 401); // bloqueado perde o acesso
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 'pedro@x.com', senha: 'senha1234' })).s, 401);
});

test('chamado: conversa, anexo com link assinado, etapa do card e avaliação', async () => {
  const f = fakeBitrix(); const Sch = require('../lib/schedule');
  const c = await call('POST', '/api/auth/cadastro', { nome: 'Rita Gomes', email: 'rita@x.com', senha: 'senha1234' }), o = await call('POST', '/api/auth/cadastro', { nome: 'Outro Cliente', email: 'outro@x.com', senha: 'senha1234' });
  const k = { cookie: c.c.split(';')[0] }, ko = { cookie: o.c.split(';')[0] };
  const r = await call('POST', '/api/solicitacoes', { assunto: 'Preciso de ajuda', texto: 'Detalhes', categoria: 'duvida' }, k); const db = () => require('../server').store.db; const sol = () => db().solicitacoes.find(s => s.protocolo === r.j.protocolo);
  await aguarda(() => sol().bitrix.status === 'enviado'); assert.strictEqual(sol().etapa.nome, 'Novo chamado'); const deal = sol().bitrix.dealId;
  // cliente complementa com anexo
  const m1 = await call('POST', `/api/solicitacoes/${sol().id}/mensagens`, { texto: 'Segue o contrato', arquivo: { nome: 'contrato.pdf', base64: Buffer.from('conteudo').toString('base64') } }, k); assert.strictEqual(m1.s, 201);
  await aguarda(() => f.comentarios.length === 1); const cm = f.comentarios[0]; assert.strictEqual(cm.ENTITY_ID, deal); assert.strictEqual(cm.ENTITY_TYPE, 'deal');
  assert.ok(cm.COMMENT.includes('Segue o contrato') && cm.COMMENT.includes('Anexo: contrato.pdf') && cm.COMMENT.includes(r.j.protocolo));
  const link = /https:\/\/app\.example\.com(\/api\/baixar\/[0-9a-f]+\?e=\d+&t=[0-9a-f]{64})/.exec(cm.COMMENT); assert.ok(link, 'link assinado no card');
  assert.strictEqual(await (await fetch(base + link[1])).text(), 'conteudo'); // equipe baixa pelo card, sem login
  assert.strictEqual((await fetch(base + link[1].replace(/t=[0-9a-f]/, 't=0'))).status, 403); // assinatura adulterada
  assert.strictEqual((await fetch(base + link[1].replace(/e=\d+/, 'e=1'))).status, 403); // validade alterada
  const arqId = /baixar\/([0-9a-f]+)/.exec(link[1])[1]; assert.strictEqual((await fetch(base + '/api/arquivos/' + arqId, { headers: ko })).status, 404); assert.strictEqual((await fetch(base + '/api/arquivos/' + arqId, { headers: k })).status, 200);
  assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/mensagens`, { texto: 'invasor' }, ko)).s, 404); assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/mensagens`, { texto: '' }, k)).s, 400);
  // equipe responde: cliente vê, status sai de "nova"
  assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/mensagens`, { texto: 'Já estamos vendo' }, EQ)).s, 201);
  const v = (await call('GET', '/api/solicitacoes', null, k)).j.solicitacoes.find(x => x.protocolo === r.j.protocolo); assert.deepStrictEqual(v.mensagens.map(x => x.tipoAutor), ['cliente', 'equipe']); assert.strictEqual(v.mensagens[0].arquivo.nome, 'contrato.pdf'); assert.strictEqual(v.status, 'em_analise');
  // etapa do card no Bitrix24 chega ao cliente
  f.etapaDe[deal] = 'C5:PROGRESS'; assert.strictEqual(await suporte.sincronizar(), 1); assert.strictEqual(sol().etapa.nome, 'Em atendimento'); assert.strictEqual(await suporte.sincronizar(), 0);
  assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/avaliar`, { nota: 5 }, k)).s, 400); // ainda não concluído
  f.etapaDe[deal] = 'C5:WON'; assert.strictEqual(await suporte.sincronizar(), 1);
  const v2 = (await call('GET', '/api/solicitacoes', null, k)).j.solicitacoes.find(x => x.protocolo === r.j.protocolo); assert.strictEqual(v2.status, 'concluida'); assert.strictEqual(v2.etapa, 'Resolvido'); assert.strictEqual(v2.historico.length, 3); assert.ok(v2.podeAvaliar);
  assert.strictEqual(await suporte.sincronizar(), 0); const consultas = f.chamadas.filter(x => x[0] === 'crm.deal.list' && x[1].filter.ID); assert.ok(!consultas[consultas.length - 1][1].filter.ID.includes(deal)); // chamado encerrado não é mais consultado
  // avaliação
  assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/avaliar`, { nota: 9 }, k)).s, 400); assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/avaliar`, { nota: 5 }, ko)).s, 404); assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/avaliar`, { nota: 5 }, EQ)).s, 403);
  assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/avaliar`, { nota: 5, comentario: 'Excelente' }, k)).s, 201); assert.strictEqual((await call('POST', `/api/solicitacoes/${sol().id}/avaliar`, { nota: 4 }, k)).s, 409);
  await aguarda(() => f.comentarios.some(x => x.COMMENT.includes('Avaliação do cliente'))); assert.ok(f.comentarios.some(x => x.COMMENT.includes('5/5') && x.COMMENT.includes('Excelente')));
  assert.strictEqual((await call('GET', '/api/painel', null, EQ)).j.avaliacaoMedia, 5);
  assert.ok(Sch); });

test('início do cliente: pendências, o que está acontecendo e novidades', async () => {
  const Sch = require('../lib/schedule'); const h = Sch.hojeSP(); const d = n => Sch.addDays(h, n);
  const c = await call('POST', '/api/auth/cadastro', { nome: 'Lia Prado', email: 'lia@x.com', senha: 'senha1234' }), o = await call('POST', '/api/auth/cadastro', { nome: 'Sem Projeto', email: 'sem@x.com', senha: 'senha1234' });
  const k = { cookie: c.c.split(';')[0] }, ko = { cookie: o.c.split(';')[0] }; const id = (await call('GET', '/api/clientes', null, EQ)).j.clientes.find(x => x.email === 'lia@x.com').id;
  const p = (await call('POST', '/api/projetos', { nome: 'Projeto Lia', clientes: [id] }, EQ)).j.projeto;
  const t1 = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Enviar acessos', inicio: d(-2), fim: d(5), aguardaCliente: true, pedido: 'Envie a lista de usuários' }, EQ)).j.tarefa;
  await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Configurar CRM', inicio: d(-1), fim: d(8) }, EQ); await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Treinamento', inicio: d(6), fim: d(9) }, EQ);
  await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Reunião interna secreta', inicio: d(0), fim: d(0), interna: true, aguardaCliente: true, pedido: 'não deveria aparecer' }, EQ);
  const ini = (await call('GET', '/api/inicio', null, k)).j;
  assert.deepStrictEqual(ini.pendencias.map(x => x.tarefa), ['Enviar acessos']); assert.strictEqual(ini.pendencias[0].pedido, 'Envie a lista de usuários'); assert.strictEqual(ini.pendencias[0].respondidoEm, null);
  assert.deepStrictEqual(ini.agora.map(x => x.tarefa).sort(), ['Configurar CRM', 'Enviar acessos']); assert.deepStrictEqual(ini.proximas.map(x => x.tarefa), ['Treinamento']); assert.ok(!JSON.stringify(ini).includes('secreta'));
  assert.strictEqual((await call('GET', '/api/inicio', null, EQ)).s, 403);
  // cliente responde na atividade → equipe vê que foi respondido
  await call('POST', `/api/tarefas/${t1}/itens`, { texto: 'Lista enviada' }, k); assert.ok((await call('GET', '/api/inicio', null, k)).j.pendencias[0].respondidoEm);
  const tv = (await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto.tarefas.find(x => x.id === t1); assert.ok(tv.respondidoEm && tv.aguardaCliente);
  await call('PATCH', '/api/tarefas/' + t1, { aguardaCliente: false }, EQ); assert.strictEqual((await call('GET', '/api/inicio', null, k)).j.pendencias.length, 0);
  // novidades: só do próprio projeto, sem atividade interna, com contador de não lidas
  const nv = (await call('GET', '/api/novidades', null, k)).j; assert.ok(nv.novas > 0); const txt = nv.itens.map(x => x.texto).join('|');
  assert.ok(txt.includes('Nova atividade: Configurar CRM') && txt.includes('A equipe precisa de você em Enviar acessos')); assert.ok(!txt.includes('secreta'));
  assert.strictEqual((await call('GET', '/api/novidades', null, ko)).j.itens.length, 0); assert.strictEqual((await call('GET', '/api/novidades', null, EQ)).s, 403);
  await call('POST', '/api/novidades/lido', {}, k); assert.strictEqual((await call('GET', '/api/novidades', null, k)).j.novas, 0);
});
