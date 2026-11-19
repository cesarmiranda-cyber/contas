const $ = s => document.querySelector(s);
const IC = { cal: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', chart: 'M18 20V10M12 20V4M6 20v-6', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z', inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z', pin: 'M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' };
const ico = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const ini = n => String(n || '').split(/\s+/).map(x => x.replace(/[^\p{L}]/gu, '')).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase() || '?';
const rel = (d, hoje) => { if (!d || !hoje) return ''; const n = Math.round((new Date(d + 'T00:00:00Z') - new Date(hoje + 'T00:00:00Z')) / 864e5); return n === 0 ? 'hoje' : n === 1 ? 'amanhã' : n > 1 ? `em ${n} dias` : n === -1 ? 'ontem' : `há ${-n} dias`; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ETAPAS = { NEW: 'Aguardando', PREPARATION: 'Dia da visita', LATE: 'Atrasada', ENC: 'Encerrado', NAOREAL: 'Não realizada', SUCCESS: 'Finalizado', OUTRA: 'Outra etapa', FAIL: 'Removido' };
const COLS = ['NEW', 'PREPARATION', 'LATE', 'ENC', 'NAOREAL', 'SUCCESS', 'OUTRA'];
const nomeEtapa = i => (i.etapa === 'OUTRA' && i.etapaNome) || ETAPAS[i.etapa] || i.etapa;
const S = { page: 1, size: 50, total: 0, pages: 1, eu: null, aba: 'fila', vista: 'cards', f: { de: '', ate: '', segmento: '', vendedor: '', classe: '', etapa: '', supervisor: '' }, itens: [], sel: new Set(), dashPag: 'fila', cfg: null };
try { Object.assign(S.f, JSON.parse(localStorage.getItem('vis.f') || '{}')); S.vista = localStorage.getItem('vis.v') || 'cards'; } catch {}
const dtBR = d => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
const dthBR = d => (d ? `${dtBR(d)} ${d.length > 10 ? d.slice(11, 16) : ''}` : '—');

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
  return j;
}
let tt; function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.append(t); clearTimeout(tt); tt = setTimeout(() => t.remove(), 3500); setTimeout(() => t.remove(), 3600); }
const falha = e => toast(e.message || String(e));

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
  const app = $('#app');
  if (S.eu.acesso === false) { app.innerHTML = '<div class="aviso erro">Seu departamento não tem acesso ao Registro de Visitas. Peça a um administrador.</div>'; return; }
  if (!S.eu.webhook && S.aba !== 'cfg') { app.innerHTML = `<div class="aviso erro">O Bitrix24 ainda não está conectado ao app. ${S.eu.config ? 'Abra <b>Configurações</b> e informe o webhook de entrada.' : 'Peça a um administrador para concluir a configuração.'}</div>`; return; }
  try { await ({ fila: telaFila, alt: telaAlt, dash: telaDash, cfg: telaCfg }[S.aba])(); } catch (e) { app.innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; }
}

