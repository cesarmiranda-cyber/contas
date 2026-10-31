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
  let nextId = 500, nextCo = 50, nextFieldId = 1000, nextStatus = 9000;
  // Campos personalizados criados em tempo de execução (listas ganham ids como no Bitrix)
  const dealFields = userfields(), companyFields = [];
  const addField = (arr, f) => {
    const x = { ID: String(nextFieldId++), FIELD_NAME: 'UF_CRM_' + f.FIELD_NAME, USER_TYPE_ID: f.USER_TYPE_ID, SETTINGS: f.SETTINGS || {} };
    if (f.LIST) x.LIST = f.LIST.map(i => ({ ID: String(nextFieldId++), VALUE: i.VALUE }));
    arr.push(x); return x;
  };
  // Funis: o 90 (Contas) já existe; categorias novas nascem com as etapas padrão do Bitrix
  const categories = [{ ID: '90', NAME: 'Contas' }];
  const statuses = { DEAL_STAGE_90: [{ ID: '1', STATUS_ID: 'GERAR' }, { ID: '2', STATUS_ID: 'CONTRATADO' }] };
  const DEFAULT_STAGES = [['NEW', 'Novo', 10], ['PREPARATION', 'Preparação', 20], ['PREPAYMENT_INVOICE', 'Fatura de pré-pagamento', 30], ['EXECUTING', 'Em execução', 40], ['FINAL_INVOICE', 'Fatura final', 50], ['WON', 'Negócio fechado', 60], ['LOSE', 'Negócio perdido', 70], ['APOLOGY', 'Analisar falha', 80]];
  const catOf = d => String(d.CATEGORY_ID ?? 90);
  const bitrix = {
    async call(m, p) {
      calls.push(m);
      switch (m) {
        case 'crm.deal.userfield.list': return { result: dealFields };
        case 'crm.deal.userfield.add': return { result: addField(dealFields, p.fields).ID };
        case 'crm.company.userfield.list': return { result: companyFields };
        case 'crm.company.userfield.add': return { result: addField(companyFields, p.fields).ID };
        case 'crm.dealcategory.list': return { result: categories };
        case 'crm.dealcategory.add': { const id = String(93 + categories.length); categories.push({ ID: id, NAME: p.fields.NAME }); statuses['DEAL_STAGE_' + id] = DEFAULT_STAGES.map(([k, n, so]) => ({ ID: String(nextStatus++), STATUS_ID: `C${id}:${k}`, NAME: n, SORT: so })); return { result: id }; }
        case 'crm.status.list': return { result: statuses[p.filter?.ENTITY_ID] || [] };
        case 'crm.status.add': { const e = p.fields.ENTITY_ID, id = e.split('_').pop(); (statuses[e] ||= []).push({ ID: String(nextStatus++), STATUS_ID: `C${id}:${p.fields.STATUS_ID}`, NAME: p.fields.NAME, SORT: p.fields.SORT }); return { result: true }; }
        case 'crm.status.update': { for (const l of Object.values(statuses)) { const x = l.find(y => y.ID == p.id); if (x) Object.assign(x, p.fields); } return { result: true }; }
        case 'crm.status.delete': { for (const k of Object.keys(statuses)) statuses[k] = statuses[k].filter(y => y.ID != p.id); return { result: true }; }
        case 'crm.company.get': return { result: companies[p.id] || { TITLE: 'ACME Ltda', UF_CRM_CNPJ: '11.222.333/0001-81', EMAIL: [{ VALUE: 'fin@acme.com' }] } };
        case 'crm.company.list': {
          if (p.filter?.COMPANY_TYPE) return { result: Object.values(companies).filter(c => p.filter.COMPANY_TYPE.includes(c.COMPANY_TYPE)) };
          return { result: (p.filter?.ID || []).map(id => ({ ID: String(id), TITLE: 'ACME Ltda', UF_CRM_CNPJ: '11.222.333/0001-81', EMAIL: [{ VALUE: 'fin@acme.com' }] })) };
        }
        case 'crm.deal.get': return { result: deals.find(d => d.ID == p.id) || {} };
        case 'crm.company.add': { const id = String(nextCo++); companies[id] = { ID: id, TITLE: p.fields.TITLE, EMAIL: (p.fields.EMAIL || []).map((e, i) => ({ ID: 'm' + id + i, ...e })), PHONE: (p.fields.PHONE || []).map((e, i) => ({ ID: 'p' + id + i, ...e })), ...Object.fromEntries(Object.entries(p.fields).filter(([k]) => k !== 'EMAIL' && k !== 'PHONE')) }; return { result: id }; }
        case 'crm.company.update': { const c = companies[p.id] || (companies[p.id] = { ID: String(p.id), TITLE: 'Empresa ' + p.id }); for (const [k, v] of Object.entries(p.fields)) { if (k === 'EMAIL' || k === 'PHONE') c[k] = v.map((x, i) => ({ ID: x.ID || 'n' + i, VALUE: x.VALUE, VALUE_TYPE: x.VALUE_TYPE })); else c[k] = v; } return { result: true }; }
        case 'crm.requisite.list': return { result: [] };
        case 'crm.duplicate.findbycomm': return { result: {} };
        case 'crm.deal.add': { const d = { ID: String(nextId++), ...p.fields }; deals.push(d); return { result: d.ID }; }
        case 'crm.deal.delete': { const i = deals.findIndex(d => d.ID == p.id); if (i >= 0) deals.splice(i, 1); return { result: true }; }
        case 'crm.deal.update': Object.assign(deals.find(d => d.ID == p.id), p.fields); return { result: true };
        case 'crm.timeline.comment.add': comments.push(p.fields); return { result: 1 };
        default: return { result: true };
      }
    },
    async listAll(method, p) {
      if (method === 'crm.company.list') return (await bitrix.call(method, p)).result;
      const cat = p?.filter?.CATEGORY_ID;
      return cat === undefined ? deals : deals.filter(d => catOf(d) === String(cat));
    },
  };
  const pays = {}, subs = {}, customers = { cus_x: { id: 'cus_x', name: 'Cliente Direto SA', cpfCnpj: '11222333000181', email: 'x@y.com' } };
  let np = 1;
  const cancelled = [], updates = [], gets = [];
  const installments = {}, receipts = [], refunds = [], links = [], deletedLinks = [], subUpdates = [], subCancelled = [], created = [];
  const opts = { autoFirst: false, failCreate: null, noPix: false };
  const addMonths = (d, n) => R.addMonths(d, n);
  const asaas = {
    enabled: true,
    async listPayments({ externalReference }) { return { data: Object.values(pays).filter(x => x.externalReference === externalReference) }; },
    async findOrCreateCustomer() { return { id: 'cus_1' }; },
    async createPayment(b) {
      if (opts.failCreate) { const e = new Error(opts.failCreate); e.status = 400; throw e; }
      created.push(b);
      if (b.installmentCount) {
        const inst = 'inst_' + (Object.keys(installments).length + 1), n = b.installmentCount, each = Math.round((b.totalValue / n) * 100) / 100, arr = [];
        for (let i = 0; i < n; i++) {
          const { installmentCount, totalValue, ...rest } = b;
          const p = { ...rest, id: 'pay_' + np++, status: 'PENDING', value: each, dueDate: addMonths(b.dueDate, i), installment: inst, installmentNumber: i + 1, invoiceUrl: `https://asaas/i/${np}`, bankSlipUrl: `https://asaas/b/${np}` };
          pays[p.id] = p; arr.push(p);
        }
        installments[inst] = arr; return arr[0];
      }
      const p = { id: 'pay_' + np++, status: 'PENDING', invoiceUrl: 'https://asaas/i', bankSlipUrl: 'https://asaas/b', ...b }; pays[p.id] = p; return p;
    },
    async getPayment(id) { gets.push(id); return pays[id]; },
    async activePayments() { return Object.values(pays).filter(p => ['PENDING', 'OVERDUE'].includes(p.status)); },
    async getCustomer(id) { return customers[id] || { id, name: 'Cliente ' + id }; },
    async installmentPayments(id) { return { data: installments[id] || [] }; },
    async identificationField(id) { return { identificationField: '00190.00009 01234.567890 12345.678901 1 99990000012345' }; },
    async pixQrCode(id) { if (opts.noPix) throw new Error('Pix indisponível'); return { payload: `00020126PIX${id}`, encodedImage: 'iVBORw0KGgo' }; },
    async receiveInCash(id, b) { receipts.push([id, b]); Object.assign(pays[id], { status: 'RECEIVED_IN_CASH', paymentDate: b.paymentDate }); },
    async refund(id, b) { refunds.push([id, b]); pays[id].status = 'REFUND_REQUESTED'; },
    async createPaymentLink(b) { links.push(b); return { id: 'lnk_' + links.length, url: `https://asaas/l/${links.length}`, ...b }; },
    async deletePaymentLink(id) { deletedLinks.push(id); },
    async createSubscription(b) {
      if (opts.failCreate) { const e = new Error(opts.failCreate); e.status = 400; throw e; }
      const s = { id: 'sub_' + (Object.keys(subs).length + 1), status: 'ACTIVE', ...b }; subs[s.id] = s;
      if (opts.autoFirst) { const p = { id: 'pay_' + np++, status: 'PENDING', value: b.value, dueDate: b.nextDueDate, billingType: b.billingType, customer: b.customer, subscription: s.id, invoiceUrl: 'https://asaas/i/sub' }; pays[p.id] = p; }
      return s;
    },
    async allSubscriptions() { return Object.values(subs); },
    async updateSubscription(id, b) { subUpdates.push([id, b]); const m = { value: 'value', nextDueDate: 'nextDueDate', cycle: 'cycle', billingType: 'billingType', description: 'description', status: 'status' }; for (const [k, v] of Object.entries(b)) if (m[k]) subs[id][m[k]] = v; return subs[id]; },
    async cancelSubscription(id) { subCancelled.push(id); subs[id].status = 'INACTIVE'; },
    async subscriptionPayments(id) { return { data: Object.values(pays).filter(p => p.subscription === id) }; },
    async allPayments() { return Object.values(pays); },
    async cancelPayment(id) { pays[id].status = 'DELETED'; cancelled.push(id); },
    async updatePayment(id, b) { updates.push([id, b]); Object.assign(pays[id], b); return pays[id]; },
  };
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')));
  const emails = [];
  const mailer = { ok: true, configured() { return this.ok; }, async send(m) { if (!this.ok) throw new Error('não configurado'); emails.push(m); return { ok: true, para: [].concat(m.to).flatMap(x => String(x).split(/[;,]/)).map(x => x.trim()).filter(Boolean), cc: m.cc ? [].concat(m.cc).flatMap(x => String(x).split(/[;,]/)).map(x => x.trim()).filter(Boolean) : [] }; } };
  const svc = createService({ bitrix, asaas, store, mailer });
  return { deals, comments, pays, subs, asaas, svc, store, customers, cancelled, updates, gets, calls, emails, mailer, companies, categories, statuses, dealFields, companyFields, installments, receipts, refunds, links, deletedLinks, subUpdates, subCancelled, created, opts };
}

module.exports = { userfields, FORMA_ID, TIPO_ID, today, in10, world, R };
