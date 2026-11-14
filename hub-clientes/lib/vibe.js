'use strict';
// Cliente da API Vibecode (https://vibecode.bitrix24.com/v1) — lê/escreve o CRM do Bitrix24 com a chave do app.
function createVibe({ base = 'https://vibecode.bitrix24.com/v1', key = '', fetchImpl = globalThis.fetch } = {}) {
  async function call(method, path, { query, body } = {}) {
    if (!key) { const e = new Error('VIBE_KEY não configurada no servidor'); e.status = 503; throw e; }
    const url = new URL(base.replace(/\/+$/, '') + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const r = await fetchImpl(url, {
      method, signal: AbortSignal.timeout(60000),
      headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.success === false) {
      const e = new Error(`Vibe ${method} ${path}: ${j?.error?.message || r.status}`);
      e.status = r.status === 404 ? 404 : 502; throw e;
    }
    return j.data;
  }
  return {
    get: (p, query) => call('GET', p, { query }),
    post: (p, body) => call('POST', p, { body }),
    patch: (p, body) => call('PATCH', p, { body }),
    get enabled() { return !!key; },
  };
}
module.exports = { createVibe };
