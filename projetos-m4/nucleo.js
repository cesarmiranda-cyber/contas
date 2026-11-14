'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { createStore } = require('./lib/store'); const { createSecrets, hint, checkWebhook, hostDe } = require('./lib/secrets'); const { createBitrix } = require('./lib/bitrix'); const { createSuporte, CAT, PRIO } = require('./lib/suporte'); const Audit = require('./lib/auditoria'); const Modelos = require('./lib/modelos'); const SLA = require('./lib/sla'); const Ajuda = require('./lib/ajuda'); const Relat = require('./lib/relatorio'); const A = require('./lib/auth'); const S = require('./lib/schedule');

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
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'Cross-Origin-Opener-Policy': 'same-origin',
  // O portal do cliente abre direto no navegador; só o Bitrix24 pode embutir (iframe) a área da equipe.
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'self' https://*.bitrix24.com.br https://*.bitrix24.com https://*.bitrix24.com.ar https://*.bitrix24.es https://*.bitrix24.eu https://*.bitrix24.net https://*.bitrix24.ru",
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
  const sess = A.ler(store.secret, A.cookies(h.cookie).pm4);
  const c = sess && db.clientes.find(x => x.id === sess.uid && x.ativo !== false && !x.bloqueioLogin);
  if (!c || (c.sessoesRevogadasEm && sess.emitidoEm <= c.sessoesRevogadasEm)) return null; // bloqueado, desativado ou saiu: o cookie antigo deixa de valer
  return { tipo: 'cliente', id: c.id, nome: c.nome, email: c.email, empresa: c.empresa, sessaoExpiraEm: sess.expiraEm, trocarSenha: !!c.trocarSenha };
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

