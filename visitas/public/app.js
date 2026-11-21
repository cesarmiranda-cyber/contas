const $ = s => document.querySelector(s);
const IC = { cal: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', chart: 'M18 20V10M12 20V4M6 20v-6', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z', inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z', pin: 'M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' };
const ico = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const ini = n => String(n || '').split(/\s+/).map(x => x.replace(/[^\p{L}]/gu, '')).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase() || '?';
const rel = (d, hoje) => { d = String(d || '').slice(0, 10); hoje = String(hoje || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(hoje)) return ''; const n = Math.round((new Date(d + 'T00:00:00Z') - new Date(hoje + 'T00:00:00Z')) / 864e5); if (Number.isNaN(n)) return ''; return n === 0 ? 'hoje' : n === 1 ? 'amanhã' : n > 1 ? `em ${n} dias` : n === -1 ? 'ontem' : `há ${-n} dias`; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ETAPAS = { NEW: 'Aguardando', PREPARATION: 'Dia da visita', LATE: 'Atrasada', ENC: 'Encerrado', NAOREAL: 'Não realizada', SUCCESS: 'Finalizado', OUTRA: 'Outra etapa', FAIL: 'Removido' };
const COLS = ['NEW', 'PREPARATION', 'LATE', 'ENC', 'NAOREAL', 'SUCCESS', 'OUTRA'];
const nomeEtapa = i => (i.etapa === 'OUTRA' && i.etapaNome) || ETAPAS[i.etapa] || i.etapa;
const S = { page: 1, size: 30, total: 0, pages: 1, eu: null, aba: 'fila', vista: 'cards', f: { de: '', ate: '', segmento: '', vendedor: '', classe: '', etapa: '', supervisor: '' }, itens: [], sel: new Set(), dashPag: 'fila', cfg: null };
try { Object.assign(S.f, JSON.parse(localStorage.getItem('vis.f') || '{}')); S.vista = localStorage.getItem('vis.v') || 'cards'; } catch {}
const dtBR = d => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
const dthBR = d => (d ? `${dtBR(d)} ${d.length > 10 ? d.slice(11, 16) : ''}` : '—');

// Resposta atrasada de uma tela que já foi trocada é descartada em silêncio (evita escrever em tela inexistente).
class Stale extends Error {}
const gen = { n: 0 };
async function vapi(url) { const g = gen.n; const r = await api(url); if (g !== gen.n) throw new Stale(); return r; }
window.addEventListener('unhandledrejection', e => { if (e.reason instanceof Stale) e.preventDefault(); });
async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
  return j;
}
let tt; function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.append(t); clearTimeout(tt); tt = setTimeout(() => t.remove(), 3500); setTimeout(() => t.remove(), 3600); }
const falha = e => { if (!(e instanceof Stale)) toast(e.message || String(e)); };

// ----- janelas (não fecham ao clicar fora, para não perder o que foi digitado) -----
function modal(html, onReady) {
  const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(bg); const close = () => bg.remove();
  bg.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  onReady && onReady(bg, close); return { bg, close };
}

// ----- navegação -----
function tabs() {
  const t = [['fila', 'Visitas', 'list'], ['alt', 'Visita Alterada', 'edit'], ['dash', 'Dashboard', 'chart'], ...(S.eu.config ? [['cfg', 'Configurações', 'gear']] : [])];
  $('#logo').innerHTML = ico('cal'); $('#me').innerHTML = `<div class="av">${esc(ini(S.eu.nome))}</div><span>${esc(S.eu.nome || 'Usuário #' + S.eu.id)}</span>`;
  $('#tabs').innerHTML = t.map(([k, n, i]) => `<button class="tab ${S.aba === k ? 'on' : ''}" data-k="${k}" ${S.aba === k ? 'aria-current="page"' : ''}>${ico(i)}${n}</button>`).join('');
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => { S.aba = b.dataset.k; tabs(); render(); });
}
async function render() {
  gen.n++; const app = $('#app');
  if (S.eu.acesso === false) { app.innerHTML = '<div class="aviso erro">Seu departamento não tem acesso ao Registro de Visitas. Peça a um administrador.</div>'; return; }
  if (!S.eu.webhook && S.aba !== 'cfg') { app.innerHTML = `<div class="aviso erro">O Bitrix24 ainda não está conectado ao app. ${S.eu.config ? 'Abra <b>Configurações</b> e informe o webhook de entrada.' : 'Peça a um administrador para concluir a configuração.'}</div>`; return; }
  try { await ({ fila: telaFila, alt: telaAlt, dash: telaDash, cfg: telaCfg }[S.aba])(); } catch (e) { if (!(e instanceof Stale)) app.innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; }
}

