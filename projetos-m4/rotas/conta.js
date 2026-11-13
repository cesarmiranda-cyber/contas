'use strict';
// Conta e acesso: cadastro, login, termos (LGPD) e “meus dados”.
module.exports = ctx => {
  const { A, Audit, SEC, bad, cookie, db, exigir, falhas, legal, protocolo, reg, rota, send, solView, store, str } = ctx;
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
  const email = str(b.email, 160, true, 'E-mail').toLowerCase(), nome = str(b.nome, 120, true, 'Nome');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad(400, 'E-mail inválido.');
  if (String(b.senha || '').length < 8) throw bad(400, 'A senha deve ter ao menos 8 caracteres.');
  if (db.clientes.some(c => c.email === email)) throw bad(409, 'Já existe uma conta com este e-mail.');
  const lg = legal(); if (lg.versao && b.aceite !== true) throw bad(400, 'Para criar a conta, aceite os Termos de uso e a Política de privacidade.');
  const c = { id: store.id(), nome, email, empresa: str(b.empresa, 120), telefone: str(b.telefone, 40), senha: A.hash(String(b.senha)), criadoEm: store.agora(), ativo: true, ...(lg.versao ? { aceite: { versao: lg.versao, ts: store.agora() } } : {}) };
  db.clientes.push(c); store.log(nome, 'cliente', 'cadastro', email, null, { uid: c.id }); store.save();
  send(res, 201, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
rota('POST', '/api/auth/login', async (req, res, _m, b) => {
  const email = String(b.email || '').trim().toLowerCase(), f = falhas.get(email) || { n: 0, ate: 0 };
  if (f.n >= 5 && Date.now() < f.ate) throw bad(429, 'Muitas tentativas. Tente novamente em alguns minutos.');
  const c = db.clientes.find(x => x.email === email && x.ativo !== false);
  if (!c || !A.confere(String(b.senha || ''), c.senha)) { falhas.set(email, { n: f.n + 1, ate: Date.now() + 15 * 60e3 }); const mascara = e => e.replace(/^(.).*(@.*)$/, '$1***$2') || '?'; if (c) store.log(c.nome, 'cliente', 'login_falhou', '', null, { uid: c.id }); else store.log('Tentativa de login', 'cliente', 'login_falhou', mascara(email)); throw bad(401, 'E-mail ou senha incorretos.'); }
  falhas.delete(email); store.log(c.nome, 'cliente', 'login', c.email, null, { uid: c.id });
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, A.emitir(store.secret, c.id), A.TTL / 1000) });
});
rota('POST', '/api/auth/logout', async (req, res, _m, _b, u) => { if (u) reg(u, 'saiu'); send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) }); });
rota('GET', '/api/me', async (req, res, _m, _b, u) => { const l = legal(); const c = u && u.tipo === 'cliente' && db.clientes.find(x => x.id === u.id); send(res, 200, { usuario: u, legalVersao: l.versao, precisaAceitar: !!(c && l.versao && !(c.aceite && c.aceite.versao === l.versao)) }); });
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
