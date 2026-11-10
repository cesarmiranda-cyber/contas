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
test('senha única: aceita a certa, bloqueia após 5 erros', () => {
  const a = createAuth({ portal: 'p', secret: 's' });
  assert.equal(a.verificar(a.entrarSenha('abc', 'abc', '1.1.1.1')).id, '0');
  for (let i = 0; i < 5; i++) assert.equal(a.entrarSenha('x', 'abc', '2.2.2.2'), null);
  assert.equal(a.entrarSenha('abc', 'abc', '2.2.2.2'), 'bloqueado');
});
