'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { today, world, R } = require('../testkit/world');

const deal = (id, o = {}) => ({ ID: String(id), TITLE: `Parcela ${id}`, STAGE_ID: R.STAGES.open, OPPORTUNITY: '100', COMPANY_ID: '0', CONTACT_ID: '0', UF_CRM_CR_VENC: today, UF_CRM_CR_ASAAS_ID: 'pay_' + id, ...o });

test('vincular: liga cobranças importadas a um cliente do Bitrix, lembra o cliente do Asaas e registra a venda de origem', async () => {
  const deals = [deal(1), deal(2), deal(3, { UF_CRM_CR_DOC: '11222333000181' })];
  const w = world(deals); await w.svc.ensureFields();
  const r = await w.svc.vincular({ ids: [1, 2, 3], companyId: 5, vendaId: '777' });
  assert.equal(r.vinculadas, 3);
  assert.ok(deals.every(d => String(d.COMPANY_ID) === '5' && d.UF_CRM_CR_VENDA === '777'));
  assert.equal(deals[2].CONTACT_ID, '');
  assert.equal(w.store.customerMap()['11222333000181'].companyId, '5');          // próxima importação desse CNPJ cai no mesmo cliente
  assert.ok(w.comments.some(c => /Vinculada ao cliente/.test(c.COMMENT)));
  await assert.rejects(() => w.svc.vincular({ ids: [1], companyId: 5, contactId: 9 }), /OU/);
  await assert.rejects(() => w.svc.vincular({ ids: [999], companyId: 5 }), /não encontrada/);
  await assert.rejects(() => w.svc.vincular({ ids: [], companyId: 5 }), /1 a 200/);
  const so = await w.svc.vincular({ ids: [1], vendaId: '' });                    // limpar só a venda
  assert.equal(so.vinculadas, 1); assert.equal(deals[0].UF_CRM_CR_VENDA, '');
});

test('organizar parcelas: marca cada cobrança com o parcelamento/assinatura de origem (agrupa na lista)', async () => {
  const deals = [deal(10), deal(11), deal(12), deal(13)];
  const w = world(deals); await w.svc.ensureFields();
  w.pays.pay_10 = { id: 'pay_10', installment: 'ins_A', status: 'PENDING' }; w.pays.pay_11 = { id: 'pay_11', installment: 'ins_A', status: 'RECEIVED' };
  w.pays.pay_12 = { id: 'pay_12', subscription: 'sub_Z', status: 'PENDING' }; w.pays.pay_13 = { id: 'pay_13', status: 'PENDING' };
  const r = await w.svc.organizarParcelas();
  assert.equal(r.atualizadas, 3);
  assert.deepEqual(deals.map(d => d.UF_CRM_CR_GRUPO || ''), ['i_ins_A', 'i_ins_A', 's_sub_Z', '']);
  assert.equal((await w.svc.organizarParcelas()).atualizadas, 0);                 // idempotente
  const ld = await w.svc.loadDeals(); assert.equal(ld.find(d => d.id === 11).grupo, 'i_ins_A');
});
