'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const C = require('../lib/finCad');
const F = require('../lib/fin');
const { createFinStore } = require('../lib/finStore');
const { createSecrets } = require('../lib/secrets');
const { createEmpresas } = require('../lib/empresas');
const { createFinApi } = require('../lib/finApi');

const HOJE = '2026-10-19';   // segunda-feira

test('vencimentos automáticos: condição em dias, dia útil e meses curtos', () => {
  const p = C.planejarParcelas({ total: 300, dias: [30, 60, 90], base: '2026-10-19' });
  assert.deepEqual(p.map(x => x.venc), ['2026-11-18', '2026-12-18', '2027-01-17']);
  assert.deepEqual(p.map(x => x.valor), [100, 100, 100]);
  const u = C.planejarParcelas({ total: 100, dias: [0, 30], base: '2026-10-23', util: true });   // 23/10 é sexta; 22/11 é domingo
  assert.deepEqual(u.map(x => x.venc), ['2026-10-23', '2026-11-23']);
  const m = C.planejarParcelas({ total: 10, parcelas: 3, venc: '2026-01-31' });                  // meses mensais mantêm o fim do mês
  assert.deepEqual(m.map(x => x.venc), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(m.map(x => x.valor), [3.34, 3.33, 3.33]);                                     // centavos nunca se perdem
  assert.equal(F.round2(m.reduce((a, x) => a + x.valor, 0)), 10);
});

test('parcelas: recorrente repete o valor cheio e a lista manual precisa fechar o total', () => {
  const r = C.planejarParcelas({ total: 500, modo: 'recorrente', parcelas: 4, venc: '2026-11-05' });
  assert.deepEqual(r.map(x => x.valor), [500, 500, 500, 500]);
  const man = C.planejarParcelas({ total: 100, manual: [{ venc: '2026-11-01', valor: 40, descricao: 'Sinal' }, { venc: '2026-12-01', valor: 60, obs: 'Restante' }] });
  assert.equal(man[0].descricao, 'Sinal'); assert.equal(man[1].obs, 'Restante');
  assert.throws(() => C.planejarParcelas({ total: 100, manual: [{ venc: '2026-11-01', valor: 40 }, { venc: '2026-12-01', valor: 50 }] }), /soma das parcelas/);
  assert.throws(() => C.planejarParcelas({ total: 100, manual: [{ venc: 'x', valor: 100 }] }), /vencimento inválido/);
  assert.throws(() => C.planejarParcelas({ total: 0, parcelas: 1, venc: '2026-11-01' }), /valor/i);
});

test('forma de pagamento: previsão de crédito (D+N, dias úteis) e taxa', () => {
  const cartao = { prazoDias: 30, diasUteis: false, taxaPct: 3.5, taxaFixa: 0.5 }, boleto = { prazoDias: 1, diasUteis: true, taxaPct: 0, taxaFixa: 3 };
  assert.equal(C.creditoEm('2026-10-19', cartao), '2026-11-18');
  assert.equal(C.creditoEm('2026-10-23', boleto), '2026-10-26');                  // sexta + 1 útil = segunda
  assert.equal(C.creditoEm('2026-10-19', null), '2026-10-19');
  assert.equal(C.taxaForma(1000, cartao), 35.5); assert.equal(C.taxaForma(1000, boleto), 3);
});

test('lançamento a receber: título, anotações, parcelas, taxa e crédito vindos da forma', () => {
  const formas = C.defaults().formas, condicoes = C.defaults().condicoes;
  const l = C.criarLancamentos({ empresaId: 'e1', descricao: 'Consultoria ACME', obs: 'Contrato 2026/14', cliente: 'ACME', valor: 3000, condicaoId: 'cp_30_60_90', base: '2026-10-19', formaId: 'fp_cartao', categoria: 'Vendas e serviços', centro: 'Comercial', contaId: 'cc1' }, 'receber', { formas, condicoes, hoje: HOJE });
  assert.equal(l.length, 3);
  assert.deepEqual(l.map(x => x.parcela), ['1/3', '2/3', '3/3']);
  assert.ok(l.every(x => x.descricao === 'Consultoria ACME' && x.obs === 'Contrato 2026/14' && x.status === 'aberto' && x.forma === 'CARTAO' && x.centro === 'Comercial'));
  assert.equal(l[0].taxa, 35); assert.equal(l[0].valorLiquido, 965); assert.equal(l[0].credito, '2026-12-18');   // venc 18/11 + 30 dias
  assert.equal(new Set(l.map(x => x.grupo)).size, 1);
  const p = C.criarLancamentos({ empresaId: 'e1', descricao: 'Energia', fornecedor: 'CPFL', valor: 200, venc: '2026-11-10', forma: 'BOLETO' }, 'pagar', { formas, condicoes, hoje: HOJE });
  assert.equal(p[0].status, 'aberta'); assert.equal(p[0].fornecedor, 'CPFL'); assert.ok(p[0].id.startsWith('cp_'));
  assert.throws(() => C.criarLancamentos({ empresaId: 'e1', descricao: 'x', valor: 1, venc: '2026-11-10' }, 'pagar', {}), /título/);
});

test('baixa com juros, multa e desconto; pagamento parcial gera saldo', () => {
  const [c] = C.criarLancamentos({ empresaId: 'e1', descricao: 'Aluguel', valor: 1000, venc: '2026-10-10', forma: 'BOLETO' }, 'pagar', { hoje: HOJE });
  const { pago, saldo } = C.baixarLancamento(c, { data: HOJE, juros: 12, multa: 20, desconto: 2, contaId: 'cc1' }, HOJE);
  assert.equal(pago.status, 'paga'); assert.equal(pago.valorPago, 1030); assert.equal(pago.valor, 1000); assert.equal(saldo, null); assert.equal(pago.contaId, 'cc1');
  const parc = C.baixarLancamento(c, { valor: 400 }, HOJE);
  assert.equal(parc.pago.valorPago, 400); assert.equal(parc.saldo.valor, 600); assert.equal(parc.saldo.status, 'aberta'); assert.equal(parc.saldo.saldoDe, c.id); assert.match(parc.saldo.parcela, /saldo/);
  assert.throws(() => C.baixarLancamento(c, { valor: 1500 }, HOJE), /não pode passar/);
  assert.throws(() => C.baixarLancamento(c, { data: '2026-12-01' }, HOJE), /futura/);
  assert.throws(() => C.baixarLancamento(c, { desconto: 5000 }, HOJE), /desconto/);
  assert.throws(() => C.baixarLancamento(pago, {}, HOJE), /já baixado/);
  const [r] = C.criarLancamentos({ empresaId: 'e1', descricao: 'Venda', valor: 1000, venc: '2026-10-10', formaId: 'fp_cartao' }, 'receber', { formas: C.defaults().formas, hoje: HOJE });
  const rp = C.baixarLancamento(r, { valor: 500 }, HOJE);
  assert.equal(rp.pago.status, 'pago'); assert.equal(rp.pago.taxa, 17.5); assert.equal(rp.saldo.taxa, 17.5); assert.equal(rp.saldo.valorLiquido, 482.5);
});

test('saldo por conta, extrato e transferências', () => {
  const conta = { id: 'cc1', saldoInicial: 1000, dataSaldo: '2026-10-01' }, cc2 = { id: 'cc2', saldoInicial: 0, dataSaldo: '2026-10-01' };
  const receber = [{ id: 'rc_1', contaId: 'cc1', status: 'pago', pagoEm: '2026-10-05', valorPago: 500, valor: 500, descricao: 'Venda', cliente: 'ACME' }, { id: 'rc_2', contaId: 'cc1', status: 'aberto', valor: 9999 }];
  const pagar = [{ id: 'cp_1', contaId: 'cc1', status: 'paga', pagoEm: '2026-10-08', valorPago: 300, valor: 300, descricao: 'Luz', fornecedor: 'CPFL' }, { id: 'cp_2', contaId: '', status: 'paga', pagoEm: '2026-10-08', valorPago: 77, valor: 77, descricao: 'Sem conta' }, { id: 'cp_3', contaId: 'cc1', status: 'paga', pagoEm: '2026-09-20', valorPago: 5000, valor: 5000, descricao: 'Antes do saldo inicial' }];
  const transferencias = [{ id: 'tr_1', de: 'cc1', para: 'cc2', valor: 200, data: '2026-10-10', obs: 'reserva' }];
  const dados = { receber, pagar, transferencias };
  assert.equal(C.saldoConta(conta, dados), 1000);                                    // 1000 + 500 − 300 − 200
  assert.equal(C.saldoConta(cc2, dados), 200);
  assert.equal(C.saldoConta(conta, dados, '2026-10-06'), 1500);
  assert.equal(C.saldoAntes(conta, dados, '2026-10-08'), 1500);
  const ex = C.extrato(conta, dados);
  assert.deepEqual(ex.linhas.map(l => [l.tipo, l.valor, l.saldo]), [['entrada', 500, 1500], ['saida', -300, 1200], ['transferencia', -200, 1000]]);
  assert.equal(ex.saldoFinal, 1000);
  assert.deepEqual(C.extrato(conta, dados, { de: '2026-10-08' }).linhas.length, 2);
  const contas = [{ ...conta, nome: 'A' }, { ...cc2, nome: 'B' }];
  assert.throws(() => C.validarTransferencia({ de: 'cc1', para: 'cc1', valor: 10 }, contas, HOJE), /diferentes/);
  assert.throws(() => C.validarTransferencia({ de: 'cc1', para: 'cc2', valor: 0 }, contas, HOJE), /valor/i);
  assert.throws(() => C.validarTransferencia({ de: 'cc1', para: 'cc2', valor: 5, data: '2026-09-01' }, contas, HOJE), /anterior/);
  assert.equal(C.validarTransferencia({ de: 'cc1', para: 'cc2', valor: 5 }, contas, HOJE).data, HOJE);
});

test('DRE: caixa x competência, por categoria, com margem', () => {
  const receber = [{ id: 'rc_1', empresaId: 'e1', categoria: 'Vendas e serviços', status: 'pago', pagoEm: '2026-10-05', valorPago: 900, valor: 900, venc: '2026-10-01' }, { id: 'rc_2', empresaId: 'e1', categoria: 'Vendas e serviços', status: 'aberto', valor: 300, venc: '2026-10-20' }, { id: 'deal_5', origem: 'bitrix', empresaId: 'e1', status: 'pago', pagoEm: '2026-10-07', valor: 100, venc: '2026-10-07' }, { id: 'rc_9', empresaId: 'e2', status: 'pago', pagoEm: '2026-10-05', valor: 5000, venc: '2026-10-05' }];
  const pagar = [{ id: 'cp_1', empresaId: 'e1', categoria: 'Aluguel e condomínio', status: 'paga', pagoEm: '2026-10-06', valorPago: 400, valor: 400, venc: '2026-10-05' }, { id: 'cp_2', empresaId: 'e1', categoria: 'Marketing', status: 'aberta', valor: 100, venc: '2026-10-25' }, { id: 'cp_3', empresaId: 'e1', categoria: 'Marketing', status: 'cancelada', valor: 999, venc: '2026-10-25' }];
  const cx = C.dre({ receber, pagar, empresaId: 'e1', de: '2026-10-01', ate: '2026-10-31' });
  assert.equal(cx.totalReceitas, 1000); assert.equal(cx.totalDespesas, 400); assert.equal(cx.resultado, 600); assert.equal(cx.margemPct, 60);
  assert.deepEqual(cx.receitas.map(r => r.categoria), ['Vendas e serviços', 'Cobranças do Bitrix / Asaas']);
  const cp = C.dre({ receber, pagar, empresaId: 'e1', de: '2026-10-01', ate: '2026-10-31', regime: 'competencia' });
  assert.equal(cp.totalReceitas, 1300); assert.equal(cp.totalDespesas, 500); assert.equal(cp.resultado, 800);
  assert.equal(C.dre({ receber, pagar, de: '2026-10-01', ate: '2026-10-31' }).totalReceitas, 6000);
});

test('cadastros: validação de conta, forma e condição', () => {
  const c = C.VALID.contas({ empresaId: 'e1', nome: 'Itaú PJ', banco: '341', agencia: '1234-5', numero: '98765-0', saldoInicial: '1500.50' });
  assert.equal(c.bancoNome, 'Itaú'); assert.equal(c.saldoInicial, 1500.5); assert.equal(c.tipo, 'corrente');
  assert.throws(() => C.VALID.contas({ nome: 'Sem empresa' }), /empresa/i);
  assert.throws(() => C.VALID.formas({ nome: 'X', tipo: 'PIX' }), /Nome/);
  assert.equal(C.VALID.formas({ nome: 'Cartão Stone', tipo: 'CARTAO', prazoDias: '30', taxaPct: '2,5'.replace(',', '.') }).prazoDias, 30);
  assert.throws(() => C.VALID.formas({ nome: 'Taxa absurda', tipo: 'PIX', taxaPct: 150 }), /Taxa/);
  assert.deepEqual(C.VALID.condicoes({ nome: '28/56', dias: '28, 56' }).dias, [28, 56]);
  assert.throws(() => C.VALID.condicoes({ nome: 'Fora de ordem', dias: '60, 30' }), /ordem/);
  assert.throws(() => C.VALID.condicoes({ nome: 'Vazia', dias: '' }), /prazos/);
  assert.throws(() => C.VALID.fornecedores({ nome: 'Forn', doc: '123' }), /CPF\/CNPJ/);
});

// ---------- API ----------
function api() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), fin = createFinStore(dir), secrets = createSecrets(dir);
  const bitrix = { enabled: false, base: '', call: async () => ({ result: [] }), listAll: async () => [] };
  const empresas = createEmpresas({ fin, secrets, bitrix, createAsaas: () => ({ configure() {}, enabled: false }) });
  const a = createFinApi({ fin, empresas, svc: { dealsCached: async () => [] }, bitrix, asaas: { as: (_, f) => f(), enabled: false }, store: { log() {} } });
  const call = async (method, p, body, q = '') => (await a.handle(method, `/api/fin${p}`, new URL('http://x/?' + q), async () => body || {}))?.json;
  return { call, fin };
}

