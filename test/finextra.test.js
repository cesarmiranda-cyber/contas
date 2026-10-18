'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { parseOfx } = require('../lib/ofx');
const X = require('../lib/finExtra');
const R = require('../lib/rules');
const { createFinStore } = require('../lib/finStore');
const { createSecrets } = require('../lib/secrets');
const { createEmpresas } = require('../lib/empresas');
const { createFinApi } = require('../lib/finApi');

const D = R.todayBR(), em = n => new Date(Date.parse(D + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const ofx = linhas => `OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nCHARSET:1252\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>341<BRANCHID>1234<ACCTID>56789-0</BANKACCTFROM><BANKTRANLIST><DTSTART>${em(-30)}<DTEND>${em(0)}\r\n${linhas.map(l => `<STMTTRN><TRNTYPE>${l[1] > 0 ? 'CREDIT' : 'DEBIT'}<DTPOSTED>${em(l[0])}000000[-3:BRT]<TRNAMT>${l[1]}<FITID>${l[3]}<MEMO>${l[2]}</STMTTRN>`).join('\r\n')}\r\n</BANKTRANLIST><LEDGERBAL><BALAMT>1234,56<DTASOF>${em(0)}</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test('OFX: lê SGML dos bancos, valores com vírgula e saldo', () => {
  const p = parseOfx(ofx([[-2, -1500, 'PAG BOLETO IMOBILIARIA SUL', 'F1'], [-1, 3000.5, 'PIX RECEBIDO ACME LTDA', 'F2'], [0, '-1.234,56', 'TARIFA &amp; MANUTENCAO', 'F3']]));
  assert.equal(p.banco, '341'); assert.equal(p.conta, '56789-0'); assert.equal(p.linhas.length, 3);
  assert.deepEqual(p.linhas.map(l => l.valor), [-1500, 3000.5, -1234.56]);
  assert.equal(p.linhas[0].data, `${em(-2).slice(0, 4)}-${em(-2).slice(4, 6)}-${em(-2).slice(6, 8)}`);
  assert.equal(p.linhas[2].descricao, 'TARIFA & MANUTENCAO'); assert.equal(p.saldoFinal, 1234.56);
  assert.throws(() => parseOfx('isto não é um extrato'), /não parece um extrato OFX/);
  assert.throws(() => parseOfx('<OFX><BANKTRANLIST></BANKTRANLIST></OFX>'), /não tem lançamentos/);
  assert.throws(() => parseOfx('<OFX><STMTTRN><DTPOSTED>xx<TRNAMT>1</STMTTRN></OFX>'), /inválido/);
});

test('conciliação: sugestões por valor, data e nome; repetidas não entram; baixa conforme o banco', () => {
  const conta = { id: 'cc1', empresaId: 'e1' };
  const pagar = [{ id: 'cp_1', empresaId: 'e1', status: 'aberta', valor: 1500, venc: `${D.slice(0, 8)}${D.slice(8)}`, descricao: 'Aluguel Imobiliaria Sul', fornecedor: 'Imobiliaria Sul' }, { id: 'cp_2', empresaId: 'e1', status: 'aberta', valor: 1500, venc: R.addMonths(D, 3), descricao: 'Outro' }, { id: 'cp_3', empresaId: 'e2', status: 'aberta', valor: 1500, venc: D, descricao: 'Outra empresa' }];
  const receber = [{ id: 'rc_1', empresaId: 'e1', origem: 'manual', status: 'aberto', valor: 1000, valorLiquido: 965, taxa: 35, venc: D, descricao: 'Venda cartão', cliente: 'ACME' }];
  const linha = { id: 'ex_1', contaId: 'cc1', data: D, valor: -1500, descricao: 'PAG BOLETO IMOBILIARIA SUL' };
  const s = X.sugestoes(linha, conta, { pagar, receber });
  assert.deepEqual(s.map(x => x.id), ['cp_1', 'cp_2']);                                // outra empresa nunca aparece
  assert.ok(X.forte(s[0]) && !X.forte(s[1])); assert.equal(s[0].score, 100);
  assert.equal(X.sugestoes({ ...linha, valor: 965 }, conta, { pagar, receber })[0].id, 'rc_1');   // cartão: valor líquido
  assert.equal(X.sugestoes({ ...linha, valor: 777 }, conta, { pagar, receber }).length, 0);
  const p = parseOfx(ofx([[-1, -10, 'TARIFA', 'A'], [-1, -10, 'TARIFA', 'A'], [-1, -10, 'TARIFA', 'B']]));
  const { novas, repetidas } = X.novasLinhas(p, 'cc1', [{ contaId: 'cc1', fitid: 'B' }]);
  assert.equal(novas.length, 1); assert.equal(repetidas, 2);                           // A repetida no próprio arquivo, B já importada
  assert.deepEqual(X.baixaPorExtrato(pagar[0], { ...linha, valor: -1520 }), { data: D, contaId: 'cc1', obs: 'Conciliado com o extrato: PAG BOLETO IMOBILIARIA SUL', valor: 1500, juros: 20 });
  assert.equal(X.baixaPorExtrato(receber[0], { ...linha, valor: 965 }).desconto, 35);
  assert.equal(X.baixaPorExtrato(pagar[0], { ...linha, valor: -1000 }).valor, 1000);
  assert.equal(X.baixaPorExtrato(pagar[0], { ...linha, valor: -1000 }, { modo: 'desconto' }).desconto, 500);
});

test('recorrência sem fim: gera até o horizonte, não duplica, respeita fim e dia útil', () => {
  const rec = { id: 'rec_1', tipo: 'pagar', empresaId: 'e1', inicio: R.addMonths(D, -1), fim: '', util: false, ativa: true, modelo: { descricao: 'Internet', valor: 200, fornecedor: 'ISP', categoria: 'Outros' } };
  const l1 = X.gerarRecorrentes({ recorrencias: [rec], existentes: [], hoje: D });
  assert.equal(l1.length, 5);                                                          // mês passado, este, +1, +2, +3
  assert.ok(l1.every(l => l.recId === 'rec_1' && l.valor === 200 && l.status === 'aberta' && l.fornecedor === 'ISP'));
  assert.equal(new Set(l1.map(l => l.recCompetencia)).size, 5);
  assert.equal(X.gerarRecorrentes({ recorrencias: [rec], existentes: l1, hoje: D }).length, 0);       // idempotente
  assert.equal(X.gerarRecorrentes({ recorrencias: [rec], existentes: l1.slice(0, 3), hoje: D }).length, 2);
  assert.equal(X.gerarRecorrentes({ recorrencias: [{ ...rec, fim: R.addMonths(D, 1) }], existentes: [], hoje: D }).length, 3);
  assert.equal(X.gerarRecorrentes({ recorrencias: [{ ...rec, ativa: false }], existentes: [], hoje: D }).length, 0);
  assert.throws(() => X.validarRecorrencia({ tipo: 'pagar', empresaId: 'e1', inicio: '2026-10-01', fim: '2026-09-01', modelo: { descricao: 'Aluguel', valor: 1 } }), /depois do primeiro/);
  assert.throws(() => X.validarRecorrencia({ tipo: 'pagar', empresaId: 'e1', inicio: '2026-10-01', modelo: { descricao: 'Aluguel', valor: 0 } }), /valor/i);
});

test('orçamento: meta padrão, exceção por mês, status e totais por empresa', () => {
  const mes = D.slice(0, 7);
  const orcamentos = [{ id: 'o1', empresaId: 'e1', tipo: 'despesa', categoria: 'Marketing', valor: 1000, mes: '' }, { id: 'o2', empresaId: 'e1', tipo: 'despesa', categoria: 'Marketing', valor: 3000, mes }, { id: 'o3', empresaId: 'e1', tipo: 'despesa', categoria: 'Aluguel e condomínio', valor: 2000, mes: '' }, { id: 'o4', empresaId: 'e1', tipo: 'receita', categoria: 'Vendas e serviços', valor: 10000, mes: '' }, { id: 'o5', empresaId: 'e2', tipo: 'despesa', categoria: 'Marketing', valor: 500, mes: '' }];
  const pagar = [{ id: 'cp_1', empresaId: 'e1', categoria: 'Marketing', valor: 2900, status: 'paga', pagoEm: `${mes}-02`, valorPago: 2900, venc: `${mes}-02` }, { id: 'cp_2', empresaId: 'e1', categoria: 'Aluguel e condomínio', valor: 2500, status: 'aberta', venc: `${mes}-20` }, { id: 'cp_3', empresaId: 'e1', categoria: 'Software e licenças', valor: 90, status: 'cancelada', venc: `${mes}-20` }, { id: 'cp_4', empresaId: 'e2', categoria: 'Marketing', valor: 700, status: 'aberta', venc: `${mes}-10` }];
  const receber = [{ id: 'rc_1', empresaId: 'e1', categoria: 'Vendas e serviços', valor: 6000, status: 'pago', pagoEm: `${mes}-05`, valorPago: 6000, venc: `${mes}-05`, origem: 'manual' }];
  const o = X.orcamentoMes({ orcamentos, receber, pagar, empresaId: 'e1', mes });
  const L = Object.fromEntries(o.linhas.map(l => [l.categoria, l]));
  assert.equal(L['Marketing'].orcado, 3000); assert.equal(L['Marketing'].pct, 96.7); assert.equal(L['Marketing'].status, 'alerta');   // exceção do mês vale mais que o padrão
  assert.equal(L['Aluguel e condomínio'].status, 'estourado'); assert.equal(L['Aluguel e condomínio'].desvio, 500);
  assert.equal(L['Vendas e serviços'].status, 'abaixo'); assert.equal(L['Vendas e serviços'].realizado, 6000);
  assert.ok(!L['Software e licenças']);                                                // cancelado não aparece
  assert.equal(o.despesas.orcado, 5000); assert.equal(o.receitas.previsto, 6000);
  const prox = X.orcamentoMes({ orcamentos, receber, pagar, empresaId: 'e1', mes: R.addMonths(D, 1).slice(0, 7) });
  assert.equal(prox.linhas.find(l => l.categoria === 'Marketing').orcado, 1000);       // sem exceção: volta ao padrão
  assert.equal(X.orcamentoMes({ orcamentos, receber, pagar, mes }).linhas.find(l => l.categoria === 'Marketing').orcado, 3500);   // todas as empresas somam
  assert.throws(() => X.validarOrcamento({ empresaId: 'x', tipo: 'despesa', categoria: 'A', valor: 1 }, [{ id: 'e1' }]), /empresa/i);
});

// ---------- API ----------
function api() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), fin = createFinStore(dir), secrets = createSecrets(dir);
  const bitrix = { enabled: false, base: '', call: async () => ({ result: [] }), listAll: async () => [] };
  const empresas = createEmpresas({ fin, secrets, bitrix, createAsaas: () => ({ configure() {}, enabled: false }) });
  const a = createFinApi({ fin, empresas, svc: { dealsCached: async () => [] }, bitrix, asaas: { as: (_, f) => f(), enabled: false }, store: { log() {} }, dataDir: dir });
  const call = async (method, p, body, q = '') => (await a.handle(method, `/api/fin${p}`, new URL('http://x/?' + q), async () => body || {}))?.json;
  return { call, fin, a, dir };
}
const setup = async call => {
  const emp = await call('POST', '/empresas', { nome: 'Alfa Ltda' });
  const conta = await call('POST', '/cad/contas', { empresaId: emp.id, nome: 'Itaú PJ', banco: '341', numero: '56789-0', saldoInicial: 5000, dataSaldo: `${D.slice(0, 4)}-01-01`, padrao: true });
  return { emp, conta };
};

test('API conciliação: importa OFX, sugere, concilia com juros, cria tarifa e desfaz', async () => {
  const { call, fin } = api(); const { emp, conta } = await setup(call);
  const [ap] = await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Aluguel Imobiliaria Sul', fornecedor: 'Imobiliaria Sul', valor: 1500, venc: R.addMonths(D, 0), categoria: 'Aluguel e condomínio' });
  const [ar] = await call('POST', '/receber', { empresaId: emp.id, descricao: 'Venda ACME', cliente: 'ACME', valor: 3000, venc: D });
  const imp = await call('POST', '/conciliacao/importar', { contaId: conta.id, ofx: ofx([[-1, -1520, 'PAG BOLETO IMOBILIARIA SUL', 'F1'], [-1, 3000, 'PIX ACME LTDA', 'F2'], [-1, -29.9, 'TARIFA PACOTE SERVICOS', 'F3']]) });
  assert.equal(imp.novas, 3); assert.equal(imp.aviso, '');
  assert.equal((await call('POST', '/conciliacao/importar', { contaId: conta.id, ofx: ofx([[-1, -1520, 'PAG BOLETO IMOBILIARIA SUL', 'F1']]) })).repetidas, 1);
  const lista = await call('GET', '/conciliacao');
  assert.equal(lista.linhas.length, 3);
  const lPag = lista.linhas.find(l => l.valor === -1520), lRec = lista.linhas.find(l => l.valor === 3000), lTar = lista.linhas.find(l => l.valor === -29.9);
  assert.equal(lRec.sugestoes[0].id, ar.id);
  assert.equal(lPag.sugestoes.length, 1); assert.equal(lPag.sugestoes[0].exato, false);   // 1520 vs 1500: valor próximo (até 2%) entra como sugestão fraca
  // juros de 20: concilia manualmente
  const c1 = await call('POST', `/conciliacao/${lPag.id}/conciliar`, { lancId: ap.id });
  assert.equal(c1.status, 'conciliado');
  const pago = fin.pagar.get(ap.id); assert.equal(pago.status, 'paga'); assert.equal(pago.valorPago, 1520); assert.equal(pago.juros, 20); assert.equal(pago.contaId, conta.id);
  assert.equal((await call('POST', '/conciliacao/auto', {})).conciliadas, 1);          // a entrada de 3000 bate exato com a venda
  assert.equal(fin.receber.get(ar.id).status, 'pago');
  const tar = await call('POST', `/conciliacao/${lTar.id}/criar`, { descricao: 'Tarifa bancária', categoria: 'Outros' });
  assert.equal(tar.ref.criada, true);
  const saldo = (await call('GET', '/contas/saldos')).find(s => s.id === conta.id).saldo;
  assert.equal(saldo, 5000 - 1520 + 3000 - 29.9);
  assert.equal((await call('GET', '/conciliacao')).linhas.length, 0);
  await assert.rejects(call('POST', `/conciliacao/${lTar.id}/ignorar`), /já foi tratada/);
  await call('POST', `/conciliacao/${lPag.id}/desfazer`);                              // volta a conta a pagar para aberta
  assert.equal(fin.pagar.get(ap.id).status, 'aberta'); assert.equal((await call('GET', '/contas/saldos')).find(s => s.id === conta.id).saldo, 5000 + 3000 - 29.9);
  await call('POST', `/conciliacao/${lTar.id}/desfazer`);                              // lançamento criado pela conciliação é removido
  assert.equal(fin.pagar.all().filter(x => x.descricao === 'Tarifa bancária').length, 0);
  assert.equal((await call('GET', '/contas/saldos')).find(s => s.id === conta.id).saldoExtrato, 1234.56);
  await assert.rejects(call('POST', '/conciliacao/importar', { contaId: conta.id, ofx: 'lixo' }), /OFX/);
});

test('API conciliação: entrada não concilia com conta a pagar e linha anterior ao saldo inicial é ignorada', async () => {
  const { call } = api(); const { emp, conta } = await setup(call);
  const [ap] = await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Conta', valor: 100, venc: D });
  const ex = await call('POST', '/conciliacao/importar', { contaId: conta.id, ofx: ofx([[-1, 100, 'ENTRADA QUALQUER', 'G1']]) });
  const [l] = (await call('GET', '/conciliacao')).linhas;
  await assert.rejects(call('POST', `/conciliacao/${l.id}/conciliar`, { lancId: ap.id }), /Escolha o lançamento|Entrada do banco/);
  const velha = await call('POST', '/cad/contas', { empresaId: emp.id, nome: 'Nova', saldoInicial: 0, dataSaldo: D, numero: '56789-0' });
  const imp = await call('POST', '/conciliacao/importar', { contaId: velha.id, ofx: ofx([[-10, -5, 'ANTIGA', 'H1']]) });
  assert.equal(imp.anteriores, 1); assert.equal(ex.novas, 1);
});

test('API recorrências: cria, gera, reajusta os futuros e encerra', async () => {
  const { call, fin, a } = api(); const { emp, conta } = await setup(call);
  const r = await call('POST', '/recorrencias', { tipo: 'pagar', empresaId: emp.id, inicio: D, util: false, modelo: { descricao: 'Internet fibra', valor: 200, fornecedor: 'ISP', categoria: 'Outros', contaId: conta.id } });
  assert.equal(r.geradas, 4);
  assert.equal(a.gerarRecorrenciasAgora(), 0);
  assert.equal((await call('GET', '/recorrencias'))[0].geradas, 4);
  await call('POST', `/pagar/${fin.pagar.all()[0].id}/baixar`, { data: D, contaId: conta.id });
  const up = await call('PUT', `/recorrencias/${r.id}`, { valor: 250, aplicarFuturos: true });
  assert.equal(up.ajustadas, 3);                                                       // a já paga não muda
  assert.deepEqual(fin.pagar.all().map(x => x.valor), [200, 250, 250, 250]);
  const del = await call('DELETE', `/recorrencias/${r.id}`);
  assert.equal(del.removidas, 3); assert.equal(fin.pagar.all().length, 1);
  await assert.rejects(call('POST', '/recorrencias', { tipo: 'pagar', empresaId: emp.id, inicio: D, modelo: { descricao: 'x', valor: 10 } }), /título/);
});

test('API orçamento: define meta, exceção por mês e remove', async () => {
  const { call } = api(); const { emp } = await setup(call);
  const mes = D.slice(0, 7);
  await call('PUT', '/orcamento', { empresaId: emp.id, tipo: 'despesa', categoria: 'Marketing', valor: 1000 });
  await call('PUT', '/orcamento', { empresaId: emp.id, tipo: 'despesa', categoria: 'Marketing', valor: 1500 });   // atualiza, não duplica
  await call('PUT', '/orcamento', { empresaId: emp.id, tipo: 'despesa', categoria: 'Marketing', valor: 2500, mes });
  await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Anúncios', valor: 2000, venc: `${mes}-28`, categoria: 'Marketing' });
  const o = await call('GET', '/orcamento', null, `mes=${mes}&empresa=${emp.id}`);
  assert.equal(o.definidos.length, 2); assert.equal(o.linhas[0].orcado, 2500); assert.equal(o.linhas[0].pct, 80); assert.equal(o.linhas[0].status, 'ok');
  await call('DELETE', `/orcamento/${o.definidos.find(x => x.mes === mes).id}`);
  assert.equal((await call('GET', '/orcamento', null, `mes=${mes}&empresa=${emp.id}`)).linhas[0].status, 'estourado');
});

test('API caixa por conta e resumo por conta', async () => {
  const { call } = api(); const { emp, conta } = await setup(call);
  const outra = await call('POST', '/cad/contas', { empresaId: emp.id, nome: 'Caixa', tipo: 'caixa', saldoInicial: 100, dataSaldo: `${D.slice(0, 4)}-01-01` });
  await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Pagar na conta Itaú', valor: 400, venc: R.addMonths(D, 1), contaId: conta.id });
  await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Pagar no caixa', valor: 30, venc: R.addMonths(D, 1), contaId: outra.id });
  const c = await call('GET', '/caixa', null, `conta=${conta.id}&atras=0&frente=2`);
  assert.equal(c.linhas[1].saidaPrev, 400); assert.equal(c.saldoFinal, 5000 - 400);
  const cx = await call('GET', '/caixa', null, `conta=${outra.id}&atras=0&frente=2`);
  assert.equal(cx.saldoFinal, 70);
  const resumo = await call('GET', '/caixa/contas');
  assert.equal(resumo.find(x => x.id === conta.id).saldo, 5000);
  await assert.rejects(call('GET', '/caixa', null, 'conta=inexistente'), /não encontrada/);
});

test('API anexos: envia, baixa, exige tipo permitido e remove', async () => {
  const { call, fin } = api(); const { emp } = await setup(call);
  const [p] = await call('POST', '/pagar', { empresaId: emp.id, descricao: 'Fornecedor X', valor: 100, venc: D });
  const conteudo = Buffer.from('%PDF-1.4 teste');
  const m = await call('POST', '/anexos', { tipo: 'pagar', lancId: p.id, nome: '../../boleto março.pdf', base64: conteudo.toString('base64') });
  assert.equal(m.nome, 'boleto março.pdf'); assert.equal(m.tamanho, conteudo.length);                // caminho é descartado
  assert.equal(fin.pagar.get(p.id).anexos.length, 1);
  const f = await call('GET', `/anexos/${m.id}`);
  assert.equal(f.__file.mime, 'application/pdf'); assert.equal(f.__file.dados.toString(), '%PDF-1.4 teste');
  await assert.rejects(call('POST', '/anexos', { tipo: 'pagar', lancId: p.id, nome: 'virus.exe', base64: 'AAAA' }), /não permitido/);
  await assert.rejects(call('POST', '/anexos', { tipo: 'pagar', lancId: p.id, nome: 'pagina.html', base64: 'AAAA' }), /não permitido/);
  await assert.rejects(call('POST', '/anexos', { tipo: 'pagar', lancId: p.id, nome: 'vazio.pdf', base64: '' }), /vazio/);
  await assert.rejects(call('POST', '/anexos', { tipo: 'pagar', lancId: 'nao-existe', nome: 'a.pdf', base64: 'AAAA' }), /não encontrado/);
  await call('DELETE', `/anexos/${m.id}`);
  assert.equal(fin.pagar.get(p.id).anexos.length, 0);
  await assert.rejects(call('GET', `/anexos/${m.id}`), /não encontrado/);
});
