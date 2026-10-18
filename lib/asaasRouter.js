'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

// Faz o app falar com a conta Asaas certa. Cada empresa pode ter a própria chave; quem não tem usa a conta padrão.
// Dentro de `as(empresaId, fn)` todas as chamadas vão para o cliente da empresa (propaga por await, sem mudar o código chamador).
//   base: cliente padrão · clientFor(id): cliente da empresa (ou null) · allClients(): clientes de todas as empresas
function createAsaasRouter({ base, clientFor, allClients = () => [] }) {
  const als = new AsyncLocalStorage();
  const current = () => {
    const id = als.getStore();
    const own = id ? clientFor(id) : null;
    return own && own.enabled ? own : base;
  };
  const own = {
    as: (empresaId, fn) => als.run(empresaId ? String(empresaId) : null, fn),
    // para laços de sincronização: vale até o próximo use(); chame use(null) ao terminar
    use: empresaId => als.enterWith(empresaId ? String(empresaId) : null),
    get empresaAtual() { return als.getStore() || null; },
    get enabled() { return als.getStore() ? current().enabled : base.enabled || allClients().some(c => c.enabled); },
    // lote de cobranças em aberto de todas as contas (os ids do Asaas são únicos entre contas)
    activePayments: async () => {
      const clients = [base, ...allClients()].filter((c, i, a) => c.enabled && a.indexOf(c) === i);
      const out = [];
      for (const c of clients) out.push(...await c.activePayments());
      return out;
    },
  };
  return new Proxy(own, {
    get(t, k) {
      if (k in t) return t[k];
      const c = current(), v = c[k];
      return typeof v === 'function' ? v.bind(c) : v;
    },
  });
}
module.exports = { createAsaasRouter };
