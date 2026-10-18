'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizaWebhook, checkWebhook } = require('../lib/secrets');

test('webhook do Bitrix: aceita colagens com pequenos deslizes e explica o erro', () => {
  const ok = 'https://nutrimix.bitrix24.com.br/rest/1/abc123xyz/';
  for (const v of [ok, ok.slice(0, -1), `  ${ok}\n`, '"' + ok + '"', 'nutrimix.bitrix24.com.br/rest/1/abc123xyz', ok + 'profile.json', ok + 'crm.deal.list', '<' + ok + '>']) {
    assert.equal(normalizaWebhook(v), ok, v); assert.equal(checkWebhook(normalizaWebhook(v)), null, v);
  }
  assert.match(checkWebhook(''), /Cole a URL do webhook/);                       // campo vazio: mensagem clara (antes dizia só "URL inválida")
  assert.match(checkWebhook(normalizaWebhook('só o código abc123')), /Formato esperado|não parece um endereço/);
  assert.match(checkWebhook(normalizaWebhook('http://nutrimix.bitrix24.com.br/rest/1/abc/')), /https/);
  assert.match(checkWebhook(normalizaWebhook('https://127.0.0.1/rest/1/abc/')), /não permitido/);   // endereços internos continuam barrados
  assert.match(checkWebhook(normalizaWebhook('https://localhost/rest/1/abc/')), /não permitido/);
  assert.match(checkWebhook(normalizaWebhook('https://nutrimix.bitrix24.com.br/outra/coisa')), /Formato esperado/);
});
