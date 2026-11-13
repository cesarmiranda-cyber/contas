'use strict';
// Regras do Validador de Cadastro sobre as entidades de empresas e contatos do Bitrix24.
const { onlyDigits, formatCnpj, formatCpf, isValidCnpj, isValidCpf } = require('./cnpj');

// O app NÃO cria campos no Bitrix24: usa os campos que já existem no formulário, localizados pelo nome de exibição.
// Preferência: campo próprio do portal (qualquer ufCrm... que não seja ufCrmHub*), depois o ufCrmHub* legado, se existir.
const SEMANTIC = {
  companies: {
    cnpj: /\bcnpj\b/i, razao: /raz[aã]o\s*social/i, situacao: /situa[cç][aã]o/i, cnae: /cnae|atividade\s*principal/i,
    porte: /\bporte\b/i, natureza: /natureza\s*jur/i, abertura: /abertura|funda[cç][aã]o|in[ií]cio\s*(da\s*)?atividade/i,
    endereco: /endere[cç]o/i, validado: /valida[cç][aã]o|validad/i,
  },
  contacts: { cpf: /\bcpf\b/i },
};
const SEMANTIC_LABEL = { cnpj: 'CNPJ', razao: 'Razão social', situacao: 'Situação cadastral', cnae: 'Atividade principal (CNAE)', porte: 'Porte', natureza: 'Natureza jurídica', abertura: 'Data de abertura', endereco: 'Endereço', validado: 'Validado na Receita em', cpf: 'CPF' };
const LAYOUT_TYPE = { companies: 4, contacts: 3 };

const camel = (n) => 'ufCrm' + n.toLowerCase().split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
// Nomes do legado (campos ufCrmHub*); só servem de reserva se o portal ainda os tiver.
const F = { cnpj: camel('HUB_CNPJ'), razao: camel('HUB_RAZAO'), situacao: camel('HUB_SITUACAO'), cnae: camel('HUB_CNAE'),
  porte: camel('HUB_PORTE'), natureza: camel('HUB_NATUREZA'), abertura: camel('HUB_ABERTURA'), endereco: camel('HUB_ENDERECO'),
  validado: camel('HUB_VALIDADO'), cpf: camel('HUB_CPF') };

class HubError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (m, code = 'BAD_REQUEST') => new HubError(400, code, m);

const str = (v, max = 255) => String(v ?? '').trim().slice(0, max);
const rows = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res?.data?.items) ? res.data.items : []);
const one = (res) => res?.data ?? res;

