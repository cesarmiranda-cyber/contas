'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { dashboard } = require('../lib/dashboard');
const R = require('../lib/rules');

const HOJE = '2026-10-15';
let n = 0;
const t = (stage, valor, venc, extra = {}) => ({ id: ++n, titulo: 'T' + n, cliente: extra.cliente || 'Cliente A', stageId: stage, valor, venc, pagoEm: '', tipo: 'UNICA', link: '', criado: '2026-01-10', ...extra });
const S = R.STAGES;

test('resumo: a vencer, atraso, pago, cancelado, janelas de 7/30/60/90 dias e inadimplência', () => {
  const d = dashboard([
    t(S.open, 1000, '2026-10-20'),            // 5 dias
    t(S.soon, 500, '2026-10-16'),             // 1 dia
    t(S.open, 2000, '2026-11-10'),            // 26 dias
    t(S.open, 4000, '2026-12-20'),            // 66 dias
    t(S.late, 600, '2026-10-01'),             // 14 dias de atraso
    t(S.late, 400, '2026-07-01'),             // 106 dias
    t(S.paid, 3000, '2026-10-05', { pagoEm: '2026-10-05' }),
    t(S.cancelled, 700, '2026-09-01'),
    t(S.gerar, 99999, '2026-10-30'), t(S.contrato, 88888, '2026-10-30'),   // contratos fora dos números
  ], HOJE);
  const r = d.resumo;
  assert.equal(r.aVencer.valor, 7500); assert.equal(r.aVencer.qtd, 4);
  assert.equal(r.atrasado.valor, 1000); assert.equal(r.atrasado.qtd, 2);
  assert.equal(r.pago.valor, 3000); assert.equal(r.cancelado.valor, 700);
  assert.equal(r.aReceber, 8500);
  assert.deepEqual(r.proximos, { d7: 1500, d30: 3500, d60: 3500, d90: 7500 });
  assert.equal(r.inadimplenciaPct, 11.8);                    // 1000 / 8500
  assert.equal(d.total, 8);
  assert.equal(r.recebidoMes, 3000);
});

