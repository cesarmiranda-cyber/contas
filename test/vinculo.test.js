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

test('agrupa pelo título "Parcela N de M. …" quando não há marca do Asaas (Asaas desligado); clientes e contratos diferentes não se misturam', async () => {
  const mk = (id, n, comp, rest = 'Renovação Bitrix24 Professional', tot = 12) => deal(id, { TITLE: `Parcela ${n} de ${tot}. ${rest}`, COMPANY_ID: comp, UF_CRM_CR_ASAAS_ID: '' });
  const deals = [mk(1, 4, '5'), mk(2, 5, '5'), mk(3, 6, '5'), mk(4, 4, '6'), mk(5, 5, '5', 'Outro serviço'), deal(6, { TITLE: 'Licença avulsa', COMPANY_ID: '5' })];
  const w = world(deals); w.asaas.enabled = false;
  const ld = await w.svc.loadDeals(); const g = id => ld.find(d => d.id === id);
  assert.equal(g(1).grupo, g(2).grupo); assert.equal(g(2).grupo, g(3).grupo);
  assert.notEqual(g(1).grupo, g(4).grupo);                 // outro cliente
  assert.notEqual(g(1).grupo, g(5).grupo);                 // outro serviço
  assert.equal(g(6).grupo, '');
  assert.deepEqual([g(1).parcelaN, g(1).parcelaTotal], [4, 12]);
  assert.equal(R.parseParcelaTitulo('Parcela 13 de 12. x'), null);
});

test('agrupamento de parcelas manuais: lote do recebimento manual, "Título — n/N" e recorrência', async () => {
  const w = world([]); w.asaas.enabled = true; await w.svc.ensureFields();
  const r1 = await w.svc.cobrar.nova({ tipo: 'manual', titulo: 'Implantação', valor: 3000, venc: today, parcelas: 3, companyId: '5' });
  const r2 = await w.svc.cobrar.nova({ tipo: 'manual', titulo: 'Suporte mensal', valor: 500, venc: today, companyId: '5', recorrencia: { freq: 'mensal', qtd: 4 } });
  const ld = await w.svc.loadDeals();
  const g1 = r1.ids.map(id => ld.find(d => d.id === id).grupo), g2 = ld.filter(d => d.recor).map(d => d.recor.split(':')[0]);
  assert.equal(new Set(g1).size, 1); assert.match(g1[0], /^m_/); assert.equal(g1.length, 3);
  assert.equal(new Set(g2).size, 1); assert.equal(g2.length, 4);
  const deals = [1, 2, 3].map(n => deal(100 + n, { TITLE: `Plano anual — ${n}/3`, COMPANY_ID: '9', UF_CRM_CR_ASAAS_ID: '' }));
  const w2 = world(deals); const l2 = await w2.svc.loadDeals();
  assert.equal(new Set(l2.map(d => d.grupo)).size, 1); assert.ok(l2[0].grupo.startsWith('p_'));
});

test('situação calculada pela data: vencida sem a etapa certa no Bitrix conta como atrasada (filtro, KPI e aging)', async () => {
  const dias = n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const deals = [deal(1, { UF_CRM_CR_VENC: dias(-10), UF_CRM_CR_ASAAS_ID: '' }), deal(2, { UF_CRM_CR_VENC: dias(2), UF_CRM_CR_ASAAS_ID: '' }), deal(3, { UF_CRM_CR_VENC: dias(40), UF_CRM_CR_ASAAS_ID: '' }),
    deal(4, { STAGE_ID: R.STAGES.paid, UF_CRM_CR_VENC: dias(-5), UF_CRM_CR_ASAAS_ID: '' }), deal(5, { STAGE_ID: R.STAGES.cancelled, UF_CRM_CR_ASAAS_ID: '' })];
  const w = world(deals); w.asaas.enabled = false;
  const ld = await w.svc.loadDeals();
  assert.deepEqual([1, 2, 3, 4, 5].map(i => ld.find(d => d.id === i).sit), ['late', 'soon', 'open', 'paid', 'canc']);
  const k = w.svc.kpis(ld);
  assert.equal(k.atrasado.qtd, 1); assert.equal(k.atrasado.valor, 100); assert.equal(k.aberto.qtd, 2); assert.equal(k.pago.qtd, 1); assert.equal(k.aging['1-30'], 100);
});
