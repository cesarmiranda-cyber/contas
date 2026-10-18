'use strict';
// Regras do módulo financeiro (sem I/O): contas a pagar, folha, fluxo de caixa, resumo e relatórios.
// Cobertas por test/fin.test.js. Datas AAAA-MM-DD (fuso de São Paulo), valores em reais.
const R = require('./rules');

const FORMAS_PAG = ['PIX', 'BOLETO', 'CARTAO', 'TRANSFERENCIA', 'DINHEIRO'];
const CATEGORIAS_DESPESA = ['Folha de pagamento', 'Encargos e impostos', 'Fornecedores', 'Aluguel e condomínio', 'Software e licenças', 'Marketing', 'Serviços de terceiros', 'Outros'];
const brl = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const round2 = v => Math.round(Number(v) * 100) / 100;
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const bad = msg => { const e = new Error(msg); e.status = 400; return e; };
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isCompetencia = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const money = (v, nome) => { const n = Number(v); if (!(n > 0) || n > 1e9) throw bad(`${nome}: informe um valor maior que zero.`); return round2(n); };

// ---------- contas a pagar ----------
// Gera N parcelas (mensais) de uma despesa; a soma das parcelas é sempre igual ao total.
function criarContas(p, hoje = R.todayBR()) {
  const empresaId = String(p.empresaId || '');
  if (!empresaId) throw bad('Escolha a empresa.');
  const descricao = String(p.descricao || '').trim();
  if (descricao.length < 2 || descricao.length > 200) throw bad('Descrição de 2 a 200 caracteres.');
  const total = money(p.valor, 'Valor');
  if (!isDay(p.venc)) throw bad('Vencimento inválido (AAAA-MM-DD).');
  const forma = FORMAS_PAG.includes(p.forma) ? p.forma : 'BOLETO';
  const n = Math.max(1, Math.min(60, Math.floor(Number(p.parcelas) || 1)));
  const sched = R.buildSchedule({ total, parcelas: n, primeiroVenc: p.venc, tipo: n > 1 ? 'PARCELADO' : 'UNICA' });
  const grupo = n > 1 ? uid('grp') : '';
  return sched.map(s => ({
    id: uid('cp'), empresaId, descricao, valor: s.value, venc: s.due, forma,
    fornecedor: String(p.fornecedor || '').trim().slice(0, 120), categoria: String(p.categoria || 'Outros').slice(0, 60),
    parcela: n > 1 ? `${s.n}/${s.of}` : '', grupo, origem: p.origem || 'manual', folhaKey: p.folhaKey || '',
    codigoBarras: String(p.codigoBarras || '').slice(0, 120), obs: String(p.obs || '').slice(0, 500),
    status: 'aberta', pagoEm: '', valorPago: 0, criado: hoje,
  }));
}

// aberta | vencida | a_vencer(<=7 dias) | paga | cancelada
function statusConta(c, hoje = R.todayBR()) {
  if (c.status === 'paga' || c.status === 'cancelada') return c.status;
  const d = R.dayDiff(c.venc, hoje);
  return d < 0 ? 'vencida' : d <= 7 ? 'a_vencer' : 'aberta';
}
function baixar(c, { data, valor, forma } = {}, hoje = R.todayBR()) {
  if (c.status === 'cancelada') throw bad('Conta cancelada não pode ser paga.');
  const dia = data || hoje;
  if (!isDay(dia) || dia > hoje) throw bad('Data de pagamento inválida.');
  return { ...c, status: 'paga', pagoEm: dia, valorPago: valor ? money(valor, 'Valor pago') : c.valor, forma: FORMAS_PAG.includes(forma) ? forma : c.forma };
}

