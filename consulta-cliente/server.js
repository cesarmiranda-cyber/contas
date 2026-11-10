'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createBitrix, consultar } = require('./lib');

try { // .env opcional (em produção as variáveis já vêm no processo)
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* sem .env */ }

const bitrix = createBitrix(process.env.BITRIX_WEBHOOK);
const PORT = +process.env.PORT || 3000;
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'self' https://*.bitrix24.com.br https://*.bitrix24.com https://*.bitrix24.com.ar https://*.bitrix24.es https://*.bitrix24.eu https://*.bitrix24.net https://*.bitrix24.ru",
};
const json = (res, code, obj) => { res.writeHead(code, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

// Só usuário logado no Bitrix24 (o gateway da Vibecode injeta X-Vibe-User-Id; o navegador não forja). AUTH_DISABLED=1 só para desenvolvimento.
const logado = req => process.env.AUTH_DISABLED === '1' || /^\d{1,12}$/.test(String(req.headers['x-vibe-user-id'] || ''));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/health') return json(res, 200, { ok: true });
    if (u.pathname === '/api/consulta') {
      if (!logado(req)) return json(res, 401, { error: 'Entre pelo Bitrix24 para usar a consulta.' });
      return json(res, 200, await consultar(bitrix, u.searchParams.get('q')));
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    json(res, 404, { error: 'Não encontrado.' });
  } catch (e) {
    console.error(e.message);   // detalhes só no log do servidor
    json(res, e.status || 502, { error: e.status ? e.message : 'Não foi possível consultar o Bitrix24 agora. Tente novamente.' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`Consulta de cliente em :${PORT}`));
module.exports = server;
