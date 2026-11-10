'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBitrix, consultar, criarExclusao, criarOrcamentos, criarFunisNomes } = require('../lib');

// Bitrix falso: responde ao batch executando cada comando contra tabelas em memória.
function fake() {
  const calls = [];
  const fetchImpl = async (url, { body }) => {
    const method = url.split('/').pop().replace('.json', '');
    const p = new URLSearchParams(body); calls.push(method);
    const ok = j => ({ json: async () => j, status: 200 });
    if (method === 'user.get') return ok({ result: [{ ID: '7', NAME: 'Ana', LAST_NAME: 'Lima' }] });
    const out = { result: {}, result_total: {} };
    for (const [k, v] of p) {
      const m = k.match(/^cmd\[(.+)\]$/); if (!m) continue;
      const [meth] = v.split('?');
      out.result[m[1]] = meth === 'crm.company.list' ? [{ ID: '1', TITLE: 'Acme', ASSIGNED_BY_ID: '7' }]
        : meth === 'crm.contact.list' ? []
        : meth === 'crm.deal.list' && v.includes('filter%5BCATEGORY_ID') ? [{ ID: '20', TITLE: 'Orçamento livro X', STAGE_ID: 'C5:NEW', STAGE_SEMANTIC_ID: 'P', DATE_CREATE: '2026-02-03T10:00:00-03:00', ASSIGNED_BY_ID: '7' }]
        : meth === 'crm.deal.list' ? [{ ID: '9', TITLE: 'Venda', STAGE_SEMANTIC_ID: 'S', ASSIGNED_BY_ID: '7', OPPORTUNITY: '100', CURRENCY_ID: 'BRL', DATE_CREATE: '2026-01-02T10:00:00-03:00' }]
        : [{ ID: '5', SUBJECT: 'Ligar', TYPE_ID: '2', CREATED: v.includes('OWNER_TYPE_ID%5D=4') ? '2026-03-01T10:00:00-03:00' : '2026-05-01T10:00:00-03:00' }];
      out.result_total[m[1]] = out.result[m[1]].length;
    }
    return ok({ result: out });
  };
  return { bx: createBitrix('https://x.bitrix24.com.br/rest/1/tok/', fetchImpl), calls };
}

test('resume responsável, negócio e última atividade (própria ou de negócio)', async () => {
  const { bx } = fake();
  const { resultados } = await consultar(bx, 'acme', { agora: () => Date.parse('2026-11-10') });
  const r = resultados[0];
  assert.equal(r.nome, 'Acme'); assert.equal(r.responsavel, 'Ana Lima');
  assert.equal(r.negocios.total, 1); assert.equal(r.negocios.ultimo.situacao, 'Ganho');
  assert.equal(r.situacao, 'Inativo'); assert.ok(r.diasSemMovimento > 90);
  assert.equal(r.negocios.ultimo.valor, undefined); assert.equal(r.negocios.ultimo.responsavel, 'Ana Lima');
  assert.equal(r.negocios.itens.length, 1); assert.equal(r.negocios.ganhos, 1); assert.equal(r.negocios.perdidos, 0);
  assert.equal(r.atividades.total, 2); assert.match(r.atividades.ultima.data, /2026-05-01/);
});
test('exige ao menos 3 letras', async () => {
  const { bx, calls } = fake();
  await assert.rejects(consultar(bx, 'ab'), e => e.status === 400);
  assert.equal(calls.length, 0);
});
test('cliente com movimento recente aparece como Ativo', async () => {
  const { bx } = fake();
  const { resultados } = await consultar(bx, 'acme', { agora: () => Date.parse('2026-05-20') });
  assert.equal(resultados[0].situacao, 'Ativo');
});
test('ignora sufixo colado no webhook (ex.: /profile/)', async () => {
  let url; const bx = createBitrix(' https://x.bitrix24.com.br/rest/1/tok/profile/ ', async u => { url = u; return { json: async () => ({ result: [] }) }; });
  await bx.call('crm.company.list');
  assert.equal(url, 'https://x.bitrix24.com.br/rest/1/tok/crm.company.list.json');
});

test('não mostra clientes cujo responsável é do departamento excluído', async () => {
  const { bx } = fake();                                   // o cliente "Acme" pertence ao usuário 7
  const r = await consultar(bx, 'acme', { excluirResponsaveis: async () => ['7', '8'] });
  assert.deepEqual(r.resultados, []);
});
test('exclusão resolve departamento pelo nome e lista os usuários', async () => {
  const chamadas = [];
  const bx = { call: async (m, p) => { chamadas.push(m);
    if (m === 'department.get') return { result: [{ ID: '5', NAME: 'Vendas - Pack' }, { ID: '6', NAME: 'Vendas - Pack 2' }] };
    return { result: [{ ID: '7' }, { ID: '8' }] }; } };
  assert.deepEqual(await criarExclusao(bx, 'vendas - pack')(), ['7', '8']);
});
test('exclusão falha fechada se o departamento não existe', async () => {
  const bx = { call: async () => ({ result: [] }) };
  await assert.rejects(criarExclusao(bx, 'Inexistente')(), /não encontrado/);
});

