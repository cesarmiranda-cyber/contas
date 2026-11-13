'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { createStore } = require('./lib/store'); const { createSecrets, hint, checkWebhook, hostDe } = require('./lib/secrets'); const { createBitrix } = require('./lib/bitrix'); const { createSuporte, CAT, PRIO } = require('./lib/suporte'); const Audit = require('./lib/auditoria'); const Modelos = require('./lib/modelos'); const SLA = require('./lib/sla'); const Ajuda = require('./lib/ajuda'); const A = require('./lib/auth'); const S = require('./lib/schedule');

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
  if (req.method === 'DELETE' && !req.headers['content-length'] && !req.headers['transfer-encoding']) { req.resume(); return ok({}); } // DELETE não tem corpo
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
    const nomeFinal = nome.slice(0, 120) || `Usuário ${uid}`; const e = (db.equipe = db.equipe || {})[uid]; // lembra quem da equipe já usou o app (para atribuir chamados)
    if (!e || e.nome !== nomeFinal || Date.now() - Date.parse(e.visto) > 10 * 60e3) { db.equipe[uid] = { id: uid, nome: nomeFinal, visto: new Date().toISOString() }; store.save(); }
    return { tipo: 'equipe', id: uid, nome: nomeFinal, admin: String(h['x-vibe-user-role'] || '').toUpperCase() === 'ADMIN' };
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
  if ('diasUteis' in b) o.diasUteis = !!b.diasUteis;
  if ('feriadosExtras' in b) { const lista = Array.isArray(b.feriadosExtras) ? b.feriadosExtras : String(b.feriadosExtras || '').split(/[\s,;]+/).filter(Boolean); if (lista.length > 60) throw bad(400, 'No máximo 60 feriados extras.'); if (lista.some(d => !S.isDate(d))) throw bad(400, 'Feriados extras: use datas AAAA-MM-DD.'); o.feriadosExtras = [...new Set(lista)].sort(); }
  if ('situacao' in b && ['andamento', 'pausado', 'concluido'].includes(b.situacao)) o.situacao = b.situacao;
  return o;
}
const proximoCodigo = () => 'PRJ-' + String(db.projetos.reduce((m, p) => Math.max(m, +(/^PRJ-(\d+)$/.exec(p.codigo || '') || [])[1] || 0), 0) + 1).padStart(4, '0');
function validarProjeto(p) {
  if (p.inicioPrevisto && p.fimPrevisto && p.fimPrevisto < p.inicioPrevisto) throw bad(400, 'O término previsto não pode ser antes do início previsto.');
  if (p.codigo && db.projetos.some(x => x.id !== p.id && x.codigo === p.codigo)) throw bad(409, 'Já existe um projeto com este código.');
}
for (const p of db.projetos) if (!p.codigo) { p.codigo = proximoCodigo(); store.save(); } // projetos criados antes do campo
// registro de alterações (quem, o quê, de → para); 'uid' = id do usuário no Bitrix24 ou do cliente
const reg = (u, acao, detalhe = '', projetoId = null, extra = {}) => store.log(u.nome, u.tipo, acao, detalhe, projetoId, { uid: u.id, ...extra });
const vistos = new Map(); // evita encher o registro quando a mesma tela é aberta várias vezes seguidas
const regUnico = (u, chave, ms, ...args) => { const k = `${u.id}|${chave}`; if (Date.now() - (vistos.get(k) || 0) < ms) return; vistos.set(k, Date.now()); reg(u, ...args); };
const snapT = t => ({ ...t, deps: (t.deps || []).map(d => ({ ...d })) });
const nomeTarefa = id => (db.tarefas.find(x => x.id === id) || {}).nome || '(atividade removida)';
const desfazerDe = (alvo, id, antes, depois, campos) => { const b = Audit.bruto(antes, depois, campos); return b ? { alvo, id, ...b } : undefined; };
const nomeCliente = id => (db.clientes.find(c => c.id === id) || {}).nome || id;
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
    inicioPrevisto: p.inicioPrevisto || '', fimPrevisto: p.fimPrevisto || '', link: p.link || '', diasUteis: !!p.diasUteis, feriadosExtras: p.feriadosExtras || [],
    feriados: p.diasUteis ? (() => { const ds = all.flatMap(t => [t.inicio, t.fim]).sort(); return ds.length ? calDe(p).feriadosEntre(S.addDays(ds[0], -30), S.addDays(ds[ds.length - 1], 120)) : []; })() : [],
    desvioDias: desvio };
  if (u.tipo === 'equipe') { // campos internos: o cliente nunca recebe
    out.acessosClientes = p.clientes.map(id => { let ultimo = null, total = 0; for (const l of db.logs) if (l.uid === id && l.projetoId === p.id && l.acao === 'abriu_projeto') { total++; ultimo = l.ts; } return { nome: nomeCliente(id), ultimo, total }; });
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
  if ('requerAprovacao' in b) o.requerAprovacao = !!b.requerAprovacao;
  if ('pedido' in b) o.pedido = str(b.pedido, 500);
  if ('deps' in b) {
    if (!Array.isArray(b.deps) || b.deps.length > 30) throw bad(400, 'Dependências inválidas.');
    o.deps = b.deps.map(d => ({ de: String(d.de), tipo: d.tipo === 'SS' ? 'SS' : 'FS', lag: Math.max(-365, Math.min(365, Math.round(+d.lag || 0))) }));
  }
  return o;
}
// Salva tarefa, valida dependências (mesmo projeto, sem ciclo) e reagenda as sucessoras.
const calDe = p => S.calendario({ diasUteis: !!(p && p.diasUteis), extras: (p && p.feriadosExtras) || [] });
function aplicarTarefas(pid, mexe) {
  const antes = tarefasDe(pid).map(t => JSON.stringify(t)); const bkp = new Map(tarefasDe(pid).map(t => [t.id, { ...t }]));
  try {
    mexe(); const all = tarefasDe(pid); const ids = new Set(all.map(t => t.id));
    for (const t of all) { t.deps = (t.deps || []).filter(d => d.de !== t.id && ids.has(d.de)); if (t.fim < t.inicio) throw bad(400, 'O término não pode ser antes do início.'); }
    const cal = calDe(projetoDe(pid)); const normal = S.normalizar(all, cal); // em dias úteis: início/término caem em dia útil
    const reag = S.reagendar(all, cal); return [...new Set([...normal, ...reag])];
  } catch (e) { // desfaz
    db.tarefas = db.tarefas.filter(t => t.projetoId !== pid || bkp.has(t.id)); for (const t of db.tarefas) if (bkp.has(t.id)) Object.assign(t, bkp.get(t.id)); void antes; throw e;
  }
}

