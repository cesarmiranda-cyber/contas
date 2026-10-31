'use strict';
const { request } = require('./http');

// Cliente do webhook de entrada do Bitrix24 (BITRIX_WEBHOOK = https://portal/rest/1/token/).
function createBitrix(webhook) {
  let base = String(webhook || '').replace(/\/+$/, '');

  function flatten(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v !== null && typeof v === 'object') flatten(v, key, out);
      else out.push([key, v === null || v === undefined ? '' : String(v)]);
    }
    return out;
  }

  async function call(method, params = {}, override) {
    const root = override ? String(override).replace(/\/+$/, '') : base;
    if (!root) throw new Error('Webhook do Bitrix24 não configurado');
    const body = new URLSearchParams(flatten(params, '', []));
    const r = await request(`${root}/${method}.json`, {
      method: 'POST',
      retries: /\.(add|delete)$/.test(method) ? 0 : 2,      // criar de novo após falha de rede pode duplicar card/comentário
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.json) throw new Error(`Bitrix ${method}: resposta inválida (${r.status})`);
    if (r.json.error) {
      const e = new Error(`Bitrix ${method}: ${r.json.error_description || r.json.error}`);
      e.code = r.json.error;
      throw e;
    }
    return r.json;
  }

  // Lista paginada (50 por página) até esgotar.
  async function listAll(method, params = {}) {
    const out = [];
    let start = 0;
    for (;;) {
      const r = await call(method, { ...params, start });
      const res = Array.isArray(r.result) ? r.result : (r.result?.items || []);
      out.push(...res);
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    return out;
  }

  return {
    call, listAll,
    get base() { return base; },
    get enabled() { return !!base; },
    configure(w) { base = String(w || '').replace(/\/+$/, ''); },
  };
}
module.exports = { createBitrix };
