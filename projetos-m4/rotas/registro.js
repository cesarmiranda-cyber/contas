'use strict';
// Registro de alterações: log, histórico por projeto e desfazer.
module.exports = ctx => {
  const { A, Audit, SEC, ajustesDe, aplicarTarefas, bad, db, desfazerDe, exigir, filtraLogs, http, nomeCliente, nomeTarefa, podeVer, projetoDe, reg, registraReagendadas, rota, send, snapT, store, tarefasDe, validarProjeto } = ctx;
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
};
