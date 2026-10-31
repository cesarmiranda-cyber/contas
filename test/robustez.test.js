'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { today, world, R } = require('../testkit/world');

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
async function pronto() {
  const w = world([]); await w.svc.pagar.ensure(); const p = w.svc.pagar;
  const A = (await p.salvarParceiro({ nome: 'Connect Think' })).id;
  return { w, p, A };
}
const conta = (p, o) => p.criarConta({ categoria: 'Repasse a parceiro', ...o }).then(r => r.ids[0]);

test('split: ponto decimal não vira milhar (R$ 50.00 = 50, 12.5% = 12,5%), pt-BR continua valendo', () => {
  const ws = [{ nome: 'P', walletId: '11111111-1111-1111-1111-111111111111' }];
  assert.equal(R.parseSplit('P=R$ 50.00', ws)[0].fixedValue, 50);
  assert.equal(R.parseSplit('P=12.5%', ws)[0].percentualValue, 12.5);
  assert.equal(R.parseSplit('P=R$ 1.234,56', ws)[0].fixedValue, 1234.56);
  assert.equal(R.parseSplit('P=R$ 1.234', ws)[0].fixedValue, 1234);
  assert.equal(R.parseSplit('P=30%', ws)[0].percentualValue, 30);
});

test('clique duplo em "pagar" não paga duas vezes', async () => {
  const { w, p, A } = await pronto();
  const id = await conta(p, { titulo: 'x', valor: 100, venc: addDays(today, 3), parceiroId: A });
  const r = await Promise.allSettled([p.pagarConta(id, { valor: 100 }), p.pagarConta(id, { valor: 100 })]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(w.comments.filter(c => c.ENTITY_ID == id && /Pago em/.test(c.COMMENT)).length, 1);
});

test('duas consolidações simultâneas dos mesmos títulos: só uma vale', async () => {
  const { w, p, A } = await pronto();
  const a = await conta(p, { titulo: 'a', valor: 10, venc: addDays(today, 3), parceiroId: A }), b = await conta(p, { titulo: 'b', valor: 10, venc: addDays(today, 3), parceiroId: A });
  const r = await Promise.allSettled([p.consolidar({ ids: [a, b] }), p.consolidar({ ids: [a, b] })]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
  const rs = p.resumoContas(await p.contas());
  assert.equal(rs.aPagar.valor, 20); assert.equal(rs.aPagar.qtd, 1);
});

test('validações: valor infinito/negativo, data inexistente e consolidado com valor pago ínfimo', async () => {
  const { p, A } = await pronto();
  await assert.rejects(() => p.criarConta({ titulo: 'x', valor: 'Infinity', venc: addDays(today, 3), parceiroId: A }), /Valor inválido/);
  await assert.rejects(() => p.criarConta({ titulo: 'x', valor: -5, venc: addDays(today, 3), parceiroId: A }), /Valor inválido/);
  await assert.rejects(() => p.criarConta({ titulo: 'x', valor: 10, venc: '2026-02-31', parceiroId: A }), /vencimento/i);
  const a = await conta(p, { titulo: 'a', valor: 100, venc: addDays(today, 3), parceiroId: A }), b = await conta(p, { titulo: 'b', valor: 100, venc: addDays(today, 3), parceiroId: A });
  const c = await p.consolidar({ ids: [a, b] });
  await assert.rejects(() => p.pagarConta(c.id, { valor: 0.001 }), /inválido|pequeno/);
  const livre = await conta(p, { titulo: 'livre', valor: 5, venc: addDays(today, 3), parceiroId: A });
  await assert.rejects(() => p.editarConta(livre, { forma: 'Split Asaas' }), /Split Asaas/);
});

test('pagamento do consolidado ignora filho cancelado e não redistribui o que já foi baixado', async () => {
  const { w, p, A } = await pronto();
  const ids = []; for (const v of [100, 100, 100]) ids.push(await conta(p, { titulo: 't' + v, valor: v, venc: addDays(today, 3), parceiroId: A }));
  const c = await p.consolidar({ ids });
  await p.pagarConta(c.id, { valor: 300 });
  const todas = await p.contas();
  assert.equal(todas.filter(x => ids.includes(x.id)).reduce((a, x) => a + x.valorPago, 0), 300);
  await p.tickDatas();                                                            // reconciliação não pode alterar o total
  assert.equal((await p.contas()).filter(x => ids.includes(x.id)).reduce((a, x) => a + x.valorPago, 0), 300);
});
