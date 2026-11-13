'use strict';
// Clientes do portal: ativação, bloqueio e anonimização (LGPD).
module.exports = ctx => {
  const { A, Audit, bad, crypto, db, exigir, nomeCliente, projetoDe, reg, rota, send, store } = ctx;
rota('GET', '/api/clientes', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe');
  send(res, 200, { clientes: db.clientes.map(c => ({ id: c.id, nome: c.nome, email: c.email, empresa: c.empresa, telefone: c.telefone, criadoEm: c.criadoEm, ativo: c.ativo !== false, anonimizado: !!c.anonimizadoEm, aceite: c.aceite || null,
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
rota('POST', '/api/clientes/([0-9a-f]+)/anonimizar', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); if (!u.admin) throw bad(403, 'Somente administradores anonimizam clientes.'); const c = db.clientes.find(x => x.id === m[1]); if (!c) throw bad(404, 'Cliente não encontrado.'); if (c.anonimizadoEm) throw bad(409, 'Este cliente já foi anonimizado.');
  if (b.confirmar !== true) throw bad(400, 'Confirmação obrigatória.'); const nomeAnt = c.nome, rotulo = 'Cliente removido'; const projetosDele = db.projetos.filter(p => p.clientes.includes(c.id)); const tids = new Set(db.tarefas.filter(t => projetosDele.some(p => p.id === t.projetoId)).map(t => t.id));
  // texto livre do titular: troca as ocorrências exatas do nome, e-mail e telefone dele (não analisa o que ele escreveu sobre outras pessoas nem o conteúdo de arquivos)
  const alvos = [c.email, c.telefone, nomeAnt].filter(x => x && String(x).trim().length >= 4); const limpaTxt = x => alvos.reduce((t, v) => String(t).split(v).join('[removido]'), x == null ? '' : x);
  for (const i of db.itens) if (i.tipoAutor === 'cliente' && i.autor === nomeAnt && tids.has(i.tarefaId)) { i.autor = rotulo; i.texto = limpaTxt(i.texto); }
  for (const s of db.solicitacoes.filter(x => x.clienteId === c.id)) { s.assunto = limpaTxt(s.assunto); s.texto = limpaTxt(s.texto); for (const msg of s.mensagens || []) msg.texto = limpaTxt(msg.texto); }
  for (const s of db.solicitacoes.filter(x => x.clienteId === c.id)) { s.cliente = rotulo; s.empresa = ''; s.email = ''; s.telefone = ''; for (const msg of s.mensagens || []) if (msg.tipoAutor === 'cliente') msg.autor = rotulo; if (s.avaliacao) s.avaliacao.comentario = ''; }
  for (const l of db.logs) if (l.uid === c.id || (l.cliente === c.id && l.tipo === 'cliente')) { l.quem = rotulo; if (['login', 'login_falhou', 'cadastro'].includes(l.acao)) l.detalhe = ''; }
  // registros feitos pela equipe que citam o cliente (vínculo a projeto, bloqueio): troca só nos campos conhecidos, sem mexer em nomes de outras pessoas
  const emailAnt = c.email; const troca = x => String(x).split(', ').map(n => n === nomeAnt ? rotulo : n).join(', ');
  for (const l of db.logs) { if (['ativou_cliente', 'alterou_acesso_cliente'].includes(l.acao)) l.detalhe = String(l.detalhe).split(nomeAnt).join(rotulo); if (['bloqueou_cliente', 'reativou_cliente'].includes(l.acao) && l.detalhe === emailAnt) l.detalhe = ''; for (const d of l.diff || []) if (d.campo === 'Clientes com acesso') { d.de = troca(d.de); d.para = troca(d.para); } }
  for (const p of projetosDele) p.clientes = p.clientes.filter(x => x !== c.id);
  Object.assign(c, { nome: rotulo, email: `removido-${c.id}@invalid.local`, telefone: '', empresa: '', senha: A.hash(crypto.randomBytes(24).toString('hex')), ativo: false, aceite: null, vistoEm: null, anonimizadoEm: store.agora() });
  reg(u, 'anonimizou_cliente', `cliente ${c.id.slice(0, 6)} (a pedido do titular)`); store.save(); send(res, 200, { ok: true });
});
};
