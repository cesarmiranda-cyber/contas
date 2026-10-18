'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('../lib/fin');
const R = require('../lib/rules');
const { createFinStore } = require('../lib/finStore');
const { createSecrets } = require('../lib/secrets');
const { createEmpresas } = require('../lib/empresas');
const { createAsaasRouter } = require('../lib/asaasRouter');
const { createFinApi } = require('../lib/finApi');

const HOJE = '2026-10-18';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fin-'));

test('contas a pagar: parcelas somam o total e vencem mês a mês', () => {
  const l = F.criarContas({ empresaId: 'e1', descricao: 'Notebook', valor: 100, parcelas: 3, venc: '2026-11-30', forma: 'CARTAO' }, HOJE);
  assert.equal(l.length, 3);
  assert.equal(F.round2(l.reduce((a, c) => a + c.valor, 0)), 100);
  assert.deepEqual(l.map(c => c.venc), ['2026-11-30', '2026-12-30', '2027-01-30']);
  assert.deepEqual(l.map(c => c.parcela), ['1/3', '2/3', '3/3']);
  assert.equal(new Set(l.map(c => c.grupo)).size, 1);
  assert.throws(() => F.criarContas({ empresaId: 'e1', descricao: 'Conta xx', valor: 0, venc: '2026-11-30' }), /valor/i);
  assert.throws(() => F.criarContas({ descricao: 'Luz', valor: 10, venc: '2026-11-30' }), /empresa/i);
});

test('status e baixa de conta a pagar', () => {
  const c = F.criarContas({ empresaId: 'e1', descricao: 'Luz', valor: 50, venc: '2026-10-10' }, HOJE)[0];
  assert.equal(F.statusConta(c, HOJE), 'vencida');
  assert.equal(F.statusConta({ ...c, venc: '2026-10-22' }, HOJE), 'a_vencer');
  assert.equal(F.statusConta({ ...c, venc: '2026-12-01' }, HOJE), 'aberta');
  const p = F.baixar(c, { valor: 52.5, forma: 'PIX' }, HOJE);
  assert.equal(p.status, 'paga'); assert.equal(p.valorPago, 52.5); assert.equal(p.pagoEm, HOJE);
  assert.throws(() => F.baixar(c, { data: '2026-12-01' }, HOJE), /data/i);
});

test('folha: gera salário líquido, benefícios e encargos no mês seguinte, sem duplicar', () => {
  const f = { id: 'f1', ...F.validarFuncionario({ empresaId: 'e1', nome: 'Ana Souza', salario: 3000, beneficios: 500, encargos: 900, descontos: 300, diaPagamento: 5 }) };
  const inativo = { id: 'f2', ...F.validarFuncionario({ empresaId: 'e1', nome: 'Beto', salario: 2000, ativo: false, desligamento: '2026-08-15' }) };
  const outra = { id: 'f3', ...F.validarFuncionario({ empresaId: 'e2', nome: 'Carla', salario: 2000 }) };
  const a = F.gerarFolha({ funcionarios: [f, inativo, outra], competencia: '2026-10', empresaId: 'e1' }, HOJE);
  assert.equal(a.length, 3);
  const por = Object.fromEntries(a.map(c => [c.folhaKey.split('|')[3], c]));
  assert.equal(por.salario.valor, 2700); assert.equal(por.salario.venc, '2026-11-05'); assert.equal(por.salario.forma, 'PIX');
  assert.equal(por.beneficios.valor, 500);
  assert.equal(por.encargos.valor, 1200); assert.equal(por.encargos.categoria, 'Encargos e impostos');
  assert.ok(a.every(c => c.origem === 'folha' && c.empresaId === 'e1'));
  assert.equal(F.custoTotal(f), 4400);
  const b = F.gerarFolha({ funcionarios: [f], competencia: '2026-10', empresaId: 'e1', jaGeradas: new Set(a.map(c => c.folhaKey)) }, HOJE);
  assert.equal(b.length, 0);                                               // idempotente
  assert.equal(F.gerarFolha({ funcionarios: [inativo], competencia: '2026-10', empresaId: 'e1' }, HOJE).length, 0);   // desligado antes
  assert.equal(F.gerarFolha({ funcionarios: [inativo], competencia: '2026-07', empresaId: 'e1' }, HOJE).length, 1);   // ainda trabalhava
  assert.throws(() => F.validarFuncionario({ empresaId: 'e1', nome: 'X Y', salario: 1, cpf: '111.111.111-11' }), /CPF/);
  assert.throws(() => F.validarFuncionario({ empresaId: 'e1', nome: 'X Y', salario: 1, diaPagamento: 31 }), /dia/i);
});

