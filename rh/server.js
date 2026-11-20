'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./lib/store');
const { createAcl } = require('./lib/acl');
const { createBitrixUsers } = require('./lib/bitrixUsers');
const { createCurriculos } = require('./lib/curriculos');
const { createIa } = require('./lib/ia');
const { MODULOS } = require('./lib/modules');
const { CAMPOS, CV_MAX } = require('./lib/candidatura');

const bad = (code, msg) => Object.assign(new Error(msg), { status: code });
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'self' https://vibecode.bitrix24.com https://*.bitrix24.com.br https://*.bitrix24.com https://*.bitrix24.com.ar https://*.bitrix24.es https://*.bitrix24.eu https://*.bitrix24.net https://*.bitrix24.ru",
};
const send = (res, code, obj) => { res.writeHead(code, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return no(bad(415, 'Content-Type deve ser application/json.'));
  const chunks = []; let n = 0, dead = false;
  req.on('data', c => { n += c.length; if (n > 4.2e6) { dead = true; chunks.length = 0; no(bad(413, 'Corpo grande demais.')); req.resume(); } else if (!dead) chunks.push(c); });
  req.on('end', () => { if (dead) return; const t = Buffer.concat(chunks).toString('utf8'); let v; try { v = t.trim() ? JSON.parse(t) : {}; } catch { return no(bad(400, 'JSON inválido.')); } if (!v || typeof v !== 'object' || Array.isArray(v)) return no(bad(400, 'O corpo deve ser um objeto JSON.')); ok(v); });
  req.on('error', () => no(bad(400, 'Requisição interrompida.')));
});
// Anti-CSRF: atrás do gateway o Host é interno; o sinal confiável é o Sec-Fetch-Site do navegador.
const sameOrigin = req => {
  const sf = req.headers['sec-fetch-site']; if (sf) return sf === 'same-origin' || sf === 'none';
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};

