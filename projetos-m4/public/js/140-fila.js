// ---------- minha fila (equipe) ----------
async function telaFila(m) {
  const st = view.fila = view.fila || { meus: false }; const f = await api('GET', '/api/fila' + (st.meus ? '?so_meus=1' : ''));
  const abreT = i => go({ nome: 'projeto', id: i.projetoId, abrir: i.tarefaId }), abreC = c => go({ nome: 'solicitacoes', sup: { filtro: 'vez', q: '', sel: c.id } });
  const linha = (titulo, meta, direita, onclick) => h('div', { class: 'lin-ativ', tabindex: 0, role: 'button', onclick, onkeydown: e => e.key === 'Enter' && onclick() }, h('div', { class: 'grow' }, h('b', {}, titulo), h('div', { class: 'muted small' }, meta)), h('div', { class: 'ativ-dir' }, direita));
  const tarefa = (i, extra, chips) => linha(i.tarefa, `${i.projeto}${i.empresa ? ' · ' + i.empresa : ''} · ${i.responsavel || 'sem responsável'} · até ${fmt(i.fim)}${extra ? ' · ' + extra : ''}`, chips || null, () => abreT(i));
  const secoes = [
    ['Chamados para responder', 'A vez é da equipe. O mais urgente (SLA) vem primeiro.', f.chamados, c => linha(c.assunto, `${c.protocolo} · ${c.cliente}${c.empresa ? ' · ' + c.empresa : ''}${c.responsavel ? ' · ' + c.responsavel.nome : ' · sem responsável'} · ${rel(c.atualizadoEm)}`, [slaChip(c.sla), chip(c.prioridade === 'urgente' || c.prioridade === 'alta' ? 'vermelho' : 'amarelo', PRIOS[c.prioridade])], () => abreC(c))],
    ['O cliente respondeu', 'Você pediu uma informação e o cliente respondeu. Falta a equipe agir.', f.clienteRespondeu, i => tarefa(i, `respondeu ${rel(i.respondidoEm)}`, chip('verde', 'Respondeu'))],
    ['Ajustes pedidos pelo cliente', 'O cliente não aprovou a entrega e pediu mudanças.', f.ajustes, i => tarefa(i, `“${i.comentario}”`, chip('vermelho', 'Ajustes'))],
    ['Atrasadas', 'Atividades com o término vencido.', f.atrasadas, i => tarefa(i, '', chip('vermelho', `${i.diasAtraso} dia(s) de atraso`))],
    ['Vencem nos próximos 7 dias', 'Atenção ao prazo.', f.vencemEm7, i => tarefa(i, '', chip(i.status.cor, `${i.progresso}%`))],
    ['Aguardando o cliente', 'Pedimos algo ao cliente e ele ainda não respondeu.', f.aguardandoCliente, i => tarefa(i, i.pedido, chip('amarelo', 'Aguardando'))],
    ['Aguardando aprovação do cliente', 'Entregas enviadas para aprovação.', f.aguardandoAprovacao, i => tarefa(i, `enviada ${rel(i.desde)}`, chip('amarelo', 'Aguardando aprovação'))]];
  juntar(m, h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Minha fila'), h('label', { class: 'nota-chk', style: 'font-weight:500' }, h('input', { type: 'checkbox', style: 'width:auto', checked: st.meus, onchange: e => { st.meus = e.target.checked; render(); } }), 'Só os meus')),
    h('p', { class: 'muted', style: 'margin:4px 0 14px' }, st.meus ? 'Só o que é seu: chamados em que você é o responsável e atividades com o seu nome.' : 'Tudo o que pede ação da equipe, em todos os projetos.'),
    h('div', { class: 'kpis' }, [['Chamados para responder', f.chamados.length], ['Cliente respondeu', f.clienteRespondeu.length], ['Ajustes pedidos', f.ajustes.length], ['Atrasadas', f.atrasadas.length], ['Vencem em 7 dias', f.vencemEm7.length]].map(([tt, n]) => h('div', { class: 'card kpi' }, h('span', { class: 'muted small' }, tt), h('b', {}, n)))));
  const ativas = secoes.filter(s => s[2].length); if (!ativas.length) return juntar(m, h('div', { class: 'card vazio' }, h('b', {}, 'Tudo em dia.'), h('div', { class: 'muted' }, 'Nada pendente para a equipe no momento.')));
  for (const [titulo, sub, itens, render1] of ativas) juntar(m, h('div', { class: 'card grupo-ativ' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, `${titulo} `, h('span', { class: 'muted small' }, `(${itens.length})`))), h('p', { class: 'muted small', style: 'margin:0 0 4px' }, sub), itens.map(render1)));
}

