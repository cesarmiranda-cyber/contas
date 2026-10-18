'use strict';
// Estoque (sem I/O): produtos, movimentos, custo médio móvel e nota de entrada. Coberto por test/estoque.test.js.
const R = require('./rules');
const F = require('./fin');

const { round2, uid, bad } = F;
const r4 = v => Math.round(v * 10000) / 10000, r3 = v => Math.round(v * 1000) / 1000;
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function validarProduto(p) {
  if (!p.empresaId) throw bad('Escolha a empresa do produto.');
  const nome = String(p.nome || '').trim(); if (nome.length < 2 || nome.length > 200) throw bad('Nome do produto: de 2 a 200 caracteres.');
  const un = String(p.un || 'UN').trim().toUpperCase().slice(0, 6) || 'UN';
  const min = Number(p.estoqueMin || 0); if (!(min >= 0) || min > 1e9) throw bad('Estoque mínimo inválido.');
  const ean = String(p.ean || '').replace(/\D/g, ''); if (ean && !/^\d{8,14}$/.test(ean)) throw bad('Código de barras (EAN) inválido.');
  return { empresaId: String(p.empresaId), codigo: String(p.codigo || '').trim().slice(0, 40), nome, un, ncm: String(p.ncm || '').replace(/\D/g, '').slice(0, 8), ean, estoqueMin: r3(min), ativo: p.ativo !== false, obs: String(p.obs || '').slice(0, 300), codigosFornecedor: Array.isArray(p.codigosFornecedor) ? p.codigosFornecedor.slice(0, 50) : [] };
}

// Reprocessa os movimentos de cada produto em ordem de data e calcula saldo e custo médio móvel.
// Saída e ajuste negativo saem pelo custo médio do momento. Devolve também o primeiro ponto com saldo negativo (se houver).
function posicao(produtos, movimentos) {
  const por = new Map();
  for (const m of movimentos) (por.get(m.produtoId) || por.set(m.produtoId, []).get(m.produtoId)).push(m);
  const out = new Map(), negativos = [];
  for (const p of produtos) {
    let saldo = 0, cm = 0, ultimaEntrada = '';
    const movs = (por.get(p.id) || []).slice().sort((a, b) => a.data.localeCompare(b.data) || (a.seq || 0) - (b.seq || 0));
    const lista = [];
    for (const m of movs) {
      const q = m.qtd;
      if (q > 0) {
        const custoUn = m.custoUnit !== undefined && m.custoUnit !== null && m.custoUnit !== '' ? Number(m.custoUnit) : cm;
        cm = saldo > 0 ? r4((saldo * cm + q * custoUn) / (saldo + q)) : custoUn;
        saldo = r3(saldo + q); if (m.tipo === 'entrada') ultimaEntrada = m.data;
        lista.push({ ...m, custoUnit: custoUn, custoTotal: round2(q * custoUn), saldoApos: saldo, custoMedioApos: cm });
      } else {
        saldo = r3(saldo + q);
        lista.push({ ...m, custoUnit: cm, custoTotal: round2(q * cm), saldoApos: saldo, custoMedioApos: cm });
        if (saldo < -0.0005) negativos.push({ produtoId: p.id, nome: p.nome, data: m.data, saldo });
      }
    }
    out.set(p.id, { saldo, custoMedio: cm, valor: round2(saldo * cm), ultimaEntrada, movimentos: lista, abaixoMinimo: p.estoqueMin > 0 && saldo < p.estoqueMin });
  }
  return { porProduto: out, negativos };
}
const comPosicao = (produtos, movimentos) => { const { porProduto } = posicao(produtos, movimentos); return produtos.map(p => { const x = porProduto.get(p.id); return { ...p, saldo: x.saldo, custoMedio: x.custoMedio, valor: x.valor, ultimaEntrada: x.ultimaEntrada, abaixoMinimo: x.abaixoMinimo }; }); };

// Movimento manual (saída, ajuste ou entrada avulsa). Bloqueia se deixar o saldo negativo em algum ponto do tempo.
function validarMovimento(p, produtos, movimentos, hoje = R.todayBR()) {
  const prod = produtos.find(x => x.id === p.produtoId); if (!prod) throw bad('Escolha o produto.');
  if (!['entrada', 'saida', 'ajuste'].includes(p.tipo)) throw bad('Tipo de movimento inválido.');
  let q = Number(p.qtd); if (!(Math.abs(q) > 0) || Math.abs(q) > 1e9) throw bad('Informe a quantidade.');
  q = p.tipo === 'saida' ? -Math.abs(q) : p.tipo === 'entrada' ? Math.abs(q) : q;   // ajuste aceita sinal
  const data = p.data || hoje; if (!F.isDay(data) || data > hoje) throw bad('Data inválida: não pode ser futura.');
  const mov = { id: uid('mv'), empresaId: prod.empresaId, produtoId: prod.id, data, tipo: p.tipo, qtd: r3(q), obs: String(p.obs || '').slice(0, 200), origem: 'manual', seq: Date.now() };
  if (q > 0 && p.custoUnit !== undefined && p.custoUnit !== '') { const c = Number(p.custoUnit); if (!(c >= 0)) throw bad('Custo unitário inválido.'); mov.custoUnit = r4(c); }
  if (q > 0 && mov.custoUnit === undefined && p.tipo === 'entrada') throw bad('Informe o custo unitário da entrada.');
  const { negativos } = posicao([prod], [...movimentos.filter(m => m.produtoId === prod.id), mov]);
  if (negativos.length) throw bad(`Saldo insuficiente de "${prod.nome}": faltam ${Math.abs(negativos[0].saldo).toLocaleString('pt-BR')} ${prod.un} em ${negativos[0].data.split('-').reverse().join('/')}.`);
  return mov;
}

