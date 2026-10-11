'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { checkKeyEnv, checkWebhook, hint, createSecrets } = require('../lib/secrets');
const { createAsaas } = require('../lib/asaas');

test('valida prefixo da chave por ambiente e o formato do webhook', () => {
  assert.match(checkKeyEnv('$aact_hmlg_abc', 'production'), /SANDBOX/);
  assert.match(checkKeyEnv('$aact_prod_abc', 'sandbox'), /PRODUÇÃO/);
  assert.equal(checkKeyEnv('$aact_hmlg_abc', 'sandbox'), null);
  assert.equal(checkKeyEnv('$aact_prod_abc', 'production'), null);
  assert.match(checkKeyEnv('abc def', 'sandbox'), /espaços/);
  assert.match(checkKeyEnv('', 'sandbox'), /Informe/);
  assert.equal(checkWebhook('https://x.bitrix24.com.br/rest/1/abc123/'), null);
  assert.match(checkWebhook('http://x.bitrix24.com.br/rest/1/abc/'), /https/);
  assert.match(checkWebhook('https://x.bitrix24.com.br/'), /Formato/);
  assert.equal(hint('abcdef1234'), '••••1234');
});

test('segredos ficam em arquivo 0600 e persistem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const a = createSecrets(dir); a.set({ asaasKey: 'k1' });
  assert.equal(createSecrets(dir).get('asaasKey'), 'k1');
  assert.equal((fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777).toString(8), '600');
  a.clear('asaasKey'); assert.equal(createSecrets(dir).get('asaasKey'), undefined);
});

test('cliente Asaas liga e desliga em tempo de execução', () => {
  const a = createAsaas({});
  assert.equal(a.enabled, false);
  a.configure({ apiKey: 'k', env: 'production' });
  assert.equal(a.enabled, true); assert.equal(a.env, 'production');
  a.configure({ apiKey: '' }); assert.equal(a.enabled, false);
});

// ---- servidor real + Bitrix e Asaas falsos ----
function listen(handler) { return new Promise(ok => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => ok(s)); }); }

test('tela de Configurações: testa, salva, nunca devolve a chave e permite remover', async t => {
  const seen = [];
  const fakeAsaas = await listen((q, r) => {
    seen.push(q.url);
    const ok = q.headers.access_token === '$aact_hmlg_valida1234';
    r.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify(ok ? (q.url.includes('balance') ? { balance: 1234.5 } : { companyName: 'Manda4 LTDA' }) : { errors: [{ description: 'invalid' }] }));
  });
  const fakeBitrix = await listen((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(q.url.includes('profile') ? { result: { NAME: 'Cesar', LAST_NAME: 'Miranda', ADMIN: true } } : { result: [] })); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dir, ASAAS_BASE_URL: `http://127.0.0.1:${fakeAsaas.address().port}`, BITRIX_WEBHOOK: '', ASAAS_API_KEY: '', SYNC_MINUTES: '600' } });
  t.after(() => { child.kill(); fakeAsaas.close(); fakeBitrix.close(); });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const api = async (m, u, b) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json() }; };

  let s = await api('GET', '/api/settings');
  assert.equal(s.json.asaas.configured, false); assert.equal(s.json.asaas.source, 'nenhuma');

  let r = await api('POST', '/api/settings/asaas/test', { apiKey: '$aact_prod_x', env: 'sandbox' });   // ambiente trocado
  assert.equal(r.status, 400); assert.match(r.json.error, /PRODUÇÃO/);
  r = await api('POST', '/api/settings/asaas/test', { apiKey: '$aact_hmlg_errada', env: 'sandbox' });  // chave recusada
  assert.equal(r.status, 400); assert.match(r.json.error, /recusou a chave/);
  r = await api('PUT', '/api/settings/asaas', { apiKey: '$aact_prod_valida', env: 'production' });     // produção exige confirmação
  assert.equal(r.status, 400); assert.match(r.json.error, /PRODUÇÃO/);

  r = await api('POST', '/api/settings/asaas/test', { apiKey: '$aact_hmlg_valida1234', env: 'sandbox' });
  assert.equal(r.status, 200); assert.equal(r.json.saldo, 1234.5); assert.equal(r.json.nome, 'Manda4 LTDA');
  s = await api('GET', '/api/settings'); assert.equal(s.json.asaas.configured, false);                   // testar não salva

  r = await api('PUT', '/api/settings/asaas', { apiKey: '$aact_hmlg_valida1234', env: 'sandbox' });
  assert.equal(r.json.saved, true);
  s = await api('GET', '/api/settings');
  assert.equal(s.json.asaas.configured, true); assert.equal(s.json.asaas.source, 'painel'); assert.equal(s.json.asaas.hint, '••••1234');
  assert.ok(!JSON.stringify(s.json).includes('valida1234') || s.json.asaas.hint.endsWith('1234'));
  assert.ok(!JSON.stringify(s.json).includes('$aact'));                                                  // chave nunca volta ao navegador
  assert.equal((fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777).toString(8), '600');

  r = await api('POST', '/api/settings/bitrix/test', { webhook: 'https://x.bitrix24.com.br/rest/1/abc/' });
  assert.equal(r.status, 400);                                                                           // host falso inalcançável
  r = await api('DELETE', '/api/settings/asaas');
  assert.equal(r.json.ok, true);
  s = await api('GET', '/api/settings'); assert.equal(s.json.asaas.configured, false);
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('valida1234'));
});