// ----- Registro de Visitas -----
async function telaFila() {
  const app = $('#app');
  if (!$('#fil')) {
    app.innerHTML = `<div class="kpis" id="kpis"></div><div class="filtros" id="fil"></div><div id="lista"><div class="grid">${'<div class="sk"></div>'.repeat(6)}</div></div>`;
  } else $('#lista').classList.add('busy');
  const f = S.f;
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: S.page, pageSize: S.vista === 'kanban' ? 200 : S.size }).toString();
  const r = await api('/api/visitas?' + q);
  S.itens = r.itens; S.total = r.total; S.pages = r.pages; S.page = r.page; S.porEtapa = r.porEtapa || {};
  S.segs = new Set([...(S.segs || []), ...S.itens.map(i => i.segmento).filter(Boolean)]); S.vends = new Map([...(S.vends || []), ...S.itens.map(i => [i.vendedorId, i.vendedor])]); S.hoje = r.hoje;
  const uniq = () => [...S.segs].sort();
  const op = (k, arr, lab = x => x) => `<option value="">Todos</option>` + arr.map(x => `<option value="${esc(x[0] ?? x)}" ${f[k] === String(x[0] ?? x) ? 'selected' : ''}>${esc(lab(x[1] ?? x))}</option>`).join('');
  const vend = [...S.vends.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  $('#fil').innerHTML = `
    <label>De<input type="date" id="f_de" value="${esc(f.de)}"></label><label>Até<input type="date" id="f_ate" value="${esc(f.ate)}"></label>
    <label>Segmento<select id="f_segmento">${op('segmento', uniq())}</select></label>
    <label>Vendedor<select id="f_vendedor">${op('vendedor', vend)}</select></label>
    <label>Classe<select id="f_classe">${op('classe', ['A', 'B', 'C', 'E'])}</select></label>
    <label>Etapa<select id="f_etapa">${op('etapa', COLS.map(c => [c, ETAPAS[c]]))}</select></label>
    <div class="count">${S.total} visita(s)</div><div class="spacer seg">${[['cards', 'Cartões'], ['tabela', 'Tabela'], ['kanban', 'Kanban']].map(([k, n]) => `<button class="btn ${S.vista === k ? 'on' : ''}" data-v="${k}">${n}</button>`).join('')}</div>
    ${S.eu.podeExcluir ? '<button class="btn" id="b_excl">Excluídos</button>' : ''}`;
  ['de', 'ate', 'segmento', 'vendedor', 'classe', 'etapa'].forEach(k => $('#f_' + k).onchange = e => { S.page = 1; f[k] = e.target.value; localStorage.setItem('vis.f', JSON.stringify({ ...f, de: '', ate: '' })); telaFila(); });
  document.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { S.page = 1; S.vista = b.dataset.v; localStorage.setItem('vis.v', S.vista); telaFila(); });
  if ($('#b_excl')) $('#b_excl').onclick = telaExcluidos;
  $('#kpis').innerHTML = ['NEW', 'PREPARATION', 'LATE', 'ENC', 'NAOREAL'].map(c => `<button class="kpi-t ${f.etapa === c ? 'on' : ''}" data-e="${c}" data-kpi="${c}"><b>${S.porEtapa[c] || 0}</b><span>${ETAPAS[c]}</span></button>`).join('');
  document.querySelectorAll('[data-kpi]').forEach(b => b.onclick = () => { f.etapa = f.etapa === b.dataset.kpi ? '' : b.dataset.kpi; S.page = 1; telaFila(); });
  $('#lista').classList.remove('busy');
  desenhaLista();
}
function acoesCard(i) {
  const a = [];
  if (['NEW', 'PREPARATION', 'LATE'].includes(i.etapa)) a.push(`<button class="btn pri sm" data-a="reg" data-id="${i.id}">Registrar visita</button><button class="btn sm" data-a="alt" data-id="${i.id}">Alterar data</button><button class="btn sm" data-a="nao" data-id="${i.id}">Não realizada</button>`);
  if (i.etapa === 'ENC') a.push(`<button class="btn sm" data-a="ver" data-id="${i.id}">Ver registro</button><button class="btn sm" data-a="edit" data-id="${i.id}">✎ Editar</button>`);
  if (i.reprogramado && ['NEW', 'PREPARATION', 'LATE'].includes(i.etapa)) a.push(`<button class="btn sm" data-a="rev" data-id="${i.id}">Reverter data</button>`);
  if (i.podeExcluir && i.etapa !== 'FAIL') a.push(`<button class="btn sm bad" data-a="del" data-id="${i.id}">Excluir</button>`);
  return a.join('');
}
function cardHtml(i) {
  const r = rel(i.data, S.hoje);
  return `<article class="card" data-e="${i.etapa}"><div class="card-h"><h3>${esc(i.empresa)}</h3><span class="tag" data-e="${i.etapa}">${esc(nomeEtapa(i))}</span></div>
    <div class="meta"><span class="cls ${esc(i.classe)}" title="Classe ${esc(i.classe || '—')}">${esc(i.classe || '–')}</span><span>${esc(i.segmento)}</span><span class="who"><span class="av">${esc(ini(i.vendedor))}</span>${esc(i.vendedor)}</span></div>
    <div class="when">${ico('cal')}${dtBR(i.data)}${r ? ` <span class="mut">${r}</span>` : ''}${i.atrasoDias ? ` <span class="tag bad">${i.atrasoDias} dia(s) de atraso</span>` : ''}${i.reprogramado ? ' <span class="tag warn">data alterada</span>' : ''}</div>
    ${i.etapa === 'NAOREAL' && i.motivo ? `<div class="mut">Motivo: ${esc(i.motivo)}${i.detalhe ? ' — ' + esc(i.detalhe) : ''}</div>` : ''}
    <div class="acoes">${acoesCard(i)}</div></article>`;
}
function pager() {
  if (S.pages <= 1 && S.total <= 50) return '';
  return `<div class="filtros" style="justify-content:center;margin-top:12px"><button class="btn sm" data-pg="-1" ${S.page <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="mut">Página ${S.page} de ${S.pages}</span><button class="btn sm" data-pg="1" ${S.page >= S.pages ? 'disabled' : ''}>Próxima ›</button>
    ${S.vista !== 'kanban' ? `<select id="pg_size" aria-label="Itens por página">${[25, 50, 100, 200].map(n => `<option ${n === S.size ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}</div>`;
}
function ligaPager(L) {
  L.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => { S.page += +b.dataset.pg; telaFila(); window.scrollTo(0, 0); });
  if ($('#pg_size')) $('#pg_size').onchange = e => { S.size = +e.target.value; S.page = 1; telaFila(); };
}
function desenhaLista() {
  const L = $('#lista'), it = S.itens;
  if (!it.length) { L.innerHTML = `<div class="vazio">${ico('inbox')}<b>Nenhuma visita encontrada</b><div>Ajuste os filtros ou rode a sincronização em Configurações.</div></div>`; return; }
  if (S.vista === 'cards') L.innerHTML = `<div class="grid">${it.map(cardHtml).join('')}</div>`;
  else if (S.vista === 'kanban') L.innerHTML = `<div class="kanban">${COLS.filter(c => c.length && (['NEW', 'PREPARATION', 'LATE', 'ENC', 'NAOREAL'].includes(c) || it.some(i => i.etapa === c))).map(c => `<div class="col" data-e="${c}"><h4>${ETAPAS[c]} <b>${S.porEtapa[c] ?? it.filter(i => i.etapa === c).length}</b></h4>${it.filter(i => i.etapa === c).map(cardHtml).join('')}</div>`).join('')}</div>`;
  else L.innerHTML = `<div style="margin-bottom:10px"><button class="btn" id="b_grupo" disabled>Alterar data dos selecionados</button></div><div class="scroll"><table><thead><tr><th></th><th>Empresa</th><th>Segmento</th><th>Classe</th><th>Vendedor</th><th>Data</th><th>Etapa</th><th></th></tr></thead><tbody>${it.map(i => `<tr><td>${['NEW', 'PREPARATION', 'LATE'].includes(i.etapa) ? `<input type="checkbox" data-sel="${i.id}" ${S.sel.has(i.id) ? 'checked' : ''}>` : ''}</td><td>${esc(i.empresa)}</td><td>${esc(i.segmento)}</td><td>${esc(i.classe)}</td><td>${esc(i.vendedor)}</td><td>${dtBR(i.data)}</td><td><span class="tag" data-e="${i.etapa}">${esc(nomeEtapa(i))}</span></td><td><div class="acoes">${acoesCard(i)}</div></td></tr>`).join('')}</tbody></table></div>`;
  L.insertAdjacentHTML('beforeend', pager()); ligaPager(L);
  L.querySelectorAll('[data-a]').forEach(b => b.onclick = () => acao(b.dataset.a, +b.dataset.id));
  L.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => { c.checked ? S.sel.add(+c.dataset.sel) : S.sel.delete(+c.dataset.sel); if ($('#b_grupo')) $('#b_grupo').disabled = !S.sel.size; });
  if ($('#b_grupo')) { $('#b_grupo').disabled = !S.sel.size; $('#b_grupo').onclick = () => modalAlterar([...S.sel]); }
}
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
function modalAlterar(ids) {
  modal(`<h2>Alterar visita</h2><div class="mut">${ids.length} card(s)</div><div class="f"><span>Nova data</span><input type="date" id="a_data"></div><div class="f"><span>Motivo (obrigatório; classe E é livre)</span><textarea id="a_mot" rows="3"></textarea></div><div class="foot"><button class="btn" data-close>Cancelar</button><button class="btn pri" id="a_ok">Salvar</button></div>`,
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
        close(); toast(editar ? 'Registro atualizado' : 'Visita registrada. Próxima visita gerada.'); telaFila();
      } catch (e) { ev.target.disabled = false; falha(e); }
    });
}
async function verRegistro(id) {
  const r = await api(`/api/cards/${id}/registro`);
  const L = [['Data/hora', dthBR(r.dataHora)], ['Fatos e dados', r.fatos], ['Interesses', r.interesses], ['Sentimentos', r.sentimentos], ['Valores', r.valores], ['População de motores', r.populacao], ['Regime de trabalho', r.regime], ['Oportunidades futuras', r.oportunidades], ['Reunião antecipada', r.antecipada], ['Resultado', r.resultado], ['Acompanhamento', r.acompanhamento]].filter(x => x[1]);
  modal(`<h2>Registro de visita</h2>${L.map(([k, v]) => `<div class="f"><span>${k}</span><div style="white-space:pre-wrap">${esc(v)}</div></div>`).join('')}${r.anexos.length ? `<div class="f"><span>Anexos</span>${r.anexos.map((a, n) => `<a href="${/^https?:\/\//.test(a.url) ? esc(a.url) : '#'}" target="_blank" rel="noopener noreferrer">Anexo ${n + 1}</a>`).join(' · ')}</div>` : ''}<div class="foot"><button class="btn" data-close>Fechar</button><button class="btn pri" id="v_ed">✎ Editar</button></div>`,
    (bg, close) => bg.querySelector('#v_ed').onclick = () => { close(); formRegistro(id, true).catch(falha); });
}

