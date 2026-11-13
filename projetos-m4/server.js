'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { createStore } = require('./lib/store'); const { createSecrets, hint, checkWebhook, hostDe } = require('./lib/secrets'); const { createBitrix } = require('./lib/bitrix'); const { createSuporte, CAT, PRIO } = require('./lib/suporte'); const A = require('./lib/auth'); const S = require('./lib/schedule');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = createStore(DATA_DIR); const db = store.db;
const PUB = path.join(__dirname, 'public');
const secrets = createSecrets(DATA_DIR); const bitrix = createBitrix('');
const crypto = require('crypto');
const assinar = (id, exp) => crypto.createHmac('sha256', store.secret).update(`arq.${id}.${exp}`).digest('hex');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const linkArquivo = id => { if (!PUBLIC_URL) return ''; const exp = Date.now() + 30 * 86400e3; return `${PUBLIC_URL}/api/baixar/${id}?e=${exp}&t=${assinar(id, exp)}`; };
const suporte = createSuporte({ store, secrets, bitrix, publicUrl: PUBLIC_URL, linkArquivo });
const MAX_FILE = 10 * 1024 * 1024;

const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  // O portal do cliente abre direto no navegador; só o Bitrix24 pode embutir (iframe) a área da equipe.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'self' https://*.bitrix24.com.br https://*.bitrix24.com https://*.bitrix24.com.ar https://*.bitrix24.es https://*.bitrix24.eu https://*.bitrix24.net https://*.bitrix24.ru",
};
const bad = (c, m) => Object.assign(new Error(m), { status: c });
const send = (res, c, o, extra = {}) => { res.writeHead(c, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(o)); };
const readBody = (req, max = 1e6) => new Promise((ok, no) => {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return no(bad(415, 'Content-Type deve ser application/json.'));
  const ch = []; let n = 0, dead = false;
  req.on('data', c => { n += c.length; if (n > max) { dead = true; ch.length = 0; no(bad(413, 'Corpo grande demais.')); req.resume(); } else if (!dead) ch.push(c); });
  req.on('end', () => { if (dead) return; try { const v = JSON.parse(Buffer.concat(ch).toString('utf8') || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; ok(v); } catch { no(bad(400, 'JSON inválido.')); } });
  req.on('error', () => no(bad(400, 'Requisição interrompida.')));
});

// ---- identidade -------------------------------------------------------------
// Equipe: cabeçalhos do gateway Vibecode (o navegador não os forja); só ID numérico do Bitrix24 conta.
// Cliente: cookie assinado após login.
function quem(req) {
  const h = req.headers, uid = String(h['x-vibe-user-id'] || '');
  if (/^\d+$/.test(uid)) {
    let nome = ''; try { nome = decodeURIComponent(String(h['x-vibe-user-name-encoded'] || '')); } catch { /* sem nome */ }
    return { tipo: 'equipe', id: uid, nome: nome.slice(0, 120) || `Usuário ${uid}`, admin: String(h['x-vibe-user-role'] || '').toUpperCase() === 'ADMIN' };
  }
  const cid = A.ler(store.secret, A.cookies(h.cookie).pm4);
  const c = cid && db.clientes.find(x => x.id === cid && x.ativo !== false);
  return c ? { tipo: 'cliente', id: c.id, nome: c.nome, email: c.email, empresa: c.empresa } : null;
}
const exigir = (u, tipo) => { if (!u) throw bad(401, 'Faça login para continuar.'); if (tipo && u.tipo !== tipo) throw bad(403, 'Acesso negado.'); return u; };
const cookie = (req, tok, max) => `pm4=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${max}${process.env.INSECURE_COOKIE ? '' : '; Secure'}`;
// CSRF: mutações do navegador precisam ser da mesma origem (Sec-Fetch-Site) além do JSON obrigatório.
const mesmaOrigem = req => { const s = req.headers['sec-fetch-site']; return !s || s === 'same-origin' || s === 'none' || s === 'same-site'; };

// ---- helpers de domínio -------------------------------------------------------
const str = (v, max, obrig, campo) => { const s = String(v ?? '').trim(); if (obrig && !s) throw bad(400, `${campo} é obrigatório.`); return s.slice(0, max); };

const TIPOS = ['Implantação Bitrix24', 'Treinamento', 'Integração / Automação', 'Customização', 'Suporte / Sustentação', 'Outro'];
const PRIORIDADES = ['baixa', 'media', 'alta'];
function lerProjeto(b, parcial) {
  const o = {};
  if (!parcial || 'nome' in b) o.nome = str(b.nome, 160, true, 'Nome');
  if ('descricao' in b) o.descricao = str(b.descricao, 4000);
  if ('gerente' in b) o.gerente = str(b.gerente, 120);
  if ('codigo' in b) o.codigo = str(b.codigo, 30);
  if ('tipo' in b) { const t = str(b.tipo, 60); if (t && !TIPOS.includes(t)) throw bad(400, 'Tipo de projeto inválido.'); o.tipo = t; }
  if ('prioridade' in b) { if (b.prioridade && !PRIORIDADES.includes(b.prioridade)) throw bad(400, 'Prioridade inválida.'); o.prioridade = b.prioridade || 'media'; }
  if ('empresa' in b) o.empresa = str(b.empresa, 120);
  if ('contatoNome' in b) o.contatoNome = str(b.contatoNome, 120);
  if ('contatoEmail' in b) { const e = str(b.contatoEmail, 160); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad(400, 'E-mail do contato inválido.'); o.contatoEmail = e; }
  if ('contatoTelefone' in b) o.contatoTelefone = str(b.contatoTelefone, 40);
  for (const k of ['inicioPrevisto', 'fimPrevisto']) if (k in b) { const v = String(b[k] || ''); if (v && !S.isDate(v)) throw bad(400, 'Data inválida (AAAA-MM-DD).'); o[k] = v; }
  if ('valor' in b) { if (b.valor === '' || b.valor == null) o.valor = null; else { const n = Number(b.valor); if (!Number.isFinite(n) || n < 0) throw bad(400, 'Valor inválido.'); o.valor = Math.round(n * 100) / 100; } }
  if ('negocioBitrix' in b) { const v = str(b.negocioBitrix, 12); if (v && !/^\d+$/.test(v)) throw bad(400, 'O ID do negócio no Bitrix24 deve ser numérico.'); o.negocioBitrix = v; }
  if ('link' in b) { const v = str(b.link, 500); if (v && !/^https?:\/\/\S+$/i.test(v)) throw bad(400, 'O link deve começar com http:// ou https://.'); o.link = v; }
  if ('obsInternas' in b) o.obsInternas = str(b.obsInternas, 4000);
  if ('situacao' in b && ['andamento', 'pausado', 'concluido'].includes(b.situacao)) o.situacao = b.situacao;
  return o;
}
const proximoCodigo = () => 'PRJ-' + String(db.projetos.reduce((m, p) => Math.max(m, +(/^PRJ-(\d+)$/.exec(p.codigo || '') || [])[1] || 0), 0) + 1).padStart(4, '0');
function validarProjeto(p) {
  if (p.inicioPrevisto && p.fimPrevisto && p.fimPrevisto < p.inicioPrevisto) throw bad(400, 'O término previsto não pode ser antes do início previsto.');
  if (p.codigo && db.projetos.some(x => x.id !== p.id && x.codigo === p.codigo)) throw bad(409, 'Já existe um projeto com este código.');
}
for (const p of db.projetos) if (!p.codigo) { p.codigo = proximoCodigo(); store.save(); } // projetos criados antes do campo
const tarefasDe = pid => db.tarefas.filter(t => t.projetoId === pid);
const projetoDe = id => db.projetos.find(p => p.id === id);
const hoje = () => S.hojeSP();
function podeVer(u, p) { return u.tipo === 'equipe' || (p && p.clientes.includes(u.id)); }
function tarefaView(t, todas, h, u) {
  const n = db.itens.filter(i => i.tarefaId === t.id).length;
  const { interna, ...r } = t;
  return { ...r, interna: u.tipo === 'equipe' ? !!interna : undefined, status: S.status(t, todas, h), itens: n };
}
function projetoView(p, u, comTarefas) {
  const h = hoje(); const all = tarefasDe(p.id); const vis = u.tipo === 'equipe' ? all : all.filter(t => !t.interna);
  const resumo = S.resumo(vis, h);
  const desvio = p.fimPrevisto && resumo.fim ? S.diffDays(p.fimPrevisto, resumo.fim) : null;
  if (desvio > 0 && resumo.cor !== 'vermelho') resumo.cor = desvio > 7 ? 'vermelho' : 'amarelo'; // previsão além do prazo contratado
  const out = { id: p.id, nome: p.nome, descricao: p.descricao, gerente: p.gerente, situacao: p.situacao, criadoEm: p.criadoEm, resumo, hoje: h,
    codigo: p.codigo || '', tipo: p.tipo || '', prioridade: p.prioridade || 'media', empresa: p.empresa || '', contatoNome: p.contatoNome || '', contatoEmail: p.contatoEmail || '', contatoTelefone: p.contatoTelefone || '',
    inicioPrevisto: p.inicioPrevisto || '', fimPrevisto: p.fimPrevisto || '', link: p.link || '',
    desvioDias: desvio };
  if (u.tipo === 'equipe') { // campos internos: o cliente nunca recebe
    out.valor = p.valor ?? null; out.negocioBitrix = p.negocioBitrix || ''; out.obsInternas = p.obsInternas || '';
    out.clientes = p.clientes.map(id => { const c = db.clientes.find(x => x.id === id); return c ? { id, nome: c.nome, email: c.email, empresa: c.empresa } : null; }).filter(Boolean);
  }
  if (comTarefas) out.tarefas = vis.map(t => tarefaView(t, vis, h, u));
  return out;
}
function lerTarefa(b, parcial) {
  const o = {};
  if (!parcial || 'nome' in b) o.nome = str(b.nome, 160, true, 'Nome');
  for (const k of ['inicio', 'fim']) if (!parcial || k in b) { if (!S.isDate(b[k])) throw bad(400, `Data de ${k === 'inicio' ? 'início' : 'término'} inválida (AAAA-MM-DD).`); o[k] = b[k]; }
  if ('progresso' in b) o.progresso = Math.max(0, Math.min(100, Math.round(+b.progresso || 0)));
  if ('responsavel' in b) o.responsavel = str(b.responsavel, 160);
  if ('descricao' in b) o.descricao = str(b.descricao, 2000);
  if ('interna' in b) o.interna = !!b.interna;
  if ('aguardaCliente' in b) o.aguardaCliente = !!b.aguardaCliente;
  if ('pedido' in b) o.pedido = str(b.pedido, 500);
  if ('deps' in b) {
    if (!Array.isArray(b.deps) || b.deps.length > 30) throw bad(400, 'Dependências inválidas.');
    o.deps = b.deps.map(d => ({ de: String(d.de), tipo: d.tipo === 'SS' ? 'SS' : 'FS', lag: Math.max(-365, Math.min(365, Math.round(+d.lag || 0))) }));
  }
  return o;
}
// Salva tarefa, valida dependências (mesmo projeto, sem ciclo) e reagenda as sucessoras.
function aplicarTarefas(pid, mexe) {
  const antes = tarefasDe(pid).map(t => JSON.stringify(t)); const bkp = new Map(tarefasDe(pid).map(t => [t.id, { ...t }]));
  try {
    mexe(); const all = tarefasDe(pid); const ids = new Set(all.map(t => t.id));
    for (const t of all) { t.deps = (t.deps || []).filter(d => d.de !== t.id && ids.has(d.de)); if (t.fim < t.inicio) throw bad(400, 'O término não pode ser antes do início.'); }
    return S.reagendar(all);
  } catch (e) { // desfaz
    db.tarefas = db.tarefas.filter(t => t.projetoId !== pid || bkp.has(t.id)); for (const t of db.tarefas) if (bkp.has(t.id)) Object.assign(t, bkp.get(t.id)); void antes; throw e;
  }
}

// ---- rotas --------------------------------------------------------------------
const R = [];
const rota = (m, re, fn) => R.push([m, new RegExp(`^${re}$`), fn]);

rota('POST', '/api/auth/cadastro', async (req, res, _m, b) => {
  const email = str(b.email, 160, true, 'E-mail').toLowerCase(), nome = str(b.nome, 120, true, 'Nome');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad(400, 'E-mail inválido.');
  if (String(b.senha || '').length < 8) throw bad(400, 'A senha deve ter ao menos 8 caracteres.');
  if (db.clientes.some(c => c.email === email)) throw bad(409, 'Já existe uma conta com este e-mail.');
  const c = { id: store.id(), nome, email, empresa: str(b.empresa, 120), telefone: str(b.telefone, 40), senha: A.hash(String(b.senha)), criadoEm: store.agora(), ativo: true };
  db.clientes.push(c); store.log(nome, 'cliente', 'cadastro', email); store.save();
  send(res, 201, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
const falhas = new Map();
rota('POST', '/api/auth/login', async (req, res, _m, b) => {
  const email = String(b.email || '').trim().toLowerCase(), f = falhas.get(email) || { n: 0, ate: 0 };
  if (f.n >= 5 && Date.now() < f.ate) throw bad(429, 'Muitas tentativas. Tente novamente em alguns minutos.');
  const c = db.clientes.find(x => x.email === email && x.ativo !== false);
  if (!c || !A.confere(String(b.senha || ''), c.senha)) { falhas.set(email, { n: f.n + 1, ate: Date.now() + 15 * 60e3 }); store.log(email || '?', 'cliente', 'login_falhou'); throw bad(401, 'E-mail ou senha incorretos.'); }
  falhas.delete(email); store.log(c.nome, 'cliente', 'login', c.email);
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
rota('POST', '/api/auth/logout', async (req, res) => send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) }));
rota('GET', '/api/me', async (req, res, _m, _b, u) => send(res, 200, { usuario: u }));

rota('GET', '/api/projetos', async (req, res, _m, _b, u) => {
  exigir(u); const lista = db.projetos.filter(p => podeVer(u, p)).map(p => projetoView(p, u, false));
  send(res, 200, { projetos: lista.sort((a, b) => a.nome.localeCompare(b.nome)) });
});
rota('GET', '/api/projetos/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u); const p = projetoDe(m[1]); if (!p || !podeVer(u, p)) throw bad(404, 'Projeto não encontrado.');
  if (u.tipo === 'cliente') store.log(u.nome, 'cliente', 'abriu_projeto', p.nome, p.id);
  send(res, 200, { projeto: projetoView(p, u, true) });
});
rota('POST', '/api/projetos', async (req, res, _m, b, u) => {
  exigir(u, 'equipe');
  const d = lerProjeto(b, false);
  const p = { situacao: 'andamento', prioridade: 'media', ...d, id: store.id(), gerente: d.gerente || u.nome, descricao: d.descricao || '', clientes: [], criadoEm: store.agora(), criadoPor: u.nome };
  p.codigo = p.codigo || proximoCodigo(); validarProjeto(p);
  if (Array.isArray(b.clientes)) p.clientes = [...new Set(b.clientes.map(String))].filter(id => db.clientes.some(c => c.id === id));
  db.projetos.push(p); store.log(u.nome, 'equipe', 'criou_projeto', p.nome, p.id); store.save(); send(res, 201, { projeto: projetoView(p, u, true) });
});
rota('PATCH', '/api/projetos/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.');
  const novo = { ...p, ...lerProjeto(b, true) }; validarProjeto(novo);
  if (Array.isArray(b.clientes)) novo.clientes = [...new Set(b.clientes.map(String))].filter(id => db.clientes.some(c => c.id === id));
  Object.assign(p, novo); store.log(u.nome, 'equipe', 'editou_projeto', p.nome, p.id); store.save(); send(res, 200, { projeto: projetoView(p, u, true) });
});
rota('DELETE', '/api/projetos/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); if (!u.admin) throw bad(403, 'Somente administradores excluem projetos.');
  const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.');
  const tids = new Set(tarefasDe(p.id).map(t => t.id));
  for (const a of db.arquivos.filter(a => tids.has(a.tarefaId))) fs.rm(store.file(a.id), () => {});
  db.arquivos = db.arquivos.filter(a => !tids.has(a.tarefaId)); db.itens = db.itens.filter(i => !tids.has(i.tarefaId));
  db.tarefas = db.tarefas.filter(t => t.projetoId !== p.id); db.projetos = db.projetos.filter(x => x.id !== p.id);
  store.log(u.nome, 'equipe', 'excluiu_projeto', p.nome); store.save(); send(res, 200, { ok: true });
});
rota('POST', '/api/projetos/([0-9a-f]+)/tarefas', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.');
  const d = lerTarefa(b, false); const t = { id: store.id(), projetoId: p.id, progresso: 0, responsavel: '', descricao: '', interna: false, deps: [], ...d, ordem: tarefasDe(p.id).length };
  const mudou = aplicarTarefas(p.id, () => db.tarefas.push(t)); if (t.aguardaCliente) store.log(u.nome, 'equipe', 'pediu_cliente', t.nome, p.id);
  store.log(u.nome, 'equipe', 'criou_tarefa', t.nome, p.id); store.save(); send(res, 201, { tarefa: t.id, reagendadas: mudou });
});
rota('PATCH', '/api/tarefas/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const t = db.tarefas.find(x => x.id === m[1]); if (!t) throw bad(404, 'Tarefa não encontrada.');
  const d = lerTarefa(b, true); const mudou = aplicarTarefas(t.projetoId, () => Object.assign(t, d));
  store.log(u.nome, 'equipe', 'editou_tarefa', t.nome, t.projetoId); store.save(); send(res, 200, { ok: true, reagendadas: mudou });
});
rota('DELETE', '/api/tarefas/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); const t = db.tarefas.find(x => x.id === m[1]); if (!t) throw bad(404, 'Tarefa não encontrada.');
  for (const a of db.arquivos.filter(a => a.tarefaId === t.id)) fs.rm(store.file(a.id), () => {});
  db.arquivos = db.arquivos.filter(a => a.tarefaId !== t.id); db.itens = db.itens.filter(i => i.tarefaId !== t.id);
  db.tarefas = db.tarefas.filter(x => x.id !== t.id); for (const o of db.tarefas) o.deps = (o.deps || []).filter(d => d.de !== t.id);
  store.log(u.nome, 'equipe', 'excluiu_tarefa', t.nome, t.projetoId); store.save(); send(res, 200, { ok: true });
});