// ---------- folha de pagamento (simples: valores informados à mão) ----------
// Funcionário: { id, empresaId, nome, cargo, cpf, salario, beneficios, encargos, diaPagamento, forma, ativo, admissao, desligamento }
function validarFuncionario(p) {
  const nome = String(p.nome || '').trim();
  if (nome.length < 2) throw bad('Informe o nome do funcionário.');
  if (!p.empresaId) throw bad('Escolha a empresa.');
  const salario = Number(p.salario);
  if (!(salario >= 0) || salario > 1e7) throw bad('Salário inválido.');
  const nz = (v, n) => { const x = Number(v || 0); if (!(x >= 0) || x > 1e7) throw bad(`${n} inválido.`); return round2(x); };
  const dia = Math.floor(Number(p.diaPagamento || 5));
  if (dia < 1 || dia > 28) throw bad('Dia de pagamento entre 1 e 28.');
  const cpf = R.digits(p.cpf);
  if (cpf && !R.validCPF(cpf)) throw bad('CPF inválido.');
  return {
    empresaId: String(p.empresaId), nome: nome.slice(0, 120), cargo: String(p.cargo || '').slice(0, 80), cpf,
    salario: round2(salario), beneficios: nz(p.beneficios, 'Benefícios'), encargos: nz(p.encargos, 'Encargos'),
    descontos: nz(p.descontos, 'Descontos'), diaPagamento: dia, forma: FORMAS_PAG.includes(p.forma) ? p.forma : 'PIX',
    pix: String(p.pix || '').slice(0, 120), ativo: p.ativo !== false, admissao: isDay(p.admissao) ? p.admissao : '', desligamento: isDay(p.desligamento) ? p.desligamento : '',
  };
}
const custoTotal = f => round2(f.salario + f.beneficios + f.encargos);
const liquido = f => round2(f.salario - (f.descontos || 0));

// Funcionário entra na folha da competência se estava ativo naquele mês.
function naFolha(f, competencia) {
  if (!f.ativo && !f.desligamento) return false;
  const ini = f.admissao ? f.admissao.slice(0, 7) : '0000-00';
  const fim = f.desligamento ? f.desligamento.slice(0, 7) : '9999-12';
  return competencia >= ini && competencia <= fim;
}

// Contas a pagar da folha de uma competência (AAAA-MM). Cada funcionário gera até 3 lançamentos
// (salário líquido, benefícios, encargos) pagos no mês seguinte; `jaGeradas` (folhaKeys) garante idempotência.
function gerarFolha({ funcionarios, competencia, empresaId, jaGeradas = new Set() }, hoje = R.todayBR()) {
  if (!isCompetencia(competencia)) throw bad('Competência inválida (AAAA-MM).');
  const contas = [];
  for (const f of funcionarios.filter(x => String(x.empresaId) === String(empresaId) && naFolha(x, competencia))) {
    const venc = R.addMonths(`${competencia}-${String(f.diaPagamento).padStart(2, '0')}`, 1);
    const itens = [
      ['salario', `Salário ${competencia} · ${f.nome}`, liquido(f), 'Folha de pagamento', f.forma],
      ['beneficios', `Benefícios ${competencia} · ${f.nome}`, f.beneficios, 'Folha de pagamento', f.forma],
      ['encargos', `Encargos ${competencia} · ${f.nome}`, f.encargos + (f.descontos || 0), 'Encargos e impostos', 'BOLETO'],
    ];
    for (const [tipo, descricao, valor, categoria, forma] of itens) {
      const folhaKey = `${empresaId}|${f.id}|${competencia}|${tipo}`;
      if (valor <= 0 || jaGeradas.has(folhaKey)) continue;
      contas.push(...criarContas({ empresaId, descricao, valor, venc, forma, fornecedor: f.nome, categoria, origem: 'folha', folhaKey }, hoje));
    }
  }
  return contas;
}

// ---------- recebíveis unificados (deals do funil 90 + lançamentos manuais) ----------
const RECEBER_STATUS = { [R.STAGES.paid]: 'pago', [R.STAGES.cancelled]: 'cancelado', [R.STAGES.late]: 'atrasado', [R.STAGES.soon]: 'a_vencer', [R.STAGES.open]: 'aberto' };
function recebiveisDeDeals(deals, empresaDe) {
  return deals.filter(d => !R.CONTRACT_STAGES.has(d.stageId)).map(d => ({
    id: `deal_${d.id}`, dealId: d.id, origem: 'bitrix', empresaId: empresaDe(d) || '', descricao: d.titulo, cliente: d.cliente,
    valor: d.valor, venc: d.venc, status: RECEBER_STATUS[d.stageId] || 'aberto', pagoEm: d.pagoEm || '', forma: d.forma || '',
    asaasId: d.asaasId || '', link: d.link || '', statusAsaas: d.statusAsaas || '', parcela: d.parcela || '', origemDeal: d.origem || '',
  }));
}
function statusReceber(r, hoje = R.todayBR()) {
  if (r.status === 'pago' || r.status === 'cancelado') return r.status;
  if (!r.venc) return 'aberto';
  const d = R.dayDiff(r.venc, hoje);
  return d < 0 ? 'atrasado' : d <= 7 ? 'a_vencer' : 'aberto';
}
const normReceber = (r, hoje) => ({ ...r, status: statusReceber(r, hoje) });
const abertoR = r => r.status !== 'pago' && r.status !== 'cancelado';
const abertoP = c => c.status !== 'paga' && c.status !== 'cancelada';
const pick = (list, empresaId) => (empresaId ? list.filter(x => String(x.empresaId) === String(empresaId)) : list);

