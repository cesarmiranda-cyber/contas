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
  const base = String(webhook || '').replace(/\/+$/, '');
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

async function consultar(bitrix, texto) {
  const q = String(texto || '').trim().replace(/\s+/g, ' ');
  if (q.length < 3) { const e = new Error('Digite pelo menos 3 letras do nome.'); e.status = 400; throw e; }
  const tokens = q.split(' ');
  const contatoFiltros = tokens.length === 1
    ? [{ '%NAME': q }, { '%LAST_NAME': q }]
    : [{ '%NAME': tokens[0], '%LAST_NAME': tokens[tokens.length - 1] }];
  const sel = { select: ['ID', 'ASSIGNED_BY_ID'], order: { ID: 'DESC' } };
  const busca = { emp: { method: 'crm.company.list', params: { ...sel, select: ['ID', 'TITLE', 'ASSIGNED_BY_ID'], filter: { '%TITLE': q } } } };
  contatoFiltros.forEach((f, i) => {
    busca['c' + i] = { method: 'crm.contact.list', params: { ...sel, select: ['ID', 'NAME', 'LAST_NAME', 'ASSIGNED_BY_ID'], filter: f } };
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
  const lista = clientes.slice(0, 15);
  const maisResultados = clientes.length > lista.length;
  if (!lista.length) return { resultados: [], maisResultados: false };

  // negócios (total + o mais recente) e atividades do próprio cadastro
  const cmds = {};
  for (const c of lista) {
    const k = `${c.ownerType}_${c.id}`;
    cmds['d' + k] = { method: 'crm.deal.list', params: { filter: { [c.dealField]: c.id }, order: { ID: 'DESC' }, select: ['ID', 'TITLE', 'STAGE_SEMANTIC_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE'] } };
    cmds['a' + k] = { method: 'crm.activity.list', params: { filter: { OWNER_TYPE_ID: c.ownerType, OWNER_ID: c.id }, order: { CREATED: 'DESC' }, select: ['ID', 'SUBJECT', 'TYPE_ID', 'CREATED', 'COMPLETED'] } };
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
  const respIds = [...new Set(lista.map(c => c.resp).filter(Boolean))];
  const nomes = {};
  if (respIds.length) {
    try {
      for (const u of arr((await bitrix.call('user.get', { FILTER: { ID: respIds } })).result)) nomes[u.ID] = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || u.EMAIL || `Usuário #${u.ID}`;
    } catch { /* webhook sem escopo "user": mostra só o número */ }
  }

  const TIPOS = { 1: 'Reunião', 2: 'Ligação', 3: 'Tarefa', 4: 'E-mail', 6: 'Comentário' };
  const ativ = a => a && { assunto: a.SUBJECT || '(sem assunto)', tipo: TIPOS[a.TYPE_ID] || 'Atividade', data: a.CREATED, concluida: a.COMPLETED === 'Y' };
  const resultados = lista.map(c => {
    const k = `${c.ownerType}_${c.id}`;
    const d = arr(r2['d' + k]), proprias = arr(r2['a' + k]), dosNeg = arr(r3['a' + k]);
    const ultimaAtiv = [...proprias.slice(0, 1), ...dosNeg.slice(0, 1)].sort((x, y) => String(y.CREATED).localeCompare(String(x.CREATED)))[0];
    const u = d[0];
    return {
      tipo: c.tipo, nome: c.nome,
      responsavel: c.resp ? (nomes[c.resp] || `Usuário #${c.resp}`) : 'Sem responsável',
      negocios: { total: +(t2['d' + k] ?? d.length), ultimo: u && { titulo: u.TITLE, situacao: SEMANTICA[u.STAGE_SEMANTIC_ID] || 'Em andamento', data: u.DATE_CREATE, valor: +u.OPPORTUNITY || 0, moeda: u.CURRENCY_ID } },
      atividades: { total: +(t2['a' + k] ?? proprias.length) + +(t3['a' + k] ?? dosNeg.length), ultima: ativ(ultimaAtiv) },
    };
  });
  return { resultados, maisResultados };
}

module.exports = { createBitrix, consultar, qs };
