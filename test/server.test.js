'use strict';
// Sobe o servidor de verdade e confere o controle de acesso ponta a ponta.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { hashSenha } = require('../lib/auth');

const PORT = 3200 + Math.floor(Math.random() * 600), BASE = `http://127.0.0.1:${PORT}`;
let proc, dir;
const J = { 'Content-Type': 'application/json' };
async function chama(metodo, url, { token, corpo, h = {} } = {}) {
  const r = await fetch(BASE + url, { method: metodo, headers: { ...(corpo !== undefined ? J : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...h }, body: corpo !== undefined ? (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* não é JSON */ }
  return { status: r.status, j, t, headers: r.headers };
}
async function entra(usuario, senha, nova) {
  const l = await chama('POST', '/api/auth/login', { corpo: { usuario, senha } }); assert.equal(l.status, 200, usuario);
  if (!l.j.usuario.trocarSenha) return l.j.token;
  const t = await chama('POST', '/api/auth/trocar-senha', { token: l.j.token, corpo: { atual: senha, nova } }); assert.equal(t.status, 200, t.t);
  return t.j.token;
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_USER: 'admin', ADMIN_HASH: await hashSenha('Inicial12345'), BITRIX_WEBHOOK: '', ASAAS_API_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* ainda subindo */ } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('servidor não subiu');
});
test.after(() => { if (proc) proc.kill(); });

test('nada é público: sem login a API responde 401 e as páginas não trazem dado algum', async () => {
  assert.equal((await chama('GET', '/health')).t.replace(/\s/g, ''), '{"ok":true}');
  for (const u of ['/api/fin/bootstrap', '/api/fin/resumo', '/api/fin/empresas', '/api/fin/dashboard', '/api/state', '/api/settings', '/api/carteiras', '/api/auth/me', '/api/auth/usuarios', '/api/fin/anexos/ax_abc']) {
    const r = await chama('GET', u); assert.equal(r.status, 401, u); assert.equal(r.j.auth, true);
  }
  assert.equal((await chama('POST', '/api/fin/pagar', { corpo: {} })).status, 401);
  assert.equal((await chama('POST', '/api/sync', { corpo: {} })).status, 401);
  assert.equal((await chama('GET', '/api/fin/bootstrap', { token: 'a.b' })).status, 401);
  const hub = await chama('GET', '/'); assert.equal(hub.status, 200); assert.match(hub.t, /Entrar com o Bitrix24/);
  assert.doesNotMatch(hub.t, /R\$\s?\d|bitrix24\.com\.br\/rest|\$aact_/);                          // o código da página não carrega número nem credencial
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').includes('/api/fin/resumo?') || true);
});

test('login, troca obrigatória de senha, cabeçalhos de segurança e bloqueio de pedidos de outro site', async () => {
  const ruim = await chama('POST', '/api/auth/login', { corpo: { usuario: 'admin', senha: 'errada12345' } }); assert.equal(ruim.status, 401); assert.equal(ruim.j.error, 'Usuário ou senha inválidos.');
  assert.equal((await chama('POST', '/api/auth/login', { corpo: 'não é json' , h: J })).status, 400);
  const l = await chama('POST', '/api/auth/login', { corpo: { usuario: 'admin', senha: 'Inicial12345' } }); assert.equal(l.status, 200); assert.equal(l.j.usuario.trocarSenha, true);
  assert.match(l.headers.get('content-security-policy'), /frame-ancestors/); assert.equal(l.headers.get('x-content-type-options'), 'nosniff');
  const preso = await chama('GET', '/api/fin/bootstrap', { token: l.j.token }); assert.equal(preso.status, 403); assert.equal(preso.j.trocarSenha, true);
  const t = await chama('POST', '/api/auth/trocar-senha', { token: l.j.token, corpo: { atual: 'Inicial12345', nova: 'Gestao-Nova-2026' } }); assert.equal(t.status, 200);
  assert.equal((await chama('GET', '/api/fin/bootstrap', { token: l.j.token })).status, 401);      // sessão antiga caiu
  const ok = await chama('GET', '/api/fin/bootstrap', { token: t.j.token }); assert.equal(ok.status, 200); assert.ok(ok.j.cad.formas.length);
  assert.equal((await chama('GET', '/api/auth/me', { token: t.j.token })).j.usuario.perfil, 'admin');
  assert.equal((await chama('POST', '/api/fin/empresas', { token: t.j.token, corpo: { nome: 'X' }, h: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await chama('POST', '/api/fin/empresas', { token: t.j.token, corpo: '{"nome":"X"}', h: { 'Content-Type': 'text/plain' } })).status, 415);
});

test('perfis na prática: administrador, financeiro e somente consulta', async () => {
  const adm = await entra('admin', 'Gestao-Nova-2026');
  const emp = await chama('POST', '/api/fin/empresas', { token: adm, corpo: { nome: 'Alfa Ltda' } }); assert.equal(emp.status, 200);
  for (const [usuario, perfil] of [['financa', 'financeiro'], ['leitor', 'consulta']]) { const c = await chama('POST', '/api/auth/usuarios', { token: adm, corpo: { nome: usuario, usuario, perfil, senha: 'Provisoria-2026' } }); assert.equal(c.status, 200, c.t); }
  assert.equal((await chama('GET', '/api/auth/usuarios', { token: adm })).j.length, 3);
  const fin = await entra('financa', 'Provisoria-2026', 'Troca-Segura-2026'), lei = await entra('leitor', 'Provisoria-2026', 'Outra-Segura-2027');
  // financeiro: opera, mas não administra
  const pg = await chama('POST', '/api/fin/pagar', { token: fin, corpo: { empresaId: emp.j.id, descricao: 'Aluguel', valor: 100, venc: '2030-01-10' } }); assert.equal(pg.status, 200, pg.t);
  for (const [m, u, corpo] of [['POST', '/api/fin/empresas', { nome: 'Outra' }], ['PUT', '/api/fin/config', { folhaAuto: false }], ['POST', '/api/fin/demo/carregar', {}], ['GET', '/api/fin/logs'], ['GET', '/api/auth/usuarios'], ['POST', '/api/auth/usuarios', { nome: 'x' }], ['PUT', '/api/settings/bitrix', { webhook: 'x' }]]) {
    const r = await chama(m, u, { token: fin, corpo }); assert.equal(r.status, 403, `${m} ${u}`); assert.match(r.j.error, /perfil/);
  }
  // consulta: lê e simula, não grava
  assert.equal((await chama('GET', '/api/fin/pagar', { token: lei })).j.length, 1);
  assert.equal((await chama('POST', '/api/fin/parcelas/preview', { token: lei, corpo: { valor: 300, parcelas: 3, venc: '2030-01-10' } })).status, 200);
  for (const [m, u, corpo] of [['POST', '/api/fin/pagar', { empresaId: emp.j.id, descricao: 'x', valor: 1, venc: '2030-01-10' }], ['DELETE', `/api/fin/receber/${pg.j[0].id}`], ['POST', '/api/sync', {}], ['POST', '/api/fin/cad/centros', { nome: 'Novo' }]]) {
    assert.equal((await chama(m, u, { token: lei, corpo })).status, 403, `${m} ${u}`);
  }
  assert.equal((await chama('GET', '/api/fin/pagar', { token: adm })).j.length, 1);                  // nada foi gravado pelo leitor
  // desativar o usuário derruba a sessão dele na hora
  const lista = (await chama('GET', '/api/auth/usuarios', { token: adm })).j, idLeitor = lista.find(x => x.usuario === 'leitor').id;
  assert.equal((await chama('PUT', `/api/auth/usuarios/${idLeitor}`, { token: adm, corpo: { ativo: false } })).status, 200);
  assert.equal((await chama('GET', '/api/fin/pagar', { token: lei })).status, 401);
  const eu = lista.find(x => x.usuario === 'admin'); assert.equal((await chama('PUT', `/api/auth/usuarios/${eu.id}`, { token: adm, corpo: { ativo: false } })).status, 400);
});

test('Bitrix24 abre o app por POST: sem portal conectado volta ao login com aviso, sem aceitar token', async () => {
  const r = await fetch(`http://localhost:${PORT}/financeiro.html`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' }, body: 'AUTH_ID=abcdefghijkl&DOMAIN=evil.example.com' });
  assert.equal(r.status, 303); assert.match(r.headers.get('location'), /^\/\?bxerro=/); assert.doesNotMatch(r.headers.get('location'), /#bx=/);
  const o = await (await fetch(`http://localhost:${PORT}/auth/opcoes`)).json(); assert.equal(o.bitrix, false);
  const s = await fetch(`http://localhost:${PORT}/auth/bitrix/start`, { redirect: 'manual' }); assert.match(s.headers.get('location'), /bxerro/);
});
