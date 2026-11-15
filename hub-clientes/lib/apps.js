'use strict';
// Regras puras do módulo Apps M4: cada negócio do funil "Licenças Apps" é a licença de um app para um cliente.
// A etapa indica o app (MandaZap, Fale Fácil Chat…) ou o estado da cobrança (Cobrança, Aguardando cobrança).
const { addMes, diasEntre } = require('./metrics');

const ROTULOS = { MANDAZAP: 'MandaZap', 'MANDA TRACKING': 'Manda Tracking', 'MANDA JARVIS': 'Manda Jarvis', 'MANDA LEAD': 'Manda Lead', 'MANDA EXTRATOR': 'Manda Extrator', 'ODOO MANDA4': 'Odoo Manda4', 'FALE FACIL CHAT': 'Fale Fácil Chat', 'FALE FÁCIL CHAT': 'Fale Fácil Chat', WHATCRM: 'WhatCRM', CHATAPP: 'ChatApp', SUPORTE: 'Suporte' };
// Etapas que NÃO são app: viram estado da licença.
function etapasApps(statuses) {
  const porId = {}, apps = [];
  for (const s of statuses || []) {
    const n = String(s.name || '').trim();
    let tipo = 'app';
    if (s.semantics === 'S') tipo = 'fechada'; else if (s.semantics === 'F') tipo = 'cancelada';
    else if (/aguardando\s+cobran/i.test(n)) tipo = 'aguardando'; else if (/cobran/i.test(n)) tipo = 'cobranca'; else if (/nova\s+contrata/i.test(n)) tipo = 'nova';
    const nome = tipo === 'app' ? (ROTULOS[n.toUpperCase()] || n.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase())) : n;
    porId[s.statusId] = { id: s.statusId, nome, tipo };
    if (tipo === 'app') apps.push(nome);
  }
  return { porId, apps };
}

// Licenças a partir dos negócios. over: {dealId: app} (correção manual) · inf: {dealId: app} (inferido do histórico).
function licencas({ deals, etapa, enums = {}, campos = {}, empresas = {}, contatos = {}, over = {}, inf = {}, campoRenovApp, hoje }) {
  // O valor do negócio é o preço mensal da licença (mensal e anual têm o mesmo valor, ex.: MandaZap R$ 44,50).
  const out = [];
  for (const d of deals) {
    const e = etapa.porId[d.stageId]; if (!e) continue;
    const rot = (k, v) => (v === null || v === undefined || v === '') ? null : (enums[k]?.[v] || String(v));
    const contratacao = rot('contratacao', campos.contratacao && d[campos.contratacao]);
    const anual = /anual/i.test(contratacao || '');
    const valor = +d.amount || 0, renov = campoRenovApp && d[campoRenovApp] ? String(d[campoRenovApp]).slice(0, 10) : null;
    const appEtapa = e.tipo === 'app' ? e.nome : null;
    const app = over[d.id] || appEtapa || inf[d.id] || null;
    const cli = d.companyId ? 'e' + d.companyId : d.contactId ? 'c' + d.contactId : 't' + d.title;
    out.push({
      id: d.id, cliente: cli, nome: empresas[d.companyId] || contatos[d.contactId] || d.title, dominio: String(d.title).includes('.') ? d.title : '',
      app, appOrigem: over[d.id] ? 'manual' : appEtapa ? 'etapa' : inf[d.id] ? 'historico' : null,
      estado: e.tipo === 'app' || e.tipo === 'nova' || e.tipo === 'fechada' ? 'ativa' : e.tipo, etapa: e.nome, tipoEtapa: e.tipo,
      plano: rot('plano', campos.plano && d[campos.plano]), planoId: campos.plano && d[campos.plano] ? String(d[campos.plano]) : '',
      contratacao, contratacaoId: campos.contratacao && d[campos.contratacao] ? String(d[campos.contratacao]) : '', anual,
      valor, mensal: valor, renovacao: renov, diasRenovar: renov ? diasEntre(hoje, renov) : null,
      criado: d.createdAt ? String(d.createdAt).slice(0, 10) : null, responsavelId: d.assignedById,
    });
  }
  return out;
}

