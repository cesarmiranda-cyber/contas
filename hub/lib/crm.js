'use strict';
// Regras do Validador de Cadastro sobre as entidades de empresas e contatos do Bitrix24.
const { onlyDigits, formatCnpj, formatCpf, isValidCnpj, isValidCpf } = require('./cnpj');

// Campos personalizados criados (uma vez) no portal. Nome do campo na API = ufCrm + CamelCase.
const COMPANY_FIELDS = [
  ['HUB_CNPJ', 'CNPJ'], ['HUB_RAZAO', 'Razão social'], ['HUB_SITUACAO', 'Situação cadastral (Receita)'],
  ['HUB_CNAE', 'Atividade principal (CNAE)'], ['HUB_PORTE', 'Porte'], ['HUB_NATUREZA', 'Natureza jurídica'],
  ['HUB_ABERTURA', 'Data de abertura'], ['HUB_ENDERECO', 'Endereço'], ['HUB_VALIDADO', 'Validado na Receita em'],
];
const CONTACT_FIELDS = [['HUB_CPF', 'CPF']];

const camel = (n) => 'ufCrm' + n.toLowerCase().split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
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
const multiIn = (list, type = 'WORK') => [...new Set((list || []).map((s) => str(s)).filter(Boolean))].map((value) => ({ value, typeId: type }));

function normCompany(r) {
  if (!r) return null;
  return {
    id: Number(r.id), title: str(r.title), cnpj: str(r[F.cnpj]), razaoSocial: str(r[F.razao]), situacao: str(r[F.situacao]),
    cnae: str(r[F.cnae]), porte: str(r[F.porte]), natureza: str(r[F.natureza]), abertura: str(r[F.abertura]),
    endereco: str(r[F.endereco]), validadoEm: str(r[F.validado]),
    telefones: multi(r.phone), emails: multi(r.email), sites: multi(r.web), comentarios: str(r.comments, 5000),
    criadoEm: str(r.createdTime), responsavelId: r.assignedById ?? null,
  };
}
function normContact(r) {
  const nome = [r.name, r.secondName, r.lastName].map((x) => str(x)).filter(Boolean).join(' ');
  return {
    id: Number(r.id), nome, cargo: str(r.post), cpf: str(r[F.cpf]), telefones: multi(r.phone), emails: multi(r.email),
    empresaId: r.companyId ? Number(r.companyId) : null,
    principal: r.isPrimary === true || r.isPrimary === 'Y' || undefined,
  };
}

function createCrm(vibe) {
  let schemaPromise = null;

  async function ensureEntityFields(entity, wanted) {
    const existing = new Set(rows(await vibe.get(`/userfields/${entity}`)).map((f) => String(f.fieldName || f.FIELD_NAME || '').toUpperCase()));
    const created = [];
    for (const [name, label] of wanted) {
      if (existing.has(`UF_CRM_${name}`)) continue;
      await vibe.post(`/userfields/${entity}`, { userTypeId: 'string', fieldName: name, label, showInList: false, showFilter: name === 'HUB_CNPJ' || name === 'HUB_CPF', isSearchable: true });
      created.push(name);
    }
    return created;
  }
  // Idempotente; em caso de falha, tenta de novo na próxima chamada.
  function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => ({
        companies: await ensureEntityFields('companies', COMPANY_FIELDS),
        contacts: await ensureEntityFields('contacts', CONTACT_FIELDS),
      }))().catch((e) => { schemaPromise = null; throw e; });
    }
    return schemaPromise;
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
    jobs.push(searchCompaniesRaw({ [F.razao]: { $contains: q } }, limit + 1, offset));
    if (d.length >= 3) jobs.push(searchCompaniesRaw({ [F.cnpj]: { $contains: formatCnpj(d) } }, limit + 1, offset));
    const seen = new Map();
    for (const list of await Promise.all(jobs)) for (const r of list) seen.set(Number(r.id), r);
    const merged = [...seen.values()].sort((a, b) => Number(b.id) - Number(a.id));
    return paged(merged, limit);
  }
  function paged(raw, limit) { return { items: raw.slice(0, limit).map(normCompany), hasMore: raw.length > limit }; }

  async function findByCnpj(cnpj) {
    await ensureSchema();
    const d = onlyDigits(cnpj);
    const list = await searchCompaniesRaw({ [F.cnpj]: { $in: [formatCnpj(d), d] } }, 5, 0);
    return list.length ? normCompany(list[0]) : null;
  }

  async function getCompany(id) {
    await ensureSchema();
    const res = await vibe.get(`/companies/${Number(id)}`, { include: 'contact' });
    const data = one(res);
    const company = normCompany(data);
    company.contatos = (data._included?.contacts || []).map(normContact);
    return company;
  }

  function companyPayload(c, { requireTitle = true } = {}) {
    const title = str(c.title, 255) || str(c.razaoSocial, 255);
    if (requireTitle && !title) throw bad('Informe o nome da empresa.');
    const p = { title };
    const set = (k, v) => { if (v !== undefined) p[k] = v; };
    set(F.cnpj, c.cnpj === undefined ? undefined : formatCnpj(c.cnpj));
    set(F.razao, c.razaoSocial === undefined ? undefined : str(c.razaoSocial));
    set(F.situacao, c.situacao === undefined ? undefined : str(c.situacao));
    set(F.cnae, c.cnae === undefined ? undefined : str(c.cnae));
    set(F.porte, c.porte === undefined ? undefined : str(c.porte));
    set(F.natureza, c.natureza === undefined ? undefined : str(c.natureza));
    set(F.abertura, c.abertura === undefined ? undefined : str(c.abertura));
    set(F.endereco, c.endereco === undefined ? undefined : str(c.endereco, 500));
    set(F.validado, c.validadoEm === undefined ? undefined : str(c.validadoEm));
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
      p[F.cpf] = formatCpf(c.cpf);
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
    const payload = companyPayload(empresa);
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
    const p = companyPayload(empresa, { requireTitle: false });
    if (!p.title) delete p.title;
    await vibe.patch(`/companies/${Number(id)}`, p);
    return getCompany(id);
  }

  async function searchContacts(q, limit = 12) {
    q = str(q, 80);
    if (q.length < 2) return [];
    const [byName, byLast] = await Promise.all([
      vibe.post('/contacts/search', { filter: { name: { $contains: q } }, limit, select: ['*', 'UF_*'] }),
      vibe.post('/contacts/search', { filter: { lastName: { $contains: q } }, limit, select: ['*', 'UF_*'] }),
    ]);
    const seen = new Map();
    for (const r of [...rows(byName), ...rows(byLast)]) seen.set(Number(r.id), r);
    return [...seen.values()].slice(0, limit).map(normContact);
  }

  async function unlinkContact(companyId, contactId) {
    await vibe.del(`/companies/${Number(companyId)}/contacts/${Number(contactId)}`);
  }

  return { ensureSchema, listCompanies, findByCnpj, getCompany, createCompany, updateCompany, addContact, unlinkContact, searchContacts };
}

module.exports = { createCrm, HubError, F, normCompany, normContact, COMPANY_FIELDS, CONTACT_FIELDS };
