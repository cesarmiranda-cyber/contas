'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('../lib/rules');
const D = require('../lib/finDash');
const { createFinStore } = require('../lib/finStore');
const { createSecrets } = require('../lib/secrets');
const { createEmpresas } = require('../lib/empresas');
const { createFinApi } = require('../lib/finApi');

const H = R.todayBR(), mes = H.slice(0, 7), em = n => new Date(Date.parse(H + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

test('painel: janela, filtros cruzados (cada visual ignora o filtro da própria dimensão) e agregações', () => {
  const j = D.janela('3m', H);
  assert.equal(j.de, R.addMonths(`${mes}-01`, -2)); assert.equal(j.ate, D.lastDay(R.addMonths(`${mes}-01`, 3).slice(0, 7)));
  assert.equal(D.janela('ano', H).de, `${mes.slice(0, 4)}-01-01`); assert.equal(D.janela('lixo', H).periodo, '6m');
  assert.equal(D.janela('custom', H, { de: '2026-01-05', ate: '2026-02-10' }).ate, '2026-02-10');
  const rec = [
    { id: 'rc_1', empresaId: 'e1', descricao: 'Venda 1', cliente: 'ACME', categoria: 'Vendas e serviços', valor: 1000, venc: `${mes}-05`, status: 'pago', pagoEm: `${mes}-06`, valorPago: 1000, contaId: 'c1' },
    { id: 'rc_2', empresaId: 'e1', descricao: 'Venda 2', cliente: 'Beta', categoria: 'Contratos recorrentes', valor: 500, venc: em(-50), status: 'aberto' },
    { id: 'rc_3', empresaId: 'e1', descricao: 'Venda 3', cliente: 'ACME', categoria: 'Vendas e serviços', valor: 300, venc: em(20), status: 'aberto' },
    { id: 'deal_9', empresaId: 'e1', origem: 'bitrix', descricao: 'Parcela', cliente: 'Gama', valor: 200, venc: em(-5), status: 'atrasado' },
    { id: 'rc_x', empresaId: 'e1', descricao: 'Cancelada', cliente: 'Z', valor: 9999, venc: `${mes}-05`, status: 'cancelado' }];
  const pag = [
    { id: 'cp_1', empresaId: 'e1', descricao: 'Aluguel', fornecedor: 'Imob', categoria: 'Aluguel e condomínio', valor: 400, venc: `${mes}-10`, status: 'paga', pagoEm: `${mes}-10`, valorPago: 400, contaId: 'c1' },
    { id: 'cp_2', empresaId: 'e1', descricao: 'Anúncio', fornecedor: 'Pixel', categoria: 'Marketing', valor: 250, venc: `${R.addMonths(`${mes}-01`, 1).slice(0, 7)}-10`, status: 'aberta' }];
  const a = D.agregar({ rec, pag, f: {}, janela: j, hoje: H });
  assert.equal(a.kpis.receitaPrev, 1000 + 300 + 200 + (R.dayDiff(em(-50), j.de) >= 0 ? 500 : 0));
  assert.equal(a.kpis.recebido, 1000); assert.equal(a.kpis.pago, 400);
  assert.equal(a.kpis.aReceber, 1000); assert.equal(a.kpis.atrasado, 700);                   // 500 + 200 atrasados
  assert.equal(a.kpis.aPagar, 250);
  assert.deepEqual(a.aging['31-60'], { valor: 500, qtd: 1 }); assert.deepEqual(a.aging['1-30'], { valor: 200, qtd: 1 });
  assert.ok(a.categoriasReceita.some(c => c.nome === 'Cobranças do Bitrix / Asaas' && c.valor === 200));
  assert.equal(a.lista.some(x => x.id === 'rc_x'), false);                                   // cancelado fora de tudo
  // filtro de categoria: a lista e os KPIs mudam, mas o gráfico de categorias continua mostrando todas
  const fc = D.agregar({ rec, pag, f: { cat: 'Vendas e serviços' }, janela: j, hoje: H });
  assert.deepEqual(fc.lista.map(x => x.id).sort(), ['rc_1', 'rc_3']);
  assert.equal(fc.kpis.despesaPrev, 0); assert.ok(fc.categoriasReceita.length >= 3);
  // filtro de mês: a série continua completa (contexto), os KPIs só do mês
  const fm = D.agregar({ rec, pag, f: { mes }, janela: j, hoje: H });
  assert.equal(fm.serie.length, D.meses(j.de, j.ate).length); assert.equal(fm.kpis.despesaPrev, 400);
  // filtro por cliente: o ranking de clientes não some
  const fx = D.agregar({ rec, pag, f: { contra: 'ACME' }, janela: j, hoje: H });
  assert.ok(fx.topClientes.length >= 2); assert.deepEqual(fx.lista.map(x => x.contra), ['ACME', 'ACME']);
  // filtro por conta e por tipo
  assert.deepEqual(D.agregar({ rec, pag, f: { conta: 'c1' }, janela: j, hoje: H }).lista.map(x => x.id).sort(), ['cp_1', 'rc_1']);
  assert.ok(D.agregar({ rec, pag, f: { tipo: 'despesa' }, janela: j, hoje: H }).lista.every(x => x.tipo === 'despesa'));
  const atual = a.serie.find(s => s.atual), extra = (em(-5).startsWith(mes) ? 200 : 0) + (em(20).startsWith(mes) ? 300 : 0);
  assert.equal(atual.receita, 1000 + extra); assert.equal(atual.despesa, 400); assert.equal(atual.resultado, 600 + extra);
});

// ---------- API: demonstração ----------
function api() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-')), fin = createFinStore(dir), secrets = createSecrets(dir);
  const calls = [];
  const bitrix = { enabled: false, base: '', call: async (m, p) => { calls.push(m); return { result: [] }; }, listAll: async () => [] };
  const empresas = createEmpresas({ fin, secrets, bitrix, createAsaas: () => ({ configure() {}, enabled: false }) });
  const a = createFinApi({ fin, empresas, svc: { dealsCached: async () => [], gerar: async () => { calls.push('gerar'); return { ids: [] }; } }, bitrix, asaas: { as: (_, f) => f(), enabled: false }, store: { log() {}, logs: [] }, dataDir: dir });
  const call = async (method, p, body, q = '') => (await a.handle(method, `/api/fin${p}`, new URL('http://x/?' + q), async () => body || {}))?.json;
  return { call, fin, calls, dir };
}

test('demonstração: carrega todos os processos, painel/relatórios funcionam, contrato demo gera parcelas só no app e remove limpa tudo', async () => {
  const { call, fin, calls } = api();
  await call('POST', '/empresas', { nome: 'Empresa Real Ltda' });
  const r = await call('POST', '/demo/carregar');
  assert.equal(r.empresas.length, 2); assert.ok(r.quantidades.pagar > 100 && r.quantidades.receber > 40 && r.quantidades.notas === 4 && r.quantidades.contratos === 5);
  await assert.rejects(call('POST', '/demo/carregar'), /Já existem/);
  assert.equal((await call('GET', '/bootstrap')).demo, true);
  // painel completo
  const d = await call('GET', '/dashboard', null, 'periodo=6m');
  assert.ok(d.kpis.receitaPrev > 0 && d.kpis.despesaPrev > 0 && d.kpis.saldoContas > 0 && d.kpis.estoqueValor > 0);
  assert.equal(d.contratos.total, 5); assert.ok(d.contratos.porStatus.vencido >= 1 && d.contratos.porStatus.vencendo >= 1);
  assert.ok(d.estoque.qtdAbaixo >= 1); assert.ok(d.orcamento.linhas.length >= 3); assert.ok(d.conciliacao.pendentes >= 5); assert.equal(d.notas.total, 4); assert.ok(d.folha.custo > 0);
  assert.ok(d.categoriasDespesa.some(c => c.nome === 'Folha de pagamento')); assert.ok(d.serie.length >= 9 && d.serie.some(s => s.futuro));
  const empAlfa = (await call('GET', '/empresas')).find(e => e.nome.includes('Alfa')).id;
  const da = await call('GET', '/dashboard', null, `empresa=${empAlfa}&cat=Marketing`);
  assert.ok(da.lista.every(x => x.categoria === 'Marketing'));
  // processos interligados: saldo das contas, DRE e relatórios
  const sal = await call('GET', '/contas/saldos', null, `empresa=${empAlfa}`); assert.ok(sal.length === 3 && sal.every(c => typeof c.saldo === 'number'));
  const dre = await call('GET', '/relatorio', null, `tipo=dre&empresa=${empAlfa}&de=${R.addMonths(`${mes}-01`, -5)}&ate=${H}`); assert.ok(dre.dre.totalReceitas > 0 && dre.dre.totalDespesas > 0);
  assert.ok((await call('GET', '/relatorio', null, 'tipo=estoque')).linhas.length === 8);
  assert.ok((await call('GET', '/conciliacao')).linhas.some(l => l.sugestoes.length));      // há sugestões de conciliação
  const cts = await call('GET', '/contratos'); assert.equal(cts.length, 5);
  const det = await call('GET', `/contratos/${cts[0].id}`); assert.equal(det.demo, true); assert.ok(det.cliente.doc);
  const g = await call('POST', `/contratos/${cts[1].id}/gerar-cobrancas`, { valor: 54000, parcelas: 3, primeiroVenc: em(10) });
  assert.equal(g.ids.length, 3); assert.equal(calls.includes('gerar'), false);              // nada foi ao Bitrix
  assert.equal((await call('GET', `/contratos/${cts[1].id}`)).financeiro.parcelas.length, 3);
  await assert.rejects(call('POST', `/contratos/${cts[1].id}/gerar-cobrancas`, { valor: 1, parcelas: 1, primeiroVenc: em(10) }), /já foram geradas/);
  const ed = await call('PUT', `/contratos/${cts[2].id}`, { titulo: 'Contrato editado', valor: 31000 }); assert.equal(ed.contrato.titulo, 'Contrato editado'); assert.equal(ed.contrato.valor, 31000);
  // empresas de demonstração não vão para o campo de lista do Bitrix
  assert.deepEqual((await call('POST', '/empresas/sincronizar-campo').catch(() => ({ opcoes: [] }))).opcoes.filter(o => /Demo/.test(o)), []);
  // lançamento criado pelo usuário dentro de empresa demo também é limpo; dados reais ficam
  await call('POST', '/pagar', { empresaId: empAlfa, descricao: 'Teste do cliente', valor: 10, venc: H });
  const rm = await call('POST', '/demo/remover'); assert.ok(rm.removidos > 300);
  assert.equal((await call('GET', '/empresas')).length, 1); assert.equal(fin.pagar.all().length, 0); assert.equal(fin.contas.all().length, 0); assert.equal(fin.contratosDemo.all().length, 0); assert.equal(fin.notas.all().length, 0); assert.equal(fin.cobrancaContrato(String(cts[1].id)), null);
  assert.equal((await call('GET', '/bootstrap')).demo, false);
  await assert.rejects(call('POST', '/demo/remover'), /Não há dados/);
});
