'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fluxoCaixa } = require('../lib/fluxo');
const R = require('../lib/rules');

const HOJE = '2026-10-15';
let n = 0;
const rec = (stage, valor, venc, extra = {}) => ({ id: ++n, stageId: stage, valor, venc, pagoEm: '', ...extra });
const ap = (estado, valor, venc, extra = {}) => ({ id: 1000 + (++n), estado, valor, venc, beneficiario: 'Parceiro A', origem: 0, ...extra });
const S = R.STAGES;

test('entradas e saídas por mês, saldo acumulado; atrasadas, pagas, canceladas e contratos ficam fora da previsão', () => {
  const f = fluxoCaixa([
    rec(S.open, 1000, '2026-10-20'), rec(S.open, 2000, '2026-11-10'), rec(S.open, 500, '2026-12-05'),
    rec(S.late, 300, '2026-09-01'),                                             // atrasada: não é previsão confiável
    rec(S.paid, 9999, '2026-10-02', { pagoEm: '2026-10-02' }), rec(S.gerar, 7777, '2026-10-30'),
  ], [
    ap('aguardando', 300, '2026-10-25'),                                        // repasse estimado no mês atual
    ap('aberto', 400, '2026-11-20'), ap('atrasado', 150, '2026-10-01'),         // atrasada sai neste mês
    ap('pago', 5000, '2026-10-05'), ap('cancelado', 800, '2026-11-01'),
  ], HOJE, { meses: 3 });
  assert.deepEqual(f.linha.map(l => [l.mes, l.entradas, l.saidas, l.saldo, l.acumulado]), [
    ['2026-10', 1000, 450, 550, 550], ['2026-11', 2000, 400, 1600, 2150], ['2026-12', 500, 0, 500, 2650]]);
  assert.equal(f.linha[0].atual, true); assert.equal(f.linha[0].label, 'out/26'); assert.equal(f.linha[1].atual, false);
  assert.equal(f.resumo.saldoPeriodo, 2650);
  assert.equal(f.resumo.atrasadoReceber, 300);
  assert.equal(fluxoCaixa([], [], HOJE, { meses: 12 }).linha.length, 12);
});

test('janelas de 30 dias, a pagar × aguardando × atrasado e alerta de mês com saldo negativo', () => {
  const f = fluxoCaixa([rec(S.open, 1000, '2026-10-20'), rec(S.open, 2000, '2026-11-10'), rec(S.open, 800, '2026-12-20')], [
    ap('aberto', 400, '2026-11-20'), ap('atrasado', 150, '2026-10-01'), ap('aguardando', 300, '2026-10-25'), ap('aberto', 5000, '2026-12-22'),
  ], HOJE, { meses: 3 });
  assert.equal(f.resumo.entradas30, 3000);                  // 20/10 (5 dias) e 10/11 (26 dias)
  assert.equal(f.resumo.saidas30, 450);                     // 150 vencida + 300 aguardando; 400 (36 dias) e 5000 ficam fora
  assert.equal(f.resumo.saldo30, 2550);
  assert.equal(f.resumo.aPagarTotal, 5550); assert.equal(f.resumo.aguardando, 300); assert.equal(f.resumo.atrasadoPagar, 150);
  const alerta = f.insights.find(i => i.tipo === 'alerta' && /dez\/26/.test(i.msg));
  assert.ok(alerta); assert.match(alerta.msg, /faltam R\$\s4\.200,00/);
  assert.ok(f.insights.some(i => /contas a pagar já vencidas/.test(i.msg)));
  assert.ok(f.insights.some(i => /aguardando o recebimento/.test(i.msg)));
});

test('margem de 90 dias: receita recebida menos repasses ligados (cancelados não contam) e maiores a pagar', () => {
  const r1 = rec(S.paid, 1000, '2026-09-10', { pagoEm: '2026-09-12' }), r2 = rec(S.paid, 2000, '2026-08-20', { pagoEm: '2026-08-21' });
  const antiga = rec(S.paid, 5000, '2026-01-10', { pagoEm: '2026-01-11' });              // fora dos 90 dias
  const f = fluxoCaixa([r1, r2, antiga], [
    ap('pago', 300, '2026-09-20', { origem: r1.id }), ap('aberto', 600, '2026-11-01', { origem: r2.id, beneficiario: 'Parceiro B' }),
    ap('cancelado', 999, '2026-09-20', { origem: r1.id }), ap('pago', 2500, '2026-01-20', { origem: antiga.id }), ap('aberto', 100, '2026-11-02', { beneficiario: 'ISP' }),
  ], HOJE);
  assert.deepEqual([f.margem.receita, f.margem.repasses, f.margem.margem, f.margem.pct, f.margem.qtd], [3000, 900, 2100, 70, 2]);
  assert.ok(f.insights.some(i => /Margem dos últimos 90 dias: R\$\s2\.100,00 \(70%\)/.test(i.msg)));
  assert.deepEqual(f.maiores.map(m => [m.nome, m.valor]), [['Parceiro B', 600], ['ISP', 100]]);
  assert.equal(fluxoCaixa([], [], HOJE).margem.pct, null);                                // sem receita: não inventa percentual
});
