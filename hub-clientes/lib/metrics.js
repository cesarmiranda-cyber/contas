'use strict';
// Regras puras do Registro de Cliente (sem rede/disco): etapas do funil, situação do mês, indicadores do dashboard.

const DIA_ATRASO = 20;          // a partir do dia 20 o mês corrente sem registro vira "atrasado"
const DIAS_ETAPA = 30;          // tempo na etapa para sugerir avançar de mês
const DIAS_SEM_CONTATO = 45;    // alerta de cliente sem contato
const STATUS = ['reuniao', 'contato', 'sem_contato', 'pendente', 'atrasado'];

const addMes = (m, n) => { const [y, mo] = m.split('-').map(Number), t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const diasEntre = (a, b) => Math.floor((Date.parse(b.slice(0, 10) + 'T00:00:00Z') - Date.parse(a.slice(0, 10) + 'T00:00:00Z')) / 864e5);
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

// Monta a visão de cada cliente do funil. deals: [{id,title,stageId,companyId,assignedById,begindate,movedTime,...}]
function clientes({ deals, etapa, registros, empresas = {}, contatos = {}, usuarios = {}, mes, hoje }) {
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
    let mover = null;
    if (e.tipo === 'mes' && diasNaEtapa !== null) {
      if (e.mes === 12) mover = { tipo: 'decidir', vencida: diasNaEtapa >= DIAS_ETAPA };
      else if (diasNaEtapa >= DIAS_ETAPA) mover = { tipo: 'avancar', vencida: true };
    }
    out.push({
      id: d.id, nome: empresas[d.companyId] || contatos[d.contactId] || d.title, dominio: String(d.title).includes('.') ? d.title : '', empresaId: d.companyId || null,
      responsavelId: d.assignedById, responsavel: usuarios[d.assignedById] || null,
      etapaId: e.id, etapa: e.nome, mesCiclo: e.mes, tipoEtapa: e.tipo, inicio, valor: d.amount || 0, moeda: d.currency || 'BRL',
      diasNaEtapa, mover, status: situacao(reg, mes, hoje, inicio), registro: reg,
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
  const alertas = [];
  const add = (tipo, c, detalhe) => alertas.push({ tipo, dealId: c.id, nome: c.nome, etapa: c.etapa, detalhe });
  for (const c of ativos) {
    if (c.saude === 'vermelho') add('saude', c, 'Saúde do cliente em vermelho');
    if (c.renovacao === 'improvavel') add('renovacao', c, 'Renovação improvável');
    if (c.diasSemContato !== null && c.diasSemContato > DIAS_SEM_CONTATO) add('sem_contato', c, `${c.diasSemContato} dias sem contato`);
    if (c.status === 'atrasado') add('atrasado', c, 'Registro do mês em atraso');
    if (c.mover?.vencida) add('mover', c, c.mover.tipo === 'decidir' ? 'Fim do ciclo: renovar ou cancelar' : `Há ${c.diasNaEtapa} dias em ${c.etapa}: avançar de mês`);
  }
  const cont = t => alertas.filter(a => a.tipo === t).length;
  return {
    mes, geral, cobertura: geral.total ? feito / geral.total : 0, reuniaoPct: geral.total ? geral.reuniao / geral.total : 0,
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

module.exports = { STATUS, DIA_ATRASO, DIAS_ETAPA, DIAS_SEM_CONTATO, addMes, diasEntre, todayBR, etapas, situacao, statusDoRegistro, clientes, dashboard, destino };
