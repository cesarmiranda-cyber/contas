'use strict';
// Busca de usuários do Bitrix24 pela API da Vibecode, em nome de quem está usando o app (token de sessão injetado pelo gateway).
const BASE = 'https://vibecode.bitrix24.com';
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const crypto = require('crypto');
function createBitrixUsers({ appKey, fetchImpl = fetch } = {}) {
  let cache = { at: 0, list: null };
  const euCache = new Map();   // sha(bearer) -> { at, v }
  // Quem está usando o app, perguntando ao Bitrix24 (fonte confiável do ID e de ser administrador do portal)
  async function eu(bearer) {
    if (!bearer || !appKey) return null;
    const k = crypto.createHash('sha256').update(bearer).digest('hex'), c = euCache.get(k);
    if (c && Date.now() - c.at < (c.v ? 600_000 : 30_000)) return c.v;
    let v = null;
    try {
      const r = await fetchImpl(`${BASE}/v1/users/me`, { headers: { 'X-Api-Key': appKey, Authorization: `Bearer ${bearer}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.success && /^\d{1,12}$/.test(String(j.data?.id))) v = { id: String(j.data.id), nome: [j.data.name, j.data.lastName].filter(Boolean).join(' '), isAdmin: j.data.isAdmin === true ? true : j.data.isAdmin === false ? false : null };
    } catch { /* sem resposta: segue só com o cabeçalho */ }
    euCache.set(k, { at: Date.now(), v }); return v;
  }
  async function todos(bearer) {
    if (cache.list && Date.now() - cache.at < 60_000) return cache.list;
    if (!appKey) { const e = new Error('VIBE_APP_KEY não configurada no servidor.'); e.status = 503; throw e; }
    if (!bearer) { const e = new Error('Sessão do Bitrix24 ausente: abra o app pelo menu do Bitrix24.'); e.status = 401; throw e; }
    const r = await fetchImpl(`${BASE}/v1/users?limit=1000&filter[active]=true`, {
      headers: { 'X-Api-Key': appKey, Authorization: `Bearer ${bearer}` }, redirect: 'manual', signal: AbortSignal.timeout(20_000),
    }).catch(() => { const e = new Error('Não consegui falar com o Bitrix24.'); e.status = 502; throw e; });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) { const e = new Error(`Bitrix24 recusou a busca de usuários (${j.error?.code || r.status}).`); e.status = 502; throw e; }
    const list = (j.data || []).filter(u => !u.userType || u.userType === 'employee').map(u => ({
      id: String(u.id), nome: [u.name, u.lastName].filter(Boolean).join(' ') || u.email || `#${u.id}`,
      email: u.email || '', cargo: u.workPosition || '', foto: /^https:\/\//.test(u.personalPhoto || '') ? u.personalPhoto : '',
    }));
    cache = { at: Date.now(), list };
    return list;
  }
  return {
    eu,
    async buscar(bearer, q) {
      const t = norm(q).trim(); if (t.length < 2) return [];
      return (await todos(bearer)).filter(u => norm(`${u.nome} ${u.email}`).includes(t)).slice(0, 20);
    },
    async porId(bearer, id) { return (await todos(bearer)).find(u => u.id === String(id)) || null; },
  };
}
module.exports = { createBitrixUsers };