// ----- Visita Alterada -----
let altPg = 1;
async function telaAlt() {
  const r = await api('/api/historico?page=' + altPg), h = r.itens;
  $('#app').innerHTML = h.length ? `<div class="scroll"><table><thead><tr><th>Quando</th><th>Empresa</th><th>Segmento</th><th>Vendedor</th><th>De</th><th>Para</th><th>Motivo</th><th>Quem alterou</th></tr></thead><tbody>${h.map(x => `<tr><td>${dthBR(x.at)}</td><td>${esc(x.titulo)}</td><td>${esc(x.segmento)}</td><td>${esc(x.vendedor)}</td><td>${dtBR(x.de)}</td><td>${dtBR(x.para)}</td><td>${esc(x.motivo)}</td><td>${esc(x.usuario)}</td></tr>`).join('')}</tbody></table></div><div class="filtros" style="justify-content:center;margin-top:12px"><button class="btn sm" id="h_a" ${r.page <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="mut">Página ${r.page} de ${r.pages}</span><button class="btn sm" id="h_p" ${r.page >= r.pages ? 'disabled' : ''}>Próxima ›</button></div>` : `<div class="vazio">${ico('inbox')}Nenhuma data alterada ainda.</div>`;
  if ($('#h_a')) { $('#h_a').onclick = () => { altPg--; telaAlt(); }; $('#h_p').onclick = () => { altPg++; telaAlt(); }; }
}