// ---------- fluxo de caixa ----------
// Mês a mês: entradas e saídas realizadas (por data de pagamento) e previstas (por vencimento, em aberto).
// Atrasados entram no mês atual (é quando se espera resolver). Saldo acumulado parte de `saldoInicial`.
function fluxoCaixa({ receber, pagar, empresaId, hoje = R.todayBR(), mesesAtras = 2, mesesFrente = 6, saldoInicial = 0 }) {
  const rec = pick(receber, empresaId).map(r => normReceber(r, hoje)), pag = pick(pagar, empresaId);
  const mesHoje = hoje.slice(0, 7), meses = [];
  const m0 = R.addMonths(`${mesHoje}-01`, -mesesAtras);
  for (let i = 0; i <= mesesAtras + mesesFrente; i++) meses.push(R.addMonths(m0, i).slice(0, 7));
  const clamp = m => (m < mesHoje ? mesHoje : m);
  const linhas = meses.map(mes => ({ mes, entradaReal: 0, saidaReal: 0, entradaPrev: 0, saidaPrev: 0 }));
  const at = mes => linhas.find(l => l.mes === mes);
  for (const r of rec) {
    if (r.status === 'cancelado') continue;
    if (r.status === 'pago') { const l = at((r.pagoEm || r.venc || '').slice(0, 7)); if (l) l.entradaReal += r.valor; }
    else if (r.venc) { const l = at(clamp((r.credito || r.venc).slice(0, 7))); if (l) l.entradaPrev += r.valorLiquido ?? r.valor; }   // forma com prazo (ex.: cartão D+30) e taxa
  }
  for (const c of pag) {
    if (c.status === 'cancelada') continue;
    if (c.status === 'paga') { const l = at((c.pagoEm || c.venc).slice(0, 7)); if (l) l.saidaReal += c.valorPago || c.valor; }
    else { const l = at(clamp(c.venc.slice(0, 7))); if (l) l.saidaPrev += c.valor; }
  }
  let saldo = round2(saldoInicial);
  for (const l of linhas) {
    for (const k of ['entradaReal', 'saidaReal', 'entradaPrev', 'saidaPrev']) l[k] = round2(l[k]);
    l.resultado = round2(l.entradaReal + l.entradaPrev - l.saidaReal - l.saidaPrev);
    saldo = round2(saldo + l.resultado); l.saldo = saldo; l.atual = l.mes === mesHoje; l.futuro = l.mes > mesHoje;
  }
  const minimo = linhas.filter(l => l.mes >= mesHoje).reduce((a, l) => (!a || l.saldo < a.saldo ? l : a), null);
  return { linhas, saldoFinal: saldo, menorSaldo: minimo ? { mes: minimo.mes, saldo: minimo.saldo } : null };
}