// ----- Registro de Visitas -----
const ABERTA = ['NEW', 'PREPARATION', 'LATE'];
const PIOR = ['LATE', 'PREPARATION', 'NEW', 'NAOREAL', 'ENC', 'SUCCESS', 'OUTRA'];
S.agrupar = localStorage.getItem('vis.g') !== '0'; S.fin = localStorage.getItem('vis.fin') === '1'; S.q = ''; S.kan = {}; S.size = 30;
async function telaFila() {
  gen.n++; const app = $('#app');
  if (!$('#fil')) {
    app.innerHTML = `<div class="kpis" id="kpis"></div><div class="filtros" id="fil"></div><div id="lista"><div class="grid">${'<div class="sk"></div>'.repeat(6)}</div></div>`;
  } else $('#lista').classList.add('busy');
  const f = S.f, kan = S.vista === 'kanban';
  const q = new URLSearchParams(Object.entries({ ...f, q: S.q, agrupar: S.agrupar && !kan ? '1' : '', all: kan ? '1' : '', finalizados: S.fin ? '1' : '', page: S.page, pageSize: S.size }).filter(([, v]) => v !== '' && v !== undefined)).toString();
  const r = await vapi('/api/visitas?' + q);
  S.itens = r.itens; S.total = r.total; S.grupos = r.totalGrupos; S.pages = r.pages; S.page = r.page; S.porEtapa = r.porEtapa || {};
  S.segs = new Set([...(S.segs || []), ...S.itens.map(i => i.segmento).filter(Boolean)]); S.vends = new Map([...(S.vends || []), ...S.itens.map(i => [i.vendedorId, i.vendedor])]); S.hoje = r.hoje;
  const uniq = () => [...S.segs].sort();
  const op = (k, arr, lab = x => x) => `<option value="">Todos</option>` + arr.map(x => `<option value="${esc(x[0] ?? x)}" ${f[k] === String(x[0] ?? x) ? 'selected' : ''}>${esc(lab(x[1] ?? x))}</option>`).join('');
  const vend = [...S.vends.entries()].map(([id, n]) => [id || 'sem', n]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const foco = document.activeElement?.id === 'f_q' ? document.activeElement.selectionStart : null;
  $('#fil').innerHTML = `
    <label class="busca">Cliente<input type="search" id="f_q" placeholder="Buscar cliente ou segmento…" value="${esc(S.q)}"></label>
    <label>De<input type="date" id="f_de" value="${esc(f.de)}"></label><label>Até<input type="date" id="f_ate" value="${esc(f.ate)}"></label>
    <label>Segmento<select id="f_segmento">${op('segmento', uniq())}</select></label>
    <label>Vendedor<select id="f_vendedor">${op('vendedor', vend)}</select></label>
    <label>Classe<select id="f_classe">${op('classe', ['A', 'B', 'C', 'E'])}</select></label>
    <label>Etapa<select id="f_etapa">${op('etapa', COLS.map(c => [c, ETAPAS[c]]))}</select></label>
    <div class="fim"><span class="count">${S.total} visita(s) · ${S.grupos} cliente(s)</span>
      <label class="sw"><input type="checkbox" id="f_fin" ${S.fin ? 'checked' : ''}> Mostrar finalizados</label>
      <label class="sw ${kan ? 'off' : ''}" title="${kan ? 'No Kanban os segmentos do mesmo cliente já ficam juntos em cada coluna' : ''}"><input type="checkbox" id="f_g" ${S.agrupar ? 'checked' : ''} ${kan ? 'disabled' : ''}> Agrupar por cliente</label>
      <div class="seg">${[['cards', 'Cartões'], ['tabela', 'Tabela'], ['kanban', 'Kanban']].map(([k, n]) => `<button class="btn ${S.vista === k ? 'on' : ''}" data-v="${k}">${n}</button>`).join('')}</div>
      ${S.eu.podeExcluir ? '<button class="btn" id="b_excl">Excluídos</button>' : ''}</div>`;
  if (foco !== null) { const el = $('#f_q'); el.focus(); el.setSelectionRange(foco, foco); }
  ['de', 'ate', 'segmento', 'vendedor', 'classe', 'etapa'].forEach(k => $('#f_' + k).onchange = e => { S.page = 1; f[k] = e.target.value; localStorage.setItem('vis.f', JSON.stringify({ ...f, de: '', ate: '' })); telaFila(); });
  let tq; $('#f_q').oninput = e => { clearTimeout(tq); tq = setTimeout(() => { S.q = e.target.value; S.page = 1; telaFila().catch(falha); }, 350); };
  $('#f_fin').onchange = e => { S.fin = e.target.checked; localStorage.setItem('vis.fin', S.fin ? '1' : '0'); S.page = 1; telaFila(); };
  $('#f_g').onchange = e => { S.agrupar = e.target.checked; localStorage.setItem('vis.g', S.agrupar ? '1' : '0'); S.page = 1; telaFila(); };
  document.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { S.page = 1; S.vista = b.dataset.v; S.kan = {}; localStorage.setItem('vis.v', S.vista); telaFila(); });
  if ($('#b_excl')) $('#b_excl').onclick = telaExcluidos;
  $('#kpis').innerHTML = ['NEW', 'PREPARATION', 'LATE', 'ENC', 'NAOREAL'].map(c => `<button class="kpi-t ${f.etapa === c ? 'on' : ''}" data-e="${c}" data-kpi="${c}"><b>${S.porEtapa[c] || 0}</b><span>${ETAPAS[c]}</span></button>`).join('');
  document.querySelectorAll('[data-kpi]').forEach(b => b.onclick = () => { f.etapa = f.etapa === b.dataset.kpi ? '' : b.dataset.kpi; S.page = 1; telaFila(); });
  $('#lista').classList.remove('busy');
  desenhaLista();
}
// Ações de uma linha: a principal à vista e as demais num menu "⋯".
function acoesLinha(i) {
  const abre = ABERTA.includes(i.etapa), b = (a, t, c = '') => `<button class="btn sm ${c}" data-a="${a}" data-id="${i.id}">${t}</button>`;
  const sec = [];
  if (abre) sec.push(b('alt', 'Alterar data'), b('nao', 'Não realizada'));
  if (i.etapa === 'ENC') sec.push(b('edit', '✎ Editar registro'));
  if (i.reprogramado && abre) sec.push(b('rev', 'Reverter data'));
  if (i.podeExcluir && i.etapa !== 'FAIL') sec.push(b('del', 'Excluir', 'bad'));
  const prim = abre ? b('reg', 'Registrar', 'pri') : i.etapa === 'ENC' ? b('ver', 'Ver registro') : '';
  return `${prim}${sec.length ? `<details class="menu"><summary class="btn sm" aria-label="Mais ações">⋯</summary><div class="menu-p">${sec.join('')}</div></details>` : ''}`;
}
function linhaHtml(i, kan) {
  const r = rel(i.data, S.hoje), abre = ABERTA.includes(i.etapa);
  return `<div class="srow" data-e="${i.etapa}" data-id="${i.id}" ${abre && kan ? 'draggable="true"' : ''}>
    <div class="srow-t"><span class="segn">${esc(i.segmento || '—')}</span><span class="cls ${esc(i.classe)}" title="Classe ${esc(i.classe || '—')}">${esc(i.classe || '–')}</span>${kan ? '' : `<span class="tag" data-e="${i.etapa}">${esc(nomeEtapa(i))}</span>`}</div>
    <div class="srow-s"><span class="who"><span class="av">${esc(ini(i.vendedor))}</span>${esc(i.vendedor)}</span><span class="dt">${ico('cal')}${dtBR(i.data)}${r ? ` <span class="mut">${r}</span>` : ''}</span>${i.atrasoDias ? `<span class="tag bad">${i.atrasoDias}d de atraso</span>` : ''}${i.reprogramado ? '<span class="tag warn">data alterada</span>' : ''}</div>
    ${i.etapa === 'NAOREAL' && i.motivo ? `<div class="mut">Motivo: ${esc(i.motivo)}${i.detalhe ? ' — ' + esc(i.detalhe) : ''}</div>` : ''}
    <div class="srow-a">${acoesLinha(i)}</div></div>`;
}
const agrupaItens = it => { const m = new Map(); for (const i of it) (m.get(i.empresaId) || m.set(i.empresaId, []).get(i.empresaId)).push(i); return [...m.values()]; };
const piorEtapa = g => PIOR.find(e => g.some(i => i.etapa === e)) || g[0].etapa;
const rotGrupo = g => { const n = new Set(g.map(i => i.segmento)).size; return g.length > 1 ? `<span class="tag plain neutro">${n > 1 ? n + ' segmentos' : g.length + ' visitas'}</span>` : ''; };
function grupoHtml(g, kan) {
  return `<article class="card grp" data-e="${piorEtapa(g)}"><div class="card-h"><h3>${esc(g[0].empresa)}</h3>${rotGrupo(g)}</div><div class="srows">${g.map(i => linhaHtml(i, kan)).join('')}</div></article>`;
}
function pager() {
  if (S.pages <= 1 && S.vista === 'kanban') return '';
  if (S.vista === 'kanban') return '';
  return `<div class="filtros pg"><button class="btn sm" data-pg="-1" ${S.page <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="mut">Página ${S.page} de ${S.pages}</span><button class="btn sm" data-pg="1" ${S.page >= S.pages ? 'disabled' : ''}>Próxima ›</button>
    <select id="pg_size" aria-label="Por página">${[15, 30, 60, 100].map(n => `<option ${n === S.size ? 'selected' : ''} value="${n}">${n} ${S.agrupar ? 'clientes' : 'itens'}</option>`).join('')}</select></div>`;
}
function ligaPager(L) {
  L.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => { S.page += +b.dataset.pg; telaFila(); window.scrollTo(0, 0); });
  if ($('#pg_size')) $('#pg_size').onchange = e => { S.size = +e.target.value; S.page = 1; telaFila(); };
}
function kanbanHtml(it) {
  const cols = COLS.filter(c => ['NEW', 'PREPARATION', 'LATE', 'ENC', 'NAOREAL'].includes(c) || it.some(i => i.etapa === c));
  return `<div class="kdica">${ico('pin')} Arraste um item para outra coluna: <b>Encerrado</b> abre o registro, <b>Não realizada</b> pede o motivo, <b>Aguardando / Dia da visita</b> altera a data${S.eu.podeExcluir ? ' e a faixa inferior exclui' : ''}.</div>
  <div class="kanban">${cols.map(c => { const gs = agrupaItens(it.filter(i => i.etapa === c)), lim = S.kan[c] || 20;
    return `<div class="col" data-e="${c}" data-col="${c}"><h4>${ETAPAS[c]} <b>${gs.reduce((n, g) => n + g.length, 0)}</b></h4><div class="colb">${gs.slice(0, lim).map(g => grupoHtml(g, true)).join('') || '<div class="mut" style="padding:10px">Vazio</div>'}${gs.length > lim ? `<button class="btn sm" data-mais="${c}">Ver mais (${gs.length - lim})</button>` : ''}</div></div>`; }).join('')}</div>`;
}
function tabelaHtml(it) {
  const linha = (i, mostraEmpresa) => `<tr data-e="${i.etapa}"><td>${ABERTA.includes(i.etapa) ? `<input type="checkbox" data-sel="${i.id}" ${S.sel.has(i.id) ? 'checked' : ''} aria-label="Selecionar">` : ''}</td><td>${mostraEmpresa ? `<b>${esc(i.empresa)}</b> <span class="mut">${esc(i.segmento)}</span>` : `<span class="segn">${esc(i.segmento || '—')}</span>`}</td><td><span class="cls ${esc(i.classe)}">${esc(i.classe || '–')}</span></td><td>${esc(i.vendedor)}</td><td style="white-space:nowrap">${dtBR(i.data)} <span class="mut">${rel(i.data, S.hoje)}</span></td><td><span class="tag" data-e="${i.etapa}">${esc(nomeEtapa(i))}</span></td><td><div class="srow-a" style="justify-content:flex-end">${acoesLinha(i)}</div></td></tr>`;
  const corpo = S.agrupar ? agrupaItens(it).map(g => `<tr class="gh"><td colspan="7"><b>${esc(g[0].empresa)}</b> ${rotGrupo(g)}</td></tr>${g.map(i => linha(i, false)).join('')}`).join('') : it.map(i => linha(i, true)).join('');
  return `<div style="margin-bottom:10px"><button class="btn" id="b_grupo" disabled>Alterar data dos selecionados</button></div><div class="scroll"><table class="tbl"><thead><tr><th></th><th>${S.agrupar ? 'Segmento' : 'Cliente'}</th><th>Classe</th><th>Vendedor</th><th>Data</th><th>Etapa</th><th></th></tr></thead><tbody>${corpo}</tbody></table></div>`;
}
function desenhaLista() {
  const L = $('#lista'), it = S.itens;
  if (!it.length) { L.innerHTML = `<div class="vazio">${ico('inbox')}<b>Nenhuma visita encontrada</b><div>Ajuste os filtros ou rode a sincronização em Configurações.</div></div>`; return; }
  if (S.vista === 'cards') L.innerHTML = `<div class="grid">${(S.agrupar ? agrupaItens(it) : it.map(i => [i])).map(g => grupoHtml(g, false)).join('')}</div>`;
  else if (S.vista === 'kanban') L.innerHTML = kanbanHtml(it);
  else L.innerHTML = tabelaHtml(it);
  L.insertAdjacentHTML('beforeend', pager()); ligaPager(L);
  L.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { b.closest('details')?.removeAttribute('open'); acao(b.dataset.a, +b.dataset.id); });
  L.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => { c.checked ? S.sel.add(+c.dataset.sel) : S.sel.delete(+c.dataset.sel); if ($('#b_grupo')) $('#b_grupo').disabled = !S.sel.size; });
  if ($('#b_grupo')) { $('#b_grupo').disabled = !S.sel.size; $('#b_grupo').onclick = () => modalAlterar([...S.sel]); }
  L.querySelectorAll('[data-mais]').forEach(b => b.onclick = () => { S.kan[b.dataset.mais] = (S.kan[b.dataset.mais] || 20) + 25; desenhaLista(); });
  if (S.vista === 'kanban') ligaKanban(L);
}
// Arrastar e soltar no Kanban: a coluna de destino decide a ação (mesmas regras dos botões).
function ligaKanban(L) {
  let zona = $('#kdel'); zona?.remove();
  if (S.eu.podeExcluir) { zona = document.createElement('div'); zona.id = 'kdel'; zona.className = 'kdel'; zona.textContent = 'Solte aqui para excluir'; document.body.append(zona); }
  const fim = () => { document.body.classList.remove('arrastando'); document.querySelectorAll('.over').forEach(x => x.classList.remove('over')); };
  L.querySelectorAll('.srow[draggable]').forEach(r => { r.ondragstart = e => { e.dataTransfer.setData('text/plain', r.dataset.id); e.dataTransfer.effectAllowed = 'move'; r.classList.add('drag'); document.body.classList.add('arrastando'); }; r.ondragend = () => { r.classList.remove('drag'); fim(); }; });
  L.querySelectorAll('[data-col]').forEach(c => { c.ondragover = e => { e.preventDefault(); c.classList.add('over'); }; c.ondragleave = () => c.classList.remove('over'); c.ondrop = e => { e.preventDefault(); const id = +e.dataTransfer.getData('text/plain'); fim(); soltar(id, c.dataset.col); }; });
  if (zona) { zona.ondragover = e => { e.preventDefault(); zona.classList.add('over'); }; zona.ondragleave = () => zona.classList.remove('over'); zona.ondrop = e => { e.preventDefault(); const id = +e.dataTransfer.getData('text/plain'); fim(); acao('del', id); }; }
}
function soltar(id, destino) {
  const i = S.itens.find(x => x.id === id);
  if (!i || i.etapa === destino) return;
  if (!ABERTA.includes(i.etapa)) return toast('Só visitas abertas (Aguardando, Dia da visita ou Atrasada) podem ser movidas.');
  if (destino === 'ENC') return formRegistro(id).catch(falha);
  if (destino === 'NAOREAL') return modalNao(id).catch(falha);
  if (destino === 'LATE') return toast('"Atrasada" é automática: acontece quando a data programada passa.');
  if (destino === 'NEW' || destino === 'PREPARATION') return modalAlterar([id], destino === 'PREPARATION' ? S.hoje : '');
  toast('Esse movimento não está disponível.');
}
// O menu "⋯" usa posição fixa (calculada ao abrir): não é cortado pela coluna rolável do Kanban nem coberto pelo cartão seguinte.
const fechaMenus = ex => document.querySelectorAll('details.menu[open]').forEach(d => { if (d !== ex) d.removeAttribute('open'); });
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches?.('details.menu') || !d.open) return;
  fechaMenus(d);
  const p = d.querySelector('.menu-p'), r = d.querySelector('summary').getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
  let top = r.bottom + 4; if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 4);
  Object.assign(p.style, { position: 'fixed', top: top + 'px', left: Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px', right: 'auto' });
}, true);
window.addEventListener('scroll', () => fechaMenus(), true); window.addEventListener('resize', () => fechaMenus());
document.addEventListener('keydown', e => { if (e.key === 'Escape') fechaMenus(); });
document.addEventListener('click', e => { document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.removeAttribute('open'); }); });
async function acao(a, id) {
  const i = S.itens.find(x => x.id === id);
  try {
    if (a === 'reg') return formRegistro(id);
    if (a === 'edit') return formRegistro(id, true);
    if (a === 'ver') return verRegistro(id);
    if (a === 'alt') return modalAlterar([id]);
    if (a === 'nao') return modalNao(id);
    if (a === 'rev') { if (confirm('Voltar à data anterior?')) { await api(`/api/cards/${id}/reverter`, 'POST', {}); toast('Data revertida'); telaFila(); } return; }
    if (a === 'del') return modal(`<h2>Excluir card</h2><p>Excluir a visita de <b>${esc(i.empresa)}</b>? Por padrão a próxima visita é gerada.</p><label><input type="checkbox" id="x_prox" checked> Gerar a próxima visita</label><div class="foot"><button class="btn" data-close>Cancelar</button><button class="btn bad" id="x_ok">Excluir</button></div>`, (bg, close) => bg.querySelector('#x_ok').onclick = async () => { try { await api(`/api/cards/${id}/excluir`, 'POST', { gerarProxima: bg.querySelector('#x_prox').checked }); close(); toast('Card excluído'); telaFila(); } catch (e) { falha(e); } });
  } catch (e) { falha(e); }
}
async function telaExcluidos() {
  const r = await api('/api/excluidos');
  modal(`<h2>Excluídos</h2>${r.itens.length ? `<table><tbody>${r.itens.map(i => `<tr><td>${esc(i.empresa)}<div class="mut">${esc(i.segmento)} · ${dtBR(i.data)}</div></td><td><button class="btn sm" data-r="${i.id}">Restaurar</button></td></tr>`).join('')}</tbody></table>` : '<div class="vazio">Nada excluído.</div>'}<div class="foot"><button class="btn" data-close>Fechar</button></div>`,
    (bg, close) => bg.querySelectorAll('[data-r]').forEach(b => b.onclick = async () => { try { await api(`/api/cards/${b.dataset.r}/restaurar`, 'POST', {}); toast('Card restaurado'); close(); telaFila(); } catch (e) { falha(e); } }));
}
function modalAlterar(ids, dataPadrao = '') {
  modal(`<h2>Alterar visita</h2><div class="mut">${ids.length} card(s)</div><div class="f"><span>Nova data</span><input type="date" id="a_data" value="${esc(dataPadrao)}"></div><div class="f"><span>Motivo (obrigatório; classe E é livre)</span><textarea id="a_mot" rows="3"></textarea></div><div class="foot"><button class="btn" data-close>Cancelar</button><button class="btn pri" id="a_ok">Salvar</button></div>`,
    (bg, close) => bg.querySelector('#a_ok').onclick = async () => {
      const data = bg.querySelector('#a_data').value, motivo = bg.querySelector('#a_mot').value;
      try {
        if (ids.length === 1) await api(`/api/cards/${ids[0]}/reprogramar`, 'POST', { data, motivo });
        else { const r = await api('/api/reprogramar-grupo', 'POST', { ids, data, motivo }); const err = r.resultados.filter(x => x.ok === false); if (err.length) toast(`${err.length} falhou: ${err[0].erro}`); }
        S.sel.clear(); close(); toast('Data alterada'); telaFila();
      } catch (e) { falha(e); }
    });
}
async function modalNao(id) {
  const f = await api(`/api/cards/${id}/form`);
  modal(`<h2>Visita não realizada</h2><div class="mut">${esc(f.card.titulo)}</div><div class="f"><span>Motivo</span><select id="n_mot"><option value="">Selecione…</option>${f.motivos.map(m => `<option>${esc(m)}</option>`).join('')}</select></div><div class="f"><span>Detalhe</span><textarea id="n_det" rows="3"></textarea></div><div class="foot"><button class="btn" data-close>Cancelar</button><button class="btn pri" id="n_ok">Confirmar</button></div>`,
    (bg, close) => bg.querySelector('#n_ok').onclick = async () => { try { await api(`/api/cards/${id}/nao-realizada`, 'POST', { motivo: bg.querySelector('#n_mot').value, detalhe: bg.querySelector('#n_det').value }); close(); toast('Registrado como não realizada'); telaFila(); } catch (e) { falha(e); } });
}
const arq64 = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok({ nome: f.name, base64: String(r.result).split(',')[1] }); r.onerror = no; r.readAsDataURL(f); });
async function formRegistro(id, editar) {
  const f = await api(`/api/cards/${id}/form`), c = f.card;
  let reg = null; if (editar) reg = await api(`/api/cards/${id}/registro`);
  const sel = (nome, arr, v) => `<select id="r_${nome}"><option value="">—</option>${arr.map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
  const T = (k, rot, rows = 3) => `<div class="f"><span>${rot}</span><textarea id="r_${k}" rows="${rows}">${esc(reg?.[k] || '')}</textarea></div>`;
  const ctSel = new Set(reg?.contatos || []);
  modal(`<h2>${editar ? 'Editar registro' : 'Registrar visita'}</h2><div class="mut">${esc(c.titulo)} · programada para ${dtBR(c.data)}</div>
    <div class="row2"><div class="f"><span>Data/hora da visita *</span><input type="datetime-local" id="r_dataHora" value="${esc((reg?.dataHora || f.hoje + 'T09:00').slice(0, 16))}" max="${f.hoje}T23:59"></div>
    ${f.campos.supervisor ? `<div class="f"><span>Supervisor que acompanhou</span><select id="r_supervisor"><option value="">Nenhum</option>${f.supervisores.map(s => `<option value="${s.id}" ${reg?.supervisor === s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}</select></div>` : ''}</div>
    <div class="f"><span>Contatos / participantes</span><div class="contatos">${f.contatos.length ? f.contatos.map(k => `<label title="${esc(k.telefone)}"><input type="checkbox" value="${k.id}" ${ctSel.has(k.id) ? 'checked' : ''}> ${esc(k.nome)} <span class="mut">${esc(k.cargo)} ${k.telefone ? '· ' + esc(k.telefone) : ''}</span></label>`).join('') : '<span class="mut">Esta empresa não tem contatos cadastrados.</span>'}</div></div>
    ${T('fatos', 'Fatos e dados *', 4)}${T('interesses', 'Interesses')}${T('sentimentos', 'Sentimentos')}${T('valores', 'Valores')}${f.campos.populacao ? T('populacao', 'População de motores', 6) : ''}
    <div class="row2">${f.opcoes.regime.length ? `<div class="f"><span>Regime de trabalho</span>${sel('regime', f.opcoes.regime, reg?.regime)}</div>` : ''}${f.opcoes.oportunidades.length ? `<div class="f"><span>Oportunidades futuras</span>${sel('oportunidades', f.opcoes.oportunidades, reg?.oportunidades)}</div>` : ''}
    ${f.opcoes.antecipada.length ? `<div class="f"><span>Reunião antecipada?</span>${sel('antecipada', f.opcoes.antecipada, reg?.antecipada)}</div>` : ''}${f.opcoes.acompanhamento.length ? `<div class="f"><span>Acompanhamento</span>${sel('acompanhamento', f.opcoes.acompanhamento, reg?.acompanhamento)}</div>` : ''}</div>
    ${T('resultado', 'Resultado / observações')}${f.campos.anexos ? '<div class="f"><span>Anexos (até 10; 20 MB no total)</span><input type="file" id="r_anexos" multiple></div>' : ''}
    <div class="foot"><button class="btn" data-close>Cancelar</button><button class="btn pri" id="r_ok">${editar ? 'Salvar alterações' : 'Registrar visita'}</button></div>`,
    (bg, close) => bg.querySelector('#r_ok').onclick = async ev => {
      const g = k => bg.querySelector('#r_' + k)?.value || '';
      const b = { dataHora: g('dataHora'), fatos: g('fatos'), interesses: g('interesses'), sentimentos: g('sentimentos'), valores: g('valores'), populacao: g('populacao'), regime: g('regime'), oportunidades: g('oportunidades'), antecipada: g('antecipada'), acompanhamento: g('acompanhamento'), resultado: g('resultado'), supervisor: g('supervisor'),
        contatos: [...bg.querySelectorAll('.contatos input:checked')].map(x => +x.value) };
      const files = [...(bg.querySelector('#r_anexos')?.files || [])];
      if (files.reduce((s, x) => s + x.size, 0) > 20e6) return toast('Anexos passam de 20 MB.');
      ev.target.disabled = true;
      try {
        b.anexos = await Promise.all(files.slice(0, 10).map(arq64));
        if (editar) await api(`/api/registros/${reg.id}/editar`, 'POST', b); else await api(`/api/cards/${id}/registrar`, 'POST', b);
        close(); toast(editar ? 'Registro atualizado' : 'Visita registrada. Próxima visita gerada.'); recarrega();
      } catch (e) { ev.target.disabled = false; falha(e); }
    });
}
async function verRegistro(id) {
  const r = await api(`/api/cards/${id}/registro`);
  const L = [['Data/hora', dthBR(r.dataHora)], ...(r.campos && r.campos.length ? r.campos.map(c => [c.label, c.valor]) : [['Fatos e dados', r.fatos], ['Interesses', r.interesses], ['Sentimentos', r.sentimentos], ['Valores', r.valores], ['População de motores', r.populacao], ['Regime de trabalho', r.regime], ['Oportunidades futuras', r.oportunidades], ['Reunião antecipada', r.antecipada], ['Resultado', r.resultado], ['Acompanhamento', r.acompanhamento]])].filter(x => x[1]);
  modal(`<h2>Registro de visita</h2><div class="mut">${L.length} campo(s) preenchido(s)</div>${L.map(([k, v]) => `<div class="f"><span>${esc(k)}</span><div style="white-space:pre-wrap">${esc(v)}</div></div>`).join('')}${r.anexos.length ? `<div class="f"><span>Anexos</span>${r.anexos.map((a, n) => `<a href="${/^https?:\/\//.test(a.url) ? esc(a.url) : '#'}" target="_blank" rel="noopener noreferrer">Anexo ${n + 1}</a>`).join(' · ')}</div>` : ''}<div class="foot"><button class="btn" data-close>Fechar</button><button class="btn pri" id="v_ed">✎ Editar</button></div>`,
    (bg, close) => bg.querySelector('#v_ed').onclick = () => { close(); formRegistro(id, true).catch(falha); });
}

