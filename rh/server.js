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
const readBody = (req, aceitaTexto = false) => new Promise((ok, no) => {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '') && !(aceitaTexto && /^text\/plain\b/i.test(req.headers['content-type'] || ''))) return no(bad(415, 'Content-Type deve ser application/json.'));
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

const ORIGENS_PADRAO = 'https://originallocadora.com.br,https://www.originallocadora.com.br';
function createServer({ dataDir, appKey, applicationId, usuarios, intakeKeyIds, ia, extrair, siteOrigins } = {}) {
  const ORIGENS = (siteOrigins || process.env.SITE_ORIGINS || ORIGENS_PADRAO).split(',').map(x => x.trim()).filter(Boolean);
  // site da Original (e a pré-visualização do Bitrix24 Sites) — somente estes navegadores podem ler/enviar pelo CORS
  const origemOk = o => !!o && (ORIGENS.includes(o) || /^https:\/\/[a-z0-9-]+\.bitrix24\.site$/i.test(o));
  const store = createStore(dataDir);
  usuarios = usuarios || createBitrixUsers({ appKey });
  const acl = createAcl({ store, usuarios });
  const cur = createCurriculos({ store, ia: ia || createIa({ appKey }), usuarios, extrair });
  cur.retomar();
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
  // a mesma página do bloco HTML do site, apontando para o próprio app (mesma origem)
  const paginaCarreiras = () => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trabalhe conosco · Original Locações</title></head><body style="margin:0">${fs.readFileSync(path.join(__dirname, 'site', 'trabalhe-conosco.html'), 'utf8').replace(/API: "[^"]*", \/\*API\*\//, 'API: "", /*API*/')}</body></html>`;
  const taxa = new Map();   // limitador genérico: chave -> instantes
  const estouro = (k, max, ms) => { const t = Date.now(), l = (taxa.get(k) || []).filter(x => t - x < ms); l.push(t); taxa.set(k, l); if (taxa.size > 5000) for (const [kk, v] of taxa) if (!v.length || t - v[v.length - 1] > 3.6e6) taxa.delete(kk); return l.length > max; };
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
    'DELETE /api/curriculos/exemplos': async ({ user }) => { acl.exige(user, 'curriculos', 'gestor'); return cur.removerExemplos(user); },
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
    res.on('finish', () => {   // diagnóstico: método, rota, status e ID do usuário (nada de conteúdo)
      if (pathname === '/health' || (res.statusCode < 400 && pathname !== '/api/me' && !pathname.startsWith('/public/'))) return;
      console.log(JSON.stringify({ m: req.method, p: pathname.replace(/[0-9a-f]{24}/g, ':id'), s: res.statusCode, uid: String(req.headers['x-vibe-user-id'] || '-').slice(0, 40), role: req.headers['x-vibe-user-role'] || '-', ...(pathname.startsWith('/public/') ? { o: String(req.headers.origin || '-').slice(0, 80), nav: /Mobile|Android|iPhone/i.test(req.headers['user-agent'] || '') ? 'movel' : /Chrome|Safari|Firefox|Edg/i.test(req.headers['user-agent'] || '') ? 'desktop' : 'outro' } : {}), bearer: !!req.headers['x-vibe-authorization'], ext: req.headers['x-vibe-caller-kind'] || '-' }));
    });
    try {
      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
      const externo = String(req.headers['x-vibe-caller-kind'] || '') === 'external-api';
      // Canal externo (site de carreiras): só a rota de entrada, com chave identificada; todas as demais ficam fechadas.
      const publico = req.headers['x-vibe-public'] === 'true' && !externo;   // visitante anônimo do site (servidor em modo público)
      if (pathname.startsWith('/public/')) {
        const origem = req.headers.origin;
        if (origem && origemOk(origem)) {   // CORS só para o site da Original
          res.setHeader('Access-Control-Allow-Origin', origem); res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept'); res.setHeader('Access-Control-Max-Age', '86400');
        }
        if (req.method === 'OPTIONS') { if (!origemOk(origem)) throw bad(403, 'Origem não permitida.'); res.writeHead(204, { ...SEC }); return res.end(); }
        const kid = String(req.headers['x-vibe-caller-kind'] === 'external-api' ? req.headers['x-vibe-caller-key-id'] || '' : '');
        if (externo) {
          if (!kid) throw bad(403, 'Acesso permitido apenas pelo canal da API externa.');
          if (intakeKeyIds?.length && !intakeKeyIds.includes(kid)) throw bad(403, 'Chave não autorizada para enviar candidaturas.');
        } else if (!publico) throw bad(403, 'Acesso permitido apenas pelo site de carreiras.');
        else if (origem && !origemOk(origem)) throw bad(403, 'Origem não permitida.');
        if (estouro(`pub:${externo ? kid : 'site'}`, 240, 60_000)) throw bad(429, 'Muitas requisições. Tente em instantes.');
        if (pathname === '/public/ping') {   // sinal de diagnóstico da página (sem dados pessoais): só vai para o registro do servidor
          console.log(JSON.stringify({ ping: String(u.searchParams.get('e') || '').slice(0, 30), d: String(u.searchParams.get('d') || '').slice(0, 80), site: String(u.searchParams.get('o') || '').slice(0, 80), pag: String(u.searchParams.get('p') || '').slice(0, 80) }));
          res.writeHead(204, { ...SEC, 'Cache-Control': 'no-store' }); return res.end();
        }
        const mv = pathname.match(/^\/public\/vagas\/([a-z0-9-]{1,60})$/);
        if (mv) { if (req.method !== 'GET') throw bad(405, 'Use GET.'); return send(res, 200, { success: true, ...cur.vagaPublica(mv[1]) }); }
        if (pathname === '/public/vagas') { if (req.method !== 'GET') throw bad(405, 'Use GET.'); return send(res, 200, { success: true, ...cur.vagasPublicas() }); }
        if (pathname === '/public/candidaturas') {
          if (req.method !== 'POST') throw bad(405, 'Use POST.');
          if (estouro(`cand:${externo ? kid : 'site'}`, 60, 60_000)) throw bad(429, 'Muitas candidaturas em pouco tempo. Tente em instantes.');
          const body = await readBody(req, true);
          if (publico && estouro(`email:${String(body.email || '').toLowerCase().slice(0, 120)}`, 5, 3_600_000)) throw bad(429, 'Você já enviou várias candidaturas. Tente novamente mais tarde.');
          return send(res, 201, { success: true, ...cur.receber(body, externo ? kid : 'site') });
        }
        throw bad(404, 'Não encontrado.');
      }
      if (externo) throw bad(403, 'Este canal só aceita o envio de candidaturas.');
      if (req.method === 'GET' && pathname === '/carreiras') {
        const csp = SEC['Content-Security-Policy'].replace(/frame-ancestors [^;]*/, `frame-ancestors 'self' ${ORIGENS.join(' ')}`);
        res.writeHead(200, { ...SEC, 'Content-Security-Policy': csp, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(paginaCarreiras());
      }
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) { res.writeHead(200, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html); }
      if (!pathname.startsWith('/api/')) throw bad(404, 'Não encontrado.');
      const user = await acl.resolve(req.headers, bearerDe(req.headers));
      if (!user) throw bad(401, 'Não consegui identificar o seu usuário do Bitrix24. Abra o app pelo menu do Bitrix24 (não pelo endereço direto) e tente de novo.');
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
  if (process.env.SEED_DEMO === '1') cur.semearExemplos().catch(e => console.error('exemplos', e.message));
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
