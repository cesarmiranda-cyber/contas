'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAuth } = require('../auth');

const fetchOk = async () => ({ json: async () => ({ result: { ID: '42' } }) });
test('troca AUTH_ID do portal certo por token válido', async () => {
  const a = createAuth({ portal: 'p.bitrix24.com.br', secret: 's', fetchImpl: fetchOk });
  const t = await a.entrar({ authId: 'x', domain: 'p.bitrix24.com.br' });
  assert.equal(a.verificar(t).id, '42');
});
test('recusa outro domínio, token adulterado e token vencido', async () => {
  let n = 1000; const a = createAuth({ portal: 'p.bitrix24.com.br', secret: 's', fetchImpl: fetchOk, now: () => n, ttlMs: 10 });
  assert.equal(await a.entrar({ authId: 'x', domain: 'falso.com' }), null);
  const t = await a.entrar({ authId: 'x', domain: 'p.bitrix24.com.br' });
  assert.equal(a.verificar(t.slice(0, -2) + 'aa'), null);
  n += 11; assert.equal(a.verificar(t), null);
});
