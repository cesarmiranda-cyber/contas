'use strict';
const { request } = require('./http');

// Permissões do Bitrix24: consulta os itens (SPA) COMO o usuário logado, usando a sessão que o gateway da Vibe repassa
// (X-Vibe-Authorization). O Bitrix só devolve o que aquele usuário pode ver; o app nunca mostra mais do que isso.
function createAcesso({ apiKey, base = 'https://vibecode.bitrix24.com', log = () => {} }) {
  const cache = new Map();
  const TTL = 60e3;
  async function ids(bearer, entityTypeId) {
    if (!apiKey || !bearer) return null;          // sem sessão do usuário não há como consultar: segue só com as regras do app
    const chave = `${bearer.slice(-24)}|${entityTypeId}`;
    const c = cache.get(chave);
    if (c && Date.now() - c.em < TTL) return c.ids;
    try {
      const r = await request(`${base}/v1/items/${entityTypeId}/search`, {
        method: 'POST', timeout: 60000,
        headers: { 'X-Api-Key': apiKey, Authorization: bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: {}, limit: 5000, select: ['id'] }),
      });
      const lista = Array.isArray(r.json?.data) ? r.json.data : (r.json?.data?.items || r.json?.items);
      if (!r.ok || !Array.isArray(lista)) throw new Error(`resposta ${r.status}: ${String(r.text).slice(0, 160)}`);
      const set = new Set(lista.map(i => +(i.id ?? i.ID)).filter(Boolean));
      cache.set(chave, { em: Date.now(), ids: set });
      return set;
    } catch (e) { log(`Permissões do Bitrix não consultadas (${entityTypeId}): ${e.message}`); return null; }
  }
  return { ids, limpa: () => cache.clear() };
}
module.exports = { createAcesso };