test('API: padrões de formas, condições e categorias já vêm cadastrados', async () => {
  const { call } = api();
  assert.ok((await call('GET', '/cad/formas')).some(f => f.tipo === 'CARTAO' && f.prazoDias === 30));
  assert.ok((await call('GET', '/cad/condicoes')).some(c => c.nome === '30/60/90 dias'));
  const cat = await call('GET', '/cad/categorias');
  assert.ok(cat.some(c => c.tipo === 'receita') && cat.some(c => c.tipo === 'despesa'));
  const b = await call('GET', '/bootstrap'); assert.ok(b.cad.formas.length && b.bancos.length);
});

test('API: conta bancária, lançamento com parcelas e anotações, baixa na conta, transferência e saldo', async () => {
  const D = require('../lib/rules').todayBR();
  const { call, fin } = api();
  const emp = await call('POST', '/empresas', { nome: 'Alfa Ltda' }), emp2 = await call('POST', '/empresas', { nome: 'Beta SA' });
  const itau = await call('POST', '/cad/contas', { empresaId: emp.id, nome: 'Itaú PJ', banco: '341', saldoInicial: 1000, dataSaldo: '2026-01-01', padrao: true });
  const caixa = await call('POST', '/cad/contas', { empresaId: emp.id, nome: 'Caixa interno', tipo: 'caixa', saldoInicial: 0, dataSaldo: '2026-01-01' });
  await assert.rejects(call('POST', '/cad/contas', { empresaId: emp.id, nome: 'itaú pj', saldoInicial: 0 }), /Já existe/);
  const outra = await call('POST', '/cad/contas', { empresaId: emp2.id, nome: 'Conta da Beta', saldoInicial: 0 });
  const prev = await call('POST', '/parcelas/preview', { valor: 900, condicaoId: 'cp_30_60_90', base: D });
  assert.deepEqual(prev.map(p => p.valor), [300, 300, 300]);
  const l = await call('POST', '/receber', { empresaId: emp.id, descricao: 'Projeto ACME', obs: 'PO 123', cliente: 'ACME', valor: 900, condicaoId: 'cp_30_60_90', base: D, formaId: 'fp_pix', contaId: itau.id, categoria: 'Vendas e serviços' });
  assert.equal(l.length, 3); assert.equal(l[0].obs, 'PO 123');
  await assert.rejects(call('POST', '/receber', { empresaId: emp.id, descricao: 'Conta errada', valor: 10, venc: '2026-11-01', contaId: outra.id }), /não pertence/);
  const b = await call('POST', `/receber/${l[0].id}/baixar`, { data: D, contaId: itau.id, juros: 5 });
  assert.equal(b.pago.valorPago, 305);
  const [p] = await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Aluguel', valor: 400, venc: '2026-10-05', forma: 'BOLETO', categoria: 'Aluguel e condomínio', contaId: itau.id });
  const parcial = await call('POST', `/pagar/${p.id}/baixar`, { data: D, valor: 150, contaId: itau.id });
  assert.equal(parcial.saldo.valor, 250);
  await call('POST', '/transferencias', { de: itau.id, para: caixa.id, valor: 100, data: D, obs: 'troco' });
  const saldos = await call('GET', '/contas/saldos', null, `empresa=${emp.id}`);
  assert.equal(saldos.find(s => s.id === itau.id).saldo, 1000 + 305 - 150 - 100);
  assert.equal(saldos.find(s => s.id === caixa.id).saldo, 100);
  assert.equal((await call('GET', '/contas/saldos', null, 'empresa=todas')).length, 3);
  const ex = await call('GET', `/contas/${itau.id}/extrato`);
  assert.equal(ex.linhas.length, 3); assert.equal(ex.saldoFinal, 1055);
  await assert.rejects(call('POST', '/transferencias', { de: itau.id, para: itau.id, valor: 1 }), /diferentes/);
  // edição do lançamento em aberto: título, anotações, vencimento e valor
  const ed = await call('PUT', `/receber/${l[1].id}`, { descricao: 'Projeto ACME - fase 2', obs: 'renegociado', venc: '2026-12-30', valor: 350 });
  assert.equal(ed.descricao, 'Projeto ACME - fase 2'); assert.equal(ed.venc, '2026-12-30'); assert.equal(ed.valor, 350);
  await assert.rejects(call('PUT', `/receber/${l[0].id}`, { descricao: 'já baixada' }), /em aberto/);
  // conta usada não é apagada, só inativada; conta sem uso sai de vez
  assert.deepEqual((await call('DELETE', `/cad/contas/${itau.id}`)).inativado, true);
  assert.equal((await call('DELETE', `/cad/contas/${outra.id}`)).removido, true);
  assert.equal(fin.contas.all().length, 2);
});