function tarefaAcessivel(u, id) {
  exigir(u); const t = db.tarefas.find(x => x.id === id); const p = t && projetoDe(t.projetoId);
  if (!t || !p || !podeVer(u, p) || (t.interna && u.tipo !== 'equipe')) throw bad(404, 'Atividade não encontrada.'); return [t, p];
}
rota('GET', '/api/tarefas/([0-9a-f]+)/itens', async (req, res, m, _b, u) => {
  const [t] = tarefaAcessivel(u, m[1]);
  send(res, 200, { itens: db.itens.filter(i => i.tarefaId === t.id).map(i => ({ ...i, arquivo: i.arquivoId ? db.arquivos.find(a => a.id === i.arquivoId) && { id: i.arquivoId, nome: db.arquivos.find(a => a.id === i.arquivoId).nome, tamanho: db.arquivos.find(a => a.id === i.arquivoId).tamanho } : undefined })) });
});
rota('POST', '/api/tarefas/([0-9a-f]+)/itens', async (req, res, m, b, u) => {
  const [t, p] = tarefaAcessivel(u, m[1]);
  const item = { id: store.id(), tarefaId: t.id, autor: u.nome, tipoAutor: u.tipo, ts: store.agora(), texto: str(b.texto, 4000) };
  if (b.arquivo) {
    const nome = str(b.arquivo.nome, 160, true, 'Nome do arquivo').replace(/[\\/\0\r\n"]/g, '_'); const buf = Buffer.from(String(b.arquivo.base64 || ''), 'base64');
    if (!buf.length) throw bad(400, 'Arquivo vazio.'); if (buf.length > MAX_FILE) throw bad(413, 'Arquivo acima de 10 MB.');
    const a = { id: store.id(), tarefaId: t.id, nome, tamanho: buf.length, ts: item.ts }; fs.writeFileSync(store.file(a.id), buf, { mode: 0o600 });
    db.arquivos.push(a); item.arquivoId = a.id;
  }
  if (!item.texto && !item.arquivoId) throw bad(400, 'Escreva um texto ou anexe um documento.');
  if (u.tipo === 'cliente' && t.aguardaCliente) t.respondidoEm = item.ts;
  db.itens.push(item); store.log(u.nome, u.tipo, item.arquivoId ? 'enviou_arquivo' : 'comentou', `${t.nome}`, p.id); store.save(); send(res, 201, { ok: true });
});
function enviarArquivo(res, a, u) {
  let buf; try { buf = fs.readFileSync(store.file(a.id)); } catch { throw bad(404, 'Arquivo não encontrado.'); }
  store.log(u ? u.nome : 'Link assinado', u ? u.tipo : 'equipe', 'baixou_arquivo', a.nome);
  res.writeHead(200, { ...SEC, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`, 'Content-Length': buf.length, 'Cache-Control': 'private, no-store' }); res.end(buf);
}
rota('GET', '/api/arquivos/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u); const a = db.arquivos.find(x => x.id === m[1]); if (!a) throw bad(404, 'Arquivo não encontrado.');
  if (a.solicitacaoId) { const s = db.solicitacoes.find(x => x.id === a.solicitacaoId); if (!s || (u.tipo === 'cliente' && s.clienteId !== u.id)) throw bad(404, 'Arquivo não encontrado.'); } else tarefaAcessivel(u, a.tarefaId);
  enviarArquivo(res, a, u);
});
// Link com assinatura e validade, colocado no card do Bitrix24 para a equipe baixar sem login no portal.
rota('GET', '/api/baixar/([0-9a-f]+)', async (req, res, m) => {
  const q = new URL(req.url, 'http://x').searchParams, exp = +q.get('e'), t = String(q.get('t') || ''); const esperado = assinar(m[1], exp);
  const ok = Number.isFinite(exp) && exp > Date.now() && t.length === esperado.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(esperado));
  if (!ok) throw bad(403, 'Link inválido ou expirado.'); const a = db.arquivos.find(x => x.id === m[1]); if (!a) throw bad(404, 'Arquivo não encontrado.'); enviarArquivo(res, a, null);
});

const protocolo = () => 'SUP-' + String(db.solicitacoes.reduce((m, x) => Math.max(m, +(/^SUP-(\d+)$/.exec(x.protocolo || '') || [])[1] || 0), 0) + 1).padStart(4, '0');
const cardUrl = s => s.bitrix && s.bitrix.dealId && bitrix.base ? `https://${hostDe(bitrix.base)}/crm/deal/details/${s.bitrix.dealId}/` : '';
const msgView = m => { const a = m.arquivoId && db.arquivos.find(x => x.id === m.arquivoId); return { id: m.id, autor: m.autor, tipoAutor: m.tipoAutor, ts: m.ts, texto: m.texto, arquivo: a ? { id: a.id, nome: a.nome, tamanho: a.tamanho } : undefined }; };
function solView(s, u) {
  const base = { id: s.id, protocolo: s.protocolo, projetoId: s.projetoId, projeto: (projetoDe(s.projetoId) || {}).nome, categoria: s.categoria, prioridade: s.prioridade, assunto: s.assunto, texto: s.texto, status: s.status, resposta: s.resposta, criadoEm: s.criadoEm,
    etapa: s.etapa ? s.etapa.nome : '', historico: s.historico || [], mensagens: (s.mensagens || []).map(msgView), avaliacao: s.avaliacao ? { nota: s.avaliacao.nota, comentario: s.avaliacao.comentario, ts: s.avaliacao.ts } : null,
    podeAvaliar: !s.avaliacao && (s.status === 'concluida' || (s.etapa && s.etapa.semantica === 'S')) };
  return u.tipo === 'equipe' ? { ...base, cliente: s.cliente, empresa: s.empresa, email: s.email, telefone: s.telefone, bitrix: s.bitrix ? { status: s.bitrix.status, erro: s.bitrix.erro, dealId: s.bitrix.dealId, tentativas: s.bitrix.tentativas, url: cardUrl(s) } : null } : base;
}
rota('GET', '/api/solicitacoes', async (req, res, _m, _b, u) => {
  exigir(u); await suporte.sincronizarSeVelho(); // etapa do card sempre fresca (no máx. 1 consulta/min)
  const l = db.solicitacoes.filter(s => u.tipo === 'equipe' || s.clienteId === u.id).map(s => solView(s, u));
  send(res, 200, { solicitacoes: l.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)), categorias: CAT, prioridades: PRIO });
});
rota('POST', '/api/solicitacoes', async (req, res, _m, b, u) => {
  exigir(u, 'cliente'); const pid = b.projetoId ? String(b.projetoId) : null; if (pid) { const p = projetoDe(pid); if (!p || !podeVer(u, p)) throw bad(400, 'Projeto inválido.'); }
  if (b.categoria && !CAT[b.categoria]) throw bad(400, 'Categoria inválida.'); if (b.prioridade && !PRIO[b.prioridade]) throw bad(400, 'Prioridade inválida.');
  const conta = db.clientes.find(c => c.id === u.id) || {};
  const s = { id: store.id(), protocolo: protocolo(), clienteId: u.id, cliente: u.nome, empresa: u.empresa || '', email: conta.email || '', telefone: str(b.telefone, 40) || conta.telefone || '', projetoId: pid, categoria: b.categoria || 'duvida', prioridade: b.prioridade || 'media',
    assunto: str(b.assunto, 160, true, 'Assunto'), texto: str(b.texto, 4000, true, 'Descrição'), status: 'nova', resposta: '', mensagens: [], criadoEm: store.agora(), bitrix: { status: 'pendente', tentativas: 0 } };
  db.solicitacoes.push(s); store.log(u.nome, 'cliente', 'solicitou', `${s.protocolo} · ${s.assunto}`, pid, { cliente: u.id }); store.save();
  suporte.enviar(s).catch(() => {}); // cria o card em segundo plano; se falhar, a fila reenvia
  send(res, 201, { ok: true, protocolo: s.protocolo, id: s.id });
});
rota('PATCH', '/api/solicitacoes/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const s = db.solicitacoes.find(x => x.id === m[1]); if (!s) throw bad(404, 'Solicitação não encontrada.');
  if (['nova', 'em_analise', 'aprovada', 'recusada', 'concluida'].includes(b.status)) s.status = b.status; if ('resposta' in b) s.resposta = str(b.resposta, 4000);
  store.log(u.nome, 'equipe', 'atualizou_solicitacao', `${s.protocolo} · ${s.assunto}`, s.projetoId); store.save(); send(res, 200, { ok: true });
});
rota('POST', '/api/solicitacoes/([0-9a-f]+)/reenviar', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); const s = db.solicitacoes.find(x => x.id === m[1]); if (!s) throw bad(404, 'Solicitação não encontrada.');
  suporte.aplicar(); const r = await suporte.enviar(s); store.log(u.nome, 'equipe', 'reenviou_chamado', s.protocolo, s.projetoId); send(res, 200, { bitrix: { status: r.status, erro: r.erro, dealId: r.dealId, url: cardUrl(s) } });
});

