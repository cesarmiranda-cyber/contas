'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('../lib/rules');
const { createFinStore } = require('../lib/finStore');
const { createSecrets } = require('../lib/secrets');
const { createEmpresas } = require('../lib/empresas');
const { createFinApi } = require('../lib/finApi');

const D = R.todayBR(), em = n => new Date(Date.parse(D + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function api({ contratos = [], asaasOn = true, estado = null, minhas = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-')), fin = createFinStore(dir), secrets = createSecrets(dir);
  const calls = [], gerar = [], syncs = [];
  const bitrix = {
    enabled: true, base: 'https://portal.bitrix24.com.br/rest/1/x',
    async call(m, p) {
      calls.push([m, p]);
      if (m === 'crm.deal.userfield.list') return { result: [{ ID: '1', FIELD_NAME: 'UF_CRM_CR_EMPRESA', LIST: [{ ID: '11', VALUE: 'Nutri Mix' }] }] };
      if (m === 'crm.status.list') return { result: [{ STATUS_ID: 'C15:NEW', NAME: 'Novo', EXTRA: { SEMANTICS: '' } }] };
      if (m === 'crm.company.list') return { result: [{ ID: '5', TITLE: 'ACME Ltda' }] };
      if (m === 'crm.company.get') return { result: { TITLE: 'ACME Ltda', UF_CRM_CNPJ: '11.222.333/0001-81', EMAIL: [{ VALUE: 'a@acme.com' }] } };
      if (m === 'user.get') return { result: [{ ID: '9', NAME: 'Marina', LAST_NAME: 'Lopes' }] };
      return { result: [] };
    },
    async listAll(m) { return m === 'crm.deal.list' ? contratos : m === 'crm.company.list' ? minhas : []; },
  };
  const empresas = createEmpresas({ fin, secrets, bitrix, createAsaas: () => ({ configure() {}, enabled: false }) });
  const svc = { dealsCached: async () => [], gerar: async p => { gerar.push(p); return { ids: p.parcelas === 1 ? ['100'] : ['100', '101', '102'], schedule: [] }; }, sync: async () => { syncs.push(1); return {}; }, estado: async () => estado };
  const a = createFinApi({ fin, empresas, svc, bitrix, asaas: { as: (_, f) => f(), enabled: asaasOn }, store: { log() {}, logs: [{ at: new Date().toISOString(), type: 'teste', msg: 'uma atividade' }] }, dataDir: dir });
  const call = async (method, p, body, q = '') => (await a.handle(method, `/api/fin${p}`, new URL('http://x/?' + q), async () => body || {}))?.json;
  return { call, fin, empresas, gerar, syncs, calls };
}
const contrato = extra => ({ ID: '9', TITLE: 'Contrato ACME', STAGE_ID: 'C15:NEW', OPPORTUNITY: '12000', CLOSEDATE: em(300), ASSIGNED_BY_ID: '9', COMPANY_ID: '5', CONTACT_ID: '0', MYCOMPANY_ID: '2', UF_CRM_CR_EMPRESA: '11', ...extra });

test('contrato do funil 15 gera cobranças: parcelas no funil de cobranças com responsável e empresa, uma vez só', async () => {
  const { call, fin, gerar, syncs, empresas } = api({ contratos: [contrato()] });
  await call('POST', '/empresas', { nome: 'Nutri Mix', cnpj: '19.340.693/0001-90' }); await empresas.loadEnum(true);
  const antes = await call('GET', '/contratos/9'); assert.equal(antes.cobrancas, null); assert.equal(antes.asaasPronto, true);
  await assert.rejects(call('POST', '/contratos/9/gerar-cobrancas', { valor: 0, parcelas: 3, primeiroVenc: em(5) }), /valor total/);
  await assert.rejects(call('POST', '/contratos/9/gerar-cobrancas', { valor: 12000, parcelas: 99, primeiroVenc: em(5) }), /entre 1 e 60/);
  await assert.rejects(call('POST', '/contratos/9/gerar-cobrancas', { valor: 12000, parcelas: 3, primeiroVenc: 'x' }), /primeiro vencimento/);
  const r = await call('POST', '/contratos/9/gerar-cobrancas', { valor: 12000, parcelas: 3, primeiroVenc: em(5), forma: 'PIX', emitirAsaas: true });
  assert.deepEqual(r.ids, ['100', '101', '102']);
  assert.equal(gerar.length, 1);
  const g = gerar[0];
  assert.deepEqual([g.total, g.parcelas, g.primeiroVenc, g.tipo, g.forma, g.companyId, g.origem, g.doc], [12000, 3, em(5), 'PARCELADO', 'PIX', '5', 9, '11222333000181']);
  assert.equal(g.extra.ASSIGNED_BY_ID, '9'); assert.equal(g.extra.MYCOMPANY_ID, '2'); assert.equal(g.extra.UF_CRM_CR_EMPRESA, '11');   // responsável e empresa herdados
  assert.equal(syncs.length, 1);                                                        // emissão no Asaas disparada
  assert.equal(fin.cobrancaContrato('9').parcelas, 3);
  assert.equal((await call('GET', '/contratos/9')).cobrancas.total, 12000);
  await assert.rejects(call('POST', '/contratos/9/gerar-cobrancas', { valor: 12000, parcelas: 3, primeiroVenc: em(5) }), /já foram geradas/);
  assert.equal(gerar.length, 1);
});

test('gerar cobranças exige cliente e, para emitir no Asaas, Asaas ativo e documento válido', async () => {
  const sem = api({ contratos: [contrato({ COMPANY_ID: '0', CONTACT_ID: '0' })] });
  await assert.rejects(sem.call('POST', '/contratos/9/gerar-cobrancas', { valor: 100, parcelas: 1, primeiroVenc: em(5) }), /não tem cliente/);
  const off = api({ contratos: [contrato()], asaasOn: false });
  await assert.rejects(off.call('POST', '/contratos/9/gerar-cobrancas', { valor: 100, parcelas: 1, primeiroVenc: em(5), emitirAsaas: true }), /Asaas não está configurado/);
  const ok = await off.call('POST', '/contratos/9/gerar-cobrancas', { valor: 100, parcelas: 1, primeiroVenc: em(5) });   // sem emitir: só cria as parcelas
  assert.deepEqual(ok.ids, ['100']); assert.equal(off.gerar[0].tipo, 'UNICA'); assert.equal(off.syncs.length, 0);
});

test('relatórios novos: estoque, notas, extrato, fluxo e inadimplência (com CSV)', async () => {
  const { call, fin } = api();
  const emp = await call('POST', '/empresas', { nome: 'Alfa Ltda' });
  const conta = await call('POST', '/cad/contas', { empresaId: emp.id, nome: 'Itaú', saldoInicial: 1000, dataSaldo: `${D.slice(0, 4)}-01-01` });
  const prod = await call('POST', '/produtos', { empresaId: emp.id, nome: 'Sabão', un: 'CX', estoqueMin: 20 });
  await call('POST', '/estoque/movimento', { produtoId: prod.id, tipo: 'entrada', qtd: 10, custoUnit: 25, data: D });
  const est = await call('GET', '/relatorio', null, `tipo=estoque&empresa=${emp.id}`);
  assert.deepEqual(est.linhas[0], ['Sabão', 'CX', 10, 25, 250, 20, 'abaixo do mínimo']); assert.deepEqual(est.num, [2, 5]); assert.equal(est.total, 250);
  const [p] = await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Aluguel', valor: 300, venc: D, contaId: conta.id }); await call('POST', `/pagar/${p.id}/baixar`, { data: D, contaId: conta.id });
  const ext = await call('GET', '/relatorio', null, `tipo=extrato&conta=${conta.id}`);
  assert.equal(ext.linhas.length, 1); assert.equal(ext.total, 700);
  await assert.rejects(call('GET', '/relatorio', null, 'tipo=extrato'), /Escolha a conta/);
  await call('POST', '/receber', { empresaId: emp.id, descricao: 'Venda atrasada', cliente: 'ACME', valor: 500, venc: em(-40) });
  await call('POST', '/receber', { empresaId: emp.id, descricao: 'Outra', cliente: 'ACME', valor: 100, venc: em(-5) });
  const ina = await call('GET', '/relatorio', null, `tipo=inadimplencia&empresa=${emp.id}`);
  assert.deepEqual(ina.linhas[0], ['ACME', 2, 40, 600]); assert.equal(ina.total, 600);
  const fx = await call('GET', '/relatorio', null, `tipo=fluxo&empresa=${emp.id}`);
  assert.equal(fx.linhas.length, 9); assert.equal(fx.colunas[4], 'Saldo acumulado');
  assert.equal((await call('GET', '/relatorio', null, `tipo=notas&empresa=${emp.id}`)).linhas.length, 0);
  const csv = await call('GET', '/relatorio', null, `tipo=estoque&empresa=${emp.id}&formato=csv`);
  assert.match(csv.__csv, /Sabão;CX;10;25;250;20;abaixo do mínimo/);
  assert.equal(fin.movimentos.all().length, 1);
});

test('cliente (aba dentro da deal), atividades e passos de implantação', async () => {
  const estado = { escopo: { nome: 'ACME Ltda', doc: '11222333000181', email: 'a@acme.com', telefone: '', qtd: 2 }, deals: [
    { id: 1, titulo: 'Parcela 1', stageId: R.STAGES.paid, valor: 100, venc: em(-20), pagoEm: em(-19), cliente: 'ACME', empresa: '', link: 'https://x/1' },
    { id: 2, titulo: 'Parcela 2', stageId: R.STAGES.late, valor: 100, venc: em(-3), cliente: 'ACME', empresa: '', link: '' }] };
  const { call } = api({ estado });
  const c = await call('GET', '/cliente', null, 'deal=1');
  assert.equal(c.escopo.nome, 'ACME Ltda'); assert.deepEqual([c.aberto, c.atrasado, c.pago], [100, 100, 100]); assert.equal(c.parcelas.length, 2); assert.equal(c.parcelas[1].status, 'atrasado'); assert.equal(c.parcelas[0].link, 'https://x/1');
  assert.equal((await call('GET', '/logs'))[0].msg, 'uma atividade');
});