test('fluxo de caixa: previsto x realizado, atrasados no mês atual, saldo acumulado', () => {
  const receber = [
    { id: 'r1', empresaId: 'e1', valor: 1000, venc: '2026-10-01', status: 'aberto' },                      // atrasado -> mês atual
    { id: 'r2', empresaId: 'e1', valor: 500, venc: '2026-09-05', status: 'pago', pagoEm: '2026-09-06' },
    { id: 'r3', empresaId: 'e1', valor: 800, venc: '2026-11-10', status: 'aberto' },
    { id: 'r4', empresaId: 'e2', valor: 9999, venc: '2026-11-10', status: 'aberto' },
    { id: 'r5', empresaId: 'e1', valor: 300, venc: '2026-11-10', status: 'cancelado' },
  ];
  const pagar = [
    { id: 'p1', empresaId: 'e1', valor: 400, venc: '2026-09-20', status: 'paga', pagoEm: '2026-09-20', valorPago: 400 },
    { id: 'p2', empresaId: 'e1', valor: 700, venc: '2026-11-05', status: 'aberta' },
    { id: 'p3', empresaId: 'e1', valor: 100, venc: '2026-10-05', status: 'aberta' },
  ];
  const c = F.fluxoCaixa({ receber, pagar, empresaId: 'e1', hoje: HOJE, mesesAtras: 1, mesesFrente: 2, saldoInicial: 200 });
  const m = Object.fromEntries(c.linhas.map(l => [l.mes, l]));
  assert.deepEqual(c.linhas.map(l => l.mes), ['2026-09', '2026-10', '2026-11', '2026-12']);
  assert.equal(m['2026-09'].entradaReal, 500); assert.equal(m['2026-09'].saidaReal, 400); assert.equal(m['2026-09'].saldo, 300);
  assert.equal(m['2026-10'].entradaPrev, 1000); assert.equal(m['2026-10'].saidaPrev, 100); assert.equal(m['2026-10'].saldo, 1200);
  assert.equal(m['2026-11'].entradaPrev, 800); assert.equal(m['2026-11'].saidaPrev, 700); assert.equal(m['2026-11'].saldo, 1300);
  assert.equal(c.saldoFinal, 1300);
  const todas = F.fluxoCaixa({ receber, pagar, hoje: HOJE, mesesAtras: 0, mesesFrente: 1 });
  assert.equal(todas.linhas[1].entradaPrev, 800 + 9999);                    // sem filtro soma as empresas
});

test('resumo: totais, alertas e isolamento por empresa', () => {
  const receber = [
    { id: 'r1', empresaId: 'e1', valor: 1000, venc: '2026-10-01', status: 'aberto' },
    { id: 'r2', empresaId: 'e2', valor: 5000, venc: '2026-10-25', status: 'aberto' },
  ];
  const pagar = [
    { id: 'p1', empresaId: 'e1', valor: 3000, venc: '2026-10-05', status: 'aberta', categoria: 'Fornecedores' },
    { id: 'p2', empresaId: 'e2', valor: 10, venc: '2026-10-05', status: 'paga', pagoEm: '2026-10-05', valorPago: 10, categoria: 'Outros' },
  ];
  const r = F.resumo({ receber, pagar, empresaId: 'e1', hoje: HOJE, contratos: [{ diasParaVencer: 10 }, { diasParaVencer: 90 }, { diasParaVencer: null }] });
  assert.equal(r.aReceber, 1000); assert.equal(r.atrasado, 1000); assert.equal(r.aPagar, 3000); assert.equal(r.vencidoPagar, 3000);
  assert.equal(r.inadimplenciaPct, 100); assert.equal(r.contratosVencer30, 1);
  assert.ok(r.alertas.some(a => /negativo/.test(a.msg)) && r.alertas.some(a => /vencida/.test(a.msg)) && r.alertas.some(a => /contrato/.test(a.msg)));
  assert.equal(F.resumo({ receber, pagar, hoje: HOJE }).aReceber, 6000);
});

