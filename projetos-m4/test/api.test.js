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
  assert.strictEqual((await fetch(base + link[1].replace(/t=([0-9a-f])/, (m, c) => 't=' + (c === '0' ? '1' : '0')))).status, 403); // assinatura adulterada
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

test('datas: a API informa quais atividades foram reagendadas pelas dependências', async () => {
  const p = (await call('POST', '/api/projetos', { nome: 'Datas' }, EQ)).j.projeto;
  const a = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Primeira', inicio: '2030-01-07', fim: '2030-01-09' }, EQ)).j.tarefa;
  const r = await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Segunda', inicio: '2030-01-07', fim: '2030-01-08', deps: [{ de: a, tipo: 'FS' }] }, EQ);
  assert.deepStrictEqual(r.j.ajustes.map(x => [x.nome, x.inicio, x.fim]), [['Segunda', '2030-01-10', '2030-01-11']]); // a própria atividade foi empurrada: o usuário é avisado
  const m = await call('PATCH', '/api/tarefas/' + a, { inicio: '2030-01-14', fim: '2030-01-16' }, EQ); // mover a primeira empurra a segunda
  assert.deepStrictEqual(m.j.ajustes.map(x => [x.nome, x.inicio]), [['Segunda', '2030-01-17']]);
  const m2 = await call('PATCH', '/api/tarefas/' + r.j.tarefa, { inicio: '2030-01-18', fim: '2030-01-18' }, EQ); assert.deepStrictEqual(m2.j.ajustes, []); // datas válidas: nada a avisar
  assert.strictEqual((await call('PATCH', '/api/tarefas/' + a, { inicio: '2030-01-20', fim: '2030-01-19' }, EQ)).s, 400); // término antes do início
  const t = (await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto.tarefas; assert.strictEqual(t.find(x => x.id === a).inicio, '2030-01-14'); // erro não altera nada
});

test('registro de alterações: quem mudou o quê (de → para), visão do cliente e acessos', async () => {
  const fs2 = require('fs'); const Sch = require('../lib/schedule'); const d = n => Sch.addDays('2030-03-04', n);
  const c = await call('POST', '/api/auth/cadastro', { nome: 'Vera Lopes', email: 'vera@x.com', senha: 'senha1234' }); const k = { cookie: c.c.split(';')[0] };
  const cid = (await call('GET', '/api/clientes', null, EQ)).j.clientes.find(x => x.email === 'vera@x.com').id;
  const p = (await call('POST', '/api/projetos', { nome: 'Projeto Log', valor: 1000, clientes: [cid] }, EQ)).j.projeto;
  const A_ = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Levantar', inicio: d(0), fim: d(2) }, EQ)).j.tarefa;
  const B_ = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Configurar', inicio: d(3), fim: d(4), deps: [{ de: A_, tipo: 'FS' }] }, EQ)).j.tarefa;
  const I_ = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Reunião interna', inicio: d(0), fim: d(0), interna: true }, EQ)).j.tarefa;
  const hist = async (h) => (await call('GET', `/api/projetos/${p.id}/historico`, null, h)).j.itens;
  // editar datas e andamento → de → para; sucessora reagendada com motivo
  await call('PATCH', '/api/tarefas/' + A_, { inicio: d(5), fim: d(7), progresso: 30 }, EQ);
  let eq = await hist(EQ); const ed = eq.find(x => x.acao === 'editou_tarefa' && x.detalhe === 'Levantar');
  assert.deepStrictEqual(ed.diff.map(x => [x.campo, x.de, x.para]), [['Início', d(0), d(5)], ['Término', d(2), d(7)], ['Andamento', '0%', '30%']]); assert.strictEqual(ed.quem, 'Ana Souza'); assert.strictEqual(ed.uid, '7');
  const rg = eq.find(x => x.acao === 'reagendada_dependencia'); assert.strictEqual(rg.detalhe, 'Configurar'); assert.match(rg.motivo, /Levantar/); assert.deepStrictEqual(rg.diff.map(x => x.para), [d(8), d(9)]);
  // dependência criada/removida aparece com nomes
  await call('PATCH', '/api/tarefas/' + B_, { deps: [] }, EQ); eq = await hist(EQ); assert.ok(eq.some(x => x.detalhe === 'Configurar' && x.diff.some(y => y.campo === 'Dependências' && y.de.includes('Levantar') && y.para === '—')));
  await call('PATCH', '/api/tarefas/' + B_, { deps: [{ de: A_, tipo: 'SS', lag: 1 }] }, EQ); eq = await hist(EQ); assert.ok(eq.some(x => x.diff.some(y => y.campo === 'Dependências' && y.para.includes('começam juntas, +1d'))));
  // campos internos do projeto: a equipe vê, o cliente não
  await call('PATCH', '/api/projetos/' + p.id, { valor: 2500, obsInternas: 'margem baixa' }, EQ); await call('PATCH', '/api/projetos/' + p.id, { nome: 'Projeto Log 2', valor: 3000 }, EQ);
  eq = await hist(EQ); assert.ok(eq.some(x => x.acao === 'editou_projeto' && x.diff.some(y => y.campo === 'Valor do projeto' && y.para === 'R$ 2.500,00'.replace(/ /g, ' ')) || x.diff.some(y => y.campo === 'Observações internas')));
  // atividade interna: nada aparece para o cliente
  await call('PATCH', '/api/tarefas/' + I_, { fim: d(1), responsavel: 'Segredo' }, EQ);
  let cl = await hist(k); const txt = JSON.stringify(cl); for (const proibido of ['Reunião interna', 'Valor do projeto', 'margem', 'Segredo', 'uid', 'R$']) assert.ok(!txt.includes(proibido), `vazou para o cliente: ${proibido}`);
  assert.ok(cl.some(x => x.acao === 'editou_tarefa' && x.detalhe === 'Levantar')); assert.ok(cl.some(x => x.acao === 'editou_projeto' && x.diff.some(y => y.campo === 'Nome' && y.para === 'Projeto Log 2')));
  assert.ok(!cl.some(x => ['abriu_projeto', 'login', 'ativou_cliente', 'alterou_acesso_cliente'].includes(x.acao)));
  // atividade interna que passa a ser visível: o cliente vê como nova atividade
  await call('PATCH', '/api/tarefas/' + I_, { interna: false }, EQ); cl = await hist(k); assert.ok(cl.some(x => x.acao === 'criou_tarefa' && x.detalhe === 'Reunião interna'));
  // pedido ao cliente: registro, "respondeu" limpo ao pedir de novo (regressão)
  await call('PATCH', '/api/tarefas/' + A_, { aguardaCliente: true, pedido: 'Envie o contrato' }, EQ); assert.ok((await hist(k)).some(x => x.acao === 'pediu_cliente' && x.diff[0].para === 'Envie o contrato'));
  await call('POST', `/api/tarefas/${A_}/itens`, { texto: 'Segue' }, k); const tv = async () => (await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto.tarefas.find(x => x.id === A_);
  assert.ok((await tv()).respondidoEm); await call('PATCH', '/api/tarefas/' + A_, { aguardaCliente: false }, EQ); assert.strictEqual((await tv()).respondidoEm, null);
  await call('PATCH', '/api/tarefas/' + A_, { aguardaCliente: true, pedido: 'Agora o anexo' }, EQ); assert.strictEqual((await tv()).respondidoEm, null); // novo pedido começa sem "respondeu"
  // o que o cliente faz fica registrado para a equipe (sem repetir a cada recarga)
  await call('GET', '/api/projetos/' + p.id, null, k); await call('GET', '/api/projetos/' + p.id, null, k); await call('GET', `/api/tarefas/${A_}/itens`, null, k); await call('GET', `/api/tarefas/${A_}/itens`, null, k);
  const ac = (await call('GET', `/api/projetos/${p.id}/historico?cat=acessos`, null, EQ)).j.itens; assert.strictEqual(ac.filter(x => x.acao === 'abriu_projeto' && x.quem === 'Vera Lopes').length, 1); assert.strictEqual(ac.filter(x => x.acao === 'abriu_atividade' && x.detalhe === 'Levantar').length, 1);
  assert.ok((await hist(k)).some(x => x.acao === 'comentou' && x.quem === 'Vera Lopes')); // o que o cliente enviou ele mesmo vê
  // excluir atividade registra dependências afetadas
  await call('DELETE', '/api/tarefas/' + A_, null, EQ); eq = await hist(EQ); assert.ok(eq.some(x => x.acao === 'excluiu_tarefa' && x.detalhe === 'Levantar')); assert.ok(eq.some(x => x.acao === 'editou_tarefa' && x.detalhe === 'Configurar' && x.diff.some(y => y.campo === 'Dependências' && y.para === '—')));
  // tela de log da equipe: filtros, CSV, permissões e arquivo permanente
  const f = (qs) => call('GET', '/api/logs?' + qs, null, EQ);
  assert.ok((await f(`projeto=${p.id}&tipo=cliente&cat=acessos`)).j.logs.every(x => x.tipo === 'cliente' && x.categoria === 'acessos'));
  assert.ok((await f('q=Vera+Lopes')).j.logs.length > 0); assert.strictEqual((await f('q=naoexisteesseTermo')).j.logs.length, 0); assert.strictEqual((await call('GET', '/api/logs', null, k)).s, 403);
  await call('PATCH', '/api/projetos/' + p.id, { nome: '=HYPERLINK("x")' }, EQ);
  const csv = await fetch(base + `/api/logs.csv?projeto=${p.id}`, { headers: EQ }); assert.strictEqual(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); const bytes = Buffer.from(await csv.arrayBuffer()); assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); /* BOM p/ o Excel */ const ct = bytes.toString('utf8'); assert.ok(ct.includes('Data/hora;Quem')); assert.ok(ct.includes("'=HYPERLINK")); assert.ok(!/;=HYPERLINK/.test(ct));
  assert.strictEqual((await fetch(base + '/api/logs.csv', { headers: k })).status, 403);
  await new Promise(r => setTimeout(r, 150)); const arq = fs2.readFileSync(require('path').join(process.env.DATA_DIR, 'auditoria.jsonl'), 'utf8'); assert.ok(arq.includes('"acao":"editou_tarefa"') && arq.includes('"Início"'));
  assert.strictEqual((await call('GET', `/api/projetos/${p.id}/historico`)).s, 401);
});

test('excluir atividade e projeto funciona (DELETE sem corpo) e respeita permissões', async () => {
  const p = (await call('POST', '/api/projetos', { nome: 'Para excluir' }, EQ)).j.projeto;
  const t = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Tarefa', inicio: '2030-01-01', fim: '2030-01-02' }, EQ)).j.tarefa;
  assert.strictEqual((await fetch(base + '/api/tarefas/' + t, { method: 'DELETE', headers: EQ })).status, 200);
  assert.strictEqual((await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto.tarefas.length, 0);
  assert.strictEqual((await fetch(base + '/api/projetos/' + p.id, { method: 'DELETE', headers: MEMBRO })).status, 403); // só administrador
  assert.strictEqual((await fetch(base + '/api/projetos/' + p.id, { method: 'DELETE', headers: EQ })).status, 200);
  assert.strictEqual((await call('GET', '/api/projetos/' + p.id, null, EQ)).s, 404);
  assert.strictEqual((await fetch(base + '/api/projetos/' + p.id, { method: 'DELETE' })).status, 401); // anônimo
  assert.strictEqual((await fetch(base + '/api/tarefas/' + t, { method: 'DELETE', headers: { ...EQ, 'sec-fetch-site': 'cross-site' } })).status, 403); // outro site
});

test('cache: a página aponta para a versão atual dos arquivos e nunca é guardada', async () => {
  const idx = await fetch(base + '/'); const html = await idx.text(); assert.strictEqual(idx.headers.get('cache-control'), 'no-store');
  const v = (await (await fetch(base + '/api/versao')).json()).versao; assert.match(v, /^[0-9a-f]{8}$/); assert.ok(html.includes(`/app.js?v=${v}`) && html.includes(`/style.css?v=${v}`) && html.includes(`<meta name="versao" content="${v}">`)); assert.ok(!html.includes('__VERSAO__'));
  const js = await fetch(base + `/app.js?v=${v}`); assert.match(js.headers.get('cache-control'), /immutable/); // versão atual: pode guardar
  assert.match((await fetch(base + '/app.js?v=antiga')).headers.get('cache-control'), /no-cache/); assert.match((await fetch(base + '/style.css')).headers.get('cache-control'), /no-cache/); // versão desconhecida: sempre revalida
  assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
});

test('início do cliente (resumo de projetos e suporte), documentos do projeto e vez do chamado', async () => {
  const Sch = require('../lib/schedule'); const h = Sch.hojeSP(); const d = n => Sch.addDays(h, n);
  const c = await call('POST', '/api/auth/cadastro', { nome: 'Nina Reis', email: 'nina@x.com', senha: 'senha1234' }); const k = { cookie: c.c.split(';')[0] };
  const vazio = (await call('GET', '/api/inicio', null, k)).j; assert.strictEqual(vazio.projetos.total, 0); assert.strictEqual(vazio.suporte.total, 0); assert.strictEqual(vazio.projetos.proxima, null); // aguardando ativação
  const id = (await call('GET', '/api/clientes', null, EQ)).j.clientes.find(x => x.email === 'nina@x.com').id;
  const p1 = (await call('POST', '/api/projetos', { nome: 'Projeto N1', clientes: [id] }, EQ)).j.projeto; const p2 = (await call('POST', '/api/projetos', { nome: 'Projeto N2', clientes: [id] }, EQ)).j.projeto;
  const t1 = (await call('POST', `/api/projetos/${p1.id}/tarefas`, { nome: 'Entrega 1', inicio: d(-3), fim: d(4), progresso: 100 }, EQ)).j.tarefa; await call('POST', `/api/projetos/${p1.id}/tarefas`, { nome: 'Entrega 2', inicio: d(-2), fim: d(6), progresso: 20 }, EQ);
  const ti = (await call('POST', `/api/projetos/${p1.id}/tarefas`, { nome: 'Interna', inicio: d(-1), fim: d(1), interna: true }, EQ)).j.tarefa;
  const ini = (await call('GET', '/api/inicio', null, k)).j; assert.strictEqual(ini.projetos.total, 2); assert.strictEqual(ini.projetos.unicoId, null); assert.strictEqual(ini.projetos.proxima.tarefa, 'Entrega 2'); assert.ok(ini.projetos.proxima.fim === d(6) && !ini.projetos.proxima.atrasada);
  assert.strictEqual(ini.projetos.verde + ini.projetos.amarelo + ini.projetos.vermelho, 2); assert.ok(!JSON.stringify(ini).includes('Interna'));
  // documentos: do projeto, sem os de atividade interna para o cliente
  await call('POST', `/api/tarefas/${t1}/itens`, { texto: 'contrato', arquivo: { nome: 'contrato.pdf', base64: Buffer.from('x').toString('base64') } }, k); await call('POST', `/api/tarefas/${ti}/itens`, { texto: 'segredo', arquivo: { nome: 'interno.xlsx', base64: Buffer.from('y').toString('base64') } }, EQ);
  const dc = (await call('GET', `/api/projetos/${p1.id}/documentos`, null, k)).j.documentos; assert.deepStrictEqual(dc.map(x => [x.nome, x.tarefa, x.tipoAutor]), [['contrato.pdf', 'Entrega 1', 'cliente']]); assert.strictEqual((await call('GET', `/api/projetos/${p1.id}/documentos`, null, EQ)).j.documentos.length, 2);
  assert.strictEqual((await call('GET', `/api/projetos/${p2.id}/documentos`, null, k)).j.documentos.length, 0); assert.strictEqual((await call('GET', `/api/projetos/${p1.id}/documentos`)).s, 401);
  // chamado: de quem é a vez
  const r = await call('POST', '/api/solicitacoes', { assunto: 'Dúvida X', texto: 'texto', categoria: 'duvida' }, k); const lista = async (h) => (await call('GET', '/api/solicitacoes', null, h)).j.solicitacoes.find(x => x.protocolo === r.j.protocolo);
  let s = await lista(k); assert.ok(s.aberto); assert.strictEqual(s.vezDe, 'equipe'); assert.ok(s.atualizadoEm);
  await call('POST', `/api/solicitacoes/${s.id}/mensagens`, { texto: 'Pode enviar o print?' }, EQ); s = await lista(k); assert.strictEqual(s.vezDe, 'cliente'); assert.strictEqual((await call('GET', '/api/inicio', null, k)).j.suporte.aguardandoVoce, 1);
  await call('POST', `/api/solicitacoes/${s.id}/mensagens`, { texto: 'Segue' }, k); assert.strictEqual((await lista(k)).vezDe, 'equipe');
  await call('PATCH', '/api/solicitacoes/' + s.id, { status: 'concluida' }, EQ); s = await lista(k); assert.strictEqual(s.aberto, false); assert.strictEqual(s.vezDe, null); const sup = (await call('GET', '/api/inicio', null, k)).j.suporte; assert.strictEqual(sup.abertos, 0); assert.strictEqual(sup.total, 1); assert.strictEqual(sup.ultimo.protocolo, r.j.protocolo);
  assert.strictEqual((await call('GET', '/api/inicio', null, EQ)).s, 403);
});

test('permissões: o cliente não altera prazos, atividades nem projetos; só a equipe', async () => {
  const c = await call('POST', '/api/auth/cadastro', { nome: 'Cliente Curioso', email: 'curioso@x.com', senha: 'senha1234' }); const k = { cookie: c.c.split(';')[0] };
  const cid = (await call('GET', '/api/clientes', null, EQ)).j.clientes.find(x => x.email === 'curioso@x.com').id;
  const p = (await call('POST', '/api/projetos', { nome: 'Prazo protegido', clientes: [cid] }, EQ)).j.projeto;
  const t = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Entrega', inicio: '2031-01-05', fim: '2031-01-09' }, EQ)).j.tarefa;
  const antes = JSON.stringify((await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto.tarefas);
  const tentativas = [['PATCH', '/api/tarefas/' + t, { inicio: '2031-02-01', fim: '2031-02-05' }], ['PATCH', '/api/tarefas/' + t, { progresso: 100 }], ['PATCH', '/api/tarefas/' + t, { deps: [] }], ['POST', `/api/projetos/${p.id}/tarefas`, { nome: 'X', inicio: '2031-01-01', fim: '2031-01-02' }],
    ['DELETE', '/api/tarefas/' + t], ['PATCH', '/api/projetos/' + p.id, { fimPrevisto: '2031-12-01' }], ['PATCH', '/api/projetos/' + p.id, { clientes: [] }], ['DELETE', '/api/projetos/' + p.id], ['POST', `/api/clientes/${cid}/projetos`, { projetos: [] }]];
  for (const [m, u, b] of tentativas) { const r = m === 'DELETE' ? await fetch(base + u, { method: m, headers: k }) : await call(m, u, b, k); assert.strictEqual(r.status ?? r.s, 403, `${m} ${u} deveria ser 403 para o cliente`); }
  assert.strictEqual(JSON.stringify((await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto.tarefas), antes, 'nada mudou'); // prazos e atividades intactos
  for (const [m, u, b] of tentativas) { const r = m === 'DELETE' ? await fetch(base + u, { method: m }) : await call(m, u, b); assert.strictEqual(r.status ?? r.s, 401, `${m} ${u} deveria ser 401 sem login`); } // anônimo
  assert.strictEqual((await call('PATCH', '/api/tarefas/' + t, { inicio: '2031-01-12', fim: '2031-01-16' }, EQ)).s, 200); // a equipe pode
  assert.strictEqual((await call('GET', '/api/me', null, { 'x-vibe-user-id': 'net_123', 'x-vibe-user-role': 'ADMIN' })).j.usuario, null); // id não numérico nunca é equipe
});

test('mover antes do que a dependência permite: o app explica e deixa escolher (defasagem, remover, empurrar)', async () => {
  const mk = async () => { const p = (await call('POST', '/api/projetos', { nome: 'Bloqueio' }, EQ)).j.projeto;
    const A_ = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Reunião', inicio: '2032-01-05', fim: '2032-01-09' }, EQ)).j.tarefa;
    const B_ = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Cadastro', inicio: '2032-01-10', fim: '2032-01-12', deps: [{ de: A_, tipo: 'FS', lag: 100 }] }, EQ)).j.tarefa; // +100d: começa em 20/04
    const get = async id => (await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto.tarefas.find(x => x.id === id); return { p, A_, B_, get }; };
  let { p, A_, B_, get } = await mk(); assert.strictEqual((await get(B_)).inicio, '2032-04-19'); // 09/01 + 1 + 100
  // sem escolha: 409 com o motivo, e nada muda
  const r = await call('PATCH', '/api/tarefas/' + B_, { inicio: '2032-01-15', fim: '2032-01-17' }, EQ); assert.strictEqual(r.s, 409); assert.strictEqual(r.j.codigo, 'BLOQUEADA_POR_DEPENDENCIA'); assert.strictEqual(r.j.minimo, '2032-04-19'); assert.strictEqual(r.j.inicio, '2032-01-15');
  assert.deepStrictEqual(r.j.motivos.map(x => [x.nome, x.tipo, x.lag, x.base]), [['Reunião', 'FS', 100, '2032-01-10']]); assert.strictEqual((await get(B_)).inicio, '2032-04-19');
  // mover mais tarde ou mudar só o término não é bloqueio
  assert.strictEqual((await call('PATCH', '/api/tarefas/' + B_, { inicio: '2032-04-25', fim: '2032-04-26' }, EQ)).s, 200); assert.strictEqual((await call('PATCH', '/api/tarefas/' + B_, { fim: '2032-04-30' }, EQ)).s, 200);
  // "mesmo assim": a data pedida vale e a defasagem se ajusta (a dependência continua)
  assert.strictEqual((await call('PATCH', '/api/tarefas/' + B_, { inicio: '2032-01-15', fim: '2032-01-17', dependencia: 'defasagem' }, EQ)).s, 200); let b = await get(B_); assert.deepStrictEqual([b.inicio, b.fim], ['2032-01-15', '2032-01-17']); assert.deepStrictEqual(b.deps.map(x => [x.de, x.tipo, x.lag]), [[A_, 'FS', 5]]);
  const hist = (await call('GET', `/api/projetos/${p.id}/historico`, null, EQ)).j.itens; assert.ok(hist.some(x => x.diff.some(y => y.campo === 'Dependências' && y.de.includes('+100d') && y.para.includes('+5d')))); // fica registrado
  await call('PATCH', '/api/tarefas/' + B_, { inicio: '2032-01-08', fim: '2032-01-09', dependencia: 'defasagem' }, EQ); b = await get(B_); assert.strictEqual(b.inicio, '2032-01-08'); assert.strictEqual(b.deps[0].lag, -2); // antecipa (defasagem negativa)
  // "remover a dependência"
  ({ p, A_, B_, get } = await mk()); assert.strictEqual((await call('PATCH', '/api/tarefas/' + B_, { inicio: '2032-01-15', fim: '2032-01-17', dependencia: 'remover' }, EQ)).s, 200); b = await get(B_); assert.deepStrictEqual([b.inicio, b.deps.length], ['2032-01-15', 0]);
  // "empurrar": aceita a data mínima (comportamento antigo)
  ({ p, A_, B_, get } = await mk()); assert.strictEqual((await call('PATCH', '/api/tarefas/' + B_, { inicio: '2032-01-15', fim: '2032-01-17', dependencia: 'empurrar' }, EQ)).s, 200); b = await get(B_); assert.strictEqual(b.inicio, '2032-04-19'); assert.strictEqual(b.deps[0].lag, 100);
  // defasagem impossível (< -365) é recusada; cliente não usa isso
  ({ p, A_, B_, get } = await mk()); assert.strictEqual((await call('PATCH', '/api/tarefas/' + B_, { inicio: '2030-01-01', fim: '2030-01-02', dependencia: 'defasagem' }, EQ)).s, 400); assert.strictEqual((await get(B_)).inicio, '2032-04-19');
  // início de tarefa SEM dependência nunca é bloqueado
  const livre = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Livre', inicio: '2032-06-01', fim: '2032-06-02' }, EQ)).j.tarefa; assert.strictEqual((await call('PATCH', '/api/tarefas/' + livre, { inicio: '2031-01-01', fim: '2031-01-02' }, EQ)).s, 200);
});

test('dias úteis no projeto: normaliza datas, respeita feriados e dependências, e registra a mudança de calendário', async () => {
  const p = (await call('POST', '/api/projetos', { nome: 'Dias úteis', diasUteis: true, feriadosExtras: '2031-03-04\n2031-03-05' }, EQ)).j.projeto; assert.strictEqual(p.diasUteis, true); assert.deepStrictEqual(p.feriadosExtras, ['2031-03-04', '2031-03-05']);
  assert.strictEqual((await call('POST', '/api/projetos', { nome: 'X', feriadosExtras: 'amanhã' }, EQ)).s, 400);
  const get = async () => (await call('GET', '/api/projetos/' + p.id, null, EQ)).j.projeto;
  // sábado–domingo viram segunda; a API avisa o ajuste
  const r = await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Fim de semana', inicio: '2031-01-04', fim: '2031-01-05' }, EQ); assert.deepStrictEqual(r.j.ajustes.map(x => [x.inicio, x.fim]), [['2031-01-06', '2031-01-06']]);
  const a = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'A', inicio: '2031-01-06', fim: '2031-01-10' }, EQ)).j.tarefa;
  const b = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'B', inicio: '2031-01-06', fim: '2031-01-07', deps: [{ de: a, tipo: 'FS', lag: 1 }] }, EQ)).j.tarefa; // a termina sexta; +1 dia útil de defasagem
  let t = (await get()).tarefas.find(x => x.id === b); assert.deepStrictEqual([t.inicio, t.fim], ['2031-01-14', '2031-01-15']); // ter e qua (pula o fim de semana e a defasagem)
  // mover B para antes: o motivo e a defasagem são em dias úteis
  const bl = await call('PATCH', '/api/tarefas/' + b, { inicio: '2031-01-11', fim: '2031-01-14' }, EQ); assert.strictEqual(bl.s, 409); assert.strictEqual(bl.j.minimo, '2031-01-14'); assert.strictEqual(bl.j.motivos[0].base, '2031-01-13'); // sábado pedido → segunda (13) já é anterior ao mínimo
  assert.strictEqual((await call('PATCH', '/api/tarefas/' + b, { inicio: '2031-01-13', fim: '2031-01-14', dependencia: 'defasagem' }, EQ)).s, 200); t = (await get()).tarefas.find(x => x.id === b); assert.deepStrictEqual([t.inicio, t.deps[0].lag], ['2031-01-13', 0]);
  // feriados extras entram na contagem: carnaval (04 e 05/03)
  const c = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Carnaval', inicio: '2031-03-03', fim: '2031-03-03' }, EQ)).j.tarefa; const d = (await call('POST', `/api/projetos/${p.id}/tarefas`, { nome: 'Depois', inicio: '2031-03-03', fim: '2031-03-03', deps: [{ de: c, tipo: 'FS', lag: 0 }] }, EQ)).j.tarefa;
  assert.strictEqual((await get()).tarefas.find(x => x.id === d).inicio, '2031-03-06'); assert.ok((await get()).feriados.includes('2031-03-04') && (await get()).feriados.includes('2031-04-21')); // feriados para o Gantt
  // ligar o calendário em um projeto existente normaliza as datas e deixa o registro
  const q = (await call('POST', '/api/projetos', { nome: 'Corridos' }, EQ)).j.projeto; const e = (await call('POST', `/api/projetos/${q.id}/tarefas`, { nome: 'Sábado', inicio: '2031-01-04', fim: '2031-01-05' }, EQ)).j.tarefa; assert.strictEqual((await call('GET', '/api/projetos/' + q.id, null, EQ)).j.projeto.tarefas[0].inicio, '2031-01-04'); // corridos: sábado vale
  await call('PATCH', '/api/projetos/' + q.id, { diasUteis: true }, EQ); const q2 = (await call('GET', '/api/projetos/' + q.id, null, EQ)).j.projeto; assert.strictEqual(q2.tarefas[0].inicio, '2031-01-06'); assert.ok(q2.diasUteis);
  const hist = (await call('GET', `/api/projetos/${q.id}/historico`, null, EQ)).j.itens; assert.ok(hist.some(x => x.acao === 'editou_projeto' && x.diff.some(y => y.campo === 'Contar só dias úteis' && y.para === 'Sim'))); assert.ok(hist.some(x => x.acao === 'reagendada_dependencia' && /calendário/.test(x.motivo)));
  assert.ok(e);
});
