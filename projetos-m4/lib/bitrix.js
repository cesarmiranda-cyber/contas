'use strict';
// Cliente do webhook de entrada do Bitrix24 (https://portal/rest/1/CODIGO/). Sem dependências.
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, out); else out.push([key, v == null ? '' : String(v)]);
  }
  return out;
}
function createBitrix(webhook = '') {
  let base = String(webhook).replace(/\/+$/, '');
  async function call(method, params = {}, override) {
    const root = override ? String(override).replace(/\/+$/, '') : base; if (!root) throw new Error('Webhook do Bitrix24 não configurado.');
    let r; try {
      r = await fetch(`${root}/${method}.json`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(flatten(params, '', [])).toString() });
    } catch (e) { throw Object.assign(new Error(`Bitrix24 indisponível (${e.cause?.code || e.name}).`), { rede: true }); }
    const j = await r.json().catch(() => null); if (!j) throw new Error(`Bitrix ${method}: resposta inválida (${r.status}).`);
    if (j.error) throw Object.assign(new Error(`Bitrix ${method}: ${j.error_description || j.error}`), { code: j.error });
    return j;
  }
  return { call, get base() { return base; }, get enabled() { return !!base; }, configure(w) { base = String(w || '').replace(/\/+$/, ''); } };
}
module.exports = { createBitrix };