test('relatórios e CSV', () => {
  const pagar = F.criarContas({ empresaId: 'e1', descricao: 'Aluguel; sala "A"', valor: 1500.5, venc: '2026-10-20', forma: 'BOLETO', fornecedor: 'Imob' }, HOJE);
  const rel = F.relatorio({ tipo: 'pagar', receber: [], pagar, hoje: HOJE });
  assert.equal(rel.total, 1500.5); assert.equal(rel.linhas.length, 1);
  const csv = F.csv(rel);
  assert.match(csv, /"Aluguel; sala ""A"""/); assert.match(csv, /1500,5/);
  assert.throws(() => F.relatorio({ tipo: 'x', receber: [], pagar: [] }), /desconhecido/);
});

test('contrato: vencimento, dias e marcos de aviso', () => {
  const d = { ID: '7', TITLE: 'Contrato ACME', STAGE_ID: 'C15:WON', OPPORTUNITY: '12000', CLOSEDATE: '2026-11-02T00:00:00+03:00', ASSIGNED_BY_ID: '9', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_FIM: '2026-10-25' };
  const c = F.contratoDeDeal(d, { hoje: HOJE });
  assert.equal(c.venc, '2026-11-02'); assert.equal(c.diasParaVencer, 15); assert.equal(c.status, 'vencendo'); assert.equal(c.companyId, '5'); assert.equal(c.contactId, '');
  assert.equal(F.contratoDeDeal(d, { hoje: HOJE, campoVenc: 'UF_CRM_FIM' }).venc, '2026-10-25');   // campo escolhido nas configurações
  const marcos = [60, 30, 15, 7, 0];
  assert.equal(F.avisoDevido(90, marcos, []), null);
  assert.equal(F.avisoDevido(58, marcos, []), 60);
  assert.equal(F.avisoDevido(58, marcos, [60]), null);
  assert.equal(F.avisoDevido(14, marcos, [60, 30]), 15);                       // pulou o D-30: avisa o marco atual, uma vez
  assert.equal(F.avisoDevido(-3, marcos, [60, 30, 15, 7, 0]), -1);
  assert.equal(F.avisoDevido(-3, marcos, [-1]), null);
  assert.equal(F.avisoDevido(null, marcos, []), null);
});

test('roteador Asaas: usa a chave da empresa dentro de as() e a padrão fora', async () => {
  const mk = name => ({ enabled: true, name, who() { return this.name; }, activePayments: async () => [{ id: name }] });
  const base = mk('base'), emp = mk('e1');
  const r = createAsaasRouter({ base, clientFor: id => (id === 'e1' ? emp : null), allClients: () => [emp] });
  assert.equal(r.who(), 'base');
  assert.equal(await r.as('e1', async () => { await null; return r.who(); }), 'e1');
  assert.equal(await r.as('e2', async () => r.who()), 'base');                  // empresa sem chave -> conta padrão
  assert.deepEqual((await r.activePayments()).map(p => p.id), ['base', 'e1']);
});

// ---------- API com Bitrix falso ----------
function api({ deals = [], contratos = [], notify = [] } = {}) {
  const dir = tmp(), fin = createFinStore(dir), secrets = createSecrets(dir);
  const calls = [];
  const bitrix = {
    enabled: true, base: 'https://portal.bitrix24.com.br/rest/1/x',
    async call(m, p) {
      calls.push([m, p]);
      if (m === 'crm.deal.userfield.list') return { result: [{ ID: '1', FIELD_NAME: 'UF_CRM_CR_EMPRESA', LIST: [{ ID: '11', VALUE: 'Alfa Ltda' }, { ID: '12', VALUE: 'Beta SA' }] }] };
      if (m === 'crm.status.list') return { result: [{ STATUS_ID: 'C15:NEW', NAME: 'Novo', EXTRA: { SEMANTICS: '' } }, { STATUS_ID: 'C15:LOSE', NAME: 'Perdido', EXTRA: { SEMANTICS: 'F' } }] };
      if (m === 'crm.company.list') return { result: [{ ID: '5', TITLE: 'ACME Ltda' }] };
      if (m === 'crm.company.get') return { result: { TITLE: 'ACME Ltda', UF_CRM_CNPJ: '11.222.333/0001-81', EMAIL: [{ VALUE: 'a@acme.com' }] } };
      if (m === 'im.notify.personal.add') { notify.push(p); return { result: 1 }; }
      return { result: true };
    },
    async listAll(m) { return m === 'crm.deal.list' ? contratos : []; },
  };
  const empresas = createEmpresas({ fin, secrets, bitrix, createAsaas: () => ({ configure() {}, get enabled() { return false; } }) });
  const svc = { dealsCached: async () => deals };
  const store = { log() {} };
  const asaas = { as: (_, f) => f(), enabled: false };
  const a = createFinApi({ fin, empresas, svc, bitrix, asaas, store });
  const call = async (method, p, body, q = '') => (await a.handle(method, `/api/fin${p}`, new URL('http://x/?' + q), async () => body || {}))?.json;
  return { a, fin, empresas, call, calls, notify, dir };
}

