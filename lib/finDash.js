'use strict';
// Painel (estilo BI): agrega lançamentos com filtros cruzados. Cada visual ignora o filtro da própria dimensão,
// como no Power BI (o gráfico clicado continua mostrando o todo; os outros se ajustam). Coberto por test/dash.test.js.
const R = require('./rules');
const F = require('./fin');
const C = require('./finCad');

const { round2 } = F;
const ROTULO_BITRIX = 'Cobranças do Bitrix / Asaas';
const lastDay = mes => C.addDias(R.addMonths(`${mes}-01`, 1), -1);
const meses = (de, ate) => { const out = []; for (let m = de.slice(0, 7); m <= ate.slice(0, 7); m = R.addMonths(`${m}-01`, 1).slice(0, 7)) out.push(m); return out; };

// Janela do painel: n meses para trás até o mês atual + 3 meses de previsão.
function janela(periodo, hoje, custom = {}) {
  const mes = hoje.slice(0, 7);
  if (periodo === 'custom' && F.isDay(custom.de) && F.isDay(custom.ate) && custom.de <= custom.ate) return { periodo, de: custom.de, ate: custom.ate };
  const back = { '3m': 2, '6m': 5, '12m': 11, ano: Number(mes.slice(5)) - 1 }[periodo] ?? 5;
  return { periodo: ['3m', '6m', '12m', 'ano'].includes(periodo) ? periodo : '6m', de: R.addMonths(`${mes}-01`, -back), ate: lastDay(R.addMonths(`${mes}-01`, 3).slice(0, 7)) };
}

// lançamentos a receber e a pagar no mesmo formato
function unificar(rec, pag, hoje) {
  const a = rec.map(r => { const st = F.statusReceber(r, hoje); return { tipo: 'receita', id: r.id, titulo: r.descricao, contra: r.cliente || '', categoria: r.categoria || (r.origem === 'bitrix' ? ROTULO_BITRIX : 'Sem categoria'), contaId: r.contaId || '', venc: r.venc || '', pagoEm: r.pagoEm || '', valor: r.valor, valorPago: r.valorPago || r.valor, pago: st === 'pago', cancelado: st === 'cancelado', atrasado: st === 'atrasado', status: st, origem: r.origem || 'manual', empresaId: r.empresaId }; });
  const b = pag.map(c => { const st = F.statusConta(c, hoje); return { tipo: 'despesa', id: c.id, titulo: c.descricao, contra: c.fornecedor || '', categoria: c.categoria || 'Sem categoria', contaId: c.contaId || '', venc: c.venc, pagoEm: c.pagoEm || '', valor: c.valor, valorPago: c.valorPago || c.valor, pago: st === 'paga', cancelado: st === 'cancelada', atrasado: st === 'vencida', status: st, origem: c.origem || 'manual', empresaId: c.empresaId }; });
  return [...a, ...b].filter(x => !x.cancelado);
}
// aplica os filtros, exceto os das dimensões em `ignorar`
function filtrar(l, f, ignorar = []) {
  return l.filter(x => (ignorar.includes('tipo') || !f.tipo || x.tipo === f.tipo) && (ignorar.includes('cat') || !f.cat || x.categoria === f.cat) && (ignorar.includes('conta') || !f.conta || x.contaId === f.conta)
    && (ignorar.includes('contra') || !f.contra || x.contra === f.contra) && (ignorar.includes('mes') || !f.mes || x.venc.startsWith(f.mes)));
}
const soma = (l, fn = x => x.valor) => round2(l.reduce((a, x) => a + fn(x), 0));
const top = (l, chave, n = 8) => { const m = new Map(); for (const x of l) m.set(chave(x) || 'Sem nome', round2((m.get(chave(x) || 'Sem nome') || 0) + x.valor)); const ord = [...m].map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor); return ord.length > n ? [...ord.slice(0, n - 1), { nome: 'Outros', valor: round2(ord.slice(n - 1).reduce((a, x) => a + x.valor, 0)), outros: true }] : ord; };

