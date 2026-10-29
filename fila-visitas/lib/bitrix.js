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

  // O Bitrix limita as chamadas por segundo (QUERY_LIMIT_EXCEEDED): limita as simultâneas e repete com espera crescente.
  const MAX_SIMULTANEAS = 4;
  let ativas = 0; const fila = [];
  const entra = () => ativas < MAX_SIMULTANEAS ? (ativas++, Promise.resolve()) : new Promise(ok => fila.push(ok));
  const sai = () => { const prox = fila.shift(); if (prox) prox(); else ativas--; };
  const espera = ms => new Promise(r => setTimeout(r, ms));
  const LIMITE = /QUERY_LIMIT_EXCEEDED|TOO_MANY_REQUESTS|OPERATION_TIME_LIMIT/i;

  async function call(method, params = {}, override) {
    const root = override ? String(override).replace(/\/+$/, '') : base;
    if (!root) throw new Error('Webhook do Bitrix24 não configurado');
    const body = new URLSearchParams(flatten(params, '', [])).toString();
    for (let tentativa = 0; ; tentativa++) {
      await entra();
      let r;
      try {
        r = await request(`${root}/${method}.json`, { method: 'POST', timeout: 60000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      } finally { sai(); }
      const err = r.json && r.json.error;
      if ((err && LIMITE.test(String(err))) || r.status === 429 || (r.status === 503 && !r.json)) {
        if (tentativa < 6) { await espera(Math.min(8000, 500 * 2 ** tentativa) + Math.random() * 300); continue; }
      }
      if (!r.json) throw new Error(`Bitrix ${method}: resposta inválida (${r.status})`);
      if (err) {
        const e = new Error(`Bitrix ${method}: ${r.json.error_description || r.json.error}`);
        e.code = r.json.error;
        throw e;
      }
      return r.json;
    }
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
