'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const http = require('http'); const { createBitrix } = require('../lib/bitrix');

test('listAll busca as páginas restantes em paralelo, na ordem e sem repetir', async () => {
  const TOTAL = 230, vistos = []; let simult = 0, pico = 0;
  const srv = http.createServer((q, r) => { let b = ''; q.on('data', c => b += c); q.on('end', async () => {
    const start = +new URLSearchParams(b).get('start') || 0; vistos.push(start); simult++; pico = Math.max(pico, simult);
    await new Promise(s => setTimeout(s, 30));
    const items = Array.from({ length: Math.min(50, TOTAL - start) }, (_, i) => ({ id: start + i + 1 }));
    simult--; r.end(JSON.stringify({ result: { items }, total: TOTAL, ...(start + 50 < TOTAL ? { next: start + 50 } : {}) }));
  }); });
  await new Promise(ok => srv.listen(0, ok));
  const bx = createBitrix(`http://localhost:${srv.address().port}/rest/1/x/`);
  const t0 = Date.now(), r = await bx.listAll('crm.item.list', {});
  srv.close();
  assert.equal(r.length, TOTAL); assert.deepEqual(r.map(x => x.id), Array.from({ length: TOTAL }, (_, i) => i + 1));
  assert.ok(pico > 1 && pico <= 4, `paralelismo ${pico}`);            // paralelo, mas respeitando o semáforo de 4
});
