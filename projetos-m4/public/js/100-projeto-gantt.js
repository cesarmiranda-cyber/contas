// ---------- projeto + gantt ----------

const PRIO = { baixa: 'Baixa', media: 'Média', alta: 'Alta' };
const brl = v => v == null || v === '' ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function ficha(p) {
  const eq = U.tipo === 'equipe';
  const prazo = p.fimPrevisto ? (p.desvioDias == null ? fmt(p.fimPrevisto) : h('span', {}, fmt(p.fimPrevisto), ' ', p.desvioDias > 0 ? chip(p.desvioDias > 7 ? 'vermelho' : 'amarelo', `previsão ${p.desvioDias} dia(s) além`) : chip('verde', 'previsão dentro do prazo'))) : '';
  const itens = [['Calendário', p.diasUteis ? 'Dias úteis (seg–sex, sem feriados)' : ''], ['Código', p.codigo], ['Tipo', p.tipo], ['Prioridade', PRIO[p.prioridade]], ['Empresa', p.empresa], ['Gerente do projeto', p.gerente],
    ['Contato do cliente', [p.contatoNome, p.contatoEmail, p.contatoTelefone].filter(Boolean).join(' · ')], ['Início previsto', fmt(p.inicioPrevisto)], ['Término contratado', prazo],
    ['Pasta de documentos', p.link ? h('a', { href: p.link, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir link') : ''],
    ...(eq ? [['Valor do projeto (interno)', brl(p.valor)], ['Negócio no Bitrix24', p.negocioBitrix ? '#' + p.negocioBitrix : ''], ['Clientes com acesso', p.clientes.map(c => c.nome).join(', ') || 'nenhum'], ['Acessos do cliente ao projeto', (p.acessosClientes || []).map(a => a.ultimo ? `${a.nome}: último acesso ${fmtTs(a.ultimo)} (${a.total} visita(s))` : `${a.nome}: ainda não acessou`).join(' · ')]] : [])].filter(x => x[1]);
  return h('div', { class: 'card ficha' }, h('h3', {}, 'Dados do projeto'),
    p.descricao && h('p', { class: 'escopo' }, h('span', { class: 'muted small' }, 'Objetivo e escopo'), h('br'), p.descricao),
    h('dl', {}, itens.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
    eq && p.obsInternas && h('p', { class: 'obs' }, h('span', { class: 'muted small' }, 'Observações internas (o cliente não vê)'), h('br'), p.obsInternas));
}
const SITUACAO = { pausado: 'Projeto pausado', concluido: 'Projeto concluído' };
function listaCliente(p) {
  const concl = t => t.status.codigo === 'concluida'; const aprP = t => t.aprovacao && t.aprovacao.estado === 'pendente'; const grupos = [['Precisam de você', t => (t.aguardaCliente && !concl(t)) || aprP(t)], ['Em andamento', t => !concl(t) && !(t.aguardaCliente) && t.inicio <= p.hoje], ['Próximas', t => !concl(t) && !(t.aguardaCliente) && t.inicio > p.hoje], ['Concluídas', t => concl(t) && !aprP(t)]];
  const linha = t => h('div', { class: 'ativ', tabindex: 0, role: 'button', onclick: () => drawer(p, t), onkeydown: e => e.key === 'Enter' && drawer(p, t) }, h('i', { class: 'dot ' + t.status.cor }),
    h('div', { class: 'grow' }, h('b', {}, t.nome), h('div', { class: 'muted small' }, `${fmt(t.inicio)} → ${fmt(t.fim)}${t.responsavel ? ' · ' + t.responsavel : ''}`), h('div', { class: 'bar mini' }, h('i', { style: `width:${t.progresso}%` }))),
    h('div', { class: 'ativ-dir' }, chip(aprP(t) ? 'amarelo' : t.status.cor, aprP(t) ? 'Aguardando sua aprovação' : t.aprovacao && t.aprovacao.estado === 'aprovada' ? 'Entrega aprovada' : t.aguardaCliente && !concl(t) ? 'Aguardando você' : t.status.rotulo), h('span', { class: 'muted small' }, `${t.progresso}%${t.itens ? ` · ${t.itens} registro(s)` : ''}`)));
  return h('div', {}, grupos.map(([nome, f]) => { const l = p.tarefas.filter(f).sort((a, b) => a.inicio.localeCompare(b.inicio)); return l.length ? h('div', { class: 'card grupo-ativ' }, h('h3', {}, `${nome} `, h('span', { class: 'muted small' }, `(${l.length})`)), l.map(linha)) : null; }));
}
async function documentosProjeto(p) {
  const { documentos } = await api('GET', `/api/projetos/${p.id}/documentos`);
  if (!documentos.length) return h('div', { class: 'card vazio' }, 'Nenhum documento enviado ainda. Para enviar, abra uma atividade e use “Anexar documento”.');
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, `Documentos do projeto (${documentos.length})`)), documentos.map(d => h('div', { class: 'doc' }, h('span', { class: 'doc-ico' }, icone('doc')),
    h('div', { class: 'grow' }, h('a', { href: '/api/arquivos/' + d.id, download: d.nome }, d.nome), h('div', { class: 'muted small' }, `${Math.ceil(d.tamanho / 1024)} KB · na atividade `, h('a', { class: 'muted', style: 'cursor:pointer', onclick: () => { const t = p.tarefas.find(x => x.id === d.tarefaId); if (t) drawer(p, t); } }, d.tarefa))),
    h('div', { class: 'doc-dir' }, h('span', { class: 'chip-mini ' + d.tipoAutor }, d.tipoAutor === 'equipe' ? 'Equipe' : 'Cliente'), h('span', { class: 'muted small' }, `${d.autor} · ${fmtTs(d.ts)}`)))));
}
async function telaProjeto(m) {
  const { projeto: p } = await api('GET', '/api/projetos/' + view.id); const eq = U.tipo === 'equipe'; const aba = view.aba || (!eq && innerWidth < 760 ? 'lista' : 'gantt');
  const abertas = p.tarefas.filter(t => t.status.codigo !== 'concluida'); const proxima = abertas.slice().sort((a, b) => a.fim.localeCompare(b.fim))[0]; const aprPend = t => t.aprovacao && t.aprovacao.estado === 'pendente'; const pend = p.tarefas.filter(t => (t.aguardaCliente && t.progresso < 100) || aprPend(t));
  const fato = (rot, v) => v ? h('div', { class: 'fato' }, h('span', { class: 'muted small' }, rot), h('b', {}, v)) : null;
  const prazo = p.resumo.fim ? h('span', {}, fmt(p.resumo.fim), p.desvioDias > 0 ? [' ', chip(p.desvioDias > 7 ? 'vermelho' : 'amarelo', `${p.desvioDias} dia(s) além do contratado`)] : p.desvioDias != null ? [' ', chip('verde', 'dentro do prazo')] : null) : null;
  juntar(m, h('section', { class: 'card proj-hero' }, h('div', { class: 'row' }, h('a', { class: 'btn sm', onclick: () => go({ nome: 'projetos' }) }, '← Projetos'), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm sem-print', onclick: () => window.print() }, 'Imprimir / PDF'), eq && p.tarefas.length > 0 && h('button', { class: 'btn sm', onclick: () => modalSalvarModelo(p) }, 'Salvar como modelo'), eq && h('button', { class: 'btn sm', onclick: () => modalProjeto(p) }, 'Editar projeto'), eq && p.tarefas.some(t => t.interna) && h('button', { class: 'btn sm', title: 'Hoje o cliente só vê as atividades marcadas como visíveis', onclick: async () => { const n = p.tarefas.filter(t => t.interna).length; if (!confirm(`Mostrar ao cliente as ${n} atividade(s) ocultas deste projeto?`)) return; await api('POST', `/api/projetos/${p.id}/publicar`, { visivel: true }); toast('Atividades publicadas ao cliente.'); render(); } }, `👁 Mostrar ao cliente (${p.tarefas.filter(t => t.interna).length} oculta${p.tarefas.filter(t => t.interna).length > 1 ? 's' : ''})`), eq && h('button', { class: 'btn pri sm', onclick: () => modalTarefa(p) }, '+ Atividade')),
    h('div', { class: 'ph-corpo' }, anel(p.resumo.progresso), h('div', { class: 'grow' }, h('h1', {}, p.nome), h('p', { class: 'muted', style: 'margin:2px 0 8px' }, [p.codigo, p.tipo, p.empresa].filter(Boolean).join(' · ') || 'Projeto Manda4'),
      h('div', { class: 'ac-chips' }, chip(p.resumo.cor, COR[p.resumo.cor]), SITUACAO[p.situacao] && chip('amarelo', SITUACAO[p.situacao]), contaChips(p.resumo)))),
    h('div', { class: 'ph-fatos' }, fato('Previsão de término', prazo), fato('Término contratado', fmt(p.fimPrevisto)), fato('Atividades concluídas', `${p.resumo.concluidas} de ${p.resumo.total}`), fato('Próxima entrega', proxima ? `${proxima.nome} · ${fmt(proxima.fim)}` : null), fato('Gerente', p.gerente))),
    h('p', { class: 'so-print' }, `Relatório do projeto ${p.codigo || ''} · gerado em ${fmtTs(new Date().toISOString())} · Manda4 Projetos e Suporte`),
    p.resumo.total > 0 && p.resumo.concluidas === p.resumo.total && h('div', { class: 'parabens' }, h('b', {}, 'Projeto concluído! '), 'Obrigado pela parceria. ', !eq && h('a', { onclick: () => go({ nome: 'solicitacoes' }) }, 'Precisa de algo? Abra um chamado →')),
    pend.length > 0 && h('div', { class: 'card precisa' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, eq ? 'Aguardando o cliente' : 'Precisamos de você neste projeto'), chip('amarelo', `${pend.length} pendência(s)`)),
      pend.map(t => h('div', { class: 'pend' }, h('div', { class: 'grow' }, h('b', {}, t.nome), h('div', { class: 'muted small' }, `até ${fmt(t.fim)}`), h('p', { style: 'margin:6px 0 0' }, aprPend(t) ? 'Esta entrega aguarda a aprovação do cliente.' : t.pedido || 'A equipe aguarda o retorno do cliente.')), t.respondidoEm && !aprPend(t) ? chip('verde', eq ? 'Cliente respondeu' : 'Você respondeu') : null,
        h('button', { class: 'btn pri sm', onclick: () => drawer(p, t) }, eq ? 'Abrir' : aprPend(t) ? 'Revisar e aprovar' : t.respondidoEm ? 'Ver conversa' : 'Responder')))));
  const tabs = h('div', { class: 'tabs' }, [['gantt', 'Cronograma'], ['lista', 'Atividades'], ['docs', 'Documentos'], ['dados', 'Dados do projeto'], ['relatorios', 'Relatórios'], ['historico', 'Histórico']].map(([k, tt]) => h('a', { class: aba === k ? 'on' : '', onclick: () => { view.aba = k; render(); } }, tt)));
  if (view.abrir) { const t0 = p.tarefas.find(x => x.id === view.abrir); view.abrir = null; if (t0) setTimeout(() => drawer(p, t0), 50); }
  juntar(m, tabs);
  if (aba === 'relatorios') { if (view.relSemana) m.classList.add('relatorio-aberto'); return juntar(m, await relatoriosProjeto(p)); }
  if (aba === 'historico') return juntar(m, await historicoProjeto(p)); if (aba === 'docs') return juntar(m, await documentosProjeto(p)); if (aba === 'dados') return juntar(m, ficha(p));
  if (!p.tarefas.length) return juntar(m, h('div', { class: 'card vazio' }, 'Nenhuma atividade cadastrada ainda.'));
  if (aba === 'gantt') juntar(m, h('div', { class: 'legenda small' }, h('span', { class: 'chip verde' }, 'No prazo'), h('span', { class: 'chip amarelo' }, 'Alerta'), h('span', { class: 'chip vermelho' }, 'Atrasado'), h('span', { class: 'muted' }, eq ? 'Arraste o bloco para mover as datas · arraste as pontas para mudar início/término · arraste do círculo de uma atividade até outra para criar a dependência · clique na seta para remover' : 'Passe o mouse para detalhes · clique para abrir · para pedir mudança de prazo, abra a atividade')), gantt(p));
  else if (!eq) juntar(m, listaCliente(p));
  else juntar(m, h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['Atividade', 'Início', 'Término', '%', 'Responsável', 'Status', ''].map(x => h('th', {}, x)))),
    h('tbody', {}, p.tarefas.map(t => h('tr', { style: 'cursor:pointer', onclick: () => drawer(p, t) }, h('td', {}, t.nome, t.interna && h('span', { class: 'muted small' }, ' (oculta ao cliente)')), h('td', {}, fmt(t.inicio)), h('td', {}, fmt(t.fim)), h('td', {}, t.progresso + '%'), h('td', {}, t.responsavel || '—'),
      h('td', {}, chip(t.status.cor, t.status.rotulo), t.aguardaCliente && t.progresso < 100 && h('div', {}, chip('amarelo', t.respondidoEm ? 'Cliente respondeu' : 'Aguardando cliente'))), h('td', {}, h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); modalTarefa(p, t); } }, 'Editar'))))))));
}
function gantt(p) {
  const eq = U.tipo === 'equipe';
  const ts = [...p.tarefas].sort((a, b) => a.inicio.localeCompare(b.inicio) || a.fim.localeCompare(b.fim)); const RH = 44, DW = view.dw || 26;
  const min = Math.min(...ts.map(t => ms(t.inicio)), ms(p.hoje)) - 3 * DAY, max = Math.max(...ts.map(t => ms(t.fim)), ms(p.hoje)) + 10 * DAY;
  const dias = Math.round((max - min) / DAY) + 1, W = dias * DW, x = s => Math.round((ms(s) - min) / DAY) * DW;
  const cv = h('div', { class: 'g-canvas', style: `width:${W}px;height:${48 + ts.length * RH}px` });
  let mesAtual = '';
  for (let i = 0; i < dias; i++) {
    const d = new Date(min + i * DAY), s = iso(min + i * DAY), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) juntar(cv, h('div', { class: 'g-fds', style: `left:${i * DW}px;width:${DW}px` })); else if (p.diasUteis && (p.feriados || []).includes(s)) juntar(cv, h('div', { class: 'g-fds g-fer', title: 'Feriado', style: `left:${i * DW}px;width:${DW}px` }));
    if (DW >= 18 || d.getUTCDate() === 1 || dow === 1) juntar(cv, h('div', { class: 'g-dia', style: `left:${i * DW}px;width:${DW}px` }, DW >= 18 || dow === 1 ? d.getUTCDate() : ''));
    const mk = s.slice(0, 7); if (mk !== mesAtual) { mesAtual = mk; juntar(cv, h('div', { class: 'g-mes', style: `left:${i * DW}px` }, d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }))); }
  }
  ts.forEach((t, i) => juntar(cv, h('div', { class: 'g-lin', style: `top:${48 + i * RH}px` })));
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'g-svg'); svg.setAttribute('width', W); svg.setAttribute('height', 48 + ts.length * RH);
  svg.innerHTML = '<defs><marker id="ar" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="#7d8aa8"/></marker></defs>';
  const pos = new Map(ts.map((t, i) => [t.id, { i, l: x(t.inicio), r: x(t.fim) + DW }]));
  for (const t of ts) for (const d of t.deps || []) {
    const a = pos.get(d.de), b = pos.get(t.id); if (!a) continue; const ya = 48 + a.i * RH + RH / 2, yb = 48 + b.i * RH + RH / 2;
    const [x1, x2] = d.tipo === 'SS' ? [a.l, b.l] : [a.r, b.l]; const mx = d.tipo === 'SS' ? Math.min(x1, x2) - 10 : x1 + 8;
    const path = document.createElementNS(NS, 'path'); path.setAttribute('d', `M${x1},${ya} H${mx} V${yb} H${x2 - 1}`); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#7d8aa8'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('marker-end', 'url(#ar)'); svg.append(path);
    if (eq && d.lag) { const tx = document.createElementNS(NS, 'text'); tx.setAttribute('x', Math.max(x1, x2 - 8)); tx.setAttribute('y', yb - 5); tx.setAttribute('text-anchor', 'end'); tx.setAttribute('class', 'dep-lag'); tx.textContent = `${d.lag > 0 ? '+' : ''}${d.lag}d`; svg.append(tx); }
    if (eq) { const hit = document.createElementNS(NS, 'path'); hit.setAttribute('d', path.getAttribute('d')); hit.setAttribute('class', 'dep-hit'); hit.style.pointerEvents = 'stroke'; hit.setAttribute('role', 'button'); hit.setAttribute('aria-label', 'Dependência: clique para alterar ou remover');
      const tit = document.createElementNS(NS, 'title'); tit.textContent = `${ts.find(y => y.id === d.de) ? ts.find(y => y.id === d.de).nome : ''} → ${t.nome} · ${d.tipo === 'SS' ? 'começam juntas' : 'termina → começa'}${d.lag ? `, defasagem ${d.lag > 0 ? '+' : ''}${d.lag} dia(s)` : ''}. Clique para alterar ou remover.`; hit.append(tit); hit.addEventListener('click', () => menuDep(p, ts.find(y => y.id === d.de), t, d)); svg.append(hit); }
  }
  juntar(cv, svg, h('div', { class: 'g-hoje', style: `left:${x(p.hoje) + DW / 2}px` }));
  for (const t of ts) {
    const i = pos.get(t.id).i, w = Math.max(DW, x(t.fim) + DW - x(t.inicio));
    const b = h('div', { class: 'g-bloco ' + t.status.cor + ((t.aguardaCliente && t.progresso < 100) || (t.aprovacao && t.aprovacao.estado === 'pendente') ? ' aguarda' : '') + (t.aprovacao && t.aprovacao.estado === 'aprovada' ? ' aprovada' : ''), style: `left:${x(t.inicio)}px;width:${w - 2}px;top:${48 + i * RH + 9}px`, tabindex: 0, role: 'button', 'aria-label': `${t.nome}: ${t.status.rotulo}`, onclick: eq ? undefined : () => drawer(p, t), onkeydown: e => e.key === 'Enter' && drawer(p, t) },
      h('div', { class: 'miolo' }, h('div', { class: 'pg', style: `width:${t.progresso}%` }), h('span', {}, w > 90 ? `${t.nome}` : '')), eq && h('i', { class: 'alca esq', title: 'Arraste para mudar o início' }), eq && h('i', { class: 'alca dir', title: 'Arraste para mudar o término' }),
      eq && h('i', { class: 'cx ini', title: 'Arraste até outra atividade: as duas começam juntas' }), eq && h('i', { class: 'cx fim', title: 'Arraste até outra atividade: ela só começa quando esta terminar' }));
    b.dataset.id = t.id;
    if (eq) { arrasto(b, t, p, DW); for (const cx of b.querySelectorAll('.cx')) conecta(cx, b, t, p, cv, svg, NS); }
    b.addEventListener('mousemove', e => { if (!arrastando) tip(e, t); }); b.addEventListener('mouseleave', () => $tip.hidden = true); b.addEventListener('focus', () => { const r = b.getBoundingClientRect(); tip({ clientX: r.left, clientY: r.bottom }, t); }); b.addEventListener('blur', () => $tip.hidden = true);
    juntar(cv, b);
  }
  const nomes = h('div', { class: 'g-nomes' }, h('div', { class: 'g-head' }, h('select', { style: 'width:auto;padding:3px 6px;font-size:12px', onchange: e => { view.dw = +e.target.value; view.scrollX = null; render(); } }, [[26, 'Dias'], [10, 'Semanas'], [4, 'Meses']].map(([v, t]) => h('option', { value: v, selected: v === DW }, t)))),
    ts.map(t => h('div', { class: 'g-nome', title: t.nome, onclick: () => drawer(p, t) }, h('i', { class: 'dot ' + t.status.cor }), h('span', {}, t.nome))));
  const sc = h('div', { class: 'g-scroll' }, cv); setTimeout(() => { sc.scrollLeft = view.scrollX != null ? view.scrollX : Math.max(0, x(p.hoje) - 160); sc.addEventListener('scroll', () => { view.scrollX = sc.scrollLeft; }); }, 0); // mantém a posição após cada ajuste
  return h('div', { class: 'gantt' }, nomes, sc);
}
// Salva datas/campos de uma atividade. Se as dependências impedem a data pedida, explica o motivo e deixa escolher o que fazer.
async function patchTarefa(t, body) {
  try { const r = await api('PATCH', '/api/tarefas/' + t.id, body); avisaAjustes(r.ajustes); return true; }
  catch (e) {
    if (!(e.dados && e.dados.codigo === 'BLOQUEADA_POR_DEPENDENCIA')) throw e;
    const modo = await dialogoBloqueio(t, body, e.dados); if (!modo) return false;
    const r = await api('PATCH', '/api/tarefas/' + t.id, { ...body, dependencia: modo }); avisaAjustes(r.ajustes); if (modo === 'defasagem') toast('Data mantida. A defasagem da dependência foi ajustada.', 5000); return true;
  }
}
function dialogoBloqueio(t, pedido, d) {
  return new Promise(resolve => {
    const v = overlay(true); let resolvido = false; const fim = x => { if (resolvido) return; resolvido = true; v.remove(); resolve(x); }; v.addEventListener('mousedown', e => { if (e.target === v) fim(null); });
    const sinal = n => (n > 0 ? '+' : '') + n; const novaLag = m => Math.round((Date.parse(pedido.inicio) - Date.parse(m.base)) / DAY);
    const opcao = (rot, desc, cls, modo) => h('button', { class: 'opcao ' + cls, onclick: () => fim(modo) }, h('b', {}, rot), h('span', { class: 'small' }, desc));
    juntar(v, h('div', { class: 'modal', style: 'max-width:580px' }, h('h2', {}, 'Esta atividade depende de outra'),
      h('p', {}, `“${t.nome}” não pode começar em `, h('b', {}, fmt(pedido.inicio)), '. A data mais cedo permitida é ', h('b', {}, fmt(d.minimo)), ', porque:'),
      h('ul', { class: 'diff' }, d.motivos.map(m => h('li', {}, `depende de “${m.nome}” (${m.tipo === 'SS' ? 'começam juntas' : 'só começa quando termina'}; ${m.tipo === 'SS' ? 'a anterior começa' : 'a anterior termina'} em ${fmt(m.tipo === 'SS' ? m.predInicio : m.predFim)}) com defasagem de `, h('b', {}, `${sinal(m.lag)} dia(s)`), '.'))),
      h('p', { class: 'muted small' }, 'O que você quer fazer?'),
      h('div', { class: 'opcoes' },
        opcao(`Começar em ${fmt(pedido.inicio)} mesmo assim`, `A dependência continua, com defasagem de ${d.motivos.map(m => sinal(novaLag(m)) + ' dia(s)').join(' e ')}.`, 'pri', 'defasagem'),
        opcao('Remover a dependência', 'A atividade fica livre para ser movida.', '', 'remover'),
        opcao(`Começar em ${fmt(d.minimo)}`, 'Respeita a dependência como está.', '', 'empurrar'),
        h('button', { class: 'btn', onclick: () => fim(null) }, 'Cancelar'))));
  });
}
// Calendário do projeto no navegador: dias corridos, ou dias úteis (seg–sex, sem os feriados que o servidor envia).
function calCli(p) {
  const fer = new Set((p && p.feriados) || []), ativo = !!(p && p.diasUteis); const dow = s => new Date(ms(s)).getUTCDay();
  const util = s => !ativo || (dow(s) !== 0 && dow(s) !== 6 && !fer.has(s)), prox = s => { while (!util(s)) s = somaDias(s, 1); return s; }, ant = s => { while (!util(s)) s = somaDias(s, -1); return s; };
  const soma = (s, n) => { if (!ativo) return somaDias(s, n); let d = n >= 0 ? prox(s) : ant(s), k = Math.abs(n); const passo = n >= 0 ? 1 : -1; while (k > 0) { d = somaDias(d, passo); if (util(d)) k--; } return d; };
  const dif = (a, b) => { if (!ativo) return Math.round((ms(b) - ms(a)) / DAY); if (a === b) return 0; const [x, y, sg] = b > a ? [a, b, 1] : [b, a, -1]; let n = 0; for (let d = somaDias(x, 1); d <= y; d = somaDias(d, 1)) if (util(d)) n++; return sg * n; };
  return { ativo, util, prox, ant, soma, dif, fer };
}
let arrastando = false;
// Cria dependência arrastando do círculo de uma atividade até outra: círculo do fim = a outra só começa quando esta terminar; círculo do início = começam juntas.
function conecta(cx, b, t, p, cv, svg, NS) {
  cx.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return; ev.preventDefault(); ev.stopPropagation(); const origem = cx.classList.contains('fim') ? 'fim' : 'ini';
    arrastando = true; $tip.hidden = true; cx.setPointerCapture(ev.pointerId); cv.classList.add('conectando');
    const rc = cv.getBoundingClientRect(), bb = b.getBoundingClientRect(), x1 = (origem === 'fim' ? bb.right : bb.left) - rc.left, y1 = bb.top + bb.height / 2 - rc.top;
    const linha = document.createElementNS(NS, 'path'); linha.setAttribute('class', 'dep-nova'); svg.append(linha); let alvo = null;
    const mover = e => {
      const x2 = e.clientX - rc.left, y2 = e.clientY - rc.top; linha.setAttribute('d', `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`);
      const el = document.elementFromPoint(e.clientX, e.clientY), nb = el && el.closest ? el.closest('.g-bloco') : null, novo = nb && nb.dataset.id !== t.id ? nb : null;
      if (novo !== alvo) { if (alvo) alvo.classList.remove('alvo'); alvo = novo; if (alvo) alvo.classList.add('alvo'); }
      $tip.replaceChildren(h('b', {}, alvo ? 'Solte para criar a dependência' : origem === 'fim' ? 'Solte sobre a atividade que só começa depois desta terminar' : 'Solte sobre a atividade que começa junto com esta')); $tip.hidden = false;
      $tip.style.left = Math.min(e.clientX + 14, innerWidth - $tip.offsetWidth - 8) + 'px'; $tip.style.top = Math.min(e.clientY + 18, innerHeight - $tip.offsetHeight - 8) + 'px';
    };
    const limpa = () => { cx.removeEventListener('pointermove', mover); cx.removeEventListener('pointerup', solta); cx.removeEventListener('pointercancel', cancela); linha.remove(); cv.classList.remove('conectando'); if (alvo) alvo.classList.remove('alvo'); $tip.hidden = true; arrastando = false; };
    const cancela = () => limpa();
    const solta = async () => {
      const dest = alvo; limpa(); if (!dest) return; const suc = p.tarefas.find(y => y.id === dest.dataset.id); if (!suc) return;
      const tipo = origem === 'fim' ? 'FS' : 'SS', deps = (suc.deps || []).map(d => ({ ...d })), ja = deps.find(d => d.de === t.id);
      if (ja && ja.tipo === tipo) return toast(`“${suc.nome}” já depende de “${t.nome}” desse jeito.`);
      if (ja) ja.tipo = tipo; else deps.push({ de: t.id, tipo, lag: 0 });
      try { const r = await api('PATCH', '/api/tarefas/' + suc.id, { deps }); toast(`${tipo === 'FS' ? `“${suc.nome}” só começa quando “${t.nome}” terminar.` : `“${suc.nome}” começa junto com “${t.nome}”.`}`, 5000); avisaAjustes(r.ajustes); } catch (err) { toast(err.message, 6000); } render();
    };
    cx.addEventListener('pointermove', mover); cx.addEventListener('pointerup', solta); cx.addEventListener('pointercancel', cancela);
  });
}
// Clicar na seta: trocar o tipo, ajustar a defasagem ou remover a dependência.
function menuDep(p, pred, suc, dep) {
  if (!pred || !suc) return; const v = overlay(true), err = h('div'); const lag = h('input', { type: 'number', value: dep.lag || 0, style: 'width:90px' });
  const salva = async novas => { try { const r = await api('PATCH', '/api/tarefas/' + suc.id, { deps: novas }); v.remove(); avisaAjustes(r.ajustes); render(); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); } };
  const outras = (suc.deps || []).filter(d => d.de !== dep.de).map(d => ({ ...d }));
  juntar(v, h('div', { class: 'modal', style: 'max-width:480px' }, h('h2', {}, 'Dependência'), h('p', {}, h('b', {}, pred.nome), ' → ', h('b', {}, suc.nome)),
    h('p', { class: 'muted' }, dep.tipo === 'SS' ? 'As duas começam juntas.' : `“${suc.nome}” só começa quando “${pred.nome}” terminar.`),
    h('label', {}, 'Defasagem em dias (positivo = espera mais; negativo = adianta)'), lag, err,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri sm', onclick: () => salva([...outras, { de: dep.de, tipo: dep.tipo, lag: Math.round(+lag.value) || 0 }]) }, 'Salvar defasagem'),
      h('button', { class: 'btn sm', onclick: () => salva([...outras, { de: dep.de, tipo: dep.tipo === 'SS' ? 'FS' : 'SS', lag: Math.round(+lag.value) || 0 }]) }, dep.tipo === 'SS' ? 'Mudar para “termina → começa”' : 'Mudar para “começam juntas”'),
      h('button', { class: 'btn sm perigo', onclick: () => salva(outras) }, 'Remover dependência'), h('button', { class: 'btn sm', onclick: () => v.remove() }, 'Fechar'))));
}
const somaDias = (s, n) => iso(ms(s) + n * DAY);
// Arrastar (mover), ou puxar as pontas (início/término). Dia a dia; as dependências reagendam as seguintes.
function arrasto(b, t, p, DW) {
  b.classList.add('arrasta');
  const iniciar = ev => {
    if (ev.button !== 0) return; ev.preventDefault(); ev.stopPropagation();
    const modo = ev.target.classList.contains('esq') ? 'ini' : ev.target.classList.contains('dir') ? 'fim' : 'mover';
    const x0 = ev.clientX, l0 = parseFloat(b.style.left), w0 = parseFloat(b.style.width), dur = Math.round((ms(t.fim) - ms(t.inicio)) / DAY); let delta = 0, moveu = false;
    arrastando = true; $tip.hidden = true; b.setPointerCapture(ev.pointerId);
    const novas = () => modo === 'mover' ? [somaDias(t.inicio, delta), somaDias(t.fim, delta)] : modo === 'ini' ? [somaDias(t.inicio, delta), t.fim] : [t.inicio, somaDias(t.fim, delta)];
    const volta = () => { b.style.left = l0 + 'px'; b.style.width = w0 + 'px'; };
    const mover = e => {
      const dx = e.clientX - x0; if (!moveu && Math.abs(dx) < 4) return; moveu = true;
      delta = Math.round(dx / DW); if (modo === 'ini') delta = Math.min(delta, dur); if (modo === 'fim') delta = Math.max(delta, -dur);
      if (modo === 'mover') b.style.left = (l0 + delta * DW) + 'px'; else if (modo === 'ini') { b.style.left = (l0 + delta * DW) + 'px'; b.style.width = (w0 - delta * DW) + 'px'; } else b.style.width = (w0 + delta * DW) + 'px';
      const [i, f] = novas(); $tip.replaceChildren(h('b', {}, `${fmt(i)} → ${fmt(f)}`), h('div', {}, `${Math.round((ms(f) - ms(i)) / DAY) + 1} dia(s)`)); $tip.hidden = false;
      $tip.style.left = Math.min(e.clientX + 14, innerWidth - $tip.offsetWidth - 8) + 'px'; $tip.style.top = Math.min(e.clientY + 18, innerHeight - $tip.offsetHeight - 8) + 'px';
    };
    const limpa = () => { b.removeEventListener('pointermove', mover); b.removeEventListener('pointerup', solta); b.removeEventListener('pointercancel', cancela); $tip.hidden = true; arrastando = false; };
    const cancela = () => { limpa(); volta(); };
    const solta = async () => {
      limpa(); if (!moveu) return drawer(p, t); if (delta === 0) return volta();
      const [i, f] = novas(); try { await patchTarefa(t, { inicio: i, fim: f }); } catch (err) { toast(err.message, 6000); } render();
    };
    b.addEventListener('pointermove', mover); b.addEventListener('pointerup', solta); b.addEventListener('pointercancel', cancela);
  };
  // as alças têm ouvinte próprio: no toque o navegador escolhe o alvo mais próximo que tenha ouvinte (senão o círculo de dependência ganharia)
  b.addEventListener('pointerdown', iniciar); for (const al of b.querySelectorAll('.alca')) al.addEventListener('pointerdown', iniciar);
}
function tip(e, t) {
  $tip.replaceChildren(h('b', {}, t.nome), chip(t.status.cor, t.status.rotulo), t.aguardaCliente && t.progresso < 100 && h('div', { style: 'margin-top:4px;color:#ffd33d' }, (U.tipo === 'equipe' ? 'Aguardando o cliente: ' : 'Aguardando você: ') + (t.pedido || 'retorno pendente')), h('div', {}, `${fmt(t.inicio)} → ${fmt(t.fim)} · ${t.progresso}%`), h('div', {}, 'Quem está trabalhando: ' + (t.responsavel || 'a definir')), t.itens ? h('div', {}, `${t.itens} registro(s) · clique para abrir`) : h('div', {}, 'Clique para abrir'));
  $tip.hidden = false; const w = $tip.offsetWidth; $tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px'; $tip.style.top = Math.min(e.clientY + 14, innerHeight - $tip.offsetHeight - 8) + 'px';
}

