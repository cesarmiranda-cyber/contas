'use strict';
// Regras puras do Registro de Cliente (sem rede/disco): etapas do funil, situação do mês, indicadores do dashboard.

const DIA_ATRASO = 20;          // a partir do dia 20 o mês corrente sem registro vira "atrasado"
const DIAS_ETAPA = 30;          // tempo na etapa para sugerir avançar de mês
const DIAS_SEM_CONTATO = 45;    // alerta de cliente sem contato
const MES_PRIORIDADE = 10;     // últimos 3 meses de contrato (Mês 10, 11 e 12) = prioridade; antes disso, acompanhamento
const STATUS = ['reuniao', 'contato', 'sem_contato', 'pendente', 'atrasado'];

const addMes = (m, n) => { const [y, mo] = m.split('-').map(Number), t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const diasEntre = (a, b) => Math.floor((Date.parse(b.slice(0, 10) + 'T00:00:00Z') - Date.parse(a.slice(0, 10) + 'T00:00:00Z')) / 864e5);
const mesesEntre = (a, b) => Math.max(0, (+b.slice(0, 4) * 12 + +b.slice(5, 7)) - (+a.slice(0, 4) * 12 + +a.slice(5, 7)) - (+b.slice(8, 10) < +a.slice(8, 10) ? 1 : 0));
const todayBR = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);

// Etapas do funil a partir de /statuses (DEAL_STAGE): "Mês N" = ciclo, semântica S = assinado, F = cancelados.
function etapas(statuses) {
  const porId = {}, meses = [];
  let ganho = null, perdido = null;
  for (const s of statuses || []) {
    const m = /^m[eê]s\s*(\d+)/i.exec(String(s.name || '').trim());
    const info = { id: s.statusId, nome: s.name, sort: +s.sort || 0, mes: m ? +m[1] : null, tipo: m ? 'mes' : s.semantics === 'S' ? 'ganho' : s.semantics === 'F' ? 'perdido' : 'outro' };
    porId[s.statusId] = info;
    if (info.tipo === 'mes') meses.push(info); else if (info.tipo === 'ganho') ganho = info; else if (info.tipo === 'perdido') perdido = info;
  }
  meses.sort((a, b) => a.mes - b.mes);
  return { porId, meses, mes0: meses.find(e => e.mes === 0) || null, ultimo: meses[meses.length - 1] || null, ganho, perdido };
}

const statusDoRegistro = r => r.reuniaoRealizada ? 'reuniao' : r.contatoFeito ? 'contato' : 'sem_contato';

// Situação de um cliente em um mês de referência (AAAA-MM). 'na' = cliente ainda não existia no mês.
function situacao(reg, mes, hoje, inicio) {
  if (inicio && mes < inicio.slice(0, 7)) return 'na';
  if (reg) return statusDoRegistro(reg);
  const atual = hoje.slice(0, 7);
  if (mes < atual) return 'atrasado';
  if (mes === atual) return +hoje.slice(8, 10) >= DIA_ATRASO ? 'atrasado' : 'pendente';
  return 'pendente';
}

// Etapa esperada pela data da próxima renovação (campo "Próxima Renovação Bitrix24"), por meses de calendário:
// renova daqui a 12 meses → Mês 0 … renova neste mês → Mês 12. Data em mês anterior = renovação vencida (precisa decisão).
const idxMes = d => { const [y, m] = d.slice(0, 7).split('-').map(Number); return y * 12 + m - 1; };
function mesEsperado(renov, hoje) {
  if (!renov) return null;
  const diff = idxMes(renov) - idxMes(hoje);
  if (diff < 0) return { mes: 12, vencida: true };
  return { mes: Math.max(0, Math.min(12, 12 - diff)), vencida: false };
}
// Plano de sincronização: quais cards mudam de etapa e quais ficam de fora (sem data / renovação vencida).
function plano({ deals, etapa, hoje, campo }) {
  const mover = [], ignorados = [];
  for (const d of deals) {
    const e = etapa.porId[d.stageId]; if (!e || e.tipo !== 'mes') continue;
    const renov = d[campo] ? String(d[campo]).slice(0, 10) : null, esp = mesEsperado(renov, hoje);
    if (!esp) { ignorados.push({ id: d.id, titulo: d.title, etapa: e.nome, motivo: 'sem_data' }); continue; }
    if (esp.vencida) { ignorados.push({ id: d.id, titulo: d.title, etapa: e.nome, renovacao: renov, motivo: 'vencida' }); continue; }
    if (esp.mes !== e.mes) mover.push({ id: d.id, titulo: d.title, de: e.nome, para: etapa.meses.find(x => x.mes === esp.mes)?.nome, paraId: etapa.meses.find(x => x.mes === esp.mes)?.id, renovacao: renov });
  }
  return { mover: mover.filter(m => m.paraId), ignorados };
}

