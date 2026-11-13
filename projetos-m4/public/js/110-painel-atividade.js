// ---------- painel da atividade ----------
function overlay(centro) { const v = h('div', { class: 'veu' + (centro ? ' centro' : ''), onmousedown: e => e.target === v && v.remove() }); document.body.append(v); return v; }
function rapido(p, t, v) {
  const val = h('b', {}, t.progresso + '%'); const r = h('input', { type: 'range', min: 0, max: 100, step: 5, value: t.progresso, 'aria-label': 'Andamento da atividade', oninput: () => { val.textContent = r.value + '%'; } });
  return h('div', { class: 'rapido' }, h('label', {}, 'Atualizar andamento'), h('div', { class: 'row' }, r, val, h('button', { class: 'btn sm', onclick: async ev => { ev.target.disabled = true; try { await api('PATCH', '/api/tarefas/' + t.id, { progresso: +r.value }); v.remove(); toast('Andamento atualizado.'); render(); } catch (e) { toast(e.message); ev.target.disabled = false; } } }, 'Salvar')));
}
// Aprovação de entrega: a equipe envia; o cliente aprova ou pede ajustes (com comentário). Fica registrado com autor e data.
function modalDecisao(t, decisao, depois) {
  const v = overlay(true), err = h('div'), ok = decisao === 'aprovar'; const tx = h('textarea', { rows: 4, placeholder: ok ? 'Algum comentário? (opcional)' : 'Descreva o que precisa ser ajustado.' });
  juntar(v, h('div', { class: 'modal', style: 'max-width:520px' }, h('h2', {}, ok ? 'Aprovar a entrega' : 'Pedir ajustes'), h('p', {}, h('b', {}, t.nome)), h('p', { class: 'muted small' }, ok ? 'Ao aprovar, a atividade é marcada como concluída e ficam registrados o seu nome e a data.' : 'A equipe Manda4 recebe o seu pedido e a entrega volta para ajustes.'),
    h('label', {}, ok ? 'Comentário' : 'O que precisa ser ajustado *'), tx, err, h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async ev => { ev.target.disabled = true; try { await api('POST', `/api/tarefas/${t.id}/aprovacao`, { decisao, comentario: tx.value }); v.remove(); toast(ok ? 'Entrega aprovada. Obrigado!' : 'Pedido de ajustes enviado à equipe.'); depois(); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); ev.target.disabled = false; } } }, ok ? 'Aprovar entrega' : 'Enviar pedido'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'))));
}
function blocoAprovacao(t, fecha) {
  const eq = U.tipo === 'equipe', a = t.aprovacao; if (!t.requerAprovacao && !a) return null; if (!eq && !a) return null;
  const quando = x => fmtTs(x);
  if (a && a.estado === 'aprovada') return h('div', { class: 'callout ok' }, h('b', {}, 'Entrega aprovada'), h('p', {}, `Aprovada por ${a.por} em ${quando(a.decididaEm)}.${a.comentario ? ' “' + a.comentario + '”' : ''}`));
  if (!eq && a.estado === 'pendente') return h('div', { class: 'callout' }, h('b', {}, 'Esta entrega aguarda a sua aprovação'), h('p', {}, 'Confira o que foi entregue e aprove, ou peça ajustes.'), h('div', { class: 'row' }, h('button', { class: 'btn pri sm', onclick: () => modalDecisao(t, 'aprovar', () => { fecha(); render(); }) }, 'Aprovar entrega'), h('button', { class: 'btn sm', onclick: () => modalDecisao(t, 'ajustes', () => { fecha(); render(); }) }, 'Pedir ajustes')));
  if (!eq) return h('div', { class: 'callout' }, h('b', {}, 'Você pediu ajustes'), h('p', {}, `${a.comentario}`), h('p', { class: 'small muted' }, 'A equipe Manda4 está ajustando e vai enviar a entrega para uma nova aprovação.'));
  const envia = h('button', { class: 'btn pri sm', onclick: async ev => { ev.target.disabled = true; try { await api('POST', `/api/tarefas/${t.id}/aprovacao/solicitar`, {}); toast('Entrega enviada para aprovação do cliente.'); fecha(); render(); } catch (e) { toast(e.message); ev.target.disabled = false; } } }, a && a.estado === 'ajustes' ? 'Reenviar para aprovação' : 'Enviar para aprovação do cliente');
  return h('div', { class: 'callout' }, h('b', {}, 'Aprovação do cliente'), h('p', {}, !a ? 'Ainda não enviada ao cliente.' : a.estado === 'pendente' ? `Aguardando aprovação desde ${quando(a.solicitadaEm)} (enviada por ${a.solicitadaPor}).` : `Ajustes pedidos por ${a.por} em ${quando(a.decididaEm)}: “${a.comentario}”`), !a || a.estado === 'ajustes' ? envia : null);
}
async function drawer(p, t) {
  $tip.hidden = true; const v = overlay(), box = h('aside', { class: 'drawer' }); juntar(v, box); const eq = U.tipo === 'equipe';
  const fio = h('div', { class: 'fio' }), err = h('div'); const txt = h('textarea', { rows: 3, placeholder: 'Escreva uma informação, dúvida ou observação…' }); const file = h('input', { type: 'file' }); const soEq = eq && h('input', { type: 'checkbox', style: 'width:auto' });
  const carregar = async () => {
    const { itens } = await api('GET', `/api/tarefas/${t.id}/itens`); fio.replaceChildren(...(itens.length ? itens.map(i => h('div', { class: 'msg' + (i.tipoAutor === 'equipe' ? ' eq' : '') + (i.interna ? ' nota' : '') }, h('div', { class: 'quem' }, `${i.autor} `, i.interna && h('span', { class: 'selo-int' }, 'só equipe '), h('span', { class: 'muted' }, `${i.tipoAutor === 'equipe' ? 'Equipe Manda4' : 'Cliente'} · ${fmtTs(i.ts)}`)),
      i.texto && h('p', {}, i.texto), i.arquivo && h('p', {}, h('a', { href: '/api/arquivos/' + i.arquivo.id, download: i.arquivo.nome }, '📎 ' + i.arquivo.nome), h('span', { class: 'muted small' }, ` (${Math.ceil(i.arquivo.tamanho / 1024)} KB)`)))) : [h('p', { class: 'muted' }, 'Nenhum registro ainda.')]));
  };
  juntar(box, h('div', { class: 'row' }, h('h2', { class: 'grow' }, t.nome), eq && h('button', { class: 'btn pri sm', onclick: () => { v.remove(); modalTarefa(p, t); } }, 'Editar atividade'), !eq && t.status.codigo !== 'concluida' && h('button', { class: 'btn sm', title: 'O prazo é ajustado pela equipe Manda4. Peça por aqui.', onclick: () => { v.remove(); novaSolic({ projetoId: p.id, categoria: 'mudanca', assunto: `Pedido de ajuste de prazo: ${t.nome}`, texto: `Gostaria de pedir um ajuste de prazo na atividade “${t.nome}” (hoje: ${fmt(t.inicio)} a ${fmt(t.fim)}).\n\nNovo prazo desejado:\nMotivo:` }); } }, 'Pedir ajuste de prazo'), h('button', { class: 'btn sm', onclick: () => v.remove() }, 'Fechar')), chip(t.status.cor, t.status.rotulo),
    t.aguardaCliente && t.progresso < 100 && h('div', { class: 'callout' }, h('b', {}, U.tipo === 'equipe' ? 'Aguardando o cliente' : 'A equipe precisa de você'), h('p', {}, t.pedido || 'A equipe aguarda o seu retorno para continuar.'), t.respondidoEm && h('p', { class: 'small' }, `${U.tipo === 'equipe' ? 'Cliente respondeu' : 'Você respondeu'} em ${fmtTs(t.respondidoEm)}.`)),
    blocoAprovacao(t, () => v.remove()),
    h('p', { class: 'muted' }, t.descricao), h('p', {}, `📅 ${fmt(t.inicio)} → ${fmt(t.fim)} · ${t.progresso}% concluído`), h('p', {}, '👷 Quem está trabalhando: ', h('b', {}, t.responsavel || 'a definir')),
    (t.deps || []).length > 0 && h('p', { class: 'muted small' }, 'Depende de: ' + t.deps.map(d => { const o = p.tarefas.find(x => x.id === d.de); return o ? `${o.nome} (${d.tipo === 'SS' ? 'começam juntas' : 'espera terminar'}${d.lag ? ', ' + d.lag + 'd' : ''})` : null; }).filter(Boolean).join('; ')),
    eq && rapido(p, t, v),
    h('h3', { style: 'margin-top:18px' }, 'Informações e documentos'), fio, h('label', {}, 'Adicionar texto'), txt, h('label', {}, 'Anexar documento (até 10 MB)'), file, soEq && h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:500;color:var(--tinta)' }, soEq, 'Só a equipe vê (o cliente não vê este registro nem o anexo)'), err,
    h('button', { class: 'btn pri', style: 'margin-top:12px', onclick: async ev => {
      err.replaceChildren(); const body = { texto: txt.value }; if (soEq && soEq.checked) body.interna = true; const f = file.files[0]; ev.target.disabled = true;
      try {
        if (f) { if (f.size > 10 * 1024 * 1024) throw new Error('Arquivo acima de 10 MB.'); const buf = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768)); body.arquivo = { nome: f.name, base64: btoa(s) }; }
        await api('POST', `/api/tarefas/${t.id}/itens`, body); txt.value = ''; file.value = ''; await carregar();
      } catch (e) { err.append(h('div', { class: 'erro' }, e.message)); } ev.target.disabled = false;
    } }, 'Enviar'));
  carregar().catch(e => fio.append(h('div', { class: 'erro' }, e.message)));
}

