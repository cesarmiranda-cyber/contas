'use strict';
// Chamados, integração com o funil de suporte, SLA, equipe, respostas prontas e central de ajuda.
module.exports = ctx => {
  const { A, Ajuda, CAT, MAX_FILE, PRIO, S, SLA, artigoPublico, bad, bitrix, cardUrl, checkWebhook, db, estadoSuporte, exigir, exigirAdmin, fs, http, podeVer, projetoDe, protocolo, quem, reg, regUnico, rota, secrets, send, solAcessivel, solView, store, str, suporte } = ctx;
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
// ---- equipe, prazos de resposta (SLA), respostas prontas e central de ajuda ----
rota('GET', '/api/equipe', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { equipe: Object.values(db.equipe || {}).sort((a, b) => a.nome.localeCompare(b.nome)).map(x => ({ id: x.id, nome: x.nome })) }); });
rota('GET', '/api/config/sla', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { sla: SLA.config(db), padrao: SLA.PADRAO }); });
rota('POST', '/api/config/sla', async (req, res, _m, b, u) => {
  exigir(u, 'equipe'); if (!u.admin) throw bad(403, 'Somente administradores alteram os prazos.'); const novo = {}; for (const k of Object.keys(SLA.PADRAO)) { const v = +b[k]; if (!(v > 0 && v <= 720)) throw bad(400, `Prazo inválido para “${k}” (use de 1 a 720 horas).`); novo[k] = v; }
  const ant = SLA.config(db); db.config.sla = novo; reg(u, 'configurou_sla', Object.keys(novo).map(k => `${k}: ${ant[k]}h → ${novo[k]}h`).join(' · ')); store.save(); send(res, 200, { sla: SLA.config(db) });
});
rota('GET', '/api/respostas', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { respostas: db.respostas }); });
rota('POST', '/api/respostas', async (req, res, _m, b, u) => { exigir(u, 'equipe'); const r = { id: store.id(), titulo: str(b.titulo, 80, true, 'Título'), texto: str(b.texto, 2000, true, 'Texto') }; db.respostas.push(r); store.save(); send(res, 201, { resposta: r }); });
rota('PATCH', '/api/respostas/([0-9a-f]+)', async (req, res, m, b, u) => { exigir(u, 'equipe'); const r = db.respostas.find(x => x.id === m[1]); if (!r) throw bad(404, 'Resposta não encontrada.'); if ('titulo' in b) r.titulo = str(b.titulo, 80, true, 'Título'); if ('texto' in b) r.texto = str(b.texto, 2000, true, 'Texto'); store.save(); send(res, 200, { resposta: r }); });
rota('DELETE', '/api/respostas/([0-9a-f]+)', async (req, res, m, _b, u) => { exigir(u, 'equipe'); if (!db.respostas.some(x => x.id === m[1])) throw bad(404, 'Resposta não encontrada.'); db.respostas = db.respostas.filter(x => x.id !== m[1]); store.save(); send(res, 200, { ok: true }); });
rota('GET', '/api/artigos', async (req, res, _m, _b, u) => { exigir(u); send(res, 200, { artigos: u.tipo === 'equipe' ? db.artigos : db.artigos.filter(a => a.publicado !== false).map(artigoPublico) }); });
rota('GET', '/api/artigos/sugestoes', async (req, res, _m, _b, u) => { exigir(u); const q = new URL(req.url, 'http://x').searchParams.get('q') || ''; const r = Ajuda.sugerir(db.artigos, q, 3); for (const a of r) a.vistas = (a.vistas || 0) + 1; if (r.length) store.save(); send(res, 200, { artigos: r.map(artigoPublico) }); });
rota('POST', '/api/artigos', async (req, res, _m, b, u) => { exigir(u, 'equipe'); const a = { id: store.id(), titulo: str(b.titulo, 140, true, 'Título'), texto: str(b.texto, 8000, true, 'Texto'), palavras: str(b.palavras, 300), categoria: str(b.categoria, 60), publicado: b.publicado !== false, criadoEm: store.agora(), vistas: 0, uteis: 0, naoUteis: 0 }; db.artigos.push(a); store.save(); send(res, 201, { artigo: a }); });
rota('PATCH', '/api/artigos/([0-9a-f]+)', async (req, res, m, b, u) => { exigir(u, 'equipe'); const a = db.artigos.find(x => x.id === m[1]); if (!a) throw bad(404, 'Artigo não encontrado.'); if ('titulo' in b) a.titulo = str(b.titulo, 140, true, 'Título'); if ('texto' in b) a.texto = str(b.texto, 8000, true, 'Texto'); if ('palavras' in b) a.palavras = str(b.palavras, 300); if ('categoria' in b) a.categoria = str(b.categoria, 60); if ('publicado' in b) a.publicado = !!b.publicado; a.atualizadoEm = store.agora(); store.save(); send(res, 200, { artigo: a }); });
rota('DELETE', '/api/artigos/([0-9a-f]+)', async (req, res, m, _b, u) => { exigir(u, 'equipe'); if (!db.artigos.some(x => x.id === m[1])) throw bad(404, 'Artigo não encontrado.'); db.artigos = db.artigos.filter(x => x.id !== m[1]); store.save(); send(res, 200, { ok: true }); });
rota('POST', '/api/artigos/([0-9a-f]+)/util', async (req, res, m, b, u) => { exigir(u, 'cliente'); const a = db.artigos.find(x => x.id === m[1] && x.publicado !== false); if (!a) throw bad(404, 'Artigo não encontrado.'); if (b.resolveu) a.uteis = (a.uteis || 0) + 1; else a.naoUteis = (a.naoUteis || 0) + 1; store.save(); send(res, 200, { ok: true }); });
};
