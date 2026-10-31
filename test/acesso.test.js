'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { today, world, R } = require('../testkit/world');

const raw = (port, method, p, { headers = {}, body } = {}) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json', ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* html */ } ok({ status: res.statusCode, json: j, body: b }); }); });
  r.on('error', no); if (body) r.write(JSON.stringify(body)); r.end();
});
const U = (id, role = 'MEMBER', name = 'Fulano') => ({ 'X-Vibe-User-Id': String(id), 'X-Vibe-User-Role': role, 'X-Vibe-User-Name-Encoded': encodeURIComponent(name), 'Sec-Fetch-Site': 'same-origin' });

test('controle de acesso: sem identidade 401; sem vínculo 403; admin do portal configura; parceiro só lê o portal; máx. 3 admins', async () => {
  const port = 3800 + Math.floor(Math.random() * 90), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-'));
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, BITRIX_WEBHOOK: '', ASAAS_API_KEY: '', SYNC_MINUTES: '600', QUICK_MINUTES: '600' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await raw(port, 'GET', '/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.equal((await raw(port, 'GET', '/api/state')).status, 401);                                         // ninguém identificado
    assert.equal((await raw(port, 'GET', '/api/me', { headers: { 'X-Vibe-User-Id': 'share:abc' } })).status, 401);   // visitante sem ID numérico
    assert.equal((await raw(port, 'GET', '/health')).status, 200);
    let me = await raw(port, 'GET', '/api/me', { headers: U(7, 'MEMBER') });
    assert.equal(me.json.papel, 'sem');
    assert.equal((await raw(port, 'GET', '/api/state', { headers: U(7) })).status, 403);                      // sem vínculo: nada
    assert.equal((await raw(port, 'POST', '/api/cobrar', { headers: U(7), body: {} })).status, 403);
    assert.equal((await raw(port, 'GET', '/api/acessos', { headers: U(7) })).status, 403);
    me = await raw(port, 'GET', '/api/me', { headers: U(1, 'ADMIN') });
    assert.equal(me.json.papel, 'admin'); assert.equal(me.json.bootstrap, true);                              // ninguém definido: admin do portal configura
    const J = id => ({ headers: U(1, 'ADMIN'), body: { userId: id } });
    for (const id of [1, 2, 3]) assert.equal((await raw(port, 'POST', '/api/acessos/admins', J(id))).status, 200);
    const quarto = await raw(port, 'POST', '/api/acessos/admins', J(4)); assert.equal(quarto.status, 400); assert.match(quarto.json.error, /limite é de 3/);
    assert.equal((await raw(port, 'POST', '/api/acessos/admins', J('abc'))).status, 400);
    // agora só os 3 listados são admin; o admin do portal não listado perde acesso aos dados, mas ainda corrige os acessos
    assert.equal((await raw(port, 'GET', '/api/me', { headers: U(9, 'ADMIN') })).json.papel, 'sem');
    assert.equal((await raw(port, 'GET', '/api/state', { headers: U(9, 'ADMIN') })).status, 403);
    assert.equal((await raw(port, 'GET', '/api/acessos', { headers: U(9, 'ADMIN') })).status, 200);
    assert.equal((await raw(port, 'GET', '/api/acessos', { headers: U(2, 'MEMBER') })).status, 200);           // admin listado, mesmo MEMBER no portal
    assert.equal((await raw(port, 'GET', '/api/me', { headers: U(2, 'MEMBER') })).json.papel, 'admin');
    assert.equal((await raw(port, 'DELETE', '/api/acessos/admins/3', { headers: U(1, 'ADMIN') })).status, 200);
    const lista = await raw(port, 'GET', '/api/acessos', { headers: U(1, 'ADMIN') }); assert.deepEqual(lista.json.admins.map(a => a.id), ['1', '2']);
  } finally { p.kill(); }
});

