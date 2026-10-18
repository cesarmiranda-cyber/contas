'use strict';
// Conciliação bancária, recorrências sem fim e orçamento por categoria (sem I/O). Coberto por test/finextra.test.js.
const R = require('./rules');
const F = require('./fin');
const C = require('./finCad');

const { round2, uid, bad } = F;
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = t => norm(t).split(/[^a-z0-9]+/).filter(x => x.length >= 4);

// ---------- conciliação bancária ----------
// Linhas do extrato importado: { id, contaId, fitid, data, valor (+ entrada, − saída), descricao, status, ref }
function novasLinhas(parsed, contaId, existentes, hoje = R.todayBR()) {
  const chave = l => `${l.contaId}|${l.fitid || `${l.data}|${l.valor}|${l.descricao}`}`;
  const vistas = new Set(existentes.map(chave));
  const novas = [];
  for (const l of parsed.linhas) {
    const x = { id: uid('ex'), contaId, fitid: l.fitid, data: l.data, valor: l.valor, descricao: l.descricao, doc: l.doc, status: 'pendente', ref: null, importado: hoje };
    if (vistas.has(chave(x))) continue;
    vistas.add(chave(x)); novas.push(x);
  }
  return { novas, repetidas: parsed.linhas.length - novas.length };
}

// Lançamentos em aberto que podem ser a origem desta linha do extrato (mesma empresa, mesmo sentido), do mais provável ao menos.
function sugestoes(linha, conta, { pagar = [], receber = [] }, max = 3) {
  const entrada = linha.valor > 0, abs = round2(Math.abs(linha.valor));
  const base = (entrada ? receber.filter(r => r.status === 'aberto' && r.origem === 'manual') : pagar.filter(c => c.status === 'aberta')).filter(x => x.empresaId === conta.empresaId);
  const toks = tokens(linha.descricao);
  return base.map(x => {
    const valores = [x.valor, ...(x.valorLiquido !== undefined && x.valorLiquido !== x.valor ? [x.valorLiquido] : [])];
    const exato = valores.some(v => Math.abs(v - abs) < 0.005), proximo = !exato && Math.abs(x.valor - abs) <= x.valor * 0.02;
    if (!exato && !proximo) return null;
    const d = Math.abs(R.dayDiff(linha.data, x.venc));
    const alvo = tokens([x.descricao, x.cliente, x.fornecedor].join(' '));
    const nome = toks.some(t => alvo.includes(t));
    const score = (exato ? 60 : 30) + (d <= 3 ? 30 : d <= 7 ? 20 : d <= 15 ? 8 : 0) + (nome ? 10 : 0);
    return { id: x.id, tipo: entrada ? 'receber' : 'pagar', descricao: x.descricao, parcela: x.parcela, contra: x.cliente || x.fornecedor || '', venc: x.venc, valor: x.valor, exato, score, diasDiferenca: d };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.diasDiferenca - b.diasDiferenca).slice(0, max);
}
const forte = s => s.exato && s.score >= 80;   // valor exato e data até 3 dias (com nome, 90)

// Parâmetros da baixa que fazem o lançamento fechar com o valor que o banco registrou:
// maior que o valor = juros; igual ao líquido do cartão = desconto da taxa; menor = baixa parcial (ou desconto, se pedido).
function baixaPorExtrato(lanc, linha, { modo = 'parcial' } = {}) {
  const abs = round2(Math.abs(linha.valor));
  const p = { data: linha.data, contaId: linha.contaId, obs: `Conciliado com o extrato: ${linha.descricao}`.slice(0, 300) };
  if (abs >= lanc.valor - 0.005) return { ...p, valor: lanc.valor, juros: round2(Math.max(0, abs - lanc.valor)) };
  if (lanc.valorLiquido !== undefined && Math.abs(lanc.valorLiquido - abs) < 0.005) return { ...p, valor: lanc.valor, desconto: round2(lanc.valor - abs) };
  return modo === 'desconto' ? { ...p, valor: lanc.valor, desconto: round2(lanc.valor - abs) } : { ...p, valor: abs };
}

// ---------- recorrências (contas fixas sem data final) ----------
// rec: { id, tipo, empresaId, modelo:{descricao,valor,categoria,...}, inicio (1º vencimento), fim ('' = sem fim), ativa, util }
function validarRecorrencia(p, hoje = R.todayBR()) {
  if (!['pagar', 'receber'].includes(p.tipo)) throw bad('Escolha pagar ou receber.');
  if (!p.empresaId) throw bad('Escolha a empresa.');
  if (!F.isDay(p.inicio)) throw bad('Informe o primeiro vencimento.');
  if (p.fim && (!F.isDay(p.fim) || p.fim < p.inicio)) throw bad('A data final precisa ser depois do primeiro vencimento.');
  const m = p.modelo || {};
  if (String(m.descricao || '').trim().length < 2) throw bad('O título precisa ter de 2 a 200 caracteres.');
  if (!(Number(m.valor) > 0)) throw bad('Valor: informe um valor maior que zero.');
  return { tipo: p.tipo, empresaId: String(p.empresaId), inicio: p.inicio, fim: p.fim || '', util: !!p.util, ativa: p.ativa !== false, modelo: { ...m, descricao: String(m.descricao).trim(), valor: round2(m.valor) }, criado: p.criado || hoje };
}
// Lançamentos que faltam até `horizonte` meses à frente (idempotente: usa recId + competência).
function gerarRecorrentes({ recorrencias, existentes, hoje = R.todayBR(), horizonte = 3, ctx = {} }) {
  const limite = R.addMonths(hoje, horizonte), tem = new Set(existentes.filter(x => x.recId).map(x => `${x.recId}|${x.recCompetencia}`));
  const out = [];
  for (const r of recorrencias.filter(x => x.ativa)) {
    for (let k = 0, n = 0; k < 600 && n < 36; k++) {
      let venc = R.addMonths(r.inicio, k);
      if (venc > limite || (r.fim && venc > r.fim)) break;
      const comp = venc.slice(0, 7);
      if (tem.has(`${r.id}|${comp}`)) continue;
      if (r.util) venc = C.proximoUtil(venc);
      const l = C.criarLancamentos({ ...r.modelo, empresaId: r.empresaId, venc, parcelas: 1, modo: 'parcelado' }, r.tipo, { ...ctx, hoje })[0];
      out.push({ ...l, recId: r.id, recCompetencia: comp }); n++;
    }
  }
  return out;
}

// ---------- orçamento por categoria ----------
// orcamentos: [{ id, empresaId, categoria, tipo, valor, mes }]  (mes '' = valor padrão de todos os meses; mês preenchido = exceção)
function validarOrcamento(p, empresas) {
  if (!empresas.some(e => e.id === p.empresaId)) throw bad('Escolha a empresa do orçamento.');
  if (!['receita', 'despesa'].includes(p.tipo)) throw bad('Escolha receita ou despesa.');
  const categoria = String(p.categoria || '').trim(); if (!categoria) throw bad('Escolha a categoria.');
  const valor = Number(p.valor); if (!(valor >= 0) || valor > 1e9) throw bad('Valor do orçamento inválido.');
  if (p.mes && !F.isCompetencia(p.mes)) throw bad('Mês inválido (AAAA-MM).');
  return { empresaId: p.empresaId, categoria, tipo: p.tipo, valor: round2(valor), mes: p.mes || '' };
}
function orcamentoMes({ orcamentos = [], receber = [], pagar = [], empresaId = '', mes, hoje = R.todayBR() }) {
  const orc = new Map();   // `${tipo}|${categoria}` -> valor orçado no mês
  const por = new Map();
  for (const o of orcamentos.filter(x => !empresaId || x.empresaId === empresaId)) {
    const k = `${o.tipo}|${o.empresaId}|${o.categoria}`; por.set(k, [...(por.get(k) || []), o]);
  }
  for (const [k, l] of por) {
    const v = (l.find(o => o.mes === mes) || l.find(o => !o.mes) || { valor: 0 }).valor, [tipo, , categoria] = k.split('|'), kk = `${tipo}|${categoria}`;
    orc.set(kk, round2((orc.get(kk) || 0) + v));
  }
  const rec = F.pick(receber, empresaId).filter(r => r.status !== 'cancelado'), pag = F.pick(pagar, empresaId).filter(c => c.status !== 'cancelada');
  const linhas = new Map();
  const linha = (tipo, categoria) => { const k = `${tipo}|${categoria}`; if (!linhas.has(k)) linhas.set(k, { tipo, categoria, orcado: orc.get(k) || 0, previsto: 0, realizado: 0 }); return linhas.get(k); };
  for (const k of orc.keys()) { const [t, c] = k.split('|'); linha(t, c); }
  for (const r of rec) { const cat = r.categoria || (r.origem === 'bitrix' ? 'Cobranças do Bitrix / Asaas' : 'Sem categoria'), l = linha('receita', cat); if ((r.venc || '').startsWith(mes)) l.previsto += r.valor; if (r.status === 'pago' && (r.pagoEm || '').startsWith(mes)) l.realizado += r.valorPago || r.valor; }
  for (const c of pag) { const l = linha('despesa', c.categoria || 'Sem categoria'); if ((c.venc || '').startsWith(mes)) l.previsto += c.valor; if (c.status === 'paga' && (c.pagoEm || '').startsWith(mes)) l.realizado += c.valorPago || c.valor; }
  const out = [...linhas.values()].map(l => {
    const previsto = round2(l.previsto), realizado = round2(l.realizado), pct = l.orcado > 0 ? Math.round(previsto / l.orcado * 1000) / 10 : null;
    // despesa: passar do orçado é ruim; receita: ficar abaixo da meta é ruim
    const status = pct === null ? 'sem_meta' : l.tipo === 'despesa' ? (pct > 100 ? 'estourado' : pct >= 85 ? 'alerta' : 'ok') : (pct >= 100 ? 'ok' : pct >= 70 ? 'alerta' : 'abaixo');
    return { ...l, previsto, realizado, pct, status, desvio: round2(previsto - l.orcado) };
  }).filter(l => l.orcado || l.previsto || l.realizado).sort((a, b) => (a.tipo === b.tipo ? b.previsto - a.previsto : a.tipo === 'receita' ? -1 : 1));
  const tot = tipo => { const l = out.filter(x => x.tipo === tipo); return { orcado: round2(l.reduce((a, x) => a + x.orcado, 0)), previsto: round2(l.reduce((a, x) => a + x.previsto, 0)), realizado: round2(l.reduce((a, x) => a + x.realizado, 0)) }; };
  return { mes, linhas: out, receitas: tot('receita'), despesas: tot('despesa') };
}

module.exports = { novasLinhas, sugestoes, forte, baixaPorExtrato, validarRecorrencia, gerarRecorrentes, validarOrcamento, orcamentoMes };