test('API: DRE e relatório em CSV', async () => {
  const { call } = api();
  const emp = await call('POST', '/empresas', { nome: 'Alfa Ltda' });
  const [r] = await call('POST', '/receber', { empresaId: emp.id, descricao: 'Venda', valor: 1000, venc: '2026-10-01', categoria: 'Vendas e serviços' });
  await call('POST', `/receber/${r.id}/baixar`, { data: '2026-10-02' });
  const [p] = await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Software', valor: 300, venc: '2026-10-03', categoria: 'Software e licenças' });
  await call('POST', `/pagar/${p.id}/baixar`, { data: '2026-10-03' });
  const dre = await call('GET', '/relatorio', null, `tipo=dre&empresa=${emp.id}&de=2026-10-01&ate=2026-10-31`);
  assert.equal(dre.dre.resultado, 700); assert.match(dre.totalLabel, /70%/);
  const csv = await call('GET', '/relatorio', null, `tipo=dre&empresa=${emp.id}&de=2026-10-01&ate=2026-10-31&formato=csv`);
  assert.match(csv.__csv, /RESULTADO DO PERÍODO;700/);
});

test('fluxo de caixa usa a previsão de crédito da forma e o valor líquido', () => {
  const receber = [{ id: 'rc_1', empresaId: 'e1', valor: 1000, valorLiquido: 965, venc: '2026-10-25', credito: '2026-11-24', status: 'aberto' }];
  const c = F.fluxoCaixa({ receber, pagar: [], hoje: HOJE, mesesAtras: 0, mesesFrente: 2 });
  assert.equal(c.linhas.find(l => l.mes === '2026-10').entradaPrev, 0);
  assert.equal(c.linhas.find(l => l.mes === '2026-11').entradaPrev, 965);
});
