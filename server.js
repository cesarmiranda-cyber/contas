'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createBitrix } = require('./lib/bitrix');
const { createAsaas } = require('./lib/asaas');
const { createStore } = require('./lib/store');
const { createService } = require('./lib/service');
const { createSecrets } = require('./lib/secrets');
const { createSettingsApi } = require('./lib/settingsApi');
const R = require('./lib/rules');
const { createFinStore } = require('./lib/finStore');
const { createEmpresas } = require('./lib/empresas');
const { createAsaasRouter } = require('./lib/asaasRouter');
const { createFinApi } = require('./lib/finApi');

// .env opcional (a plataforma de deploy já injeta as variáveis no processo).
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* sem .env */ }

const PORT = +process.env.PORT || 3000;
const SYNC_MIN = +process.env.SYNC_MINUTES || 10;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = createStore(DATA_DIR);
const secrets = createSecrets(DATA_DIR);
const bitrix = createBitrix('');
const asaasBase = createAsaas({});
const fin = createFinStore(DATA_DIR);
const empresas = createEmpresas({ fin, secrets, bitrix, createAsaas });
// Multiempresa: cada empresa pode ter a própria chave do Asaas; quem não tem usa a conta padrão.
const asaas = createAsaasRouter({ base: asaasBase, clientFor: id => empresas.clientFor(id), allClients: () => empresas.allClients() });
const svc = createService({ bitrix, asaas, store, empresas });
const finApi = createFinApi({ fin, empresas, svc, bitrix, asaas, store, dataDir: DATA_DIR });
const settings = createSettingsApi({ secrets, asaas: asaasBase, bitrix, store, svc });
settings.apply(); // credenciais do painel (se houver) ou das variáveis de ambiente

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = (req, limit = 1e6) => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > limit) { no(new Error('payload grande')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
});

