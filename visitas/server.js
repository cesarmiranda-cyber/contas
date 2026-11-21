'use strict';
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createBitrix } = require('./lib/bitrix');
const { createStore } = require('./lib/store');
const { createService } = require('./lib/service');
const { createJobs } = require('./lib/jobs');
const R = require('./lib/rules');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = createStore(DATA_DIR);
const bitrix = createBitrix('');
// Webhook: variável de ambiente ou, na falta dela, o que um administrador salvou em Configurações (arquivo 0600, nunca devolvido ao navegador).
const WH_FILE = path.join(DATA_DIR, 'webhook.secret');
const lerWebhook = () => process.env.BITRIX_WEBHOOK || (() => { try { return fs.readFileSync(WH_FILE, 'utf8').trim(); } catch { return ''; } })();
bitrix.configure(lerWebhook());
const svc = createService({ bitrix, store });

const jobs = createJobs({ diagnostico: (b, passo) => svc.diagnosticoDatas(passo), sincronizar: b => svc.sync({ forcar: !!b.forcar, previa: !!b.previa }), preparar: () => svc.preparar(), reconciliar: () => svc.reconciliar(), auditoria: (b, passo) => svc.auditoria(passo), corrigir: (b, passo) => svc.corrigirAuditoria(String(b.id || ''), passo), restaurar: (b, passo) => svc.restaurarRemovidos({ confirmar: b.confirmar === true, desde: b.desde }, passo) });
const bad = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://*.bitrix24.com.br https://*.bitrix24.com https://*.bitrix24.com.ar https://*.bitrix24.es https://*.bitrix24.eu https://*.bitrix24.net https://*.bitrix24.ru",
};
const send = (res, code, obj) => {
  let body = Buffer.from(JSON.stringify(obj)); const h = { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (body.length > 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body, { level: 4 }); h['Content-Encoding'] = 'gzip'; }
  res.writeHead(code, h); res.end(body);
};
// Limite de requisições por usuário (janela de 1 min): leitura 300, escrita 60. Protege o Bitrix (limite de chamadas) e o app.
const limites = new Map();
function limite(user, escrita) {
  const k = `${user.id}:${escrita ? 'w' : 'r'}`, agora = Date.now(), max = escrita ? 60 : 300;
  let l = limites.get(k); if (!l || l.fim < agora) { l = { n: 0, fim: agora + 60000 }; limites.set(k, l); }
  if (++l.n > max) { const e = bad(429, 'Muitas requisições. Aguarde um instante e tente de novo.'); e.retry = Math.ceil((l.fim - agora) / 1000); throw e; }
}
setInterval(() => { const t = Date.now(); for (const [k, v] of limites) if (v.fim < t) limites.delete(k); }, 60000).unref();
// Arquivos estáticos: lidos uma vez, comprimidos em memória e servidos com ETag (304 quando não mudou).
const estaticos = new Map();
function estatico(f) {
  const st = fs.statSync(f), c = estaticos.get(f);
  if (c && c.mtime === st.mtimeMs) return c;
  const raw = fs.readFileSync(f), n = { mtime: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20)}"` };
  estaticos.set(f, n); return n;
}
const readBody = (req, max = 1e6) => new Promise((ok, no) => {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return no(bad(415, 'Content-Type deve ser application/json.'));
  const chunks = []; let n = 0, dead = false;
  req.on('data', c => { n += c.length; if (n > max) { dead = true; chunks.length = 0; no(bad(413, 'Corpo da requisição grande demais.')); req.resume(); } else if (!dead) chunks.push(c); });
  req.on('end', () => {
    if (dead) return;
    let v; try { const t = Buffer.concat(chunks).toString('utf8'); v = t.trim() ? JSON.parse(t) : {}; } catch { return no(bad(400, 'JSON inválido.')); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return no(bad(400, 'O corpo deve ser um objeto JSON.'));
    ok(v);
  });
  req.on('error', () => no(bad(400, 'Requisição interrompida.')));
});
const sameOrigin = req => {
  const sf = req.headers['sec-fetch-site'];
  if (sf) return sf === 'same-origin' || sf === 'none';
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};

// Identidade: cabeçalhos injetados pelo gateway da Vibecode (o navegador não os forja).
function usuario(headers) {
  if (process.env.AUTH_DISABLED === '1' && process.env.NODE_ENV !== 'production') return { id: '0', nome: 'Desenvolvimento', portalAdmin: true, papel: 'admin', config: true };
  const id = String(headers['x-vibe-user-id'] || '');
  if (!/^\d{1,12}$/.test(id)) return null;
  let nome = ''; try { nome = decodeURIComponent(String(headers['x-vibe-user-name-encoded'] || '')); } catch { /* sem nome */ }
  const portalAdmin = String(headers['x-vibe-user-role'] || '').toUpperCase() === 'ADMIN';
  const c = store.config, config = portalAdmin || c.admins.map(String).includes(id);
  return { id, nome: nome.slice(0, 120), portalAdmin, papel: config ? 'admin' : 'usuario', config };
}
const exigeConfig = u => { if (!u.config) throw bad(403, 'Somente quem tem acesso à configuração pode fazer isto.'); };
const exigeBitrix = () => { if (!bitrix.enabled) throw bad(503, 'Webhook do Bitrix24 ainda não configurado (Configurações → Conexão com o Bitrix24).'); };

const CFG_CAMPOS = {
  intervalos: v => Object.fromEntries(['A', 'B', 'C', 'E'].map(k => [k, Math.max(1, Math.min(400, +v?.[k] || R.DEFAULT_CONFIG.intervalos[k]))])),
  periodos: v => Object.fromEntries(['A', 'B', 'C'].map(k => [k, Math.max(1, Math.min(400, +v?.[k] || R.DEFAULT_CONFIG.periodos[k]))])),
  mesClasseE: v => Math.max(1, Math.min(12, +v || 3)), horaJob: v => Math.max(0, Math.min(23, +v || 7)), sweepSegundos: v => Math.max(10, Math.min(3600, +v || 30)),
  tarefaAtiva: Boolean, atualizarProxima: Boolean, removerSemClasse: Boolean, exigirUltimaVisita: Boolean, hierarquiaAuto: Boolean, ativo: Boolean,
  cargosFila: v => (Array.isArray(v) ? v.filter(x => R.CARGOS.includes(x)) : []),
  supervisoresDepts: v => ids(v), supervisoresExtras: v => ids(v), verTudo: v => ids(v), admins: v => ids(v), podeExcluir: v => ids(v),
  motivosNaoRealizada: v => (Array.isArray(v) ? v.map(x => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 30) : []),
  deptsAcesso: v => ids(v),
  mapa: v => { const F = require('./lib/fields'), pick = (lista, o) => Object.fromEntries(lista.filter(k => /^[A-Za-z0-9_]{1,80}$/.test(o?.[k] || '')).map(k => [k, o[k]])); return { fila: pick(F.CAMPOS_AJUSTAVEIS, v?.fila), visita: pick(F.VISITA_AJUSTAVEIS, v?.visita) }; },
  visibilidade: v => (v === 'bitrix' ? 'bitrix' : 'app'),
};
const ids = v => (Array.isArray(v) ? v.map(String).filter(x => /^\d{1,12}$/.test(x)).slice(0, 500) : []);

const routes = {
  'GET /api/eu': async (u, b, user) => ({ veTudo: await svc.veTudo(user), acesso: await svc.temAcesso(user).catch(() => true), id: user.id, nome: user.nome, papel: user.papel, config: user.config, podeExcluir: svc.podeExcluir(user), hoje: svc.hoje(), webhook: bitrix.enabled, ativo: store.ativo }),
  'GET /api/config': async (u, b, user) => { exigeConfig(user); return { config: store.config, webhook: bitrix.enabled, motivosPadrao: R.MOTIVOS }; },
  'PUT /api/config': async (u, body, user) => {
    exigeConfig(user);
    const p = {}; for (const [k, f] of Object.entries(CFG_CAMPOS)) if (body[k] !== undefined) p[k] = f(body[k]);
    if (p.cargosFila && !p.cargosFila.length) throw bad(400, 'Escolha ao menos um cargo que gera fila.');
    if (p.motivosNaoRealizada && !p.motivosNaoRealizada.length) throw bad(400, 'Mantenha ao menos um motivo.');
    svc.invalidar(); if (body.mapa !== undefined) svc.resetModelo();
    store.log('config', `Configuração alterada por ${user.nome || user.id}: ${Object.keys(p).join(', ')}`);
    return store.setConfig(p);
  },
  'PUT /api/webhook': async (u, body, user) => {
    exigeConfig(user);
    const w = String(body.webhook || '').trim();
    if (!/^https:\/\/[^/\s]+\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(w)) throw bad(400, 'Webhook inválido. Formato: https://SEU-PORTAL/rest/1/CODIGO/');
    fs.writeFileSync(WH_FILE, w, { mode: 0o600 }); bitrix.configure(w); svc.invalidar();
    store.log('config', `Webhook do Bitrix24 atualizado por ${user.nome || user.id}`);
    await bitrix.call('profile').catch(e => { throw bad(502, `Webhook salvo, mas o teste falhou: ${e.message}`); });
    return { ok: true };
  },
  'GET /api/diagnostico-datas': async (u, b, user) => { exigeConfig(user); exigeBitrix(); return svc.diagnosticoDatas(); },
  'GET /api/sem-ultima': async (u, b, user) => { exigeBitrix(); return svc.semUltima(user, Object.fromEntries(u.searchParams)); },
  'POST /api/ultima-visita': async (u, b, user) => { exigeBitrix(); return svc.salvarUltimas(user, b.itens); },
  'POST /api/admitir-agendados': async (u, b, user) => { exigeConfig(user); exigeBitrix(); return svc.admitirAgendados(user); },
  'GET /api/campos': async (u, b, user) => { exigeConfig(user); exigeBitrix(); return svc.camposInfo(); },
  'GET /api/usuarios': async (u, b, user) => {
    exigeConfig(user); exigeBitrix(); const q = String(u.searchParams.get('q') || '').trim().slice(0, 60); if (q.length < 2) return [];
    const r = await bitrix.call('user.get', { FILTER: { ACTIVE: true, NAME_SEARCH: q } }).catch(e => { throw bad(502, e.message); });
    return (r.result || []).slice(0, 20).map(x => ({ id: String(x.ID), nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') || x.EMAIL }));
  },
  'GET /api/nomes': async (u, b, user) => { exigeConfig(user); exigeBitrix(); const ids = String(u.searchParams.get('ids') || '').split(',').filter(x => /^\d+$/.test(x)).slice(0, 100); const n = await svc.nomes(ids); return Object.fromEntries(ids.map(i => [i, n(i)])); },
  'GET /api/departamentos': async (u, b, user) => { exigeConfig(user); exigeBitrix(); return svc.departamentos(); },
  'GET /api/supervisores': async () => { exigeBitrix(); return svc.supervisores(); },
  'GET /api/visitas': async (u, b, user) => { exigeBitrix(); return svc.listar(user, Object.fromEntries(u.searchParams)); },
  'GET /api/excluidos': async (u, b, user) => { exigeBitrix(); if (!svc.podeExcluir(user)) throw bad(403, 'Sem permissão.'); return svc.listar(user, { ...Object.fromEntries(u.searchParams), excluidos: '1' }); },
  'GET /api/dashboard': async (u, b, user) => { exigeBitrix(); return svc.dashboard(user, Object.fromEntries(u.searchParams)); },
  'GET /api/registros': async (u, b, user) => { exigeBitrix(); return svc.registros(user, Object.fromEntries(u.searchParams)); },
  'GET /api/historico': async (u, b, user) => { exigeBitrix(); return svc.historico(user, Object.fromEntries(u.searchParams)); },
  'GET /api/log': async (u, b, user) => { exigeConfig(user); return store.logs.slice(0, 200); },
  'POST /api/preparar': async (u, b, user) => { exigeConfig(user); exigeBitrix(); return svc.preparar(); },
  'POST /api/sincronizar': async (u, b, user) => { exigeConfig(user); exigeBitrix(); return svc.sync({ forcar: !!b.forcar, previa: !!b.previa }); },
  'POST /api/varrer': async (u, b, user) => { exigeConfig(user); exigeBitrix(); return svc.varrer(); },
  'POST /api/reprogramar-grupo': async (u, b, user) => { exigeBitrix(); return svc.reprogramarGrupo(b.ids, b.data, b.motivo, user); },
};
const cardRoutes = {
  form: (id, b, user) => svc.formCard(id, user), registro: (id, b, user) => svc.registroDoCard(id, user),
  registrar: (id, b, user) => svc.registrar(id, b, user), reprogramar: (id, b, user) => svc.reprogramar(id, b, user), reverter: (id, b, user) => svc.reverter(id, user),
  participantes: (id, b, user) => svc.participantes(id, b.contatos, user), excluir: (id, b, user) => svc.excluir(id, { gerarProxima: b.gerarProxima !== false }, user),
  restaurar: (id, b, user) => svc.restaurar(id, user), proxima: (id, b, user) => svc.proxima(id, user), 'nao-realizada': (id, b, user) => svc.naoRealizada(id, b, user),
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url.replace(/^\/{2,}/, '/'), 'http://x'); } catch { return send(res, 400, { error: 'URL inválida.' }); }
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) throw bad(403, 'Origem não permitida.');
    const key = `${req.method} ${u.pathname}`;
    if (u.pathname === '/health') return send(res, 200, { ok: true });
    if (u.pathname.startsWith('/api/')) {
      const user = usuario(req.headers);
      if (!user) throw bad(401, 'Não consegui identificar seu usuário. Abra o app pelo Bitrix24.');
      if (u.pathname !== '/api/eu' && !(await svc.temAcesso(user))) throw bad(403, 'Seu departamento não tem acesso a este app. Peça a um administrador.');
      const w = ['POST', 'PUT', 'DELETE'].includes(req.method);
      limite(user, w);
      if (routes[key]) return send(res, 200, await routes[key](u, w ? await readBody(req) : {}, user));
      const mj = u.pathname.match(/^\/api\/jobs\/(diagnostico|sincronizar|preparar|reconciliar|auditoria|corrigir|restaurar)$/);
      if (mj) { exigeConfig(user); exigeBitrix(); return send(res, 200, req.method === 'POST' ? jobs.iniciar(mj[1], await readBody(req)) : jobs.estado(mj[1])); }
      let m = u.pathname.match(/^\/api\/cards\/(\d+)\/([a-z-]+)$/);
      if (m && cardRoutes[m[2]]) {
        exigeBitrix();
        const big = m[2] === 'registrar';
        return send(res, 200, await cardRoutes[m[2]](+m[1], w ? await readBody(req, big ? 30e6 : 1e6) : {}, user));
      }
      m = u.pathname.match(/^\/api\/registros\/(\d+)\/editar$/);
      if (m && req.method === 'POST') { exigeBitrix(); return send(res, 200, await svc.editarRegistro(+m[1], await readBody(req, 30e6), user)); }
      throw bad(404, 'Rota não encontrada.');
    }
    if (req.method === 'GET') {
      const pub = path.join(__dirname, 'public');
      const f = path.join(pub, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (f.startsWith(pub + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const e = estatico(f), h = { ...SEC, 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: e.etag, Vary: 'Accept-Encoding' };
        if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, h); return res.end(); }
        const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /^\.(html|js|css|svg)$/.test(path.extname(f));
        if (gz) h['Content-Encoding'] = 'gzip';
        res.writeHead(200, h); return res.end(req.method === 'HEAD' ? undefined : gz ? e.gz : e.raw);
      }
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    const code = e.status >= 400 && e.status < 600 ? e.status : 500;
    if (code >= 500) store.log('erro', `${req.method} ${u.pathname}: ${String(e.message).replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
    if (e.retry) res.setHeader('Retry-After', e.retry);
    send(res, code, { error: String(e.message).slice(0, 300) });
  }
});
server.requestTimeout = 120000; server.headersTimeout = 15000;
process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

if (require.main === module) server.listen(PORT, () => {
  console.log(`Registro de Visitas em :${PORT} · Bitrix ${bitrix.enabled ? 'configurado' : 'SEM WEBHOOK'} · fila ${store.ativo ? 'ATIVA' : 'desligada'}`);
  if (process.env.ATIVAR !== undefined) store.setConfig({ ativo: /^(1|true|sim)$/i.test(process.env.ATIVAR) });
  if (process.env.PREPARAR === '1' && bitrix.enabled) setTimeout(() => svc.preparar().then(r => console.log('preparar', JSON.stringify(r))).catch(e => console.error('preparar', e.message)), 3000);
  // Varredura leve a cada sweepSegundos; sincronização completa a cada hora e no job diário (a partir de horaJob, Brasília).
  let ultimoJob = '', ultimaHora = 0;
  let ultimoAquec = 0, ultimaReconc = 0;
  const aquece = () => { ultimoAquec = Date.now(); return svc.aquecer().catch(e => store.log('erro', `aquecer: ${e.message}`.slice(0, 200))); };
  setTimeout(aquece, 1500);
  const tique = async () => {
    if (bitrix.enabled && Date.now() - ultimoAquec > 120000) await aquece();
    if (!bitrix.enabled || !store.ativo) return;
    try {
      await svc.varrer();
      if (Date.now() - ultimaReconc > 300000) { ultimaReconc = Date.now(); const r = await svc.reconciliar(); if (r.movidos) store.log('reconcilia', `Reconciliação: ${r.movidos} card(s) encerrado(s) por já terem registro`); }
      const h = svc.hoje(), horaBR = +new Intl.DateTimeFormat('en-GB', { timeZone: R.TZ, hour: '2-digit', hour12: false }).format(new Date());
      if (Date.now() - ultimaHora > 3600e3) { ultimaHora = Date.now(); await svc.sync(); }
      if (ultimoJob !== h && horaBR >= store.config.horaJob) { ultimoJob = h; await svc.sync(); store.log('job', 'Job diário concluído'); }
    } catch (e) { store.log('erro', `rotina: ${e.message}`.slice(0, 300)); }
  };
  const agenda = () => setTimeout(async () => { await tique(); agenda(); }, Math.max(30, store.config.sweepSegundos) * 1000);
  setTimeout(agenda, 5000);
});
module.exports = { server, svc, store };
