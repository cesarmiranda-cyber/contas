// ---------- suporte (chamados) ----------
const SOL = { nova: 'Nova', em_analise: 'Em análise', aprovada: 'Aprovada', recusada: 'Recusada', concluida: 'Concluída' };
const CATS = { duvida: 'Dúvida', problema: 'Problema / erro', mudanca: 'Solicitação de mudança', acesso: 'Acesso e usuários', financeiro: 'Financeiro', privacidade: 'Privacidade e dados (LGPD)', outro: 'Outro' };
const PRIOS = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
function toast(msg, ms = 4200) { const e = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(e); setTimeout(() => e.remove(), ms); }
// Explica quando as dependências mudaram datas (para não parecer que "não salvou").
function avisaAjustes(ajustes) { if (ajustes && ajustes.length) toast('Datas ajustadas pelas dependências: ' + ajustes.map(a => `${a.nome} (${fmt(a.inicio)} a ${fmt(a.fim)})`).join('; '), 9000); }
function trilha(s) {
  if (!s.historico.length) return null;
  return h('div', { class: 'trilha', role: 'list', 'aria-label': 'Andamento do chamado' }, s.historico.map((x, k) => h('div', { class: 'passo' + (k === s.historico.length - 1 ? ' atual' : ' feito'), role: 'listitem' }, h('i', {}), h('b', {}, x.etapa), h('span', { class: 'small muted' }, fmtTs(x.ts)))));
}
const slaChip = sla => {
  if (!sla) return null; const f = m => { const a = Math.abs(m); return a >= 60 ? `${Math.floor(a / 60)}h${String(a % 60).padStart(2, '0')}` : `${a} min`; };
  return { ok: () => chip('verde', `Responder em até ${f(sla.restanteMin)}`), vencendo: () => chip('amarelo', `SLA vence em ${f(sla.restanteMin)}`), estourado: () => chip('vermelho', `SLA estourado há ${f(sla.restanteMin)}`), cumprido: () => chip('verde', 'Respondido no prazo'), cumprido_atrasado: () => chip('amarelo', 'Respondido fora do prazo') }[sla.estado]?.() || null;
};
function controlesStaff(s, ctxS) {
  const resp = h('select', { onchange: e => api('PATCH', '/api/solicitacoes/' + s.id, { responsavel: e.target.value }).then(render) }, h('option', { value: '' }, 'Sem responsável'), (ctxS.equipe || []).map(x => h('option', { value: x.id, selected: !!s.responsavel && s.responsavel.uid === x.id }, x.nome)));
  const pri = h('select', { onchange: e => api('PATCH', '/api/solicitacoes/' + s.id, { prioridade: e.target.value }).then(render) }, Object.entries(PRIOS).map(([k, tt]) => h('option', { value: k, selected: k === s.prioridade }, tt)));
  return h('div', { class: 'ctl-chamado' }, h('div', {}, h('label', {}, 'Responsável'), resp), h('div', {}, h('label', {}, 'Prioridade'), pri), h('div', {}, h('label', {}, 'Prazo de resposta'), h('div', { class: 'ac-chips' }, slaChip(s.sla), s.sla && s.sla.estado !== 'encerrado' && h('span', { class: 'muted small' }, `até ${fmtTs(s.sla.prazo)}`))));
}
const infoCliente = s => (s.atendente || s.respostaPrevistaAte) ? h('p', { class: 'muted small', style: 'margin:0 0 6px' }, s.atendente && `Atendente: ${s.atendente}`, s.atendente && s.respostaPrevistaAte && ' · ', s.respostaPrevistaAte && `Resposta prevista até ${fmtTs(s.respostaPrevistaAte)}`) : null;
function modalRespostas(ctxS) {
  const v = overlay(true), caixa = h('div'), tit = h('input', { maxlength: 80, placeholder: 'Título (ex.: Horário de atendimento)' }), tx = h('textarea', { rows: 3, placeholder: 'Texto. Use {cliente}, {protocolo} e {atendente}.' }), err = h('div');
  const pinta = () => caixa.replaceChildren(...ctxS.respostas.map(r => h('div', { class: 'modelo' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, r.titulo), h('button', { class: 'btn sm perigo', onclick: async () => { await api('DELETE', '/api/respostas/' + r.id); ctxS.respostas = ctxS.respostas.filter(x => x.id !== r.id); pinta(); } }, 'Excluir')), h('div', { class: 'muted small', style: 'white-space:pre-wrap' }, r.texto))));
  pinta(); juntar(v, h('div', { class: 'modal' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Respostas prontas'), h('button', { class: 'btn sm', onclick: () => { v.remove(); render(); } }, 'Fechar')), caixa, h('h3', { style: 'margin-top:16px' }, 'Nova resposta'), tit, h('div', { style: 'height:8px' }), tx, err,
    h('button', { class: 'btn pri', style: 'margin-top:10px', onclick: async () => { try { const r = (await api('POST', '/api/respostas', { titulo: tit.value, texto: tx.value })).resposta; ctxS.respostas.push(r); tit.value = tx.value = ''; err.replaceChildren(); pinta(); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); } } }, 'Adicionar')));
}
function conversa(s, eq, ctxS = {}) {
  const fio = h('div', { class: 'fio', style: 'margin:10px 0' }, s.mensagens.map(x => h('div', { class: 'msg' + (x.tipoAutor === 'equipe' ? ' eq' : '') + (x.interna ? ' nota' : '') }, h('div', { class: 'quem' }, `${x.autor} `, h('span', { class: 'muted' }, `${x.interna ? 'Nota interna · só a equipe vê' : x.tipoAutor === 'equipe' ? 'Equipe Manda4' : 'Cliente'} · ${fmtTs(x.ts)}`)),
    x.texto && h('p', {}, x.texto), x.arquivo && h('p', {}, h('a', { href: '/api/arquivos/' + x.arquivo.id, download: x.arquivo.nome }, '📎 ' + x.arquivo.nome), h('span', { class: 'muted small' }, ` (${Math.ceil(x.arquivo.tamanho / 1024)} KB)`)))));
  const tx = h('textarea', { rows: 3, placeholder: eq ? 'Responder ao cliente…' : 'Escrever uma mensagem ou complemento…' }), file = h('input', { type: 'file' }), err = h('div'); const nota = eq ? h('input', { type: 'checkbox', style: 'width:auto' }) : null;
  if (nota) nota.addEventListener('change', () => { tx.placeholder = nota.checked ? 'Nota interna (o cliente não vê)…' : 'Responder ao cliente…'; tx.classList.toggle('nota-ativa', nota.checked); });
  const prontas = eq && (ctxS.respostas || []).length ? h('select', { style: 'width:auto;max-width:230px', onchange: e => { const r = ctxS.respostas.find(x => x.id === e.target.value); if (r) tx.value = (tx.value ? tx.value + '\n' : '') + r.texto.replace(/\{cliente\}/g, primeiroNome(s.cliente)).replace(/\{protocolo\}/g, s.protocolo).replace(/\{atendente\}/g, primeiroNome(U.nome)); e.target.value = ''; } }, h('option', { value: '' }, 'Inserir resposta pronta…'), ctxS.respostas.map(r => h('option', { value: r.id }, r.titulo))) : null;
  return h('div', {}, fio, tx, h('div', { class: 'row', style: 'margin-top:6px' }, prontas, eq && h('a', { class: 'small', style: 'cursor:pointer;color:var(--marca-2)', onclick: () => modalRespostas(ctxS) }, 'Gerenciar respostas'), eq && h('label', { class: 'nota-chk' }, nota, 'Nota interna'), file, h('button', { class: 'btn sm pri', onclick: async ev => { ev.target.disabled = true; err.replaceChildren(); try {
    const body = { texto: tx.value }; if (nota && nota.checked) body.interna = true; if (file.files[0]) body.arquivo = await lerArquivo(file.files[0]); await api('POST', `/api/solicitacoes/${s.id}/mensagens`, body); render();
  } catch (e) { err.append(h('div', { class: 'erro' }, e.message)); ev.target.disabled = false; } } }, 'Enviar')), err);
}
function avaliacao(s, eq) {
  if (s.avaliacao) return h('div', { class: 'aval' }, h('b', { class: 'estrelas' }, estrelas(s.avaliacao.nota)), h('span', { class: 'muted small' }, eq ? ' Avaliação do cliente' : ' Obrigado pela sua avaliação!'), s.avaliacao.comentario && h('p', { style: 'margin:4px 0 0' }, s.avaliacao.comentario));
  if (eq || !s.podeAvaliar) return null; let nota = 0; const bs = [1, 2, 3, 4, 5].map(n => h('button', { class: 'estrela', 'aria-label': `${n} de 5`, onclick: () => { nota = n; bs.forEach((b, k) => b.classList.toggle('on', k < n)); } }, '★'));
  const cm = h('textarea', { rows: 2, placeholder: 'Quer contar como foi? (opcional)' }), err = h('div');
  return h('div', { class: 'aval' }, h('b', {}, 'Como foi o atendimento?'), h('div', { class: 'estrelas-in' }, bs), cm, err, h('button', { class: 'btn sm pri', style: 'margin-top:6px', onclick: async ev => { if (!nota) { err.replaceChildren(h('div', { class: 'erro' }, 'Escolha de 1 a 5 estrelas.')); return; } ev.target.disabled = true;
    try { await api('POST', `/api/solicitacoes/${s.id}/avaliar`, { nota, comentario: cm.value }); toast('Obrigado pela avaliação!'); render(); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); ev.target.disabled = false; } } }, 'Enviar avaliação'));
}
function detalheChamado(s, eq, voltar, ctxS = {}) {
  const st = h('select', { onchange: e => api('PATCH', '/api/solicitacoes/' + s.id, { status: e.target.value }).then(render) }, Object.entries(SOL).map(([k, tt]) => h('option', { value: k, selected: k === s.status }, tt))); const bx = s.bitrix;
  return h('div', { class: 'card chamado' }, h('button', { class: 'btn sm so-mobile', onclick: voltar }, '← Chamados'), h('div', { class: 'row' }, h('h3', { class: 'grow' }, s.assunto), eq ? st : chip(s.status === 'recusada' ? 'vermelho' : s.status === 'concluida' ? 'verde' : 'amarelo', s.etapa || SOL[s.status])),
    h('p', { class: 'muted small', style: 'margin:4px 0' }, h('b', {}, s.protocolo), ` · ${CATS[s.categoria] || ''} · Prioridade ${PRIOS[s.prioridade] || ''} · ${s.projeto || 'Geral'} · ${fmtTs(s.criadoEm)}`),
    eq && h('p', { class: 'muted small', style: 'margin:0 0 6px' }, [s.cliente, s.empresa, s.email, s.telefone].filter(Boolean).join(' · ')), eq ? controlesStaff(s, ctxS) : infoCliente(s), trilha(s), h('p', { style: 'white-space:pre-wrap' }, s.texto),
    eq && bx && h('div', { class: 'bx' }, bx.status === 'enviado' ? [chip('verde', 'Card criado no Bitrix24'), bx.url && h('a', { href: bx.url, target: '_blank', rel: 'noopener noreferrer' }, `Abrir card #${bx.dealId}`)]
      : [chip(bx.status === 'erro' ? 'vermelho' : 'amarelo', bx.status === 'erro' ? 'Falha ao criar o card' : 'Card ainda não criado'), h('span', { class: 'muted small' }, bx.erro || ''), h('button', { class: 'btn sm', onclick: async ev => { ev.target.disabled = true; try { const r = await api('POST', `/api/solicitacoes/${s.id}/reenviar`, {}); toast(r.bitrix.status === 'enviado' ? 'Card criado no Bitrix24.' : (r.bitrix.erro || 'Não foi possível criar o card.')); } catch (e) { toast(e.message); } render(); } }, 'Reenviar ao Bitrix24')]),
    conversa(s, eq, ctxS), avaliacao(s, eq));
}
async function telaSolic(m) {
  const { solicitacoes } = await api('GET', '/api/solicitacoes'); const eq = U.tipo === 'equipe'; const st = view.sup = view.sup || { filtro: null, q: '', sel: null }; const ctxS = eq ? { equipe: (await api('GET', '/api/equipe')).equipe, respostas: (await api('GET', '/api/respostas')).respostas } : {};
  const aberto = s => s.aberto, vez = s => s.aberto && s.vezDe === (eq ? 'equipe' : 'cliente');
  const filtros = eq ? [['vez', 'Para responder', vez], ['meus', 'Meus', s => s.aberto && !!s.responsavel && s.responsavel.uid === U.id], ['semresp', 'Sem dono', s => s.aberto && !s.responsavel], ['abertos', 'Abertos', aberto], ['concluidos', 'Concluídos', s => !s.aberto], ['todos', 'Todos', () => true]] : [['abertos', 'Abertos', aberto], ['vez', 'Aguardando você', vez], ['concluidos', 'Concluídos', s => !s.aberto], ['todos', 'Todos', () => true]];
  if (!st.filtro) st.filtro = eq ? (solicitacoes.some(vez) ? 'vez' : 'abertos') : (solicitacoes.some(aberto) ? 'abertos' : 'todos');
  juntar(m, h('div', { class: 'row' }, h('h1', { class: 'grow' }, eq ? 'Suporte e solicitações' : 'Suporte'), !eq && h('button', { class: 'btn pri', onclick: () => novaSolic() }, '+ Abrir chamado')),
    !eq && h('p', { class: 'muted', style: 'margin:4px 0 0' }, 'Dúvidas, problemas e pedidos para a equipe Manda4. Cada chamado tem um protocolo e a conversa fica registrada aqui.'));
  const sem = eq && solicitacoes.some(s => s.bitrix && s.bitrix.status === 'nao_configurado');
  if (sem) juntar(m, h('div', { class: 'aviso' }, h('b', {}, 'Os chamados ainda não estão chegando ao funil de suporte do Bitrix24. '), U.admin ? h('a', { onclick: () => go({ nome: 'integracao' }) }, 'Configurar a integração →') : 'Peça a um administrador para configurar a integração.'));
  if (!solicitacoes.length) return juntar(m, h('div', { class: 'card vazio' }, eq ? 'Nenhum chamado ainda.' : h('div', {}, h('p', {}, 'Você ainda não abriu nenhum chamado.'), h('button', { class: 'btn pri', onclick: () => novaSolic() }, 'Abrir meu primeiro chamado'))));
  const mobile = innerWidth < 900; const lista = h('aside', { class: 'card sup-lista' }), detalhe = h('section', { class: 'sup-detalhe' }), grade = h('div', { class: 'sup' }, lista, detalhe); let tmr;
  const busca = h('input', { type: 'search', class: 'busca', placeholder: eq ? 'Buscar por assunto, cliente ou protocolo' : 'Buscar chamado', value: st.q, oninput: e => { st.q = e.target.value; clearTimeout(tmr); tmr = setTimeout(pinta, 150); } });
  const chips = h('div', { class: 'filtros' });
  function pinta() {
    const f = filtros.find(x => x[0] === st.filtro) || filtros[0]; const q = st.q.trim().toLowerCase();
    const vis = solicitacoes.filter(f[2]).filter(s => !q || [s.assunto, s.protocolo, s.cliente, s.empresa, s.projeto].join(' ').toLowerCase().includes(q)).sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
    if (!vis.some(x => x.id === st.sel)) st.sel = mobile ? null : (vis[0] ? vis[0].id : null);
    chips.replaceChildren(...filtros.map(([k, rot, fn]) => h('button', { class: 'filtro' + (st.filtro === k ? ' on' : ''), onclick: () => { st.filtro = k; st.sel = null; pinta(); } }, `${rot} `, h('span', { class: 'n' }, solicitacoes.filter(fn).length))));
    lista.replaceChildren(busca, chips, vis.length ? h('div', { class: 'sup-itens' }, vis.map(s => h('div', { class: 'sup-item' + (s.id === st.sel ? ' on' : ''), tabindex: 0, role: 'button', onclick: () => { st.sel = s.id; pinta(); }, onkeydown: e => e.key === 'Enter' && (st.sel = s.id, pinta()) },
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('b', { class: 'grow sup-ass' }, s.assunto), h('span', { class: 'muted small', style: 'white-space:nowrap' }, rel(s.atualizadoEm))),
      h('div', { class: 'muted small' }, `${s.protocolo} · ${CATS[s.categoria] || ''}${eq ? ' · ' + s.cliente : ''}${eq && s.responsavel ? ' · ' + s.responsavel.nome : ''}`),
      h('div', { class: 'ac-chips', style: 'margin-top:6px' }, chip(!s.aberto ? 'verde' : 'amarelo', !s.aberto ? (s.status === 'recusada' ? 'Encerrado' : 'Concluído') : s.etapa || SOL[s.status]), vez(s) && h('span', { class: 'vez' }, eq ? 'Para responder' : 'Aguardando você'), eq && s.aberto && s.sla && ['vencendo', 'estourado'].includes(s.sla.estado) && slaChip(s.sla))))) : h('div', { class: 'vazio small' }, 'Nenhum chamado neste filtro.'));
    const s = solicitacoes.find(x => x.id === st.sel); grade.classList.toggle('com-sel', !!s);
    detalhe.replaceChildren(s ? detalheChamado(s, eq, () => { st.sel = null; pinta(); }, ctxS) : h('div', { class: 'card vazio' }, 'Selecione um chamado para ver a conversa.'));
  }
  juntar(m, grade); pinta();
}
async function novaSolic(pre = {}) {
  const v = overlay(true), err = h('div'); const { projetos } = await api('GET', '/api/projetos');
  const sel = (o, def) => h('select', {}, Object.entries(o).map(([k, t]) => h('option', { value: k, selected: k === def }, t)));
  const pj = h('select', {}, h('option', { value: '' }, 'Geral (sem projeto)'), projetos.map(p => h('option', { value: p.id }, `${p.nome}${p.codigo ? ' · ' + p.codigo : ''}`)));
  const cat = sel(CATS, 'duvida'), pri = sel(PRIOS, 'media'), tel = h('input', { type: 'tel', placeholder: '(11) 90000-0000' }), as = h('input', { maxlength: 160, placeholder: 'Resumo em uma linha' }), tx = h('textarea', { rows: 6, placeholder: 'Conte o que aconteceu ou o que você precisa: o que estava fazendo, o que esperava e o que aconteceu.' }), arq = h('input', { type: 'file', multiple: true });
  const c = (r, el) => h('div', {}, h('label', {}, r), el);
  const sug = h('div', { class: 'sugestoes' }); let tmrS; const sugere = () => { clearTimeout(tmrS); tmrS = setTimeout(async () => { const q = as.value.trim(); if (q.length < 4) return sug.replaceChildren(); try { const { artigos } = await api('GET', '/api/artigos/sugestoes?q=' + encodeURIComponent(q + ' ' + tx.value.slice(0, 200)));
    sug.replaceChildren(...(artigos.length ? [h('div', { class: 'sug-caixa' }, h('b', {}, 'Estes artigos podem resolver sua dúvida agora:'), artigos.map(a => h('details', {}, h('summary', {}, a.titulo), h('p', { style: 'white-space:pre-wrap' }, a.texto), h('div', { class: 'row' }, h('button', { class: 'btn sm pri', onclick: async () => { await api('POST', `/api/artigos/${a.id}/util`, { resolveu: true }).catch(() => {}); v.remove(); toast('Que bom que ajudou! Se precisar de algo, é só abrir um chamado.', 5000); } }, 'Resolveu, obrigado'), h('button', { class: 'btn sm', onclick: () => api('POST', `/api/artigos/${a.id}/util`, { resolveu: false }).catch(() => {}) }, 'Não resolveu')))))] : [])); } catch { /* sem sugestão */ } }, 450); };
  as.addEventListener('input', sugere); tx.addEventListener('input', sugere);
  if (pre.projetoId) pj.value = pre.projetoId; if (pre.categoria) cat.value = pre.categoria; if (pre.assunto) as.value = pre.assunto; if (pre.texto) tx.value = pre.texto;
  juntar(v, h('div', { class: 'modal' }, h('h2', {}, 'Abrir chamado de suporte'), h('p', { class: 'muted small' }, 'Seu chamado vai direto para a equipe Manda4, com protocolo para acompanhamento.'),
    h('div', { class: 'g2' }, c('Projeto', pj), c('Categoria', cat), c('Prioridade', pri), c('Telefone para contato (opcional)', tel)), h('label', {}, 'Assunto *'), as, sug, h('label', {}, 'Descrição *'), tx, h('label', {}, 'Anexos (prints, documentos · até 3 arquivos de 10 MB)'), arq, err,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async ev => { ev.target.disabled = true; err.replaceChildren(); try {
      const arqs = [...arq.files]; if (arqs.length > 3) throw new Error('Envie no máximo 3 arquivos por chamado. Você pode anexar mais depois, na conversa.'); const prontos = await Promise.all(arqs.map(lerArquivo));
      const r = await api('POST', '/api/solicitacoes', { projetoId: pj.value, categoria: cat.value, prioridade: pri.value, telefone: tel.value, assunto: as.value, texto: tx.value });
      for (const a of prontos) await api('POST', `/api/solicitacoes/${r.id}/mensagens`, { arquivo: a }).catch(() => {}); v.remove(); view.sup = { ...(view.sup || {}), filtro: 'abertos', q: '', sel: r.id }; if (view.nome === 'inicio') go({ nome: 'solicitacoes', sup: view.sup }); else render(); toast(`Chamado ${r.protocolo} registrado. A equipe Manda4 foi avisada.`);
    } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); ev.target.disabled = false; } } }, 'Enviar chamado'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'))));
}

