'use strict';
// CRM em memória que imita o trecho usado da API Vibe. Serve aos testes e ao modo demonstração (MOCK=1).
function createMockVibe(seed = true) {
  const db = { layout: null, companies: [], contacts: [], links: [], userfields: { companies: [], contacts: [] }, seq: 100 };
  let rid = 0; const mf = (v) => (v || []).map((x) => ({ id: ++rid, value: x.value, typeId: x.typeId }));
  const match = (rec, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    const v = rec[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$contains' in cond) return String(v ?? '').toLowerCase().includes(String(cond.$contains).toLowerCase());
      if ('$in' in cond) return cond.$in.includes(v);
      return true;
    }
    return v === cond;
  });
  function add(kind, body) {
    const rec = { id: ++db.seq, createdTime: new Date().toISOString(), ...body };
    for (const k of ['phone', 'email', 'web']) if (rec[k]) rec[k] = mf(rec[k]);
    db[kind].push(rec); return rec;
  }
  const CH = { PHONE: 'phone', EMAIL: 'email', WEB: 'web' };
  function applyPatch(rec, body) {
    const { fm, ...rest } = body; Object.assign(rec, rest);
    for (const k of ['phone', 'email', 'web']) if (rest[k]) rec[k] = mf(rest[k]);
    for (const [key, row] of Object.entries(fm || {})) {
      const f = CH[row.typeId]; rec[f] = rec[f] || [];
      if (key.startsWith('n')) { rec[f].push({ id: ++db.seq, value: row.value, typeId: row.valueType }); continue; }
      const i = rec[f].findIndex((x) => String(x.id) === key);
      if (i < 0) { const e = new Error('row'); e.status = 409; e.code = 'MULTIFIELD_ROW_NOT_FOUND'; throw e; }
      if (row.value === '') rec[f].splice(i, 1); else rec[f][i] = { ...rec[f][i], value: row.value };
    }
  }
  function link(companyId, contactId) {
    if (!db.links.some((l) => l.companyId === companyId && l.contactId === contactId)) db.links.push({ companyId, contactId });
    const c = db.contacts.find((x) => x.id === contactId); if (c) c.companyId = companyId;
  }
  const contactsOf = (cid) => db.links.filter((l) => l.companyId === cid).map((l, i) => ({ ...db.contacts.find((c) => c.id === l.contactId), isPrimary: i === 0 }));
  const ok = (data) => ({ success: true, data });
  const nf = () => { const e = new Error('Não encontrado'); e.status = 404; e.code = 'NOT_FOUND'; throw e; };

  async function route(method, path, { query = {}, body = {} } = {}) {
    let m;
    if ((m = /^\/userfields\/(companies|contacts)$/.exec(path))) {
      if (method === 'GET') return ok([...db.userfields[m[1]].map((n) => ({ fieldName: `UF_CRM_${n}` })), ...(m[1] === 'companies' ? [{ fieldName: 'UF_CRM_PRIORIDADE', list: [{ ID: '11', VALUE: 'Alta' }, { ID: '12', VALUE: 'Baixa' }] }, { fieldName: 'UF_CRM_AREAS', list: [{ ID: '21', VALUE: 'Trabalhista' }, { ID: '22', VALUE: 'Tributário' }] }] : [])]);
      db.userfields[m[1]].push(body.fieldName); return { success: true, data: { id: ++db.seq } };
    }
    if (path === '/users') return ok([{ id: 1, name: 'Ana', lastName: 'Silva', active: true }, { id: 7, name: 'Bruno', lastName: 'Costa', active: true }, { id: 9, name: 'Inativo', lastName: 'X', active: false }]);
    if (path === '/statuses') return ok(({ COMPANY_TYPE: [{ statusId: 'CUSTOMER', name: 'Cliente' }, { statusId: 'PARTNER', name: 'Parceiro' }], INDUSTRY: [{ statusId: 'IT', name: 'Tecnologia' }, { statusId: 'LAW', name: 'Jurídico' }], CONTACT_TYPE: [{ statusId: 'CLIENT', name: 'Cliente' }], SOURCE: [{ statusId: 'WEB', name: 'Site' }] })[query['filter[entityId]']] || []);
    if (path === '/companies/fields') return ok({ fields: { id: { type: 'integer', readonly: true, label: 'ID' }, title: { type: 'string', label: 'Nome' }, assignedById: { type: 'user', label: 'Responsável' }, typeId: { type: 'crm_status', label: 'Tipo de empresa' }, industry: { type: 'crm_status', label: 'Setor' }, revenue: { type: 'double', label: 'Receita anual' }, opened: { type: 'boolean', label: 'Disponível para todos' }, comments: { type: 'string', label: 'Comentário' }, createdTime: { type: 'datetime', readonly: true, label: 'Criado' }, logo: { type: 'file', label: 'Logo' }, ufCrmTags: { type: 'string', multiple: true, label: 'Tags' }, ufCrmHubCnpj: { type: 'string', label: 'CNPJ' }, ufCrmHubRazao: { type: 'string', label: 'Razão social' }, ufCrmCnpjCliente: { type: 'string', label: 'CNPJ' }, ufCrmRazaoSocial: { type: 'string', label: 'Razão social' }, ufCrmSituacaoCadastral: { type: 'string', label: 'Situação cadastral' }, ufCrmCnae: { type: 'string', label: 'CNAE' }, ufCrmPorte: { type: 'string', label: 'Porte' }, ufCrmNaturezaJuridica: { type: 'string', label: 'Natureza jurídica' }, ufCrmDataAbertura: { type: 'string', label: 'Data de abertura' }, ufCrmEnderecoCompleto: { type: 'string', label: 'Endereço completo' }, ufCrmContrato: { type: 'date', label: 'Início do contrato' }, ufCrmPrioridade: { type: 'enumeration', label: 'Prioridade' }, ufCrmAreas: { type: 'enumeration', multiple: true, label: 'Áreas de atuação' }, ufCrmArquivo: { type: 'file', label: 'Contrato (PDF)' } } });
    if (path === '/contacts/fields') return ok({ fields: { id: { type: 'integer', readonly: true, label: 'ID' }, name: { type: 'string', label: 'Nome' }, ufCrmCpf: { type: 'string', label: 'CPF' }, assignedById: { type: 'user', label: 'Responsável' }, sourceId: { type: 'crm_status', label: 'Origem' }, birthdate: { type: 'date', label: 'Aniversário' } } });
    if ((m = /^\/crm\/card-config\/(\d+)$/.exec(path))) {
      if (m[1] !== '4' || !db.layout || query.scope !== db.layout.scope) return ok(null);
      return ok(db.layout.sections);
    }
    if (path === '/companies/search') return ok(db.companies.filter((c) => match(c, body.filter)).sort((a, b) => b.id - a.id).slice(body.offset || 0, (body.offset || 0) + (body.limit || 50)));
    if (path === '/contacts/search') return ok(db.contacts.filter((c) => match(c, body.filter)).slice(0, body.limit || 50));
    if (path === '/companies' && method === 'POST') return ok(add('companies', body));
    if (path === '/contacts' && method === 'POST') {
      const rec = add('contacts', body); if (body.companyId) link(Number(body.companyId), rec.id); return ok(rec);
    }
    if ((m = /^\/companies\/(\d+)\/contacts\/(\d+)$/.exec(path)) && method === 'DELETE') {
      db.links = db.links.filter((l) => !(l.companyId === +m[1] && l.contactId === +m[2])); return ok(true);
    }
    if ((m = /^\/companies\/(\d+)\/contacts$/.exec(path)) && method === 'POST') { link(+m[1], Number(body.contactId)); return ok(true); }
    if ((m = /^\/companies\/(\d+)$/.exec(path)) && method === 'DELETE') {
      const i = db.companies.findIndex((x) => x.id === +m[1]); if (i < 0) nf(); db.companies.splice(i, 1);
      db.links = db.links.filter((l) => l.companyId !== +m[1]); return ok(true);
    }
    if ((m = /^\/contacts\/(\d+)$/.exec(path)) && method === 'DELETE') {
      const i = db.contacts.findIndex((x) => x.id === +m[1]); if (i < 0) nf(); db.contacts.splice(i, 1);
      db.links = db.links.filter((l) => l.contactId !== +m[1]); return ok(true);
    }
    if ((m = /^\/contacts\/(\d+)$/.exec(path)) && method === 'PATCH') {
      const c = db.contacts.find((x) => x.id === +m[1]); if (!c) nf(); applyPatch(c, body); return ok(c);
    }
    if ((m = /^\/companies\/(\d+)$/.exec(path))) {
      const c = db.companies.find((x) => x.id === +m[1]); if (!c) nf();
      if (method === 'PATCH') { applyPatch(c, body); return ok(c); }
      return ok(query.include === 'contact' ? { ...c, _included: { contacts: contactsOf(c.id) } } : c);
    }
    if ((m = /^\/contacts\/(\d+)$/.exec(path))) { const c = db.contacts.find((x) => x.id === +m[1]); if (!c) nf(); return ok(c); }
    const e = new Error(`mock: rota não implementada ${method} ${path}`); e.status = 501; throw e;
  }
  const vibe = {
    get: (p, q) => route('GET', p, { query: q }), post: (p, b) => route('POST', p, { body: b }),
    patch: (p, b) => route('PATCH', p, { body: b }), put: (p, b) => route('PUT', p, { body: b }), del: (p) => route('DELETE', p),
  };
  if (seed) {
    const a = add('companies', { title: 'Almeida & Pinheiro Advogados', ufCrmCnpjCliente: '11.222.333/0001-81', ufCrmRazaoSocial: 'Almeida E Pinheiro Sociedade De Advogados', ufCrmSituacaoCadastral: 'Ativa', ufCrmCnae: '6911-7/01 · Serviços advocatícios', ufCrmPorte: 'Demais', ufCrmEnderecoCompleto: 'Av. Paulista, 1000, Bela Vista, São Paulo/SP, 01310-100', phone: [{ value: '(11) 3000-1000', typeId: 'WORK' }], email: [{ value: 'contato@almeidapinheiro.com.br', typeId: 'WORK' }] });
    const b = add('companies', { title: 'Construtora Horizonte', ufCrmCnpjCliente: '00.000.000/0001-91', ufCrmSituacaoCadastral: 'Suspensa', ufCrmEnderecoCompleto: 'Rua das Flores, 45, Centro, Curitiba/PR' });
    const c1 = add('contacts', { name: 'Mariana', lastName: 'Almeida', post: 'Sócia', phone: [{ value: '(11) 99999-0001', typeId: 'MOBILE' }], email: [{ value: 'mariana@almeidapinheiro.com.br', typeId: 'WORK' }] });
    link(a.id, c1.id);
    add('contacts', { name: 'Ricardo', lastName: 'Souza', post: 'Diretor financeiro' });
    void b;
  }
  return { vibe, db };
}