// Sugere o produto cadastrado de cada item da nota: 1) vínculo código do fornecedor, 2) EAN, 3) mesmo nome.
function sugerirProdutos(nota, produtos, empresaId) {
  const doc = nota.fornecedor.doc, meus = produtos.filter(p => p.empresaId === empresaId && p.ativo);
  return nota.itens.map(i => {
    const v = meus.find(p => (p.codigosFornecedor || []).some(c => c.doc === doc && c.cProd === i.cProd));
    if (v) return { n: i.n, produtoId: v.id, como: 'vinculo' };
    const e = i.ean && meus.find(p => p.ean === i.ean); if (e) return { n: i.n, produtoId: e.id, como: 'ean' };
    const n = meus.find(p => norm(p.nome) === norm(i.descricao)); if (n) return { n: i.n, produtoId: n.id, como: 'nome' };
    return { n: i.n, produtoId: '', como: 'novo' };
  });
}

// Monta a nota de entrada, os produtos novos e os movimentos de estoque a partir da nota lida e da escolha do usuário.
// escolhas: [{ n, produtoId | 'novo', nome?, codigo?, un?, estoque: bool }]
function montarEntrada({ nota, empresaId, entradaEm, escolhas, produtos, darEntrada = true, hoje = R.todayBR() }) {
  if (!F.isDay(entradaEm)) throw bad('Informe a data de entrada.');
  if (entradaEm > hoje) throw bad('A data de entrada não pode ser futura.');
  const novos = [], movs = [], itens = [];
  for (const i of nota.itens) {
    const e = escolhas.find(x => Number(x.n) === i.n) || {};
    const estoque = darEntrada && e.estoque !== false;
    let produtoId = '';
    if (estoque) {
      if (e.produtoId && e.produtoId !== 'novo') { const p = produtos.find(x => x.id === e.produtoId && x.empresaId === empresaId); if (!p) throw bad(`Item ${i.n}: produto escolhido não encontrado.`); produtoId = p.id; }
      else {
        const v = validarProduto({ empresaId, nome: e.nome || i.descricao, codigo: e.codigo || i.cProd, un: e.un || i.un, ncm: i.ncm, ean: i.ean });
        const p = { id: uid('pr'), ...v, codigosFornecedor: [{ doc: nota.fornecedor.doc, cProd: i.cProd }] }; novos.push(p); produtoId = p.id;
      }
    }
    itens.push({ ...i, produtoId, estoque });
    if (produtoId) movs.push({ id: uid('mv'), empresaId, produtoId, data: entradaEm, tipo: 'entrada', qtd: r3(i.qtd), custoUnit: i.custoUnit, obs: `NF-e ${nota.numero} — ${nota.fornecedor.nome}`.slice(0, 200), origem: 'nota', seq: Date.now() + movs.length });
  }
  return { novos, movs, itens };
}
// Vincula (ou atualiza) o código do fornecedor ao produto escolhido
const vincular = (p, doc, cProd) => (cProd && !(p.codigosFornecedor || []).some(c => c.doc === doc && c.cProd === cProd) ? { ...p, codigosFornecedor: [...(p.codigosFornecedor || []), { doc, cProd }].slice(-50) } : null);

// A nota só pode ser cancelada se nenhum título foi pago e o estoque não ficar negativo sem as entradas dela.
function checarCancelamento(nota, titulos, produtos, movimentos) {
  if (nota.status === 'cancelada') throw bad('A nota já está cancelada.');
  if (titulos.some(t => t.status === 'paga')) throw bad('Há título desta nota já pago. Desfaça o pagamento antes de cancelar a nota.');
  const restantes = movimentos.filter(m => m.notaId !== nota.id);
  const { negativos } = posicao(produtos.filter(p => movimentos.some(m => m.notaId === nota.id && m.produtoId === p.id)), restantes);
  if (negativos.length) throw bad(`Não dá para cancelar: parte do estoque desta nota já foi consumida (${negativos[0].nome} ficaria com saldo negativo). Registre o ajuste ou a devolução antes.`);
}

module.exports = { validarProduto, posicao, comPosicao, validarMovimento, sugerirProdutos, montarEntrada, vincular, checarCancelamento, norm };
