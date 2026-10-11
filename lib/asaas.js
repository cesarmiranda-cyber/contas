'use strict';
const { request } = require('./http');

// Cliente Asaas v3. ASAAS_ENV=sandbox|production.
function createAsaas({ apiKey, env = 'sandbox' }) {
  const base = env === 'production' ? 'https://api.asaas.com/v3' : 'https://sandbox.asaas.com/api/v3';
  const enabled = !!apiKey;

  async function call(method, path, body) {
    if (!enabled) throw new Error('ASAAS_API_KEY não configurada');
    const r = await request(base + path, {
      method,
      headers: { access_token: apiKey, 'Content-Type': 'application/json', 'User-Agent': 'contas-receber-manda4' },
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
    enabled, env, base,
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
