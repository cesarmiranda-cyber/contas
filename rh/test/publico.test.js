'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createServer } = require('../server');

const fakeUsers = { buscar: async () => [], porId: async () => null };
const SITE = 'https://originallocadora.com.br';
async function boot() {
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-')), usuarios: fakeUsers, ia: { ativa: false }, applicationId: 'app-1' });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, { h, body, raw } = {}) => {
    const r = await fetch(base + p, { method: m, headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...h }, body: body ? (raw || JSON.stringify(body)) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, r };
  };
  return { srv, call };
}
const PUB = { 'x-vibe-public': 'true' };
const dia = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const ficha = (n, o = {}) => ({ nome: 'Pessoa ' + n, email: `p${n}@x.com`, telefone: '31999990000', cidade: 'BH', uf: 'MG', area: 'Administrativo', consentimento: true, linkedin: 'linkedin.com/in/pessoa-' + n, ...o });
async function comVaga(srv, call) {
  // cria e publica uma vaga como gestor (via API interna) — modo desenvolvimento
  process.env.AUTH_DISABLED = '1';
  const I = { 'Content-Type': 'application/json' };
  const v = (await call('POST', '/api/curriculos/vagas', { h: I, body: { titulo: 'Assistente', area: 'Administrativo', descricao: 'Rotinas administrativas da filial de Belo Horizonte.' } })).j;
  await call('POST', `/api/curriculos/vagas/${v.id}/acao`, { h: I, body: { acao: 'publicar', encerraEm: dia(10) } });
  delete process.env.AUTH_DISABLED; return v;
}

test('site (modo público): lê vagas e envia candidatura, com CORS só para a origem da Original', async () => {
  const { srv, call } = await boot(); const v = await comVaga(srv, call);
  const ok = await call('GET', '/public/vagas', { h: { ...PUB, Origin: SITE } });
  assert.equal(ok.s, 200); assert.equal(ok.j.vagas.length, 1);
  assert.equal(ok.r.headers.get('access-control-allow-origin'), SITE); assert.match(ok.r.headers.get('vary'), /Origin/i);
  // origem estranha: sem cabeçalho CORS e POST recusado
  const mau = await call('GET', '/public/vagas', { h: { ...PUB, Origin: 'https://site-malicioso.com' } });
  assert.equal(mau.s, 403); assert.equal(mau.r.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('GET', '/public/vagas', { h: { ...PUB, Origin: 'https://abc123.bitrix24.site' } })).s, 200, 'pré-visualização do Bitrix24 Sites');
  assert.equal((await call('GET', '/public/vagas', { h: { ...PUB, Origin: 'https://evil.bitrix24.site.attacker.com' } })).s, 403);
  // preflight
  const pf = await call('OPTIONS', '/public/candidaturas', { h: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(pf.s, 204); assert.match(pf.r.headers.get('access-control-allow-headers'), /Content-Type/i);
  assert.equal((await call('OPTIONS', '/public/candidaturas', { h: { Origin: 'https://x.com' } })).s, 403);
  // candidatura: text/plain (sem preflight) e JSON
  const a = await call('POST', '/public/candidaturas', { h: { ...PUB, Origin: SITE, 'Content-Type': 'text/plain;charset=UTF-8' }, body: ficha(1, { vaga: v.codigo }), raw: JSON.stringify(ficha(1, { vaga: v.codigo })) });
  assert.equal(a.s, 201, JSON.stringify(a.j)); assert.ok(a.j.protocolo);
  assert.equal((await call('POST', '/public/candidaturas', { h: { ...PUB, Origin: SITE }, body: ficha(2) })).s, 201);
  assert.equal((await call('POST', '/public/candidaturas', { h: { ...PUB, Origin: 'https://x.com' }, body: ficha(3) })).s, 403);
  assert.equal((await call('POST', '/public/candidaturas', { h: { ...PUB, Origin: SITE }, body: { nome: 'x' } })).s, 422);
  assert.equal((await call('GET', `/public/vagas/${v.codigo}`, { h: PUB })).j.vaga.titulo, 'Assistente');
  assert.equal((await call('GET', '/public/vagas/nao-existe', { h: PUB })).s, 404);
  srv.close();
});

test('sem modo público nem canal externo, /public/* não responde; e anônimo não alcança a área interna', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('GET', '/public/vagas')).s, 403);
  assert.equal((await call('POST', '/public/candidaturas', { body: ficha(1) })).s, 403);
  // visitante anônimo do modo público: nada de /api (exige identidade do gateway)
  for (const p of ['/api/me', '/api/curriculos/candidatos', '/api/curriculos/vagas', '/api/acessos', '/api/auditoria']) assert.equal((await call('GET', p, { h: PUB })).s, 401, p);
  assert.equal((await call('GET', '/api/curriculos/candidatos/aaaaaaaaaaaaaaaaaaaaaaaa/cv', { h: PUB })).s, 401);
  assert.equal((await call('DELETE', '/api/curriculos/exemplos', { h: PUB })).s, 401);
  // o canal externo continua restrito à entrada pública
  assert.equal((await call('GET', '/api/me', { h: { 'x-vibe-caller-kind': 'external-api', 'x-vibe-caller-key-id': 'k' } })).s, 403);
  srv.close();
});