// Monta a visão de cada cliente do funil. deals: [{id,title,stageId,companyId,assignedById,begindate,movedTime,...}]
function clientes({ deals, etapa, registros, empresas = {}, contatos = {}, usuarios = {}, mes, hoje, campo, campos = {}, enums = {} }) {
  const porDeal = new Map();
  for (const r of registros) { if (!porDeal.has(r.dealId)) porDeal.set(r.dealId, new Map()); porDeal.get(r.dealId).set(r.mes, r); }
  const out = [];
  for (const d of deals) {
    const e = etapa.porId[d.stageId]; if (!e) continue;
    const regs = porDeal.get(d.id) || new Map();
    const inicio = d.begindate ? d.begindate.slice(0, 10) : null;
    const reg = regs.get(mes) || null;
    const ordenados = [...regs.values()].sort((a, b) => b.mes.localeCompare(a.mes));
    const ultimo = ordenados[0] || null;
    const comContato = ordenados.filter(r => r.reuniaoRealizada || r.contatoFeito).sort((a, b) => (b.data || b.mes).localeCompare(a.data || a.mes))[0] || null;
    const refDias = comContato ? (comContato.data || comContato.mes + '-01') : inicio;
    const historico = [];
    for (let i = 11; i >= 0; i--) { const m = addMes(mes, -i); historico.push({ mes: m, status: situacao(regs.get(m), m, hoje, inicio) }); }
    let seq = 0;
    for (let i = (reg ? 0 : 1); i < 24; i++) { const r = regs.get(addMes(mes, -i)); if (r && (r.reuniaoRealizada || r.contatoFeito)) seq++; else break; }
    const diasNaEtapa = d.movedTime ? Math.max(0, diasEntre(d.movedTime, hoje)) : null;
    const rot = (k, v) => (v === null || v === undefined || v === '') ? null : (enums[k]?.[v] || String(v));
    const plano = rot('plano', campos.plano && d[campos.plano]) || rot('planoB24', campos.planoB24 && d[campos.planoB24]);
    const contratacao = rot('contratacao', campos.contratacao && d[campos.contratacao]);
    const renov = campo && d[campo] ? String(d[campo]).slice(0, 10) : null, esp = mesEsperado(renov, hoje);
    let mover = null;
    if (e.tipo === 'mes') {
      if (esp?.vencida) mover = { tipo: 'decidir', vencida: true, motivo: 'renovacao_vencida' };
      else if (esp && esp.mes !== e.mes) mover = { tipo: 'sincronizar', vencida: true, destinoMes: esp.mes };
      else if (esp && e.mes === 12) mover = { tipo: 'decidir', vencida: false };
      else if (!esp && diasNaEtapa !== null) {
        if (e.mes === 12) mover = { tipo: 'decidir', vencida: diasNaEtapa >= DIAS_ETAPA };
        else if (diasNaEtapa >= DIAS_ETAPA) mover = { tipo: 'avancar', vencida: true };
      }
    }
    out.push({
      id: d.id, nome: empresas[d.companyId] || contatos[d.contactId] || d.title, dominio: String(d.title).includes('.') ? d.title : '', empresaId: d.companyId || null,
      responsavelId: d.assignedById, responsavel: usuarios[d.assignedById] || null,
      prioridade: e.tipo === 'mes' && e.mes >= MES_PRIORIDADE, etapaId: e.id, etapa: e.nome, mesCiclo: e.mes, tipoEtapa: e.tipo, inicio, valor: d.amount || 0, moeda: d.currency || 'BRL',
      diasNaEtapa, mover, plano, planoId: campos.plano && d[campos.plano] ? String(d[campos.plano]) : '', contratacao, contratacaoId: campos.contratacao && d[campos.contratacao] ? String(d[campos.contratacao]) : '', mesesContrato: inicio ? mesesEntre(inicio, hoje) : null, diasParaRenovar: renov ? diasEntre(hoje, renov) : null, nuncaVisitado: !comContato, proxRenovacao: renov, mesEsperado: esp ? esp.mes : null, status: situacao(reg, mes, hoje, inicio), registro: reg,
      saude: ultimo?.saude || null, renovacao: ultimo?.renovacao || null,
      ultimoContato: refDias, diasSemContato: refDias ? Math.max(0, diasEntre(refDias, hoje)) : null, temContato: !!comContato,
      sequencia: seq, historico,
    });
  }
  return out;
}

