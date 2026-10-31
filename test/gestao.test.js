'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/gestao');
const R = require('../lib/rules');
const { today, world } = require('../testkit/world');

const mes = today.slice(0, 7);
const rec = (o) => ({ id: Math.random(), stageId: R.STAGES.paid, valor: 1000, liquido: 0, venc: today, pagoEm: today, split: '', repasses: '', manual: false, ...o });
const pag = (o) => ({ id: Math.random(), estado: 'pago', valor: 100, valorPago: 0, venc: today, pagoEm: today, origem: 0, categoria: 'Outros', itens: [], lote: 0, beneficiario: 'X', ...o });

test('DRE (caixa): receita por origem, comissão, taxas Asaas, despesas por categoria e resultado', () => {
  const r = [
    rec({ valor: 1000, liquido: 980, split: 'Connect=10%', repasses: '9' }),         // venda com comissão (taxa 20)
    rec({ valor: 500, liquido: 490 }),                                               // venda sem comissão (taxa 10)
    rec({ valor: 300, manual: true, liquido: 300 }),                                 // recebimento avulso
    rec({ valor: 777, stageId: R.STAGES.open, pagoEm: '' }),                         // aberto: não entra no caixa
    rec({ valor: 999, stageId: R.STAGES.cancelled }),                                // cancelado: nunca
  ];
  const c = [
    pag({ valor: 100, origem: 9, categoria: 'Repasse a parceiro', beneficiario: 'Connect' }),
    pag({ valor: 400, categoria: 'Estrutura e software', beneficiario: 'Aluguel' }),
    pag({ valor: 50, categoria: 'Pessoas', valorPago: 55 }),                         // pago a mais: caixa usa o valor pago
    pag({ valor: 900, estado: 'aberto', pagoEm: '' }),                               // não pago: fora do caixa
    pag({ valor: 150, itens: [1, 2], categoria: 'Repasse a parceiro', origem: 9 }),    // consolidado: agrupador, não conta
  ];
  const d = G.dre(r, c, { mes, regime: 'caixa' });
  assert.equal(d.receitaBruta, 1800); assert.equal(d.taxas, 30); assert.equal(d.comissoes, 100);
  assert.equal(d.margem, 1670); assert.equal(d.despesas, 455); assert.equal(d.resultado, 1215);
  assert.deepEqual(d.receitaPorOrigem.map(x => [x.origem, x.valor]), [['comissao', 1000], ['semComissao', 500], ['avulso', 300]]);
  assert.deepEqual(d.despesasPorCategoria.map(x => [x.nome, x.valor]), [['Estrutura e software', 400], ['Pessoas', 55]]);
  assert.equal(d.comissaoPorParceiro[0].nome, 'Connect');
});

test('DRE (competência): usa vencimento e inclui o que ainda não foi pago; contratos-mãe ficam de fora', () => {
  const r = [rec({ stageId: R.STAGES.open, pagoEm: '', valor: 700 }), rec({ stageId: R.STAGES.contrato, valor: 5000 }), rec({ valor: 200, venc: '2001-01-01', pagoEm: '2001-01-01' })];
  const c = [pag({ estado: 'aberto', valor: 120, pagoEm: '' }), pag({ estado: 'consolidado', valor: 80, pagoEm: '', origem: 3 })];
  const d = G.dre(r, c, { mes, regime: 'competencia' });
  assert.equal(d.receitaBruta, 700);                                                    // só o aberto deste mês: o contrato-mãe e o título de 2001 ficam fora
  assert.equal(d.aReceber, 700); assert.equal(d.comissoes, 80); assert.equal(d.despesas, 120); assert.equal(d.aPagar, 200);
  const s = G.serie(r, c, { mes, regime: 'competencia', meses: 3 });
  assert.equal(s.length, 3); assert.equal(s[2].mes, mes);
  assert.equal(G.addMes('2026-01', -1), '2025-12');
});

test('recebimento manual: cria títulos sem Asaas (com parcelas e comissão), baixa e desfaz a baixa; repasse nasce da baixa', async () => {
  const w = world([]); const { svc } = w;
  w.asaas.enabled = true;
  await svc.ensureFields(); await svc.pagar.ensure();
  const A = (await svc.pagar.salvarParceiro({ nome: 'Connect Think', perc: 10, base: 'BRUTO' })).id;
  w.customers = w.customers || {};
  const r = await svc.cobrar.nova({ tipo: 'manual', titulo: 'Comissão Bitrix', valor: 1000, venc: today, parcelas: 2, companyId: '5', split: 'Connect Think=10%' });
  assert.equal(r.parcelas, 2);
  const all = await svc.loadDeals();
  const kids = all.filter(d => r.ids.includes(d.id));
  assert.ok(kids.every(k => k.manual && !k.asaasId));
  assert.equal(kids.reduce((a, k) => a + k.valor, 0), 1000);
  await svc.sync();                                                     // não pode emitir cobrança no Asaas para manual
  assert.equal(Object.keys(w.pays).length, 0);
  const c0 = (await svc.loadDeals()).find(d => d.id === r.ids[0]);
  await assert.rejects(() => svc.createCharge(c0), /manual/i);
  await svc.baixaManual(c0, { valor: 500, forma: 'Pix' });
  const pago = (await svc.loadDeals()).find(d => d.id === r.ids[0]);
  assert.equal(pago.stageId, R.STAGES.paid); assert.equal(pago.pagoEm, today);
  await assert.rejects(() => svc.baixaManual(pago, {}), /já está pago/);
  await svc.sync();                                                     // recebido → repasse liberado para o parceiro
  const reps = (await svc.pagar.contas()).filter(x => x.origem === r.ids[0]);
  assert.equal(reps.length, 1); assert.equal(reps[0].valor, 50);
  await svc.desfazerBaixa(pago);
  assert.notEqual((await svc.loadDeals()).find(d => d.id === r.ids[0]).stageId, R.STAGES.paid);
});