test('API: empresas, validações e isolamento entre empresas', async () => {
  const { call, fin } = api();
  const e1 = await call('POST', '/empresas', { nome: 'Alfa Ltda', cnpj: '11.222.333/0001-81' });
  const e2 = await call('POST', '/empresas', { nome: 'Beta SA' });
  await assert.rejects(call('POST', '/empresas', { nome: 'alfa ltda' }), /Já existe/);
  await assert.rejects(call('POST', '/empresas', { nome: 'Gama', cnpj: '123' }), /CNPJ/);
  await call('POST', '/pagar', { empresaId: e1.id, descricao: 'Aluguel Alfa', valor: 1000, venc: '2026-12-10', forma: 'PIX' });
  await call('POST', '/pagar', { empresaId: e2.id, descricao: 'Aluguel Beta', valor: 2000, venc: '2026-12-10', parcelas: 2 });
  assert.equal((await call('GET', '/pagar', null, `empresa=${e1.id}`)).length, 1);
  assert.equal((await call('GET', '/pagar', null, `empresa=${e2.id}`)).length, 2);
  assert.equal((await call('GET', '/pagar', null, 'empresa=todas')).length, 3);
  await assert.rejects(call('POST', '/pagar', { empresaId: 'inexistente', descricao: 'x', valor: 1, venc: '2026-12-10' }), /Empresa/);
  await assert.rejects(call('DELETE', `/empresas/${e1.id}`), /lançamentos/);          // não apaga empresa com movimento
  assert.ok(fin.empresas.all().length === 2);
});

test('API: chave do Asaas por empresa nunca volta inteira e valida o ambiente', async () => {
  const { call } = api();
  const e = await call('POST', '/empresas', { nome: 'Alfa Ltda' });
  await assert.rejects(call('PUT', `/empresas/${e.id}/asaas`, { apiKey: '$aact_prod_abc', env: 'sandbox' }), /PRODUÇÃO/);
  const r = await call('PUT', `/empresas/${e.id}/asaas`, { apiKey: '$aact_hmlg_1234567890', env: 'sandbox' });
  assert.equal(r.asaas.configurado, true); assert.equal(r.asaas.dica, '••••7890');
  assert.ok(!JSON.stringify(await call('GET', '/empresas')).includes('aact_hmlg'));
  assert.equal((await call('DELETE', `/empresas/${e.id}/asaas`)).asaas.configurado, false);
});

test('API: folha gera contas a pagar uma única vez e a geração automática respeita a competência', async () => {
  const { call, a, fin } = api();
  const e = await call('POST', '/empresas', { nome: 'Alfa Ltda' });
  await call('POST', '/funcionarios', { empresaId: e.id, nome: 'Ana Souza', salario: 3000, beneficios: 200, encargos: 800, diaPagamento: 5 });
  const r1 = await call('POST', '/folha/gerar', { empresaId: e.id, competencia: '2026-10' });
  assert.equal(r1.novas, 3);
  assert.equal((await call('POST', '/folha/gerar', { empresaId: e.id, competencia: '2026-10' })).novas, 0);
  const pag = await call('GET', '/pagar', null, `empresa=${e.id}`);
  assert.equal(pag.filter(c => c.origem === 'folha').length, 3);
  await call('POST', '/funcionarios', { empresaId: e.id, nome: 'Novo Func', salario: 1000 });
  assert.equal((await call('POST', '/folha/gerar', { empresaId: e.id, competencia: '2026-10' })).novas, 1);   // só o novo
  fin.setConfig({ folhaAuto: false });
  assert.deepEqual(a.folhaAuto(), []);
  const rel = await call('GET', '/relatorio', null, `tipo=folha&empresa=${e.id}`);
  assert.equal(rel.linhas.length, 2);
});

