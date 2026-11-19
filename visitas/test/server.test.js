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
