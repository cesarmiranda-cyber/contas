'use strict';
// Relatório semanal do projeto. Dois formatos: "equipe" (completo) e "cliente" (sem atividades internas, valores ou observações internas).
const diaBR = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ts));
const segundaDe = (s, S) => { const dow = new Date(Date.parse(s + 'T00:00:00Z')).getUTCDay(); return S.addDays(s, -((dow + 6) % 7)); };
const semanaAnterior = (hoje, S) => S.addDays(segundaDe(hoje, S), -7);

function gerar({ projeto: p, tarefas, logs, solicitacoes, itens, arquivos, S, Audit, cal, hoje, semana, visao }) {
  const de = semana, ate = S.addDays(semana, 6), ref = ate < hoje ? ate : hoje; const cli = visao === 'cliente';
  const vis = tarefas.filter(t => !cli || !t.interna), idsVis = new Set(vis.map(t => t.id)); const dentro = ts => { const d = diaBR(ts); return d >= de && d <= ate; };
  const resumoT = S.resumo(vis, ref), desvio = p.fimPrevisto && resumoT.fim ? S.diffDays(p.fimPrevisto, resumoT.fim) : null;
  const eventos = logs.filter(l => l.projetoId === p.id && dentro(l.ts)).map(l => cli ? Audit.paraCliente(l) && { ...Audit.paraCliente(l), tarefaId: l.tarefaId } : { ...Audit.paraEquipe(l), tarefaId: l.tarefaId }).filter(Boolean).sort((a, b) => a.ts.localeCompare(b.ts));
  const concl = new Map(), andam = new Map(), datas = [];
  for (const e of eventos) {
    for (const d of e.diff || []) {
      if (e.acao === 'criou_tarefa') break; // criar a atividade não é mudança de data nem de andamento
      if (d.campo === 'Andamento') { if (d.para === '100%') { if (!concl.has(e.tarefaId || e.detalhe)) concl.set(e.tarefaId || e.detalhe, { nome: e.detalhe, em: e.ts }); } else { const k = e.tarefaId || e.detalhe; andam.set(k, { nome: e.detalhe, de: andam.has(k) ? andam.get(k).de : d.de, para: d.para }); } }
      if (d.campo === 'Início' || d.campo === 'Término') datas.push({ nome: e.detalhe, campo: d.campo, de: d.de, para: d.para, por: e.quem });
    }
    if (e.acao === 'aprovou_entrega' && !concl.has(e.tarefaId || e.detalhe)) concl.set(e.tarefaId || e.detalhe, { nome: e.detalhe, em: e.ts, aprovadaPor: e.quem });
  }
  const aberta = t => S.status(t, vis, ref).codigo !== 'concluida';
  const proximas = vis.filter(t => aberta(t) && t.inicio <= S.addDays(ref, 14) && t.fim >= ref).sort((a, b) => a.fim.localeCompare(b.fim)).slice(0, 12).map(t => ({ nome: t.nome, inicio: t.inicio, fim: t.fim, progresso: t.progresso, cor: S.status(t, vis, ref).cor }));
  const atrasadas = vis.filter(t => S.status(t, vis, ref).codigo === 'atrasada').sort((a, b) => a.fim.localeCompare(b.fim)).map(t => ({ nome: t.nome, fim: t.fim, dias: S.diffDays(t.fim, ref) }));
  const pend = vis.filter(t => (t.aguardaCliente && (+t.progresso || 0) < 100)).map(t => ({ nome: t.nome, pedido: t.pedido || '' })), apr = vis.filter(t => t.aprovacao && t.aprovacao.estado === 'pendente').map(t => ({ nome: t.nome, desde: t.aprovacao.solicitadaEm }));
  const docs = itens.filter(i => i.arquivoId && idsVis.has(i.tarefaId) && dentro(i.ts)).map(i => ({ nome: (arquivos.find(a => a.id === i.arquivoId) || {}).nome || 'arquivo', atividade: (vis.find(t => t.id === i.tarefaId) || {}).nome || '', autor: i.autor, tipoAutor: i.tipoAutor }));
  const sols = solicitacoes.filter(s => s.projetoId === p.id); const abertosSem = sols.filter(s => dentro(s.criadoEm)), fechados = sols.filter(s => !['nova', 'em_analise', 'aprovada'].includes(s.status) && s.status !== undefined && ['concluida', 'recusada'].includes(s.status) && dentro((s.etapa && s.etapa.desde) || (s.mensagens || []).slice(-1)[0]?.ts || s.criadoEm));
  const chamados = { abertosNaSemana: abertosSem.length, concluidosNaSemana: fechados.length, abertosAgora: sols.filter(s => !['concluida', 'recusada'].includes(s.status)).length, ...(cli ? {} : { itens: sols.filter(s => dentro(s.criadoEm) || !['concluida', 'recusada'].includes(s.status)).map(s => ({ protocolo: s.protocolo, assunto: s.assunto, status: s.status, cliente: s.cliente })) }) };
  const f = x => x.split('-').reverse().join('/'), destaques = [];
  destaques.push(`${resumoT.progresso}% do projeto concluído (${resumoT.concluidas} de ${resumoT.total} atividades).`);
  if (concl.size) destaques.push(`${concl.size} atividade(s) concluída(s) na semana.`); if (datas.length) destaques.push(`${new Set(datas.map(d => d.nome)).size} atividade(s) com datas alteradas.`);
  if (desvio > 0) destaques.push(`Atenção: a previsão de término (${f(resumoT.fim)}) está ${desvio} dia(s) além do prazo contratado (${f(p.fimPrevisto)}).`); else if (desvio != null) destaques.push(`Previsão de término (${f(resumoT.fim)}) dentro do prazo contratado.`);
  if (atrasadas.length) destaques.push(`${atrasadas.length} atividade(s) atrasada(s).`); if (pend.length || apr.length) destaques.push(`${pend.length + apr.length} item(ns) aguardando o cliente.`);
  return { visao, projeto: { id: p.id, nome: p.nome, codigo: p.codigo || '', tipo: p.tipo || '', empresa: p.empresa || '', gerente: p.gerente || '', fimPrevisto: p.fimPrevisto || '', previsaoFim: resumoT.fim, desvioDias: desvio }, periodo: { de, ate, referencia: ref }, resumo: { progresso: resumoT.progresso, cor: resumoT.cor, concluidas: resumoT.concluidas, total: resumoT.total, verde: resumoT.verde, amarelo: resumoT.amarelo, vermelho: resumoT.vermelho },
    destaques, concluidasNaSemana: [...concl.values()], andamento: [...andam.values()], mudancasDeData: datas, proximas, atrasadas, aguardandoCliente: { pedidos: pend, aprovacoes: apr }, documentos: docs, chamados };
}
module.exports = { gerar, segundaDe, semanaAnterior, diaBR };