const vazio = () => ({ total: 0, reuniao: 0, contato: 0, sem_contato: 0, pendente: 0, atrasado: 0 });
const conta = (acc, s) => { if (s === 'na') return acc; acc.total++; acc[s]++; return acc; };

// Indicadores do dashboard para o mês de referência.
function dashboard({ lista, etapa, registros, mes, hoje }) {
  const ativos = lista.filter(c => c.tipoEtapa === 'mes');
  const geral = ativos.reduce((a, c) => conta(a, c.status), vazio());
  const feito = geral.reuniao + geral.contato;
  const grupo = p => ativos.filter(c => c.prioridade === p).reduce((a, c) => conta(a, c.status), vazio());
  const grupos = { prioridade: grupo(true), acompanhamento: grupo(false) };
  const porEtapa = etapa.meses.map(e => ({ etapa: e.nome, mes: e.mes, ...ativos.filter(c => c.mesCiclo === e.mes).reduce((a, c) => conta(a, c.status), vazio()) }));
  const resp = new Map();
  for (const c of ativos) { const k = c.responsavel || 'Sem responsável'; resp.set(k, conta(resp.get(k) || vazio(), c.status)); }
  const porResponsavel = [...resp].map(([nome, v]) => ({ nome, ...v })).sort((a, b) => b.total - a.total);
  const regsAtivos = new Map(registros.map(r => [r.dealId + ':' + r.mes, r]));
  const serie = [];
  for (let i = 5; i >= 0; i--) {
    const m = addMes(mes, -i), a = vazio();
    for (const c of ativos) conta(a, situacao(regsAtivos.get(c.id + ':' + m), m, hoje, c.inicio));
    serie.push({ mes: m, ...a });
  }
  const saude = { verde: 0, amarelo: 0, vermelho: 0, sem: 0 };
  for (const c of ativos) saude[c.saude || 'sem']++;
  const alertas = [], nivel = Object.fromEntries(ativos.map(c => [c.id, c.prioridade ? 1 : 0]));
  const add = (tipo, c, detalhe) => alertas.push({ tipo, dealId: c.id, nome: c.nome, etapa: c.etapa, detalhe });
  for (const c of ativos) {
    if (c.saude === 'vermelho') add('saude', c, 'Saúde do cliente em vermelho');
    if (c.renovacao === 'improvavel') add('renovacao', c, 'Renovação improvável');
    if (c.diasSemContato !== null && c.diasSemContato > DIAS_SEM_CONTATO) add('sem_contato', c, `${c.diasSemContato} dias sem contato`);
    if (c.status === 'atrasado') add('atrasado', c, 'Registro do mês em atraso');
    if (c.mover?.vencida) add('mover', c, c.mover.motivo === 'renovacao_vencida' ? `Renovação vencida (${c.proxRenovacao.split('-').reverse().join('/')}): renovar ou cancelar` : c.mover.tipo === 'sincronizar' ? `Pela renovação (${c.proxRenovacao.split('-').reverse().join('/')}) deveria estar no Mês ${c.mover.destinoMes}` : c.mover.tipo === 'decidir' ? 'Fim do ciclo: renovar ou cancelar' : `Há ${c.diasNaEtapa} dias em ${c.etapa}: avançar de mês`);
  }
  alertas.sort((a, b) => (nivel[b.dealId] || 0) - (nivel[a.dealId] || 0));
  const cont = t => alertas.filter(a => a.tipo === t).length;
  const soma = a => a.reduce((s, c) => s + (c.valor || 0), 0), res = a => ({ qtd: a.length, valor: soma(a) });
  const janela = n => ativos.filter(c => c.diasParaRenovar !== null && c.diasParaRenovar >= 0 && c.diasParaRenovar <= n);
  const ficha = c => ({ id: c.id, nome: c.nome, etapa: c.etapa, mesCiclo: c.mesCiclo, prioridade: c.prioridade, responsavel: c.responsavel, status: c.status, plano: c.plano, valor: c.valor, dias: c.diasParaRenovar, data: c.proxRenovacao, semContato: c.diasSemContato });
  const porChave = (fn) => { const m = new Map(); for (const c of ativos) { const k = fn(c); const o = m.get(k) || { nome: k, qtd: 0, valor: 0 }; o.qtd++; o.valor += c.valor || 0; m.set(k, o); } return [...m.values()].sort((a, b) => b.qtd - a.qtd); };
  const meses = []; for (let i = 0; i < 12; i++) { const m = addMes(hoje.slice(0, 7), i); const l = ativos.filter(c => c.proxRenovacao && c.proxRenovacao.slice(0, 7) === m); meses.push({ mes: m, ...res(l) }); }
  const faixas = [['0 a 3', 0, 3], ['4 a 6', 4, 6], ['7 a 9', 7, 9], ['10 a 12', 10, 12], ['13 a 24', 13, 24], ['25+', 25, 1e9]].map(([f, a, b]) => ({ faixa: f, qtd: ativos.filter(c => c.mesesContrato !== null && c.mesesContrato >= a && c.mesesContrato <= b).length }));
  const medidos = ativos.filter(c => c.mesesContrato !== null);
  const urg = (a, b) => (b.prioridade - a.prioridade) || (b.mesCiclo - a.mesCiclo);
  const carteira = {
    ativos: ativos.length, valor: soma(ativos), ticket: ativos.length ? soma(ativos) / ativos.filter(c => c.valor).length || 0 : 0,
    vencer: { d30: res(janela(30)), d60: res(janela(60)), d90: res(janela(90)) },
    proximos: ativos.filter(c => c.diasParaRenovar !== null && c.diasParaRenovar <= 90).sort((a, b) => a.diasParaRenovar - b.diasParaRenovar).slice(0, 80).map(ficha),
    porMesRenov: meses, porPlano: porChave(c => c.plano || 'Sem plano'), porContratacao: porChave(c => c.contratacao || 'Não informado'),
    tempo: { faixas, media: medidos.length ? medidos.reduce((s, c) => s + c.mesesContrato, 0) / medidos.length : 0 },
    semVisita: {
      nunca: ativos.filter(c => c.nuncaVisitado).sort(urg).slice(0, 80).map(ficha),
      semContato45: ativos.filter(c => !c.nuncaVisitado && c.diasSemContato > DIAS_SEM_CONTATO).sort(urg).slice(0, 80).map(ficha),
      pendentes: ativos.filter(c => c.status === 'pendente' || c.status === 'atrasado').sort(urg).slice(0, 80).map(ficha),
      nNunca: ativos.filter(c => c.nuncaVisitado).length,
    },
    qualidade: { semData: ativos.filter(c => !c.proxRenovacao).map(ficha), vencidas: ativos.filter(c => c.mover?.motivo === 'renovacao_vencida').map(ficha), semPlano: ativos.filter(c => !c.plano).length, semResponsavel: ativos.filter(c => !c.responsavel).length },
    intencao: { provavel: ativos.filter(c => c.renovacao === 'provavel').length, indefinido: ativos.filter(c => c.renovacao === 'indefinido').length, improvavel: ativos.filter(c => c.renovacao === 'improvavel').length, sem: ativos.filter(c => !c.renovacao).length },
  };
  return {
    mes, geral, grupos, carteira, cobertura: geral.total ? feito / geral.total : 0, reuniaoPct: geral.total ? geral.reuniao / geral.total : 0,
    porEtapa, porResponsavel, serie, saude, alertas, resumoAlertas: { saude: cont('saude'), renovacao: cont('renovacao'), sem_contato: cont('sem_contato'), atrasado: cont('atrasado'), mover: cont('mover') },
    encerrados: { assinados: lista.filter(c => c.tipoEtapa === 'ganho').length, cancelados: lista.filter(c => c.tipoEtapa === 'perdido').length },
  };
}

// Destino permitido para mover o cliente no ciclo de 12 meses.
function destino(acao, atual, etapa) {
  if (atual.tipo !== 'mes') return { erro: 'Só clientes em uma etapa de "Mês" podem ser movidos.' };
  if (acao === 'cancelar') return etapa.perdido ? { etapa: etapa.perdido } : { erro: 'Etapa de cancelados não encontrada.' };
  if (acao === 'avancar') {
    const prox = etapa.meses.find(e => e.mes === atual.mes + 1);
    return prox ? { etapa: prox } : { erro: 'Cliente já está no último mês: use renovar ou cancelar.' };
  }
  if (acao === 'renovar') {
    if (atual.mes !== (etapa.ultimo?.mes)) return { erro: 'Só é possível renovar no último mês do ciclo.' };
    return etapa.mes0 ? { etapa: etapa.mes0 } : { erro: 'Etapa Mês 0 não encontrada.' };
  }
  return { erro: 'Ação inválida.' };
}

module.exports = { MES_PRIORIDADE, mesEsperado, plano, STATUS, DIA_ATRASO, DIAS_ETAPA, DIAS_SEM_CONTATO, addMes, diasEntre, todayBR, etapas, situacao, statusDoRegistro, clientes, dashboard, destino };
