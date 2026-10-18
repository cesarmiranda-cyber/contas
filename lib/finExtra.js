'use strict';
// Conciliação bancária e recorrências sem fim (sem I/O). Coberto por test/finextra.test.js.
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

module.exports = { novasLinhas, sugestoes, forte, baixaPorExtrato, validarRecorrencia, gerarRecorrentes };