// ----- Dashboard -----
const barras = (o, vazio = 'Sem dados') => { const e = Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 15), mx = Math.max(1, ...e.map(x => x[1])); return e.length ? e.map(([k, v]) => `<div class="barra"><span title="${esc(k)}">${esc(ETAPAS[k] || k)}</span><i style="width:${(v / mx) * 100}%"></i><b>${v}</b></div>`).join('') : `<div class="mut">${vazio}</div>`; };
async function telaDash() {
  const d = await api('/api/dashboard'), P = S.dashPag;
  const pag = [['fila', 'Fila'], ['encerradas', 'Encerradas'], ['registros', 'Registros'], ['reprogramacoes', 'Reprogramações'], ['supervisor', 'Supervisor'], ['naoRealizadas', 'Não realizadas']];
  const box = (t, o) => `<div class="sec"><h3>${t}</h3>${barras(o)}</div>`, kpi = (t, n) => `<div class="sec"><div class="mut">${t}</div><div class="kpi">${n}</div></div>`;
  const corpo = {
    fila: () => kpi('Atrasadas', d.fila.atrasadas) + kpi('Dia da visita', d.fila.diaDaVisita) + box('Cards por etapa', d.fila.porEtapa) + box('Em aberto por vendedor', d.fila.porVendedor) + box('Em aberto por classe', d.fila.porClasse) + box('Em aberto por segmento', d.fila.porSegmento),
    encerradas: () => kpi('Encerradas', d.encerradas.total) + box('Por mês', d.encerradas.porMes) + box('Por vendedor', d.encerradas.porVendedor) + box('Por classe', d.encerradas.porClasse) + box('Por segmento', d.encerradas.porSegmento),
    registros: () => kpi('Visitas registradas', d.registros.total) + box('Por mês', d.registros.porMes) + box('Por vendedor', d.registros.porVendedor) + box('Por segmento', d.registros.porSegmento),
    reprogramacoes: () => kpi('Reprogramações', d.reprogramacoes.total) + box('Motivos', d.reprogramacoes.porMotivo) + box('Vendedores que mais reprogramam', d.reprogramacoes.porVendedor),
    supervisor: () => kpi('Visitas acompanhadas', d.supervisor.acompanhadas) + box('Por supervisor', d.supervisor.porSupervisor),
    naoRealizadas: () => kpi('Não realizadas', d.naoRealizadas.total) + box('Motivos', d.naoRealizadas.porMotivo) + box('Vendedores', d.naoRealizadas.porVendedor) + box('Tendência por mês', d.naoRealizadas.porMes),
  }[P]();
  $('#app').innerHTML = `<div class="seg" style="margin-bottom:12px;flex-wrap:wrap">${pag.map(([k, n]) => `<button class="btn ${P === k ? 'on' : ''}" data-p="${k}">${n}</button>`).join('')}</div><div class="dash">${corpo}</div>`;
  document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { S.dashPag = b.dataset.p; telaDash(); });
}