const routes = {
  ...settings.routes,
  'GET /health': async () => ({ ok: true }),
  'POST /api/sync-empresas': async () => empresas.sincronizarCampo(),
  'GET /api/state': async (u) => {
    if (!bitrix.enabled) { const e = new Error('Bitrix24 não configurado'); e.status = 503; throw e; }
    const q = u.searchParams;
    const { deals, kpis, escopo } = await svc.estado({ deal: q.get('deal'), company: q.get('company'), contact: q.get('contact') });
    return {
      config: store.config, asaas: { enabled: asaas.enabled, env: asaas.env }, escopo,
      kpis, deals, lastSync: store.lastSync, lastQuick: store.lastQuick, logs: escopo ? store.logs.filter(l => l.deal && deals.some(d => d.id === l.deal)).slice(0, 50) : store.logs.slice(0, 50),
      hoje: R.todayBR(),
      listas: { categorias: Object.values((await svc.loadEnums()).categoria), planos: Object.values((await svc.loadEnums()).plano), licenca: R.CATEGORIA_LICENCA },
    };
  },
  'POST /api/sync': async () => svc.sync({ trigger: 'manual' }),
  // Painel financeiro: geral, ou só do cliente quando vem ?deal= / ?company= / ?contact= (resolvido no servidor).
  'GET /api/dashboard': async (u) => {
    if (!bitrix.enabled) { const e = new Error('Bitrix24 não configurado'); e.status = 503; throw e; }
    const q = u.searchParams;
    return svc.painel({ deal: q.get('deal'), company: q.get('company'), contact: q.get('contact') });   // { escopo, dashes: { 3, 6, 12 } }
  },
  'PUT /api/config': async (_, body) => {
    const p = {};
    if (typeof body.autoCreate === 'boolean') p.autoCreate = body.autoCreate;
    if (typeof body.reguaAtiva === 'boolean') p.reguaAtiva = body.reguaAtiva;
    if (Array.isArray(body.reguaOffsets)) p.reguaOffsets = body.reguaOffsets.map(Number).filter(Number.isInteger).slice(0, 12);
    if (typeof body.importAuto === 'boolean') p.importAuto = body.importAuto;
    if (body.importDias !== undefined && !isNaN(+body.importDias)) p.importDias = Math.max(1, Math.min(730, +body.importDias));
    for (const k of ['diasProximo', 'multaPct', 'jurosMensalPct', 'alertaAtrasoDias']) if (body[k] !== undefined && !isNaN(+body[k])) p[k] = +body[k];
    svc.invalidate();
    return store.setConfig(p);
  },
  'POST /api/gerar': async (_, body) => svc.gerar(body),
  'POST /api/cobrar': async (_, body) => svc.cobrar.nova(body),
  'GET /api/links': async () => store.links,
  'GET /api/assinaturas': async (u) => svc.cobrar.assinaturas({ status: ['ACTIVE', 'INACTIVE', 'EXPIRED'].includes(u.searchParams.get('status')) ? u.searchParams.get('status') : undefined }),
  'GET /api/carteiras': async () => store.wallets,
  'POST /api/carteiras': async (_, b) => {
    const nome = String(b.nome || '').trim(), walletId = String(b.walletId || '').trim();
    const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
    if (nome.length < 2 || nome.length > 60) throw bad('Informe um nome de 2 a 60 caracteres.');
    if (/[=;%]/.test(nome)) throw bad('O nome não pode ter os caracteres = ; %');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(walletId)) throw bad('walletId inválido: use o ID da carteira do Asaas do recebedor (formato 00000000-0000-0000-0000-000000000000).');
    if (store.wallets.some(w => w.nome.toLowerCase() === nome.toLowerCase() && w.walletId !== walletId)) throw bad('Já existe uma carteira com esse nome.');
    store.log('config', `Carteira de split cadastrada: ${nome}`);
    return store.addWallet({ nome, walletId });
  },
  'POST /api/importar': async (_, body) => svc.importar({ dias: body.dias, dryRun: !!body.dryRun }),
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
  gerar: async c => svc.expandNow(c),
  detalhe: async c => svc.detalhe(c),
  receber: async (c, body) => svc.receberDinheiro(c, body),
  estornar: async (c, body) => svc.estornar(c, body),
  editar: async (c, body) => svc.editar(c, body),
  categoria: async (c, body) => { await svc.classify(c, String(body.categoria || ''), String(body.plano || '')); return { ok: true }; },
  doc: async (c, body) => { await svc.setDoc(c.id, body.doc); return { ok: true }; },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/fin/')) {
      const r = await finApi.handle(req.method, u.pathname, u, () => readBody(req, u.pathname === '/api/fin/anexos' ? 12e6 : u.pathname === '/api/fin/conciliacao/importar' ? 3e6 : 1e6));
      if (!r) return send(res, 404, { error: 'não encontrado' });
      if (r.json && r.json.__file) {   // anexo: sempre como download, tipo fixo pela extensão (nunca executa no navegador)
        res.writeHead(200, { 'Content-Type': r.json.__file.mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.json.__file.nome)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, no-store' });
        return res.end(r.json.__file.dados);
      }
      if (r.json && r.json.__csv !== undefined) {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${r.json.nome}"` });
        return res.end('\ufeff' + r.json.__csv);
      }
      return send(res, 200, r.json);
    }
    const key = `${req.method} ${u.pathname}`;
    if (req.method === 'DELETE' && routes[key]) return send(res, 200, await routes[key](u, {}));
    if (routes[key]) return send(res, 200, await routes[key](u, ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {}));
    const m = u.pathname.match(/^\/api\/deals\/(\d+)\/(charge|remind|cancel|doc|categoria|gerar|editar|detalhe|receber|estornar)$/);
    if (m && req.method === 'POST') {
      const c = await svc.byId(m[1]);
      if (!c) return send(res, 404, { error: 'Deal não encontrada no funil 90' });
      const body = await readBody(req);
      return send(res, 200, await asaas.as(c.empresa, () => dealRoutes[m[2]](c, body)));   // conta Asaas da empresa do card
    }
    const m2 = u.pathname.match(/^\/api\/(assinaturas|links|carteiras)\/([\w.-]+)$/);
    if (m2 && (req.method === 'PUT' || req.method === 'DELETE')) {
      const [, kind, id] = m2;
      if (kind === 'assinaturas') return send(res, 200, req.method === 'PUT' ? await svc.cobrar.editarAssinatura(id, await readBody(req)) : await svc.cobrar.cancelarAssinatura(id));
      if (kind === 'links' && req.method === 'DELETE') return send(res, 200, await svc.cobrar.removerLink(id));
      if (kind === 'carteiras' && req.method === 'DELETE') { store.log('config', `Carteira de split removida: ${id}`); return send(res, 200, store.removeWallet(id)); }
    }
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html') && /[?&](deal|company|contact)=/.test(req.url)) {   // links antigos da aba dentro da deal
      res.writeHead(302, { Location: '/financeiro.html' + u.search }); return res.end();
    }
    if (req.method === 'GET') {
      const f = path.join(__dirname, 'public', u.pathname === '/' || u.pathname === '/index.html' ? 'financeiro.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (f.startsWith(path.join(__dirname, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        return fs.createReadStream(f).pipe(res);
      }
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    store.log('erro', `${req.method} ${u.pathname}: ${e.message}`);
    send(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Contas a Receber em :${PORT} · Asaas ${asaas.enabled ? asaas.env : 'DESLIGADO (configure em Configurações)'} · sync a cada ${SYNC_MIN} min`);
  setTimeout(() => svc.sync().then(r => console.log('sync inicial', JSON.stringify(r))).catch(e => console.error(e)), 5000);
  setInterval(() => svc.sync().catch(e => console.error('sync', e.message)), SYNC_MIN * 60 * 1000);
  // Contratos (funil 15): avisa o responsável nos marcos de vencimento, 1x por hora (cada marco só uma vez por contrato).
  const avisar = () => bitrix.enabled && finApi.avisarContratos().then(r => r.enviados.length && console.log('avisos de contrato', r.enviados.length)).catch(e => console.error('avisos', e.message));
  setTimeout(avisar, 30000); setInterval(avisar, 3600 * 1000);
  const recorr = () => { try { const n = finApi.gerarRecorrenciasAgora(); if (n) console.log('recorrências geradas', n); } catch (e) { console.error('recorrências', e.message); } };
  setTimeout(recorr, 12000); setInterval(recorr, 3600 * 1000);
  const folha = () => { try { finApi.folhaAuto(); } catch (e) { console.error('folha', e.message); } };
  setTimeout(folha, 10000); setInterval(folha, 3600 * 1000);
  const QUICK_MIN = +process.env.QUICK_MINUTES || 2;
  setInterval(() => svc.quick().catch(e => console.error('quick', e.message)), QUICK_MIN * 60 * 1000);
});
