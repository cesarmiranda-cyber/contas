// ---------- início do cliente: acesso direto a Projetos e Suporte ----------
async function telaInicio(m) {
  const ini = await api('GET', '/api/inicio'); const pj = ini.projetos, sp = ini.suporte; const abre = i => go({ nome: 'projeto', id: i.projetoId, abrir: i.tarefaId });
  const lin = (i, extra) => h('div', { class: 'lin-ativ', tabindex: 0, role: 'button', onclick: () => abre(i), onkeydown: e => e.key === 'Enter' && abre(i) }, h('i', { class: 'dot ' + i.status.cor }), h('div', { class: 'grow' }, h('b', {}, i.tarefa), h('div', { class: 'muted small' }, `${i.projeto} · ${extra}`)), h('span', { class: 'muted small' }, i.progresso + '%'));
  const cardProj = h('section', { class: 'card acesso' }, h('div', { class: 'ac-topo' }, h('span', { class: 'ac-ico azul' }, icone('projetos')), h('h2', { class: 'grow' }, 'Projetos'), pj.total === 0 && chip('amarelo', 'Aguardando ativação')),
    pj.total === 0 ? h('p', { class: 'muted' }, 'A equipe Manda4 vai vincular você ao seu projeto. Assim que for ativado, o cronograma e o status aparecem aqui.')
      : [h('div', { class: 'ac-num' }, h('b', {}, pj.progresso + '%'), h('span', { class: 'muted' }, ` concluído${pj.total > 1 ? ' em média' : ''} · ${pj.total} projeto(s)`)), h('div', { class: 'bar' }, h('i', { style: `width:${pj.progresso}%` })), h('div', { class: 'ac-chips' }, contaChips(pj)),
        pj.proxima && h('p', { class: 'ac-prox' }, h('span', { class: 'muted' }, pj.proxima.atrasada ? 'Em atraso: ' : 'Próxima entrega: '), h('b', {}, pj.proxima.tarefa), h('span', { class: 'muted' }, ` · ${pj.proxima.projeto} · até ${fmt(pj.proxima.fim)}`))],
    pj.total > 0 && h('div', { class: 'ac-cta' }, h('button', { class: 'btn pri', onclick: () => pj.unicoId ? go({ nome: 'projeto', id: pj.unicoId }) : go({ nome: 'projetos' }) }, pj.unicoId ? 'Abrir projeto →' : 'Abrir projetos →')));
  const cardSup = h('section', { class: 'card acesso' }, h('div', { class: 'ac-topo' }, h('span', { class: 'ac-ico laranja' }, icone('suporte')), h('h2', { class: 'grow' }, 'Suporte'), sp.aguardandoVoce > 0 && chip('amarelo', `${sp.aguardandoVoce} aguardando você`)),
    h('div', { class: 'ac-num' }, h('b', {}, sp.abertos), h('span', { class: 'muted' }, ` chamado(s) em aberto${sp.total ? ` · ${sp.total} no total` : ''}`)),
    sp.ultimo ? h('p', { class: 'ac-prox' }, h('span', { class: 'muted' }, 'Último: '), h('b', {}, `${sp.ultimo.protocolo} · ${sp.ultimo.assunto}`), h('span', { class: 'muted' }, ` · ${sp.ultimo.aberto ? sp.ultimo.etapa || 'em atendimento' : 'concluído'} · ${rel(sp.ultimo.atualizadoEm)}`)) : h('p', { class: 'muted' }, 'Dúvida, problema ou precisa de algo? Abra um chamado e a equipe Manda4 responde por aqui.'),
    h('div', { class: 'ac-cta' }, h('button', { class: 'btn pri', onclick: () => novaSolic() }, 'Abrir chamado'), sp.total > 0 && h('button', { class: 'btn', onclick: () => go({ nome: 'solicitacoes' }) }, 'Ver chamados')));
  juntar(m, h('section', { class: 'hero-cli' }, h('p', { class: 'eyebrow' }, U.empresa || 'Área do cliente'), h('h1', {}, `${saudacao()}, `, h('em', {}, primeiroNome(U.nome)), '.'), h('p', { class: 'sub' }, SUPORTE ? 'Acompanhe os seus projetos e fale com o suporte da Manda4.' : 'Acompanhe o andamento dos seus projetos com a Manda4.')),
    h('div', { class: 'acessos' }, cardProj, SUPORTE && cardSup));
  if (pj.total === 0) return espera(m);
  const pend = [...ini.aprovacoes.map(i => ({ ...i, _apr: true, pedido: 'Esta entrega está pronta e aguarda a sua aprovação.' })), ...ini.pendencias];
  juntar(m, pend.length > 0 && h('div', { class: 'card precisa' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Precisamos de você'), chip('amarelo', `${pend.length} pendência(s)`)), h('p', { class: 'muted small' }, 'Estas atividades dependem de uma informação ou documento seu para continuar no prazo.'),
      pend.map(i => h('div', { class: 'pend' }, h('div', { class: 'grow' }, h('b', {}, i.tarefa), h('div', { class: 'muted small' }, `${i.projeto} · até ${fmt(i.fim)}`), h('p', { style: 'margin:6px 0 0' }, i.pedido || 'A equipe aguarda o seu retorno.')),
        i.respondidoEm ? chip('verde', 'Você respondeu') : null, h('button', { class: 'btn pri sm', onclick: () => abre(i) }, i._apr ? 'Revisar e aprovar' : i.respondidoEm ? 'Ver conversa' : 'Responder')))),
    (ini.agora.length || ini.proximas.length) > 0 && h('div', { class: 'duas' }, h('div', { class: 'card' }, h('h3', {}, 'Acontecendo agora'), ini.agora.length ? ini.agora.map(i => lin(i, `até ${fmt(i.fim)}`)) : h('p', { class: 'muted small' }, 'Nada em andamento no momento.')),
      h('div', { class: 'card' }, h('h3', {}, 'Próximas atividades'), ini.proximas.length ? ini.proximas.map(i => lin(i, `começa em ${fmt(i.inicio)}`)) : h('p', { class: 'muted small' }, 'Nenhuma nos próximos 14 dias.'))),
    ini.novidadesLista.length > 0 && h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'O que mudou recentemente'), h('button', { class: 'btn sm', onclick: () => abrirNovidades() }, 'Ver todas')),
      ini.novidadesLista.map(n => h('div', { class: 'novid' }, h('span', {}, n.texto, n.projeto && h('span', { class: 'muted small' }, ` · ${n.projeto}`)), h('span', { class: 'muted small' }, rel(n.ts))))));
}