// ---------- resumo (dashboard) ----------
function resumo({ receber, pagar, funcionarios = [], contratos = [], empresaId, hoje = R.todayBR(), saldoInicial = 0 }) {
  const rec = pick(receber, empresaId).map(r => normReceber(r, hoje)), pag = pick(pagar, empresaId);
  const func = pick(funcionarios, empresaId).filter(f => f.ativo);
  const mes = hoje.slice(0, 7), soma = (l, f, v = x => x.valor) => round2(l.filter(f).reduce((a, x) => a + v(x), 0));
  const aReceber = soma(rec, abertoR), aPagar = soma(pag, abertoP);
  const atrasado = soma(rec, r => r.status === 'atrasado'), vencidoPagar = soma(pag, c => statusConta(c, hoje) === 'vencida');
  const recebidoMes = soma(rec, r => r.status === 'pago' && (r.pagoEm || '').startsWith(mes));
  const pagoMes = soma(pag, c => c.status === 'paga' && (c.pagoEm || '').startsWith(mes), c => c.valorPago || c.valor);
  const d30 = new Date(Date.parse(hoje + 'T00:00:00Z') + 30 * 864e5).toISOString().slice(0, 10);
  const prox = (l, f) => soma(l, x => f(x) && x.venc && x.venc <= d30);
  const caixa = fluxoCaixa({ receber: rec, pagar: pag, hoje, saldoInicial, mesesAtras: 0, mesesFrente: 5 });
  const despesas = new Map();
  for (const c of pag.filter(x => x.status !== 'cancelada' && (x.venc || '').startsWith(mes))) despesas.set(c.categoria || 'Outros', round2((despesas.get(c.categoria || 'Outros') || 0) + c.valor));
  const venc30 = contratos.filter(c => c.diasParaVencer !== null && c.diasParaVencer >= 0 && c.diasParaVencer <= 30);
  const aging = { '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rec.filter(x => x.status === 'atrasado')) { const d = -R.dayDiff(r.venc, hoje); aging[d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+'] += r.valor; }
  for (const k of Object.keys(aging)) aging[k] = round2(aging[k]);
  const devedores = new Map();
  for (const r of rec.filter(x => x.status === 'atrasado')) devedores.set(r.cliente || 'Sem cliente', round2((devedores.get(r.cliente || 'Sem cliente') || 0) + r.valor));
  const lista = (l, f) => l.filter(f).sort((a, b) => (a.venc || '9999').localeCompare(b.venc || '9999')).slice(0, 6);
  const alertas = [];
  if (vencidoPagar > 0) alertas.push({ sev: 'alta', msg: `${pag.filter(c => statusConta(c, hoje) === 'vencida').length} conta(s) a pagar vencida(s): ${brl(vencidoPagar)}` });
  if (atrasado > 0) alertas.push({ sev: 'media', msg: `${brl(atrasado)} em recebimentos atrasados` });
  if (caixa.menorSaldo && caixa.menorSaldo.saldo < 0) alertas.push({ sev: 'alta', msg: `Caixa projetado negativo em ${caixa.menorSaldo.mes} (${brl(caixa.menorSaldo.saldo)})` });
  if (venc30.length) alertas.push({ sev: 'media', msg: `${venc30.length} contrato(s) vencem nos próximos 30 dias` });
  return {
    aReceber, aPagar, atrasado, vencidoPagar, recebidoMes, pagoMes, resultadoMes: round2(recebidoMes - pagoMes),
    receber30: prox(rec, abertoR), pagar30: prox(pag, abertoP), saldoProjetado30: round2(prox(rec, abertoR) - prox(pag, abertoP)),
    inadimplenciaPct: aReceber > 0 ? Math.round((atrasado / aReceber) * 1000) / 10 : 0,
    folhaMensal: round2(func.reduce((a, f) => a + custoTotal(f), 0)), funcionarios: func.length,
    despesasMes: [...despesas].map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor),
    aging, devedores: [...devedores].map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor).slice(0, 5),
    proximosPagar: lista(pag, abertoP).map(c => ({ id: c.id, descricao: c.descricao, fornecedor: c.fornecedor, venc: c.venc, valor: c.valor, situacao: statusConta(c, hoje) })),
    proximosReceber: lista(rec, abertoR).map(r => ({ id: r.id, descricao: r.descricao, cliente: r.cliente, venc: r.venc, valor: r.valor, situacao: r.status })),
    contratosProximos: contratos.filter(c => c.diasParaVencer !== null).slice(0, 5).map(c => ({ id: c.id, titulo: c.titulo, cliente: c.cliente, venc: c.venc, dias: c.diasParaVencer, valor: c.valor })),
    contratosAtivos: contratos.length, contratosVencer30: venc30.length, caixa: caixa.linhas, menorSaldo: caixa.menorSaldo, alertas,
  };
}