// uma entrada para cada atividade que as dependências reagendaram (além da que o usuário editou)
const modeloPorId = id => Modelos.EMBUTIDOS.find(m => m.id === id) || (db.modelos || []).find(m => m.id === id);
function aplicarModelo(u, p, modelo, inicio) {
  const novas = Modelos.gerarTarefas(modelo, inicio, calDe(p), S, store.id).map((t, i) => ({ ...t, projetoId: p.id, ordem: tarefasDe(p.id).length + i }));
  aplicarTarefas(p.id, () => db.tarefas.push(...novas)); reg(u, 'aplicou_modelo', `${modelo.nome} (${novas.length} atividades)`, p.id); return novas.length;
}
function registraReagendadas(u, ids, antes, causa) {
  for (const id of ids) { if (id === causa.id) continue; const x = db.tarefas.find(y => y.id === id); if (!x) continue; const dx = Audit.diff(antes.get(id) || {}, x, { inicio: 'Início', fim: 'Término' });
    if (dx.length) reg(u, 'reagendada_dependencia', x.nome, x.projetoId, { tarefaId: x.id, interna: !!x.interna, diff: dx, desfazer: desfazerDe('tarefa', x.id, antes.get(id) || {}, x, ['inicio', 'fim']), motivo: causa.motivo || `por causa da atividade “${causa.nome}”` }); }
}
// Dependências que impedem a atividade de começar na data pedida (início mínimo = fim da anterior + 1 + defasagem, ou início da anterior + defasagem).
function depsBloqueio(deps, inicio, todas, cal = S.CAL_CORRIDOS) {
  const out = []; for (const d of deps || []) { const p = todas.find(x => x.id === d.de); if (!p) continue; const base = S.baseDep(p, d.tipo, cal), minimo = S.minimoDep(p, d.tipo, d.lag, cal);
    if (inicio < minimo) out.push({ de: p.id, nome: p.nome, tipo: d.tipo, lag: +d.lag || 0, base, minimo, predInicio: p.inicio, predFim: p.fim }); }
  return out;
}
const ajustesDe = ids => ids.map(id => db.tarefas.find(x => x.id === id)).filter(Boolean).map(x => ({ id: x.id, nome: x.nome, inicio: x.inicio, fim: x.fim })); // atividades cujas datas as dependências alteraram
// ---- rotas --------------------------------------------------------------------
const R = [];
const rota = (m, re, fn) => R.push([m, new RegExp(`^${re}$`), fn]);

rota('POST', '/api/auth/cadastro', async (req, res, _m, b) => {
  const email = str(b.email, 160, true, 'E-mail').toLowerCase(), nome = str(b.nome, 120, true, 'Nome');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad(400, 'E-mail inválido.');
  if (String(b.senha || '').length < 8) throw bad(400, 'A senha deve ter ao menos 8 caracteres.');
  if (db.clientes.some(c => c.email === email)) throw bad(409, 'Já existe uma conta com este e-mail.');
  const c = { id: store.id(), nome, email, empresa: str(b.empresa, 120), telefone: str(b.telefone, 40), senha: A.hash(String(b.senha)), criadoEm: store.agora(), ativo: true };
  db.clientes.push(c); store.log(nome, 'cliente', 'cadastro', email, null, { uid: c.id }); store.save();
  send(res, 201, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
const falhas = new Map();
rota('POST', '/api/auth/login', async (req, res, _m, b) => {
  const email = String(b.email || '').trim().toLowerCase(), f = falhas.get(email) || { n: 0, ate: 0 };
  if (f.n >= 5 && Date.now() < f.ate) throw bad(429, 'Muitas tentativas. Tente novamente em alguns minutos.');
  const c = db.clientes.find(x => x.email === email && x.ativo !== false);
  if (!c || !A.confere(String(b.senha || ''), c.senha)) { falhas.set(email, { n: f.n + 1, ate: Date.now() + 15 * 60e3 }); store.log(email || '?', 'cliente', 'login_falhou'); throw bad(401, 'E-mail ou senha incorretos.'); }
  falhas.delete(email); store.log(c.nome, 'cliente', 'login', c.email, null, { uid: c.id });
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
rota('POST', '/api/auth/logout', async (req, res, _m, _b, u) => { if (u) reg(u, 'saiu'); send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) }); });
rota('GET', '/api/me', async (req, res, _m, _b, u) => send(res, 200, { usuario: u }));

rota('GET', '/api/projetos', async (req, res, _m, _b, u) => {
  exigir(u); const lista = db.projetos.filter(p => podeVer(u, p)).map(p => projetoView(p, u, false));
  send(res, 200, { projetos: lista.sort((a, b) => a.nome.localeCompare(b.nome)) });
});
rota('GET', '/api/projetos/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u); const p = projetoDe(m[1]); if (!p || !podeVer(u, p)) throw bad(404, 'Projeto não encontrado.');
  if (u.tipo === 'cliente') regUnico(u, 'proj' + p.id, 10 * 60e3, 'abriu_projeto', p.nome, p.id);
  send(res, 200, { projeto: projetoView(p, u, true) });
});
rota('POST', '/api/projetos', async (req, res, _m, b, u) => {
  exigir(u, 'equipe');
  const d = lerProjeto(b, false); const modelo = b.modeloId ? modeloPorId(String(b.modeloId)) : null; if (b.modeloId && !modelo) throw bad(400, 'Modelo não encontrado.');
  const inicioModelo = b.inicioModelo ? String(b.inicioModelo) : S.hojeSP(); if (modelo && !S.isDate(inicioModelo)) throw bad(400, 'Data de início inválida.');
  if (modelo) { if (!('tipo' in b)) d.tipo = modelo.tipo; if (!('descricao' in b) || !d.descricao) d.descricao = modelo.descricao || ''; if (!('diasUteis' in b)) d.diasUteis = !!modelo.diasUteis; }
  const p = { situacao: 'andamento', prioridade: 'media', ...d, id: store.id(), gerente: d.gerente || u.nome, descricao: d.descricao || '', clientes: [], criadoEm: store.agora(), criadoPor: u.nome };
  p.codigo = p.codigo || proximoCodigo(); validarProjeto(p);
  if (Array.isArray(b.clientes)) p.clientes = [...new Set(b.clientes.map(String))].filter(id => db.clientes.some(c => c.id === id));
  db.projetos.push(p); if (modelo) aplicarModelo(u, p, modelo, inicioModelo); reg(u, 'criou_projeto', p.nome, p.id, { diff: Audit.diff({}, p, Audit.CAMPOS_PROJETO, nomeCliente, Audit.INTERNOS_PROJETO) }); store.save(); send(res, 201, { projeto: projetoView(p, u, true) });
});
rota('PATCH', '/api/projetos/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.');
  const novo = { ...p, ...lerProjeto(b, true) }; validarProjeto(novo);
  if (Array.isArray(b.clientes)) novo.clientes = [...new Set(b.clientes.map(String))].filter(id => db.clientes.some(c => c.id === id));
  const antesP = { ...p, clientes: [...p.clientes] }; const snapsCal = new Map(tarefasDe(p.id).map(x => [x.id, snapT(x)])); Object.assign(p, novo);
  if (JSON.stringify([antesP.diasUteis, antesP.feriadosExtras]) !== JSON.stringify([p.diasUteis, p.feriadosExtras])) { const mudouCal = aplicarTarefas(p.id, () => {}); registraReagendadas(u, mudouCal, snapsCal, { id: null, nome: '', motivo: 'por mudança no calendário do projeto (dias úteis e feriados)' }); }
  const dp = Audit.diff(antesP, p, Audit.CAMPOS_PROJETO, nomeCliente, Audit.INTERNOS_PROJETO); if (dp.length) reg(u, 'editou_projeto', p.nome, p.id, { diff: dp, desfazer: desfazerDe('projeto', p.id, antesP, p, Audit.UNDO_PROJETO) }); store.save(); send(res, 200, { projeto: projetoView(p, u, true) });
});
rota('DELETE', '/api/projetos/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); if (!u.admin) throw bad(403, 'Somente administradores excluem projetos.');
  const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.');
  const tids = new Set(tarefasDe(p.id).map(t => t.id));
  for (const a of db.arquivos.filter(a => tids.has(a.tarefaId))) fs.rm(store.file(a.id), () => {});
  db.arquivos = db.arquivos.filter(a => !tids.has(a.tarefaId)); db.itens = db.itens.filter(i => !tids.has(i.tarefaId));
  db.tarefas = db.tarefas.filter(t => t.projetoId !== p.id); db.projetos = db.projetos.filter(x => x.id !== p.id);
  reg(u, 'excluiu_projeto', p.nome); store.save(); send(res, 200, { ok: true });
});
rota('POST', '/api/projetos/([0-9a-f]+)/tarefas', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.');
  const d = lerTarefa(b, false); const t = { id: store.id(), projetoId: p.id, progresso: 0, responsavel: '', descricao: '', interna: false, deps: [], ...d, ordem: tarefasDe(p.id).length };
  const snaps = new Map(tarefasDe(p.id).map(x => [x.id, snapT(x)])); const mudou = aplicarTarefas(p.id, () => db.tarefas.push(t));
  reg(u, 'criou_tarefa', t.nome, p.id, { tarefaId: t.id, interna: !!t.interna, diff: Audit.diff({}, t, Audit.CAMPOS_TAREFA, nomeTarefa), snap: { inicio: t.inicio, fim: t.fim } });
  if (t.aguardaCliente) reg(u, 'pediu_cliente', t.nome, p.id, { tarefaId: t.id, interna: !!t.interna, diff: [{ campo: 'Pedido ao cliente', de: '—', para: t.pedido || '(sem texto)' }] });
  registraReagendadas(u, mudou, snaps, t); store.save(); send(res, 201, { tarefa: t.id, reagendadas: mudou, ajustes: ajustesDe(mudou) });
});
rota('PATCH', '/api/tarefas/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const t = db.tarefas.find(x => x.id === m[1]); if (!t) throw bad(404, 'Tarefa não encontrada.');
  const d = lerTarefa(b, true);
  // mover para antes do que as dependências permitem: avisa o motivo e deixa a equipe escolher (defasagem, remover ou empurrar)
  const modo = ['defasagem', 'remover', 'empurrar'].includes(b.dependencia) ? b.dependencia : null; const depsAtuais = d.deps || t.deps || []; const calT = calDe(projetoDe(t.projetoId));
  if ('inicio' in d && calT.ativo) d.inicio = calT.proximoUtil(d.inicio); // em dias úteis o início cai em dia útil
  if ('inicio' in d && depsAtuais.length) {
    const bloq = depsBloqueio(depsAtuais, d.inicio, tarefasDe(t.projetoId), calT);
    if (bloq.length && !modo) throw Object.assign(bad(409, 'Esta atividade depende de outra e não pode começar nessa data.'), { extra: { codigo: 'BLOQUEADA_POR_DEPENDENCIA', inicio: d.inicio, minimo: bloq.map(x => x.minimo).sort().pop(), motivos: bloq } });
    if (bloq.length && modo === 'remover') d.deps = depsAtuais.filter(x => !bloq.some(y => y.de === x.de));
    if (bloq.length && modo === 'defasagem') d.deps = depsAtuais.map(x => { const y = bloq.find(z => z.de === x.de); if (!y) return x; const lag = calT.diffUteis(y.base, d.inicio); if (lag < -365) throw bad(400, 'A defasagem ficaria menor que -365 dias. Remova a dependência.'); return { ...x, lag }; });
  }
  const pedia = !!t.aguardaCliente, antesT = snapT(t), snaps = new Map(tarefasDe(t.projetoId).map(x => [x.id, snapT(x)])); const mudou = aplicarTarefas(t.projetoId, () => Object.assign(t, d));
  if (d.requerAprovacao === false) t.aprovacao = null;
  if (d.aguardaCliente === false) t.respondidoEm = null;
  if (d.aguardaCliente && !pedia) { t.respondidoEm = null; reg(u, 'pediu_cliente', t.nome, t.projetoId, { tarefaId: t.id, interna: !!t.interna, diff: [{ campo: 'Pedido ao cliente', de: '—', para: t.pedido || '(sem texto)' }] }); }
  const dt = Audit.diff(antesT, t, Audit.CAMPOS_TAREFA, nomeTarefa).filter(x => !(x.campo === 'Aguardando o cliente' && x.para === 'Sim')); // o pedido já tem registro próprio
  if (dt.length) reg(u, 'editou_tarefa', t.nome, t.projetoId, { tarefaId: t.id, interna: !!t.interna, diff: dt, snap: { inicio: t.inicio, fim: t.fim }, desfazer: desfazerDe('tarefa', t.id, antesT, t, Audit.UNDO_TAREFA) });
  registraReagendadas(u, mudou, snaps, t); store.save(); send(res, 200, { ok: true, reagendadas: mudou, ajustes: ajustesDe(mudou) });
});
rota('DELETE', '/api/tarefas/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); const t = db.tarefas.find(x => x.id === m[1]); if (!t) throw bad(404, 'Tarefa não encontrada.');
  for (const a of db.arquivos.filter(a => a.tarefaId === t.id)) fs.rm(store.file(a.id), () => {});
  db.arquivos = db.arquivos.filter(a => a.tarefaId !== t.id); db.itens = db.itens.filter(i => i.tarefaId !== t.id);
  const snapsDeps = new Map(tarefasDe(t.projetoId).map(x => [x.id, snapT(x)]));
  db.tarefas = db.tarefas.filter(x => x.id !== t.id); for (const o of db.tarefas) o.deps = (o.deps || []).filter(d => d.de !== t.id);
  reg(u, 'excluiu_tarefa', t.nome, t.projetoId, { tarefaId: t.id, interna: !!t.interna, diff: Audit.diff(t, {}, { nome: 'Atividade', inicio: 'Início', fim: 'Término' }) });
  for (const o of tarefasDe(t.projetoId)) { const dd = Audit.diff(snapsDeps.get(o.id), o, { deps: 'Dependências' }, id => id === t.id ? t.nome : nomeTarefa(id)); if (dd.length) reg(u, 'editou_tarefa', o.nome, o.projetoId, { tarefaId: o.id, interna: !!o.interna, diff: dd, snap: { inicio: o.inicio, fim: o.fim } }); }
  store.save(); send(res, 200, { ok: true });
});