const solAcessivel = (u, id) => { exigir(u); const s = db.solicitacoes.find(x => x.id === id); if (!s || (u.tipo === 'cliente' && s.clienteId !== u.id)) throw bad(404, 'Chamado não encontrado.'); return s; };
rota('POST', '/api/solicitacoes/([0-9a-f]+)/mensagens', async (req, res, m, b, u) => {
  const s = solAcessivel(u, m[1]); const msg = { id: store.id(), autor: u.nome, tipoAutor: u.tipo, ts: store.agora(), texto: str(b.texto, 4000), bx: false };
  if (b.arquivo) {
    const nome = str(b.arquivo.nome, 160, true, 'Nome do arquivo').replace(/[\\/\0\r\n"]/g, '_'); const buf = Buffer.from(String(b.arquivo.base64 || ''), 'base64');
    if (!buf.length) throw bad(400, 'Arquivo vazio.'); if (buf.length > MAX_FILE) throw bad(413, 'Arquivo acima de 10 MB.');
    const a = { id: store.id(), solicitacaoId: s.id, nome, tamanho: buf.length, ts: msg.ts }; fs.writeFileSync(store.file(a.id), buf, { mode: 0o600 }); db.arquivos.push(a); msg.arquivoId = a.id;
  }
  if (!msg.texto && !msg.arquivoId) throw bad(400, 'Escreva uma mensagem ou anexe um documento.');
  (s.mensagens = s.mensagens || []).push(msg); if (u.tipo === 'equipe' && s.status === 'nova') s.status = 'em_analise';
  store.log(u.nome, u.tipo, u.tipo === 'cliente' ? 'complementou_chamado' : 'respondeu_chamado', `${s.protocolo} · ${s.assunto}`, s.projetoId, { cliente: s.clienteId }); store.save();
  suporte.flushMensagens(s).catch(() => {}); send(res, 201, { ok: true });
});
rota('POST', '/api/solicitacoes/([0-9a-f]+)/avaliar', async (req, res, m, b, u) => {
  exigir(u, 'cliente'); const s = solAcessivel(u, m[1]); const nota = Math.round(+b.nota);
  if (!(nota >= 1 && nota <= 5)) throw bad(400, 'A nota deve ser de 1 a 5.'); if (s.avaliacao) throw bad(409, 'Este atendimento já foi avaliado.');
  if (!(s.status === 'concluida' || (s.etapa && s.etapa.semantica === 'S'))) throw bad(400, 'Você poderá avaliar quando o atendimento for concluído.');
  s.avaliacao = { nota, comentario: str(b.comentario, 1000), ts: store.agora() }; store.log(u.nome, 'cliente', 'avaliou_atendimento', `${s.protocolo} · ${nota}/5`, s.projetoId, { cliente: u.id }); store.save();
  suporte.avaliacaoBitrix(s).catch(() => {}); send(res, 201, { ok: true });
});

// ---- início do cliente: o que precisa dele, o que está acontecendo e novidades ----
const ROTULO = { criou_tarefa: d => `Nova atividade: ${d}`, editou_tarefa: d => `Atividade atualizada: ${d}`, comentou: d => `A equipe comentou em ${d}`, enviou_arquivo: d => `A equipe enviou um documento em ${d}`, pediu_cliente: d => `A equipe precisa de você em ${d}`,
  editou_projeto: () => 'Dados do projeto atualizados', respondeu_chamado: d => `A equipe respondeu o chamado ${d}`, etapa_chamado: d => `Chamado: ${d}` };
function novidadesDe(u) {
  const c = db.clientes.find(x => x.id === u.id) || {}; const meus = new Set(db.projetos.filter(p => p.clientes.includes(u.id)).map(p => p.id)); const desde = Date.now() - 30 * 86400e3; const vistas = new Map();
  for (const l of [...db.logs].reverse()) {
    if (l.tipo !== 'equipe' || !ROTULO[l.acao] || Date.parse(l.ts) < desde) continue; if (!(l.cliente === u.id || (l.projetoId && meus.has(l.projetoId)))) continue;
    if (['criou_tarefa', 'editou_tarefa', 'pediu_cliente', 'comentou', 'enviou_arquivo'].includes(l.acao) && db.tarefas.some(x => x.projetoId === l.projetoId && x.nome === l.detalhe && x.interna)) continue; // atividade interna nunca aparece
    const k = l.acao + '|' + l.detalhe + '|' + (l.projetoId || ''); const ant = vistas.get(k); if (ant && Math.abs(Date.parse(ant.ts) - Date.parse(l.ts)) < 3600e3) continue; vistas.set(k, l);
  }
  const itens = [...vistas.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 20).map(l => ({ ts: l.ts, texto: ROTULO[l.acao](l.detalhe), projeto: (projetoDe(l.projetoId) || {}).nome || '' }));
  const visto = c.vistoEm || c.criadoEm || '1970'; return { itens, novas: itens.filter(i => i.ts > visto).length };
}
rota('GET', '/api/novidades', async (req, res, _m, _b, u) => { exigir(u, 'cliente'); send(res, 200, novidadesDe(u)); });
rota('POST', '/api/novidades/lido', async (req, res, _m, _b, u) => { exigir(u, 'cliente'); const c = db.clientes.find(x => x.id === u.id); if (c) { c.vistoEm = store.agora(); store.save(); } send(res, 200, { ok: true }); });
rota('GET', '/api/inicio', async (req, res, _m, _b, u) => {
  exigir(u, 'cliente'); const h = hoje(); const meus = db.projetos.filter(p => p.clientes.includes(u.id)); const pendencias = [], agora = [], proximas = [];
  for (const p of meus) for (const t of tarefasDe(p.id).filter(x => !x.interna)) {
    const st = S.status(t, tarefasDe(p.id).filter(x => !x.interna), h); const item = { projetoId: p.id, projeto: p.nome, tarefaId: t.id, tarefa: t.nome, inicio: t.inicio, fim: t.fim, progresso: t.progresso, status: st };
    if (t.aguardaCliente && (+t.progresso || 0) < 100) pendencias.push({ ...item, pedido: t.pedido || '', respondidoEm: t.respondidoEm || null });
    if (st.codigo !== 'concluida' && t.inicio <= h) agora.push(item); else if (st.codigo !== 'concluida' && S.diffDays(h, t.inicio) <= 14) proximas.push(item);
  }
  const por = (a, b) => a.fim.localeCompare(b.fim) || a.inicio.localeCompare(b.inicio);
  send(res, 200, { pendencias: pendencias.sort(por), agora: agora.sort(por).slice(0, 6), proximas: proximas.sort((a, b) => a.inicio.localeCompare(b.inicio)).slice(0, 5), novidades: novidadesDe(u).novas });
});

// ---- integração com o funil de suporte (somente administradores do Bitrix24) ----
const exigirAdmin = u => { exigir(u, 'equipe'); if (!u.admin) throw bad(403, 'Somente administradores configuram a integração.'); };
const estadoSuporte = () => { const c = suporte.cfg(); return { configurado: bitrix.enabled, host: hostDe(bitrix.base), dica: hint(suporte.webhook()), origem: secrets.get('bitrixWebhook') ? 'painel' : process.env.BITRIX_WEBHOOK ? 'ambiente' : 'nenhuma', categoriaId: c.categoriaId ?? null, estagioId: c.estagioId || '', funilNome: c.funilNome || '', etapaNome: c.etapaNome || '', pronto: suporte.pronto(),
  pendentes: db.solicitacoes.filter(s => s.bitrix && s.bitrix.status !== 'enviado').length }; };
rota('GET', '/api/config/suporte', async (req, res, _m, _b, u) => { exigirAdmin(u); send(res, 200, estadoSuporte()); });
rota('POST', '/api/config/suporte/testar', async (req, res, _m, b, u) => {
  exigirAdmin(u); const w = String(b.webhook || '').trim() || suporte.webhook(); const erro = checkWebhook(w); if (erro) throw bad(400, erro);
  try { const funis = await suporte.funis(w); send(res, 200, { ok: true, funis }); } catch (e) { throw bad(502, 'Não consegui consultar o Bitrix24: ' + e.message); }
});
rota('POST', '/api/config/suporte', async (req, res, _m, b, u) => {
  exigirAdmin(u); const w = String(b.webhook || '').trim();
  if (w) { const erro = checkWebhook(w); if (erro) throw bad(400, erro); secrets.set({ bitrixWebhook: w }); }
  if (!suporte.webhook()) throw bad(400, 'Informe o webhook do Bitrix24.'); suporte.aplicar();
  if (b.categoriaId == null || !b.estagioId) throw bad(400, 'Escolha o funil e a etapa inicial.');
  db.config.suporte = { categoriaId: +b.categoriaId, estagioId: str(b.estagioId, 60, true, 'Etapa'), funilNome: str(b.funilNome, 120), etapaNome: str(b.etapaNome, 120) };
  store.log(u.nome, 'equipe', 'configurou_suporte', `${db.config.suporte.funilNome} / ${db.config.suporte.etapaNome}`); store.save();
  const n = await suporte.processarPendentes(); send(res, 200, { ...estadoSuporte(), reenviados: n });
});
rota('POST', '/api/config/suporte/reenviar', async (req, res, _m, _b, u) => { exigirAdmin(u); suporte.aplicar(); const n = await suporte.processarPendentes(); send(res, 200, { ...estadoSuporte(), reenviados: n }); });

rota('GET', '/api/clientes', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe');
  send(res, 200, { clientes: db.clientes.map(c => ({ id: c.id, nome: c.nome, email: c.email, empresa: c.empresa, telefone: c.telefone, criadoEm: c.criadoEm, ativo: c.ativo !== false,
    projetoIds: db.projetos.filter(p => p.clientes.includes(c.id)).map(p => p.id), projetos: db.projetos.filter(p => p.clientes.includes(c.id)).map(p => p.nome),
    chamados: db.solicitacoes.filter(x => x.clienteId === c.id).length,
    ultimoAcesso: [...db.logs].reverse().find(l => l.tipo === 'cliente' && (l.acao === 'login' || l.acao === 'cadastro') && l.detalhe === c.email)?.ts || null })) });
});
// Ativa/ajusta o acesso do cliente: define exatamente em quais projetos ele entra.
rota('POST', '/api/clientes/([0-9a-f]+)/projetos', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const c = db.clientes.find(x => x.id === m[1]); if (!c) throw bad(404, 'Cliente não encontrado.');
  if (!Array.isArray(b.projetos)) throw bad(400, 'Informe a lista de projetos.');
  const alvo = new Set(b.projetos.map(String)); if ([...alvo].some(id => !projetoDe(id))) throw bad(400, 'Projeto inválido.');
  const antes = db.projetos.filter(p => p.clientes.includes(c.id)).length;
  for (const p of db.projetos) { const tem = p.clientes.includes(c.id); if (alvo.has(p.id) && !tem) p.clientes.push(c.id); else if (!alvo.has(p.id) && tem) p.clientes = p.clientes.filter(x => x !== c.id); }
  store.log(u.nome, 'equipe', antes === 0 && alvo.size ? 'ativou_cliente' : 'alterou_acesso_cliente', `${c.nome} → ${alvo.size} projeto(s)`); store.save(); send(res, 200, { ok: true, projetos: alvo.size });
});
rota('PATCH', '/api/clientes/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const c = db.clientes.find(x => x.id === m[1]); if (!c) throw bad(404, 'Cliente não encontrado.');
  if ('ativo' in b) c.ativo = !!b.ativo; store.log(u.nome, 'equipe', c.ativo ? 'reativou_cliente' : 'bloqueou_cliente', c.email); store.save(); send(res, 200, { ok: true });
});
rota('GET', '/api/logs', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe'); const q = new URL(req.url, 'http://x').searchParams, pid = q.get('projeto'), tipo = q.get('tipo');
  const l = db.logs.filter(x => (!pid || x.projetoId === pid) && (!tipo || x.tipo === tipo)).slice(-300).reverse().map(x => ({ ...x, projeto: (projetoDe(x.projetoId) || {}).nome }));
  send(res, 200, { logs: l });
});
rota('GET', '/api/painel', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe'); const ps = db.projetos.map(p => projetoView(p, u, false));
  send(res, 200, { projetos: ps.length, verde: ps.filter(p => p.resumo.cor === 'verde').length, amarelo: ps.filter(p => p.resumo.cor === 'amarelo').length, vermelho: ps.filter(p => p.resumo.cor === 'vermelho').length,
    solicitacoesNovas: db.solicitacoes.filter(s => s.status === 'nova').length, clientes: db.clientes.length,
    avaliacaoMedia: (() => { const n = db.solicitacoes.filter(x => x.avaliacao).map(x => x.avaliacao.nota); return n.length ? Math.round(n.reduce((a, b) => a + b, 0) / n.length * 10) / 10 : null; })(),
    aguardando: db.clientes.filter(c => c.ativo !== false && !db.projetos.some(p => p.clientes.includes(c.id))).length });
});

