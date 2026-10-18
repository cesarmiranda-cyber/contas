'use strict';
// Cadastros e lançamentos do financeiro (sem I/O): contas bancárias, formas e condições de pagamento,
// categorias, centros de custo, fornecedores, vencimentos automáticos, parcelas, baixa com juros/multa/desconto,
// saldos por conta, extrato e DRE. Cobertas por test/fincad.test.js.
const R = require('./rules');
const F = require('./fin');

const { round2, uid, bad, isDay } = F;
const BANCOS = [['001', 'Banco do Brasil'], ['033', 'Santander'], ['077', 'Inter'], ['104', 'Caixa Econômica'], ['208', 'BTG Pactual'], ['212', 'Banco Original'], ['237', 'Bradesco'], ['260', 'Nubank'], ['290', 'PagBank'], ['336', 'C6 Bank'], ['341', 'Itaú'], ['380', 'PicPay'], ['403', 'Cora'], ['461', 'Asaas'], ['748', 'Sicredi'], ['756', 'Sicoob'], ['000', 'Outro / caixa interno']];
const TIPOS_CONTA = ['corrente', 'poupanca', 'caixa', 'cartao', 'asaas', 'investimento'];
const TIPOS_FORMA = ['PIX', 'BOLETO', 'CARTAO', 'TRANSFERENCIA', 'DINHEIRO'];

// ---------- padrões criados no primeiro uso (tudo editável na tela de Configurações) ----------
const defaults = () => ({
  formas: [
    { id: 'fp_pix', nome: 'Pix', tipo: 'PIX', prazoDias: 0, diasUteis: false, taxaPct: 0, taxaFixa: 0, maxParcelas: 1, ativa: true },
    { id: 'fp_boleto', nome: 'Boleto bancário', tipo: 'BOLETO', prazoDias: 1, diasUteis: true, taxaPct: 0, taxaFixa: 0, maxParcelas: 12, ativa: true },
    { id: 'fp_cartao', nome: 'Cartão de crédito', tipo: 'CARTAO', prazoDias: 30, diasUteis: false, taxaPct: 3.5, taxaFixa: 0, maxParcelas: 12, ativa: true },
    { id: 'fp_transf', nome: 'Transferência (TED/DOC)', tipo: 'TRANSFERENCIA', prazoDias: 0, diasUteis: false, taxaPct: 0, taxaFixa: 0, maxParcelas: 1, ativa: true },
    { id: 'fp_dinheiro', nome: 'Dinheiro', tipo: 'DINHEIRO', prazoDias: 0, diasUteis: false, taxaPct: 0, taxaFixa: 0, maxParcelas: 1, ativa: true },
  ],
  condicoes: [
    { id: 'cp_vista', nome: 'À vista', dias: [0], ativa: true },
    { id: 'cp_7', nome: '7 dias', dias: [7], ativa: true },
    { id: 'cp_15', nome: '15 dias', dias: [15], ativa: true },
    { id: 'cp_30', nome: '30 dias', dias: [30], ativa: true },
    { id: 'cp_30_60', nome: '30/60 dias', dias: [30, 60], ativa: true },
    { id: 'cp_30_60_90', nome: '30/60/90 dias', dias: [30, 60, 90], ativa: true },
    { id: 'cp_ent_30', nome: 'Entrada + 30 dias', dias: [0, 30], ativa: true },
    { id: 'cp_3x', nome: '3x mensal', dias: [30, 60, 90], ativa: true },
    { id: 'cp_6x', nome: '6x mensal', dias: [30, 60, 90, 120, 150, 180], ativa: true },
    { id: 'cp_12x', nome: '12x mensal', dias: Array.from({ length: 12 }, (_, i) => 30 * (i + 1)), ativa: true },
  ],
  categorias: [
    ...['Vendas e serviços', 'Contratos recorrentes', 'Licenças e aplicativos', 'Receitas financeiras', 'Outras receitas'].map((nome, i) => ({ id: `cat_r${i}`, tipo: 'receita', nome, ativa: true })),
    ...F.CATEGORIAS_DESPESA.map((nome, i) => ({ id: `cat_d${i}`, tipo: 'despesa', nome, ativa: true })),
  ],
});