// ---- aprovação de entrega pelo cliente ----
const ROT_APROV = { pendente: 'Aguardando aprovação', aprovada: 'Aprovada', ajustes: 'Ajustes solicitados' };
const logAprov = (u, acao, t, de, para, extra = {}) => reg(u, acao, t.nome, t.projetoId, { tarefaId: t.id, interna: !!t.interna, diff: [{ campo: 'Aprovação da entrega', de, para }], ...extra });
rota('POST', '/api/tarefas/([0-9a-f]+)/aprovacao/solicitar', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); const t = db.tarefas.find(x => x.id === m[1]); if (!t) throw bad(404, 'Atividade não encontrada.'); const ant = t.aprovacao ? ROT_APROV[t.aprovacao.estado] : '—';
  if (t.aprovacao && t.aprovacao.estado === 'aprovada') throw bad(409, 'Esta entrega já foi aprovada.'); if (t.aprovacao && t.aprovacao.estado === 'pendente') throw bad(409, 'Esta entrega já está aguardando aprovação.');
  t.requerAprovacao = true; t.aprovacao = { estado: 'pendente', solicitadaEm: store.agora(), solicitadaPor: u.nome }; logAprov(u, 'solicitou_aprovacao', t, ant, ROT_APROV.pendente); store.save(); send(res, 200, { ok: true, aprovacao: t.aprovacao });
});
rota('POST', '/api/tarefas/([0-9a-f]+)/aprovacao', async (req, res, m, b, u) => {
  exigir(u, 'cliente'); const [t] = tarefaAcessivel(u, m[1]); const a = t.aprovacao; if (!a || a.estado !== 'pendente') throw bad(409, 'Esta entrega não está aguardando a sua aprovação.');
  const comentario = str(b.comentario, 1000); const agora = store.agora();
  if (b.decisao === 'aprovar') { t.aprovacao = { ...a, estado: 'aprovada', decididaEm: agora, por: u.nome, uid: u.id, comentario }; t.progresso = 100; logAprov(u, 'aprovou_entrega', t, ROT_APROV.pendente, `Aprovada por ${u.nome}`, { cliente: u.id }); }
  else if (b.decisao === 'ajustes') {
    if (comentario.length < 3) throw bad(400, 'Descreva o que precisa ser ajustado.'); t.aprovacao = { ...a, estado: 'ajustes', decididaEm: agora, por: u.nome, uid: u.id, comentario }; t.progresso = Math.min(+t.progresso || 0, 90);
    db.itens.push({ id: store.id(), tarefaId: t.id, autor: u.nome, tipoAutor: 'cliente', ts: agora, texto: `Pedido de ajustes na entrega: ${comentario}` }); t.respondidoEm = agora; logAprov(u, 'pediu_ajustes_entrega', t, ROT_APROV.pendente, ROT_APROV.ajustes, { cliente: u.id });
  } else throw bad(400, 'Decisão inválida.');
  store.save(); send(res, 200, { ok: true, aprovacao: t.aprovacao });
});