test('portal: parceiro vê só o que tem a receber (sem regras/margens) e não enxerga outro parceiro', async () => {
  const w = world([]); await w.svc.ensureFields(); await w.svc.pagar.ensure();
  const A = (await w.svc.pagar.salvarParceiro({ nome: 'Connect Think' })).id, B = (await w.svc.pagar.salvarParceiro({ nome: 'Outro Fornecedor', tipo: 'SUPPLIER' })).id;
  const mk = (o) => w.svc.pagar.criarConta({ categoria: 'Repasse a parceiro', venc: today, ...o }).then(r => r.ids[0]);
  const a1 = await mk({ titulo: 'Repasse A1', valor: 300, parceiroId: A, obs: 'MARGEM SECRETA' }), a2 = await mk({ titulo: 'Repasse A2', valor: 200, parceiroId: A }), b1 = await mk({ titulo: 'Repasse B1', valor: 999, parceiroId: B });
  const c = await w.svc.pagar.consolidar({ ids: [a1, a2] });
  const v = await w.svc.pagar.visaoPortal(A);
  assert.equal(v.quem.nome, 'Connect Think'); assert.equal(v.resumo.aReceber, 500);
  assert.deepEqual(v.contas.map(x => x.id), [c.id]);                          // só o consolidado (os títulos dentro dele não aparecem soltos)
  assert.ok(!JSON.stringify(v).includes('MARGEM SECRETA')); assert.ok(!('regra' in v.contas[0]) && !('origem' in v.contas[0]) && !('pix' in v.contas[0]));
  const d = await w.svc.pagar.detalhePortal(c.id, A);
  assert.equal(d.itens.length, 2); assert.equal(d.total, 500);
  await assert.rejects(() => w.svc.pagar.detalhePortal(c.id, B), /não encontrado/);   // outro parceiro não abre o consolidado
  assert.equal((await w.svc.pagar.visaoPortal(B)).resumo.aReceber, 999);
});

test('folha de pagamento: lançamentos por colaborador, holerite consolidado e resultado separando custo de fornecedor × comissão', async () => {
  const w = world([]); await w.svc.ensureFields(); await w.svc.pagar.ensure(); const p = w.svc.pagar;
  const E = (await p.salvarParceiro({ nome: 'Maria Silva', tipo: 'EMPLOYEE' })).id, F = (await p.salvarParceiro({ nome: 'Bitrix24 Brasil', tipo: 'SUPPLIER' })).id;
  assert.equal((await p.parceiros(true)).find(x => x.id === E).tipo, 'EMPLOYEE');
  const mk = (o) => p.criarConta({ venc: today, ...o }).then(r => r.ids[0]);
  const s = await mk({ titulo: 'Salário', valor: 3000, categoria: 'Pessoas', parceiroId: E }), b = await mk({ titulo: 'Bônus', valor: 500, categoria: 'Pessoas', parceiroId: E });
  const f = await p.folha(today.slice(0, 7));
  assert.equal(f.colaboradores.length, 1); assert.equal(f.colaboradores[0].total, 3500); assert.deepEqual(f.colaboradores[0].soltos.sort(), [s, b].sort());
  const h = await p.consolidar({ ids: [s, b] });
  const f2 = await p.folha(today.slice(0, 7));
  assert.equal(f2.colaboradores[0].soltos.length, 0); assert.equal(f2.colaboradores[0].lotes[0].id, h.id);
  assert.equal((await p.visaoPortal(E)).resumo.aReceber, 3500);               // o colaborador vê o holerite consolidado
  // DRE: repasse a fornecedor = custo da revenda; a parceiro = comissão
  const G = require('../lib/gestao');
  const cs = await p.contas();
  const rec = [{ id: 1, stageId: R.STAGES.paid, valor: 1000, liquido: 0, venc: today, pagoEm: today, split: 'x', repasses: '', manual: false }];
  const fake = [{ ...cs[0], id: 901, origem: 1, benTipo: 'SUPPLIER', beneficiario: 'Bitrix24 Brasil', categoria: 'Fornecedor', estado: 'pago', pagoEm: today, valorPago: 0, valor: 800, itens: [], lote: 0 },
    { ...cs[0], id: 902, origem: 1, benTipo: 'PARTNER', beneficiario: 'Indicador', categoria: 'Repasse a parceiro', estado: 'pago', pagoEm: today, valorPago: 0, valor: 50, itens: [], lote: 0 }];
  const d = G.dre(rec, fake, { mes: today.slice(0, 7), regime: 'caixa' });
  assert.equal(d.custos, 800); assert.equal(d.comissoes, 50); assert.equal(d.margem, 150); assert.equal(d.resultado, 150);
});