// ---- estáticos ----------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function estatico(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
  const f = path.join(PUB, path.normalize(p)); if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { erro: 'Não encontrado.' });
  res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'); const pathname = url.pathname;
    if (pathname === '/health') return send(res, 200, { ok: true });
    if (!pathname.startsWith('/api/')) return estatico(req, res);
    const hit = R.map(([m, re, fn]) => [m, re.exec(pathname), fn]).find(([m, mm]) => mm && m === req.method);
    if (!hit) return send(res, 404, { erro: 'Rota não encontrada.' });
    let b = {}; if (req.method !== 'GET') { if (!mesmaOrigem(req)) throw bad(403, 'Origem não permitida.'); b = await readBody(req, /(itens|mensagens)$/.test(pathname) ? 16e6 : 1e6); }
    await hit[2](req, res, hit[1], b, quem(req));
  } catch (e) { if (!e.status) console.error(e); send(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno.' }); }
});
if (require.main === module) { server.listen(PORT, () => console.log(`Projetos M4 na porta ${PORT}`)); setInterval(() => suporte.ciclo(), 2 * 60e3).unref(); setTimeout(() => suporte.ciclo(), 5e3).unref(); process.on('SIGTERM', () => { store.flush(); process.exit(0); }); }
module.exports = { server, store, suporte, bitrix, secrets };
