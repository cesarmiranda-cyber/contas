// ---------- novidades (sino) ----------
async function abrirNovidades(badge) {
  const v = overlay(), box = h('aside', { class: 'drawer' }); juntar(v, box); const { itens } = await api('GET', '/api/novidades');
  juntar(box, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Novidades'), h('button', { class: 'btn sm', onclick: () => v.remove() }, 'Fechar')), h('p', { class: 'muted small' }, 'O que a equipe Manda4 fez nos seus projetos e chamados nos últimos 30 dias.'),
    itens.length ? h('div', { class: 'fio' }, itens.map(i => h('div', { class: 'msg eq' }, h('div', { class: 'quem' }, i.texto), h('div', { class: 'muted small' }, `${i.projeto ? i.projeto + ' · ' : ''}${fmtTs(i.ts)}`)))) : h('div', { class: 'vazio' }, 'Nenhuma novidade por enquanto.'));
  await api('POST', '/api/novidades/lido', {}); if (badge) badge.hidden = true;
}
function sino() {
  const n = h('span', { class: 'sino-n', hidden: true }); const svg = document.createElementNS(NS_SVG, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 19a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  const b = h('button', { class: 'sino', 'aria-label': 'Novidades', title: 'Novidades', onclick: () => abrirNovidades(n) }, svg, n);
  api('GET', '/api/novidades').then(r => { if (r.novas) { n.textContent = r.novas > 9 ? '9+' : r.novas; n.hidden = false; } }).catch(() => {}); return b;
}

