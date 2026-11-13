'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cnpj = require('../lib/cnpj');
const { createCrm, F } = require('../lib/crm');
const { createMockVibe, fakeLookup } = require('../lib/mock');
const { createApp } = require('../server');

test('CNPJ/CPF: validação e máscara', () => {
  assert.ok(cnpj.isValidCnpj('00.000.000/0001-91'));
  assert.ok(cnpj.isValidCnpj('11222333000181'));
  assert.ok(!cnpj.isValidCnpj('11.222.333/0001-82'));
  assert.ok(!cnpj.isValidCnpj('11111111111111'));
  assert.ok(cnpj.isValidCpf('529.982.247-25'));
  assert.ok(!cnpj.isValidCpf('529.982.247-24'));
  assert.equal(cnpj.formatCnpj('11222333000181'), '11.222.333/0001-81');
  assert.equal(cnpj.formatCpf('52998224725'), '529.982.247-25');
});

test('Receita: normaliza BrasilAPI e cai para ReceitaWS quando o 1º provedor falha', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('brasilapi')) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ status: 'OK', nome: 'ACME COMERCIO LTDA', fantasia: 'ACME', situacao: 'ATIVA', abertura: '01/02/2010', atividade_principal: [{ code: '69.11-7-01', text: 'Serviços advocatícios' }], logradouro: 'RUA A', numero: '10', bairro: 'CENTRO', municipio: 'SAO PAULO', uf: 'SP', cep: '01.001-000', telefone: '(11) 3000-1000 / (11) 99999-8888', email: 'ACME@X.COM', qsa: [{ nome: 'JOAO DA SILVA', qual: '49-Sócio-Administrador' }] }) };
  };
  const out = await cnpj.createLookup({ fetchImpl })('11222333000181');
  assert.equal(calls.length, 2);
  assert.equal(out.razaoSocial, 'Acme Comercio Ltda');
  assert.equal(out.situacao, 'Ativa');
  assert.deepEqual(out.telefones, ['(11) 3000-1000', '(11) 99999-8888']);
  assert.equal(out.endereco.cep, '01001-000');
  assert.equal(out.socios[0].qualificacao, 'Sócio-Administrador');
  assert.equal(out.fonte, 'ReceitaWS');
});

test('Receita: 404 vira CNPJ_NOT_FOUND; falha geral vira LOOKUP_UNAVAILABLE; inválido nem consulta', async () => {
  const nf = cnpj.createLookup({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  await assert.rejects(nf('11222333000181'), { code: 'CNPJ_NOT_FOUND' });
  const down = cnpj.createLookup({ fetchImpl: async () => { throw new Error('rede'); } });
  await assert.rejects(down('11222333000181'), { code: 'LOOKUP_UNAVAILABLE' });
  await assert.rejects(down('123'), { code: 'CNPJ_INVALID' });
});

test('CRM: cria campos uma vez, cadastra empresa + contatos, bloqueia CNPJ duplicado', async () => {
  const { vibe, db } = createMockVibe(false);
  const crm = createCrm(vibe);
  const empresa = { title: 'Acme', razaoSocial: 'Acme Ltda', cnpj: '11222333000181', situacao: 'Ativa', telefones: ['(11) 3000-1000'], emails: ['a@acme.com'] };
  const r = await crm.createCompany({ empresa, contatos: [{ nome: 'Maria Souza', cargo: 'Sócia', telefone: '(11) 99999-0000', cpf: '529.982.247-25' }] });
  assert.ok(r.id && r.contatos[0].ok);
  assert.equal(db.userfields.companies.length, 9);
  await crm.ensureSchema();
  assert.equal(db.userfields.companies.length, 9);
  const c = await crm.getCompany(r.id);
  assert.equal(c.cnpj, '11.222.333/0001-81');
  assert.equal(c.contatos.length, 1);
  assert.equal(c.contatos[0].cpf, '529.982.247-25');
  assert.equal((await crm.findByCnpj('11.222.333/0001-81')).id, r.id);
  await assert.rejects(crm.createCompany({ empresa }), { code: 'CNPJ_DUPLICATE', status: 409 });
});

test('CRM: valida tudo antes de gravar (CPF inválido não deixa empresa órfã)', async () => {
  const { vibe, db } = createMockVibe(false);
  const crm = createCrm(vibe);
  await assert.rejects(crm.createCompany({ empresa: { title: 'X', cnpj: '11222333000181' }, contatos: [{ nome: 'Fulano', cpf: '111.111.111-11' }] }), /CPF inválido/);
  assert.equal(db.companies.length, 0);
});

test('CRM: vincular contato existente, desvincular e buscar', async () => {
  const { vibe } = createMockVibe(true);
  const crm = createCrm(vibe);
  const found = await crm.searchContacts('ricardo');
  assert.equal(found.length, 1);
  const { items } = await crm.listCompanies({ q: 'construtora' });
  assert.equal(items.length, 1);
  await crm.addContact(items[0].id, { contactId: found[0].id });
  assert.equal((await crm.getCompany(items[0].id)).contatos.length, 1);
  await assert.rejects(crm.addContact(items[0].id, { contactId: 99999 }), { status: 404 });
  await crm.unlinkContact(items[0].id, found[0].id);
  assert.equal((await crm.getCompany(items[0].id)).contatos.length, 0);
  assert.equal((await crm.listCompanies({ q: '11.222' })).items.length, 1);   // busca por CNPJ parcial
});

async function withServer(opts, fn) {
  const server = createApp(opts); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
test('Servidor: exige identidade do gateway e cabeçalho anti-CSRF; fluxo CNPJ → cadastro', async () => {
  const { vibe } = createMockVibe(true);
  await withServer({ vibeFactory: () => vibe, lookup: fakeLookup, mock: false }, async (base) => {
    assert.equal((await fetch(`${base}/api/companies`)).status, 401);
    const h = { 'x-vibe-user-id': '7', 'x-vibe-user-name-encoded': encodeURIComponent('Ana Jurídica') };
    assert.equal((await (await fetch(`${base}/api/me`, { headers: h })).json()).user.name, 'Ana Jurídica');
    assert.equal((await fetch(`${base}/api/companies`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/cnpj?v=123`, { headers: h })).status, 400);
    const dup = await (await fetch(`${base}/api/cnpj?v=11222333000181`, { headers: h })).json();
    assert.equal(dup.existing.title, 'Almeida & Pinheiro Advogados');
    const novo = await (await fetch(`${base}/api/cnpj?v=34028316000103`, { headers: h })).json();
    assert.equal(novo.existing, null);
    assert.equal(novo.receita.socios.length, 2);
    const res = await fetch(`${base}/api/companies`, { method: 'POST', headers: { ...h, 'content-type': 'application/json', 'x-hub': '1' }, body: JSON.stringify({ empresa: { title: 'Vieira Santos', cnpj: '34028316000103' }, contatos: [{ nome: 'Helena Vieira Santos' }] }) });
    assert.equal(res.status, 201);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/server.js`)).status, 404);              // código do servidor não é servido
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
    assert.equal((await fetch(`${base}/clientes/12`)).status, 200);            // rota do SPA
  });
});