// rec/pag: lançamentos das empresas escolhidas. f: { tipo, cat, conta, contra, mes }
function agregar({ rec, pag, f = {}, janela: j, hoje = R.todayBR() }) {
  const todos = unificar(rec, pag, hoje);
  const naJanela = l => l.filter(x => x.venc >= j.de && x.venc <= j.ate);
  const base = naJanela(filtrar(todos, f));
  const dentroMes = f.mes ? base : base;
  const rc = dentroMes.filter(x => x.tipo === 'receita'), ds = dentroMes.filter(x => x.tipo === 'despesa');
  const realizadoNaJanela = (l, tipo) => l.filter(x => x.tipo === tipo && x.pago && x.pagoEm >= j.de && x.pagoEm <= j.ate && (!f.mes || x.pagoEm.startsWith(f.mes)));
  const realiz = filtrar(todos, f, ['mes']);
  const kpis = {
    receitaPrev: soma(rc), despesaPrev: soma(ds), resultadoPrev: round2(soma(rc) - soma(ds)),
    recebido: soma(realizadoNaJanela(realiz, 'receita'), x => x.valorPago), pago: soma(realizadoNaJanela(realiz, 'despesa'), x => x.valorPago),
    aReceber: soma(filtrar(todos, f).filter(x => x.tipo === 'receita' && !x.pago)), aPagar: soma(filtrar(todos, f).filter(x => x.tipo === 'despesa' && !x.pago)),
    atrasado: soma(filtrar(todos, f).filter(x => x.tipo === 'receita' && x.atrasado)), vencido: soma(filtrar(todos, f).filter(x => x.tipo === 'despesa' && x.atrasado)),
  };
  // série mensal (ignora o filtro de mês para continuar mostrando o contexto)
  const sem = naJanela(filtrar(todos, f, ['mes']));
  let acum = 0;
  const serie = meses(j.de, j.ate).map(m => {
    const r = soma(sem.filter(x => x.tipo === 'receita' && x.venc.startsWith(m))), d = soma(sem.filter(x => x.tipo === 'despesa' && x.venc.startsWith(m)));
    acum = round2(acum + r - d);
    return { mes: m, receita: r, despesa: d, resultado: round2(r - d), acumulado: acum, futuro: m > hoje.slice(0, 7), atual: m === hoje.slice(0, 7) };
  });
  const semCat = naJanela(filtrar(todos, f, ['cat'])), semContra = naJanela(filtrar(todos, f, ['contra']));
  const aging = { '1-30': { valor: 0, qtd: 0 }, '31-60': { valor: 0, qtd: 0 }, '61-90': { valor: 0, qtd: 0 }, '90+': { valor: 0, qtd: 0 } };
  for (const x of filtrar(todos, f).filter(y => y.tipo === 'receita' && y.atrasado)) { const d = -R.dayDiff(x.venc, hoje), k = d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+'; aging[k].valor = round2(aging[k].valor + x.valor); aging[k].qtd++; }
  const lista = base.slice().sort((a, b) => b.venc.localeCompare(a.venc)).slice(0, 500)
    .map(x => ({ id: x.id, tipo: x.tipo, venc: x.venc, titulo: x.titulo, contra: x.contra, categoria: x.categoria, status: x.status, valor: x.valor, contaId: x.contaId, origem: x.origem, empresaId: x.empresaId }));
  return {
    kpis, serie,
    categoriasDespesa: top(semCat.filter(x => x.tipo === 'despesa' && (!f.tipo || f.tipo === 'despesa')), x => x.categoria, 7),
    categoriasReceita: top(semCat.filter(x => x.tipo === 'receita' && (!f.tipo || f.tipo === 'receita')), x => x.categoria, 7),
    topClientes: top(semContra.filter(x => x.tipo === 'receita'), x => x.contra, 8), topFornecedores: top(semContra.filter(x => x.tipo === 'despesa'), x => x.contra, 8),
    aging, lista, totalLista: base.length,
    opcoes: { categorias: [...new Set(todos.map(x => x.categoria))].sort() },
  };
}
// Painel de contratos: mesmos filtros cruzados. contratos: lista de contratos ativos (com cobrado, faltas, status, valor, venc...).
// f: { status, mes ('vencidos' | 'sem' | AAAA-MM do vencimento), cliente, resp, cobranca ('sim' | 'nao') }
function agregarContratos({ contratos, f = {}, hoje = R.todayBR() }) {
  const mesHoje = hoje.slice(0, 7);
  const balde = c => (c.diasParaVencer === null ? 'sem' : c.diasParaVencer < 0 ? 'vencidos' : c.venc.slice(0, 7));
  const cli = c => c.cliente || 'Sem cliente', resp = c => c.responsavelNome || 'Sem responsável';
  const aplica = (ign = []) => contratos.filter(c => (ign.includes('status') || !f.status || c.status === f.status) && (ign.includes('mes') || !f.mes || balde(c) === f.mes)
    && (ign.includes('cliente') || !f.cliente || cli(c) === f.cliente) && (ign.includes('resp') || !f.resp || resp(c) === f.resp) && (ign.includes('cobranca') || !f.cobranca || (f.cobranca === 'sim') === !!c.cobrado));
  const val = l => round2(l.reduce((a, c) => a + (c.valor || 0), 0));
  const grupo = (l, chave, n = 8) => { const m = new Map(); for (const c of l) { const k = chave(c), g = m.get(k) || { nome: k, valor: 0, qtd: 0 }; g.valor = round2(g.valor + (c.valor || 0)); g.qtd++; m.set(k, g); } const o = [...m.values()].sort((a, b) => b.valor - a.valor || b.qtd - a.qtd); return o.length > n ? [...o.slice(0, n - 1), { nome: 'Outros', valor: round2(o.slice(n - 1).reduce((a, x) => a + x.valor, 0)), qtd: o.slice(n - 1).reduce((a, x) => a + x.qtd, 0), outros: true }] : o; };
  const base = aplica(), v30 = base.filter(c => c.diasParaVencer !== null && c.diasParaVencer >= 0 && c.diasParaVencer <= 30), v90 = base.filter(c => c.diasParaVencer !== null && c.diasParaVencer >= 0 && c.diasParaVencer <= 90), venc = base.filter(c => c.status === 'vencido');
  const kpis = { total: base.length, valor: val(base), ticket: base.length ? round2(val(base) / base.length) : 0, vencem30: v30.length, valor30: val(v30), vencem90: v90.length, valor90: val(v90), vencidos: venc.length, valorVencidos: val(venc),
    semVencimento: base.filter(c => c.status === 'sem_data').length, incompletos: base.filter(c => (c.faltas || []).length).length, cobrados: base.filter(c => c.cobrado).length, semCobranca: base.filter(c => !c.cobrado).length, emRisco: round2(val(v30) + val(venc)) };
  const sm = aplica(['mes']), meses = ['vencidos', ...Array.from({ length: 12 }, (_, i) => R.addMonths(`${mesHoje}-01`, i).slice(0, 7))];
  const porMes = meses.map(m => { const l = sm.filter(c => balde(c) === m); return { mes: m, qtd: l.length, valor: val(l) }; });
  const ST = ['vigente', 'vencendo', 'vencido', 'sem_data'], ss = aplica(['status']);
  const porStatus = ST.map(k => ({ status: k, qtd: ss.filter(c => c.status === k).length, valor: val(ss.filter(c => c.status === k)) }));
  const sc = aplica(['cobranca']);
  return { kpis, porMes, porStatus, topClientes: grupo(aplica(['cliente']), cli), porResponsavel: grupo(aplica(['resp']), resp), porEmpresa: grupo(base, c => c.empresa || 'Sem empresa'),
    cobranca: { gerada: sc.filter(c => c.cobrado).length, pendente: sc.filter(c => !c.cobrado).length },
    pendencias: base.filter(c => (c.faltas || []).length).slice(0, 8).map(c => ({ id: c.id, titulo: c.titulo, cliente: c.cliente, faltas: c.faltas })),
    lista: base.slice().sort((a, b) => (a.venc || '9999').localeCompare(b.venc || '9999')).slice(0, 500).map(c => ({ id: c.id, titulo: c.titulo, cliente: c.cliente, responsavel: c.responsavelNome, empresa: c.empresa, venc: c.venc, dias: c.diasParaVencer, status: c.status, valor: c.valor, cobrado: !!c.cobrado, faltas: c.faltas || [], etapa: c.etapaNome })),
    opcoes: { clientes: [...new Set(contratos.map(cli))].sort(), responsaveis: [...new Set(contratos.map(resp))].sort() } };
}
module.exports = { agregarContratos, janela, unificar, filtrar, agregar, ROTULO_BITRIX, meses, lastDay };
