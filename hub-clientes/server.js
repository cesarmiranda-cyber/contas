'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createVibe } = require('./lib/vibe');
const { createStore } = require('./lib/store');
const M = require('./lib/metrics');

const CATEGORIA = +process.env.CATEGORY_ID || 0;           // funil de contratos ativos (Bitrix24: /crm/deal/kanban/category/0/)
const PORTAL = process.env.PORTAL_HOST || 'manda4.bitrix24.com.br';
const CAMPO_RENOV = process.env.RENEWAL_FIELD || 'ufCrm_1771112861536';   // "Próxima Renovação Bitrix24" (referência do ciclo)
const SELECT = CAMPO_RENOV + ',id,title,stageId,companyId,contactId,amount,currency,assignedById,begindate,movedTime,stageSemanticId';
const CANAIS = ['reuniao', 'video', 'whatsapp', 'telefone', 'email', 'outro'];
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'self' https://*.bitrix24.com.br https://*.bitrix24.com https://*.bitrix24.com.ar https://*.bitrix24.es https://*.bitrix24.eu https://*.bitrix24.net https://*.bitrix24.ru",
};
const bad = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const fmtData = d => d ? d.split('-').reverse().join('/') : '';
const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };

function createApp({ vibe, store, now = () => new Date(), allowAnon = false }) {
  const cache = new Map();
  const memo = async (k, ttl, fn) => {
    const c = cache.get(k); if (c && Date.now() - c.t < ttl) return c.v;
    const v = await fn(); cache.set(k, { t: Date.now(), v }); return v;
  };
  const invalidar = () => cache.delete('deals');
  const hoje = () => M.todayBR(now());

  const etapas = () => memo('etapas', 600000, async () => M.etapas(await vibe.get('/statuses', { 'filter[entityId]': CATEGORIA ? `DEAL_STAGE_${CATEGORIA}` : 'DEAL_STAGE', limit: 100 })));
  const usuarios = () => memo('users', 600000, async () => {
    const r = await vibe.get('/users', { limit: 500 }).catch(() => []);
    return Object.fromEntries(r.map(u => [u.id, [u.name, u.lastName].filter(Boolean).join(' ') || `Usuário ${u.id}`]));
  });
  const deals = () => memo('deals', 20000, () => vibe.get('/deals', { 'filter[categoryId]': CATEGORIA, select: SELECT, limit: 5000 }));
  // Nome do cliente: empresa vinculada ao card; sem empresa, o contato (vendas repetidas vêm com título genérico).
  const nomes = async (ds, campo, rota, select, nome) => {
    const ids = [...new Set(ds.filter(d => !(campo === 'contactId' && d.companyId)).map(d => d[campo]).filter(Boolean))];
    return memo(rota + ':' + ids.join(','), 600000, async () => {
      const out = {};
      for (let i = 0; i < ids.length; i += 50) {
        const r = await vibe.get(rota, { 'filter[id][$in]': ids.slice(i, i + 50).join(','), select, limit: 50 }).catch(() => []);
        for (const c of r) out[c.id] = nome(c);
      }
      return out;
    });
  };

  async function estado(mes) {
    const [et, ds, us] = await Promise.all([etapas(), deals(), usuarios()]);
    const [emp, con] = await Promise.all([nomes(ds, 'companyId', '/companies', 'id,title', c => c.title), nomes(ds, 'contactId', '/contacts', 'id,name,lastName', c => [c.name, c.lastName].filter(Boolean).join(' ') || null)]), h = hoje();
    const registros = store.all();
    const lista = M.clientes({ deals: ds, etapa: et, registros, empresas: emp, contatos: con, usuarios: us, mes, hoje: h, campo: CAMPO_RENOV });
    const ativos = lista.filter(c => c.tipoEtapa === 'mes');
    const ids = new Set(ativos.map(c => c.id));
    return {
      hoje: h, mes, portal: PORTAL, canais: CANAIS,
      etapas: et.meses.map(e => ({ id: e.id, nome: e.nome, mes: e.mes })), ganho: et.ganho?.nome, perdido: et.perdido?.nome,
      clientes: lista, sync, campoRenov: CAMPO_RENOV,
      registros: registros.filter(r => ids.has(r.dealId)),
      dashboard: M.dashboard({ lista, etapa: et, registros: registros.filter(r => ids.has(r.dealId)), mes, hoje: h }),
    };
  }

  function validarRegistro(b, h) {
    const dealId = +b.dealId; if (!Number.isInteger(dealId) || dealId <= 0) throw bad(400, 'Cliente inválido.');
    const mes = String(b.mes || ''); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw bad(400, 'Mês inválido (use AAAA-MM).');
    if (mes > h.slice(0, 7)) throw bad(400, 'Não é possível registrar um mês futuro.');
    const reuniaoRealizada = b.reuniaoRealizada === true;
    const contatoFeito = reuniaoRealizada || b.contatoFeito === true;
    const data = b.data ? String(b.data) : '';
    if (data && (!/^\d{4}-\d{2}-\d{2}$/.test(data) || isNaN(Date.parse(data)))) throw bad(400, 'Data inválida.');
    if (data > h) throw bad(400, 'A data do contato não pode ser futura.');
    if (contatoFeito && !data) throw bad(400, 'Informe a data do contato/reunião.');
    const canal = contatoFeito ? txt(b.canal, 20) : '';
    if (contatoFeito && !CANAIS.includes(canal)) throw bad(400, 'Informe o canal do contato.');
    const saude = b.saude ? String(b.saude) : '';
    if (saude && !['verde', 'amarelo', 'vermelho'].includes(saude)) throw bad(400, 'Saúde inválida.');
    const renovacao = b.renovacao ? String(b.renovacao) : '';
    if (renovacao && !['provavel', 'indefinido', 'improvavel'].includes(renovacao)) throw bad(400, 'Intenção de renovação inválida.');
    const proximoContato = b.proximoContato ? String(b.proximoContato) : '';
    if (proximoContato && !/^\d{4}-\d{2}-\d{2}$/.test(proximoContato)) throw bad(400, 'Data do próximo contato inválida.');
    return {
      dealId, mes, reuniaoRealizada, contatoFeito, data: contatoFeito ? data : '', canal,
      motivo: contatoFeito ? '' : txt(b.motivo, 1000), participantes: txt(b.participantes, 300), resumo: txt(b.resumo, 4000),
      proximosPassos: txt(b.proximosPassos, 2000), proximoContato, saude, renovacao,
    };
  }

  async function comentar(dealId, comment) {
    try { await vibe.post('/timelines', { entityType: 'deal', entityId: dealId, comment }); return true; } catch { return false; }
  }

  const rotulo = r => r.reuniaoRealizada ? 'Reunião realizada' : r.contatoFeito ? 'Contato feito (sem reunião)' : 'Sem contato';
  function textoRegistro(r, nome) {
    const l = [`[B]Registro mensal ${r.mes.split('-').reverse().join('/')} — ${rotulo(r)}[/B]`];
    if (r.data) l.push(`Data: ${fmtData(r.data)} · Canal: ${r.canal}`);
    if (r.motivo) l.push(`Motivo: ${r.motivo}`);
    if (r.participantes) l.push(`Participantes: ${r.participantes}`);
    if (r.resumo) l.push(`Resumo: ${r.resumo}`);
    if (r.proximosPassos) l.push(`Próximos passos: ${r.proximosPassos}`);
    if (r.proximoContato) l.push(`Próximo contato: ${fmtData(r.proximoContato)}`);
    const ex = [r.saude && `Saúde: ${r.saude}`, r.renovacao && `Renovação: ${r.renovacao}`].filter(Boolean);
    if (ex.length) l.push(ex.join(' · '));
    l.push(`Registrado por ${nome} (Hub de Clientes)`);
    return l.join('\n');
  }

  const routes = {
    'GET /health': async () => ({ ok: true }),
    'GET /api/estado': async (u) => {
      const h = hoje(), mes = u.searchParams.get('mes') || h.slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw bad(400, 'Mês inválido.');
      return estado(mes);
    },
    'POST /api/registros': async (_, body, who) => {
      const h = hoje(), r = validarRegistro(body, h);
      const d = (await deals()).find(x => x.id === r.dealId);
      const et = await etapas();
      if (!d || et.porId[d.stageId]?.tipo !== 'mes') throw bad(404, 'Cliente não está em uma etapa ativa do funil.');
      const ant = store.get(r.dealId, r.mes);
      const salvo = store.upsert({ ...r, criadoEm: new Date().toISOString(), criadoPor: who.nome, atualizadoEm: new Date().toISOString(), atualizadoPor: who.nome });
      const timeline = await comentar(r.dealId, (ant ? '[B](atualizado)[/B] ' : '') + textoRegistro(salvo, who.nome));
      return { registro: salvo, timeline };
    },
    'DELETE /api/registros': async (u) => {
      const dealId = +u.searchParams.get('dealId'), mes = u.searchParams.get('mes') || '';
      if (!store.remove(dealId, mes)) throw bad(404, 'Registro não encontrado.');
      return { ok: true };
    },
  };

  // POST /api/clientes/:id/mover  { acao: avancar | renovar | cancelar }
  async function mover(id, body, who) {
    const [d, et] = await Promise.all([deals().then(ds => ds.find(x => x.id === id)), etapas()]);
    const atual = d && et.porId[d.stageId]; if (!d || !atual) throw bad(404, 'Cliente não encontrado no funil.');
    const dest = M.destino(String(body.acao), atual, et);
    if (dest.erro) throw bad(400, dest.erro);
    await vibe.patch(`/deals/${id}`, { stageId: dest.etapa.id });
    invalidar();
    const timeline = await comentar(id, `[B]Ciclo do cliente:[/B] ${atual.nome} → ${dest.etapa.nome} (${body.acao}) por ${who.nome} (Hub de Clientes)`);
    return { de: atual.nome, para: dest.etapa.nome, timeline };
  }

  // Ajusta a etapa de cada card pela Próxima Renovação (Mês = 12 − meses até renovar). Renovação vencida ou sem data não é movida.
  let sync = { quando: null, movidos: [], erro: null }, rodando = false;
  async function sincronizar(aplicar, quem = 'Hub de Clientes') {
    const [et, ds] = await Promise.all([etapas(), vibe.get('/deals', { 'filter[categoryId]': CATEGORIA, select: SELECT, limit: 5000 })]);
    const pl = M.plano({ deals: ds, etapa: et, hoje: hoje(), campo: CAMPO_RENOV });
    if (!aplicar) return pl;
    if (rodando) throw bad(409, 'Sincronização já em andamento.');
    rodando = true; const feitos = [];
    try {
      for (const m of pl.mover) {
        await vibe.patch(`/deals/${m.id}`, { stageId: m.paraId });
        await comentar(m.id, `[B]Ciclo do cliente:[/B] ${m.de} → ${m.para}. Etapa ajustada pela Próxima Renovação Bitrix24 (${fmtData(m.renovacao)}) por ${quem}.`);
        feitos.push(m);
      }
    } finally { rodando = false; invalidar(); sync = { quando: new Date().toISOString(), movidos: feitos, erro: null }; }
    return { ...pl, movidos: feitos };
  }
  routes['GET /api/sincronizar'] = async () => ({ ...(await sincronizar(false)), ultima: sync });
  routes['POST /api/sincronizar'] = async (_, __, who) => sincronizar(true, who.nome);

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'GET' && u.pathname === '/health') return send(200, { ok: true });
      const uid = +req.headers['x-vibe-user-id'];
      if (u.pathname.startsWith('/api/') && !uid && !allowAnon) throw bad(401, 'Abra o app pelo Bitrix24 (identidade não encontrada).');
      const who = { id: uid || 0, nome: decode(req.headers['x-vibe-user-name'] || '') || `Usuário ${uid || '?'}` };
      if (u.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') {
          const sf = req.headers['sec-fetch-site'];
          if (sf ? !(sf === 'same-origin' || sf === 'none') : (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`)) throw bad(403, 'Origem não permitida.');
        }
        const mm = /^\/api\/clientes\/(\d+)\/mover$/.exec(u.pathname);
        if (mm && req.method === 'POST') return send(200, await mover(+mm[1], await readBody(req), who));
        const fn = routes[`${req.method} ${u.pathname}`]; if (!fn) throw bad(404, 'Rota não encontrada.');
        const body = req.method === 'POST' ? await readBody(req) : {};
        const r = await fn(u, body, who);
        if (req.method !== 'GET') invalidar();
        return send(200, r);
      }
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        res.writeHead(200, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      }
      send(404, { error: 'Não encontrado.' });
    } catch (e) {
      send(e.status || 500, { error: e.status ? e.message : 'Erro interno.' });
      if (!e.status) console.error(e);
    }
  }
  return { handle, estado, sincronizar, ultimaSync: () => sync, falhaSync: e => { sync = { ...sync, quando: new Date().toISOString(), erro: String(e.message || e) }; } };
}

const readBody = req => new Promise((ok, no) => {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return no(bad(415, 'Content-Type deve ser application/json.'));
  const ch = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > 1e6) { no(bad(413, 'Corpo grande demais.')); req.destroy(); } else ch.push(c); });
  req.on('end', () => { try { const v = JSON.parse(Buffer.concat(ch).toString('utf8') || '{}'); v && typeof v === 'object' && !Array.isArray(v) ? ok(v) : no(bad(400, 'Corpo deve ser um objeto JSON.')); } catch { no(bad(400, 'JSON inválido.')); } });
  req.on('error', () => no(bad(400, 'Requisição interrompida.')));
});

if (require.main === module) {
  const vibe = createVibe({ key: process.env.VIBE_KEY });
  const store = createStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const app = createApp({ vibe, store });
  const port = +process.env.PORT || 3000;
  http.createServer(app.handle).listen(port, () => console.log(`Hub de Clientes na porta ${port}`));
  // Quando o mês vira, os cards avançam sozinhos (desligue com AUTO_MOVE=0). Roda ao iniciar e a cada 6 horas.
  if (process.env.AUTO_MOVE !== '0' && vibe.enabled) {
    const ciclo = () => app.sincronizar(true).then(r => r.movidos.length && console.log('Etapas ajustadas:', r.movidos.map(m => `${m.id} ${m.de}→${m.para}`).join(', '))).catch(e => { app.falhaSync(e); console.error('sync:', e.message); });
    setTimeout(ciclo, 30000); setInterval(ciclo, 6 * 3600 * 1000);
  }
}
module.exports = { createApp };
