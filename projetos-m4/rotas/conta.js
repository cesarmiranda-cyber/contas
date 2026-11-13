'use strict';
// Conta e acesso: cadastro, login, termos (LGPD) e “meus dados”.
module.exports = ctx => {
  const { MAX_FALHAS, limitaIp, A, Audit, SEC, bad, cookie, db, exigir, falhas, legal, protocolo, reg, rota, send, solView, store, str } = ctx;
rota('GET', '/api/legal', async (req, res) => send(res, 200, legal())); // público: o cadastro precisa mostrar antes do login
rota('POST', '/api/config/legal', async (req, res, _m, b, u) => {
  exigir(u, 'equipe'); if (!u.admin) throw bad(403, 'Somente administradores publicam os textos legais.'); const termos = str(b.termos, 30000, true, 'Termos de uso'), privacidade = str(b.privacidade, 30000, true, 'Política de privacidade');
  if (/\[[A-ZÀ-Ú0-9][A-ZÀ-Ú0-9 /\-.]{2,}\]/.test(termos + privacidade)) throw bad(400, 'Ainda há campos entre colchetes (ex.: [CNPJ]). Preencha ou remova antes de publicar.');
  const ant = legal(); db.config.legal = { termos, privacidade, versao: ant.versao + 1, publicadoEm: store.agora(), publicadoPor: u.nome }; reg(u, 'atualizou_termos', `versão ${db.config.legal.versao}`); store.save(); send(res, 200, legal());
});
rota('POST', '/api/eu/aceite', async (req, res, _m, b, u) => {
  exigir(u, 'cliente'); const l = legal(); if (!l.versao || +b.versao !== l.versao) throw bad(400, 'Versão dos termos inválida. Atualize a página.'); const c = db.clientes.find(x => x.id === u.id); c.aceite = { versao: l.versao, ts: store.agora() }; reg(u, 'aceitou_termos', `versão ${l.versao}`); store.save(); send(res, 200, { ok: true });
});
rota('POST', '/api/auth/cadastro', async (req, res, _m, b) => {
  limitaIp(req, 'cadastro', 10, 60 * 60e3);
  const email = str(b.email, 160, true, 'E-mail').toLowerCase(), nome = str(b.nome, 120, true, 'Nome');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad(400, 'E-mail inválido.');
  { const e = A.validarSenha(b.senha); if (e) throw bad(400, e); }
  if (db.clientes.some(c => c.email === email)) throw bad(409, 'Já existe uma conta com este e-mail.');
  const lg = legal(); if (lg.versao && b.aceite !== true) throw bad(400, 'Para criar a conta, aceite os Termos de uso e a Política de privacidade.');
  const c = { id: store.id(), nome, email, empresa: str(b.empresa, 120), telefone: str(b.telefone, 40), senha: A.hash(String(b.senha)), criadoEm: store.agora(), ativo: true, ...(lg.versao ? { aceite: { versao: lg.versao, ts: store.agora() } } : {}) };
  db.clientes.push(c); store.log(nome, 'cliente', 'cadastro', email, null, { uid: c.id }); store.save();
  send(res, 201, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
const MSG_BLOQ = 'Acesso bloqueado após 3 tentativas incorretas. Fale com a equipe Manda4 para liberar o seu acesso.';
const mascara = e => e.replace(/^(.).*(@.*)$/, '$1***$2') || '?';
rota('POST', '/api/auth/login', async (req, res, _m, b) => {
  limitaIp(req, 'login', 30, 15 * 60e3); // trava rajadas vindas de um mesmo endereço, mesmo trocando de e-mail
  const email = String(b.email || '').trim().toLowerCase().slice(0, 160), senha = String(b.senha || '').slice(0, 200);
  const c = db.clientes.find(x => x.email === email && x.ativo !== false);
  const f = falhas.get(email) || { n: 0, ate: 0 }; // contador em memória para e-mails sem conta: a resposta é igual à de uma conta real (não revela quem é cliente)
  if (c ? c.bloqueioLogin : f.n >= MAX_FALHAS && Date.now() < f.ate) throw bad(423, MSG_BLOQ);
  if (!c || !A.confere(senha, c.senha)) {
    const n = c ? (c.tentativasErradas = (c.tentativasErradas || 0) + 1) : f.n + 1;
    if (!c) falhas.set(email, { n, ate: Date.now() + 30 * 60e3 });
    store.log(c ? c.nome : 'Tentativa de login', 'cliente', 'login_falhou', c ? '' : mascara(email), null, c ? { uid: c.id } : {});
    if (n >= MAX_FALHAS) { if (c) { c.bloqueioLogin = { em: store.agora(), tentativas: n }; store.log(c.nome, 'cliente', 'login_bloqueado', `${n} tentativas incorretas`, null, { uid: c.id }); } store.save(); throw bad(423, MSG_BLOQ); }
    if (c) store.save(); throw bad(401, `E-mail ou senha incorretos. ${MAX_FALHAS - n === 1 ? 'Resta 1 tentativa' : `Restam ${MAX_FALHAS - n} tentativas`} antes do bloqueio.`);
  }
  falhas.delete(email); if (c.tentativasErradas) { c.tentativasErradas = 0; } store.log(c.nome, 'cliente', 'login', c.email, null, { uid: c.id }); store.save();
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
rota('POST', '/api/auth/logout', async (req, res, _m, _b, u) => { if (u) { reg(u, 'saiu'); if (u.tipo === 'cliente') { const c = db.clientes.find(x => x.id === u.id); if (c) { c.sessoesRevogadasEm = Date.now(); store.save(); } } } send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) }); });
// Troca de senha pelo próprio cliente (também usada na troca obrigatória após uma redefinição feita pela equipe).
rota('POST', '/api/eu/senha', async (req, res, _m, b, u) => {
  exigir(u, 'cliente'); limitaIp(req, 'senha', 10, 15 * 60e3); const c = db.clientes.find(x => x.id === u.id);
  if (!A.confere(String(b.atual || '').slice(0, 200), c.senha)) throw bad(400, 'A senha atual não confere.');
  const e = A.validarSenha(b.nova); if (e) throw bad(400, e); if (String(b.nova) === String(b.atual)) throw bad(400, 'Escolha uma senha diferente da atual.');
  c.senha = A.hash(String(b.nova)); c.trocarSenha = false; c.sessoesRevogadasEm = Date.now() - 1; reg(u, 'trocou_senha'); store.save();
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
rota('GET', '/api/me', async (req, res, _m, _b, u) => { const l = legal(); const c = u && u.tipo === 'cliente' && db.clientes.find(x => x.id === u.id); send(res, 200, { usuario: u, sessaoMin: A.TTL / 60e3, trocarSenha: !!(c && c.trocarSenha), legalVersao: l.versao, precisaAceitar: !!(c && l.versao && !(c.aceite && c.aceite.versao === l.versao)) }); });
// ---- LGPD: o cliente baixa os próprios dados; um administrador anonimiza quando ele pedir a exclusão ----
rota('GET', '/api/eu/dados', async (req, res, _m, _b, u) => {
  exigir(u, 'cliente'); const c = db.clientes.find(x => x.id === u.id); const meus = db.projetos.filter(p => p.clientes.includes(c.id)); const tids = new Map(db.tarefas.filter(t => meus.some(p => p.id === t.projetoId) && !t.interna).map(t => [t.id, t]));
  const dados = { exportadoEm: store.agora(), conta: { nome: c.nome, email: c.email, telefone: c.telefone || '', empresa: c.empresa || '', criadaEm: c.criadoEm, aceite: c.aceite || null },
    projetos: meus.map(p => ({ nome: p.nome, codigo: p.codigo || '', empresa: p.empresa || '' })),
    chamados: db.solicitacoes.filter(s => s.clienteId === c.id).map(s => solView(s, u)).map(s => ({ protocolo: s.protocolo, assunto: s.assunto, categoria: s.categoria, prioridade: s.prioridade, status: s.status, criadoEm: s.criadoEm, descricao: s.texto, mensagens: s.mensagens.map(m => ({ autor: m.autor, tipo: m.tipoAutor, em: m.ts, texto: m.texto, arquivo: m.arquivo ? m.arquivo.nome : null })), avaliacao: s.avaliacao })),
    mensagensNasAtividades: db.itens.filter(i => i.tipoAutor === 'cliente' && i.autor === c.nome && tids.has(i.tarefaId)).map(i => ({ atividade: tids.get(i.tarefaId).nome, em: i.ts, texto: i.texto, arquivo: i.arquivoId ? (db.arquivos.find(a => a.id === i.arquivoId) || {}).nome || null : null })),
    arquivosEnviados: db.arquivos.filter(a => db.itens.some(i => i.arquivoId === a.id && i.tipoAutor === 'cliente' && i.autor === c.nome) || db.solicitacoes.some(s => s.clienteId === c.id && (s.mensagens || []).some(m => m.arquivoId === a.id && m.tipoAutor === 'cliente'))).map(a => ({ nome: a.nome, tamanhoBytes: a.tamanho, em: a.ts })),
    acessos: db.logs.filter(l => l.uid === c.id).map(l => ({ em: l.ts, acao: Audit.ROTULO[l.acao] || l.acao, detalhe: l.detalhe })) };
  reg(u, 'exportou_dados', 'download dos próprios dados'); const txt = JSON.stringify(dados, null, 2);
  res.writeHead(200, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="meus-dados-manda4.json"', 'Cache-Control': 'no-store' }); res.end(txt);
});
};
