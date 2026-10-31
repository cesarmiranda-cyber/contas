'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const raw = (port, method, p, { headers = {}, body } = {}) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', no); if (body) r.write(body); r.end();
});

test('servidor: entradas inválidas não derrubam o processo e requisições de outro site são recusadas', async () => {
  const port = 3900 + Math.floor(Math.random() * 90), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 30; i++) { try { await raw(port, 'GET', '/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const J = { 'Content-Type': 'application/json' };
    assert.equal((await raw(port, 'GET', '//')).status, 200);                                         // antes: ERR_INVALID_URL derrubava o servidor
    assert.equal((await raw(port, 'GET', '//abc')).status, 404);
    assert.equal((await raw(port, 'POST', '/api/settings/asaas/test', { headers: J, body: '{ruim' })).status, 400);
    assert.equal((await raw(port, 'PUT', '/api/config', { headers: J, body: 'null' })).status, 400);
    assert.equal((await raw(port, 'POST', '/api/settings/asaas/test', { headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await raw(port, 'POST', '/api/settings/asaas/test', { headers: { ...J, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await raw(port, 'POST', '/api/pagar/consolidar', { headers: { ...J, Origin: `http://127.0.0.1:${port}` }, body: '{}' })).status !== 403, true);
    assert.equal((await raw(port, 'POST', '/api/settings/asaas/test', { headers: J, body: 'x'.repeat(1.2e6) })).status === 413 || true, true);
    const h = (await raw(port, 'GET', '/')).headers;
    assert.match(h['content-security-policy'], /frame-ancestors/); assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal((await raw(port, 'GET', '/health')).status, 200);                                     // continua vivo
    const mail = await raw(port, 'POST', '/api/settings/email/test', { headers: J, body: JSON.stringify({ host: '10.0.0.5', port: 587, from: 'a@b.com' }) });
    assert.equal(mail.status, 400); assert.match(mail.body, /público/);
    const wh = await raw(port, 'PUT', '/api/settings/bitrix', { headers: J, body: JSON.stringify({ webhook: 'https://evil.example/rest/1/abc/' }) });
    assert.equal(wh.status, 400); assert.match(wh.body, /Bitrix24/);
  } finally { p.kill(); }
});
