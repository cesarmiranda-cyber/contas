'use strict';
const { request } = require('./http');
// Cliente do webhook de entrada (BITRIX_WEBHOOK = https://portal/rest/1/token/): semáforo de 4 chamadas e repetição em QUERY_LIMIT_EXCEEDED.
function createBitrix(webhook, { limit = 4 } = {}) {
  let base = String(webhook || '').replace(/\/+$/, '');
  let ativas = 0; const fila = [];
  const acquire = () => new Promise(ok => { if (ativas < limit) { ativas++; ok(); } else fila.push(ok); });
  const release = () => { const n = fila.shift(); if (n) n(); else ativas--; };
  const flatten = (obj, prefix, out) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v !== null && typeof v === 'object') flatten(v, key, out);
      else out.push([key, v === null || v === undefined ? '' : String(v)]);
    }
    return out;
  };
  async function call(method, params = {}) {
    if (!base) { const e = new Error('Webhook do Bitrix24 não configurado'); e.status = 503; throw e; }
    await acquire();
    try {
      for (let t = 0; ; t++) {
        const r = await request(`${base}/${method}.json`, {
          method: 'POST', retries: /\.(add|delete|complete)$/.test(method) ? 0 : 2,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(flatten(params, '', [])).toString(),
        });
        if (r.json?.error === 'QUERY_LIMIT_EXCEEDED' && t < 5) { await new Promise(s => setTimeout(s, 600 * (t + 1))); continue; }
        if (!r.json) throw new Error(`Bitrix ${method}: resposta inválida (${r.status})`);
        if (r.json.error) { const e = new Error(`Bitrix ${method}: ${r.json.error_description || r.json.error}`); e.code = r.json.error; throw e; }
        return r.json;
      }
    } finally { release(); }
  }
  // Lista paginada: lê a 1ª página, e se o Bitrix informar o total busca as demais em paralelo (o semáforo limita a 4 chamadas simultâneas).
  const itensDe = r => (Array.isArray(r.result) ? r.result : (r.result?.items || []));
  async function listAll(method, params = {}) {
    const first = await call(method, { ...params, start: 0 }), out = [...itensDe(first)];
    if (first.next === undefined || first.next === null) return out;
    const total = +first.total;
    if (Number.isFinite(total) && total > first.next) {
      const starts = []; for (let st = first.next; st < total; st += first.next || 50) starts.push(st);
      for (let i = 0; i < starts.length; i += 8) for (const r of await Promise.all(starts.slice(i, i + 8).map(st => call(method, { ...params, start: st })))) out.push(...itensDe(r));
      const vistos = new Set();       // deslocamento concorrente a gravações pode repetir um item
      return out.filter(x => { const k = x?.id ?? x?.ID; if (k === undefined) return true; if (vistos.has(k)) return false; vistos.add(k); return true; });
    }
    let start = first.next;
    for (;;) {
      const r = await call(method, { ...params, start });
      out.push(...itensDe(r));
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    return out;
  }
  return { call, listAll, get enabled() { return !!base; }, get base() { return base; }, configure(w) { base = String(w || '').replace(/\/+$/, ''); } };
}
module.exports = { createBitrix };
