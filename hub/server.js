'use strict';
// Hub do escritório — servidor HTTP sem dependências. Roda atrás do gateway da Vibecode (Black Hole):
// a identidade chega em X-Vibe-* e o navegador nunca vê o token da sessão.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createVibe, VibeError } = require('./lib/vibe');
const { createCrm, HubError } = require('./lib/crm');
const { createLookup, CnpjError, isValidCnpj, onlyDigits } = require('./lib/cnpj');
const { createMockVibe, fakeLookup } = require('./lib/mock');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function createApp({ vibeFactory, lookup, portal = process.env.BITRIX_PORTAL || '', mock = false } = {}) {
  const shared = {};                       // caches do portal (schema, campos, usuários)

  async function currentUser(req, vibe) {
    const h = req.headers;
    const id = h['x-vibe-user-id'];
    if (!mock && !id && !process.env.VIBE_API_KEY) throw new HubError(401, 'UNAUTHENTICATED', 'Abra o app pelo Bitrix24 para entrar.');
    let name = '';
    try { name = decodeURIComponent(h['x-vibe-user-name-encoded'] || ''); } catch { /* ignora */ }
    return { id: id || (mock ? 'demo' : ''), name: name || (mock ? 'Usuário Demo' : ''), role: h['x-vibe-user-role'] || (mock ? 'ADMIN' : 'MEMBER'), vibe };
  }

  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1_000_000) throw new HubError(413, 'TOO_LARGE', 'Requisição grande demais.'); chunks.push(c); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HubError(400, 'BAD_JSON', 'JSON inválido.'); }
  }
  const send = (res, status, body, headers = {}) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(data);
  };

  async function api(req, res, url) {
    if (req.method !== 'GET' && req.headers['x-hub'] !== '1') throw new HubError(403, 'CSRF', 'Requisição não permitida.');
    const vibe = vibeFactory(req.headers['x-vibe-authorization']);
    const user = await currentUser(req, vibe);
    const crm = createCrm(vibe, shared);
    const p = url.pathname, m = req.method, q = url.searchParams;
    let r;

    if (m === 'GET' && p === '/api/me') return send(res, 200, { user: { id: user.id, name: user.name, role: user.role }, portal, mock });
    if (m === 'GET' && p === '/api/cnpj') {                       // /api/cnpj?v=...
      const d = onlyDigits(q.get('v'));
      if (!isValidCnpj(d)) throw new CnpjError('CNPJ_INVALID', 'CNPJ inválido: confira os dígitos.', 400);
      const [existing, receita] = await Promise.allSettled([crm.findByCnpj(d), lookup(d)]);
      if (existing.status === 'rejected') throw existing.reason;          // sem saber se já existe, não deixa seguir
      if (receita.status === 'rejected' && !existing.value) throw receita.reason;
      return send(res, 200, { existing: existing.value, receita: receita.status === 'fulfilled' ? receita.value : null, receitaError: receita.status === 'rejected' ? { code: receita.reason.code, message: receita.reason.message } : null });
    }
    if (m === 'GET' && p === '/api/companies') return send(res, 200, await crm.listCompanies({ q: q.get('q') || '', limit: q.get('limit'), offset: q.get('offset') }));
    if (m === 'POST' && p === '/api/companies') return send(res, 201, await crm.createCompany(await readJson(req)));
    if ((r = /^\/api\/companies\/(\d+)$/.exec(p))) {
      if (m === 'GET') return send(res, 200, await crm.getCompany(r[1]));
      if (m === 'PATCH') return send(res, 200, await crm.updateCompany(r[1], (await readJson(req)).empresa || {}));
      if (m === 'DELETE') { await crm.deleteCompany(r[1]); return send(res, 200, { ok: true }); }
    }
    if ((r = /^\/api\/contacts\/(\d+)$/.exec(p))) {
      if (m === 'PATCH') return send(res, 200, await crm.updateContact(r[1], await readJson(req)));
      if (m === 'DELETE') { await crm.deleteContact(r[1]); return send(res, 200, { ok: true }); }
    }
    if ((r = /^\/api\/companies\/(\d+)\/contacts$/.exec(p)) && m === 'POST') {
      const out = await crm.addContact(r[1], await readJson(req));
      return send(res, 201, { ...out, empresa: await crm.getCompany(r[1]) });
    }
    if ((r = /^\/api\/companies\/(\d+)\/contacts\/(\d+)$/.exec(p)) && m === 'DELETE') {
      await crm.unlinkContact(r[1], r[2]);
      return send(res, 200, await crm.getCompany(r[1]));
    }
    if (m === 'GET' && p === '/api/users') return send(res, 200, { items: await crm.listUsers() });
    if (m === 'GET' && (r = /^\/api\/fields\/(companies|contacts)$/.exec(p))) { const { list, ignored } = await crm.formFields(r[1], true); return send(res, 200, { items: list, ignored }); }
    if (m === 'GET' && (r = /^\/api\/contacts\/(\d+)$/.exec(p))) return send(res, 200, await crm.getContact(r[1]));
    if (m === 'GET' && p === '/api/contacts') return send(res, 200, { items: await crm.searchContacts(q.get('q') || '') });
    throw new HubError(404, 'NOT_FOUND', 'Rota não encontrada.');
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' ) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (path.extname(rel)) return send(res, 404, { error: 'not_found' });
      return serveStatic(req, res, new URL('/', 'http://x'));          // SPA
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && !(e instanceof VibeError)) console.error(e);
      send(res, status, { error: { code: e.code || 'INTERNAL', message: status >= 500 && !e.code ? 'Erro interno.' : e.message } });
    }
  });
}

function boot() {
  const mock = process.env.MOCK === '1';
  const mockVibe = mock ? createMockVibe(true).vibe : null;
  const forSession = createVibe({ appKey: process.env.VIBE_APP_KEY, apiKey: process.env.VIBE_API_KEY });
  const server = createApp({ vibeFactory: mock ? () => mockVibe : forSession, lookup: mock ? fakeLookup : createLookup(), mock });
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`Hub do escritório em http://127.0.0.1:${port}${mock ? ' (demonstração)' : ''}`));
  return server;
}
if (require.main === module) boot();
module.exports = { createApp, boot };