// ----- Visita Alterada -----
let altPg = 1;
async function telaAlt() {
  gen.n++; const r = await vapi('/api/historico?page=' + altPg), h = r.itens;
  $('#app').innerHTML = h.length ? `<div class="scroll"><table><thead><tr><th>Quando</th><th>Empresa</th><th>Segmento</th><th>Vendedor</th><th>De</th><th>Para</th><th>Motivo</th><th>Quem alterou</th></tr></thead><tbody>${h.map(x => `<tr><td>${dthBR(x.at)}</td><td>${esc(x.titulo)}</td><td>${esc(x.segmento)}</td><td>${esc(x.vendedor)}</td><td>${dtBR(x.de)}</td><td>${dtBR(x.para)}</td><td>${esc(x.motivo)}</td><td>${esc(x.usuario)}</td></tr>`).join('')}</tbody></table></div><div class="filtros" style="justify-content:center;margin-top:12px"><button class="btn sm" id="h_a" ${r.page <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="mut">Página ${r.page} de ${r.pages}</span><button class="btn sm" id="h_p" ${r.page >= r.pages ? 'disabled' : ''}>Próxima ›</button></div>` : `<div class="vazio">${ico('inbox')}Nenhuma data alterada ainda.</div>`;
  if ($('#h_a')) { $('#h_a').onclick = () => { altPg--; telaAlt(); }; $('#h_p').onclick = () => { altPg++; telaAlt(); }; }
}