// Consulta fictícia da Receita para o modo demonstração (sem internet).
async function fakeLookup(input) {
  const { isValidCnpj, onlyDigits, CnpjError } = require('./cnpj');
  const d = onlyDigits(input);
  if (!isValidCnpj(d)) throw new CnpjError('CNPJ_INVALID', 'CNPJ inválido: confira os dígitos.', 400);
  if (d.startsWith('99')) throw new CnpjError('CNPJ_NOT_FOUND', 'CNPJ não encontrado na Receita Federal.', 404);
  await new Promise((r) => setTimeout(r, 700));
  return {
    cnpj: d, razaoSocial: 'Vieira Santos Comércio E Serviços Ltda', nomeFantasia: 'Vieira Santos', situacao: d.startsWith('00') ? 'Suspensa' : 'Ativa',
    situacaoData: '12/03/2014', motivoSituacao: '', abertura: '12/03/2014', naturezaJuridica: '2062 - Sociedade Empresária Limitada', porte: 'Demais', capitalSocial: 250000, matriz: true,
    cnae: { codigo: '6911701', descricao: 'Serviços advocatícios' }, cnaesSecundarios: [{ codigo: '7020400', descricao: 'Atividades de consultoria em gestão empresarial' }],
    endereco: { logradouro: 'Avenida Brigadeiro Faria Lima', numero: '3477', complemento: 'Andar 14', bairro: 'Itaim Bibi', cep: '04538-133', municipio: 'São Paulo', uf: 'SP' },
    telefones: ['(11) 3555-0142'], email: 'contato@vieirasantos.com.br',
    socios: [{ nome: 'Helena Vieira Santos', qualificacao: 'Sócio-Administrador' }, { nome: 'Paulo Henrique Santos', qualificacao: 'Sócio' }], fonte: 'Demonstração',
  };
}
module.exports = { createMockVibe, fakeLookup };