// ---------- datas e vencimentos automáticos ----------
const addDias = (dia, n) => new Date(Date.parse(dia + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dow = dia => new Date(dia + 'T00:00:00Z').getUTCDay();   // 0 = domingo
// fim de semana vira segunda-feira (feriados não entram: o app não tem calendário de feriados)
const proximoUtil = dia => { const d = dow(dia); return d === 6 ? addDias(dia, 2) : d === 0 ? addDias(dia, 1) : dia; };
// n dias úteis a partir de uma data (segunda a sexta)
const somaUteis = (dia, n) => { let d = dia, left = n; while (left > 0) { d = addDias(d, 1); if (dow(d) !== 0 && dow(d) !== 6) left--; } return d; };
// previsão de crédito/pagamento de uma forma (ex.: cartão D+30, boleto D+1 útil)
const creditoEm = (venc, forma) => (!forma || !forma.prazoDias ? venc : forma.diasUteis ? somaUteis(venc, forma.prazoDias) : addDias(venc, forma.prazoDias));
const taxaForma = (valor, forma) => (forma ? round2(valor * (Number(forma.taxaPct) || 0) / 100 + (Number(forma.taxaFixa) || 0)) : 0);

// Parcelas planejadas. Entradas:
//  manual: [{venc, valor, descricao?, obs?}]  → usada como veio (parcelado: a soma tem que fechar o total)
//  dias: [0,30,60] + base (data de referência) → vencimentos automáticos, `util` empurra fim de semana para segunda
//  senão: parcelas (n) mensais a partir de venc
//  modo 'recorrente': cada parcela tem o valor cheio; 'parcelado' (padrão): o total é dividido sem perder centavos
function planejarParcelas({ total, modo = 'parcelado', parcelas, dias, base, venc, util = false, manual }) {
  const t = Number(total);
  if (!(t > 0) || t > 1e9) throw bad('Valor: informe um valor maior que zero.');
  const recorrente = modo === 'recorrente';
  if (Array.isArray(manual) && manual.length) {
    if (manual.length > 120) throw bad('No máximo 120 parcelas.');
    const l = manual.map((m, i) => {
      if (!isDay(m.venc)) throw bad(`Parcela ${i + 1}: vencimento inválido.`);
      const v = Number(m.valor); if (!(v > 0)) throw bad(`Parcela ${i + 1}: valor inválido.`);
      return { n: i + 1, of: manual.length, venc: m.venc, valor: round2(v), descricao: String(m.descricao || '').slice(0, 200), obs: String(m.obs || '').slice(0, 500) };
    });
    const soma = round2(l.reduce((a, p) => a + p.valor, 0));
    if (!recorrente && Math.abs(soma - round2(t)) > 0.009) throw bad(`A soma das parcelas (R$ ${soma.toFixed(2)}) precisa ser igual ao valor total (R$ ${round2(t).toFixed(2)}).`);
    return l;
  }
  let datas;
  if (Array.isArray(dias) && dias.length) {
    const ref = base || venc; if (!isDay(ref)) throw bad('Data base inválida.');
    datas = dias.map(d => addDias(ref, Math.max(0, Math.floor(Number(d) || 0))));
  } else {
    if (!isDay(venc)) throw bad('Vencimento inválido (AAAA-MM-DD).');
    const n = Math.max(1, Math.min(120, Math.floor(Number(parcelas) || 1)));
    datas = Array.from({ length: n }, (_, i) => R.addMonths(venc, i));
  }
  if (datas.length > 120) throw bad('No máximo 120 parcelas.');
  if (util) datas = datas.map(proximoUtil);
  const cents = Math.round(t * 100), n = datas.length;
  const partes = recorrente ? datas.map(() => cents) : (() => { const b = Math.floor(cents / n), r = cents - b * n; return datas.map((_, i) => b + (i < r ? 1 : 0)); })();
  return datas.map((d, i) => ({ n: i + 1, of: n, venc: d, valor: partes[i] / 100, descricao: '', obs: '' }));
}

// ---------- lançamentos (contas a pagar e a receber manuais) ----------
// tipo 'pagar' | 'receber'. ctx: { formas, hoje }
function criarLancamentos(p, tipo, ctx = {}) {
  const hoje = ctx.hoje || R.todayBR(), pagar = tipo === 'pagar';
  if (!p.empresaId) throw bad('Escolha a empresa.');
  const titulo = String(p.descricao || '').trim();
  if (titulo.length < 2 || titulo.length > 200) throw bad('O título precisa ter de 2 a 200 caracteres.');
  const forma = (ctx.formas || []).find(f => f.id === p.formaId) || null;
  const codForma = forma ? forma.tipo : (F.FORMAS_PAG.includes(p.forma) ? p.forma : (pagar ? 'BOLETO' : ''));
  const cond = (ctx.condicoes || []).find(c => c.id === p.condicaoId);
  const plano = planejarParcelas({ ...p, total: p.valor, dias: cond ? cond.dias : p.dias, base: p.base || p.venc || hoje });
  const grupo = plano.length > 1 ? uid('grp') : '';
  const contra = String((pagar ? p.fornecedor : p.cliente) || '').trim().slice(0, 120);
  return plano.map(s => {
    const taxa = pagar ? 0 : taxaForma(s.valor, forma);
    return {
      id: uid(pagar ? 'cp' : 'rc'), tipo, empresaId: String(p.empresaId), descricao: titulo, obs: String(p.obs || '').slice(0, 500),
      parcelaTitulo: s.descricao, parcelaObs: s.obs,
      valor: s.valor, venc: s.venc, parcela: plano.length > 1 ? `${s.n}/${s.of}` : '', grupo, modo: p.modo === 'recorrente' ? 'recorrente' : 'parcelado',
      forma: codForma, formaId: forma ? forma.id : '', contaId: String(p.contaId || ''), centro: String(p.centro || '').slice(0, 60),
      categoria: String(p.categoria || (pagar ? 'Outros' : '')).slice(0, 60), contatoId: String(p.contatoId || ''),
      ...(pagar ? { fornecedor: contra, codigoBarras: String(p.codigoBarras || '').slice(0, 120), chavePix: String(p.chavePix || '').slice(0, 120) }
        : { cliente: contra, clienteTipo: ['company', 'contact'].includes(p.clienteTipo) ? p.clienteTipo : '', clienteId: /^\d+$/.test(String(p.clienteId || '')) ? String(p.clienteId) : '', origem: 'manual', taxa, valorLiquido: round2(s.valor - taxa), credito: creditoEm(s.venc, forma) }),
      ...(pagar ? { origem: p.origem || 'manual', folhaKey: '' } : {}),
      status: pagar ? 'aberta' : 'aberto', pagoEm: '', valorPago: 0, criado: hoje,
    };
  });
}

// Baixa com juros, multa e desconto. Pagamento menor que o valor gera um novo lançamento com o saldo restante.
function baixarLancamento(c, p = {}, hoje = R.todayBR()) {
  const pagar = c.id.startsWith('cp_');
  if (c.status === 'cancelada' || c.status === 'cancelado') throw bad('Lançamento cancelado.');
  if (c.status === 'paga' || c.status === 'pago') throw bad('Lançamento já baixado.');
  const dia = p.data || hoje;
  if (!isDay(dia) || dia > hoje) throw bad('Data inválida: não pode ser futura.');
  const nz = (v, n) => { const x = Number(v || 0); if (!(x >= 0) || x > 1e9) throw bad(`${n} inválido.`); return round2(x); };
  const principal = p.valor === undefined || p.valor === '' || p.valor === null ? c.valor : nz(p.valor, 'Valor');
  if (!(principal > 0)) throw bad('Informe o valor a baixar.');
  if (principal > c.valor + 0.005) throw bad(`O valor a baixar não pode passar de ${F.brl(c.valor)}. Use juros ou multa para o acréscimo.`);
  const juros = nz(p.juros, 'Juros'), multa = nz(p.multa, 'Multa'), desconto = nz(p.desconto, 'Desconto');
  const total = round2(principal + juros + multa - desconto);
  if (!(total >= 0)) throw bad('O desconto não pode ser maior que o valor.');
  const forma = F.FORMAS_PAG.includes(p.forma) ? p.forma : c.forma;
  const parcial = principal < c.valor - 0.005;
  const pago = { ...c, valor: principal, status: pagar ? 'paga' : 'pago', pagoEm: dia, valorPago: total, juros, multa, desconto, forma, formaId: p.formaId || c.formaId || '', contaId: p.contaId !== undefined ? String(p.contaId) : (c.contaId || ''), obsBaixa: String(p.obs || '').slice(0, 300) };
  if (!pagar) { pago.taxa = round2((c.taxa || 0) * (principal / c.valor)); pago.valorLiquido = round2(total - pago.taxa); }
  const saldo = parcial ? { ...c, id: uid(pagar ? 'cp' : 'rc'), valor: round2(c.valor - principal), parcela: c.parcela ? `${c.parcela} (saldo)` : '(saldo)', saldoDe: c.id } : null;
  if (saldo && !pagar) { saldo.taxa = round2((c.taxa || 0) - pago.taxa); saldo.valorLiquido = round2(saldo.valor - saldo.taxa); }
  return { pago, saldo };
}

// ---------- validação dos cadastros ----------
const txt = (v, n, max = 80) => { const s = String(v ?? '').trim(); if (s.length < 2 || s.length > max) throw bad(`${n}: de 2 a ${max} caracteres.`); return s; };
const num = (v, n, { min = 0, max = 1e9 } = {}) => { const x = Number(v === '' || v == null ? 0 : v); if (!(x >= min) || x > max) throw bad(`${n} inválido.`); return round2(x); };
const VALID = {
  contas(p) {
    if (!p.empresaId) throw bad('Escolha a empresa da conta.');
    const tipo = TIPOS_CONTA.includes(p.tipo) ? p.tipo : 'corrente';
    const banco = BANCOS.find(b => b[0] === p.banco);
    return { empresaId: String(p.empresaId), nome: txt(p.nome, 'Nome da conta'), tipo, banco: banco ? banco[0] : '', bancoNome: banco ? banco[1] : '', agencia: String(p.agencia || '').replace(/[^\dxX-]/g, '').slice(0, 12), numero: String(p.numero || '').replace(/[^\dxX-]/g, '').slice(0, 20),
      saldoInicial: num(p.saldoInicial, 'Saldo inicial', { min: -1e9 }), dataSaldo: isDay(p.dataSaldo) ? p.dataSaldo : R.todayBR(), padrao: !!p.padrao, ativa: p.ativa !== false, obs: String(p.obs || '').slice(0, 300) };
  },
  formas(p) {
    return { nome: txt(p.nome, 'Nome da forma'), tipo: TIPOS_FORMA.includes(p.tipo) ? p.tipo : 'BOLETO', prazoDias: Math.floor(num(p.prazoDias, 'Prazo de recebimento', { max: 365 })), diasUteis: !!p.diasUteis,
      taxaPct: num(p.taxaPct, 'Taxa (%)', { max: 100 }), taxaFixa: num(p.taxaFixa, 'Taxa fixa'), maxParcelas: Math.max(1, Math.min(24, Math.floor(Number(p.maxParcelas) || 1))), contaId: String(p.contaId || ''), ativa: p.ativa !== false };
  },
  condicoes(p) {
    const dias = (Array.isArray(p.dias) ? p.dias : String(p.dias || '').split(/[\s,;/]+/)).filter(x => x !== '').map(Number);
    if (!dias.length || dias.length > 60 || dias.some(d => !Number.isInteger(d) || d < 0 || d > 1825)) throw bad('Informe os prazos em dias, separados por vírgula (ex.: 30, 60, 90).');
    if (dias.some((d, i) => i && d < dias[i - 1])) throw bad('Os prazos precisam estar em ordem crescente.');
    return { nome: txt(p.nome, 'Nome da condição'), dias, ativa: p.ativa !== false };
  },
  categorias(p) { if (!['receita', 'despesa'].includes(p.tipo)) throw bad('Escolha receita ou despesa.'); return { tipo: p.tipo, nome: txt(p.nome, 'Nome da categoria', 60), ativa: p.ativa !== false }; },
  centros(p) { return { nome: txt(p.nome, 'Nome do centro de custo', 60), ativa: p.ativa !== false }; },
  fornecedores(p) {
    const doc = R.digits(p.doc); if (doc && !R.validDoc(doc)) throw bad('CPF/CNPJ inválido.');
    return { nome: txt(p.nome, 'Nome', 120), doc, email: String(p.email || '').trim().slice(0, 120), telefone: String(p.telefone || '').slice(0, 30), chavePix: String(p.chavePix || '').slice(0, 120), obs: String(p.obs || '').slice(0, 300), ativa: p.ativa !== false };
  },
};
// quantos lançamentos usam este cadastro (impede apagar; nesse caso só inativa)
function usos(tabela, item, { pagar = [], receber = [], contas = [] } = {}) {
  const l = [...pagar, ...receber];
  switch (tabela) {
    case 'contas': return l.filter(x => x.contaId === item.id).length;
    case 'formas': return l.filter(x => x.formaId === item.id).length + contas.filter(c => c.padraoForma === item.id).length;
    case 'categorias': return l.filter(x => x.categoria === item.nome).length;
    case 'centros': return l.filter(x => x.centro === item.nome).length;
    case 'fornecedores': return l.filter(x => x.contatoId === item.id).length;
    default: return 0;
  }
}

// ---------- saldos, extrato e DRE ----------
// Movimentos reais de uma conta: baixas (entrada/saída) e transferências. Só entra o que tem a conta informada.
function movimentos(conta, { pagar = [], receber = [], transferencias = [] }) {
  const m = [];
  for (const r of receber) if (r.contaId === conta.id && r.status === 'pago') m.push({ data: r.pagoEm, tipo: 'entrada', descricao: r.descricao + (r.parcela ? ` (${r.parcela})` : ''), contra: r.cliente || '', valor: r.valorPago || r.valor, ref: r.id });
  for (const c of pagar) if (c.contaId === conta.id && c.status === 'paga') m.push({ data: c.pagoEm, tipo: 'saida', descricao: c.descricao + (c.parcela ? ` (${c.parcela})` : ''), contra: c.fornecedor || '', valor: -(c.valorPago || c.valor), ref: c.id });
  for (const t of transferencias) {
    if (t.de === conta.id) m.push({ data: t.data, tipo: 'transferencia', descricao: `Transferência enviada${t.obs ? ' · ' + t.obs : ''}`, contra: '', valor: -t.valor, ref: t.id });
    if (t.para === conta.id) m.push({ data: t.data, tipo: 'transferencia', descricao: `Transferência recebida${t.obs ? ' · ' + t.obs : ''}`, contra: '', valor: t.valor, ref: t.id });
  }
  return m.filter(x => x.data >= conta.dataSaldo).sort((a, b) => a.data.localeCompare(b.data));
}
// saldo da conta ao fim do dia `ate` (inclusive); sem `ate` = saldo atual
function saldoConta(conta, dados, ate = '9999-12-31') {
  return round2(conta.saldoInicial + movimentos(conta, dados).filter(x => x.data <= ate).reduce((a, x) => a + x.valor, 0));
}
const saldoAntes = (conta, dados, dia) => round2(conta.saldoInicial + movimentos(conta, dados).filter(x => x.data < dia).reduce((a, x) => a + x.valor, 0));
function extrato(conta, dados, { de = '', ate = '' } = {}) {
  let saldo = conta.saldoInicial; const out = [];
  for (const m of movimentos(conta, dados)) { saldo = round2(saldo + m.valor); if ((!de || m.data >= de) && (!ate || m.data <= ate)) out.push({ ...m, saldo }); }
  return { conta: conta.nome, saldoInicial: conta.saldoInicial, saldoFinal: saldo, linhas: out };
}
function validarTransferencia(p, contas, hoje = R.todayBR()) {
  const de = contas.find(c => c.id === p.de), para = contas.find(c => c.id === p.para);
  if (!de || !para) throw bad('Escolha as contas de origem e de destino.');
  if (de.id === para.id) throw bad('Origem e destino precisam ser contas diferentes.');
  const valor = num(p.valor, 'Valor'); if (!(valor > 0)) throw bad('Informe o valor da transferência.');
  const data = p.data || hoje; if (!isDay(data) || data > hoje) throw bad('Data inválida: não pode ser futura.');
  if (data < de.dataSaldo || data < para.dataSaldo) throw bad('A data é anterior ao saldo inicial de uma das contas.');
  return { de: de.id, para: para.id, valor, data, obs: String(p.obs || '').slice(0, 200) };
}

// DRE simples. regime 'caixa' = por data de pagamento (só o que foi pago); 'competencia' = por vencimento (pago ou não, sem cancelados).
function dre({ receber = [], pagar = [], empresaId = '', de = '', ate = '', regime = 'caixa' }) {
  const dentro = d => d && (!de || d >= de) && (!ate || d <= ate);
  const rec = F.pick(receber, empresaId).filter(r => r.status !== 'cancelado'), pag = F.pick(pagar, empresaId).filter(c => c.status !== 'cancelada');
  const caixa = regime === 'caixa';
  const rx = rec.filter(r => (caixa ? r.status === 'pago' && dentro(r.pagoEm) : dentro(r.venc)));
  const px = pag.filter(c => (caixa ? c.status === 'paga' && dentro(c.pagoEm) : dentro(c.venc)));
  const soma = (l, key, val) => { const m = new Map(); for (const x of l) m.set(key(x), round2((m.get(key(x)) || 0) + val(x))); return [...m].map(([categoria, valor]) => ({ categoria, valor })).sort((a, b) => b.valor - a.valor); };
  const receitas = soma(rx, r => r.categoria || (r.origem === 'bitrix' ? 'Cobranças do Bitrix / Asaas' : 'Sem categoria'), r => (caixa ? r.valorPago || r.valor : r.valor));
  const despesas = soma(px, c => c.categoria || 'Sem categoria', c => (caixa ? c.valorPago || c.valor : c.valor));
  const totalReceitas = round2(receitas.reduce((a, x) => a + x.valor, 0)), totalDespesas = round2(despesas.reduce((a, x) => a + x.valor, 0));
  return { regime, receitas, despesas, totalReceitas, totalDespesas, resultado: round2(totalReceitas - totalDespesas), margemPct: totalReceitas > 0 ? Math.round((totalReceitas - totalDespesas) / totalReceitas * 1000) / 10 : 0 };
}

module.exports = { BANCOS, TIPOS_CONTA, TIPOS_FORMA, defaults, addDias, proximoUtil, somaUteis, creditoEm, taxaForma, planejarParcelas, criarLancamentos, baixarLancamento, VALID, usos, movimentos, saldoConta, saldoAntes, extrato, validarTransferencia, dre };