// ---------- relatórios ----------
// tipo: receber | pagar | folha | vencimentos. Devolve { titulo, colunas, linhas, total }.
function relatorio({ tipo, receber, pagar, funcionarios = [], empresaId, de, ate, hoje = R.todayBR() }) {
  const dentro = d => (!de || d >= de) && (!ate || d <= ate);
  if (tipo === 'receber') {
    const l = pick(receber, empresaId).map(r => normReceber(r, hoje)).filter(r => r.status !== 'cancelado' && dentro(r.venc || '')).sort((a, b) => (a.venc || '').localeCompare(b.venc || ''));
    return { titulo: 'Contas a receber', colunas: ['Vencimento', 'Cliente', 'Descrição', 'Status', 'Valor'], linhas: l.map(r => [r.venc, r.cliente || '', r.descricao, r.status, r.valor]), total: round2(l.filter(abertoR).reduce((a, r) => a + r.valor, 0)), totalLabel: 'Total em aberto' };
  }
  if (tipo === 'pagar') {
    const l = pick(pagar, empresaId).filter(c => c.status !== 'cancelada' && dentro(c.venc)).sort((a, b) => a.venc.localeCompare(b.venc));
    return { titulo: 'Contas a pagar', colunas: ['Vencimento', 'Fornecedor', 'Descrição', 'Forma', 'Status', 'Valor'], linhas: l.map(c => [c.venc, c.fornecedor, c.descricao + (c.parcela ? ` (${c.parcela})` : ''), c.forma, statusConta(c, hoje), c.valor]), total: round2(l.filter(abertoP).reduce((a, c) => a + c.valor, 0)), totalLabel: 'Total em aberto' };
  }
  if (tipo === 'folha') {
    const l = pick(funcionarios, empresaId).filter(f => f.ativo);
    return { titulo: 'Folha de pagamento (custo mensal)', colunas: ['Funcionário', 'Cargo', 'Salário', 'Benefícios', 'Encargos', 'Custo total'], linhas: l.map(f => [f.nome, f.cargo, f.salario, f.beneficios, f.encargos, custoTotal(f)]), total: round2(l.reduce((a, f) => a + custoTotal(f), 0)), totalLabel: 'Custo total mensal' };
  }
  throw bad('Relatório desconhecido.');
}
const csv = rel => [rel.colunas, ...rel.linhas].map(r => r.map(v => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : (typeof v === 'number' ? String(v).replace('.', ',') : s); }).join(';')).join('\n');

// ---------- contratos (funil 15) ----------
const STATUS_CONTRATO = (dias) => (dias === null ? 'sem_data' : dias < 0 ? 'vencido' : dias <= 30 ? 'vencendo' : 'vigente');
function contratoDeDeal(d, { campoVenc, hoje = R.todayBR(), empresaDe = () => '' } = {}) {
  const venc = R.toDay((campoVenc && d[campoVenc]) || d.CLOSEDATE);
  const dias = venc ? R.dayDiff(venc, hoje) : null;
  return {
    id: +d.ID, titulo: d.TITLE, etapa: d.STAGE_ID, valor: Number(d.OPPORTUNITY) || 0, moeda: d.CURRENCY_ID || 'BRL',
    inicio: R.toDay(d.BEGINDATE), venc, diasParaVencer: dias, status: STATUS_CONTRATO(dias),
    responsavel: d.ASSIGNED_BY_ID, companyId: d.COMPANY_ID && d.COMPANY_ID !== '0' ? d.COMPANY_ID : '', contactId: d.CONTACT_ID && d.CONTACT_ID !== '0' ? d.CONTACT_ID : '',
    empresaId: empresaDe(d) || '', mycompanyId: d.MYCOMPANY_ID && d.MYCOMPANY_ID !== '0' ? String(d.MYCOMPANY_ID) : '',
    obs: String(d.COMMENTS || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500), criado: R.toDay(d.DATE_CREATE), atualizado: R.toDay(d.DATE_MODIFY),
  };
}
// o que falta preencher na deal para o contrato aparecer completo
const faltasContrato = c => [!c.companyId && !c.contactId && 'cliente', !c.valor && 'valor', !c.venc && 'vencimento', !c.empresaId && 'empresa', !c.responsavel && 'responsável'].filter(Boolean);
// Qual aviso deve sair agora: o menor marco (60, 30, 15, 7, 0 dias) já atingido e ainda não enviado.
function avisoDevido(dias, marcos, enviados = []) {
  if (dias === null) return null;
  if (dias < 0) return enviados.includes(-1) ? null : -1;
  const atingidos = marcos.filter(m => dias <= m).sort((a, b) => a - b);
  return atingidos.length && !enviados.includes(atingidos[0]) ? atingidos[0] : null;
}

module.exports = { STATUS_CONTRATO, brl, FORMAS_PAG, CATEGORIAS_DESPESA, uid, round2, bad, isDay, isCompetencia, criarContas, statusConta, baixar, validarFuncionario, custoTotal, liquido, naFolha, gerarFolha, recebiveisDeDeals, statusReceber, fluxoCaixa, resumo, relatorio, csv, contratoDeDeal, faltasContrato, avisoDevido, pick };
