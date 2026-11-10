'use strict';
// Cliente do webhook + a consulta. O webhook (usuário com acesso total) lê o CRM; quem usa o app só recebe o resumo.

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, out);
    else out.push([key, v === null || v === undefined ? '' : String(v)]);
  }
  return out;
}
const qs = o => new URLSearchParams(flatten(o, '', [])).toString();

function createBitrix(webhook, fetchImpl = fetch) {
  // Usa só https://portal/rest/ID/TOKEN: se colaram a URL de exemplo do Bitrix (ex.: .../TOKEN/profile/), o sufixo é descartado.
  const raw = String(webhook || '').trim();
  const base = (raw.match(/^https?:\/\/[^/\s]+\/rest\/\d+\/[^/\s]+/) || [raw.replace(/\/+$/, '')])[0];
  async function call(method, params = {}) {
    if (!base) throw new Error('BITRIX_WEBHOOK não configurado');
    const r = await fetchImpl(`${base}/${method}.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs(params),
    });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`Bitrix ${method}: resposta inválida (${r.status})`);
    if (j.error) throw new Error(`Bitrix ${method}: ${j.error_description || j.error}`);
    return j;
  }
  // batch: até 50 comandos por chamada → { result: {chave: ...}, total: {chave: n} }
  async function batch(cmds) {
    const keys = Object.keys(cmds), result = {}, total = {};
    for (let i = 0; i < keys.length; i += 50) {
      const cmd = {};
      for (const k of keys.slice(i, i + 50)) cmd[k] = `${cmds[k].method}?${qs(cmds[k].params)}`;
      const r = (await call('batch', { halt: 0, cmd })).result || {};
      Object.assign(result, r.result || {}); Object.assign(total, r.result_total || {});
    }
    return { result, total };
  }
  return { call, batch, enabled: !!base };
}

const SEMANTICA = { P: 'Em andamento', S: 'Ganho', F: 'Perdido' };
const arr = v => (Array.isArray(v) ? v : []);

// Funis de orçamento (nomes ou IDs, separados por vírgula): resolve os IDs e os nomes das etapas. Guardado por 5 minutos.
function criarOrcamentos(bitrix, spec, { ttlMs = 300000, agora = Date.now } = {}) {
  const itens = String(spec || '').split(',').map(x => x.trim()).filter(Boolean);
  let cache = null;
  return async () => {
    if (!itens.length) return { ids: [], stages: {} };
    if (cache && agora() - cache.t < ttlMs) return cache.v;
    const todas = arr((await bitrix.call('crm.dealcategory.list', { select: ['ID', 'NAME'] })).result);
    const ids = [];
    for (const it of itens) {
      const achada = /^\d+$/.test(it) ? { ID: it } : todas.find(c => String(c.NAME).toLowerCase() === it.toLowerCase());
      if (!achada) throw new Error(`Funil "${it}" não encontrado`);
      ids.push(String(achada.ID));
    }
    const stages = {};
    for (const id of ids) for (const e of arr((await bitrix.call('crm.dealcategory.stage.list', { id })).result)) stages[e.STATUS_ID] = e.NAME;
    cache = { t: agora(), v: { ids, stages } };
    return cache.v;
  };
}

// ID do funil -> nome (para mostrar em que funil está cada negócio). Guardado por 5 minutos; sem nomes, a coluna fica vazia.
function criarFunisNomes(bitrix, { ttlMs = 300000, agora = Date.now } = {}) {
  let cache = null;
  return async () => {
    if (cache && agora() - cache.t < ttlMs) return cache.v;
    const v = { 0: 'Funil geral' };
    for (const c of arr((await bitrix.call('crm.dealcategory.list', { select: ['ID', 'NAME'] })).result)) v[c.ID] = c.NAME;
    cache = { t: agora(), v };
    return v;
  };
}

// Responsáveis cujos clientes NÃO podem aparecer: membros dos departamentos em `spec` (nomes ou IDs, separados por vírgula).
// Falha fechada: se não achar o departamento ou não conseguir ler os usuários, lança erro (nunca devolve "tudo liberado").
function criarExclusao(bitrix, spec, { ttlMs = 300000, agora = Date.now } = {}) {
  const itens = String(spec || '').split(',').map(x => x.trim()).filter(Boolean);
  let cache = null;
  return async () => {
    if (!itens.length) return [];
    if (cache && agora() - cache.t < ttlMs) return cache.ids;
    const deps = [];
    for (const it of itens) {
      if (/^\d+$/.test(it)) { deps.push(it); continue; }
      const achados = arr((await bitrix.call('department.get', { NAME: it })).result).filter(d => String(d.NAME).toLowerCase() === it.toLowerCase());
      if (!achados.length) throw new Error(`Departamento "${it}" não encontrado`);
      deps.push(...achados.map(d => String(d.ID)));
    }
    const ids = new Set(); let start = 0;
    for (;;) {
      const r = await bitrix.call('user.get', { FILTER: { UF_DEPARTMENT: deps }, start });
      arr(r.result).forEach(u => ids.add(String(u.ID)));
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    cache = { t: agora(), ids: [...ids] };
    return cache.ids;
  };
}

async function consultar(bitrix, texto, { inativoDias = 90, agora = Date.now, excluirResponsaveis, historico, usuario, orcamentos, funisNomes } = {}) {
  const q = String(texto || '').trim().replace(/\s+/g, ' ');
  if (q.length < 3) { const e = new Error('Digite pelo menos 3 letras do nome.'); e.status = 400; throw e; }
  const tokens = q.split(' ');
  const contatoFiltros = tokens.length === 1
    ? [{ '%NAME': q }, { '%LAST_NAME': q }]
    : [{ '%NAME': tokens[0], '%LAST_NAME': tokens[tokens.length - 1] }];
  const excl = excluirResponsaveis ? await excluirResponsaveis() : [];
  const semExcl = f => (excl.length ? { ...f, '!ASSIGNED_BY_ID': excl } : f);   // o próprio Bitrix já não devolve esses cadastros
  const sel = { select: ['ID', 'ASSIGNED_BY_ID'], order: { ID: 'DESC' } };
  const busca = { emp: { method: 'crm.company.list', params: { ...sel, select: ['ID', 'TITLE', 'ASSIGNED_BY_ID'], filter: semExcl({ '%TITLE': q }) } } };
  contatoFiltros.forEach((f, i) => {
    busca['c' + i] = { method: 'crm.contact.list', params: { ...sel, select: ['ID', 'NAME', 'LAST_NAME', 'ASSIGNED_BY_ID'], filter: semExcl(f) } };
  });
  const { result: r1 } = await bitrix.batch(busca);
  const clientes = [];
  for (const e of arr(r1.emp)) clientes.push({ tipo: 'Empresa', id: +e.ID, nome: e.TITLE || `Empresa #${e.ID}`, resp: e.ASSIGNED_BY_ID, ownerType: 4, dealField: 'COMPANY_ID' });
  const vistos = new Set();
  for (const k of Object.keys(r1).filter(k => k.startsWith('c'))) {
    for (const c of arr(r1[k])) {
      if (vistos.has(c.ID)) continue; vistos.add(c.ID);
      clientes.push({ tipo: 'Contato', id: +c.ID, nome: [c.NAME, c.LAST_NAME].filter(Boolean).join(' ') || `Contato #${c.ID}`, resp: c.ASSIGNED_BY_ID, ownerType: 3, dealField: 'CONTACT_ID' });
    }
  }
  const permitidos = clientes.filter(c => !excl.includes(String(c.resp)));   // segunda barreira, no próprio servidor
  const lista = permitidos.slice(0, 15);
  const maisResultados = permitidos.length > lista.length;
  if (!lista.length) return { resultados: [], maisResultados: false };

  // negócios (total + o mais recente) e atividades do próprio cadastro
  const cmds = {};
  for (const c of lista) {
    const k = `${c.ownerType}_${c.id}`;
    cmds['d' + k] = { method: 'crm.deal.list', params: { filter: { [c.dealField]: c.id }, order: { ID: 'DESC' }, select: ['ID', 'TITLE', 'STAGE_SEMANTIC_ID', 'DATE_CREATE', 'ASSIGNED_BY_ID', 'CATEGORY_ID'] } };
    cmds['a' + k] = { method: 'crm.activity.list', params: { filter: { OWNER_TYPE_ID: c.ownerType, OWNER_ID: c.id }, order: { CREATED: 'DESC' }, select: ['ID', 'SUBJECT', 'TYPE_ID', 'CREATED', 'COMPLETED'] } };
  }
  let funis = { ids: [], stages: {} }, orcErro = false;
  try { if (orcamentos) funis = await orcamentos(); } catch (e) { orcErro = true; console.error(e.message); }   // não derruba a busca
  if (funis.ids.length) {
    for (const c of lista) {
      cmds[`o${c.ownerType}_${c.id}`] = { method: 'crm.deal.list', params: { filter: { [c.dealField]: c.id, CATEGORY_ID: funis.ids }, order: { ID: 'DESC' }, select: ['ID', 'TITLE', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'DATE_CREATE', 'ASSIGNED_BY_ID'] } };
    }
  }
  const { result: r2, total: t2 } = await bitrix.batch(cmds);

  // atividades registradas nos negócios do cliente (até os 50 mais recentes)
  const cmds3 = {};
  for (const c of lista) {
    const k = `${c.ownerType}_${c.id}`, ids = arr(r2['d' + k]).map(d => +d.ID);
    if (ids.length) cmds3['a' + k] = { method: 'crm.activity.list', params: { filter: { OWNER_TYPE_ID: 2, OWNER_ID: ids }, order: { CREATED: 'DESC' }, select: ['ID', 'SUBJECT', 'TYPE_ID', 'CREATED', 'COMPLETED'] } };
  }
  const { result: r3, total: t3 } = Object.keys(cmds3).length ? await bitrix.batch(cmds3) : { result: {}, total: {} };

  // responsáveis
  const todosNegocios = lista.flatMap(c => arr(r2[`d${c.ownerType}_${c.id}`]));
  const chave = c => `${c.ownerType}_${c.id}`;
  const consultasDe = c => (historico ? historico.ler(chave(c)) : []).slice(0, 5);
  let nomesFunis = {}; try { if (funisNomes) nomesFunis = await funisNomes(); } catch (e) { console.error(e.message); }
  const respIds = [...new Set([...lista.map(c => c.resp), ...todosNegocios.map(d => d.ASSIGNED_BY_ID), ...lista.flatMap(c => consultasDe(c).map(e => e.u)), ...lista.flatMap(c => arr(r2[`o${c.ownerType}_${c.id}`]).map(d => d.ASSIGNED_BY_ID))].filter(Boolean))];
  const nomes = {};
  if (respIds.length) {
    try {
      for (const u of arr((await bitrix.call('user.get', { FILTER: { ID: respIds } })).result)) nomes[u.ID] = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || u.EMAIL || `Usuário #${u.ID}`;
    } catch { /* webhook sem escopo "user": mostra só o número */ }
  }

  const TIPOS = { 1: 'Reunião', 2: 'Ligação', 3: 'Tarefa', 4: 'E-mail', 6: 'Comentário' };
  const ativ = a => a && { assunto: a.SUBJECT || '(sem assunto)', tipo: TIPOS[a.TYPE_ID] || 'Atividade', data: a.CREATED, concluida: a.COMPLETED === 'Y' };
  // Ativo = houve negócio ou atividade nos últimos `inativoDias` dias.
  const diasDesde = d => { const t = Date.parse(d); return Number.isNaN(t) ? null : Math.floor((agora() - t) / 864e5); };
  const resultados = lista.map(c => {
    const k = `${c.ownerType}_${c.id}`;
    const d = arr(r2['d' + k]), proprias = arr(r2['a' + k]), dosNeg = arr(r3['a' + k]);
    const ultimaAtiv = [...proprias.slice(0, 1), ...dosNeg.slice(0, 1)].sort((x, y) => String(y.CREATED).localeCompare(String(x.CREATED)))[0];
    const u = d[0];
    const datas = [u?.DATE_CREATE, ultimaAtiv?.CREATED].map(diasDesde).filter(x => x !== null);
    const dias = datas.length ? Math.max(0, Math.min(...datas)) : null;
    return {
      orcamentos: orcErro ? { erro: true } : { total: +(t2[`o${k}`] ?? arr(r2[`o${k}`]).length), itens: arr(r2[`o${k}`]).map(o => ({
        titulo: o.TITLE, etapa: funis.stages[o.STAGE_ID] || SEMANTICA[o.STAGE_SEMANTIC_ID] || 'Em andamento', situacao: SEMANTICA[o.STAGE_SEMANTIC_ID] || 'Em andamento',
        data: o.DATE_CREATE, responsavel: o.ASSIGNED_BY_ID ? (nomes[o.ASSIGNED_BY_ID] || `Usuário #${o.ASSIGNED_BY_ID}`) : '' })) },
      consultas: consultasDe(c).map(e => ({ nome: nomes[e.u] || `Usuário #${e.u}`, data: e.t, voce: e.u === String(usuario) })),
      situacao: dias === null ? 'Sem histórico' : dias <= inativoDias ? 'Ativo' : 'Inativo',
      diasSemMovimento: dias,
      tipo: c.tipo, nome: c.nome,
      responsavel: c.resp ? (nomes[c.resp] || `Usuário #${c.resp}`) : 'Sem responsável',
      negocios: (() => {
        const sit = x => SEMANTICA[x.STAGE_SEMANTIC_ID] || 'Em andamento';
        const itens = d.map(x => ({ titulo: x.TITLE, funil: nomesFunis[x.CATEGORY_ID] || '', situacao: sit(x), data: x.DATE_CREATE, responsavel: x.ASSIGNED_BY_ID ? (nomes[x.ASSIGNED_BY_ID] || `Usuário #${x.ASSIGNED_BY_ID}`) : '' }));
        const conta = n => itens.filter(i => i.situacao === n).length;   // dos negócios listados (os 50 mais recentes)
        return { total: +(t2['d' + k] ?? d.length), ganhos: conta('Ganho'), perdidos: conta('Perdido'), andamento: conta('Em andamento'), itens, ultimo: itens[0] };
      })(),
      atividades: { total: +(t2['a' + k] ?? proprias.length) + +(t3['a' + k] ?? dosNeg.length), ultima: ativ(ultimaAtiv) },
    };
  });
  // registra só depois de montar a resposta: o histórico mostrado é o das consultas anteriores
  if (historico && usuario !== undefined) for (const c of lista) historico.registrar(chave(c), usuario);
  return { resultados, maisResultados };
}

module.exports = { createBitrix, consultar, criarExclusao, criarOrcamentos, criarFunisNomes, qs };
