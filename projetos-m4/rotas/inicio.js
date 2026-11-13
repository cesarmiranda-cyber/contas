'use strict';
// Início do cliente, novidades, painel da equipe e “Minha fila”.
module.exports = ctx => {
  const { Ajuda, S, SLA, db, exigir, hoje, http, novidadesDe, projetoView, protocolo, rota, send, solView, store, suporte, tarefasDe } = ctx;
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
rota('GET', '/api/painel', async (req, res, _m, _b, u) => {
  exigir(u, 'equipe'); const ps = db.projetos.map(p => projetoView(p, u, false));
  send(res, 200, { projetos: ps.length, verde: ps.filter(p => p.resumo.cor === 'verde').length, amarelo: ps.filter(p => p.resumo.cor === 'amarelo').length, vermelho: ps.filter(p => p.resumo.cor === 'vermelho').length,
    solicitacoesNovas: db.solicitacoes.filter(s => s.status === 'nova').length, clientes: db.clientes.length,
    avaliacaoMedia: (() => { const n = db.solicitacoes.filter(x => x.avaliacao).map(x => x.avaliacao.nota); return n.length ? Math.round(n.reduce((a, b) => a + b, 0) / n.length * 10) / 10 : null; })(),
    aguardando: db.clientes.filter(c => c.ativo !== false && !db.projetos.some(p => p.clientes.includes(c.id))).length });
});
};
