'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.ASAAS_MIN_GAP_MS = '0';
process.env.ASAAS_RETRY_BASE_MS = '5';
const { createAsaas } = require('../lib/asaas');

const listen = h => new Promise(ok => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok(s)); });
const HTML = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><HTML><HEAD><TITLE>ERROR</TITLE></HEAD></HTML>';

test('repete com pausa quando o Asaas responde página HTML de erro e depois funciona', async t => {
  let hits = 0;
  const srv = await listen((q, r) => {
    hits++;
    if (hits <= 2) { r.writeHead(403, { 'Content-Type': 'text/html' }); return r.end(HTML); }
    r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ id: 'pay_1', status: 'PENDING' }));
  });
  t.after(() => srv.close());
  process.env.ASAAS_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  const a = createAsaas({ apiKey: 'k' });
  const p = await a.getPayment('pay_1');
  assert.equal(p.id, 'pay_1'); assert.equal(hits, 3);
});

test('erro persistente vira mensagem curta, sem despejar HTML', async t => {
  const srv = await listen((q, r) => { r.writeHead(403, { 'Content-Type': 'text/html' }); r.end(HTML); });
  t.after(() => srv.close());
  process.env.ASAAS_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  const a = createAsaas({ apiKey: 'k' });
  await assert.rejects(() => a.getPayment('x'), e => /recusou a requisição \(HTTP 403\)/.test(e.message) && !/DOCTYPE|<HTML/i.test(e.message));
});

test('erro de negócio (401/400 com JSON) não é repetido', async t => {
  let hits = 0;
  const srv = await listen((q, r) => { hits++; r.writeHead(401, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ errors: [{ description: 'chave inválida' }] })); });
  t.after(() => srv.close());
  process.env.ASAAS_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  const a = createAsaas({ apiKey: 'k' });
  await assert.rejects(() => a.getPayment('x'), /chave inválida/);
  assert.equal(hits, 1);
});
