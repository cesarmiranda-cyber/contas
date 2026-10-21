'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createBitrix } = require('./lib/bitrix');
const { createStore } = require('./lib/store');
const { createService } = require('./lib/service');
const { request } = require('./lib/http');
const R = require('./lib/rules');
const D = require('./lib/duplicados');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = createStore(DATA_DIR);
const bitrix = createBitrix(process.env.BITRIX_WEBHOOK || '');
const svc = createService({ bitrix, store });
const EVENT_TOKEN = process.env.EVENT_TOKEN || '';

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) { no(new Error('payload grande')); req.destroy(); } });
  req.on('end', () => {
    try { ok(b ? ((req.headers['content-type'] || '').includes('json') ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b))) : {}); } catch (e) { no(e); }
  });
});
const exige = () => { if (!bitrix.enabled) throw Object.assign(new Error('Defina BITRIX_WEBHOOK (webhook de entrada do Bitrix24).'), { status: 503 }); };

// Usuário logado: gateway da Vibe injeta X-Vibe-Authorization (precisa da chave do app em VIBE_APP_KEY); senão, o seletor da tela (?uid).
async function quem(req, u) {
  const bearer = req.headers['x-vibe-authorization'];
  if (bearer && process.env.VIBE_APP_KEY) {
    try {
      const r = await request('https://vibecode.bitrix24.com/v1/me', { headers: { 'X-Api-Key': process.env.VIBE_APP_KEY, Authorization: bearer } });
      const id = r.json?.data?.currentUser?.bitrixUserId;
      if (id) return { uid: +id, verificado: true };
    } catch { /* cai no seletor */ }
  }
  const uid = +(u.searchParams.get('uid') || 0);
  return { uid: uid || null, verificado: false };
}

