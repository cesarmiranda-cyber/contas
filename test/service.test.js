'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createService } = require('../lib/service');
const { createStore } = require('../lib/store');
const R = require('../lib/rules');

function fakes(deals) {
  const calls = [];
  const bitrix = {
    async call(m, p) {
      calls.push([m, p]);
      if (m === 'crm.deal.userfield.list') return { result: [] };
      if (m === 'crm.company.get') return { result: { TITLE: 'ACME Ltda', UF_CRM_CNPJ: '11.222.333/0001-81', EMAIL: [{ VALUE: 'fin@acme.com' }], PHONE: [{ VALUE: '11999990000' }] } };
      if (m === 'crm.requisite.list') return { result: [] };
      if (m === 'crm.deal.update') { Object.assign(deals.find(d => d.ID == p.id), p.fields); return { result: true }; }
      return { result: true };
    },
    async listAll() { return deals; },
  };
  const pays = {};
  const asaas = {
    enabled: true,
    async listPayments({ externalReference }) { return { data: Object.values(pays).filter(x => x.externalReference === externalReference) }; },
    async findOrCreateCustomer() { return { id: 'cus_1' }; },
    async createPayment(b) { const p = { id: 'pay_' + (Object.keys(pays).length + 1), status: 'PENDING', invoiceUrl: 'https://asaas/i/1', ...b }; pays[p.id] = p; return p; },
    async getPayment(id) { return pays[id]; },
    async cancelPayment() {},
  };
  return { bitrix, asaas, pays, calls };
}

test('emite cobrança, concilia pagamento e aciona a régua sem duplicar', async () => {
  const today = R.todayBR();
  const due = R.addMonths(today, 0); // vence hoje -> D0
  const deals = [{ ID: '10', TITLE: 'Implantação — 1/2', STAGE_ID: R.STAGES.open, OPPORTUNITY: '500', COMPANY_ID: '5', CONTACT_ID: '0', ASSIGNED_BY_ID: '1', UF_CRM_CR_VENC: due + 'T03:00:00+03:00', UF_CRM_CR_FORMA: 'PIX' }];
  const { bitrix, asaas, pays } = fakes(deals);
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')));
  store.setConfig({ reguaAtiva: true });
  const svc = createService({ bitrix, asaas, store });

  const r1 = await svc.sync();
  assert.equal(r1.errors.length, 0, r1.errors.join(';'));
  assert.equal(r1.created, 1);
  assert.equal(Object.keys(pays).length, 1);
  assert.equal(pays.pay_1.value, 500); assert.equal(pays.pay_1.billingType, 'PIX');
  assert.equal(deals[0].UF_CRM_CR_ASAAS_ID, 'pay_1');
  assert.equal(deals[0].STAGE_ID, R.STAGES.soon);     // vence hoje -> próximo do vencimento
  assert.equal(r1.reminders, 1);                        // D0
  assert.match(deals[0].UF_CRM_CR_GATILHO, /^D0\|/);

  const r2 = await svc.sync();                          // 2º sync: sem duplicar cobrança nem lembrete
  assert.equal(r2.created, 0); assert.equal(r2.reminders, 0); assert.equal(Object.keys(pays).length, 1);

  pays.pay_1.status = 'RECEIVED'; pays.pay_1.paymentDate = today;
  const r3 = await svc.sync();
  assert.equal(deals[0].STAGE_ID, R.STAGES.paid);
  assert.equal(r3.moved, 1);
  const r4 = await svc.sync();                          // pago não recebe mais lembrete
  assert.equal(r4.reminders, 0);
});

