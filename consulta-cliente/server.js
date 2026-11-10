'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createBitrix, consultar } = require('./lib');
const { createAuth } = require('./auth');

try { // .env opcional (em produção as variáveis já vêm no processo)
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* sem .env */ }

const bitrix = createBitrix(process.env.BITRIX_WEBHOOK);
const PORT = +process.env.PORT || 3000;
const auth = process.env.PORTAL_DOMAIN && process.env.SESSION_SECRET
  ? createAuth({ portal: process.env.PORTAL_DOMAIN, secret: process.env.SESSION_SECRET }) : null;
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://api.bitrix24.com; frame-ancestors 'self' https://*.bitrix24.com.br https://*.bitrix24.com https://*.bitrix24.com.ar https://*.bitrix24.es https://*.bitrix24.eu https://*.bitrix24.net https://*.bitrix24.ru",
};
const json = (res, code, obj) => { res.writeHead(code, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

// Só usuário logado no Bitrix24: token assinado emitido em POST / (abertura do app). AUTH_DISABLED=1 só para desenvolvimento.
const cookie = req => (String(req.headers.cookie || '').match(/(?:^|;\s*)sessao=([^;]+)/) || [])[1] || '';
const tokenDe = req => (req.headers.authorization || '').replace(/^Bearer /, '') || cookie(req);
const logado = req => process.env.AUTH_DISABLED === '1' || !!(auth && auth.verificar(tokenDe(req)));
const loginPage = erro => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Entrar</title>
<body style="font:16px system-ui;max-width:360px;margin:15vh auto;padding:0 16px"><h2>Consultar cliente</h2>${erro ? `<p style="color:#c0392b">${erro}</p>` : ''}
<form method=post action=/login><input type=password name=senha placeholder="Senha de acesso" autofocus style="width:100%;padding:10px;font-size:16px;box-sizing:border-box"><button style="margin-top:10px;padding:10px 18px;font-size:16px">Entrar</button></form></body>`;
const html = (res, code, body) => { res.writeHead(code, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
const lerForm = req => new Promise(ok => {
  let t = ''; req.on('data', c => { if (t.length < 1e5) t += c; }); req.on('end', () => ok(new URLSearchParams(t))); req.on('error', () => ok(new URLSearchParams()));
});
const pagina = tok => fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('__TOKEN__', tok);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/health') return json(res, 200, { ok: true });
    if (u.pathname === '/api/consulta') {
      if (!logado(req)) return json(res, 401, { error: 'Entre pelo Bitrix24 para usar a consulta.' });
      return json(res, 200, await consultar(bitrix, u.searchParams.get('q')));
    }
    if (u.pathname === '/install' && req.method === 'POST') {   // Bitrix chama ao instalar o app local
      return html(res, 200, '<script src="https://api.bitrix24.com/api/v1/"></script><script>BX24.init(function(){BX24.installFinish()})</script>');
    }
    if (u.pathname === '/' && req.method === 'POST') {          // Bitrix abre o app (iframe) com AUTH_ID e DOMAIN
      const f = await lerForm(req);
      const tok = auth && await auth.entrar({ authId: f.get('AUTH_ID'), domain: f.get('DOMAIN') });
      return tok ? html(res, 200, pagina(tok)) : html(res, 401, 'Não foi possível confirmar seu login no Bitrix24. Abra o app por dentro do Bitrix24.');
    }
    if (u.pathname === '/login' && req.method === 'POST') {     // acesso por senha (link fora do Bitrix)
      const f = await lerForm(req), ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
      const tok = auth && process.env.APP_PASSWORD ? auth.entrarSenha(f.get('senha'), process.env.APP_PASSWORD, ip) : null;
      if (tok === 'bloqueado') return html(res, 429, loginPage('Muitas tentativas. Tente de novo em 15 minutos.'));
      if (!tok) return html(res, 401, loginPage('Senha incorreta.'));
      res.writeHead(303, { ...SEC, Location: '/', 'Set-Cookie': `sessao=${tok}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Lax` }); return res.end();
    }
    if (u.pathname === '/' && req.method === 'GET') {
      if (process.env.AUTH_DISABLED === '1') return html(res, 200, pagina('dev'));
      return logado(req) ? html(res, 200, pagina(cookie(req))) : html(res, process.env.APP_PASSWORD ? 200 : 401, process.env.APP_PASSWORD ? loginPage('') : 'Abra este app por dentro do Bitrix24.');
    }
    json(res, 404, { error: 'Não encontrado.' });
  } catch (e) {
    console.error(e.message);   // detalhes só no log do servidor
    json(res, e.status || 502, { error: e.status ? e.message : 'Não foi possível consultar o Bitrix24 agora. Tente novamente.' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`Consulta de cliente em :${PORT}`));
module.exports = server;