test('API: contrato mostra só dados do contrato/cliente e avisa o responsável uma vez por marco', async () => {
  const hoje = R.todayBR(), em = n => new Date(Date.parse(hoje + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const contratos = [
    { ID: '1', TITLE: 'Contrato A', STAGE_ID: 'C15:NEW', OPPORTUNITY: '1000', CLOSEDATE: em(6), ASSIGNED_BY_ID: '9', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_EMPRESA: '11' },
    { ID: '2', TITLE: 'Contrato B', STAGE_ID: 'C15:NEW', OPPORTUNITY: '2000', CLOSEDATE: em(200), ASSIGNED_BY_ID: '9', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_EMPRESA: '12' },
    { ID: '3', TITLE: 'Contrato perdido', STAGE_ID: 'C15:LOSE', OPPORTUNITY: '5', CLOSEDATE: em(2), ASSIGNED_BY_ID: '9', COMPANY_ID: '5', CONTACT_ID: '0' },
  ];
  const deals = [
    { id: 50, titulo: 'Parcela 1/2', stageId: R.STAGES.paid, valor: 500, venc: em(-20), pagoEm: em(-19), companyId: '5', contactId: '0', cliente: 'ACME', empresa: '' },
    { id: 51, titulo: 'Parcela 2/2', stageId: R.STAGES.late, valor: 500, venc: em(-2), companyId: '5', contactId: '0', cliente: 'ACME', empresa: '' },
    { id: 52, titulo: 'Outro cliente', stageId: R.STAGES.open, valor: 7777, venc: em(10), companyId: '6', contactId: '0', cliente: 'Outro', empresa: '' },
  ];
  const { call, notify, fin, empresas } = api({ deals, contratos });
  await call('POST', '/empresas', { nome: 'Alfa Ltda' }); await call('POST', '/empresas', { nome: 'Beta SA' });
  await empresas.loadEnum(true);
  const lista = await call('GET', '/contratos');
  assert.deepEqual(lista.map(c => c.id), [1, 2]);                              // perdido fica de fora
  assert.equal(lista[0].cliente, 'ACME Ltda'); assert.equal(lista[0].diasParaVencer, 6);
  assert.equal((await call('GET', '/contratos', null, `empresa=${fin.empresas.all()[0].id}`)).length, 1);   // filtro por empresa (campo de lista do Bitrix)
  const v = await call('GET', '/contratos/1');
  assert.equal(v.cliente.nome, 'ACME Ltda'); assert.equal(v.contrato.empresa, 'Alfa Ltda');
  assert.deepEqual(v.financeiro.parcelas.map(p => p.id), ['deal_50', 'deal_51']);
  assert.equal(v.financeiro.aberto, 500); assert.equal(v.financeiro.pago, 500);
  assert.ok(!JSON.stringify(v).includes('7777'));                              // nada de outro cliente
  const sim = await call('POST', '/contratos/avisar', { simular: true });
  assert.equal(sim.enviados.length, 1); assert.equal(notify.length, 0);
  const r1 = await call('POST', '/contratos/avisar', {});
  assert.equal(r1.enviados.length, 1); assert.equal(notify.length, 1);
  assert.equal(notify[0].USER_ID, '9'); assert.match(notify[0].MESSAGE, /Contrato A/); assert.match(notify[0].MESSAGE, /6 dia/);
  assert.equal((await call('POST', '/contratos/avisar', {})).enviados.length, 0);   // não repete o mesmo marco
  await assert.rejects(call('GET', '/contratos/999'), /não encontrado/);
});

test('API: pagar pelo Asaas exige confirmação e dados do boleto/Pix', async () => {
  const { call } = api();
  const e = await call('POST', '/empresas', { nome: 'Alfa Ltda' });
  const [c] = await call('POST', '/pagar', { empresaId: e.id, descricao: 'Fornecedor', valor: 100, venc: '2026-12-10', forma: 'BOLETO' });
  await assert.rejects(call('POST', `/pagar/${c.id}/asaas`, {}), /Confirme/);
  await assert.rejects(call('POST', `/pagar/${c.id}/asaas`, { confirmar: true }), /Asaas/);   // empresa sem chave
});

test('API: campo de empresa no Bitrix recebe os nomes das empresas ativas', async () => {
  const { call, calls } = api();
  await call('POST', '/empresas', { nome: 'Alfa Ltda' }); await call('POST', '/empresas', { nome: 'Gama Novo' });
  const r = await call('POST', '/empresas/sincronizar-campo');
  assert.deepEqual(r.opcoes, ['Alfa Ltda', 'Gama Novo']);
  const up = calls.find(([m]) => m === 'crm.deal.userfield.update');
  assert.ok(up && up[1].fields.LIST.some(i => i.VALUE === 'Gama Novo') && up[1].fields.LIST.some(i => i.ID === '11'));   // mantém os itens existentes
});
