'use strict';
const { request } = require('./http');

const BASES = { production: 'https://api.asaas.com/v3', sandbox: 'https://sandbox.asaas.com/api/v3' };

// Cliente Asaas v3, reconfigurável em tempo de execução (tela de Configurações).
// ASAAS_BASE_URL permite apontar para um servidor falso nos testes.
function createAsaas({ apiKey, env = 'sandbox' } = {}) {
  const st = { apiKey: apiKey || '', env: env === 'production' ? 'production' : 'sandbox' };
  const baseOf = e => process.env.ASAAS_BASE_URL || BASES[e];

  async function call(method, path, body, override) {
    const key = override ? override.apiKey : st.apiKey;
    const base = baseOf(override ? override.env : st.env);
    if (!key) throw new Error('ASAAS_API_KEY não configurada');
    const r = await request(base + path, {
      method,
      headers: { access_token: key, 'Content-Type': 'application/json', 'User-Agent': 'contas-receber-manda4' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const msg = r.json?.errors?.map(e => e.description).join('; ') || r.text?.slice(0, 200) || r.status;
      const e = new Error(`Asaas ${method} ${path}: ${msg}`);
      e.status = r.status;
      throw e;
    }
    return r.json;
  }

  const onlyDigits = s => String(s || '').replace(/\D/g, '');

  async function findOrCreateCustomer({ name, cpfCnpj, email, phone }) {
    const doc = onlyDigits(cpfCnpj);
    const found = await call('GET', `/customers?cpfCnpj=${doc}&limit=1`);
    if (found.data?.length) return found.data[0];
    const body = { name, cpfCnpj: doc, notificationDisabled: false };
    if (email) body.email = email;
    const ph = onlyDigits(phone);
    if (ph.length >= 10) body.mobilePhone = ph.slice(-11);
    return call('POST', '/customers', body);
  }

  return {
    get enabled() { return !!st.apiKey; },
    get env() { return st.env; },
    get base() { return baseOf(st.env); },
    configure({ apiKey: k, env: e }) { if (k !== undefined) st.apiKey = k || ''; if (e) st.env = e === 'production' ? 'production' : 'sandbox'; },
    // Testa uma chave sem salvá-la: saldo (prova que a chave vale) + nome da conta, quando disponível.
    async test({ apiKey: k, env: e }) {
      const o = { apiKey: k, env: e === 'production' ? 'production' : 'sandbox' };
      const bal = await call('GET', '/finance/balance', null, o);
      let nome = '';
      try { const c = await call('GET', '/myAccount/commercialInfo', null, o); nome = c.companyName || c.name || ''; } catch { /* opcional */ }
      return { saldo: bal.balance, nome };
    },
    balance: () => call('GET', '/finance/balance'),
    findOrCreateCustomer,
    createPayment: p => call('POST', '/payments', p),
    getPayment: id => call('GET', `/payments/${id}`),
    cancelPayment: id => call('DELETE', `/payments/${id}`),
    pixQrCode: id => call('GET', `/payments/${id}/pixQrCode`),
    identificationField: id => call('GET', `/payments/${id}/identificationField`),
    listPayments: q => call('GET', `/payments?${new URLSearchParams(q)}`),
    getCustomer: id => call('GET', `/customers/${id}`),
    createSubscription: b => call('POST', '/subscriptions', b),
    listSubscriptions: q => call('GET', `/subscriptions?${new URLSearchParams(q)}`),
    cancelSubscription: id => call('DELETE', `/subscriptions/${id}`),
    subscriptionPayments: (id, q = {}) => call('GET', `/subscriptions/${id}/payments?${new URLSearchParams({ limit: 100, ...q })}`),
    // Percorre todas as páginas de /payments (100 por vez).
    async allPayments(q = {}) {
      const out = [];
      for (let offset = 0; offset < 20000; offset += 100) {
        const r = await call('GET', `/payments?${new URLSearchParams({ ...q, limit: 100, offset })}`);
        out.push(...(r.data || []));
        if (!r.hasMore) break;
      }
      return out;
    },
  };
}
module.exports = { createAsaas };
