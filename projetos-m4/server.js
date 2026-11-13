'use strict';
// Servidor HTTP: carrega o núcleo, registra as rotas (rotas/*.js) e serve o front-end.
const ctx = require('./nucleo');
for (const area of ["conta", "projetos", "suporte", "clientes", "registro", "inicio", "relatorios", "modelos"]) require('./rotas/' + area)(ctx);
const { PORT, PUB, R, SEC, bad, bitrix, crypto, fs, http, mesmaOrigem, path, quem, readBody, rodarRelatoriosSemanais, secrets, send, store, suporte } = ctx;
// ---- estáticos ----------------------------------------------------------------
// Versão do front-end = hash dos arquivos publicados. Vai na URL de cada arquivo (cache-busting) e é consultada pelo navegador para avisar de versão nova.
// O front-end é escrito em vários arquivos (public/js/*.js, em ordem) e entregue como um único /app.js.
const BUNDLE = fs.readdirSync(path.join(PUB, 'js')).filter(f => f.endsWith('.js')).sort().map(f => fs.readFileSync(path.join(PUB, 'js', f), 'utf8')).join('');
const VERSAO = crypto.createHash('sha1').update([fs.readFileSync(path.join(PUB, 'index.html')), BUNDLE, fs.readFileSync(path.join(PUB, 'style.css'))].join('\0')).digest('hex').slice(0, 8);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function estatico(req, res) {
  const url = new URL(req.url, 'http://x'); let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  if (p === '/app.js') { const cacheJs = url.searchParams.get('v') === VERSAO ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate'; res.writeHead(200, { ...SEC, 'Content-Type': MIME['.js'], 'Cache-Control': cacheJs }); return res.end(BUNDLE); }
  if (p.startsWith('/js/')) return send(res, 404, { erro: 'Não encontrado.' });
  const f = path.join(PUB, path.normalize(p)); if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { erro: 'Não encontrado.' });
  const tipo = MIME[path.extname(f)] || 'application/octet-stream';
  if (p === '/index.html') { // a página nunca é guardada em cache: sempre aponta para a versão atual dos arquivos
    const html = fs.readFileSync(f, 'utf8').replace(/__VERSAO__/g, VERSAO); res.writeHead(200, { ...SEC, 'Content-Type': tipo, 'Cache-Control': 'no-store' }); return res.end(html);
  }
  const cache = url.searchParams.get('v') === VERSAO ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate'; // com ?v=versão atual é seguro guardar; sem, sempre revalida
  res.writeHead(200, { ...SEC, 'Content-Type': tipo, 'Cache-Control': cache }); fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'); const pathname = url.pathname;
    if (pathname === '/health') return send(res, 200, { ok: true });
    if (pathname === '/api/versao') return send(res, 200, { versao: VERSAO });
    if (!pathname.startsWith('/api/')) return estatico(req, res);
    const hit = R.map(([m, re, fn]) => [m, re.exec(pathname), fn]).find(([m, mm]) => mm && m === req.method);
    if (!hit) return send(res, 404, { erro: 'Rota não encontrada.' });
    let b = {}; if (req.method !== 'GET') { if (!mesmaOrigem(req)) throw bad(403, 'Origem não permitida.'); b = await readBody(req, /(itens|mensagens)$/.test(pathname) ? 16e6 : 1e6); }
    await hit[2](req, res, hit[1], b, quem(req));
  } catch (e) { if (!e.status) console.error(e); send(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno.', ...(e.extra || {}) }); }
});
if (require.main === module) { server.listen(PORT, () => console.log(`Projetos M4 na porta ${PORT}`)); setInterval(() => suporte.ciclo(), 2 * 60e3).unref(); setInterval(() => { try { rodarRelatoriosSemanais(); } catch (e) { console.error('relatório semanal:', e.message); } }, 60 * 60e3).unref(); setTimeout(() => { try { rodarRelatoriosSemanais(); } catch { /* tenta de novo na próxima hora */ } }, 15e3).unref(); setTimeout(() => suporte.ciclo(), 5e3).unref(); process.on('SIGTERM', () => { store.flush(); process.exit(0); }); }
module.exports = { server, store, suporte, bitrix, secrets, rodarRelatoriosSemanais };
