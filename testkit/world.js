'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { createService } = require('../lib/service');
const { createStore } = require('../lib/store');
const R = require('../lib/rules');

function userfields() {
  const L = { CR_CATEGORIA: R.CATEGORIAS, CR_PLANO: R.PLANOS, CR_TIPO: R.TIPOS.map(t => t.label), CR_FORMA: R.FORMAS.map(f => f.label) };
  const base = { CR_CATEGORIA: 100, CR_PLANO: 200, CR_TIPO: 300, CR_FORMA: 400 };
  return Object.entries(L).map(([n, l]) => ({ ID: String(base[n]), FIELD_NAME: 'UF_CRM_' + n, USER_TYPE_ID: 'enumeration', LIST: l.map((v, i) => ({ ID: String(base[n] + i), VALUE: v })) }));
}
const FORMA_ID = c => String(400 + R.FORMAS.findIndex(f => f.code === c));
const TIPO_ID = c => String(300 + R.TIPOS.findIndex(t => t.code === c));
const today = R.todayBR();
const in10 = R.addMonths(today, 1);

function world(initial = []) {
  const deals = [...initial];
  const companies = {};
  const comments = [];
  const calls = [];
  let nextId = 500, nextCo = 50;
  const bitrix = {
    async call(m, p) {
      calls.push(m);
      switch (m) {
        case 'crm.deal.userfield.list': return { result: userfields() };
        case 'crm.status.list': return { result: [{ STATUS_ID: 'GERAR' }, { STATUS_ID: 'CONTRATADO' }] };
        case 'crm.company.get': return { result: companies[p.id] || { TITLE: 'ACME Ltda', UF_CRM_CNPJ: '11.222.333/0001-81', EMAIL: [{ VALUE: 'fin@acme.com' }] } };
        case 'crm.company.list': return { result: (p.filter?.ID || []).map(id => ({ ID: String(id), TITLE: 'ACME Ltda', UF_CRM_CNPJ: '11.222.333/0001-81', EMAIL: [{ VALUE: 'fin@acme.com' }] })) };
        case 'crm.deal.get': return { result: deals.find(d => d.ID == p.id) || {} };
        case 'crm.company.add': { const id = String(nextCo++); companies[id] = { ID: id, TITLE: p.fields.TITLE, EMAIL: p.fields.EMAIL || [] }; return { result: id }; }
        case 'crm.requisite.list': return { result: [] };
        case 'crm.duplicate.findbycomm': return { result: {} };
        case 'crm.deal.add': { const d = { ID: String(nextId++), ...p.fields }; deals.push(d); return { result: d.ID }; }
        case 'crm.deal.update': Object.assign(deals.find(d => d.ID == p.id), p.fields); return { result: true };
        case 'crm.timeline.comment.add': comments.push(p.fields); return { result: 1 };
        default: return { result: true };
      }
    },
    async listAll() { return deals; },
  };
  const pays = {}, subs = {}, customers = { cus_x: { id: 'cus_x', name: 'Cliente Direto SA', cpfCnpj: '11222333000181', email: 'x@y.com' } };
  let np = 1;
  const cancelled = [], updates = [], gets = [];
  const asaas = {
    enabled: true,
    async listPayments({ externalReference }) { return { data: Object.values(pays).filter(x => x.externalReference === externalReference) }; },
    async findOrCreateCustomer() { return { id: 'cus_1' }; },
    async createPayment(b) { const p = { id: 'pay_' + np++, status: 'PENDING', invoiceUrl: 'https://asaas/i', ...b }; pays[p.id] = p; return p; },
    async getPayment(id) { gets.push(id); return pays[id]; },
    async activePayments() { return Object.values(pays).filter(p => ['PENDING', 'OVERDUE'].includes(p.status)); },
    async getCustomer(id) { return customers[id]; },
    async createSubscription(b) { const s = { id: 'sub_' + (Object.keys(subs).length + 1), ...b }; subs[s.id] = s; return s; },
    async subscriptionPayments(id) { return { data: Object.values(pays).filter(p => p.subscription === id) }; },
    async allPayments() { return Object.values(pays); },
    async cancelPayment(id) { pays[id].status = 'DELETED'; cancelled.push(id); },
    async updatePayment(id, b) { updates.push([id, b]); Object.assign(pays[id], b); return pays[id]; },
  };
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')));
  const svc = createService({ bitrix, asaas, store });
  return { deals, comments, pays, subs, asaas, svc, store, customers, cancelled, updates, gets, calls };
}

module.exports = { userfields, FORMA_ID, TIPO_ID, today, in10, world, R };