function createServer({ dataDir, appKey, applicationId, usuarios, intakeKeyIds, ia, extrair } = {}) {
  const store = createStore(dataDir);
  usuarios = usuarios || createBitrixUsers({ appKey });
  const acl = createAcl({ store, usuarios });
  const cur = createCurriculos({ store, ia: ia || createIa({ appKey }), usuarios, extrair });
  cur.retomar();
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
  const janela = new Map(); // limite por chave do site: 60 fichas/min
  const limitado = k => { const t = Date.now(), l = (janela.get(k) || []).filter(x => t - x < 60_000); l.push(t); janela.set(k, l); return l.length > 60; };
  const bearerDe = h => String(h['x-vibe-authorization'] || '').replace(/^Bearer /, '');

  const rotas = {
    'GET /api/me': async ({ user }) => ({
      usuario: { id: user.id, nome: user.nome, papel: user.papel, bootstrap: user.bootstrap },
      modulos: MODULOS.map(m => ({ ...m, acesso: !!user.niveis[m.id], nivel: user.niveis[m.id] || null })),
    }),
    // ---- Configuração de acesso (admin)
    'GET /api/usuarios': async ({ user, u, bearer }) => { acl.exigeAdmin(user); return { usuarios: await usuarios.buscar(bearer, u.searchParams.get('q')) }; },
    'GET /api/acessos': async ({ user }) => { acl.exigeAdmin(user); return acl.listar(); },
    'POST /api/acessos/admin': async ({ user, body, bearer }) => { acl.exigeAdmin(user); return acl.addAdmin(user, bearer, body.userId); },
    'DELETE /api/acessos/admin/:id': async ({ user, p }) => { acl.exigeAdmin(user); return acl.removeAdmin(user, p.id); },
    'PUT /api/acessos/modulo/:mod': async ({ user, p, body, bearer }) => { acl.exigeAdmin(user); return acl.setAcesso(user, bearer, p.mod, body.userId, body.nivel); },
    'DELETE /api/acessos/modulo/:mod/:id': async ({ user, p }) => { acl.exigeAdmin(user); return acl.removeAcesso(user, p.mod, p.id); },
    'GET /api/auditoria': async ({ user }) => { acl.exigeAdmin(user); return { itens: store.auditoria.slice(0, 300) }; },
    // ---- Módulo: recepção de currículos
    'GET /api/curriculos/candidatos': async ({ user, u }) => {
      acl.exige(user, 'curriculos'); const q = u.searchParams;
      return cur.listar({ status: q.get('status'), q: q.get('q'), vaga: q.get('vaga'), area: q.get('area'), responsavel: q.get('responsavel') === 'eu' ? user.id : q.get('responsavel'), origem: q.get('origem'), parada: q.get('parada') === '1', ordem: q.get('ordem'), limite: +q.get('limite') || 200, offset: +q.get('offset') || 0 });
    },
    'GET /api/curriculos/candidatos/:id': async ({ user, p }) => { acl.exige(user, 'curriculos'); const d = cur.detalhe(p.id); store.audit(user, 'candidato.ver', `${p.id.slice(0, 8)} ${d.nome}`); return d; },
    'PATCH /api/curriculos/candidatos/:id': async ({ user, p, body, bearer }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.atualizar(user, p.id, body, bearer); },
    'POST /api/curriculos/candidatos/:id/reanalisar': async ({ user, p }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.reanalisar(user, p.id); },
    'DELETE /api/curriculos/candidatos/:id': async ({ user, p }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.excluir(user, p.id); },
    'GET /api/curriculos/vagas': async ({ user }) => { acl.exige(user, 'curriculos'); return cur.vagas(); },
    'POST /api/curriculos/vagas': async ({ user, body, bearer }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.criarVaga(user, body, bearer); },
    'PATCH /api/curriculos/vagas/:id': async ({ user, p, body, bearer }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.editarVaga(user, p.id, body, bearer); },
    'POST /api/curriculos/vagas/:id/acao': async ({ user, p, body, bearer }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.acaoVaga(user, p.id, body, bearer); },
    'DELETE /api/curriculos/vagas/:id': async ({ user, p }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.excluirVaga(user, p.id); },
    'GET /api/curriculos/config': async ({ user }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.config(); },
    'PUT /api/curriculos/config': async ({ user, body }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.salvarConfig(user, body); },
    'PUT /api/curriculos/config/area/:area': async ({ user, p, body, bearer }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.addResponsavel(user, bearer, p.area, body.userId); },
    'DELETE /api/curriculos/config/area/:area/:id': async ({ user, p }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.removeResponsavel(user, p.area, p.id); },
    'GET /api/curriculos/usuarios': async ({ user, u, bearer }) => { acl.exige(user, 'curriculos', 'gestor'); return { usuarios: await usuarios.buscar(bearer, u.searchParams.get('q')) }; },
    'GET /api/curriculos/integracao': async ({ user }) => {
      acl.exige(user, 'curriculos', 'gestor');
      return { campos: CAMPOS, cvMaxBytes: CV_MAX, applicationId: applicationId || '', endpoint: applicationId ? `https://vibecode.bitrix24.com/v1/applications/${applicationId}/api/public/candidaturas` : '' };
    },
  };
  const compiled = Object.entries(rotas).map(([k, fn]) => { const [m, pat] = k.split(' '); const names = []; const re = new RegExp('^' + pat.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$'); return { m, re, names, fn }; });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const pathname = u.pathname;
    try {
      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
      const externo = String(req.headers['x-vibe-caller-kind'] || '') === 'external-api';
      // Canal externo (site de carreiras): só a rota de entrada, com chave identificada; todas as demais ficam fechadas.
      const mv = pathname.match(/^\/public\/vagas\/([a-z0-9-]{1,60})$/);
      if (mv) {
        if (req.method !== 'GET') throw bad(405, 'Use GET.');
        if (!externo || !req.headers['x-vibe-caller-key-id']) throw bad(403, 'Acesso permitido apenas pelo canal da API externa.');
        return send(res, 200, { success: true, ...cur.vagaPublica(mv[1]) });
      }
      if (pathname === '/public/vagas') {
        if (req.method !== 'GET') throw bad(405, 'Use GET.');
        if (!externo || !req.headers['x-vibe-caller-key-id']) throw bad(403, 'Acesso permitido apenas pelo canal da API externa.');
        return send(res, 200, { success: true, ...cur.vagasPublicas() });
      }
      if (pathname === '/public/candidaturas') {
        if (req.method !== 'POST') throw bad(405, 'Use POST.');
        const kid = String(req.headers['x-vibe-caller-key-id'] || '');
        if (!externo || !kid) throw bad(403, 'Acesso permitido apenas pelo canal da API externa.');
        if (intakeKeyIds?.length && !intakeKeyIds.includes(kid)) throw bad(403, 'Chave não autorizada para enviar candidaturas.');
        if (limitado(kid)) throw bad(429, 'Muitas candidaturas em pouco tempo. Tente em instantes.');
        return send(res, 201, { success: true, ...cur.receber(await readBody(req), kid) });
      }
      if (externo) throw bad(403, 'Este canal só aceita o envio de candidaturas.');
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) { res.writeHead(200, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html); }
      if (!pathname.startsWith('/api/')) throw bad(404, 'Não encontrado.');
      const user = acl.resolve(req.headers);
      if (!user) throw bad(401, 'Abra o app pelo Bitrix24 para se identificar.');
      if (req.method !== 'GET' && !sameOrigin(req)) throw bad(403, 'Origem não permitida.');
      // download do currículo (GET autenticado, sem JSON)
      let m = pathname.match(/^\/api\/curriculos\/candidatos\/([0-9a-f]{24})\/cv$/);
      if (req.method === 'GET' && m) {
        acl.exige(user, 'curriculos'); const f = cur.baixarCv(m[1]); store.audit(user, 'candidato.cv', m[1].slice(0, 8));
        const tipos = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
        res.writeHead(200, { ...SEC, 'Content-Type': tipos[f.ext], 'Content-Length': f.buf.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': 'sandbox', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.nome)}` });
        return res.end(f.buf);
      }
      for (const r of compiled) {
        if (r.m !== req.method) continue; m = pathname.match(r.re); if (!m) continue;
        const p = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        return send(res, 200, await r.fn({ user, u, p, body, bearer: bearerDe(req.headers) }));
      }
      throw bad(404, 'Não encontrado.');
    } catch (e) {
      const code = e.status || 500; if (code === 500) console.error(e);
      send(res, code, { error: code === 500 ? 'Erro interno.' : e.message, ...(e.erros ? { erros: e.erros } : {}) });
    }
  });
  server.store = store; server.cur = cur;
  return server;
}
module.exports = { createServer };

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const intake = (process.env.INTAKE_KEY_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  createServer({ dataDir, appKey: process.env.VIBE_APP_KEY, applicationId: process.env.VIBE_APPLICATION_ID, intakeKeyIds: intake })
    .listen(+process.env.PORT || 3000, () => console.log('RH no ar'));
}
