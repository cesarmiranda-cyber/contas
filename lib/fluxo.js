'use strict';
const R = require('./rules');

// Fluxo de caixa previsto: entradas (a receber) × saídas (contas a pagar, inclusive repasses a parceiros), por mês,
// e margem das vendas (o que entrou menos o que vai para parceiros). Função pura.
//  - Entradas: cobranças em aberto com vencimento de hoje em diante (as já vencidas ficam à parte: não são previsão confiável).
//  - Saídas: contas a pagar não pagas/canceladas, no mês do vencimento (as atrasadas contam no mês atual: precisam sair já).
//    Repasse "aguardando recebimento" entra pelo vencimento estimado (vencimento da cobrança + prazo do parceiro).
//  - Saldo acumulado parte de zero: o app não conhece o saldo bancário.
const r2 = n => Math.round(n * 100) / 100;
const monthKey = d => String(d).slice(0, 7);
const shiftMonth = (key, n) => R.addMonths(`${key}-01`, n).slice(0, 7);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const brl = n => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const ABERTAS = new Set(['aguardando', 'aberto', 'proximo', 'atrasado']);

function fluxoCaixa(recebiveis, contas, hoje, { meses = 6 } = {}) {
  const rec = recebiveis.filter(d => !R.CONTRACT_STAGES.has(d.stageId));
  const abertos = rec.filter(d => !R.FINAL_STAGES.has(d.stageId));
  const aVencer = abertos.filter(d => d.venc && d.venc >= hoje);
  const atrasadosReceber = abertos.filter(d => d.venc && d.venc < hoje);
  const saidas = contas.filter(c => ABERTAS.has(c.estado));
  const cur = monthKey(hoje);
  const saidaMes = c => (c.venc && c.venc >= hoje ? monthKey(c.venc) : cur);        // atrasada/sem data: sai neste mês
  const sum = (a, f) => r2(a.reduce((x, d) => x + f(d), 0));

  let acum = 0;
  const linha = [];
  for (let i = 0; i < Math.max(1, meses); i++) {
    const k = shiftMonth(cur, i);
    const entradas = sum(aVencer.filter(d => monthKey(d.venc) === k), d => d.valor);
    const sai = sum(saidas.filter(c => saidaMes(c) === k), c => c.valor);
    acum = r2(acum + entradas - sai);
    linha.push({ mes: k, label: `${MESES[+k.slice(5, 7) - 1]}/${k.slice(2, 4)}`, atual: i === 0, entradas, saidas: sai, saldo: r2(entradas - sai), acumulado: acum });
  }
  const em30 = d => R.dayDiff(d, hoje) <= 30;
  const entradas30 = sum(aVencer.filter(d => em30(d.venc)), d => d.valor);
  const saidas30 = sum(saidas.filter(c => !c.venc || c.venc < hoje || em30(c.venc)), c => c.valor);
  const total = f => sum(contas.filter(f), c => c.valor);

  // margem dos últimos 90 dias: o que foi recebido × repasses ligados a essas cobranças
  const ini = R.addMonths(hoje, -3);
  const recebidas = rec.filter(d => d.stageId === R.STAGES.paid && (d.pagoEm || d.venc) >= ini);
  const ids = new Set(recebidas.map(d => d.id));
  const ligados = contas.filter(c => c.origem && ids.has(c.origem) && c.estado !== 'cancelado');
  const receita = sum(recebidas, d => d.valor);
  const repasses = sum(ligados, c => c.valor);
  const margem = { receita, repasses, margem: r2(receita - repasses), pct: receita > 0 ? Math.round(((receita - repasses) / receita) * 1000) / 10 : null, qtd: recebidas.length };

  // quem mais temos a pagar (parceiros/fornecedores)
  const porBenef = new Map();
  for (const c of saidas) { const k = c.beneficiario || 'Sem beneficiário'; porBenef.set(k, (porBenef.get(k) || 0) + c.valor); }
  const maiores = [...porBenef].map(([nome, valor]) => ({ nome, valor: r2(valor) })).sort((a, b) => b.valor - a.valor).slice(0, 5);

  const resumo = {
    entradas30, saidas30, saldo30: r2(entradas30 - saidas30),
    aPagarTotal: total(c => ['aberto', 'proximo', 'atrasado'].includes(c.estado)), aguardando: total(c => c.estado === 'aguardando'),
    atrasadoPagar: total(c => c.estado === 'atrasado'), atrasadoReceber: sum(atrasadosReceber, d => d.valor),
    saldoPeriodo: linha.length ? linha[linha.length - 1].acumulado : 0,
  };

  const insights = [];
  const neg = linha.find(l => l.saldo < 0);
  if (neg) insights.push({ tipo: 'alerta', msg: `Em ${neg.label} as saídas previstas (${brl(neg.saidas)}) superam as entradas (${brl(neg.entradas)}): faltam ${brl(-neg.saldo)}.` });
  if (resumo.atrasadoPagar > 0) insights.push({ tipo: 'alerta', msg: `${brl(resumo.atrasadoPagar)} em contas a pagar já vencidas.` });
  if (resumo.aguardando > 0) insights.push({ tipo: 'info', msg: `${brl(resumo.aguardando)} em repasses a parceiros aguardando o recebimento dos clientes.` });
  if (margem.pct !== null && margem.receita > 0) insights.push({ tipo: 'info', msg: `Margem dos últimos 90 dias: ${brl(margem.margem)} (${margem.pct}%) depois de ${brl(margem.repasses)} em repasses.` });

  return { meses, linha, resumo, margem, maiores, insights };
}
module.exports = { fluxoCaixa };