test('mostra quem consultou antes e registra a consulta atual', async () => {
  const { bx } = fake(); const regs = [];
  const historico = { ler: k => k === '4_1' ? [{ u: '7', t: '2026-11-01T10:00:00Z' }] : [], registrar: (k, u) => regs.push([k, u]) };
  const { resultados } = await consultar(bx, 'acme', { historico, usuario: '99' });
  assert.equal(resultados[0].consultas[0].nome, 'Ana Lima'); assert.equal(resultados[0].consultas[0].voce, false);
  assert.deepEqual(regs, [['4_1', '99']]);
});

test('lista os orçamentos do cliente (funil resolvido pelo nome) com etapa e responsável', async () => {
  const { bx } = fake();
  const orcamentos = async () => ({ ids: ['5'], stages: { 'C5:NEW': 'Em análise' } });
  const { resultados } = await consultar(bx, 'acme', { orcamentos });
  const o = resultados[0].orcamentos;
  assert.equal(o.total, 1); assert.equal(o.itens[0].titulo, 'Orçamento livro X');
  assert.equal(o.itens[0].etapa, 'Em análise'); assert.equal(o.itens[0].responsavel, 'Ana Lima');
});
test('funil de orçamento inexistente não derruba a busca', async () => {
  const { bx } = fake();
  const orc = criarOrcamentos({ call: async () => ({ result: [{ ID: '1', NAME: 'Outro' }] }) }, 'Orçamento Editorial');
  const { resultados } = await consultar(bx, 'acme', { orcamentos: orc });
  assert.equal(resultados[0].orcamentos.erro, true); assert.equal(resultados[0].nome, 'Acme');
});
test('criarOrcamentos acha o funil pelo nome e as etapas', async () => {
  const bx = { call: async m => m === 'crm.dealcategory.list' ? { result: [{ ID: '5', NAME: 'Orçamento Editorial' }] } : { result: [{ STATUS_ID: 'C5:NEW', NAME: 'Nova' }] } };
  assert.deepEqual(await criarOrcamentos(bx, 'orçamento editorial')(), { ids: ['5'], stages: { 'C5:NEW': 'Nova' } });
});

test('lista todos os negócios com situação ganho/perdido/em andamento e nome do funil', async () => {
  const bx = createBitrix('https://x.bitrix24.com.br/rest/1/t/', async (url, { body }) => {
    const p = new URLSearchParams(body), out = { result: {}, result_total: {} };
    const ok = j => ({ json: async () => j });
    if (url.endsWith('user.get.json')) return ok({ result: [{ ID: '7', NAME: 'Ana', LAST_NAME: 'Lima' }] });
    for (const [k, v] of p) { const m = k.match(/^cmd\[(.+)\]$/); if (!m) continue; const meth = v.split('?')[0];
      out.result[m[1]] = meth === 'crm.company.list' ? [{ ID: '1', TITLE: 'Acme', ASSIGNED_BY_ID: '7' }] : meth === 'crm.deal.list' ? [
        { ID: '3', TITLE: 'C', STAGE_SEMANTIC_ID: 'P', CATEGORY_ID: '0', DATE_CREATE: '2026-03-01T10:00:00-03:00', ASSIGNED_BY_ID: '7' },
        { ID: '2', TITLE: 'B', STAGE_SEMANTIC_ID: 'F', CATEGORY_ID: '5', DATE_CREATE: '2026-02-01T10:00:00-03:00', ASSIGNED_BY_ID: '7' },
        { ID: '1', TITLE: 'A', STAGE_SEMANTIC_ID: 'S', CATEGORY_ID: '5', DATE_CREATE: '2026-01-01T10:00:00-03:00', ASSIGNED_BY_ID: '7' }] : [];
      out.result_total[m[1]] = out.result[m[1]].length; }
    return ok({ result: out });
  });
  const { resultados } = await consultar(bx, 'acme', { funisNomes: async () => ({ 0: 'Funil geral', 5: 'Orçamento Editorial' }) });
  const n = resultados[0].negocios;
  assert.deepEqual([n.total, n.ganhos, n.perdidos, n.andamento], [3, 1, 1, 1]);
  assert.deepEqual(n.itens.map(i => [i.titulo, i.situacao, i.funil]), [['C', 'Em andamento', 'Funil geral'], ['B', 'Perdido', 'Orçamento Editorial'], ['A', 'Ganho', 'Orçamento Editorial']]);
});

test('pede os negócios de todos os funis (o geral e os demais)', async () => {
  const pedidos = [];
  const bx = createBitrix('https://x.bitrix24.com.br/rest/1/t/', async (url, { body }) => {
    const p = new URLSearchParams(body), out = { result: {}, result_total: {} }, ok = j => ({ json: async () => j });
    if (url.endsWith('user.get.json')) return ok({ result: [] });
    for (const [k, v] of p) { const m = k.match(/^cmd\[(.+)\]$/); if (!m) continue; pedidos.push(decodeURIComponent(v));
      out.result[m[1]] = v.startsWith('crm.company.list') ? [{ ID: '1', TITLE: 'Acme', ASSIGNED_BY_ID: '7' }] : []; out.result_total[m[1]] = 0; }
    return ok({ result: out });
  });
  await consultar(bx, 'acme', { funisNomes: async () => ({ 0: 'Funil geral', 5: 'Orçamento Editorial', 9: 'Pack' }) });
  const d = pedidos.find(x => x.startsWith('crm.deal.list'));
  for (const id of ['0', '5', '9']) assert.ok(d.includes(`filter[CATEGORY_ID][${['0', '5', '9'].indexOf(id)}]=${id}`), d);
});