test('limite por e-mail no modo público e página /carreiras', async () => {
  const { srv, call } = await boot();
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/public/candidaturas', { h: PUB, body: ficha(9, { cidade: 'C' + i }) })).s, 201);
  assert.equal((await call('POST', '/public/candidaturas', { h: PUB, body: ficha(9) })).s, 429, 'o 6º envio do mesmo e-mail na hora é barrado');
  assert.equal((await call('POST', '/public/candidaturas', { h: PUB, body: ficha(10) })).s, 201, 'outros e-mails seguem normais');
  const pg = await call('GET', '/carreiras', { h: { 'x-vibe-user-id': '1' } });
  assert.equal(pg.s, 200); assert.match(pg.j, /Trabalhe conosco/); assert.match(pg.j, /API: "", \/\*API\*\//);
  assert.match(pg.r.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/originallocadora\.com\.br.*https:\/\/\*\.bitrix24\.site/);
  srv.close();
});

test('diagnóstico: sinal da página chega ao servidor e não exige dados pessoais', async () => {
  const { srv, call } = await boot();
  const logs = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    assert.equal((await call('GET', '/public/ping?e=inicio&d=ok&o=https%3A%2F%2Foriginallocadora.com.br&p=%2Ftrabalhe-conosco%2F', { h: { 'x-vibe-public': 'true' } })).s, 204);
    assert.equal((await call('GET', '/public/ping?e=x', {})).s, 403, 'só no modo público');
  } finally { console.log = orig; }
  const l = logs.find(x => x.includes('"ping"')); assert.ok(l && l.includes('originallocadora.com.br') && l.includes('/trabalhe-conosco/'), logs.join('\n'));
  srv.close();
});

test('bloco do site sobrevive ao editor do Bitrix24 (que decodifica entidades HTML ao salvar)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'site', 'trabalhe-conosco.html'), 'utf8');
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  const decodifica = t => t.replace(/&(amp|lt|gt|quot|apos|nbsp);?/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n]).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  assert.equal(decodifica(script), script, 'o script não pode conter entidades HTML (use escapes \\uXXXX)');
  assert.doesNotThrow(() => new Function(decodifica(script)), 'o script decodificado precisa continuar válido');
  assert.equal((html.match(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi) || []).length, 0, 'nem o HTML/CSS pode ter entidades literais');
  // o escape de texto da página continua escapando de verdade
  const esc = new Function(`${script.match(/var ESCMAP[^\n]*\n\s*var esc = [^\n]*/)[0]}; return esc;`)();
  assert.equal(esc(`<b a="x" b='y'>&`), '&lt;b a=&quot;x&quot; b=&#39;y&#39;&gt;&amp;');
});