test('não emite cobrança sem CPF/CNPJ e marca pendência', async () => {
  const deals = [{ ID: '11', TITLE: 'Sem doc', STAGE_ID: R.STAGES.open, OPPORTUNITY: '100', COMPANY_ID: '0', CONTACT_ID: '0', UF_CRM_CR_VENC: '2099-01-01T00:00:00+03:00' }];
  const { bitrix, asaas, pays } = fakes(deals);
  const svc = createService({ bitrix, asaas, store: createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'))) });
  const r = await svc.sync();
  assert.equal(r.created, 0); assert.equal(Object.keys(pays).length, 0);
  const d = (await svc.dealsCached(0))[0];
  assert.ok(d.pendencias.some(p => /CPF\/CNPJ/.test(p.msg)));
});

test('gerar cria uma deal por parcela no funil 90', async () => {
  const added = [];
  const bitrix = { async call(m, p) { if (m === 'crm.deal.add') { added.push(p.fields); return { result: 100 + added.length }; } return { result: [] }; }, async listAll() { return []; } };
  const svc = createService({ bitrix, asaas: { enabled: false }, store: createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'))) });
  const r = await svc.gerar({ titulo: 'Plano', tipo: 'PARCELADO', total: 100, parcelas: 3, primeiroVenc: '2026-11-10', companyId: '5', forma: 'boleto' });
  assert.equal(r.ids.length, 3);
  assert.ok(added.every(f => f.CATEGORY_ID === 90 && f.STAGE_ID === R.STAGES.open && f.UF_CRM_CR_FORMA === 'BOLETO'));
  assert.equal(added.reduce((a, f) => a + f.OPPORTUNITY, 0).toFixed(2), '100.00');
});

test('classifica por categoria/plano e agrupa os valores', async () => {
  const today = R.todayBR();
  const deals = [
    { ID: '1', TITLE: 'Licença Professional Vibe+', STAGE_ID: R.STAGES.open, OPPORTUNITY: '1000', COMPANY_ID: '5', UF_CRM_CR_VENC: today },
    { ID: '2', TITLE: 'Licença Basic', STAGE_ID: R.STAGES.late, OPPORTUNITY: '300', COMPANY_ID: '5', UF_CRM_CR_VENC: '2020-01-01' },
    { ID: '3', TITLE: 'Projeto ERP', STAGE_ID: R.STAGES.open, OPPORTUNITY: '5000', COMPANY_ID: '5', UF_CRM_CR_VENC: '2099-01-01', UF_CRM_CR_CATEGORIA: '11' },
  ];
  const lists = { UF_CRM_CR_CATEGORIA: R.CATEGORIAS, UF_CRM_CR_PLANO: R.PLANOS };
  const bitrix = {
    async call(m, p) {
      if (m === 'crm.deal.userfield.list') return { result: Object.entries(lists).map(([n, l]) => ({ FIELD_NAME: n, LIST: l.map((v, i) => ({ ID: String(n.endsWith('CATEGORIA') ? 10 + i : 20 + i), VALUE: v })) })) };
      if (m === 'crm.company.get') return { result: { TITLE: 'ACME', UF_CRM_CNPJ: '11.222.333/0001-81', EMAIL: [{ VALUE: 'a@b.c' }] } };
      if (m === 'crm.requisite.list') return { result: [] };
      if (m === 'crm.deal.update') { Object.assign(deals.find(d => d.ID == p.id), p.fields); return { result: true }; }
      return { result: [] };
    },
    async listAll() { return deals; },
  };
  const svc = createService({ bitrix, asaas: { enabled: false }, store: createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'))) });
  const r = await svc.sync();
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(r.classified, 2);                       // 1 e 2 citam o plano; 3 já tinha categoria
  const all = await svc.dealsCached(0);
  const by = id => all.find(d => d.id === id);
  assert.equal(by(1).categoria, 'Licença Bitrix24'); assert.equal(by(1).plano, 'Professional Vibe+');
  assert.equal(by(3).categoria, 'Serviço / Projeto'); assert.equal(by(3).plano, '');
  const k = svc.kpis(all);
  const lic = k.porCategoria.find(g => g.nome === 'Licença Bitrix24');
  assert.equal(lic.aReceber, 1300); assert.equal(lic.atrasado, 300);
  assert.equal(k.porPlano.find(g => g.nome === 'Basic').atrasado, 300);
  await assert.rejects(() => svc.classify(by(1), 'Inexistente', ''), /Categoria inexistente/);
});
