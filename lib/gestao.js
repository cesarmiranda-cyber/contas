'use strict';
// Resultado gerencial (DRE) da Manda4 — função pura, testável.
// Receita = contas a receber (vendas com comissão, vendas sem comissão e recebimentos avulsos).
// (−) Repasses/comissões a parceiros = contas a pagar ligadas a uma venda.
// = Margem da Manda4. (−) Despesas = contas a pagar sem parceiro/venda, por categoria. = Resultado.
// Regime "caixa": o que de fato entrou/saiu no mês (data de pagamento). Regime "competencia": o que vence no mês (pago ou não).
const R = require('./rules');
const r2 = n => Math.round(n * 100) / 100;
const COMISSAO_CATS = new Set(['Repasse a parceiro', 'Comissão']);
const isPago = r => r.stageId === R.STAGES.paid;
const isCanc = r => r.stageId === R.STAGES.cancelled;
const isMestre = r => R.CONTRACT_STAGES.has(r.stageId);      // contratos/assinaturas-mãe: só os cards filhos valem

const mesDe = d => String(d || '').slice(0, 7);
const addMes = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const label = m => { const [y, mo] = m.split('-'); return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+mo - 1]}/${y.slice(2)}`; };

// Títulos a pagar sem contar duas vezes: o consolidado é só um agrupador, valem os títulos que ele contém.
const pagaveis = contas => contas.filter(c => !(c.itens && c.itens.length) && c.estado !== 'cancelado');
const ehComissao = c => (c.origem > 0) || COMISSAO_CATS.has(c.categoria);
const recOrigem = r => (r.manual ? 'avulso' : (r.split || r.repasses) ? 'comissao' : 'semComissao');
const ORIGEM_NOME = { comissao: 'Venda com comissão a parceiro', semComissao: 'Venda sem comissão (100% Manda4)', avulso: 'Recebimento avulso (sem Asaas)' };

function dre(recebiveis, contas, { mes, regime = 'caixa', hoje } = {}) {
  const caixa = regime !== 'competencia';
  const rec = recebiveis.filter(r => !isMestre(r) && !isCanc(r));
  const pag = pagaveis(contas);
  const noMes = (data) => mesDe(data) === mes;

  // ----- receitas -----
  const recs = rec.filter(r => {
    if (caixa) return isPago(r) && noMes(r.pagoEm);
    return noMes(r.venc);
  });
  const porOrigem = {};
  let taxas = 0, receita = 0;
  for (const r of recs) {
    const v = r.valor, o = recOrigem(r);
    receita += v;
    (porOrigem[o] ||= { origem: o, nome: ORIGEM_NOME[o], valor: 0, qtd: 0 });
    porOrigem[o].valor += v; porOrigem[o].qtd++;
    if (isPago(r) && r.liquido > 0 && r.liquido < v && !r.manual) taxas += v - r.liquido;     // taxas do Asaas = bruto − líquido
  }

  // ----- comissões e despesas -----
  const cs = pag.filter(c => {
    if (caixa) return c.estado === 'pago' && noMes(c.pagoEm);
    return noMes(c.venc);
  });
  const valorDe = c => (caixa && c.valorPago > 0 ? c.valorPago : c.valor);
  // repasse a FORNECEDOR de uma venda = custo da revenda; repasse a parceiro/colaborador = comissão; o resto = despesa
  const custosL = cs.filter(c => ehComissao(c) && c.benTipo === 'SUPPLIER'), comissoes = cs.filter(c => ehComissao(c) && c.benTipo !== 'SUPPLIER'), despesas = cs.filter(c => !ehComissao(c));
  const sum = a => r2(a.reduce((x, c) => x + valorDe(c), 0));
  const porParceiro = {};
  for (const c of [...custosL, ...comissoes]) { const k = c.beneficiario || 'Sem nome'; (porParceiro[k] ||= { nome: k, valor: 0, qtd: 0 }); porParceiro[k].valor += valorDe(c); porParceiro[k].qtd++; }
  const porCategoria = {};
  for (const c of despesas) { const k = c.categoria || 'Outros'; (porCategoria[k] ||= { nome: k, valor: 0, qtd: 0 }); porCategoria[k].valor += valorDe(c); porCategoria[k].qtd++; }

  const rec$ = r2(receita), com$ = sum(comissoes), cus$ = sum(custosL), desp$ = sum(despesas), tax$ = r2(taxas);
  const margem = r2(rec$ - com$ - cus$ - tax$);
  const resultado = r2(margem - desp$);
  const out = {
    mes, regime: caixa ? 'caixa' : 'competencia',
    receitaBruta: rec$, custos: cus$, comissoes: com$, taxas: tax$, margem, margemPct: rec$ ? r2((margem / rec$) * 100) : null,
    despesas: desp$, resultado, resultadoPct: rec$ ? r2((resultado / rec$) * 100) : null,
    receitaPorOrigem: Object.values(porOrigem).map(x => ({ ...x, valor: r2(x.valor) })).sort((a, b) => b.valor - a.valor),
    comissaoPorParceiro: Object.values(porParceiro).map(x => ({ ...x, valor: r2(x.valor) })).sort((a, b) => b.valor - a.valor),
    despesasPorCategoria: Object.values(porCategoria).map(x => ({ ...x, valor: r2(x.valor) })).sort((a, b) => b.valor - a.valor),
  };
  // quanto da receita do mês ainda não entrou / das saídas ainda não saíram (só faz sentido em competência)
  if (!caixa) {
    out.aReceber = r2(recs.filter(r => !isPago(r)).reduce((a, r) => a + r.valor, 0));
    out.aPagar = r2(cs.filter(c => c.estado !== 'pago').reduce((a, c) => a + c.valor, 0));
  }
  return out;
}

// Série dos últimos N meses (inclui o mês escolhido) para o gráfico de evolução.
function serie(recebiveis, contas, { mes, regime, meses = 6 } = {}) {
  const out = [];
  for (let i = meses - 1; i >= 0; i--) { const m = addMes(mes, -i); const d = dre(recebiveis, contas, { mes: m, regime }); out.push({ mes: m, label: label(m), receita: d.receitaBruta, comissoes: r2(d.comissoes + d.custos), despesas: d.despesas, resultado: d.resultado }); }
  return out;
}

// Posição de hoje: o que falta receber e pagar (todas as datas) e o saldo projetado.
function posicao(recebiveis, contas, hoje) {
  const abertos = recebiveis.filter(r => !isMestre(r) && !isPago(r) && !isCanc(r));
  const pag = pagaveis(contas).filter(c => ['aberto', 'proximo', 'atrasado', 'consolidado', 'aguardando'].includes(c.estado));
  const s = a => r2(a.reduce((x, c) => x + c.valor, 0));
  const atrasoR = abertos.filter(r => r.venc && r.venc < hoje), atrasoP = pag.filter(c => c.estado !== 'aguardando' && c.venc && c.venc < hoje);
  return { aReceber: s(abertos), receberAtrasado: s(atrasoR), aPagar: s(pag.filter(c => c.estado !== 'aguardando')), pagarAtrasado: s(atrasoP), repassesAguardando: s(pag.filter(c => c.estado === 'aguardando')), saldoProjetado: r2(s(abertos) - s(pag)) };
}

module.exports = { dre, serie, posicao, addMes, label, recOrigem };