const legal = () => { const l = (db.config && db.config.legal) || {}; return { termos: l.termos || '', privacidade: l.privacidade || '', versao: l.versao || 0, publicadoEm: l.publicadoEm || null }; };
const falhas = new Map();
const SUPORTE_ATIVO = !/^(0|false|nao|não)$/i.test(process.env.SUPORTE_ATIVO || '1'); // desliga o suporte no portal (projetos continuam)
const MAX_FALHAS = 3; // tentativas erradas de senha antes de bloquear o acesso
// Limite por endereço (memória): protege cadastro e login contra rajadas automáticas.
const janelaIp = new Map();
function limitaIp(req, chave, max, janela) {
  if (process.env.SEM_LIMITE_IP) return;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?', k = chave + '|' + ip, agora = Date.now();
  const j = (janelaIp.get(k) || []).filter(t => agora - t < janela); if (j.length >= max) throw bad(429, 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.');
  j.push(agora); janelaIp.set(k, j); if (janelaIp.size > 5000) for (const [kk, v] of janelaIp) if (!v.some(t => agora - t < janela)) janelaIp.delete(kk);
}

// ---- aprovação de entrega pelo cliente ----
const ROT_APROV = { pendente: 'Aguardando aprovação', aprovada: 'Aprovada', ajustes: 'Ajustes solicitados' };
const logAprov = (u, acao, t, de, para, extra = {}) => reg(u, acao, t.nome, t.projetoId, { tarefaId: t.id, interna: !!t.interna, diff: [{ campo: 'Aprovação da entrega', de, para }], ...extra });

function tarefaAcessivel(u, id) {
  exigir(u); const t = db.tarefas.find(x => x.id === id); const p = t && projetoDe(t.projetoId);
  if (!t || !p || !podeVer(u, p) || (t.interna && u.tipo !== 'equipe')) throw bad(404, 'Atividade não encontrada.'); return [t, p];
}
function enviarArquivo(res, a, u) {
  let buf; try { buf = fs.readFileSync(store.file(a.id)); } catch { throw bad(404, 'Arquivo não encontrado.'); }
  const tt = a.tarefaId && db.tarefas.find(x => x.id === a.tarefaId); store.log(u ? u.nome : 'Link assinado (Bitrix24)', u ? u.tipo : 'equipe', 'baixou_arquivo', a.nome, tt ? tt.projetoId : null, { uid: u ? u.id : null });
  res.writeHead(200, { ...SEC, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`, 'Content-Length': buf.length, 'Cache-Control': 'private, no-store' }); res.end(buf);
}

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

const solAcessivel = (u, id) => { exigir(u); const s = db.solicitacoes.find(x => x.id === id); if (!s || (u.tipo === 'cliente' && s.clienteId !== u.id)) throw bad(404, 'Chamado não encontrado.'); return s; };

// ---- início do cliente: o que precisa dele, o que está acontecendo e novidades ----
const ROTULO = { criou_tarefa: d => `Nova atividade: ${d}`, editou_tarefa: d => `Atividade atualizada: ${d}`, comentou: d => `A equipe comentou em ${d}`, enviou_arquivo: d => `A equipe enviou um documento em ${d}`, pediu_cliente: d => `A equipe precisa de você em ${d}`, solicitou_aprovacao: d => `Entrega aguardando a sua aprovação: ${d}`,
  editou_projeto: () => 'Dados do projeto atualizados', respondeu_chamado: d => `A equipe respondeu o chamado ${d}`, etapa_chamado: d => `Chamado: ${d}` };
function novidadesDe(u) {
  const c = db.clientes.find(x => x.id === u.id) || {}; const meus = new Set(db.projetos.filter(p => p.clientes.includes(u.id)).map(p => p.id)); const desde = Date.now() - 30 * 86400e3; const vistas = new Map();
  for (const l of [...db.logs].reverse()) {
    if (l.tipo !== 'equipe' || !ROTULO[l.acao] || Date.parse(l.ts) < desde) continue; if (!(l.cliente === u.id || (l.projetoId && meus.has(l.projetoId)))) continue;
    if (l.interna) continue; if (['criou_tarefa', 'editou_tarefa', 'pediu_cliente', 'solicitou_aprovacao', 'comentou', 'enviou_arquivo'].includes(l.acao) && db.tarefas.some(x => x.projetoId === l.projetoId && x.nome === l.detalhe && x.interna)) continue; // atividade interna nunca aparece
    const k = l.acao + '|' + l.detalhe + '|' + (l.projetoId || ''); const ant = vistas.get(k); if (ant && Math.abs(Date.parse(ant.ts) - Date.parse(l.ts)) < 3600e3) continue; vistas.set(k, l);
  }
  const itens = [...vistas.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 20).map(l => ({ ts: l.ts, texto: ROTULO[l.acao](l.detalhe), projeto: (projetoDe(l.projetoId) || {}).nome || '' }));
  const visto = c.vistoEm || c.criadoEm || '1970'; return { itens, novas: itens.filter(i => i.ts > visto).length };
}

// ---- integração com o funil de suporte (somente administradores do Bitrix24) ----
const exigirAdmin = u => { exigir(u, 'equipe'); if (!u.admin) throw bad(403, 'Somente administradores configuram a integração.'); };
const estadoSuporte = () => { const c = suporte.cfg(); return { configurado: bitrix.enabled, host: hostDe(bitrix.base), dica: hint(suporte.webhook()), origem: secrets.get('bitrixWebhook') ? 'painel' : process.env.BITRIX_WEBHOOK ? 'ambiente' : 'nenhuma', categoriaId: c.categoriaId ?? null, estagioId: c.estagioId || '', funilNome: c.funilNome || '', etapaNome: c.etapaNome || '', pronto: suporte.pronto(),
  pendentes: db.solicitacoes.filter(s => s.bitrix && s.bitrix.status !== 'enviado').length }; };
const RESPOSTAS_PADRAO = [['Recebemos seu chamado', 'Olá, {cliente}! Recebemos o seu chamado {protocolo} e já estamos analisando. Voltamos com uma resposta em breve.'], ['Precisamos de mais informações', 'Olá, {cliente}! Para avançarmos no chamado {protocolo}, pode nos enviar mais detalhes (prints, o passo a passo e o horário em que aconteceu)?'], ['Chamado resolvido', 'Olá, {cliente}! Finalizamos o atendimento do chamado {protocolo}. Se algo ainda não estiver certo, é só responder por aqui. Obrigado!']];
if (!(db.respostas || []).length) { db.respostas = RESPOSTAS_PADRAO.map(([titulo, texto]) => ({ id: store.id(), titulo, texto })); store.save(); }
const artigoPublico = a => ({ id: a.id, titulo: a.titulo, texto: a.texto, categoria: a.categoria || '' });
// ---- relatório semanal ----
const gerarRelatorio = (p, semana, visao) => Relat.gerar({ projeto: p, tarefas: tarefasDe(p.id), logs: db.logs, solicitacoes: db.solicitacoes, itens: db.itens, arquivos: db.arquivos, S, Audit, cal: calDe(p), hoje: hoje(), semana, visao });
function guardarRelatorio(p, semana) {
  const rel = { id: store.id(), projetoId: p.id, semana, geradoEm: store.agora(), equipe: gerarRelatorio(p, semana, 'equipe'), cliente: gerarRelatorio(p, semana, 'cliente') };
  db.relatorios = (db.relatorios || []).filter(r => !(r.projetoId === p.id && r.semana === semana)); db.relatorios.push(rel);
  const meus = db.relatorios.filter(r => r.projetoId === p.id).sort((a, b) => b.semana.localeCompare(a.semana)); if (meus.length > 60) db.relatorios = db.relatorios.filter(r => r.projetoId !== p.id || meus.slice(0, 60).includes(r)); store.save(); return rel;
}
// Toda segunda-feira (a partir das 6h de Brasília) guarda o relatório da semana anterior de cada projeto ativo; se o servidor estava dormindo, recupera depois.
function rodarRelatoriosSemanais(agora = new Date()) {
  const dia = S.hojeSP(agora), dow = new Date(dia + 'T12:00:00Z').getUTCDay(), hora = +new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(agora); if (dow === 1 && hora < 6) return 0;
  const semana = Relat.semanaAnterior(dia, S); let n = 0;
  for (const p of db.projetos.filter(x => x.situacao !== 'concluido' && tarefasDe(x.id).length)) { if ((db.relatorios || []).some(r => r.projetoId === p.id && r.semana === semana)) continue; guardarRelatorio(p, semana); store.log('Sistema', 'equipe', 'gerou_relatorio', `semana de ${semana}`, p.id); n++; }
  return n;
}
const semanaValida = (q, h) => { const v = q ? String(q) : Relat.semanaAnterior(h, S); if (!S.isDate(v)) throw bad(400, 'Semana inválida (use AAAA-MM-DD).'); const seg = Relat.segundaDe(v, S); if (seg > Relat.segundaDe(h, S)) throw bad(400, 'Essa semana ainda não começou.'); return seg; };
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
const modeloView = m => ({ id: m.id, nome: m.nome, tipo: m.tipo || '', descricao: m.descricao || '', embutido: !!m.embutido, diasUteis: !!m.diasUteis, qtdTarefas: m.tarefas.length, tarefas: m.tarefas.map(t => ({ nome: t.nome, dur: t.dur })) });

// Tudo o que as rotas e o servidor compartilham.
module.exports = { SUPORTE_ATIVO, MAX_FALHAS, limitaIp, http, fs, path, createStore, createSecrets, hint, checkWebhook, hostDe, createBitrix, createSuporte, CAT, PRIO, Audit, Modelos, SLA, Ajuda, Relat, A, S, PORT, DATA_DIR, store, db, PUB, secrets, bitrix, crypto, assinar, PUBLIC_URL, linkArquivo, suporte, MAX_FILE, SEC, bad, send, readBody, quem, exigir, cookie, mesmaOrigem, str, TIPOS, PRIORIDADES, lerProjeto, proximoCodigo, validarProjeto, reg, vistos, regUnico, snapT, nomeTarefa, desfazerDe, nomeCliente, tarefasDe, projetoDe, hoje, podeVer, tarefaView, projetoView, lerTarefa, calDe, aplicarTarefas, modeloPorId, aplicarModelo, registraReagendadas, depsBloqueio, ajustesDe, R, rota, legal, falhas, ROT_APROV, logAprov, tarefaAcessivel, enviarArquivo, protocolo, cardUrl, msgView, solView, solAcessivel, ROTULO, novidadesDe, exigirAdmin, estadoSuporte, RESPOSTAS_PADRAO, artigoPublico, gerarRelatorio, guardarRelatorio, rodarRelatoriosSemanais, semanaValida, filtraLogs, modeloView };
