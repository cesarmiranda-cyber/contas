'use strict';
// Funis (categorias de negócio) do Bitrix24: etapas por nome, negócios do funil, criação e mudança de etapa.
const { norm } = require('./feriados');
function createBxFunil({ bitrix, ttl = 10 * 60 * 1000 }) {
  const cache = new Map();
  async function estagios(cat, force) {
    const k = String(cat), c = cache.get(k);
    if (!force && c && Date.now() - c.at < ttl) return c.lista;
    const r = (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: `DEAL_STAGE_${cat}` }, order: { SORT: 'ASC' } })).result || [];
    const lista = r.map(x => ({ id: x.STATUS_ID, nome: x.NAME, semantica: x.SEMANTICS || '' })); cache.set(k, { at: Date.now(), lista }); return lista;
  }
  // etapa pelo trecho do nome (sem acento/maiúscula): "Protocolado" → { id: 'C14:...', nome }
  const achaEtapa = async (cat, trecho) => { const t = norm(trecho); return (await estagios(cat)).find(e => norm(e.nome).includes(t)) || null; };
  async function negocios(cat, extra = []) {
    const out = []; let start = 0;
    for (let i = 0; i < 100; i++) {
      const r = await bitrix.call('crm.deal.list', { filter: { CATEGORY_ID: cat }, select: ['ID', 'TITLE', 'COMPANY_ID', 'CONTACT_ID', 'STAGE_ID', 'CLOSED', 'ASSIGNED_BY_ID', 'CLOSEDATE', 'DATE_CREATE', ...extra], order: { ID: 'ASC' }, start });
      out.push(...(r.result || [])); if (r.next === undefined) break; start = r.next;
    }
    return out;
  }
  return {
    estagios, achaEtapa, negocios,
    // campos de negócio pelo rótulo (ex.: "Tipo de contrato") com os itens das listas: { 'tipo de contrato': { cod, itens: {id: valor} } }
    async camposNegocio() {
      const f = (await bitrix.call('crm.deal.fields', {})).result || {}, out = {};
      for (const [cod, v] of Object.entries(f)) if (/^UF_/.test(cod)) { const l = String(v.formLabel || v.listLabel || '').trim().toLowerCase(); if (l && !out[l]) out[l] = { cod, itens: Object.fromEntries((v.items || []).map(i => [String(i.ID), i.VALUE])) }; }
      return out;
    },
    async criar(fields) { const r = await bitrix.call('crm.deal.add', { fields }); return String(r.result); },
    async mover(dealId, stageId) { await bitrix.call('crm.deal.update', { id: dealId, fields: { STAGE_ID: stageId } }); },
    nomeDaEtapa: async (cat, id) => ((await estagios(cat)).find(e => e.id === id) || {}).nome || '',
  };
}
module.exports = { createBxFunil };
