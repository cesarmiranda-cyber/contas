'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createServer } = require('../server');

const USERS = [{ id: '10', nome: 'Admin Um', email: 'a@x.com' }, { id: '20', nome: 'Maria Gestora', email: 'm@x.com' }, { id: '30', nome: 'João Consulta', email: 'j@x.com' }, { id: '40', nome: 'Sem Acesso', email: 's@x.com' }];
const fake = { buscar: async (_b, q) => USERS.filter(u => u.nome.toLowerCase().includes(String(q).toLowerCase())), porId: async (_b, id) => USERS.find(u => u.id === id) || null };
async function boot() {
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-')), usuarios: fake, applicationId: 'app-1' });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, { as, body, h } = {}) => {
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(as ? { 'x-vibe-user-id': as.id, 'x-vibe-user-role': as.role || 'MEMBER', 'x-vibe-user-name-encoded': encodeURIComponent(as.nome || '') } : {}), ...h };
    const r = await fetch(base + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, r };
  };
  return { srv, call };
}
const portalAdmin = { id: '10', role: 'ADMIN', nome: 'Admin Um' };
const ficha = (o = {}) => ({ nome: 'Ana Souza', email: 'ana@x.com', telefone: '31 99816-2393', cidade: 'Belo Horizonte', uf: 'MG', area: 'Administrativo', linkedin: 'linkedin.com/in/ana-souza', consentimento: true, ...o });
const EXT = { 'x-vibe-caller-kind': 'external-api', 'x-vibe-caller-key-id': 'k1' };
const PDF = Buffer.from('%PDF-1.4 teste').toString('base64');

test('sem identidade do gateway → 401; canal externo não alcança rotas internas', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('GET', '/api/me')).s, 401);
  assert.equal((await call('GET', '/api/me', { as: portalAdmin, h: EXT })).s, 403);
  assert.equal((await call('GET', '/api/curriculos/candidatos', { h: EXT })).s, 403);
  srv.close();
});
test('acesso: nega por padrão, admin libera por módulo e nível', async () => {
  const { srv, call } = await boot();
  const maria = { id: '20', nome: 'Maria Gestora' }, joao = { id: '30', nome: 'João Consulta' };
  assert.equal((await call('GET', '/api/curriculos/candidatos', { as: maria })).s, 403);
  assert.equal((await call('GET', '/api/acessos', { as: maria })).s, 403);
  // bootstrap: admin do portal configura
  assert.equal((await call('GET', '/api/me', { as: portalAdmin })).j.usuario.bootstrap, true);
  assert.equal((await call('POST', '/api/acessos/admin', { as: portalAdmin, body: { userId: '10' } })).s, 200);
  assert.equal((await call('GET', '/api/me', { as: portalAdmin })).j.usuario.bootstrap, false);
  // depois de definido, um admin do portal que não está na lista deixa de ser admin
  assert.equal((await call('GET', '/api/acessos', { as: { id: '99', role: 'ADMIN' } })).s, 403);
  const adm = { id: '10', nome: 'Admin Um' };
  assert.equal((await call('PUT', '/api/acessos/modulo/curriculos', { as: adm, body: { userId: '20', nivel: 'gestor' } })).s, 200);
  assert.equal((await call('PUT', '/api/acessos/modulo/curriculos', { as: adm, body: { userId: '30', nivel: 'consulta' } })).s, 200);
  assert.equal((await call('PUT', '/api/acessos/modulo/curriculos', { as: adm, body: { userId: '777', nivel: 'gestor' } })).s, 404, 'só usuários que existem no Bitrix24');
  assert.equal((await call('PUT', '/api/acessos/modulo/admissao', { as: adm, body: { userId: '20', nivel: 'gestor' } })).s, 404, 'módulo ainda indisponível');
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha() })).s, 201);
  const l = await call('GET', '/api/curriculos/candidatos', { as: joao });
  assert.equal(l.s, 200); assert.equal(l.j.itens.length, 1);
  const id = l.j.itens[0].id;
  assert.equal((await call('PATCH', '/api/curriculos/candidatos/' + id, { as: joao, body: { status: 'triagem' } })).s, 403, 'consulta não altera');
  assert.equal((await call('DELETE', '/api/curriculos/candidatos/' + id, { as: joao })).s, 403);
  assert.equal((await call('PATCH', '/api/curriculos/candidatos/' + id, { as: maria, body: { status: 'triagem', nota: 'Boa conversa' } })).s, 200);
  assert.equal((await call('GET', '/api/curriculos/candidatos', { as: { id: '40', nome: 'Sem Acesso' } })).s, 403);
  const me = (await call('GET', '/api/me', { as: { id: '40' } })).j;
  assert.equal(me.modulos.find(m => m.id === 'curriculos').acesso, false);
  assert.equal((await call('DELETE', '/api/acessos/modulo/curriculos/30', { as: adm })).s, 200);
  assert.equal((await call('GET', '/api/curriculos/candidatos', { as: joao })).s, 403, 'acesso revogado vale na hora');
  assert.ok((await call('GET', '/api/auditoria', { as: adm })).j.itens.some(a => a.acao === 'candidato.ver' || a.acao === 'candidato.alterar'));
  srv.close();
});
test('entrada pública: valida, aceita CV por conteúdo, deduplica e descarta robô', async () => {
  const { srv, call } = await boot();
  const bad = await call('POST', '/public/candidaturas', { h: EXT, body: { nome: 'x' } });
  assert.equal(bad.s, 422); assert.ok(bad.j.erros.email && bad.j.erros.curriculo);
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ linkedin: undefined }) })).s, 422, 'precisa de CV ou LinkedIn');
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ linkedin: 'https://evil.com/in/x' }) })).s, 422);
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ linkedin: undefined, curriculo: { nome: 'a.pdf', base64: Buffer.from('<html>').toString('base64') } }) })).s, 422, 'conteúdo não é PDF/DOC');
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ consentimento: false }) })).s, 422);
  assert.equal((await call('POST', '/public/candidaturas', { body: ficha() })).s, 403, 'sem o canal externo não entra');
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ linkedin: undefined, curriculo: { nome: 'cv.pdf', base64: PDF } }) })).s, 201);
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ cidade: 'Contagem' }) })).s, 201, 'reenvio atualiza');
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ website: 'http://spam' }) })).s, 201);
  const adm = { id: '10', role: 'ADMIN', nome: 'A' };
  const l = (await call('GET', '/api/curriculos/candidatos', { as: adm })).j;
  assert.equal(l.itens.length, 1); assert.equal(l.itens[0].cidade, 'Contagem'); assert.equal(l.itens[0].temCv, true);
  const dl = await call('GET', `/api/curriculos/candidatos/${l.itens[0].id}/cv`, { as: adm });
  assert.equal(dl.s, 200); assert.match(dl.r.headers.get('content-disposition'), /attachment/);
  const integ = (await call('GET', '/api/curriculos/integracao', { as: adm })).j;
  assert.match(integ.endpoint, /applications\/app-1\/api\/public\/candidaturas$/);
  srv.close();
});
test('lista de chaves autorizadas para o site (INTAKE_KEY_IDS)', async () => {
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-')), usuarios: fake, intakeKeyIds: ['ok'] });
  await new Promise(r => srv.listen(0, r));
  const post = k => fetch(`http://127.0.0.1:${srv.address().port}/public/candidaturas`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vibe-caller-kind': 'external-api', 'x-vibe-caller-key-id': k }, body: JSON.stringify(ficha()) });
  assert.equal((await post('outra')).status, 403); assert.equal((await post('ok')).status, 201);
  srv.close();
});