async function telaProjetos(m) {
  const { projetos } = await api('GET', '/api/projetos'); const eq = U.tipo === 'equipe'; let painel = null;
  if (eq) painel = await api('GET', '/api/painel');
  if (!eq && !projetos.length) return espera(m);
  if (eq) juntar(m, h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Projetos'), h('button', { class: 'btn', onclick: () => modalModelos() }, 'Modelos'), h('button', { class: 'btn pri', onclick: () => modalProjeto() }, '+ Novo projeto')));
  else juntar(m, h('div', { class: 'ola' }, h('h1', {}, 'Meus projetos'), h('p', {}, `${projetos.length} projeto(s) com a Manda4. Clique em um para ver o cronograma, os documentos e o histórico.`)));
  if (painel) juntar(m, h('div', { class: 'kpis' }, [['Projetos', painel.projetos], ['No prazo', painel.verde], ['Em alerta', painel.amarelo], ['Atrasados', painel.vermelho], ['Chamados novos', painel.solicitacoesNovas], ['Clientes aguardando ativação', painel.aguardando], ['Satisfação média', painel.avaliacaoMedia ? `★ ${painel.avaliacaoMedia}` : '—']].map(([t, n]) => h('div', { class: 'card kpi' }, h('span', { class: 'muted small' }, t), h('b', {}, n)))));
  if (!projetos.length) return juntar(m, h('div', { class: 'card vazio' }, 'Nenhum projeto ainda. Crie o primeiro.'));
  juntar(m, h('div', { class: 'cards' }, projetos.map(p => h('div', { class: 'card click', onclick: () => go({ nome: 'projeto', id: p.id }) },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, p.nome), chip(p.resumo.cor, COR[p.resumo.cor])),
    h('p', { class: 'muted small', style: 'margin:2px 0 0' }, [p.codigo, p.tipo, p.empresa].filter(Boolean).join(' · ')),
    h('p', { class: 'muted' }, p.descricao || 'Sem descrição'), h('div', { class: 'bar' }, h('i', { style: `width:${p.resumo.progresso}%` })),
    h('div', { class: 'row small muted' }, h('span', { class: 'grow' }, `${p.resumo.progresso}% concluído · ${p.resumo.concluidas}/${p.resumo.total} atividades`), p.resumo.fim && h('span', {}, 'até ' + fmt(p.resumo.fim)))))));
}