const ativas = l => l.filter(x => x.estado !== 'cancelada');
const soma = a => a.reduce((s, x) => s + x.mensal, 0);
const res = a => ({ qtd: a.length, mrr: soma(a) });

function resumo(todas, hoje) {
  const at = ativas(todas), clientes = new Map();
  for (const x of at) { const c = clientes.get(x.cliente) || { id: x.cliente, nome: x.nome, qtd: 0, mrr: 0, apps: {} }; c.qtd++; c.mrr += x.mensal; const k = x.app || 'Não identificado'; const a = c.apps[k] || { qtd: 0, mrr: 0 }; a.qtd++; a.mrr += x.mensal; c.apps[k] = a; clientes.set(x.cliente, c); }
  const total = soma(at), lista = [...clientes.values()].sort((a, b) => b.mrr - a.mrr);
  const porApp = new Map();
  for (const x of at) { const k = x.app || 'Não identificado'; const o = porApp.get(k) || { app: k, qtd: 0, mrr: 0, clientes: new Set() }; o.qtd++; o.mrr += x.mensal; o.clientes.add(x.cliente); porApp.set(k, o); }
  const apps = [...porApp.values()].map(o => ({ app: o.app, qtd: o.qtd, mrr: o.mrr, clientes: o.clientes.size, pct: total ? o.mrr / total : 0, ticket: o.qtd ? o.mrr / o.qtd : 0 })).sort((a, b) => b.mrr - a.mrr);
  const nomes = apps.map(a => a.app).sort((a, b) => (a === 'Não identificado') - (b === 'Não identificado') || apps.find(x => x.app === b).mrr - apps.find(x => x.app === a).mrr);
  const janela = n => at.filter(x => x.diasRenovar !== null && x.diasRenovar >= 0 && x.diasRenovar <= n);
  const meses = []; for (let i = 11; i >= 0; i--) { const m = addMes(hoje.slice(0, 7), -i); meses.push({ mes: m, qtd: todas.filter(x => x.criado && x.criado.slice(0, 7) === m).length }); }
  const top5 = lista.slice(0, 5).reduce((s, c) => s + c.mrr, 0);
  return {
    totais: { licencas: at.length, clientes: clientes.size, mrr: total, ticketLicenca: at.length ? total / at.length : 0, ticketCliente: clientes.size ? total / clientes.size : 0, top5pct: total ? top5 / total : 0, umApp: lista.filter(c => Object.keys(c.apps).length === 1).length },
    porApp: apps,
    split: { mensal: res(at.filter(x => !x.anual)), anual: res(at.filter(x => x.anual)) },
    estados: { cobranca: res(todas.filter(x => x.estado === 'cobranca')), aguardando: res(todas.filter(x => x.estado === 'aguardando')), cancelada: res(todas.filter(x => x.estado === 'cancelada')), ativa: res(todas.filter(x => x.estado === 'ativa')) },
    renovacoes: { d30: res(janela(30)), d90: res(janela(90)), vencidas: res(at.filter(x => x.diasRenovar !== null && x.diasRenovar < 0)) },
    topClientes: lista.slice(0, 10).map(c => ({ ...c, pct: total ? c.mrr / total : 0 })),
    matriz: { apps: nomes, linhas: lista.map(c => ({ id: c.id, nome: c.nome, qtd: c.qtd, mrr: c.mrr, apps: c.apps })) },
    evolucao: meses,
    qualidade: { semApp: at.filter(x => !x.app).length, semValor: at.filter(x => !x.valor).length, semPlano: at.filter(x => !x.plano).length, semTipo: at.filter(x => !x.contratacao).length, semRenovacao: at.filter(x => !x.renovacao).length },
  };
}
module.exports = { etapasApps, licencas, resumo };