// ----- Dashboard interativo -----
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesRot = m => `${MESES[+m.slice(5, 7) - 1]}/${m.slice(2, 4)}`;
const recarrega = () => (S.aba === 'dash' ? telaDash() : telaFila());
const GRUPOS = [['realizadas', 'Realizadas', 'var(--e-enc)'], ['abertas', 'Em aberto', 'var(--e-new)'], ['atrasadas', 'Atrasadas', 'var(--e-late)'], ['nao', 'Não realizadas', 'var(--e-nao)']];
const D = { f: { de: '', ate: '', segmento: '', vendedor: '', classe: '', etapa: '', motivo: '' }, preset: '6m', mes: '', q: '', page: 1 };
function periodo(preset, hoje) {
  const [y, m] = hoje.split('-').map(Number), ini = n => { const t = y * 12 + (m - 1) - (n - 1); return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}-01`; };
  return { '3m': ini(3), '6m': ini(6), '12m': ini(12), ano: `${y}-01-01`, tudo: '' }[preset] ?? '';
}
const qsDash = () => new URLSearchParams(Object.entries(D.f).filter(([, v]) => v)).toString();
function tip(el, txt) { el.dataset.tip = txt; el.setAttribute('aria-label', txt); }
function stack(o, max) {   // segmentos empilhados horizontais, com vão de 2px entre preenchimentos
  return GRUPOS.map(([k, n, c]) => o[k] ? `<i style="width:${(o[k] / max) * 100}%;background:${c}" data-tip="${esc(n)}: ${o[k]}"></i>` : '').join('');
}
function linhas(arr, campo, sel, vazio) {
  const max = Math.max(1, ...arr.map(x => x.total));
  if (!arr.length || !arr.some(x => x.total)) return `<div class="mut">${vazio || 'Sem dados no período.'}</div>`;
  return arr.map(x => { const val = campo === 'vendedor' ? x.id : x.nome, on = sel && String(sel) === String(val);
    return `<button class="hb ${on ? 'on' : sel ? 'dim' : ''}" data-f="${campo}" data-v="${esc(val)}" data-tip="${esc(x.nome)} · ${x.total} no total · ${x.realizadas} realizadas · ${x.atrasadas} atrasadas · ${x.nao} não realizadas"><span class="hn">${esc(campo === 'classe' ? 'Classe ' + x.nome : x.nome)}</span><span class="ht">${stack(x, max)}</span><b>${x.total}</b></button>`; }).join('');
}
function filtrosAtivos(d) {
  const f = D.f, ch = [];
  if (D.mes) ch.push(['mes', `Mês: ${mesRot(D.mes)}`]);
  if (f.segmento) ch.push(['segmento', `Segmento: ${f.segmento}`]);
  if (f.vendedor) ch.push(['vendedor', `Vendedor: ${d.opcoes.vendedores.find(v => v.id === f.vendedor)?.nome || f.vendedor}`]);
  if (f.classe) ch.push(['classe', `Classe ${f.classe}`]);
  if (f.etapa) ch.push(['etapa', `Etapa: ${ETAPAS[f.etapa] || f.etapa}`]);
  if (f.motivo) ch.push(['motivo', `Motivo: ${f.motivo}`]);
  return ch.length ? `<div class="chips">${ch.map(([k, t]) => `<span class="chip">${esc(t)}<button data-x="${k}" aria-label="Remover filtro">✕</button></span>`).join('')}<button class="btn sm" data-x="tudo">Limpar tudo</button></div>` : '';
}
async function telaDash() {
  gen.n++; const app = $('#app'), hoje = S.eu.hoje;
  if (!$('#dash')) { app.innerHTML = `<div id="dash"><div class="kpis">${'<div class="sk" style="height:76px"></div>'.repeat(6)}</div><div class="dash">${'<div class="sk" style="height:260px"></div>'.repeat(4)}</div></div>`; }
  else $('#dash').classList.add('busy');
  if (!D.mes) { D.f.de = periodo(D.preset, hoje); D.f.ate = ''; }
  const qs = qsDash(), d = await vapi('/api/dashboard?' + qs), k = d.kpis;
  const tile = (n, rot, e, extra = '') => `<button class="kpi-t ${D.f.etapa === e && e ? 'on' : ''}" ${e ? `data-e="${e}"` : ''} data-kpi="${e}" ${extra}><b>${n}</b><span>${rot}</span></button>`;
  const maxM = Math.max(1, ...d.serie.map(x => x.total));
  $('#dash').classList.remove('busy');
  $('#dash').innerHTML = `
  <div class="filtros dfil"><div class="seg" role="group" aria-label="Período">${[['3m', '3 meses'], ['6m', '6 meses'], ['12m', '12 meses'], ['ano', 'Este ano'], ['tudo', 'Tudo']].map(([p, n]) => `<button class="btn ${!D.mes && D.preset === p ? 'on' : ''}" data-p="${p}">${n}</button>`).join('')}</div>
    <label>Segmento<select id="d_segmento"><option value="">Todos</option>${d.opcoes.segmentos.map(x => `<option ${D.f.segmento === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
    <label>Vendedor<select id="d_vendedor"><option value="">Todos</option>${d.opcoes.vendedores.map(x => `<option value="${esc(x.id)}" ${D.f.vendedor === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
    <label>Classe<select id="d_classe"><option value="">Todas</option>${d.opcoes.classes.map(x => `<option ${D.f.classe === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <div class="count">Período pela data programada · clique nos gráficos para filtrar</div></div>
  ${filtrosAtivos(d)}
  <div class="kpis">${tile(k.programadas, 'Programadas', '')}${tile(k.realizadas, 'Realizadas', 'ENC')}${tile(k.abertas, 'Em aberto', 'NEW')}${tile(k.atrasadas, 'Atrasadas', 'LATE')}${tile(k.naoRealizadas, 'Não realizadas', 'NAOREAL')}
    <div class="kpi-t static" data-e="${k.taxa === null ? '' : k.taxa >= 80 ? 'ENC' : k.taxa >= 50 ? 'PREPARATION' : 'LATE'}"><b>${k.taxa === null ? '—' : k.taxa + '%'}</b><span>Taxa de realização</span><div class="meter"><i style="width:${k.taxa || 0}%"></i></div></div>
    <div class="kpi-t static"><b>${k.reprogramacoes}</b><span>Reprogramações</span></div></div>
  <div class="dash">
    <section class="sec wide"><h3>Visitas por mês</h3><div class="leg">${GRUPOS.map(([, n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('')}</div>
      ${d.serie.length ? `<div class="mcols" role="group" aria-label="Visitas por mês">${d.serie.map(x => `<button class="mcol ${D.mes === x.mes ? 'on' : D.mes ? 'dim' : ''}" data-mes="${x.mes}" data-tip="${mesRot(x.mes)} · ${x.total} programadas · ${x.realizadas} realizadas · ${x.abertas} em aberto · ${x.atrasadas} atrasadas · ${x.nao} não realizadas"><b>${x.total}</b><span class="stk" style="height:${Math.max(4, (x.total / maxM) * 150)}px">${[...GRUPOS].map(([g, , c]) => x[g] ? `<i style="flex:${x[g]};background:${c}"></i>` : '').join('')}</span><em>${mesRot(x.mes)}</em></button>`).join('')}</div>
      <details class="tb"><summary>Ver dados em tabela</summary><div class="scroll"><table><thead><tr><th>Mês</th>${GRUPOS.map(g => `<th>${g[1]}</th>`).join('')}<th>Total</th></tr></thead><tbody>${d.serie.map(x => `<tr><td>${mesRot(x.mes)}</td>${GRUPOS.map(([g]) => `<td>${x[g]}</td>`).join('')}<td>${x.total}</td></tr>`).join('')}</tbody></table></div></details>` : '<div class="mut">Sem visitas no período.</div>'}</section>
    <section class="sec"><h3>Por vendedor</h3><div class="hbs">${linhas(d.porVendedor, 'vendedor', D.f.vendedor)}</div></section>
    <section class="sec"><h3>Por segmento</h3><div class="hbs">${linhas(d.porSegmento, 'segmento', D.f.segmento)}</div><h3 style="margin-top:18px">Por classe</h3><div class="hbs">${linhas(d.porClasse, 'classe', D.f.classe)}</div></section>
    <section class="sec"><h3>Motivos das não realizadas</h3>${d.motivos.length ? `<div class="hbs">${(() => { const mx = Math.max(...d.motivos.map(x => x.n)); return d.motivos.map(x => `<button class="hb mono ${D.f.motivo === x.nome ? 'on' : D.f.motivo ? 'dim' : ''}" data-f="motivo" data-v="${esc(x.nome)}" data-tip="${esc(x.nome)}: ${x.n}"><span class="hn">${esc(x.nome)}</span><span class="ht"><i style="width:${(x.n / mx) * 100}%;background:var(--pri)"></i></span><b>${x.n}</b></button>`).join(''); })()}</div>` : '<div class="mut">Nenhuma não realizada no período.</div>'}</section>
  </div>
  <section class="sec" id="regs"><div class="rh"><h3>Registros de visita</h3><input type="search" id="r_q" placeholder="Buscar empresa, vendedor ou texto…" value="${esc(D.q)}" aria-label="Buscar registros"></div><div id="regs_corpo"><div class="sk" style="height:120px"></div></div></section>`;
  ligaDash(d); registrosDash();
}
async function registrosDash() {
  const r = await vapi('/api/registros?' + new URLSearchParams({ ...Object.fromEntries(Object.entries(D.f).filter(([, v]) => v)), q: D.q, page: D.page }).toString()), C = $('#regs_corpo');
  if (!C) return;
  if (!r.itens.length) { C.innerHTML = `<div class="vazio">${ico('inbox')}<b>Nenhum registro encontrado</b><div>Mude os filtros ou a busca.</div></div>`; return; }
  C.innerHTML = `<div class="scroll rtab"><table><thead><tr><th>Data</th><th>Empresa</th><th>Segmento</th><th>Vendedor</th>${r.colunas.map(c => `<th>${esc(c.label)}</th>`).join('')}<th class="acol"></th></tr></thead><tbody>${r.itens.map(x => `<tr><td style="white-space:nowrap">${dthBR(x.dataHora)}</td><td style="min-width:200px"><b>${esc(x.empresa)}</b> <span class="cls ${esc(x.classe)}">${esc(x.classe || '–')}</span></td><td>${esc(x.segmento)}</td><td>${esc(x.vendedor)}</td>${r.colunas.map(c => { const v = x.valores[c.k] || ''; return `<td class="cel"><div class="clamp" ${v.length > 90 ? `title="${esc(v.slice(0, 600))}"` : ''}>${v ? esc(v) : '<span class="mut">—</span>'}</div></td>`; }).join('')}<td class="acol"><div class="acoes" style="border:0;padding:0;margin:0;flex-wrap:nowrap"><button class="btn sm" data-ver="${x.idFila}">Ver</button>${x.podeEditar ? `<button class="btn sm" data-edit="${x.idFila}">${ico('edit')}Editar</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>
    <div class="filtros" style="justify-content:center;margin:12px 0 0;border:0;box-shadow:none;background:none"><button class="btn sm" data-rp="-1" ${r.page <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="mut">Página ${r.page} de ${r.pages} · ${r.total} registro(s) · ${r.colunas.length} campos</span><button class="btn sm" data-rp="1" ${r.page >= r.pages ? 'disabled' : ''}>Próxima ›</button></div>`;
  C.querySelectorAll('[data-rp]').forEach(b => b.onclick = () => { D.page += +b.dataset.rp; registrosDash(); });
  C.querySelectorAll('[data-ver]').forEach(b => b.onclick = () => verRegistro(+b.dataset.ver).catch(falha));
  C.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => formRegistro(+b.dataset.edit, true).catch(falha));
}
function ligaDash(d) {
  const F = D.f, muda = () => { D.page = 1; telaDash().catch(falha); };
  document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { D.preset = b.dataset.p; D.mes = ''; muda(); });
  [['segmento', 'd_segmento'], ['vendedor', 'd_vendedor'], ['classe', 'd_classe']].forEach(([k, id]) => $('#' + id).onchange = e => { F[k] = e.target.value; muda(); });
  document.querySelectorAll('[data-kpi]').forEach(b => b.onclick = () => { F.etapa = b.dataset.kpi && F.etapa !== b.dataset.kpi ? b.dataset.kpi : ''; muda(); });
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { F[b.dataset.f] = F[b.dataset.f] === b.dataset.v ? '' : b.dataset.v; muda(); });
  document.querySelectorAll('[data-mes]').forEach(b => b.onclick = () => {
    if (D.mes === b.dataset.mes) { D.mes = ''; } else { D.mes = b.dataset.mes; const [y, m] = D.mes.split('-').map(Number); F.de = `${D.mes}-01`; F.ate = `${D.mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; }
    if (!D.mes) { F.de = periodo(D.preset, S.eu.hoje); F.ate = ''; }
    D.page = 1; telaDash().catch(falha);
  });
  document.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { const k = b.dataset.x; if (k === 'tudo') { D.mes = ''; Object.keys(F).forEach(x => F[x] = ''); } else if (k === 'mes') D.mes = ''; else F[k] = ''; muda(); });
  let t; $('#r_q').oninput = e => { clearTimeout(t); t = setTimeout(() => { D.q = e.target.value; D.page = 1; registrosDash().catch(falha); }, 300); };
}
// Dica ao passar o mouse (uma só, seguindo o cursor) para qualquer elemento com data-tip.
(() => {
  const t = document.createElement('div'); t.className = 'tipbox'; t.setAttribute('role', 'tooltip'); t.hidden = true; document.body.append(t);
  const pos = e => { const el = e.target.closest?.('[data-tip]'); if (!el) { t.hidden = true; return; } t.textContent = el.dataset.tip; t.hidden = false; const w = t.offsetWidth; t.style.left = Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 12)) + 'px'; t.style.top = (e.clientY + 18) + 'px'; };
  document.addEventListener('mousemove', pos); document.addEventListener('mouseleave', () => t.hidden = true);
  document.addEventListener('focusin', e => { const el = e.target.closest?.('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); t.textContent = el.dataset.tip; t.hidden = false; t.style.left = Math.max(8, r.left) + 'px'; t.style.top = r.bottom + 6 + 'px'; } });
  document.addEventListener('focusout', () => t.hidden = true);
})();

// ----- Configurações -----
const lista = (id, ids, nomes) => `<div class="chips" id="${id}">${ids.map(i => `<span class="chip">${esc(nomes[i] || '#' + i)}<button data-rm="${i}" aria-label="Remover">✕</button></span>`).join('') || '<span class="mut">ninguém</span>'}</div>`;
async function telaCfg() {
  gen.n++;
  const { config: c, motivosPadrao } = await vapi('/api/config'), A = $('#app');
  const ids = [...new Set([...c.verTudo, ...c.admins, ...c.podeExcluir, ...c.supervisoresExtras])];
  const w = S.eu.webhook, ok = (url, vazio) => vapi(url).catch(e => { if (e instanceof Stale) throw e; return vazio === 'erro' ? { erro: e.message } : vazio; });
  const [nomes, info, depts, log] = await Promise.all([w && ids.length ? ok('/api/nomes?ids=' + ids.join(','), {}) : {}, w ? ok('/api/campos', 'erro') : null, w ? ok('/api/departamentos', []) : [], w ? ok('/api/log', []) : []]);
  A.innerHTML = `
  <div class="sec"><h3>Conexão com o Bitrix24</h3>${S.eu.webhook ? '<div>✅ Webhook configurado.</div>' : '<div class="aviso">Informe o webhook de entrada (permissões: crm, task, user, department, entity, im).</div>'}
    <div class="row2"><input id="c_wh" type="password" placeholder="https://seu-portal.bitrix24.com.br/rest/1/CODIGO/" autocomplete="off"><button class="btn pri" id="c_whb">Salvar webhook</button></div></div>
  <div class="sec"><h3>Fila</h3><label><input type="checkbox" id="c_ativo" ${c.ativo ? 'checked' : ''}> <b>Fila ativa</b> (gera, move e encerra cards automaticamente)</label>
    <div class="acoes" style="margin-top:8px"><button class="btn" id="c_prev">Prévia da sincronização</button><button class="btn" id="c_sync">Sincronizar agora</button><button class="btn" id="c_prep">Preparar Bitrix (etapas e campos)</button></div><pre id="c_out" class="mut" style="white-space:pre-wrap"></pre></div>
  <div class="sec"><h3>Intervalos por classe</h3><div class="row2">${['A', 'B', 'C'].map(k => `<label class="f"><span>Classe ${k}: dias entre visitas / período da 1ª visita (dias úteis)</span><span style="display:flex;gap:6px"><input type="number" min="1" id="c_i${k}" value="${c.intervalos[k]}"><input type="number" min="1" id="c_p${k}" value="${c.periodos[k]}"></span></label>`).join('')}
    <label class="f"><span>Classe E: meses entre visitas / mês da 1ª visita</span><span style="display:flex;gap:6px"><input type="number" min="1" id="c_iE" value="${c.intervalos.E}"><input type="number" min="1" max="12" id="c_mE" value="${c.mesClasseE}"></span></label></div></div>
  <div class="sec"><h3>Regras</h3>
    <div class="mut">Cargos que geram fila</div><div>${['Diretor', 'Gerente', 'Coordenador', 'Supervisor', 'Vendedor'].map(k => `<label style="margin-right:12px"><input type="checkbox" name="c_cargo" value="${k}" ${c.cargosFila.includes(k) ? 'checked' : ''}> ${k}</label>`).join('')}</div>
    <div style="margin-top:6px"><label><input type="checkbox" id="c_tarefa" ${c.tarefaAtiva ? 'checked' : ''}> Criar tarefa para o vendedor nas não realizadas</label></div>
    <div><label><input type="checkbox" id="c_atu" ${c.atualizarProxima ? 'checked' : ''}> Atualizar "Última/Próxima visita" no cadastro da empresa</label></div>
    <div><label><input type="checkbox" id="c_sem" ${c.removerSemClasse ? 'checked' : ''}> Remover cards de empresas sem classe</label></div>
    <div class="row2" style="margin-top:6px"><label class="f"><span>Hora do job diário (Brasília)</span><input type="number" min="0" max="23" id="c_hora" value="${c.horaJob}"></label><label class="f"><span>Varredura (segundos)</span><input type="number" min="10" id="c_sw" value="${c.sweepSegundos}"></label></div></div>
  <div class="sec"><h3>Motivos da não realização</h3><textarea id="c_mot" rows="6">${esc(c.motivosNaoRealizada.join('\n'))}</textarea><div class="mut">Um por linha. Padrão: ${esc(motivosPadrao.length)} motivos.</div></div>
  <div class="sec"><h3>Departamentos com acesso ao app</h3><div class="mut">Marque os departamentos que podem usar o app (subdepartamentos incluídos). Nenhum marcado = todos do portal. Administradores sempre têm acesso.</div>
    ${depts.length ? `<div style="columns:2 260px;margin-top:6px">${(() => { const nivel = d => { let n = 0, x = d; while (x && x.pai && depts.find(y => y.id === x.pai) && n < 8) { x = depts.find(y => y.id === x.pai); n++; } return n; }; return depts.map(d => `<label style="display:block;padding-left:${nivel(d) * 16}px;break-inside:avoid"><input type="checkbox" name="c_dept" value="${esc(d.id)}" ${c.deptsAcesso.includes(d.id) ? 'checked' : ''}> ${esc(d.nome)}</label>`).join(''); })()}</div>` : '<div class="mut">Nenhum departamento encontrado (o webhook precisa da permissão department).</div>'}</div>
  ${[['verTudo', 'Quem vê tudo'], ['podeExcluir', 'Quem pode excluir'], ['admins', 'Acesso à configuração (além dos administradores do portal)'], ['supervisoresExtras', 'Supervisores (lista extra)']].map(([k, t]) => `<div class="sec"><h3>${t}</h3>${lista('l_' + k, c[k], nomes)}<div style="display:flex;gap:6px"><input id="q_${k}" placeholder="Buscar usuário (2+ letras)" style="flex:1"><select id="s_${k}" style="min-width:160px"></select><button class="btn" id="a_${k}">Adicionar</button></div></div>`).join('')}
  <div class="sec"><h3>Campos mapeados</h3>${!info ? '<div class="mut">Conecte o webhook primeiro.</div>' : info.erro ? `<div class="aviso erro">${esc(info.erro)}</div>` : `${info.faltando.length ? `<div class="aviso">Faltando:<br>${info.faltando.map(esc).join('<br>')}<br>Use “Preparar Bitrix” para criar o que for possível.</div>` : '<div>✅ Tudo mapeado.</div>'}<div class="scroll"><table><thead><tr><th>Segmento</th><th>Cargos</th><th>Classe</th><th>Próxima</th><th>Última</th></tr></thead><tbody>${info.segmentos.map(s => `<tr><td>${esc(s.nome)}${s.duplicados ? ' <span class="tag warn">campos duplicados</span>' : ''}</td><td>${s.cargos.map(esc).join(', ')}</td><td>${s.classe}</td><td>${s.proxima}</td><td>${s.ultima}</td></tr>`).join('')}</tbody></table></div>`}</div>
  ${info && !info.erro && info.disponiveis ? `<div class="sec"><h3>Campos usados pelo app</h3><div class="mut">O app acha os campos pelo nome. Se alguma coluna vier vazia (ex.: a data da Fila ou "Fatos e dados" do registro), escolha aqui o campo certo. Os campos do registro que não estão aqui continuam aparecendo no painel e em "Ver registro".</div>
    <h4 style="margin:14px 0 4px">Fila (SPA de cards)</h4><div class="row2">${[['data', 'Data programada'], ['vendedor', 'Vendedor (vazio = responsável do card)'], ['segmento', 'Segmento'], ['classe', 'Classe'], ['cargo', 'Cargo']].map(([k, t]) => `<label class="f"><span>${t} · detectado: <b>${esc(info.fila[k] || 'não encontrado')}</b></span><select data-mapa="${k}"><option value="">(automático)</option>${info.disponiveis.map(d => `<option value="${esc(d.key)}" ${info.mapa[k] === d.key ? 'selected' : ''}>${esc(d.label)} · ${esc(d.key)}${d.type ? ' (' + esc(d.type) + ')' : ''}</option>`).join('')}</select></label>`).join('')}</div>
    <h4 style="margin:14px 0 4px">Registro de visita (SPA de registros)</h4><div class="row2">${[['data', 'Data/hora da visita'], ['fatos', 'Fatos e dados'], ['interesses', 'Interesses'], ['sentimentos', 'Sentimentos'], ['valores', 'Valores'], ['populacao', 'População de motores'], ['regime', 'Regime de trabalho'], ['oportunidades', 'Oportunidades futuras'], ['antecipada', 'Reunião antecipada'], ['resultado', 'Resultado / observações'], ['acompanhamento', 'Acompanhamento'], ['anexos', 'Anexos'], ['supervisor', 'Supervisor que acompanhou'], ['idFila', 'ID Fila (liga ao card)'], ['segmento', 'Segmento']].map(([k, t]) => `<label class="f"><span>${t} · detectado: <b>${esc(info.visitaDetectada[k] || 'não encontrado')}</b></span><select data-mapav="${k}"><option value="">(automático)</option>${info.disponiveisVisita.map(d => `<option value="${esc(d.key)}" ${info.mapaVisita[k] === d.key ? 'selected' : ''}>${esc(d.label)} · ${esc(d.key)}${d.type ? ' (' + esc(d.type) + ')' : ''}</option>`).join('')}</select></label>`).join('')}</div>
    <div class="foot" style="margin:12px 0 0;padding:0;background:none;border:0;position:static"><button class="btn pri" id="c_mapa">Salvar mapeamento</button></div></div>` : ''}
  <div class="sec"><h3>Log</h3><div class="scroll" style="max-height:260px;overflow:auto"><table><tbody>${log.map(l => `<tr><td>${dthBR(l.at)}</td><td>${esc(l.type)}</td><td>${esc(l.msg)}</td></tr>`).join('') || '<tr><td class="mut">Sem registros.</td></tr>'}</tbody></table></div></div>
  <div class="foot"><button class="btn pri" id="c_save">Salvar configurações</button></div>`;
  const draft = { verTudo: [...c.verTudo], podeExcluir: [...c.podeExcluir], admins: [...c.admins], supervisoresExtras: [...c.supervisoresExtras] };
  for (const k of Object.keys(draft)) {
    const redesenha = () => { $('#l_' + k).outerHTML = lista('l_' + k, draft[k], nomes); lig(); };
    const lig = () => $('#l_' + k).querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { draft[k] = draft[k].filter(x => x !== b.dataset.rm); redesenha(); });
    lig();
    let t; $('#q_' + k).oninput = e => { clearTimeout(t); t = setTimeout(async () => { try { const us = await api('/api/usuarios?q=' + encodeURIComponent(e.target.value)); $('#s_' + k).innerHTML = us.map(u => `<option value="${u.id}">${esc(u.nome)}</option>`).join(''); us.forEach(u => nomes[u.id] = u.nome); } catch (x) { falha(x); } }, 350); };
    $('#a_' + k).onclick = () => { const v = $('#s_' + k).value; if (v && !draft[k].includes(v)) { draft[k].push(v); redesenha(); } };
  }
  const salvar = async extra => {
    const n = id => +$('#' + id).value;
    return api('/api/config', 'PUT', { ...draft, ...extra, intervalos: { A: n('c_iA'), B: n('c_iB'), C: n('c_iC'), E: n('c_iE') }, periodos: { A: n('c_pA'), B: n('c_pB'), C: n('c_pC') }, mesClasseE: n('c_mE'), horaJob: n('c_hora'), sweepSegundos: n('c_sw'),
      cargosFila: [...document.querySelectorAll('[name=c_cargo]:checked')].map(x => x.value), tarefaAtiva: $('#c_tarefa').checked, atualizarProxima: $('#c_atu').checked, removerSemClasse: $('#c_sem').checked, ativo: $('#c_ativo').checked, ...(depts.length ? { deptsAcesso: [...document.querySelectorAll('[name=c_dept]:checked')].map(x => x.value) } : {}),
      motivosNaoRealizada: $('#c_mot').value.split('\n') });
  };
  $('#c_save').onclick = async () => { try { await salvar(); S.eu = await api('/api/eu'); toast('Configurações salvas'); } catch (e) { falha(e); } };
  if ($('#c_mapa')) $('#c_mapa').onclick = async () => { try { const fila = {}, visita = {}; document.querySelectorAll('[data-mapa]').forEach(x => { if (x.value) fila[x.dataset.mapa] = x.value; }); document.querySelectorAll('[data-mapav]').forEach(x => { if (x.value) visita[x.dataset.mapav] = x.value; }); await api('/api/config', 'PUT', { mapa: { fila, visita } }); toast('Mapeamento salvo'); telaCfg(); } catch (e) { falha(e); } };
  $('#c_whb').onclick = async () => { try { await api('/api/webhook', 'PUT', { webhook: $('#c_wh').value }); S.eu = await api('/api/eu'); toast('Webhook salvo e testado'); telaCfg(); } catch (e) { falha(e); } };
  const rodar = (id, url, body) => $(id).onclick = async ev => { ev.target.disabled = true; $('#c_out').textContent = 'Executando…'; try { await salvar(); $('#c_out').textContent = JSON.stringify(await api(url, 'POST', body), null, 2); } catch (e) { $('#c_out').textContent = e.message; } ev.target.disabled = false; };
  rodar('#c_prev', '/api/sincronizar', { previa: true }); rodar('#c_sync', '/api/sincronizar', { forcar: true }); rodar('#c_prep', '/api/preparar', {});
}

(async () => {
  try { S.eu = await api('/api/eu'); } catch (e) { $('#app').innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; return; }
  tabs(); render();
})();
