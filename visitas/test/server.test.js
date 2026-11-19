'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'visrv-')); delete process.env.AUTH_DISABLED;
const { server } = require('../server');
let base; test.before(() => new Promise(ok => server.listen(0, () => { base = `http://localhost:${server.address().port}`; ok(); })));
test.after(() => server.close());
test('/health responde sem autenticação', async () => { const r = await fetch(base + '/health'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true }); });
test('/api exige usuário do gateway', async () => { assert.equal((await fetch(base + '/api/eu')).status, 401); });
test('com usuário, avisa que o webhook não está configurado', async () => {
  const h = { 'x-vibe-user-id': '5', 'x-vibe-user-role': 'USER' };
  const eu = await (await fetch(base + '/api/eu', { headers: h })).json(); assert.equal(eu.webhook, false); assert.equal(eu.config, false);
  assert.equal((await fetch(base + '/api/visitas', { headers: h })).status, 503);
  assert.equal((await fetch(base + '/api/config', { headers: h })).status, 403);
});
test('serve a interface em /', async () => { const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /Registro de Visitas/); });
test('segurança: CSP sem script inline, nosniff e arquivo estático com ETag/gzip/304', async () => {
  const r = await fetch(base + '/', { headers: { 'accept-encoding': 'gzip' } });
  assert.match(r.headers.get('content-security-policy'), /script-src 'self';/); assert.doesNotMatch(r.headers.get('content-security-policy').split(';').find(x => x.trim().startsWith('script-src')), /unsafe/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('content-encoding'), 'gzip');
  const r2 = await fetch(base + '/app.js', { headers: { 'if-none-match': (await fetch(base + '/app.js')).headers.get('etag') } }); assert.equal(r2.status, 304);
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 404);
});
test('segurança: busca de usuários e nomes só para quem configura; limite de requisições', async () => {
  const h = { 'x-vibe-user-id': '6', 'x-vibe-user-role': 'USER' };
  assert.equal((await fetch(base + '/api/usuarios?q=ab', { headers: h })).status, 403);
  assert.equal((await fetch(base + '/api/nomes?ids=1', { headers: h })).status, 403);
  assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers: { ...h, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403);
  let last; for (let i = 0; i < 310; i++) last = (await fetch(base + '/api/eu', { headers: h })).status;
  assert.equal(last, 429);
});
