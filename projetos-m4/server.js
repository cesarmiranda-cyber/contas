'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { createStore } = require('./lib/store'); const A = require('./lib/auth'); const S = require('./lib/schedule');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = createStore(DATA_DIR); const db = store.db;
const PUB = path.join(__dirname, 'public');
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
  const mudou = aplicarTarefas(p.id, () => db.tarefas.push(t));
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
  db.itens.push(item); store.log(u.nome, u.tipo, item.arquivoId ? 'enviou_arquivo' : 'comentou', `${t.nome}`, p.id); store.save(); send(res, 201, { ok: true });
});
rota('GET', '/api/arquivos/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u); const a = db.arquivos.find(x => x.id === m[1]); if (!a) throw bad(404, 'Arquivo não encontrado.'); tarefaAcessivel(u, a.tarefaId);
  let buf; try { buf = fs.readFileSync(store.file(a.id)); } catch { throw bad(404, 'Arquivo não encontrado.'); }
  store.log(u.nome, u.tipo, 'baixou_arquivo', a.nome);
  res.writeHead(200, { ...SEC, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`, 'Content-Length': buf.length, 'Cache-Control': 'private, no-store' }); res.end(buf);
});

rota('GET', '/api/solicitacoes', async (req, res, _m, _b, u) => {
  exigir(u); const l = db.solicitacoes.filter(s => u.tipo === 'equipe' || s.clienteId === u.id).map(s => ({ ...s, projeto: (projetoDe(s.projetoId) || {}).nome }));
  send(res, 200, { solicitacoes: l.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)) });
});
rota('POST', '/api/solicitacoes', async (req, res, _m, b, u) => {
  exigir(u, 'cliente'); const pid = b.projetoId ? String(b.projetoId) : null; if (pid) { const p = projetoDe(pid); if (!p || !podeVer(u, p)) throw bad(400, 'Projeto inválido.'); }
  const s = { id: store.id(), clienteId: u.id, cliente: u.nome, empresa: u.empresa || '', projetoId: pid, assunto: str(b.assunto, 160, true, 'Assunto'), texto: str(b.texto, 4000, true, 'Descrição'), status: 'nova', resposta: '', criadoEm: store.agora() };
  db.solicitacoes.push(s); store.log(u.nome, 'cliente', 'solicitou', s.assunto, pid); store.save(); send(res, 201, { ok: true });
});
rota('PATCH', '/api/solicitacoes/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const s = db.solicitacoes.find(x => x.id === m[1]); if (!s) throw bad(404, 'Solicitação não encontrada.');
  if (['nova', 'em_analise', 'aprovada', 'recusada', 'concluida'].includes(b.status)) s.status = b.status; if ('resposta' in b) s.resposta = str(b.resposta, 4000);
  store.log(u.nome, 'equipe', 'atualizou_solicitacao', s.assunto, s.projetoId); store.save(); send(res, 200, { ok: true });
});

rota('GET', '/api/clientes', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe');
  send(res, 200, { clientes: db.clientes.map(c => ({ id: c.id, nome: c.nome, email: c.email, empresa: c.empresa, telefone: c.telefone, criadoEm: c.criadoEm, ativo: c.ativo !== false, projetos: db.projetos.filter(p => p.clientes.includes(c.id)).map(p => p.nome), ultimoAcesso: [...db.logs].reverse().find(l => l.tipo === 'cliente' && (l.acao === 'login' || l.acao === 'cadastro') && l.detalhe === c.email)?.ts || null })) });
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
    let b = {}; if (req.method !== 'GET') { if (!mesmaOrigem(req)) throw bad(403, 'Origem não permitida.'); b = await readBody(req, /itens$/.test(pathname) ? 16e6 : 1e6); }
    await hit[2](req, res, hit[1], b, quem(req));
  } catch (e) { if (!e.status) console.error(e); send(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno.' }); }
});
if (require.main === module) { server.listen(PORT, () => console.log(`Projetos M4 na porta ${PORT}`)); process.on('SIGTERM', () => { store.flush(); process.exit(0); }); }
module.exports = { server, store };