function tarefaAcessivel(u, id) {
  exigir(u); const t = db.tarefas.find(x => x.id === id); const p = t && projetoDe(t.projetoId);
  if (!t || !p || !podeVer(u, p) || (t.interna && u.tipo !== 'equipe')) throw bad(404, 'Atividade não encontrada.'); return [t, p];
}
rota('GET', '/api/tarefas/([0-9a-f]+)/itens', async (req, res, m, _b, u) => {
  const [t] = tarefaAcessivel(u, m[1]); if (u.tipo === 'cliente') regUnico(u, 'ativ' + t.id, 10 * 60e3, 'abriu_atividade', t.nome, t.projetoId, { tarefaId: t.id });
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
  db.itens.push(item); reg(u, item.arquivoId ? 'enviou_arquivo' : 'comentou', `${t.nome}`, p.id); store.save(); send(res, 201, { ok: true });
});
function enviarArquivo(res, a, u) {
  let buf; try { buf = fs.readFileSync(store.file(a.id)); } catch { throw bad(404, 'Arquivo não encontrado.'); }
  const tt = a.tarefaId && db.tarefas.find(x => x.id === a.tarefaId); store.log(u ? u.nome : 'Link assinado (Bitrix24)', u ? u.tipo : 'equipe', 'baixou_arquivo', a.nome, tt ? tt.projetoId : null, { uid: u ? u.id : null });
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
const msgView = m => { const a = m.arquivoId && db.arquivos.find(x => x.id === m.arquivoId); return { id: m.id, autor: m.autor, tipoAutor: m.tipoAutor, ts: m.ts, texto: m.texto, interna: !!m.interna, arquivo: a ? { id: a.id, nome: a.nome, tamanho: a.tamanho } : undefined }; };
function solView(s, u) {
  const publicas = (s.mensagens || []).filter(x => !x.interna), visiveis = u.tipo === 'equipe' ? (s.mensagens || []) : publicas; // nota interna: só a equipe vê; nunca muda de quem é a vez
  const base = { id: s.id, protocolo: s.protocolo, projetoId: s.projetoId, projeto: (projetoDe(s.projetoId) || {}).nome, categoria: s.categoria, prioridade: s.prioridade, assunto: s.assunto, texto: s.texto, status: s.status, resposta: s.resposta, criadoEm: s.criadoEm,
    etapa: s.etapa ? s.etapa.nome : '', historico: s.historico || [], mensagens: visiveis.map(msgView), avaliacao: s.avaliacao ? { nota: s.avaliacao.nota, comentario: s.avaliacao.comentario, ts: s.avaliacao.ts } : null,
    podeAvaliar: !s.avaliacao && (s.status === 'concluida' || (s.etapa && s.etapa.semantica === 'S')),
    aberto: !['concluida', 'recusada'].includes(s.status), atualizadoEm: [s.criadoEm, s.etapa && s.etapa.desde, ...visiveis.map(x => x.ts)].filter(Boolean).sort().pop(), atendente: s.responsavel ? s.responsavel.nome : '',
    vezDe: ['concluida', 'recusada'].includes(s.status) ? null : ((publicas.slice(-1)[0] || {}).tipoAutor === 'equipe' ? 'cliente' : 'equipe') }; // quem precisa agir agora
  const sla = SLA.calcular(s, SLA.config(db)); if (u.tipo !== 'equipe') return { ...base, respostaPrevistaAte: ['ok', 'vencendo', 'estourado'].includes(sla.estado) ? sla.prazo : null };
  return u.tipo === 'equipe' ? { ...base, responsavel: s.responsavel || null, sla, cliente: s.cliente, empresa: s.empresa, email: s.email, telefone: s.telefone, bitrix: s.bitrix ? { status: s.bitrix.status, erro: s.bitrix.erro, dealId: s.bitrix.dealId, tentativas: s.bitrix.tentativas, url: cardUrl(s) } : null } : base;
}
rota('GET', '/api/solicitacoes', async (req, res, _m, _b, u) => {
  exigir(u); if (u.tipo === 'cliente') regUnico(u, 'suporte', 30 * 60e3, 'abriu_suporte'); await suporte.sincronizarSeVelho(); // etapa do card sempre fresca (no máx. 1 consulta/min)
  const l = db.solicitacoes.filter(s => u.tipo === 'equipe' || s.clienteId === u.id).map(s => solView(s, u));
  send(res, 200, { solicitacoes: l.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)), categorias: CAT, prioridades: PRIO });
});
rota('POST', '/api/solicitacoes', async (req, res, _m, b, u) => {
  exigir(u, 'cliente'); const pid = b.projetoId ? String(b.projetoId) : null; if (pid) { const p = projetoDe(pid); if (!p || !podeVer(u, p)) throw bad(400, 'Projeto inválido.'); }
  if (b.categoria && !CAT[b.categoria]) throw bad(400, 'Categoria inválida.'); if (b.prioridade && !PRIO[b.prioridade]) throw bad(400, 'Prioridade inválida.');
  const conta = db.clientes.find(c => c.id === u.id) || {};
  const s = { id: store.id(), protocolo: protocolo(), clienteId: u.id, cliente: u.nome, empresa: u.empresa || '', email: conta.email || '', telefone: str(b.telefone, 40) || conta.telefone || '', projetoId: pid, categoria: b.categoria || 'duvida', prioridade: b.prioridade || 'media',
    assunto: str(b.assunto, 160, true, 'Assunto'), texto: str(b.texto, 4000, true, 'Descrição'), status: 'nova', resposta: '', mensagens: [], criadoEm: store.agora(), bitrix: { status: 'pendente', tentativas: 0 } };
  db.solicitacoes.push(s); reg(u, 'solicitou', `${s.protocolo} · ${s.assunto}`, pid, { cliente: u.id }); store.save();
  suporte.enviar(s).catch(() => {}); // cria o card em segundo plano; se falhar, a fila reenvia
  send(res, 201, { ok: true, protocolo: s.protocolo, id: s.id });
});
rota('PATCH', '/api/solicitacoes/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const s = db.solicitacoes.find(x => x.id === m[1]); if (!s) throw bad(404, 'Solicitação não encontrada.');
  if (['nova', 'em_analise', 'aprovada', 'recusada', 'concluida'].includes(b.status)) s.status = b.status; if ('resposta' in b) s.resposta = str(b.resposta, 4000);
  if ('responsavel' in b) { const uid = b.responsavel ? String(b.responsavel) : ''; if (uid && !(db.equipe || {})[uid]) throw bad(400, 'Pessoa da equipe não encontrada.'); const ant = s.responsavel ? s.responsavel.nome : 'ninguém'; s.responsavel = uid ? { uid, nome: db.equipe[uid].nome } : null; reg(u, 'atribuiu_chamado', `${s.protocolo} · ${ant} → ${s.responsavel ? s.responsavel.nome : 'ninguém'}`, s.projetoId); }
  if ('prioridade' in b) { if (!PRIO[b.prioridade]) throw bad(400, 'Prioridade inválida.'); s.prioridade = b.prioridade; }
  reg(u, 'atualizou_solicitacao', `${s.protocolo} · ${s.assunto}`, s.projetoId); store.save(); send(res, 200, { ok: true });
});
rota('POST', '/api/solicitacoes/([0-9a-f]+)/reenviar', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); const s = db.solicitacoes.find(x => x.id === m[1]); if (!s) throw bad(404, 'Solicitação não encontrada.');
  suporte.aplicar(); const r = await suporte.enviar(s); reg(u, 'reenviou_chamado', s.protocolo, s.projetoId); send(res, 200, { bitrix: { status: r.status, erro: r.erro, dealId: r.dealId, url: cardUrl(s) } });
});

