'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm4-')); process.env.INSECURE_COOKIE = '1';
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
