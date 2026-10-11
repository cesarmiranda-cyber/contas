'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createBitrix } = require('./lib/bitrix');
const { createAsaas } = require('./lib/asaas');
const { createStore } = require('./lib/store');
const { createService } = require('./lib/service');
const R = require('./lib/rules');

// .env opcional (a plataforma de deploy já injeta as variáveis no processo).
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* sem .env */ }

const PORT = +process.env.PORT || 3000;
const SYNC_MIN = +process.env.SYNC_MINUTES || 10;
const store = createStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
const bitrix = createBitrix(process.env.BITRIX_WEBHOOK);
const asaas = createAsaas({ apiKey: process.env.ASAAS_API_KEY, env: process.env.ASAAS_ENV || 'sandbox' });
const svc = createService({ bitrix, asaas, store });

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) { no(new Error('payload grande')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
});

const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /api/state': async () => {
    const deals = await svc.dealsCached();
    return {
      config: store.config, asaas: { enabled: asaas.enabled, env: asaas.env },
      kpis: svc.kpis(deals), deals, lastSync: store.lastSync, logs: store.logs.slice(0, 50),
      hoje: R.todayBR(),
    };
  },
  'POST /api/sync': async () => svc.sync({ trigger: 'manual' }),
  'PUT /api/config': async (_, body) => {
    const p = {};
    if (typeof body.autoCreate === 'boolean') p.autoCreate = body.autoCreate;
    if (typeof body.reguaAtiva === 'boolean') p.reguaAtiva = body.reguaAtiva;
    if (Array.isArray(body.reguaOffsets)) p.reguaOffsets = body.reguaOffsets.map(Number).filter(Number.isInteger).slice(0, 12);
    for (const k of ['diasProximo', 'multaPct', 'jurosMensalPct', 'alertaAtrasoDias']) if (body[k] !== undefined && !isNaN(+body[k])) p[k] = +body[k];
    svc.invalidate();
    return store.setConfig(p);
  },
  'POST /api/gerar': async (_, body) => svc.gerar(body),
  'GET /api/clientes': async (u) => svc.findCustomers(u.searchParams.get('q') || ''),
};
const dealRoutes = {
  charge: async c => { await svc.createCharge(c); svc.invalidate(); return { ok: true }; },
  remind: async c => {
    if (!c.venc) throw new Error('Sem vencimento');
    const d = R.dayDiff(R.todayBR(), c.venc);
    await svc.triggerReminder(c, store.config.reguaOffsets.filter(o => o <= d).pop() ?? 0, { manual: true });
    svc.invalidate(); return { ok: true };
  },
  cancel: async c => { await svc.cancel(c); return { ok: true }; },
  doc: async (c, body) => { await svc.setDoc(c.id, body.doc); return { ok: true }; },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    const key = `${req.method} ${u.pathname}`;
    if (routes[key]) return send(res, 200, await routes[key](u, ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {}));
    const m = u.pathname.match(/^\/api\/deals\/(\d+)\/(charge|remind|cancel|doc)$/);
    if (m && req.method === 'POST') {
      const c = await svc.byId(m[1]);
      if (!c) return send(res, 404, { error: 'Deal não encontrada no funil 90' });
      return send(res, 200, await dealRoutes[m[2]](c, await readBody(req)));
    }
    if (req.method === 'GET') {
      const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (f.startsWith(path.join(__dirname, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        return fs.createReadStream(f).pipe(res);
      }
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    store.log('erro', `${req.method} ${u.pathname}: ${e.message}`);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Contas a Receber em :${PORT} · Asaas ${asaas.enabled ? asaas.env : 'DESLIGADO (sem ASAAS_API_KEY)'} · sync a cada ${SYNC_MIN} min`);
  setTimeout(() => svc.sync().then(r => console.log('sync inicial', JSON.stringify(r))).catch(e => console.error(e)), 5000);
  setInterval(() => svc.sync().catch(e => console.error('sync', e.message)), SYNC_MIN * 60 * 1000);
});
