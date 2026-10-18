'use strict';
const R = require('./rules');
const F = require('./fin');
const { checkKeyEnv, hint } = require('./secrets');

const FIELD = 'UF_CRM_CR_EMPRESA';
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Cadastro de empresas (multiempresa). A empresa é escolhida no Bitrix por um campo de lista na deal (UF_CRM_CR_EMPRESA)
// e o app usa o nome da opção para saber de qual empresa é cada lançamento. Cada empresa pode ter sua chave do Asaas.
function createEmpresas({ fin, secrets, bitrix, createAsaas }) {
  const clients = new Map();
  const keyOf = id => `asaas:${id}`;
  const envOf = id => secrets.get(keyOf(id))?.env === 'production' ? 'production' : 'sandbox';
  function clientFor(id) {
    const s = secrets.get(keyOf(id));
    if (!s?.apiKey) { clients.delete(String(id)); return null; }
    let c = clients.get(String(id));
    if (!c) { c = createAsaas({}); clients.set(String(id), c); }
    c.configure({ apiKey: s.apiKey, env: s.env });
    return c;
  }
  const publica = e => ({ ...e, asaas: { configurado: !!secrets.get(keyOf(e.id))?.apiKey, env: envOf(e.id), dica: hint(secrets.get(keyOf(e.id))?.apiKey) } });
  const validar = (p, atual) => {
    const nome = String(p.nome || '').trim();
    if (nome.length < 2 || nome.length > 80) throw F.bad('Nome da empresa de 2 a 80 caracteres.');
    const cnpj = R.digits(p.cnpj);
    if (cnpj && !R.validCNPJ(cnpj)) throw F.bad('CNPJ inválido.');
    if (fin.empresas.all().some(e => norm(e.nome) === norm(nome) && e.id !== atual)) throw F.bad('Já existe uma empresa com esse nome.');
    return { nome, cnpj, ativa: p.ativa !== false, bitrixCompanyId: /^\d+$/.test(String(p.bitrixCompanyId || '')) ? String(p.bitrixCompanyId) : '' };
  };

  let enums = { at: 0, map: {} };   // id do item de lista -> nome
  async function loadEnum(force) {
    if (!force && Date.now() - enums.at < 120000) return enums.map;
    const all = (await bitrix.call('crm.deal.userfield.list', {})).result || [];
    const f = all.find(x => x.FIELD_NAME === FIELD);
    enums = { at: Date.now(), map: Object.fromEntries(((f || {}).LIST || []).map(i => [String(i.ID), i.VALUE])) };
    return enums.map;
  }
  // empresa (id) de uma deal, pelo campo de lista do Bitrix
  // 1º o campo de lista "CR · Empresa"; sem ele, a "Minha empresa" da deal (ligada à empresa pelo cadastro).
  const empresaDe = d => {
    const raw = d.empresaRaw ?? d[FIELD];
    if (raw && raw !== '0') {
      const nome = enums.map[String(raw)];
      const e = fin.empresas.all().find(x => norm(x.nome) === norm(nome));
      if (e) return e.id;
    }
    const my = String(d.mycompanyId ?? d.MYCOMPANY_ID ?? '');
    return my && my !== '0' ? (fin.empresas.all().find(e => e.bitrixCompanyId === my) || {}).id || '' : '';
  };
  // "Minhas empresas" cadastradas no Bitrix (empresa vendedora), com CNPJ quando houver.
  async function minhasBitrix() {
    const l = await bitrix.listAll('crm.company.list', { filter: { IS_MY_COMPANY: 'Y' }, select: ['ID', 'TITLE', 'UF_*', 'EMAIL', 'PHONE'] });
    return l.map(c => ({ id: String(c.ID), nome: c.TITLE, cnpj: R.findDoc(c, ['UF_CRM_CNPJ']), vinculada: (fin.empresas.all().find(e => e.bitrixCompanyId === String(c.ID)) || {}).id || '' }));
  }
  async function importarMinhas() {
    const criadas = [];
    for (const c of await minhasBitrix()) {
      if (c.vinculada) continue;
      const igual = fin.empresas.all().find(e => norm(e.nome) === norm(c.nome));
      if (igual) { fin.empresas.put({ ...igual, bitrixCompanyId: c.id, cnpj: igual.cnpj || (R.validCNPJ(c.cnpj) ? c.cnpj : '') }); continue; }
      const e = { id: F.uid('emp'), nome: c.nome.slice(0, 80), cnpj: R.validCNPJ(c.cnpj) ? R.digits(c.cnpj) : '', ativa: true, bitrixCompanyId: c.id };
      fin.empresas.add(e); criadas.push(publica(e));
    }
    return { criadas: criadas.length };
  }

  // Cria/atualiza o campo de lista no Bitrix com os nomes das empresas ativas.
  async function sincronizarCampo() {
    const nomes = fin.empresas.all().filter(e => e.ativa).map(e => e.nome);
    const all = (await bitrix.call('crm.deal.userfield.list', {})).result || [];
    const f = all.find(x => x.FIELD_NAME === FIELD);
    const label = 'CR · Empresa';
    if (!f) {
      await bitrix.call('crm.deal.userfield.add', { fields: {
        FIELD_NAME: 'CR_EMPRESA', USER_TYPE_ID: 'enumeration', XML_ID: 'CR_EMPRESA', EDIT_FORM_LABEL: { br: label, en: label }, LIST_COLUMN_LABEL: { br: label, en: label },
        SHOW_IN_LIST: 'Y', EDIT_IN_LIST: 'Y', MULTIPLE: 'N', LIST: nomes.map((v, i) => ({ VALUE: v, SORT: (i + 1) * 10, DEF: 'N' })),
      } });
    } else {
      const have = new Set((f.LIST || []).map(i => norm(i.VALUE)));
      const novos = nomes.filter(n => !have.has(norm(n)));
      if (novos.length) await bitrix.call('crm.deal.userfield.update', { id: f.ID, fields: { LIST: [...(f.LIST || []).map(i => ({ ID: i.ID, VALUE: i.VALUE, SORT: i.SORT, DEF: i.DEF })), ...novos.map((v, i) => ({ VALUE: v, SORT: 1000 + i, DEF: 'N' }))] } });
    }
    await loadEnum(true);
    return { campo: FIELD, opcoes: nomes };
  }

  return {
    FIELD, clientFor, empresaDe, loadEnum, sincronizarCampo, minhasBitrix, importarMinhas,
    allClients: () => fin.empresas.all().map(e => clientFor(e.id)).filter(Boolean),
    list: () => fin.empresas.all().map(publica),
    get: id => fin.empresas.get(String(id)),
    add(p) { const e = { id: F.uid('emp'), ...validar(p) }; fin.empresas.add(e); return publica(e); },
    update(id, p) { const a = fin.empresas.get(id); if (!a) throw F.bad('Empresa não encontrada.'); const e = { ...a, ...validar({ ...a, ...p }, id) }; fin.empresas.put(e); return publica(e); },
    remove(id) {
      const usada = [fin.pagar, fin.funcionarios, fin.receber].some(t => t.all().some(x => x.empresaId === id));
      if (usada) throw F.bad('A empresa tem lançamentos ou funcionários. Desative em vez de remover.');
      secrets.clear(keyOf(id)); clients.delete(String(id)); fin.empresas.remove(id);
    },
    setAsaas(id, { apiKey, env }) {
      if (!fin.empresas.get(id)) throw F.bad('Empresa não encontrada.');
      const e = env === 'production' ? 'production' : 'sandbox', key = String(apiKey || '').trim();
      const msg = checkKeyEnv(key, e); if (msg) throw F.bad(msg);
      secrets.set({ [keyOf(id)]: { apiKey: key, env: e } }); clients.delete(String(id));
      return publica(fin.empresas.get(id));
    },
    removeAsaas(id) { secrets.clear(keyOf(id)); clients.delete(String(id)); return publica(fin.empresas.get(id)); },
    async testAsaas(id) {
      const c = clientFor(id); if (!c) throw F.bad('Esta empresa não tem chave do Asaas.');
      try { return { ok: true, env: c.env, ...(await c.test({ apiKey: secrets.get(keyOf(id)).apiKey, env: c.env })) }; }
      catch (e) { throw F.bad(e.status === 401 ? 'O Asaas recusou a chave (401).' : e.message); }
    },
  };
}
module.exports = { createEmpresas, FIELD };
