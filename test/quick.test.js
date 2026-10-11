'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FORMA_ID, TIPO_ID, today, world, R } = require('../testkit/world');

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const card = (extra = {}) => ({ ID: '7', TITLE: 'Licença Standard', STAGE_ID: R.STAGES.open, OPPORTUNITY: '200', COMPANY_ID: '5', CONTACT_ID: '0', ASSIGNED_BY_ID: '1',
  UF_CRM_CR_FORMA: FORMA_ID('PIX'), UF_CRM_CR_TIPO: TIPO_ID('UNICA'), UF_CRM_CR_VENC: addDays(today, 20) + 'T00:00:00+03:00', ...extra });

test('verificação rápida move o card para Pago assim que o Asaas confirma, sem reler clientes', async () => {
  const w = world([card()]);
  await w.svc.sync();
  const pid = w.deals[0].UF_CRM_CR_ASAAS_ID;
  w.pays[pid].status = 'RECEIVED'; w.pays[pid].paymentDate = today;
  w.calls.length = 0;
  const r = await w.svc.quick();
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.paid);
  assert.equal(r.moved, 1); assert.equal(r.pagos, 1);
  assert.equal(w.deals[0].UF_CRM_CR_PAGO_EM, today);
  assert.ok(!w.calls.some(m => /company\.(get|list)|contact\.(get|list)|requisite/.test(m)));   // não relê clientes
  assert.equal(w.store.lastQuick.moved, 1);
});

test('verificação rápida move por vencimento: próximo, vencido; e respeita edição pendente de vencimento', async () => {
  const w = world([card()]);
  await w.svc.sync();
  const pid = w.deals[0].UF_CRM_CR_ASAAS_ID;
  // vence em 2 dias (dentro da janela de 3) -> Próximo do vencimento
  w.pays[pid].dueDate = addDays(today, 2); w.deals[0].UF_CRM_CR_VENC = addDays(today, 2);
  await w.svc.quick(); assert.equal(w.deals[0].STAGE_ID, R.STAGES.soon);
  // passou do vencimento (Asaas ainda PENDING) -> Atrasado
  w.pays[pid].dueDate = addDays(today, -1); w.deals[0].UF_CRM_CR_VENC = addDays(today, -1);
  await w.svc.quick(); assert.equal(w.deals[0].STAGE_ID, R.STAGES.late);
  // usuário adiou o vencimento no Bitrix (ainda não enviado ao Asaas): a verificação rápida não mexe
  w.deals[0].UF_CRM_CR_VENC = addDays(today, 30);
  const antes = w.deals[0].STAGE_ID;
  await w.svc.quick(); assert.equal(w.deals[0].STAGE_ID, antes);
  await w.svc.sync();                                                   // sync completo envia ao Asaas e reorganiza
  assert.equal(w.pays[pid].dueDate, addDays(today, 30));
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.open);
});

test('card sem cobrança também muda de etapa pelo vencimento', async () => {
  const w = world([card({ COMPANY_ID: '0', UF_CRM_CR_VENC: addDays(today, -3) + 'T00:00:00+03:00' }), card({ ID: '8', TITLE: 'B', COMPANY_ID: '0', UF_CRM_CR_VENC: addDays(today, 1) + 'T00:00:00+03:00' })]);
  await w.svc.quick();                                                   // sem cliente/CPF: não emite, mas organiza
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.late);
  assert.equal(w.deals[1].STAGE_ID, R.STAGES.soon);
  assert.equal(Object.keys(w.pays).length, 0);
});

test('sync completo lê clientes em lote (sem uma chamada por cliente) e informa o tempo de cada fase', async () => {
  const w = world([card({ ID: '1' }), card({ ID: '2', TITLE: 'B' }), card({ ID: '3', TITLE: 'C', COMPANY_ID: '6' })]);
  w.calls.length = 0;
  const r = await w.svc.sync();
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(w.calls.filter(m => m === 'crm.company.get').length, 0);
  assert.ok(w.calls.includes('crm.company.list'));
  for (const f of ['campos', 'lote', 'leitura', 'cards']) assert.equal(typeof r.fases[f], 'number', f);
});