// ----- Configurações -----
const lista = (id, ids, nomes) => `<div class="chips" id="${id}">${ids.map(i => `<span class="chip">${esc(nomes[i] || '#' + i)}<button data-rm="${i}" aria-label="Remover">✕</button></span>`).join('') || '<span class="mut">ninguém</span>'}</div>`;
async function telaCfg() {
  const { config: c, motivosPadrao } = await api('/api/config'), A = $('#app');
  const ids = [...new Set([...c.verTudo, ...c.admins, ...c.podeExcluir, ...c.supervisoresExtras])];
  const nomes = S.eu.webhook && ids.length ? await api('/api/nomes?ids=' + ids.join(',')).catch(() => ({})) : {};
  const info = S.eu.webhook ? await api('/api/campos').catch(e => ({ erro: e.message })) : null;
  const depts = S.eu.webhook ? await api('/api/departamentos').catch(() => []) : [];
  const log = S.eu.webhook ? await api('/api/log').catch(() => []) : [];
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
  $('#c_whb').onclick = async () => { try { await api('/api/webhook', 'PUT', { webhook: $('#c_wh').value }); S.eu = await api('/api/eu'); toast('Webhook salvo e testado'); telaCfg(); } catch (e) { falha(e); } };
  const rodar = (id, url, body) => $(id).onclick = async ev => { ev.target.disabled = true; $('#c_out').textContent = 'Executando…'; try { await salvar(); $('#c_out').textContent = JSON.stringify(await api(url, 'POST', body), null, 2); } catch (e) { $('#c_out').textContent = e.message; } ev.target.disabled = false; };
  rodar('#c_prev', '/api/sincronizar', { previa: true }); rodar('#c_sync', '/api/sincronizar', { forcar: true }); rodar('#c_prep', '/api/preparar', {});
}

(async () => {
  try { S.eu = await api('/api/eu'); } catch (e) { $('#app').innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; return; }
  tabs(); render();
})();
