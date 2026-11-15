'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { createStore } = require('../lib/store');

function fakeVibe() {
  const calls = [];
  const statuses = [...Array.from({ length: 13 }, (_, i) => ({ statusId: 'S' + i, name: 'Mês ' + i, sort: i })), { statusId: 'WON', name: 'Assinado', semantics: 'S' }, { statusId: 'LOSE', name: 'CANCELADOS', semantics: 'F' }];
  const deals = [{ id: 10, title: 'a.bitrix24.com.br', stageId: 'S3', companyId: 5, assignedById: 1, begindate: '2026-01-01T00:00:00Z', movedTime: '2026-11-01T00:00:00Z' }, { id: 11, title: 'b', stageId: 'S12', companyId: 0, assignedById: 1, begindate: '2025-11-01T00:00:00Z', movedTime: '2026-10-01T00:00:00Z' }];
  return { calls, deals, enabled: true,
    async get(p, q = {}) {
      calls.push(['GET', p]);
      if (p === '/statuses' && q['filter[entityId]'] === 'DEAL_STAGE_54') return [{ statusId: 'A1', name: 'MANDAZAP' }, { statusId: 'A2', name: 'FALE FACIL CHAT' }, { statusId: 'AC', name: 'COBRANÇA' }, { statusId: 'AX', name: 'SERVIÇO CANCELADO', semantics: 'F' }];
      if (p === '/deals' && +q['filter[categoryId]'] === 54) return [
        { id: 501, title: 'a.bitrix24.com.br', stageId: 'A1', companyId: 5, amount: 100, createdAt: '2026-05-10T10:00:00Z', ufCrm_1771422009478: '1428', ufCrm_1771421893314: '2026-11-30T03:00:00+03:00' },
        { id: 502, title: 'a.bitrix24.com.br', stageId: 'AC', companyId: 5, amount: 1200, createdAt: '2026-06-10T10:00:00Z', ufCrm_1771422009478: '1428' },
        { id: 503, title: 'b', stageId: 'A2', companyId: 0, contactId: 9, amount: 50, createdAt: '2026-06-11T10:00:00Z' },
        { id: 504, title: 'c', stageId: 'AX', companyId: 0, amount: 70, createdAt: '2026-06-12T10:00:00Z' }];
      if (p === '/stage-history') return [{ createdAt: '2026-01-01T00:00:00Z', stageId: 'A2' }, { createdAt: '2026-02-01T00:00:00Z', stageId: 'AC' }];
      if (p === '/contacts') return [{ id: 9, name: 'Maria', lastName: 'Souza' }]; if (p === '/deals/fields') return { fields: { ufCrm_1762467264536: { items: [{ ID: '1176', VALUE: 'Basic' }] }, ufCrm_1771422009478: { items: [{ ID: '1428', VALUE: 'Mensal' }] } } }; return p === '/statuses' ? statuses : p === '/deals' ? deals : p === '/users' ? [{ id: 1, name: 'Ana', lastName: 'Lima' }] : [{ id: 5, title: 'Empresa A' }]; },
    async post(p, b) { calls.push(['POST', p, b]); return { id: 1 }; },
    async patch(p, b) { calls.push(['PATCH', p, b]); const d = deals.find(x => '/deals/' + x.id === p); if (d) Object.assign(d, b); return {}; } };
}
async function boot() {
  const vibe = fakeVibe(), store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')));
  const app = createApp({ vibe, store, now: () => new Date('2026-11-14T15:00:00Z') });
  const srv = http.createServer(app.handle); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (m, p, body, h = { 'X-Vibe-User-Id': '1', 'X-Vibe-User-Name': 'Ana%20Lima' }) => {
    const r = await fetch(base + p, { method: m, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...h }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { vibe, srv, req, store };
}

test('exige identidade do gateway e responde /health sem ela', async () => {
  const { srv, req } = await boot();
  assert.equal((await req('GET', '/health', null, {})).status, 200);
  assert.equal((await req('GET', '/api/estado', null, {})).status, 401);
  srv.close();
});
test('estado lista clientes com nome da empresa e dashboard', async () => {
  const { srv, req } = await boot();
  const r = await req('GET', '/api/estado');
  assert.equal(r.status, 200); assert.equal(r.json.mes, '2026-11');
  assert.equal(r.json.clientes.find(c => c.id === 10).nome, 'Empresa A');
  assert.equal(r.json.dashboard.geral.total, 2);
  assert.equal((await req('GET', '/api/estado?mes=2026-13')).status, 400);
  srv.close();
});
test('registro: valida, grava, lança comentário no card e atualiza o dashboard', async () => {
  const { srv, req, vibe } = await boot();
  assert.equal((await req('POST', '/api/registros', { dealId: 10, mes: '2026-12', reuniaoRealizada: true })).status, 400);
  assert.equal((await req('POST', '/api/registros', { dealId: 10, mes: '2026-11', reuniaoRealizada: true })).status, 400);   // falta data/canal
  const ok = await req('POST', '/api/registros', { dealId: 10, mes: '2026-11', reuniaoRealizada: true, data: '2026-11-10', canal: 'video', resumo: 'Tudo certo', saude: 'verde' });
  assert.equal(ok.status, 200); assert.equal(ok.json.timeline, true);
  const c = vibe.calls.find(x => x[0] === 'POST'); assert.equal(c[1], '/timelines'); assert.equal(c[2].entityType, 'deal'); assert.match(c[2].comment, /Reunião realizada/); assert.match(c[2].comment, /Ana Lima/);
  const e = (await req('GET', '/api/estado')).json;
  assert.equal(e.clientes.find(x => x.id === 10).status, 'reuniao'); assert.equal(e.dashboard.geral.reuniao, 1);
  assert.equal((await req('POST', '/api/registros', { dealId: 999, mes: '2026-11' })).status, 404);
  assert.equal((await req('DELETE', '/api/registros?dealId=10&mes=2026-11')).status, 200);
  srv.close();
});
test('mover: avança, renova no Mês 12, bloqueia inválidos e protege CSRF', async () => {
  const { srv, req, vibe } = await boot();
  const a = await req('POST', '/api/clientes/10/mover', { acao: 'avancar' });
  assert.deepEqual([a.json.de, a.json.para], ['Mês 3', 'Mês 4']);
  assert.deepEqual(vibe.calls.find(x => x[0] === 'PATCH').slice(1), ['/deals/10', { stageId: 'S4' }]);
  assert.equal((await req('POST', '/api/clientes/10/mover', { acao: 'renovar' })).status, 400);
  assert.equal((await req('POST', '/api/clientes/11/mover', { acao: 'avancar' })).status, 400);
  assert.equal((await req('POST', '/api/clientes/11/mover', { acao: 'renovar' })).json.para, 'Mês 0');
  const csrf = await req('POST', '/api/clientes/11/mover', { acao: 'cancelar' }, { 'X-Vibe-User-Id': '1', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(csrf.status, 403);
  srv.close();
});

test('sincronizar: move o card pela Próxima Renovação e comenta; renovação vencida fica de fora', async () => {
  const { srv, req, vibe } = await boot();
  vibe.deals.push({ id: 12, title: 'c', stageId: 'S5', companyId: 0, begindate: '2026-03-01T00:00:00Z', ufCrm_1771112861536: '2027-03-17T03:00:00+03:00' },
                  { id: 13, title: 'd', stageId: 'S12', companyId: 0, begindate: '2025-03-01T00:00:00Z', ufCrm_1771112861536: '2026-09-01T03:00:00+03:00' });
  const pl = (await req('GET', '/api/sincronizar')).json;
  assert.deepEqual(pl.mover.map(m => [m.id, m.para]), [[12, 'Mês 8']]); assert.ok(pl.ignorados.some(i => i.id === 13 && i.motivo === 'vencida'));
  const r = (await req('POST', '/api/sincronizar', {})).json; assert.equal(r.movidos.length, 1);
  assert.deepEqual(vibe.calls.find(x => x[0] === 'PATCH').slice(1), ['/deals/12', { stageId: 'S8' }]);
  srv.close();
});

test('dados: atualiza renovação/plano/valor no card, comenta e reposiciona a etapa', async () => {
  const { srv, req, vibe } = await boot();
  const r = await req('POST', '/api/clientes/10/dados', { renovacao: '2027-03-17', plano: '1176', valor: 1234.5 });
  assert.equal(r.status, 200); assert.equal(r.json.movido.para, 'Mês 8');
  const patches = vibe.calls.filter(x => x[0] === 'PATCH');
  assert.deepEqual(patches[0][2], { ufCrm_1771112861536: '2027-03-17', ufCrm_1762467264536: '1176', amount: 1234.5, isManualOpportunity: true });
  assert.deepEqual(patches[1].slice(1), ['/deals/10', { stageId: 'S8' }]);
  assert.match(vibe.calls.find(x => x[0] === 'POST')[2].comment, /Dados do contrato atualizados/);
  assert.equal((await req('POST', '/api/clientes/10/dados', { renovacao: 'xx' })).status, 400);
  assert.equal((await req('POST', '/api/clientes/10/dados', { plano: '9999' })).status, 400);
  assert.equal((await req('POST', '/api/clientes/10/dados', { responsavelId: 777 })).status, 400);
  assert.equal((await req('POST', '/api/clientes/999/dados', { valor: 1 })).status, 404);
  assert.equal((await req('POST', '/api/clientes/10/dados', {})).status, 400);
  srv.close();
});

test('apps: licenças por app, app inferido do histórico, MRR e edição', async () => {
  const { srv, req, vibe } = await boot();
  const r = (await req('GET', '/api/apps')).json;
  assert.deepEqual(r.apps, ['MandaZap', 'Fale Fácil Chat']);
  const l = Object.fromEntries(r.licencas.map(x => [x.id, x]));
  assert.equal(l[502].app, 'Fale Fácil Chat'); assert.equal(l[502].appOrigem, 'historico'); assert.equal(l[501].appOrigem, 'etapa');
  assert.equal(r.resumo.totais.licencas, 3); assert.equal(r.resumo.totais.mrr, 1350); assert.equal(r.resumo.estados.cancelada.qtd, 1); assert.equal(r.resumo.estados.cobranca.qtd, 1);
  assert.equal(r.resumo.renovacoes.d30.qtd, 1); assert.equal(l[501].diasRenovar, 16); assert.equal(r.resumo.qualidade.semRenovacao, 2);
  assert.equal(r.resumo.porApp[0].app, 'Fale Fácil Chat'); assert.equal(l[503].nome, 'Maria Souza');
  const ed = await req('POST', '/api/apps/502/dados', { app: 'MandaZap', valor: 99 });
  assert.equal(ed.status, 200);
  assert.deepEqual(vibe.calls.filter(x => x[0] === 'PATCH').pop().slice(1), ['/deals/502', { amount: 99, isManualOpportunity: true }]);
  assert.equal((await req('GET', '/api/apps')).json.licencas.find(x => x.id === 502).app, 'MandaZap');
  assert.equal((await req('POST', '/api/apps/502/dados', { app: 'Nada' })).status, 400);
  assert.equal((await req('POST', '/api/apps/999/dados', { valor: 1 })).status, 404);
  srv.close();
});