test('linha do tempo: passado recebido/atraso, futuro previsto, mês atual com os três; atraso fora de etapa também conta', () => {
  const d = dashboard([
    t(S.paid, 800, '2026-08-10', { pagoEm: '2026-08-12' }),
    t(S.paid, 200, '2026-09-10', { pagoEm: '2026-09-09' }),
    t(S.paid, 1500, '2026-10-02', { pagoEm: '2026-10-03' }),
    t(S.open, 300, '2026-10-01'),                             // venceu e a etapa ainda é "Em aberto": é atraso
    t(S.open, 900, '2026-10-28'),
    t(S.open, 1100, '2026-12-05'),
  ], HOJE, { meses: 3 });
  assert.deepEqual(d.linha.map(x => x.mes), ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
  const by = k => d.linha.find(x => x.mes === k);
  assert.equal(by('2026-08').recebido, 800); assert.equal(by('2026-09').recebido, 200);
  assert.equal(by('2026-10').recebido, 1500); assert.equal(by('2026-10').atrasado, 300); assert.equal(by('2026-10').aVencer, 900);
  assert.equal(by('2026-12').aVencer, 1100); assert.equal(by('2026-12').futuro, true); assert.equal(by('2026-10').atual, true);
  assert.equal(by('2026-10').label, 'out/26');
  assert.equal(dashboard([], HOJE, { meses: 12 }).linha.length, 23);
});

test('aging por faixa, maior atraso e devedores ordenados', () => {
  const d = dashboard([
    t(S.late, 100, '2026-10-05', { cliente: 'Ana' }),         // 10 d
    t(S.late, 200, '2026-09-01', { cliente: 'Bruno' }),       // 44 d
    t(S.late, 300, '2026-08-01', { cliente: 'Bruno' }),       // 75 d
    t(S.late, 900, '2026-05-01', { cliente: 'Carla' }),       // 167 d
    t(S.open, 50, '2026-11-01', { cliente: 'Ana' }),
  ], HOJE);
  assert.deepEqual(d.aging.map(a => [a.faixa, a.valor, a.qtd]), [['1-30', 100, 1], ['31-60', 200, 1], ['61-90', 300, 1], ['90+', 900, 1]]);
  assert.equal(d.maisAntigo, 167);
  assert.deepEqual(d.devedores.map(x => [x.cliente, x.valor, x.qtd, x.maxAtraso]), [['Carla', 900, 1, 167], ['Bruno', 500, 2, 75], ['Ana', 100, 1, 10]]);
});

test('pontualidade, eficiência de cobrança e previsão ajustada', () => {
  const lista = [];
  for (let i = 0; i < 8; i++) lista.push(t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-10' }));       // 8 no prazo
  lista.push(t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-16' }), t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-14' })); // 2 atrasados (6 e 4 dias)
  lista.push(t(S.late, 200, '2026-09-20'));                                                                // venceu em 90d e continua em atraso
  lista.push(t(S.open, 1000, '2026-10-25'));
  const d = dashboard(lista, HOJE);
  assert.equal(d.pontualidade.n, 10); assert.equal(d.pontualidade.pct, 80); assert.equal(d.pontualidade.atrasoMedio, 5);
  assert.equal(d.eficiencia.n, 11); assert.equal(d.eficiencia.pct, 83.3);                                  // 1000 / (1000 + 200)
  assert.equal(d.previsao30.nominal, 1000); assert.equal(d.previsao30.taxa, 83.3); assert.equal(d.previsao30.esperado, 833);
  const poucos = dashboard([t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-10' }), t(S.open, 500, '2026-10-20')], HOJE);
  assert.equal(poucos.previsao30.esperado, null);                                                           // sem histórico suficiente: não ajusta
});

test('saúde financeira: nota composta, rótulo e sem-dados', () => {
  const bom = [];
  for (let i = 0; i < 20; i++) bom.push(t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-09', cliente: 'C' + (i % 6) }));
  for (let i = 0; i < 6; i++) bom.push(t(S.open, 100, '2026-11-0' + (1 + i), { cliente: 'C' + i }));
  const g = dashboard(bom, HOJE);
  assert.equal(g.saude.nivel, 'excelente'); assert.ok(g.saude.score >= 95);
  assert.equal(g.saude.componentes.reduce((x, c) => x + c.peso, 0), 100);
  assert.ok(g.saude.componentes.some(c => c.id === 'concentracao'));
  const ruim = [];
  for (let i = 0; i < 6; i++) ruim.push(t(S.late, 1000, '2026-08-1' + i, { cliente: 'Devedor' }));
  for (let i = 0; i < 4; i++) ruim.push(t(S.paid, 100, '2026-09-01', { pagoEm: '2026-09-25', cliente: 'Devedor' }));
  const r = dashboard(ruim, HOJE);
  assert.equal(r.saude.nivel, 'critica');
  const vazio = dashboard([], HOJE);
  assert.equal(vazio.saude.score, null); assert.equal(vazio.saude.nivel, 'sem-dados');
  assert.equal(vazio.insights[0].tipo, 'ok');
});

test('cliente individual: perfil de pagamento sem concentração e com próximas cobranças', () => {
  const l = [];
  for (let i = 0; i < 5; i++) l.push(t(S.paid, 200, '2026-08-1' + i, { pagoEm: '2026-08-2' + i, cliente: 'Zé' }));   // sempre atrasa ~10 dias
  l.push(t(S.open, 300, '2026-10-17', { cliente: 'Zé', link: 'https://l/1' }), t(S.open, 300, '2026-11-17', { cliente: 'Zé' }));
  const d = dashboard(l, HOJE, { individual: true });
  assert.ok(!d.saude.componentes.some(c => c.id === 'concentracao'));
  assert.equal(d.pontualidade.pct, 0); assert.equal(d.pontualidade.atrasoMedio, 10);
  assert.ok(d.insights.some(i => /Costuma pagar com atraso/.test(i.msg)));
  assert.equal(d.proximas[0].dias, 2); assert.equal(d.proximas[0].link, 'https://l/1');
  assert.equal(d.proximas.length, 2);
  assert.ok(['atencao', 'critica', 'boa'].includes(d.saude.nivel));
  assert.match(d.saude.rotulo, /pagador|Atenção|Risco/);
});

test('insights: concentração, sem data e recorrência prevista', () => {
  const d = dashboard([
    t(S.open, 9000, '2026-11-01', { cliente: 'Gigante', tipo: 'RECORRENTE' }), t(S.open, 500, '2026-10-30', { cliente: 'Pequeno', tipo: 'RECORRENTE' }),
    t(S.open, 400, '', { cliente: 'Pequeno' }),
  ], HOJE);
  assert.ok(d.insights.some(i => /Gigante concentra/.test(i.msg)));
  assert.ok(d.insights.some(i => /sem data de vencimento/.test(i.msg)));
  assert.equal(d.recorrente30, 9500);
  assert.equal(d.resumo.semData.qtd, 1); assert.equal(d.resumo.aReceber, 9500);        // sem data não entra na previsão
});

test('dívida antiga pesa na eficiência e limita a nota (nunca "Excelente pagador" com atraso grave)', () => {
  const l = [];
  for (let i = 0; i < 8; i++) l.push(t(S.paid, 500, '2026-09-1' + i, { pagoEm: '2026-09-0' + (1 + i), cliente: 'Zé' }));   // 8 pagos antes do vencimento
  l.push(t(S.late, 1330, '2026-05-24', { cliente: 'Zé' }), t(S.open, 20000, '2026-11-10', { cliente: 'Zé' }));                                                              // 144 dias de atraso, fora da janela de 3 meses
  const d = dashboard(l, HOJE, { individual: true });
  assert.equal(d.eficiencia.pct, 75);                                                                                    // 4000 / (4000 + 1330) — a dívida antiga conta
  assert.ok(d.saude.score <= 69); assert.equal(d.saude.teto.max, 69); assert.match(d.saude.teto.motivo, /90 dias/);
  assert.notEqual(d.saude.nivel, 'excelente'); assert.notEqual(d.saude.nivel, 'boa');
  // atraso entre 60 e 90 dias limita a "Boa"; sem atraso antigo não há teto
  const l2 = []; for (let i = 0; i < 10; i++) l2.push(t(S.paid, 500, '2026-09-1' + (i % 9), { pagoEm: '2026-09-01', cliente: 'Ana' })); l2.push(t(S.late, 100, '2026-08-01', { cliente: 'Ana' }), t(S.open, 5000, '2026-11-10', { cliente: 'Ana' }));
  const d2 = dashboard(l2, HOJE, { individual: true });
  assert.equal(d2.saude.teto.max, 84); assert.ok(d2.saude.score <= 84);
  const l3 = []; for (let i = 0; i < 10; i++) l3.push(t(S.paid, 500, '2026-09-1' + (i % 9), { pagoEm: '2026-09-01', cliente: 'Bia' }));
  l3.push(t(S.open, 5000, '2026-11-10', { cliente: 'Bia' }));
  const d3 = dashboard(l3, HOJE, { individual: true });
  assert.equal(d3.saude.teto, null); assert.equal(d3.saude.nivel, 'excelente');
  // visão geral: só limita quando o atraso grave é ≥10% do a receber
  const g = []; for (let i = 0; i < 10; i++) g.push(t(S.paid, 500, '2026-09-1' + (i % 9), { pagoEm: '2026-09-01', cliente: 'C' + i }));
  g.push(t(S.late, 100, '2026-05-01', { cliente: 'C1' }), t(S.open, 9000, '2026-11-10', { cliente: 'C2' }), t(S.open, 8000, '2026-11-12', { cliente: 'C3' }), t(S.open, 7000, '2026-11-14', { cliente: 'C4' }));
  assert.equal(dashboard(g, HOJE).saude.teto, null);                                                                     // 100 / 24100 < 10%
});

test('recebido do mês é comparado com o MESMO trecho do mês anterior (mês em andamento não é injusto)', () => {
  const d = dashboard([
    t(S.paid, 1000, '2026-09-05', { pagoEm: '2026-09-05' }),     // até o dia 15 do mês anterior
    t(S.paid, 2000, '2026-09-25', { pagoEm: '2026-09-25' }),     // depois do dia 15: não entra na comparação
    t(S.paid, 1100, '2026-10-03', { pagoEm: '2026-10-03' }),
  ], HOJE);
  assert.equal(d.resumo.recebidoMes, 1100); assert.equal(d.resumo.recebidoMesAnterior, 3000); assert.equal(d.resumo.recebidoMesAnteriorAteHoje, 1000);
  assert.equal(d.resumo.recebidoDeltaPct, 10);
  assert.equal(dashboard([t(S.paid, 1100, '2026-10-03', { pagoEm: '2026-10-03' })], HOJE).resumo.recebidoDeltaPct, null);   // sem base: não inventa variação
});

test('pontualidade tolera 2 dias (compensação) e o alerta de "costuma atrasar" exige amostra e atraso relevante', () => {
  const dois = [t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-11', cliente: 'Bia' }), t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-12', cliente: 'Bia' })];
  const d = dashboard(dois, HOJE, { individual: true });
  assert.equal(d.pontualidade.pct, 100); assert.equal(d.pontualidade.atrasoMedio, 0);                       // 1 e 2 dias depois = no prazo
  assert.ok(!d.insights.some(i => /Costuma pagar com atraso/.test(i.msg)));
  const tres = [1, 2, 3].map(() => t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-14', cliente: 'Caio' }));  // 4 dias de atraso, 3 pagamentos
  const c = dashboard(tres, HOJE, { individual: true });
  assert.equal(c.pontualidade.pct, 0); assert.equal(c.pontualidade.atrasoMedio, 4);
  assert.ok(c.insights.some(i => /Costuma pagar com atraso: 100% .* 4 dias/.test(i.msg)));
  const amostraPequena = dashboard([t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-20', cliente: 'Duda' }), t(S.paid, 100, '2026-09-10', { pagoEm: '2026-09-20', cliente: 'Duda' })], HOJE, { individual: true });
  assert.ok(!amostraPequena.insights.some(i => /Costuma pagar com atraso/.test(i.msg)));                     // só 2 pagamentos: não conclui
});

test('painel entrega as 3 janelas de uma vez (trocar o filtro não exige nova consulta) e o cache serve rápido', async () => {
  const { world, today, FORMA_ID, TIPO_ID } = require('../testkit/world');
  const w = world([{ ID: '1', TITLE: 'A', STAGE_ID: R.STAGES.open, OPPORTUNITY: '100', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_VENC: R.addMonths(today, 1) + 'T00:00:00+03:00', UF_CRM_CR_FORMA: FORMA_ID('PIX'), UF_CRM_CR_TIPO: TIPO_ID('UNICA') }]);
  const p = await w.svc.painel({});
  assert.deepEqual(Object.keys(p.dashes).sort(), ['12', '3', '6']);
  assert.deepEqual([3, 6, 12].map(m => p.dashes[m].linha.length), [5, 11, 23]);
  assert.equal(p.dashes[3].resumo.aReceber, p.dashes[12].resumo.aReceber);                 // saldos não dependem da janela
  assert.equal(p.escopo, null);
  const c = await w.svc.painel({ deal: '1' });
  assert.equal(c.dashes[6].individual, true); assert.equal(c.escopo.companyId, '5');
  // cache: dentro de 5 min devolve na hora (e atualiza em segundo plano); maxAge 0 e invalidação leem de novo
  const antes = w.calls.length;
  await w.svc.dealsCached(1); await new Promise(r => setTimeout(r, 5));
  const base = w.calls.length;
  w.deals.push({ ID: '2', TITLE: 'B', STAGE_ID: R.STAGES.open, OPPORTUNITY: '50', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_VENC: R.addMonths(today, 1) + 'T00:00:00+03:00' });
  const stale = await w.svc.dealsCached(60000);
  assert.equal(stale.length, 1);                                                          // dentro do prazo: não releu
  const fresh = await w.svc.dealsCached(0);
  assert.equal(fresh.length, 2);                                                          // maxAge 0: lê de novo
  assert.ok(base >= antes);
});
