'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FORMA_ID, TIPO_ID, today, in10, world, R } = require('../testkit/world');

const master = (extra = {}) => ({ ID: '1', TITLE: 'Contrato Implantação', STAGE_ID: R.STAGES.gerar, OPPORTUNITY: '300', COMPANY_ID: '5', CONTACT_ID: '0', ASSIGNED_BY_ID: '1',
  UF_CRM_CR_TIPO: TIPO_ID('PARCELADO'), UF_CRM_CR_FORMA: FORMA_ID('PIX'), UF_CRM_CR_QTD: '3', UF_CRM_CR_VENC: R.addMonths(today, 1) + 'T00:00:00+03:00', ...extra });

test('contrato parcelado vira N cards + N cobranças, sem duplicar', async () => {
  const w = world([master()]);
  const r1 = await w.svc.sync();
  assert.equal(r1.errors.length, 0, r1.errors.join(';'));
  assert.equal(r1.contratos, 1);
  const kids = w.deals.filter(d => d.UF_CRM_CR_ORIGEM == 1);
  assert.equal(kids.length, 3);
  assert.deepEqual(kids.map(k => k.UF_CRM_CR_PARCELA), ['1/3', '2/3', '3/3']);
  assert.equal(kids.reduce((a, k) => a + k.OPPORTUNITY, 0), 300);
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.contrato);
  assert.equal(w.deals[0].UF_CRM_CR_FILHOS.split(',').length, 3);
  assert.equal(Object.keys(w.pays).length, 3);                          // cobranças emitidas para os filhos
  assert.ok(Object.values(w.pays).every(p => p.billingType === 'PIX' && p.value === 100));
  await w.svc.sync();
  assert.equal(w.deals.filter(d => d.UF_CRM_CR_ORIGEM == 1).length, 3); // nada novo
  assert.equal(Object.keys(w.pays).length, 3);
  const k = w.svc.kpis(await w.svc.dealsCached(0));
  assert.equal(k.aberto.valor, 300);                                    // contrato fora dos totais (sem contar em dobro)
});

test('contrato incompleto fica na etapa e avisa uma única vez', async () => {
  const w = world([master({ COMPANY_ID: '0', UF_CRM_CR_QTD: '1' })]);
  await w.svc.sync(); await w.svc.sync();
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.gerar);
  assert.equal(w.deals.length, 1);
  assert.equal(w.comments.length, 1);
  assert.match(w.comments[0].COMMENT, /cliente/);
  assert.match(w.comments[0].COMMENT, /parcelas/);
});

test('recorrente sem fim cria assinatura; meses novos viram cards ligados ao contrato', async () => {
  const w = world([master({ UF_CRM_CR_TIPO: TIPO_ID('RECORRENTE'), UF_CRM_CR_QTD: '', OPPORTUNITY: '99.9' })]);
  w.store.setConfig({ importAuto: true });
  const r1 = await w.svc.sync();
  assert.equal(r1.errors.length, 0, r1.errors.join(';'));
  assert.equal(Object.keys(w.subs).length, 1);
  assert.equal(w.subs.sub_1.cycle, 'MONTHLY'); assert.equal(w.subs.sub_1.value, 99.9);
  assert.equal(w.deals[0].UF_CRM_CR_ASSINATURA, 'sub_1');
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.contrato);
  // o Asaas gera a cobrança do mês seguinte
  w.pays.pay_9 = { id: 'pay_9', status: 'PENDING', value: 99.9, dueDate: in10, billingType: 'PIX', customer: 'cus_x', subscription: 'sub_1', invoiceUrl: 'u' };
  const r2 = await w.svc.sync();
  assert.equal(r2.importados, 1);
  const card = w.deals.find(d => d.UF_CRM_CR_ASAAS_ID === 'pay_9');
  assert.ok(card); assert.equal(card.UF_CRM_CR_ORIGEM, 1); assert.equal(card.COMPANY_ID, '5');
  assert.equal((await w.svc.sync()).importados, 0);                      // idempotente
  assert.equal(Object.keys(w.subs).length, 1);                           // não recria a assinatura
});

test('importa do Asaas o que não tem card, cria o cliente e respeita status', async () => {
  const w = world([]);
  w.pays.p1 = { id: 'p1', status: 'OVERDUE', value: 200, dueDate: R.addMonths(today, -1), billingType: 'BOLETO', customer: 'cus_x', description: 'Licença Standard Vibe+', invoiceUrl: 'u1' };
  w.pays.p2 = { id: 'p2', status: 'RECEIVED', value: 50, dueDate: R.addMonths(today, -1), billingType: 'PIX', customer: 'cus_x', description: 'Consultoria', paymentDate: today };
  w.pays.p3 = { id: 'p3', status: 'DELETED', value: 70, dueDate: today, billingType: 'PIX', customer: 'cus_x' };
  const previa = await w.svc.importar({ dias: 90, dryRun: true });
  assert.equal(previa.novos, 2); assert.equal(w.deals.length, 0);        // prévia não grava nada
  const r = await w.svc.importar({ dias: 90 });
  assert.equal(r.novos, 2); assert.equal(w.deals.length, 2);
  const late = w.deals.find(d => d.UF_CRM_CR_ASAAS_ID === 'p1'), paid = w.deals.find(d => d.UF_CRM_CR_ASAAS_ID === 'p2');
  assert.equal(late.STAGE_ID, R.STAGES.late); assert.equal(paid.STAGE_ID, R.STAGES.paid);
  assert.equal(late.UF_CRM_CR_CATEGORIA, '100'); assert.equal(late.UF_CRM_CR_PLANO, String(200 + R.PLANOS.indexOf('Standard Vibe+')));
  assert.equal(late.UF_CRM_CR_FORMA, FORMA_ID('BOLETO'));
  assert.equal(late.COMPANY_ID, paid.COMPANY_ID);                        // mesmo cliente reaproveitado (1 empresa criada)
  assert.equal((await w.svc.importar({ dias: 90 })).novos, 0);           // segunda vez: nada
});