const solAcessivel = (u, id) => { exigir(u); const s = db.solicitacoes.find(x => x.id === id); if (!s || (u.tipo === 'cliente' && s.clienteId !== u.id)) throw bad(404, 'Chamado não encontrado.'); return s; };
rota('POST', '/api/solicitacoes/([0-9a-f]+)/mensagens', async (req, res, m, b, u) => {
  const s = solAcessivel(u, m[1]); const interna = u.tipo === 'equipe' && !!b.interna; const msg = { id: store.id(), autor: u.nome, tipoAutor: u.tipo, ts: store.agora(), texto: str(b.texto, 4000), bx: false, ...(interna ? { interna: true } : {}) };
  if (b.arquivo) {
    const nome = str(b.arquivo.nome, 160, true, 'Nome do arquivo').replace(/[\\/\0\r\n"]/g, '_'); const buf = Buffer.from(String(b.arquivo.base64 || ''), 'base64');
    if (!buf.length) throw bad(400, 'Arquivo vazio.'); if (buf.length > MAX_FILE) throw bad(413, 'Arquivo acima de 10 MB.');
    const a = { id: store.id(), solicitacaoId: s.id, nome, tamanho: buf.length, ts: msg.ts }; fs.writeFileSync(store.file(a.id), buf, { mode: 0o600 }); db.arquivos.push(a); msg.arquivoId = a.id;
  }
  if (!msg.texto && !msg.arquivoId) throw bad(400, 'Escreva uma mensagem ou anexe um documento.');
  (s.mensagens = s.mensagens || []).push(msg); if (u.tipo === 'equipe' && !interna && s.status === 'nova') s.status = 'em_analise';
  if (u.tipo === 'equipe' && !interna && !s.responsavel) { s.responsavel = { uid: u.id, nome: u.nome }; reg(u, 'atribuiu_chamado', `${s.protocolo} · ninguém → ${u.nome} (ao responder)`, s.projetoId); } // quem responde primeiro assume
  reg(u, interna ? 'nota_interna' : u.tipo === 'cliente' ? 'complementou_chamado' : 'respondeu_chamado', `${s.protocolo} · ${s.assunto}`, s.projetoId, interna ? {} : { cliente: s.clienteId }); store.save();
  suporte.flushMensagens(s).catch(() => {}); send(res, 201, { ok: true });
});
rota('POST', '/api/solicitacoes/([0-9a-f]+)/avaliar', async (req, res, m, b, u) => {
  exigir(u, 'cliente'); const s = solAcessivel(u, m[1]); const nota = Math.round(+b.nota);
  if (!(nota >= 1 && nota <= 5)) throw bad(400, 'A nota deve ser de 1 a 5.'); if (s.avaliacao) throw bad(409, 'Este atendimento já foi avaliado.');
  if (!(s.status === 'concluida' || (s.etapa && s.etapa.semantica === 'S'))) throw bad(400, 'Você poderá avaliar quando o atendimento for concluído.');
  s.avaliacao = { nota, comentario: str(b.comentario, 1000), ts: store.agora() }; reg(u, 'avaliou_atendimento', `${s.protocolo} · ${nota}/5`, s.projetoId, { cliente: u.id }); store.save();
  suporte.avaliacaoBitrix(s).catch(() => {}); send(res, 201, { ok: true });
});

// ---- início do cliente: o que precisa dele, o que está acontecendo e novidades ----
const ROTULO = { criou_tarefa: d => `Nova atividade: ${d}`, editou_tarefa: d => `Atividade atualizada: ${d}`, comentou: d => `A equipe comentou em ${d}`, enviou_arquivo: d => `A equipe enviou um documento em ${d}`, pediu_cliente: d => `A equipe precisa de você em ${d}`, solicitou_aprovacao: d => `Entrega aguardando a sua aprovação: ${d}`,
  editou_projeto: () => 'Dados do projeto atualizados', respondeu_chamado: d => `A equipe respondeu o chamado ${d}`, etapa_chamado: d => `Chamado: ${d}` };
function novidadesDe(u) {
  const c = db.clientes.find(x => x.id === u.id) || {}; const meus = new Set(db.projetos.filter(p => p.clientes.includes(u.id)).map(p => p.id)); const desde = Date.now() - 30 * 86400e3; const vistas = new Map();
  for (const l of [...db.logs].reverse()) {
    if (l.tipo !== 'equipe' || !ROTULO[l.acao] || Date.parse(l.ts) < desde) continue; if (!(l.cliente === u.id || (l.projetoId && meus.has(l.projetoId)))) continue;
    if (['criou_tarefa', 'editou_tarefa', 'pediu_cliente', 'solicitou_aprovacao', 'comentou', 'enviou_arquivo'].includes(l.acao) && db.tarefas.some(x => x.projetoId === l.projetoId && x.nome === l.detalhe && x.interna)) continue; // atividade interna nunca aparece
    const k = l.acao + '|' + l.detalhe + '|' + (l.projetoId || ''); const ant = vistas.get(k); if (ant && Math.abs(Date.parse(ant.ts) - Date.parse(l.ts)) < 3600e3) continue; vistas.set(k, l);
  }
  const itens = [...vistas.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 20).map(l => ({ ts: l.ts, texto: ROTULO[l.acao](l.detalhe), projeto: (projetoDe(l.projetoId) || {}).nome || '' }));
  const visto = c.vistoEm || c.criadoEm || '1970'; return { itens, novas: itens.filter(i => i.ts > visto).length };
}
rota('GET', '/api/novidades', async (req, res, _m, _b, u) => { exigir(u, 'cliente'); send(res, 200, novidadesDe(u)); });
rota('POST', '/api/novidades/lido', async (req, res, _m, _b, u) => { exigir(u, 'cliente'); const c = db.clientes.find(x => x.id === u.id); if (c) { c.vistoEm = store.agora(); store.save(); } send(res, 200, { ok: true }); });
rota('GET', '/api/inicio', async (req, res, _m, _b, u) => {
  exigir(u, 'cliente'); const h = hoje(); const meus = db.projetos.filter(p => p.clientes.includes(u.id)); const pendencias = [], aprovacoes = [], agora = [], proximas = []; let proxima = null;
  for (const p of meus) for (const t of tarefasDe(p.id).filter(x => !x.interna)) {
    const st = S.status(t, tarefasDe(p.id).filter(x => !x.interna), h); const item = { projetoId: p.id, projeto: p.nome, tarefaId: t.id, tarefa: t.nome, inicio: t.inicio, fim: t.fim, progresso: t.progresso, status: st };
    if (t.aprovacao && t.aprovacao.estado === 'pendente') aprovacoes.push({ ...item, solicitadaEm: t.aprovacao.solicitadaEm });
    if (t.aguardaCliente && (+t.progresso || 0) < 100) pendencias.push({ ...item, pedido: t.pedido || '', respondidoEm: t.respondidoEm || null });
    if (st.codigo !== 'concluida' && (!proxima || t.fim < proxima.fim)) proxima = { ...item, atrasada: t.fim < h };
    if (st.codigo !== 'concluida' && t.inicio <= h) agora.push(item); else if (st.codigo !== 'concluida' && S.diffDays(h, t.inicio) <= 14) proximas.push(item);
  }
  const por = (a, b) => a.fim.localeCompare(b.fim) || a.inicio.localeCompare(b.inicio);
  const resumos = meus.map(p => projetoView(p, u, false).resumo);
  const projetos = { total: meus.length, unicoId: meus.length === 1 ? meus[0].id : null, progresso: resumos.length ? Math.round(resumos.reduce((a, r) => a + r.progresso, 0) / resumos.length) : 0,
    verde: resumos.filter(r => r.cor === 'verde').length, amarelo: resumos.filter(r => r.cor === 'amarelo').length, vermelho: resumos.filter(r => r.cor === 'vermelho').length, proxima };
  const sols = db.solicitacoes.filter(x => x.clienteId === u.id).map(x => solView(x, u)).sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
  const suporte = { total: sols.length, abertos: sols.filter(x => x.aberto).length, aguardandoVoce: sols.filter(x => x.vezDe === 'cliente').length, ultimo: sols[0] ? { id: sols[0].id, protocolo: sols[0].protocolo, assunto: sols[0].assunto, etapa: sols[0].etapa, aberto: sols[0].aberto, atualizadoEm: sols[0].atualizadoEm } : null };
  const nv = novidadesDe(u);
  send(res, 200, { aprovacoes: aprovacoes.sort(por), pendencias: pendencias.sort(por), agora: agora.sort(por).slice(0, 6), proximas: proximas.sort((a, b) => a.inicio.localeCompare(b.inicio)).slice(0, 5), novidades: nv.novas, novidadesLista: nv.itens.slice(0, 5), projetos, suporte });
});
// Todos os documentos enviados nas atividades do projeto, em um só lugar (o cliente não vê os de atividades internas).
rota('GET', '/api/projetos/([0-9a-f]+)/documentos', async (req, res, m, _b, u) => {
  exigir(u); const p = projetoDe(m[1]); if (!p || !podeVer(u, p)) throw bad(404, 'Projeto não encontrado.'); const tarefas = new Map(tarefasDe(p.id).filter(t => u.tipo === 'equipe' || !t.interna).map(t => [t.id, t]));
  const docs = db.itens.filter(i => i.arquivoId && tarefas.has(i.tarefaId)).map(i => { const a = db.arquivos.find(x => x.id === i.arquivoId); return a && { id: a.id, nome: a.nome, tamanho: a.tamanho, ts: i.ts, autor: i.autor, tipoAutor: i.tipoAutor, tarefa: tarefas.get(i.tarefaId).nome, tarefaId: i.tarefaId }; }).filter(Boolean);
  send(res, 200, { documentos: docs.sort((a, b) => b.ts.localeCompare(a.ts)) });
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
  reg(u, 'configurou_suporte', `${db.config.suporte.funilNome} / ${db.config.suporte.etapaNome}`); store.save();
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
  let primeira = antes === 0;
  for (const p of db.projetos) { const tem = p.clientes.includes(c.id); if (alvo.has(p.id) === tem) continue; const ant = [...p.clientes];
    if (alvo.has(p.id)) p.clientes.push(c.id); else p.clientes = p.clientes.filter(x => x !== c.id);
    reg(u, alvo.has(p.id) && primeira ? 'ativou_cliente' : 'alterou_acesso_cliente', `${c.nome} ${alvo.has(p.id) ? 'ganhou acesso' : 'perdeu acesso'} a “${p.nome}”`, p.id, { cliente: c.id, diff: Audit.diff({ clientes: ant }, p, { clientes: 'Clientes com acesso' }, nomeCliente, Audit.INTERNOS_PROJETO) }); if (alvo.has(p.id)) primeira = false; }
  store.save(); send(res, 200, { ok: true, projetos: alvo.size });
});
rota('PATCH', '/api/clientes/([0-9a-f]+)', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const c = db.clientes.find(x => x.id === m[1]); if (!c) throw bad(404, 'Cliente não encontrado.');
  if ('ativo' in b) c.ativo = !!b.ativo; reg(u, c.ativo ? 'reativou_cliente' : 'bloqueou_cliente', c.email); store.save(); send(res, 200, { ok: true });
});
// Desfaz uma alteração restaurando os valores originais. Se algo mudou depois, avisa (e só desfaz com confirmação).
rota('POST', '/api/logs/([0-9a-f]+)/desfazer', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const l = db.logs.find(x => x.id === m[1]); if (!l || !l.desfazer) throw bad(404, 'Esta alteração não pode ser desfeita (registro antigo ou de outro tipo).'); if (l.desfeito) throw bad(409, 'Esta alteração já foi desfeita.');
  const { alvo, id, antes, depois } = l.desfazer; const campos = alvo === 'tarefa' ? Audit.CAMPOS_TAREFA : Audit.CAMPOS_PROJETO; const forcar = !!b.forcar;
  const entidade = alvo === 'tarefa' ? db.tarefas.find(x => x.id === id) : projetoDe(id); if (!entidade) throw bad(409, alvo === 'tarefa' ? 'A atividade foi excluída.' : 'O projeto foi excluído.');
  const mudouDepois = Object.keys(depois).filter(k => !Audit.igual(k, entidade[k], depois[k])); if (mudouDepois.length && !forcar) throw Object.assign(bad(409, 'Esta informação foi alterada depois.'), { extra: { codigo: 'ALTERADO_DEPOIS', campos: mudouDepois.map(k => campos[k] || k) } });
  const pid = alvo === 'tarefa' ? entidade.projetoId : entidade.id; const antesE = alvo === 'tarefa' ? snapT(entidade) : { ...entidade, clientes: [...entidade.clientes] }; const volta = JSON.parse(JSON.stringify(antes)); let ajustes = [];
  if (alvo === 'tarefa') { const snaps = new Map(tarefasDe(pid).map(x => [x.id, snapT(x)])); const mud = aplicarTarefas(pid, () => Object.assign(entidade, volta)); registraReagendadas(u, mud, snaps, entidade); ajustes = ajustesDe(mud); }
  else { const novo = { ...entidade, ...volta }; validarProjeto(novo); const snapsCal = new Map(tarefasDe(pid).map(x => [x.id, snapT(x)])); Object.assign(entidade, volta);
    if (JSON.stringify([antesE.diasUteis, antesE.feriadosExtras]) !== JSON.stringify([entidade.diasUteis, entidade.feriadosExtras])) { const mc = aplicarTarefas(pid, () => {}); registraReagendadas(u, mc, snapsCal, { id: null, nome: '', motivo: 'por mudança no calendário do projeto (dias úteis e feriados)' }); } }
  const dif = Audit.diff(antesE, entidade, campos, alvo === 'tarefa' ? nomeTarefa : nomeCliente, alvo === 'projeto' ? Audit.INTERNOS_PROJETO : new Set());
  reg(u, 'desfez_alteracao', entidade.nome, pid, { ...(alvo === 'tarefa' ? { tarefaId: entidade.id, interna: !!entidade.interna } : {}), diff: dif, desfazDe: l.id, desfazer: desfazerDe(alvo, id, antesE, entidade, alvo === 'tarefa' ? Audit.UNDO_TAREFA : Audit.UNDO_PROJETO) });
  l.desfeito = true; l.desfeitoPor = u.nome; l.desfeitoEm = store.agora(); store.save(); send(res, 200, { ok: true, ajustes });
});
// ---- equipe, prazos de resposta (SLA), respostas prontas e central de ajuda ----
rota('GET', '/api/equipe', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { equipe: Object.values(db.equipe || {}).sort((a, b) => a.nome.localeCompare(b.nome)).map(x => ({ id: x.id, nome: x.nome })) }); });
rota('GET', '/api/config/sla', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { sla: SLA.config(db), padrao: SLA.PADRAO }); });
rota('POST', '/api/config/sla', async (req, res, _m, b, u) => {
  exigir(u, 'equipe'); if (!u.admin) throw bad(403, 'Somente administradores alteram os prazos.'); const novo = {}; for (const k of Object.keys(SLA.PADRAO)) { const v = +b[k]; if (!(v > 0 && v <= 720)) throw bad(400, `Prazo inválido para “${k}” (use de 1 a 720 horas).`); novo[k] = v; }
  const ant = SLA.config(db); db.config.sla = novo; reg(u, 'configurou_sla', Object.keys(novo).map(k => `${k}: ${ant[k]}h → ${novo[k]}h`).join(' · ')); store.save(); send(res, 200, { sla: SLA.config(db) });
});
const RESPOSTAS_PADRAO = [['Recebemos seu chamado', 'Olá, {cliente}! Recebemos o seu chamado {protocolo} e já estamos analisando. Voltamos com uma resposta em breve.'], ['Precisamos de mais informações', 'Olá, {cliente}! Para avançarmos no chamado {protocolo}, pode nos enviar mais detalhes (prints, o passo a passo e o horário em que aconteceu)?'], ['Chamado resolvido', 'Olá, {cliente}! Finalizamos o atendimento do chamado {protocolo}. Se algo ainda não estiver certo, é só responder por aqui. Obrigado!']];
if (!(db.respostas || []).length) { db.respostas = RESPOSTAS_PADRAO.map(([titulo, texto]) => ({ id: store.id(), titulo, texto })); store.save(); }
rota('GET', '/api/respostas', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { respostas: db.respostas }); });
rota('POST', '/api/respostas', async (req, res, _m, b, u) => { exigir(u, 'equipe'); const r = { id: store.id(), titulo: str(b.titulo, 80, true, 'Título'), texto: str(b.texto, 2000, true, 'Texto') }; db.respostas.push(r); store.save(); send(res, 201, { resposta: r }); });
rota('PATCH', '/api/respostas/([0-9a-f]+)', async (req, res, m, b, u) => { exigir(u, 'equipe'); const r = db.respostas.find(x => x.id === m[1]); if (!r) throw bad(404, 'Resposta não encontrada.'); if ('titulo' in b) r.titulo = str(b.titulo, 80, true, 'Título'); if ('texto' in b) r.texto = str(b.texto, 2000, true, 'Texto'); store.save(); send(res, 200, { resposta: r }); });
rota('DELETE', '/api/respostas/([0-9a-f]+)', async (req, res, m, _b, u) => { exigir(u, 'equipe'); if (!db.respostas.some(x => x.id === m[1])) throw bad(404, 'Resposta não encontrada.'); db.respostas = db.respostas.filter(x => x.id !== m[1]); store.save(); send(res, 200, { ok: true }); });
const artigoPublico = a => ({ id: a.id, titulo: a.titulo, texto: a.texto, categoria: a.categoria || '' });
rota('GET', '/api/artigos', async (req, res, _m, _b, u) => { exigir(u); send(res, 200, { artigos: u.tipo === 'equipe' ? db.artigos : db.artigos.filter(a => a.publicado !== false).map(artigoPublico) }); });
rota('GET', '/api/artigos/sugestoes', async (req, res, _m, _b, u) => { exigir(u); const q = new URL(req.url, 'http://x').searchParams.get('q') || ''; const r = Ajuda.sugerir(db.artigos, q, 3); for (const a of r) a.vistas = (a.vistas || 0) + 1; if (r.length) store.save(); send(res, 200, { artigos: r.map(artigoPublico) }); });
rota('POST', '/api/artigos', async (req, res, _m, b, u) => { exigir(u, 'equipe'); const a = { id: store.id(), titulo: str(b.titulo, 140, true, 'Título'), texto: str(b.texto, 8000, true, 'Texto'), palavras: str(b.palavras, 300), categoria: str(b.categoria, 60), publicado: b.publicado !== false, criadoEm: store.agora(), vistas: 0, uteis: 0, naoUteis: 0 }; db.artigos.push(a); store.save(); send(res, 201, { artigo: a }); });
rota('PATCH', '/api/artigos/([0-9a-f]+)', async (req, res, m, b, u) => { exigir(u, 'equipe'); const a = db.artigos.find(x => x.id === m[1]); if (!a) throw bad(404, 'Artigo não encontrado.'); if ('titulo' in b) a.titulo = str(b.titulo, 140, true, 'Título'); if ('texto' in b) a.texto = str(b.texto, 8000, true, 'Texto'); if ('palavras' in b) a.palavras = str(b.palavras, 300); if ('categoria' in b) a.categoria = str(b.categoria, 60); if ('publicado' in b) a.publicado = !!b.publicado; a.atualizadoEm = store.agora(); store.save(); send(res, 200, { artigo: a }); });
rota('DELETE', '/api/artigos/([0-9a-f]+)', async (req, res, m, _b, u) => { exigir(u, 'equipe'); if (!db.artigos.some(x => x.id === m[1])) throw bad(404, 'Artigo não encontrado.'); db.artigos = db.artigos.filter(x => x.id !== m[1]); store.save(); send(res, 200, { ok: true }); });
rota('POST', '/api/artigos/([0-9a-f]+)/util', async (req, res, m, b, u) => { exigir(u, 'cliente'); const a = db.artigos.find(x => x.id === m[1] && x.publicado !== false); if (!a) throw bad(404, 'Artigo não encontrado.'); if (b.resolveu) a.uteis = (a.uteis || 0) + 1; else a.naoUteis = (a.naoUteis || 0) + 1; store.save(); send(res, 200, { ok: true }); });
// Minha fila: o que precisa de ação da equipe, em todos os projetos (chamados, entregas, atrasos, retornos de clientes).
rota('GET', '/api/fila', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe'); const soMeus = new URL(req.url, 'http://x').searchParams.get('so_meus') === '1'; const h = hoje(); const nomeMeu = Ajuda.palavras(u.nome)[0] || '';
  const meuT = t => !soMeus || (!!nomeMeu && Ajuda.palavras(t.responsavel).includes(nomeMeu)); // responsável da atividade é texto livre: casa pelo primeiro nome
  const cfg = SLA.config(db); const chamados = db.solicitacoes.filter(s => s.status !== 'concluida' && s.status !== 'recusada').map(s => solView(s, u)).filter(s => s.vezDe === 'equipe' && (!soMeus || (s.responsavel && s.responsavel.uid === u.id)))
    .sort((a, b) => Date.parse(a.sla.prazo) - Date.parse(b.sla.prazo)).map(s => ({ id: s.id, protocolo: s.protocolo, assunto: s.assunto, cliente: s.cliente, empresa: s.empresa, prioridade: s.prioridade, sla: s.sla, responsavel: s.responsavel, atualizadoEm: s.atualizadoEm, status: s.status }));
  const out = { chamados, clienteRespondeu: [], ajustes: [], atrasadas: [], vencemEm7: [], aguardandoCliente: [], aguardandoAprovacao: [] };
  for (const p of db.projetos.filter(x => x.situacao !== 'concluido')) { const ts = tarefasDe(p.id);
    for (const t of ts) { if (!meuT(t)) continue; const st = S.status(t, ts, h); if (st.codigo === 'concluida' && !(t.aprovacao && t.aprovacao.estado !== 'aprovada')) continue;
      const item = { projetoId: p.id, projeto: p.nome, projetoCodigo: p.codigo || '', empresa: p.empresa || '', tarefaId: t.id, tarefa: t.nome, inicio: t.inicio, fim: t.fim, progresso: t.progresso, responsavel: t.responsavel || '', status: st, interna: !!t.interna, diasAtraso: t.fim < h ? S.diffDays(t.fim, h) : 0 };
      const ap = t.aprovacao && t.aprovacao.estado; if (ap === 'ajustes') out.ajustes.push({ ...item, comentario: t.aprovacao.comentario, por: t.aprovacao.por }); else if (ap === 'pendente') out.aguardandoAprovacao.push({ ...item, desde: t.aprovacao.solicitadaEm });
      if (st.codigo === 'concluida') continue;
      if (t.aguardaCliente && (+t.progresso || 0) < 100) (t.respondidoEm ? out.clienteRespondeu : out.aguardandoCliente).push({ ...item, pedido: t.pedido || '', respondidoEm: t.respondidoEm || null });
      if (st.codigo === 'atrasada') out.atrasadas.push(item); else if (S.diffDays(h, t.fim) <= 7) out.vencemEm7.push(item); } }
  const porFim = (a, b) => a.fim.localeCompare(b.fim); for (const k of ['clienteRespondeu', 'ajustes', 'atrasadas', 'vencemEm7', 'aguardandoCliente', 'aguardandoAprovacao']) out[k].sort(porFim);
  out.total = chamados.length + out.clienteRespondeu.length + out.ajustes.length + out.atrasadas.length; // o que pede ação da equipe agora
  out.soMeus = soMeus; void cfg; send(res, 200, out);
});
function filtraLogs(q) {
  const pid = q.get('projeto'), tipo = q.get('tipo'), cat = q.get('cat'), busca = (q.get('q') || '').trim().toLowerCase(), dias = +q.get('dias') || 0, lim = Math.min(+q.get('limite') || 300, 5000);
  const desde = dias ? Date.now() - dias * 86400e3 : 0; const out = [];
  for (let i = db.logs.length - 1; i >= 0 && out.length < lim; i--) {
    const l = db.logs[i]; if (pid && l.projetoId !== pid) continue; if (tipo && l.tipo !== tipo) continue; if (desde && Date.parse(l.ts) < desde) continue;
    const e = Audit.paraEquipe(l); if (cat && e.categoria !== cat) continue;
    if (busca && ![e.quem, e.detalhe, e.rotulo, e.motivo, ...e.diff.map(d => `${d.campo} ${d.de} ${d.para}`)].join(' ').toLowerCase().includes(busca)) continue; out.push({ ...e, projeto: (projetoDe(l.projetoId) || {}).nome || '' });
  }
  return out;
}
rota('GET', '/api/logs', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { logs: filtraLogs(new URL(req.url, 'http://x').searchParams) }); });
rota('GET', '/api/logs\\.csv', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe'); const q = new URL(req.url, 'http://x').searchParams; if (!q.get('limite')) q.set('limite', '5000'); const lista = filtraLogs(q); const txt = Audit.csv(lista, id => (projetoDe(id) || {}).nome || ''); reg(u, 'exportou_log', `${lista.length} linha(s)`);
  res.writeHead(200, { ...SEC, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="log-projetos-m4.csv"', 'Cache-Control': 'no-store' }); res.end(txt);
});
// Histórico do projeto: a equipe vê tudo; o cliente vê só o que mudou no cronograma/dados públicos e o que foi enviado (sem atividades internas nem valores).
rota('GET', '/api/projetos/([0-9a-f]+)/historico', async (req, res, m, _b, u) => {
  exigir(u); const p = projetoDe(m[1]); if (!p || !podeVer(u, p)) throw bad(404, 'Projeto não encontrado.'); const q = new URL(req.url, 'http://x').searchParams;
  if (u.tipo === 'equipe') { q.set('projeto', p.id); return send(res, 200, { itens: filtraLogs(q), completo: true }); }
  const itens = []; for (let i = db.logs.length - 1; i >= 0 && itens.length < 300; i--) { const l = db.logs[i]; if (l.projetoId !== p.id) continue; const e = Audit.paraCliente(l); if (e) itens.push(e); }
  send(res, 200, { itens, completo: false });
});
const modeloView = m => ({ id: m.id, nome: m.nome, tipo: m.tipo || '', descricao: m.descricao || '', embutido: !!m.embutido, diasUteis: !!m.diasUteis, qtdTarefas: m.tarefas.length, tarefas: m.tarefas.map(t => ({ nome: t.nome, dur: t.dur })) });
rota('GET', '/api/modelos', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { modelos: [...Modelos.EMBUTIDOS, ...(db.modelos || [])].map(modeloView) }); });
rota('POST', '/api/modelos', async (req, res, _m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(String(b.projetoId)); if (!p) throw bad(404, 'Projeto não encontrado.'); const nome = str(b.nome, 80, true, 'Nome do modelo'); const ts = tarefasDe(p.id); if (!ts.length) throw bad(400, 'O projeto não tem atividades para salvar como modelo.');
  if ([...Modelos.EMBUTIDOS, ...(db.modelos || [])].some(m => m.nome.toLowerCase() === nome.toLowerCase())) throw bad(409, 'Já existe um modelo com este nome.');
  const m = { id: store.id(), nome, tipo: p.tipo || '', descricao: p.descricao || '', diasUteis: !!p.diasUteis, tarefas: Modelos.modeloDoProjeto(ts, calDe(p)), criadoPor: u.nome, criadoEm: store.agora() }; (db.modelos = db.modelos || []).push(m);
  reg(u, 'salvou_modelo', `${nome} (${m.tarefas.length} atividades)`, p.id); store.save(); send(res, 201, { modelo: modeloView(m) });
});
rota('DELETE', '/api/modelos/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); const mod = (db.modelos || []).find(x => x.id === m[1]); if (!mod) throw bad(404, 'Modelo não encontrado (os modelos padrão não podem ser excluídos).');
  db.modelos = db.modelos.filter(x => x.id !== mod.id); reg(u, 'excluiu_modelo', mod.nome); store.save(); send(res, 200, { ok: true });
});
rota('POST', '/api/projetos/([0-9a-f]+)/aplicar-modelo', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.'); const modelo = modeloPorId(String(b.modeloId)); if (!modelo) throw bad(404, 'Modelo não encontrado.');
  const inicio = b.inicio ? String(b.inicio) : S.hojeSP(); if (!S.isDate(inicio)) throw bad(400, 'Data de início inválida.'); const n = aplicarModelo(u, p, modelo, inicio); store.save(); send(res, 200, { ok: true, atividades: n });
});
rota('GET', '/api/painel', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe'); const ps = db.projetos.map(p => projetoView(p, u, false));
  send(res, 200, { projetos: ps.length, verde: ps.filter(p => p.resumo.cor === 'verde').length, amarelo: ps.filter(p => p.resumo.cor === 'amarelo').length, vermelho: ps.filter(p => p.resumo.cor === 'vermelho').length,
    solicitacoesNovas: db.solicitacoes.filter(s => s.status === 'nova').length, clientes: db.clientes.length,
    avaliacaoMedia: (() => { const n = db.solicitacoes.filter(x => x.avaliacao).map(x => x.avaliacao.nota); return n.length ? Math.round(n.reduce((a, b) => a + b, 0) / n.length * 10) / 10 : null; })(),
    aguardando: db.clientes.filter(c => c.ativo !== false && !db.projetos.some(p => p.clientes.includes(c.id))).length });
});

// ---- estáticos ----------------------------------------------------------------
// Versão do front-end = hash dos arquivos publicados. Vai na URL de cada arquivo (cache-busting) e é consultada pelo navegador para avisar de versão nova.
const VERSAO = crypto.createHash('sha1').update(['index.html', 'app.js', 'style.css'].map(f => fs.readFileSync(path.join(PUB, f))).join('\0')).digest('hex').slice(0, 8);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function estatico(req, res) {
  const url = new URL(req.url, 'http://x'); let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
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
if (require.main === module) { server.listen(PORT, () => console.log(`Projetos M4 na porta ${PORT}`)); setInterval(() => suporte.ciclo(), 2 * 60e3).unref(); setTimeout(() => suporte.ciclo(), 5e3).unref(); process.on('SIGTERM', () => { store.flush(); process.exit(0); }); }
module.exports = { server, store, suporte, bitrix, secrets };