// multicampo (telefone/e-mail/site) volta como lista de objetos ou de strings
function multi(v) {
  if (!v) return [];
  const a = Array.isArray(v) ? v : [v];
  return a.map((x) => (typeof x === 'object' && x ? str(x.value ?? x.VALUE) : str(x))).filter(Boolean);
}
// linhas cruas do multicampo (com id) para montar o `fm` de edição
const rawRows = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => x && typeof x === 'object');
const rowType = (r) => String(r.typeId ?? r.valueType ?? r.VALUE_TYPE ?? 'WORK');
// Plano para trocar o conjunto de valores de um canal: `fm` só altera/apaga linhas que já existem;
// valores novos vão em `adds` (formato simples da API, que apenas acrescenta — o `n0` do fm nem sempre é confirmado).
function multiPlan(channel, current, desired, plan) {
  const want = [...new Set((desired || []).map((x) => str(x)).filter(Boolean))];
  const rows = rawRows(current).filter((r) => r.id !== undefined);
  rows.forEach((r, i) => {
    if (i < want.length) { if (str(r.value ?? r.VALUE) !== want[i]) plan.fm[r.id] = { typeId: channel, valueType: rowType(r), value: want[i] }; }
    else plan.fm[r.id] = { typeId: channel, value: '' };
  });
  plan.adds[channel] = want.slice(rows.length);
}
const sameSet = (a, b) => { const x = [...new Set(a)].sort(), y = [...new Set(b)].sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
const multiIn = (list, type = 'WORK') => [...new Set((list || []).map((s) => str(s)).filter(Boolean))].map((value) => ({ value, typeId: type }));

function normCompany(r, M = F) {
  if (!r) return null;
  const g = (k) => (M[k] ? str(r[M[k]]) : '');
  return {
    id: Number(r.id), title: str(r.title), cnpj: g('cnpj'), razaoSocial: g('razao'), situacao: g('situacao'),
    cnae: g('cnae'), porte: g('porte'), natureza: g('natureza'), abertura: g('abertura'),
    endereco: g('endereco'), validadoEm: g('validado'),
    telefones: multi(r.phone), emails: multi(r.email), sites: multi(r.web), comentarios: str(r.comments, 5000),
    criadoEm: str(r.createdTime), responsavelId: r.assignedById ?? null,
  };
}
function normContact(r, M = F) {
  const nome = [r.name, r.secondName, r.lastName].map((x) => str(x)).filter(Boolean).join(' ');
  return {
    id: Number(r.id), nome, cargo: str(r.post), cpf: M.cpf ? str(r[M.cpf]) : '', telefones: multi(r.phone), emails: multi(r.email),
    empresaId: r.companyId ? Number(r.companyId) : null,
    principal: r.isPrimary === true || r.isPrimary === 'Y' || undefined,
  };
}

// Campos do formulário do Bitrix24 (editáveis), lidos do schema do portal.
const STATUS_ENTITY = {
  companies: { typeId: 'COMPANY_TYPE', industry: 'INDUSTRY', employees: 'EMPLOYEES' },
  contacts: { typeId: 'CONTACT_TYPE', sourceId: 'SOURCE' },
};
const BASE_SKIP = ['id', 'title', 'phone', 'email', 'web', 'im', 'fm', 'createdTime', 'createdById', 'modifyById', 'updatedTime', 'leadId', 'originatorId', 'originId', 'originVersion', 'hasPhone', 'hasEmail', 'hasImol', 'isReturnCustomer', 'searchContentHash', 'webformId', 'lastActivityTime', 'lastActivityBy', 'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm'];
const SKIP = {
  companies: new Set([...BASE_SKIP, 'logo', 'bankingDetails', 'address', 'addressLegal', 'registeredAddress']),
  contacts: new Set([...BASE_SKIP, 'name', 'lastName', 'secondName', 'post', 'companyId', 'companyIds', 'photo', 'honorific', 'faceId', 'exportFlag']),
};
const lc = (o, a, b) => o?.[a] ?? o?.[b];
const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');
function fieldKind(key, f) {
  if (key === 'assignedById') return 'user';
  if (f.multiple) {
    if (f.options?.length) return 'multiselect';
    return ['string', 'text', 'integer', 'double', 'float', 'number'].includes(String(f.type || '').toLowerCase()) ? 'multitext' : null;
  }
  if (f.options?.length) return 'select';
  const t = String(f.type || '').toLowerCase();
  if (t === 'boolean' || t === 'char') return 'bool';
  if (['integer', 'double', 'float', 'number'].includes(t)) return 'number';
  if (t === 'date') return 'date';
  if (['string', 'text', 'url'].includes(t)) return key === 'comments' || t === 'text' ? 'textarea' : 'text';
  return null;
}

function createCrm(vibe, shared = {}, userKey = '') {
  const cache = shared.cache || (shared.cache = {});
  let M = shared.map || { ...F };

  async function rawFields(entity) {
    const hit = cache[`raw:${entity}`];
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.fields;
    const fields = one(await vibe.get(`/${entity}/fields`))?.fields || {};
    cache[`raw:${entity}`] = { at: Date.now(), fields };
    return fields;
  }
  // Localiza, entre os campos do portal, os que guardam CNPJ, razão social etc.
  async function resolveMap() {
    if (shared.map) { M = shared.map; return shared.map; }
    const map = {}, missing = [];
    for (const [entity, wanted] of Object.entries(SEMANTIC)) {
      const fields = await rawFields(entity);
      for (const [k, re] of Object.entries(wanted)) {
        const cands = Object.entries(fields).filter(([key, f]) => /^ufCrm/.test(key) && !f.readonly && !f.multiple && /string|text|url|^$/i.test(String(f.type || '')) && re.test(str(f.label || f.title)));
        const own = cands.filter(([key]) => !/^ufCrmHub/.test(key)).sort((x, y) => str(x[1].label).length - str(y[1].label).length)[0];
        const legacy = cands.find(([key]) => /^ufCrmHub/.test(key));
        const hit = own || legacy;
        map[k] = hit ? hit[0] : null;
        if (!hit) missing.push(k);
      }
    }
    shared.map = map; shared.missing = missing; M = map;
    return map;
  }
  function ensureSchema() {
    if (shared.map) { M = shared.map; return Promise.resolve(shared.map); }
    if (!shared.mapPromise) shared.mapPromise = resolveMap().catch((e) => { shared.mapPromise = null; throw e; });
    return shared.mapPromise;
  }
  async function mapping() {
    await ensureSchema();
    return { map: shared.map, missing: (shared.missing || []).map((k) => ({ key: k, label: SEMANTIC_LABEL[k] })) };
  }
  const fixedKeys = () => new Set(Object.values(M).filter(Boolean));

  // Campo personalizado de lista: as opções vêm de /userfields/:entidade (campo `list`).
  async function userfieldOptions(entity, key) {
    if (!cache[`uf:${entity}`]) {
      try { cache[`uf:${entity}`] = rows(await vibe.get(`/userfields/${entity}`)); } catch { cache[`uf:${entity}`] = []; }
    }
    const norm = (n) => String(n || '').replace(/^UF_CRM_/i, '').replace(/^ufCrm/, '').replace(/_/g, '').toLowerCase();
    const uf = cache[`uf:${entity}`].find((u) => norm(u.fieldName || u.FIELD_NAME) === norm(key));
    return (uf?.list || []).map((i) => ({ value: String(lc(i, 'ID', 'id') ?? ''), label: str(lc(i, 'VALUE', 'value')) })).filter((o) => o.value && o.label);
  }
  async function loadOptions(entity, key, f) {
    const items = f.items || f.options;
    if (Array.isArray(items) && items.length) return items.map((i) => ({ value: String(lc(i, 'ID', 'id') ?? lc(i, 'VALUE', 'value')), label: str(lc(i, 'VALUE', 'value') ?? lc(i, 'name', 'NAME')) })).filter((o) => o.label);
    const st = STATUS_ENTITY[entity]?.[key];
    if (!st) return userfieldOptions(entity, key);
    try {
      return rows(await vibe.get('/statuses', { 'filter[entityId]': st })).map((i) => ({ value: str(lc(i, 'statusId', 'STATUS_ID')), label: str(lc(i, 'name', 'NAME')) })).filter((o) => o.value && o.label);
    } catch { return []; }
  }
  // Todos os campos editáveis do portal (com tipo e opções), em cache por 10 min.
  async function allFields(entity) {
    const hit = cache[`all:${entity}`];
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    await ensureSchema();
    const fields = await rawFields(entity);
    const fixed = fixedKeys();
    const list = [], ignored = [];
    for (const [key, f] of Object.entries(fields)) {
      if (f.readonly || SKIP[entity].has(key) || fixed.has(key) || /^ufCrmHub/.test(key)) continue;
      const withOpts = { ...f, options: await loadOptions(entity, key, f) };
      const kind = fieldKind(key, withOpts);
      const label = str(f.label || f.title || key);
      if (!kind) { ignored.push({ key, label, type: str(f.type) + (f.multiple ? '[]' : '') }); continue; }
      list.push({ key, label, kind, options: withOpts.options, mandatory: !!(f.mandatory || f.required) });
    }
    return (cache[`all:${entity}`] = { at: Date.now(), list, ignored });
  }
  const normName = (n) => String(n || '').replace(/_/g, '').toLowerCase();
  const LAYOUT_ALIAS = { revenuewithcurrency: 'revenue', opportunitywithcurrency: 'opportunity' };
  // Campos visíveis no cartão do Bitrix24 (layout pessoal; se não houver, o comum), na ordem e por seção.
  async function layoutOf(entity) {
    const ck = `layout:${entity}:${userKey}`, hit = cache[ck];
    if (hit && Date.now() - hit.at < 2 * 60_000) return hit.v;
    let v = null;
    for (const [scope, name] of [['P', 'personal'], ['C', 'common']]) {
      try {
        const res = await vibe.get(`/crm/card-config/${LAYOUT_TYPE[entity]}`, { scope });
        const d = res?.data;
        const sections = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : null;
        if (sections?.length) { v = { scope: name, sections }; break; }
      } catch { /* layout indisponível: segue sem filtro */ }
    }
    cache[ck] = { at: Date.now(), v };
    return v;
  }
  // Lista de campos do formulário: { key, label, kind, options?, mandatory, section }
  async function formFields(entity, withIgnored = false) {
    const all = await allFields(entity), lay = await layoutOf(entity);
    let list = all.list, ignored = all.ignored;
    if (lay) {
      const order = new Map();
      lay.sections.forEach((sec) => (sec.elements || []).forEach((el) => {
        const n = normName(el.name); const k = LAYOUT_ALIAS[n] || n;
        if (!order.has(k)) order.set(k, { i: order.size, section: str(sec.title) });
      }));
      const vis = (f) => order.get(normName(f.key));
      list = all.list.filter(vis).map((f) => ({ ...f, section: vis(f).section })).sort((x, y) => vis(x).i - vis(y).i);
      ignored = all.ignored.filter(vis);
    } else {
      list = [...all.list].sort((x, y) => (x.key === 'assignedById' ? -1 : y.key === 'assignedById' ? 1 : 0));
    }
    return withIgnored ? { list, ignored, layout: lay?.scope || null } : list;
  }
  function coerce(kind, v) {
    if (kind === 'multiselect' || kind === 'multitext') {
      const arr = (Array.isArray(v) ? v : String(v ?? '').split(/\n/)).map((x) => str(x, 1000)).filter(Boolean);
      return arr;
    }
    if (v === null || v === undefined || v === '') return '';
    if (kind === 'number') { const n = Number(String(v).replace(',', '.')); if (Number.isNaN(n)) throw bad('Há um campo numérico com valor inválido.'); return n; }
    if (kind === 'bool') return v === true || v === 'true' || v === 'Y';
    if (kind === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad('Data inválida.'); return String(v); }
    return str(v, 5000);
  }
  async function pickCampos(entity, campos) {
    if (!campos || typeof campos !== 'object') return {};
    const list = (await allFields(entity)).list, out = {};
    for (const f of list) {
      if (!(f.key in campos)) continue;
      const v = coerce(f.kind === 'user' ? 'number' : f.kind, campos[f.key]);
      if (f.mandatory && (v === '' || (Array.isArray(v) && !v.length))) throw bad(`Preencha o campo “${f.label}”.`);
      out[f.key] = v;
    }
    return out;
  }
  async function valuesOf(entity, raw) {
    const list = await formFields(entity), out = {};
    for (const f of list) {
      const v = raw[f.key];
      out[f.key] = Array.isArray(v) ? v.map((x) => String(x)) : f.kind === 'date' ? dateOnly(v) : f.kind === 'bool' ? (v === true || v === 'Y') : v === null || v === undefined ? '' : (typeof v === 'object' ? '' : String(v));
    }
    return out;
  }
  async function listUsers() {
    if (cache.users && Date.now() - cache.users.at < 5 * 60_000) return cache.users.list;
    const list = rows(await vibe.get('/users', { limit: 200 })).filter((u) => u.active !== false && u.active !== 'N')
      .map((u) => ({ id: Number(u.id), nome: str(u.fullName || [u.name, u.lastName].filter(Boolean).join(' ') || u.email || `Usuário ${u.id}`) }))
      .filter((u) => u.id).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    cache.users = { at: Date.now(), list };
    return list;
  }

  async function searchCompaniesRaw(filter, limit, offset) {
    return rows(await vibe.post('/companies/search', { filter, limit, offset, order: { id: 'desc' }, select: ['*', 'UF_*'] }));
  }

  async function listCompanies({ q = '', limit = 30, offset = 0 } = {}) {
    await ensureSchema();
    q = str(q, 80);
    limit = Math.min(Math.max(Number(limit) || 30, 1), 100); offset = Math.max(Number(offset) || 0, 0);
    if (!q) return paged(await searchCompaniesRaw({}, limit + 1, offset), limit);
    const d = onlyDigits(q);
    const jobs = [searchCompaniesRaw({ title: { $contains: q } }, limit + 1, offset)];
    if (M.razao) jobs.push(searchCompaniesRaw({ [M.razao]: { $contains: q } }, limit + 1, offset));
    if (M.cnpj && d.length >= 3) jobs.push(searchCompaniesRaw({ [M.cnpj]: { $contains: formatCnpj(d) } }, limit + 1, offset));
    const seen = new Map();
    for (const list of await Promise.all(jobs)) for (const r of list) seen.set(Number(r.id), r);
    const merged = [...seen.values()].sort((a, b) => Number(b.id) - Number(a.id));
    return paged(merged, limit);
  }
  function paged(raw, limit) { return { items: raw.slice(0, limit).map((r) => normCompany(r, M)), hasMore: raw.length > limit }; }

  async function findByCnpj(cnpj) {
    await ensureSchema();
    if (!M.cnpj) return null;                                   // sem campo de CNPJ no portal não há como detectar duplicidade
    const d = onlyDigits(cnpj);
    const list = await searchCompaniesRaw({ [M.cnpj]: { $in: [formatCnpj(d), d] } }, 5, 0);
    return list.length ? normCompany(list[0], M) : null;
  }

  async function getCompany(id) {
    await ensureSchema();
    const res = await vibe.get(`/companies/${Number(id)}`, { include: 'contact' });
    const data = one(res);
    const company = normCompany(data, M);
    company.contatos = (data._included?.contacts || []).map((c) => normContact(c, M));
    company.responsavelId = data.assignedById ?? null;
    company.valores = await valuesOf('companies', data).catch(() => ({}));
    return company;
  }

  function companyPayload(c, { requireTitle = true } = {}) {
    const title = str(c.title, 255) || str(c.razaoSocial, 255);
    if (requireTitle && !title) throw bad('Informe o nome da empresa.');
    const p = { title };
    const set = (k, v) => { if (v !== undefined && M[k]) p[M[k]] = v; };       // sem campo no portal: não grava
    set('cnpj', c.cnpj === undefined ? undefined : formatCnpj(c.cnpj));
    set('razao', c.razaoSocial === undefined ? undefined : str(c.razaoSocial));
    set('situacao', c.situacao === undefined ? undefined : str(c.situacao));
    set('cnae', c.cnae === undefined ? undefined : str(c.cnae));
    set('porte', c.porte === undefined ? undefined : str(c.porte));
    set('natureza', c.natureza === undefined ? undefined : str(c.natureza));
    set('abertura', c.abertura === undefined ? undefined : str(c.abertura));
    set('endereco', c.endereco === undefined ? undefined : str(c.endereco, 500));
    set('validado', c.validadoEm === undefined ? undefined : str(c.validadoEm));
    if (c.telefones?.length) p.phone = multiIn(c.telefones);
    if (c.emails?.length) p.email = multiIn(c.emails);
    if (c.sites?.length) p.web = multiIn(c.sites);
    if (c.comentarios !== undefined) p.comments = str(c.comentarios, 5000);
    return p;
  }
  function contactPayload(c, companyId) {
    const nome = str(c.nome, 150);
    if (!nome) throw bad('Informe o nome do contato.');
    const parts = nome.split(/\s+/);
    const p = { name: parts.shift(), lastName: parts.join(' ') };
    if (companyId) p.companyId = Number(companyId);
    if (str(c.cargo)) p.post = str(c.cargo, 100);
    if (str(c.cpf)) {
      if (!isValidCpf(c.cpf)) throw bad(`CPF inválido para ${nome}.`);
      if (M.cpf) p[M.cpf] = formatCpf(c.cpf);
    }
    if (c.telefones?.length || str(c.telefone)) p.phone = multiIn(c.telefones || [c.telefone], 'MOBILE');
    if (c.emails?.length || str(c.email)) p.email = multiIn(c.emails || [c.email]);
    return p;
  }

  async function addContact(companyId, spec) {
    if (spec.contactId) {
      const id = Number(spec.contactId);
      await vibe.get(`/contacts/${id}`, { select: 'id' });      // o vínculo aceita ids inexistentes: valida antes
      await vibe.post(`/companies/${Number(companyId)}/contacts`, { contactId: id });
      return { mode: 'link', id };
    }
    const res = await vibe.post('/contacts', contactPayload(spec, companyId));
    const id = Number(one(res).id);
    return { mode: 'new', id };
  }

  // Cadastro completo: empresa primeiro; contatos um a um, relatando falhas parciais.
  async function createCompany({ empresa, contatos = [] }) {
    await ensureSchema();
    if (!empresa) throw bad('Dados da empresa ausentes.');
    if (empresa.cnpj) {
      if (!isValidCnpj(empresa.cnpj)) throw bad('CNPJ inválido.', 'CNPJ_INVALID');
      const dup = await findByCnpj(empresa.cnpj);
      if (dup) throw new HubError(409, 'CNPJ_DUPLICATE', `Já existe um cadastro com este CNPJ: ${dup.title}.`);
    }
    const payload = { ...companyPayload(empresa), ...(await pickCampos('companies', empresa.campos)) };
    contatos.forEach((c) => { if (!c.contactId) contactPayload(c); });   // valida tudo antes de gravar qualquer coisa
    const res = await vibe.post('/companies', { typeId: 'CUSTOMER', ...payload });
    const companyId = Number(one(res).id);
    const results = [];
    for (const c of contatos) {
      try { results.push({ ok: true, ...(await addContact(companyId, c)), nome: c.nome }); }
      catch (e) { results.push({ ok: false, nome: c.nome || `#${c.contactId}`, error: e.message }); }
    }
    return { id: companyId, contatos: results };
  }

  async function updateCompany(id, empresa) {
    await ensureSchema();
    if (empresa.cnpj) {
      if (!isValidCnpj(empresa.cnpj)) throw bad('CNPJ inválido.', 'CNPJ_INVALID');
      const dup = await findByCnpj(empresa.cnpj);
      if (dup && dup.id !== Number(id)) throw new HubError(409, 'CNPJ_DUPLICATE', `Este CNPJ já pertence a ${dup.title}.`);
    }
    const p = { ...companyPayload({ ...empresa, telefones: undefined, emails: undefined, sites: undefined }, { requireTitle: false }), ...(await pickCampos('companies', empresa.campos)) };
    if (!p.title) delete p.title;
    const plan = { fm: {}, adds: {} };
    if (empresa.telefones || empresa.emails) {
      const cur = one(await vibe.get(`/companies/${Number(id)}`, { select: 'id,phone,email' }));
      if (empresa.telefones) multiPlan('PHONE', cur.phone, empresa.telefones, plan);
      if (empresa.emails) multiPlan('EMAIL', cur.email, empresa.emails, plan);
    }
    if (plan.adds.PHONE?.length) p.phone = multiIn(plan.adds.PHONE);
    if (plan.adds.EMAIL?.length) p.email = multiIn(plan.adds.EMAIL);
    const check = (raw) => (!empresa.telefones || sameSet(multi(raw.phone), empresa.telefones.map((x) => str(x)).filter(Boolean))) && (!empresa.emails || sameSet(multi(raw.email), empresa.emails.map((x) => str(x)).filter(Boolean)));
    if (Object.keys(p).length) await patchSafe(`/companies/${Number(id)}`, p, check);
    if (Object.keys(plan.fm).length) await patchSafe(`/companies/${Number(id)}`, { fm: plan.fm }, check);
    return getCompany(id);
  }

  // Se o Bitrix aceitou a gravação mas a API não conseguiu confirmar a troca de telefone/e-mail (422), confere o registro:
  // se já está como pedido, a operação valeu.
  async function patchSafe(path, body, check) {
    try { await vibe.patch(path, body); }
    catch (e) {
      if (!['MULTIFIELD_NOT_APPLIED', 'MULTIFIELD_UNVERIFIED'].includes(e.code)) throw e;
      const raw = one(await vibe.get(path, { select: 'id,phone,email' }));
      if (!check(raw)) throw new HubError(409, 'MULTIFIELD_NOT_APPLIED', 'O Bitrix24 não confirmou a alteração de telefone/e-mail. Atualize a tela e confira o cadastro antes de tentar de novo.');
    }
  }

  async function deleteCompany(id) { await vibe.del(`/companies/${Number(id)}`); }

  async function updateContact(id, spec) {
    await ensureSchema();
    const p = contactPayload({ ...spec, telefones: undefined, emails: undefined, telefone: undefined, email: undefined });
    delete p.companyId;
    Object.assign(p, await pickCampos('contacts', spec.campos));
    const plan = { fm: {}, adds: {} };
    if (spec.telefones || spec.emails) {
      const cur = one(await vibe.get(`/contacts/${Number(id)}`, { select: 'id,phone,email' }));
      if (spec.telefones) multiPlan('PHONE', cur.phone, spec.telefones, plan);
      if (spec.emails) multiPlan('EMAIL', cur.email, spec.emails, plan);
    }
    if (plan.adds.PHONE?.length) p.phone = multiIn(plan.adds.PHONE, 'MOBILE');
    if (plan.adds.EMAIL?.length) p.email = multiIn(plan.adds.EMAIL);
    if (!str(spec.cargo)) p.post = '';
    if (!str(spec.cpf) && M.cpf) p[M.cpf] = '';
    const check = (raw) => (!spec.telefones || sameSet(multi(raw.phone), spec.telefones.map((x) => str(x)).filter(Boolean))) && (!spec.emails || sameSet(multi(raw.email), spec.emails.map((x) => str(x)).filter(Boolean)));
    await patchSafe(`/contacts/${Number(id)}`, p, check);
    if (Object.keys(plan.fm).length) await patchSafe(`/contacts/${Number(id)}`, { fm: plan.fm }, check);
    return getContact(id);
  }
  async function getContact(id) {
    const raw = one(await vibe.get(`/contacts/${Number(id)}`));
    return { ...normContact(raw, M), responsavelId: raw.assignedById ?? null, valores: await valuesOf('contacts', raw).catch(() => ({})) };
  }
  async function deleteContact(id) { await vibe.del(`/contacts/${Number(id)}`); }

  async function searchContacts(q, limit = 12) {
    await ensureSchema();
    q = str(q, 80);
    if (q.length < 2) return [];
    const [byName, byLast] = await Promise.all([
      vibe.post('/contacts/search', { filter: { name: { $contains: q } }, limit, select: ['*', 'UF_*'] }),
      vibe.post('/contacts/search', { filter: { lastName: { $contains: q } }, limit, select: ['*', 'UF_*'] }),
    ]);
    const seen = new Map();
    for (const r of [...rows(byName), ...rows(byLast)]) seen.set(Number(r.id), r);
    return [...seen.values()].slice(0, limit).map((c) => normContact(c, M));
  }

  async function unlinkContact(companyId, contactId) {
    await vibe.del(`/companies/${Number(companyId)}/contacts/${Number(contactId)}`);
  }

  return { mapping, formFields, listUsers, getContact, updateContact, deleteCompany, deleteContact, ensureSchema, listCompanies, findByCnpj, getCompany, createCompany, updateCompany, addContact, unlinkContact, searchContacts };
}

module.exports = { createCrm, HubError, F, normCompany, normContact };
