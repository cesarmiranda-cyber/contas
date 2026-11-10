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
const logado = req => process.env.AUTH_DISABLED === '1' ||
  !!(auth && auth.verificar((req.headers.authorization || '').replace(/^Bearer /, '')));
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
    if (u.pathname === '/' && req.method === 'GET') {
      return process.env.AUTH_DISABLED === '1' ? html(res, 200, pagina('dev')) : html(res, 401, 'Abra este app por dentro do Bitrix24.');
    }
    json(res, 404, { error: 'Não encontrado.' });
  } catch (e) {
    console.error(e.message);   // detalhes só no log do servidor
    json(res, e.status || 502, { error: e.status ? e.message : 'Não foi possível consultar o Bitrix24 agora. Tente novamente.' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`Consulta de cliente em :${PORT}`));
module.exports = server;
