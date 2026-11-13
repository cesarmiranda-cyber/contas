'use strict';
// Projetos, atividades, arquivos, aprovação de entrega e documentos.
module.exports = ctx => {
  const { A, Audit, MAX_FILE, ROT_APROV, S, ajustesDe, aplicarModelo, aplicarTarefas, assinar, bad, calDe, crypto, db, depsBloqueio, desfazerDe, enviarArquivo, exigir, fs, http, lerProjeto, lerTarefa, logAprov, modeloPorId, nomeCliente, nomeTarefa, podeVer, projetoDe, projetoView, proximoCodigo, reg, regUnico, registraReagendadas, rota, send, snapT, store, str, tarefaAcessivel, tarefasDe, validarProjeto } = ctx;
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
// Todos os documentos enviados nas atividades do projeto, em um só lugar (o cliente não vê os de atividades internas).
rota('GET', '/api/projetos/([0-9a-f]+)/documentos', async (req, res, m, _b, u) => {
  exigir(u); const p = projetoDe(m[1]); if (!p || !podeVer(u, p)) throw bad(404, 'Projeto não encontrado.'); const tarefas = new Map(tarefasDe(p.id).filter(t => u.tipo === 'equipe' || !t.interna).map(t => [t.id, t]));
  const docs = db.itens.filter(i => i.arquivoId && tarefas.has(i.tarefaId)).map(i => { const a = db.arquivos.find(x => x.id === i.arquivoId); return a && { id: a.id, nome: a.nome, tamanho: a.tamanho, ts: i.ts, autor: i.autor, tipoAutor: i.tipoAutor, tarefa: tarefas.get(i.tarefaId).nome, tarefaId: i.tarefaId }; }).filter(Boolean);
  send(res, 200, { documentos: docs.sort((a, b) => b.ts.localeCompare(a.ts)) });
});
};
