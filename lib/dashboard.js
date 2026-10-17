'use strict';
const R = require('./rules');

// Indicadores do painel financeiro. Função pura (sem I/O): recebe os lançamentos já carregados
// (todos, ou só os de um cliente) e a data de hoje, e devolve tudo que o painel desenha.
//
// Definições (as mesmas mostradas na tela):
//  - A vencer: não pago/cancelado, vencimento de hoje em diante. Em atraso: não pago/cancelado, vencimento anterior a hoje.
//  - Eficiência de cobrança: dos títulos que venceram nos últimos 90 dias, quanto do valor já foi recebido
//    (recebido ÷ (recebido + ainda em atraso)).
//  - Pontualidade: % dos títulos pagos (na janela) que foram pagos até o vencimento.
//  - Inadimplência: valor em atraso ÷ valor total a receber (a vencer + em atraso).
const r2 = n => Math.round(n * 100) / 100;
const pct = n => Math.round(n * 10) / 10;
const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, n));
const monthKey = d => String(d).slice(0, 7);
const shiftMonth = (key, n) => R.addMonths(`${key}-01`, n).slice(0, 7);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesLabel = k => `${MESES[+k.slice(5, 7) - 1]}/${k.slice(2, 4)}`;
const brl = n => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// Pagamento até 2 dias depois do vencimento conta como "no prazo" (compensação bancária de boleto, fim de semana).
const TOLERANCIA_DIAS = 2;
const FAIXAS = [['1-30', 1, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['90+', 91, Infinity]];

function dashboard(all, hoje, { meses = 6, individual = false } = {}) {
  const deals = all.filter(d => !R.CONTRACT_STAGES.has(d.stageId));
  const paid = deals.filter(d => d.stageId === R.STAGES.paid);
  const canc = deals.filter(d => d.stageId === R.STAGES.cancelled);
  const open = deals.filter(d => !R.FINAL_STAGES.has(d.stageId));
  const semData = open.filter(d => !d.venc);
  const late = open.filter(d => d.venc && d.venc < hoje);
  const aVencer = open.filter(d => d.venc && d.venc >= hoje);
  const sum = a => r2(a.reduce((x, d) => x + d.valor, 0));
  const paidDay = d => d.pagoEm || d.venc || '';
  const atraso = d => R.dayDiff(hoje, d.venc);
  const cur = monthKey(hoje), prev = shiftMonth(cur, -1);

  // ---- resumo ----
  const aReceber = r2(sum(aVencer) + sum(late));
  const upTo = n => sum(aVencer.filter(d => R.dayDiff(d.venc, hoje) <= n));
  const recebidoMes = sum(paid.filter(d => monthKey(paidDay(d)) === cur));
  const recebidoPrev = sum(paid.filter(d => monthKey(paidDay(d)) === prev));
  const diaHoje = hoje.slice(8, 10);   // mês em andamento só é comparável com o mesmo trecho do mês anterior
  const recebidoPrevAteHoje = sum(paid.filter(d => monthKey(paidDay(d)) === prev && paidDay(d).slice(8, 10) <= diaHoje));
  const resumo = {
    aReceber, aVencer: { valor: sum(aVencer), qtd: aVencer.length }, atrasado: { valor: sum(late), qtd: late.length },
    pago: { valor: sum(paid), qtd: paid.length }, cancelado: { valor: sum(canc), qtd: canc.length },
    semData: { valor: sum(semData), qtd: semData.length },
    proximos: { d7: upTo(7), d30: upTo(30), d60: upTo(60), d90: upTo(90) },
    recebidoMes, recebidoMesAnterior: recebidoPrev, recebidoMesAnteriorAteHoje: recebidoPrevAteHoje,
    recebidoDeltaPct: recebidoPrevAteHoje > 0 ? pct(((recebidoMes - recebidoPrevAteHoje) / recebidoPrevAteHoje) * 100) : null,
    inadimplenciaPct: aReceber > 0 ? pct((sum(late) / aReceber) * 100) : 0,
  };

  // ---- linha do tempo: meses passados, atual e futuros ----
  const span = Math.max(1, meses) - 1;
  const linha = [];
  for (let i = -span; i <= span; i++) {
    const k = shiftMonth(cur, i);
    linha.push({
      mes: k, label: mesLabel(k), atual: i === 0, futuro: i > 0,
      recebido: sum(paid.filter(d => monthKey(paidDay(d)) === k)),
      atrasado: sum(late.filter(d => monthKey(d.venc) === k)),
      aVencer: sum(aVencer.filter(d => monthKey(d.venc) === k)),
    });
  }

  // ---- aging ----
  const aging = FAIXAS.map(([nome, a, b]) => {
    const it = late.filter(d => atraso(d) >= a && atraso(d) <= b);
    return { faixa: nome, valor: sum(it), qtd: it.length };
  });

  // ---- devedores e concentração (visão geral) ----
  const porCliente = new Map();
  for (const d of open) {
    const k = d.cliente || 'Sem cliente';
    const g = porCliente.get(k) || { cliente: k, aReceber: 0, atrasado: 0, qtdAtraso: 0, maxAtraso: 0 };
    g.aReceber += d.valor;
    if (d.venc && d.venc < hoje) { g.atrasado += d.valor; g.qtdAtraso++; g.maxAtraso = Math.max(g.maxAtraso, atraso(d)); }
    porCliente.set(k, g);
  }
  const clientes = [...porCliente.values()];
  const devedores = clientes.filter(c => c.atrasado > 0).sort((a, b) => b.atrasado - a.atrasado).slice(0, 5)
    .map(c => ({ cliente: c.cliente, valor: r2(c.atrasado), qtd: c.qtdAtraso, maxAtraso: c.maxAtraso }));
  const ranking = [...clientes].sort((a, b) => b.aReceber - a.aReceber);
  const total = ranking.reduce((x, c) => x + c.aReceber, 0);
  const concentracao = {
    top1Pct: total > 0 && ranking[0] ? pct((ranking[0].aReceber / total) * 100) : 0,
    top5Pct: total > 0 ? pct((ranking.slice(0, 5).reduce((x, c) => x + c.aReceber, 0) / total) * 100) : 0,
    topCliente: ranking[0]?.cliente || '', clientes: clientes.length,
  };

  // ---- pontualidade e eficiência ----
  const janelaIni = R.addMonths(hoje, -Math.max(3, meses));
  const pagosJanela = paid.filter(d => d.pagoEm && d.venc && d.pagoEm >= janelaIni);
  const noPrazo = pagosJanela.filter(d => R.dayDiff(d.pagoEm, d.venc) <= TOLERANCIA_DIAS);
  const atrasados = pagosJanela.filter(d => R.dayDiff(d.pagoEm, d.venc) > TOLERANCIA_DIAS);
  const pontualidade = {
    n: pagosJanela.length, tolerancia: TOLERANCIA_DIAS,
    pct: pagosJanela.length ? pct((noPrazo.length / pagosJanela.length) * 100) : null,
    atrasoMedio: atrasados.length ? pct(atrasados.reduce((x, d) => x + R.dayDiff(d.pagoEm, d.venc), 0) / atrasados.length) : 0,
  };
  // Eficiência: do valor que venceu na janela, quanto foi recebido. Todo atraso ainda em aberto pesa, de qualquer idade —
  // dívida antiga não pode sumir da nota só porque saiu da janela.
  const ini90 = R.addMonths(hoje, -3);
  const janelaMeses = Math.max(3, meses);
  const iniEf = R.addMonths(hoje, -janelaMeses);
  const pagoEf = paid.filter(d => d.venc && d.venc >= iniEf && d.venc < hoje);
  const eficiencia = { janelaMeses, n: pagoEf.length + late.length, pct: sum(pagoEf) + sum(late) > 0 ? pct((sum(pagoEf) / (sum(pagoEf) + sum(late))) * 100) : null };

  // ---- recorrência e cancelamentos ----
  const recorrente30 = sum(aVencer.filter(d => d.tipo === 'RECORRENTE' && R.dayDiff(d.venc, hoje) <= 30));
  const cancelado90 = { valor: sum(canc.filter(d => d.venc && d.venc >= ini90)), qtd: canc.filter(d => d.venc && d.venc >= ini90).length };
  const mediaRecebida3m = r2([0, 1, 2].reduce((x, i) => x + sum(paid.filter(d => monthKey(paidDay(d)) === shiftMonth(cur, -i - 1))), 0) / 3);
  const ticketMedio = paid.length ? r2(sum(paid) / paid.length) : 0;

  // ---- previsão ajustada pelo histórico de recebimento ----
  const taxa = eficiencia.n >= 10 && eficiencia.pct !== null ? eficiencia.pct : null;
  const previsao30 = { nominal: resumo.proximos.d30, esperado: taxa === null ? null : r2(resumo.proximos.d30 * (taxa / 100)), taxa };

  // ---- saúde financeira (nota 0–100, com as partes à mostra) ----
  const comp = [];
  if (eficiencia.pct !== null) comp.push({ id: 'eficiencia', nome: 'Eficiência de cobrança', valor: eficiencia.pct, peso: 0.35, texto: `${eficiencia.pct}% do que venceu nos últimos ${janelaMeses} meses já foi recebido (atrasos antigos contam)` });
  if (pontualidade.pct !== null) comp.push({ id: 'pontualidade', nome: 'Pontualidade', valor: pontualidade.pct, peso: 0.25, texto: `${pontualidade.pct}% dos pagamentos chegam até ${TOLERANCIA_DIAS} dias após o vencimento${pontualidade.atrasoMedio ? ` · atraso médio de ${pontualidade.atrasoMedio} dias nos demais` : ''}` });
  comp.push({ id: 'inadimplencia', nome: 'Inadimplência', valor: pct(clamp(100 - resumo.inadimplenciaPct * 2)), peso: 0.25, texto: `${resumo.inadimplenciaPct}% do a receber está em atraso` });
  if (!individual && concentracao.clientes > 1) comp.push({ id: 'concentracao', nome: 'Concentração', valor: pct(clamp(100 - Math.max(0, concentracao.top1Pct - 25) * 1.33)), peso: 0.15, texto: `Maior cliente = ${concentracao.top1Pct}% do a receber` });
  const pesoTotal = comp.reduce((x, c) => x + c.peso, 0);
  const evidencias = (eficiencia.n || 0) + (pontualidade.n || 0);
  let score = evidencias >= 3 && pesoTotal ? Math.round(comp.reduce((x, c) => x + c.valor * c.peso, 0) / pesoTotal) : null;
  // Teto: atraso grave limita a nota, para ela não ficar otimista com dívida antiga.
  const velho90 = sum(late.filter(d => atraso(d) > 90)), velho60 = sum(late.filter(d => atraso(d) > 60));
  let teto = null;
  if (score !== null) {
    if (individual ? velho90 > 0 : aReceber > 0 && velho90 / aReceber >= 0.1) teto = { max: 69, motivo: 'atraso acima de 90 dias' };
    else if (individual ? velho60 > 0 : aReceber > 0 && velho60 / aReceber >= 0.1) teto = { max: 84, motivo: 'atraso acima de 60 dias' };
    if (teto && score > teto.max) score = teto.max;   // o teto só aparece quando de fato reduziu a nota
    else teto = null;
  }
  const nivel = score === null ? 'sem-dados' : score >= 85 ? 'excelente' : score >= 70 ? 'boa' : score >= 50 ? 'atencao' : 'critica';
  const ROT = individual
    ? { excelente: 'Excelente pagador', boa: 'Bom pagador', atencao: 'Atenção', critica: 'Risco alto', 'sem-dados': 'Sem histórico suficiente' }
    : { excelente: 'Excelente', boa: 'Boa', atencao: 'Atenção', critica: 'Crítica', 'sem-dados': 'Sem histórico suficiente' };
  const confianca = evidencias >= 30 ? 'alta' : evidencias >= 10 ? 'média' : 'baixa';
  const saude = { score, nivel, rotulo: ROT[nivel], confianca, teto, componentes: comp.map(c => ({ ...c, peso: Math.round((c.peso / pesoTotal) * 100) })) };

  // ---- insights em linguagem direta ----
  const insights = [];
  if (resumo.atrasado.valor > 0) {
    const grave = aging[2].valor + aging[3].valor;
    insights.push({ tipo: 'alerta', msg: `${brl(resumo.atrasado.valor)} em atraso (${resumo.atrasado.qtd} título${resumo.atrasado.qtd > 1 ? 's' : ''})${grave > 0 ? `, sendo ${brl(grave)} há mais de 60 dias` : ''}.` });
  }
  if (eficiencia.pct !== null && eficiencia.pct < 80) insights.push({ tipo: 'alerta', msg: `Só ${eficiencia.pct}% do que venceu nos últimos ${janelaMeses} meses foi recebido (atrasos antigos contam).` });
  if (!individual && concentracao.top1Pct > 40 && concentracao.clientes > 1) insights.push({ tipo: 'alerta', msg: `${concentracao.topCliente} concentra ${concentracao.top1Pct}% do valor a receber.` });
  if (individual && pontualidade.n >= 3 && pontualidade.atrasoMedio >= 3 && pontualidade.pct !== null && pontualidade.pct < 70) insights.push({ tipo: 'alerta', msg: `Costuma pagar com atraso: ${pct(100 - pontualidade.pct)}% dos pagamentos fora do prazo, em média ${pontualidade.atrasoMedio} dia${pontualidade.atrasoMedio === 1 ? '' : 's'} depois.` });
  if (resumo.semData.qtd > 0) insights.push({ tipo: 'alerta', msg: `${resumo.semData.qtd} lançamento${resumo.semData.qtd > 1 ? 's' : ''} sem data de vencimento (${brl(resumo.semData.valor)}) — fora da previsão.` });
  if (mediaRecebida3m > 0 && resumo.proximos.d30 > 0) {
    const dif = pct(((resumo.proximos.d30 - mediaRecebida3m) / mediaRecebida3m) * 100);
    insights.push({ tipo: 'info', msg: `A previsão de 30 dias (${brl(resumo.proximos.d30)}) está ${Math.abs(dif)}% ${dif >= 0 ? 'acima' : 'abaixo'} da média mensal recebida nos últimos 3 meses (${brl(mediaRecebida3m)}).` });
  }
  if (previsao30.esperado !== null && resumo.proximos.d30 > 0) insights.push({ tipo: 'info', msg: `Pelo histórico de recebimento (${taxa}%), o esperado para os próximos 30 dias é ${brl(previsao30.esperado)}.` });
  if (cancelado90.qtd > 0) insights.push({ tipo: 'info', msg: `${cancelado90.qtd} cobrança${cancelado90.qtd > 1 ? 's' : ''} cancelada${cancelado90.qtd > 1 ? 's' : ''} nos últimos 90 dias (${brl(cancelado90.valor)}).` });
  if (!insights.some(i => i.tipo === 'alerta')) insights.unshift({ tipo: 'ok', msg: deals.length ? 'Nenhum ponto crítico agora: sem atraso relevante nem concentração de risco.' : 'Ainda não há lançamentos para analisar.' });

  // ---- próximas cobranças (a vencer) ----
  const proximas = [...aVencer].sort((a, b) => a.venc.localeCompare(b.venc) || a.id - b.id).slice(0, 6)
    .map(d => ({ id: d.id, cliente: d.cliente || '', titulo: d.titulo, valor: d.valor, venc: d.venc, dias: R.dayDiff(d.venc, hoje), link: d.link || '' }));
  const maisAntigo = late.length ? Math.max(...late.map(atraso)) : 0;
  const datas = deals.map(d => d.criado || d.venc).filter(Boolean).sort();

  return {
    hoje, meses, individual, resumo, linha, aging, devedores, concentracao, pontualidade, eficiencia, previsao30,
    recorrente30, cancelado90, mediaRecebida3m, ticketMedio, maisAntigo, saude, insights, proximas,
    primeiro: datas[0] || '', total: deals.length,
  };
}
module.exports = { dashboard };
