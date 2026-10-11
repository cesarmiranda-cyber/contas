'use strict';
const { request } = require('./http');

// Cliente do webhook de entrada do Bitrix24 (BITRIX_WEBHOOK = https://portal/rest/1/token/).
function createBitrix(webhook) {
  const base = String(webhook || '').replace(/\/+$/, '');
  if (!base) throw new Error('BITRIX_WEBHOOK não configurado');

  function flatten(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v !== null && typeof v === 'object') flatten(v, key, out);
      else out.push([key, v === null || v === undefined ? '' : String(v)]);
    }
    return out;
  }

  async function call(method, params = {}) {
    const body = new URLSearchParams(flatten(params, '', []));
    const r = await request(`${base}/${method}.json`, {
      method: 'POST',
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

  return { call, listAll, base };
}
module.exports = { createBitrix };