const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /api/eu': async (_, __, id) => ({ ...id, admin: id.uid ? svc.isAdmin(id.uid) : false, nome: id.uid ? await svc.nomeUsuario(id.uid) : '' }),
  'GET /api/usuarios': async () => { exige(); return svc.usuarios(); },
  'GET /api/visitas': async (u, _, id) => { exige(); return svc.listarVisitas({ uid: id.uid, escopo: u.searchParams.get('escopo') || 'minhas' }); },
  'GET /api/historico': async () => ({ reprogramacoes: store.historico }),
  'GET /api/log': async () => ({ log: store.logs.slice(0, 200), bloqueios: store.bloqueios }),
  'GET /api/config': async () => ({ config: store.config, hoje: R.todayBR(), webhook: bitrix.enabled, ultimaVarredura: store.lastSweep }),
  'PUT /api/config': async (_, b, id) => {
    if (!svc.isAdmin(id.uid) && (store.config.admins || []).length) throw Object.assign(new Error('Apenas administradores.'), { status: 403 });
    const p = {};
    if (b.intervalos && typeof b.intervalos === 'object') {
      p.intervalos = {};
      for (const c of R.CARGOS) for (const k of R.CLASSES) { const n = +b.intervalos?.[c]?.[k]; if (Number.isInteger(n) && n > 0 && n < 1000) (p.intervalos[c] ||= {})[k] = n; }
    }
    if (Number.isInteger(+b.horaJob) && +b.horaJob >= 0 && +b.horaJob < 24) p.horaJob = +b.horaJob;
    for (const k of ['tarefaAtiva', 'atualizarProxima']) if (typeof b[k] === 'boolean') p[k] = b[k];
    if (typeof b.ativo === 'boolean') p.ativo = b.ativo;
    if (Number.isFinite(+b.tarefaHorasUteis) && +b.tarefaHorasUteis > 0) p.tarefaHorasUteis = +b.tarefaHorasUteis;
    if (['secao', 'extra'].includes(b.motoresDatas)) p.motoresDatas = b.motoresDatas;
    if (Array.isArray(b.admins)) p.admins = b.admins.map(Number).filter(Boolean);
    if (b.mapaManual && typeof b.mapaManual === 'object') p.mapaManual = b.mapaManual;
    store.log('config', `Configuração alterada por ${id.uid || 'desconhecido'}`);
    const c = store.setConfig(p); await svc.campos(true).catch(() => {}); return c;
  },
  'GET /api/campos': async (u) => { exige(); return svc.campos(u.searchParams.get('refresh') === '1'); },
  'GET /api/duplicados': async () => { exige(); const a = await D.analisar(bitrix); return { ...a, plano: D.planejar(a) }; },
  'POST /api/sincronizar': async (_, b) => { exige(); return b.empresa ? svc.sincronizarEmpresa(+b.empresa, { forcar: !!b.forcar }) : svc.sincronizarTodas(); },
  'POST /api/job': async (_, b) => { exige(); return svc.jobDiario({ forcar: !!b.forcar }); },
  'POST /api/varrer': async () => { exige(); return svc.varrer(); },
  'POST /api/visitas/corrigir': async (_, b, id) => { exige(); return svc.corrigirVisita(+b.id, { uid: id.uid, dataHora: b.dataHora, motivo: b.motivo }); },
};
// Eventos do Bitrix24 (ONCRMCOMPANYADD/UPDATE, ONCRMDYNAMICITEMUPDATE...): disparam uma varredura imediata.
let agendada = null;
const acorda = () => { if (agendada) return; agendada = setTimeout(() => { agendada = null; svc.varrer().catch(e => store.log('erro', `varredura: ${e.message}`)); }, 1500); };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/events' && req.method === 'POST') {
      if (EVENT_TOKEN && u.searchParams.get('token') !== EVENT_TOKEN) return send(res, 403, { error: 'token inválido' });
      await readBody(req).catch(() => ({})); acorda(); return send(res, 200, { ok: true });
    }
    const key = `${req.method} ${u.pathname}`;
    if (routes[key]) {
      const id = await quem(req, u);
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, await routes[key](u, body, id));
    }
    let m = u.pathname.match(/^\/api\/cards\/(\d+)\/(registrar|reprogramar)$/);
    if (m && req.method === 'POST') {
      exige();
      const id = await quem(req, u), b = await readBody(req);
      const uid = id.verificado ? id.uid : +(b.uid || id.uid) || null;
      return send(res, 200, m[2] === 'registrar' ? await svc.registrarVisita(+m[1], { ...b, uid }) : await svc.reprogramar(+m[1], { ...b, uid }));
    }
    if (req.method === 'GET') {
      const root = path.join(__dirname, 'public');
      const f = path.join(root, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    store.log('erro', `${req.method} ${u.pathname}: ${e.message}`);
    send(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Fila de Visitas DLC em :${PORT} · Bitrix ${bitrix.enabled ? 'configurado' : 'SEM WEBHOOK (defina BITRIX_WEBHOOK)'}`);
  const tick = () => bitrix.enabled && svc.varrer().then(r => r && !r.pulado && !r.pausado && console.log('varredura', JSON.stringify(r))).catch(e => { store.log('erro', `varredura: ${e.message}`); console.error('varredura:', e.message); });
  if (bitrix.enabled && process.env.ANALISE_DUPLICADOS) setTimeout(() => D.analisar(bitrix).then(a => { const p = D.planejar(a); console.log('duplicados', JSON.stringify({ empresas: a.empresas, apagar: p.apagar.map(c => `${c.id}:${c.campo}:${c.rotulo}`), manter: p.manter.map(c => `${c.id}:${c.campo}:${c.rotulo}:${c.comValor}`), conflitos: p.conflitos.map(g => g.campos.map(c => `${c.campo}=${c.comValor}`)) })); }).catch(e => console.error('duplicados:', e.message)), 3000);
  if (bitrix.enabled) setTimeout(() => svc.campos(true).then(d => console.log('campos', JSON.stringify({ faltando: d.faltando, ambiguos: d.ambiguos, fila: d.map.fila, visita: d.map.visita, etapas: d.map.etapas, cat: d.map.categoriaFila, tipo: d.map.tipoEmpresa, motores: d.map.empresa.Motores }))).catch(e => console.error('campos:', e.message)), 1000);
  setTimeout(tick, 5000);
  setInterval(tick, Math.max(30, store.config.sweepSegundos) * 1000);
});
