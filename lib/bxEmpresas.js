'use strict';
// Cadastro de empresas do Bitrix24 (crm/company) como ÚNICA origem de clientes dos processos — evita duplicidade.
const { norm } = require('./feriados');
const digits = v => String(v || '').replace(/\D/g, '');
const GENERICAS = new Set(['LTDA', 'ME', 'EPP', 'EIRELI', 'SA', 'S', 'A', 'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'RESTAURANTE', 'PADARIA', 'CHURRASCARIA', 'LANCHONETE', 'BAR', 'SHOP', 'SHOPPING', 'LOJA', 'UNIDADE', 'FILIAL']);
const ABREV = { SAC: 'SACOLAO', STA: 'SANTA', CHUR: 'CHURRASCARIA', P: 'PIZZARIA', PIZ: 'PIZZARIA' };
const tokens = s => norm(s).split(' ').map(t => ABREV[t] || t).filter(t => t && !GENERICAS.has(t));
const chave = s => tokens(s).join(' ');
// similaridade 0..1 entre dois nomes (Jaccard dos termos relevantes); número no fim (unidade 1, 2…) precisa coincidir
function similar(a, b) {
  const ta = tokens(a), tb = tokens(b); if (!ta.length || !tb.length) return 0;
  const na = ta.filter(t => /^\d+$/.test(t)), nb = tb.filter(t => /^\d+$/.test(t)); if (na.join() !== nb.join() && (na.length || nb.length)) return 0;
  const A = new Set(ta), B = new Set(tb); let i = 0; for (const t of A) if (B.has(t)) i++;
  return i / (A.size + B.size - i);
}
function createBxEmpresas({ bitrix, ttl = 5 * 60 * 1000 }) {
  let cache = { at: 0, lista: [], campos: null, host: '' };
  const host = () => { try { return bitrix.enabled ? new URL(bitrix.base).host : ''; } catch { return ''; } };
  async function campos() {
    if (cache.campos) return cache.campos;
    const r = (await bitrix.call('crm.company.userfield.list', {})).result || [], por = {};
    for (const f of r) { const l = String(f.EDIT_FORM_LABEL?.br || f.EDIT_FORM_LABEL?.pt || f.EDIT_FORM_LABEL || f.LIST_COLUMN_LABEL || '').trim().toLowerCase(); if (l && !por[l]) por[l] = f.FIELD_NAME; }
    cache.campos = { cnpj: por['cnpj'] || '', cidade: por['cidade'] || por['município'] || por['municipio'] || '', uf: por['estado'] || '', razao: por['razão social'] || por['razao social'] || '' };
    return cache.campos;
  }
  async function listar(force) {
    if (!bitrix.enabled) { const e = new Error('Conecte o webhook do Bitrix24 em Configurações → Integrações para usar o cadastro de empresas.'); e.status = 409; throw e; }
    if (!force && Date.now() - cache.at < ttl && cache.lista.length) return cache.lista;
    const c = await campos(), sel = ['ID', 'TITLE', ...Object.values(c).filter(Boolean)], out = []; let start = 0;
    for (let i = 0; i < 100; i++) {
      const r = await bitrix.call('crm.company.list', { select: sel, order: { ID: 'ASC' }, start });
      for (const x of r.result || []) out.push({ id: String(x.ID), nome: x.TITLE || `Empresa ${x.ID}`, cnpj: digits(x[c.cnpj]), cidade: String(x[c.cidade] || '').trim(), uf: String(x[c.uf] || '').trim().toUpperCase().slice(0, 2), razao: x[c.razao] || '' });
      if (r.next === undefined) break; start = r.next;
    }
    cache = { ...cache, at: Date.now(), lista: out, host: host() }; return out;
  }
  return {
    host, listar, campos,
    invalida() { cache.at = 0; },
    async porId(id) { return (await listar()).find(e => e.id === String(id)) || null; },
    async buscar(q, lim = 15) {
      const t = norm(q); const l = await listar(); if (!t) return l.slice(0, lim);
      return l.filter(e => norm(e.nome).includes(t) || norm(e.razao).includes(t) || (digits(q).length >= 4 && e.cnpj.includes(digits(q)))).slice(0, lim);
    },
    porCnpj: async c => { const d = digits(c); return d.length === 14 ? (await listar()).filter(e => e.cnpj === d) : []; },
    sugestoes: async (nome, n = 3) => (await listar()).map(e => ({ e, s: similar(nome, e.nome) })).filter(x => x.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, n).map(x => ({ ...x.e, similaridade: Math.round(x.s * 100) / 100 })),
    // cria a empresa no Bitrix (sempre depois de checar CNPJ/nome iguais, para não duplicar)
    async criar({ nome, cnpj, cidade, uf }) {
      const l = await listar(true), d = digits(cnpj);
      const dup = l.find(e => (d.length === 14 && e.cnpj === d) || chave(e.nome) === chave(nome));
      if (dup) { const e = new Error(`Já existe no Bitrix24 a empresa "${dup.nome}" (ID ${dup.id}). Vincule em vez de criar.`); e.status = 409; e.existente = dup; throw e; }
      const c = await campos(), fields = { TITLE: String(nome).slice(0, 255), COMPANY_TYPE: 'CUSTOMER' };
      if (c.cnpj && d.length === 14) fields[c.cnpj] = d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
      if (c.cidade && cidade) fields[c.cidade] = cidade; if (c.uf && uf) fields[c.uf] = uf;
      const r = await bitrix.call('crm.company.add', { fields }); cache.at = 0;
      return { id: String(r.result), nome, cnpj: d, cidade: cidade || '', uf: uf || '' };
    },
  };
}
module.exports = { createBxEmpresas, similar, chave, digits };
