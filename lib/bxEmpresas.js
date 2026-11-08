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
// Um nome está "contido" no outro quando o menor tem ao menos 2 termos relevantes e todos aparecem no maior (ex.: "Freeze LOJA 1" ⊂ "Freeze LOJA 1 - Itaim").
function contido(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b)); const [p, g] = A.size <= B.size ? [A, B] : [B, A]; if (p.size < 2) return false;
  for (const t of p) if (!g.has(t)) return false; return true;
}
// Empresa única que casa com o nome (igual, quase igual ou contido); null quando não há ou há dúvida.
function acharUnica(nome, lista) {
  const ex = lista.filter(e => chave(e.nome) === chave(nome) || similar(nome, e.nome) >= 0.8); if (ex.length === 1) return ex[0]; if (ex.length > 1) return null;
  const c = lista.filter(e => contido(nome, e.nome)); return c.length === 1 ? c[0] : null;
}
function createBxEmpresas({ bitrix, ttl = 5 * 60 * 1000 }) {
  let cache = { at: 0, lista: [], campos: null, host: '' };
  const host = () => { try { return bitrix.enabled ? new URL(bitrix.base).host : ''; } catch { return ''; } };
  async function campos() {
    if (cache.campos) return cache.campos;
    const por = {}, add = (cod, rot) => { const l = String(rot || '').trim().toLowerCase(); if (l && cod && !por[l]) por[l] = cod; };
    // crm.company.fields traz os rótulos (formLabel); userfield.list em alguns portais devolve os rótulos vazios.
    try { const f = (await bitrix.call('crm.company.fields', {})).result || {}; for (const [cod, v] of Object.entries(f)) if (/^UF_/.test(cod)) add(cod, v.formLabel || v.listLabel || (v.title !== cod ? v.title : '')); } catch { /* tenta o outro */ }
    if (!Object.keys(por).length) { const r = (await bitrix.call('crm.company.userfield.list', {})).result || []; for (const f of r) { const l = f.EDIT_FORM_LABEL; add(f.FIELD_NAME, (l && (l.br || l.pt || l.en)) || (typeof l === 'string' ? l : '') || f.LIST_COLUMN_LABEL); } }
    cache.campos = { cnpj: por['cnpj'] || '', cidade: por['cidade'] || por['município'] || por['municipio'] || '', uf: por['estado'] || '', razao: por['razão social'] || por['razao social'] || '',
      situacao: por['situação'] || por['situacao'] || '', categoria: por['categoria'] || '', alvara: por['alvará/licença sanitária'] || '', validadeAlvara: por['validade do alvará/cmvs'] || '', validadeTreino: por['validade dos certificados de treinamento'] || '', cep: por['cep'] || '', bairro: por['bairro'] || '' };
    return cache.campos;
  }
  async function listar(force) {
    if (!bitrix.enabled) { const e = new Error('Conecte o webhook do Bitrix24 em Configurações → Integrações para usar o cadastro de empresas.'); e.status = 409; throw e; }
    if (!force && Date.now() - cache.at < ttl && cache.lista.length) return cache.lista;
    const c = await campos(), sel = ['ID', 'TITLE', 'EMAIL', 'ASSIGNED_BY_ID', ...Object.values(c).filter(Boolean)], out = []; let start = 0;
    for (let i = 0; i < 100; i++) {
      const r = await bitrix.call('crm.company.list', { select: sel, order: { ID: 'ASC' }, start });
      for (const x of r.result || []) out.push({ id: String(x.ID), nome: x.TITLE || `Empresa ${x.ID}`, cnpj: digits(x[c.cnpj]), cidade: String(x[c.cidade] || '').trim(), uf: String(x[c.uf] || '').trim().toUpperCase().slice(0, 2), razao: x[c.razao] || '',
        email: (Array.isArray(x.EMAIL) ? x.EMAIL : []).map(e => String(e.VALUE || '').trim().toLowerCase()).find(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) || '', responsavel: String(x.ASSIGNED_BY_ID || ''),
        situacao: String(x[c.situacao] || '').trim(), categoria: String(x[c.categoria] || '').trim(), alvara: String(x[c.alvara] || '').trim(), validadeAlvara: String(x[c.validadeAlvara] || '').slice(0, 10), validadeTreino: String(x[c.validadeTreino] || '').slice(0, 10) });
      if (r.next === undefined) break; start = r.next;
    }
    cache = { ...cache, at: Date.now(), lista: out, host: host() }; return out;
  }
  return {
    host, listar, campos,
    invalida() { cache.at = 0; },
    // Contatos do Bitrix24 ligados à empresa (o contato do cliente no cronograma vem daqui).
    async contatos(empresaId) {
      if (!bitrix.enabled) { const e = new Error('Conecte o webhook do Bitrix24 para usar os contatos.'); e.status = 409; throw e; }
      const out = []; let start = 0;
      for (let i = 0; i < 10; i++) {
        const r = await bitrix.call('crm.contact.list', { filter: { COMPANY_ID: String(empresaId) }, select: ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL'], start });
        for (const x of r.result || []) out.push({ id: String(x.ID), nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') || `Contato ${x.ID}`, telefone: ((x.PHONE || [])[0] || {}).VALUE || '', email: ((x.EMAIL || [])[0] || {}).VALUE || '' });
        if (r.next === undefined) break; start = r.next;
      }
      return out;
    },
    async porId(id) { return (await listar()).find(e => e.id === String(id)) || null; },
    async buscar(q, lim = 15) {
      const t = norm(q); const l = await listar(); if (!t) return l.slice(0, lim);
      return l.filter(e => norm(e.nome).includes(t) || norm(e.razao).includes(t) || (digits(q).length >= 4 && e.cnpj.includes(digits(q)))).slice(0, lim);
    },
    porCnpj: async c => { const d = digits(c); return d.length === 14 ? (await listar()).filter(e => e.cnpj === d) : []; },
    sugestoes: async (nome, n = 3) => (await listar()).map(e => ({ e, s: similar(nome, e.nome) })).filter(x => x.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, n).map(x => ({ ...x.e, similaridade: Math.round(x.s * 100) / 100 })),
    // cria a empresa no Bitrix (sempre depois de checar CNPJ/nome iguais, para não duplicar)
    // Completa só campos vazios de uma empresa já cadastrada (razão social, cidade, estado); nada é sobrescrito.
    async completar(id, dados) {
      const c = await campos(), f = {}, atual = (await listar()).find(e => e.id === String(id)) || {};
      if (c.razao && dados.razao && !atual.razao) f[c.razao] = dados.razao; if (c.cidade && dados.cidade && !atual.cidade) f[c.cidade] = dados.cidade; if (c.uf && dados.uf && !atual.uf) f[c.uf] = dados.uf;
      if (!Object.keys(f).length) return false; await bitrix.call('crm.company.update', { id, fields: f }); cache.at = 0; return Object.keys(f).length;
    },
    async criar({ nome, cnpj, cidade, uf, razao, cep, bairro }) {
      const l = await listar(true), d = digits(cnpj);
      const dup = l.find(e => (d.length === 14 && e.cnpj === d) || chave(e.nome) === chave(nome));
      if (dup) { const e = new Error(`Já existe no Bitrix24 a empresa "${dup.nome}" (ID ${dup.id}). Vincule em vez de criar.`); e.status = 409; e.existente = dup; throw e; }
      const c = await campos(), fields = { TITLE: String(nome).slice(0, 255), COMPANY_TYPE: 'CUSTOMER' };
      if (c.cnpj && d.length === 14) fields[c.cnpj] = d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
      if (c.cidade && cidade) fields[c.cidade] = cidade; if (c.uf && uf) fields[c.uf] = uf; if (c.razao && razao) fields[c.razao] = razao; if (c.cep && cep) fields[c.cep] = cep; if (c.bairro && bairro) fields[c.bairro] = bairro;
      const r = await bitrix.call('crm.company.add', { fields }); cache.at = 0;
      return { id: String(r.result), nome, cnpj: d, cidade: cidade || '', uf: uf || '' };
    },
  };
}
module.exports = { createBxEmpresas, similar, chave, digits, contido, acharUnica };
