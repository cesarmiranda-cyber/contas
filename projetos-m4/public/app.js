'use strict';
// ---------- util ----------
const $app = document.getElementById('app'), $tip = document.getElementById('tip');
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else if (k === 'value') e.value = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const api = async (m, url, body) => {
  const r = await fetch(url, { method: m, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.erro || 'Erro inesperado.'), { status: r.status }); return j;
};
const fmt = s => s ? s.split('-').reverse().join('/') : '';
const fmtTs = s => new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const DAY = 864e5, ms = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const iso = t => new Date(t).toISOString().slice(0, 10);
const chip = (cor, txt) => h('span', { class: 'chip ' + cor }, txt);
const COR = { verde: 'No prazo', amarelo: 'Alerta', vermelho: 'Atrasado' };
const LOGO = () => { const d = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); d.setAttribute('viewBox', '0 0 40 40'); d.setAttribute('aria-hidden', 'true');
  const q = [[5, 3], [17.5, 3], [5, 15.5], [17.5, 15.5], [30, 15.5], [17.5, 28]]; // marca da Manda4: 2 + 3 + 1 quadrados arredondados
  d.innerHTML = '<g fill="#f5a400">' + q.map(([x, y]) => `<rect x="${x}" y="${y}" width="9" height="9" rx="3"/>`).join('') + '</g>'; return d; };
const NOME = 'MAND\u039b4'; // "A" sem a barra, como no logotipo
let U = null, view = { nome: 'projetos' };
const go = v => { view = v; render(); };

// ---------- shell ----------
async function boot() { try { U = (await api('GET', '/api/me')).usuario; } catch { U = null; } render(); }
function render() {
  $app.replaceChildren(); $tip.hidden = true;
  if (!U) return $app.append(telaLogin());
  const eq = U.tipo === 'equipe';
  const nav = [['projetos', 'Projetos'], ['solicitacoes', 'Suporte'], ...(eq ? [['clientes', 'Clientes'], ['acessos', 'Acessos e log']] : [])];
  const top = h('header', { class: 'top' }, h('div', { class: 'logo', 'aria-label': 'Manda4 · Projetos e Suporte' }, LOGO(), NOME, h('span', { class: 'logo-sub' }, 'Projetos e Suporte')),
    h('nav', {}, nav.map(([k, t]) => h('a', { class: view.nome === k || (k === 'projetos' && view.nome === 'projeto') ? 'on' : '', onclick: () => go({ nome: k }) }, t))),
    h('span', { class: 'muted small' }, `${U.nome}${eq ? ' · equipe' : ''}`),
    !eq && h('button', { class: 'btn sm', onclick: async () => { await api('POST', '/api/auth/logout', {}); U = null; render(); } }, 'Sair'));
  const main = h('main', { class: 'wrap' }); $app.append(top, main);
  ({ projetos: telaProjetos, projeto: telaProjeto, solicitacoes: telaSolic, clientes: telaClientes, acessos: telaLog }[view.nome])(main).catch(e => main.append(h('div', { class: 'erro' }, e.message)));
}

// ---------- login / cadastro ----------
const NS_SVG = 'http://www.w3.org/2000/svg';
function ilustracao() {
  const d = document.createElementNS(NS_SVG, 'svg'); d.setAttribute('viewBox', '0 0 360 230'); d.setAttribute('class', 'ilus'); d.setAttribute('role', 'img'); d.setAttribute('aria-label', 'Cronograma de projeto com status por cor');
  d.innerHTML = '<rect x="10" y="10" width="340" height="200" rx="16" fill="#fff" stroke="#dbe5f5"/><rect x="10" y="10" width="340" height="34" rx="16" fill="#eef3fb"/><rect x="10" y="30" width="340" height="14" fill="#eef3fb"/>'
    + '<g fill="#cbd6ea"><rect x="26" y="22" width="60" height="8" rx="4"/><rect x="170" y="22" width="40" height="8" rx="4"/><rect x="250" y="22" width="40" height="8" rx="4"/></g>'
    + '<g font-size="10" fill="#5b6479" font-family="Inter,sans-serif"><text x="26" y="72">Levantamento</text><text x="26" y="104">Configuração</text><text x="26" y="136">Integrações</text><text x="26" y="168">Treinamento</text></g>'
    + '<rect x="110" y="60" width="90" height="16" rx="8" fill="#1f9d55"/><rect x="150" y="92" width="110" height="16" rx="8" fill="#e0a800"/><rect x="200" y="124" width="80" height="16" rx="8" fill="#d93636"/><rect x="262" y="156" width="70" height="16" rx="8" fill="#1f9d55"/>'
    + '<g fill="none" stroke="#7d8aa8" stroke-width="1.5"><path d="M200 68 H208 V84 H150" opacity="0"/><path d="M200 68 H212 V100 H215" opacity="0"/><path d="M260 100 H270 V132 H200" opacity="0"/><path d="M280 132 H292 V164 H262" opacity="0"/></g>'
    + '<line x1="236" y1="48" x2="236" y2="200" stroke="#ff6a2b" stroke-width="2"/><circle cx="236" cy="48" r="4" fill="#ff6a2b"/>'
    + '<g fill="#f5a400"><rect x="308" y="186" width="16" height="16" rx="5"/><rect x="328" y="186" width="16" height="16" rx="5"/><rect x="318" y="206" width="16" height="16" rx="5"/></g>';
  return d;
}
function telaLogin(modo = 'login') {
  const err = h('div'), campos = {};
  const f = (k, rot, tipo = 'text', ac) => { campos[k] = h('input', { type: tipo, autocomplete: ac, required: true }); return [h('label', {}, rot), campos[k]]; };
  const cad = modo === 'cadastro';
  const box = h('form', { class: 'cartao', onsubmit: async ev => {
    ev.preventDefault(); err.replaceChildren(); const bt = ev.submitter; bt.disabled = true;
    try { await api('POST', cad ? '/api/auth/cadastro' : '/api/auth/login', Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, v.value]))); await boot(); } catch (e) { err.append(h('div', { class: 'erro' }, e.message)); bt.disabled = false; }
  } }, h('h2', {}, cad ? 'Criar sua conta de cliente' : 'Entrar na área do cliente'), h('p', { class: 'muted small' }, cad ? 'Use o e-mail que a equipe Manda4 tem no seu cadastro. Leva menos de um minuto.' : 'Projetos, documentos e suporte em um só lugar.'),
    cad && f('nome', 'Nome completo', 'text', 'name'), cad && h('div', {}, h('label', {}, 'Empresa'), (campos.empresa = h('input', { autocomplete: 'organization' }))),
    f('email', 'E-mail profissional', 'email', 'email'), f('senha', cad ? 'Senha (mín. 8 caracteres)' : 'Senha', 'password', cad ? 'new-password' : 'current-password'),
    err, h('button', { class: 'btn pri', type: 'submit' }, cad ? 'Criar conta' : 'Entrar'),
    h('p', { class: 'troca muted small' }, cad ? 'Já tem conta? ' : 'Ainda não tem conta? ', h('a', { tabindex: 0, onclick: () => $app.replaceChildren(telaLogin(cad ? 'login' : 'cadastro')) }, cad ? 'Entrar' : 'Criar conta')),
    h('p', { class: 'nota muted small' }, 'Equipe Manda4? Abra o app "Projetos M4" dentro do Bitrix24.'), h('p', { class: 'nota small' }, h('a', { class: 'site', href: 'https://manda4.com.br/', target: '_blank', rel: 'noopener noreferrer' }, '← Voltar ao site manda4.com.br')));
  const onda = document.createElementNS(NS_SVG, 'svg'); onda.setAttribute('class', 'onda'); onda.setAttribute('viewBox', '0 0 1440 520'); onda.setAttribute('preserveAspectRatio', 'none'); onda.setAttribute('aria-hidden', 'true');
  onda.innerHTML = '<defs><linearGradient id="gb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f6fd6"/><stop offset="1" stop-color="#0a3f94"/></linearGradient></defs><path d="M0 0H1440V250C1180 170 940 330 700 380C460 430 230 340 0 400Z" fill="url(#gb)"/>';
  return h('div', { class: 'login' }, onda, h('div', { class: 'cena' }, h('div', { class: 'brand' }, h('div', { class: 'logo', role: 'img', 'aria-label': 'Manda4' }, LOGO(), NOME), h('h1', { class: 'tit' }, 'Área de Projetos e Suporte'), h('p', { class: 'sub' }, 'Acompanhe o andamento do seu projeto Bitrix24 e fale com o suporte da Manda4.')),
    h('div', { class: 'esq' }, ilustracao(), h('p', { class: 'conf' }, 'Parceiro Gold Bitrix24 · Centro de Treinamento Autorizado'),
      h('ul', { class: 'bene' }, ['Projetos: veja o cronograma e o status de cada atividade (no prazo, alerta ou atrasado)', 'Envie documentos e informações direto na atividade, sem e-mail e sem planilha', 'Suporte: abra chamados e acompanhe as respostas da equipe Manda4', 'Tudo com a equipe que implanta e acompanha o seu Bitrix24'].map(t => h('li', {}, t)))), box));
}

// ---------- projetos ----------
async function telaProjetos(m) {
  const { projetos } = await api('GET', '/api/projetos'); let painel = null;
  if (U.tipo === 'equipe') painel = await api('GET', '/api/painel');
  m.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, U.tipo === 'equipe' ? 'Projetos' : 'Meus projetos'), U.tipo === 'equipe' && h('button', { class: 'btn pri', onclick: () => modalProjeto() }, '+ Novo projeto')));
  if (painel) m.append(h('div', { class: 'kpis' }, [['Projetos', painel.projetos], ['No prazo', painel.verde], ['Em alerta', painel.amarelo], ['Atrasados', painel.vermelho], ['Chamados novos', painel.solicitacoesNovas], ['Clientes', painel.clientes]].map(([t, n]) => h('div', { class: 'card kpi' }, h('span', { class: 'muted small' }, t), h('b', {}, n)))));
  if (!projetos.length) return m.append(h('div', { class: 'card vazio' }, U.tipo === 'equipe' ? 'Nenhum projeto ainda. Crie o primeiro.' : 'Você ainda não tem projetos associados. Assim que a equipe Manda4 vincular, ele aparece aqui.'));
  m.append(h('div', { class: 'cards' }, projetos.map(p => h('div', { class: 'card click', onclick: () => go({ nome: 'projeto', id: p.id }) },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, p.nome), chip(p.resumo.cor, COR[p.resumo.cor])),
    h('p', { class: 'muted' }, p.descricao || 'Sem descrição'), h('div', { class: 'bar' }, h('i', { style: `width:${p.resumo.progresso}%` })),
    h('div', { class: 'row small muted' }, h('span', { class: 'grow' }, `${p.resumo.progresso}% concluído · ${p.resumo.concluidas}/${p.resumo.total} atividades`), p.resumo.fim && h('span', {}, 'até ' + fmt(p.resumo.fim)))))));
}

// ---------- projeto + gantt ----------
async function telaProjeto(m) {
  const { projeto: p } = await api('GET', '/api/projetos/' + view.id); const eq = U.tipo === 'equipe'; const aba = view.aba || 'gantt';
  m.append(h('div', { class: 'row' }, h('a', { class: 'btn sm', onclick: () => go({ nome: 'projetos' }) }, '← Projetos'), h('h1', { class: 'grow' }, p.nome), chip(p.resumo.cor, COR[p.resumo.cor]),
    eq && h('button', { class: 'btn sm', onclick: () => modalProjeto(p) }, 'Editar projeto'), eq && h('button', { class: 'btn pri sm', onclick: () => modalTarefa(p) }, '+ Atividade')),
    h('p', { class: 'muted' }, p.descricao), h('div', { class: 'kpis' }, [['Progresso', p.resumo.progresso + '%'], ['Atividades', `${p.resumo.concluidas}/${p.resumo.total} concluídas`], ['No prazo', p.resumo.verde], ['Em alerta', p.resumo.amarelo], ['Atrasadas', p.resumo.vermelho], ['Previsão de término', fmt(p.resumo.fim) || '—']].map(([t, n]) => h('div', { class: 'card kpi' }, h('span', { class: 'muted small' }, t), h('b', { style: 'font-size:20px' }, n)))),
    eq && h('p', { class: 'muted small' }, `Gerente: ${p.gerente || '—'} · Clientes com acesso: ${p.clientes.map(c => c.nome).join(', ') || 'nenhum'}`));
  const tabs = h('div', { class: 'tabs' }, [['gantt', 'Cronograma (Gantt)'], ['lista', 'Lista de atividades']].map(([k, t]) => h('a', { class: aba === k ? 'on' : '', onclick: () => { view.aba = k; render(); } }, t)));
  m.append(tabs); if (!p.tarefas.length) return m.append(h('div', { class: 'card vazio' }, 'Nenhuma atividade cadastrada ainda.'));
  if (aba === 'gantt') m.append(h('div', { class: 'legenda small' }, h('span', { class: 'chip verde' }, 'No prazo'), h('span', { class: 'chip amarelo' }, 'Alerta'), h('span', { class: 'chip vermelho' }, 'Atrasado'), h('span', { class: 'muted' }, 'Passe o mouse para detalhes · clique para abrir')), gantt(p));
  else m.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['Atividade', 'Início', 'Término', '%', 'Responsável', 'Status'].map(t => h('th', {}, t)))),
    h('tbody', {}, p.tarefas.map(t => h('tr', { style: 'cursor:pointer', onclick: () => drawer(p, t) }, h('td', {}, t.nome, t.interna && h('span', { class: 'muted small' }, ' (interna)')), h('td', {}, fmt(t.inicio)), h('td', {}, fmt(t.fim)), h('td', {}, t.progresso + '%'), h('td', {}, t.responsavel || '—'), h('td', {}, chip(t.status.cor, t.status.rotulo))))))));
}
function gantt(p) {
  const ts = [...p.tarefas].sort((a, b) => a.inicio.localeCompare(b.inicio) || a.fim.localeCompare(b.fim)); const RH = 44, DW = view.dw || 26;
  const min = Math.min(...ts.map(t => ms(t.inicio)), ms(p.hoje)) - 3 * DAY, max = Math.max(...ts.map(t => ms(t.fim)), ms(p.hoje)) + 10 * DAY;
  const dias = Math.round((max - min) / DAY) + 1, W = dias * DW, x = s => Math.round((ms(s) - min) / DAY) * DW;
  const cv = h('div', { class: 'g-canvas', style: `width:${W}px;height:${48 + ts.length * RH}px` });
  let mesAtual = '';
  for (let i = 0; i < dias; i++) {
    const d = new Date(min + i * DAY), s = iso(min + i * DAY), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) cv.append(h('div', { class: 'g-fds', style: `left:${i * DW}px;width:${DW}px` }));
    if (DW >= 18 || d.getUTCDate() === 1 || dow === 1) cv.append(h('div', { class: 'g-dia', style: `left:${i * DW}px;width:${DW}px` }, DW >= 18 || dow === 1 ? d.getUTCDate() : ''));
    const mk = s.slice(0, 7); if (mk !== mesAtual) { mesAtual = mk; cv.append(h('div', { class: 'g-mes', style: `left:${i * DW}px` }, d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }))); }
  }
  ts.forEach((t, i) => cv.append(h('div', { class: 'g-lin', style: `top:${48 + i * RH}px` })));
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'g-svg'); svg.setAttribute('width', W); svg.setAttribute('height', 48 + ts.length * RH);
  svg.innerHTML = '<defs><marker id="ar" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="#7d8aa8"/></marker></defs>';
  const pos = new Map(ts.map((t, i) => [t.id, { i, l: x(t.inicio), r: x(t.fim) + DW }]));
  for (const t of ts) for (const d of t.deps || []) {
    const a = pos.get(d.de), b = pos.get(t.id); if (!a) continue; const ya = 48 + a.i * RH + RH / 2, yb = 48 + b.i * RH + RH / 2;
    const [x1, x2] = d.tipo === 'SS' ? [a.l, b.l] : [a.r, b.l]; const mx = d.tipo === 'SS' ? Math.min(x1, x2) - 10 : x1 + 8;
    const path = document.createElementNS(NS, 'path'); path.setAttribute('d', `M${x1},${ya} H${mx} V${yb} H${x2 - 1}`); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#7d8aa8'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('marker-end', 'url(#ar)'); svg.append(path);
  }
  cv.append(svg, h('div', { class: 'g-hoje', style: `left:${x(p.hoje) + DW / 2}px` }));
  for (const t of ts) {
    const i = pos.get(t.id).i, w = Math.max(DW, x(t.fim) + DW - x(t.inicio));
    const b = h('div', { class: 'g-bloco ' + t.status.cor, style: `left:${x(t.inicio)}px;width:${w - 2}px;top:${48 + i * RH + 9}px`, tabindex: 0, role: 'button', 'aria-label': `${t.nome}: ${t.status.rotulo}`, onclick: () => drawer(p, t), onkeydown: e => e.key === 'Enter' && drawer(p, t) },
      h('div', { class: 'pg', style: `width:${t.progresso}%` }), h('span', {}, w > 90 ? `${t.nome}` : ''));
    b.addEventListener('mousemove', e => tip(e, t)); b.addEventListener('mouseleave', () => $tip.hidden = true); b.addEventListener('focus', () => { const r = b.getBoundingClientRect(); tip({ clientX: r.left, clientY: r.bottom }, t); }); b.addEventListener('blur', () => $tip.hidden = true);
    cv.append(b);
  }
  const nomes = h('div', { class: 'g-nomes' }, h('div', { class: 'g-head' }, h('select', { style: 'width:auto;padding:3px 6px;font-size:12px', onchange: e => { view.dw = +e.target.value; render(); } }, [[26, 'Dias'], [10, 'Semanas'], [4, 'Meses']].map(([v, t]) => h('option', { value: v, selected: v === DW }, t)))),
    ts.map(t => h('div', { class: 'g-nome', title: t.nome, onclick: () => drawer(p, t) }, h('i', { class: 'dot ' + t.status.cor }), h('span', {}, t.nome))));
  const sc = h('div', { class: 'g-scroll' }, cv); setTimeout(() => { sc.scrollLeft = Math.max(0, x(p.hoje) - 160); }, 0);
  return h('div', { class: 'gantt' }, nomes, sc);
}
function tip(e, t) {
  $tip.replaceChildren(h('b', {}, t.nome), chip(t.status.cor, t.status.rotulo), h('div', {}, `${fmt(t.inicio)} → ${fmt(t.fim)} · ${t.progresso}%`), h('div', {}, 'Quem está trabalhando: ' + (t.responsavel || 'a definir')), t.itens ? h('div', {}, `${t.itens} registro(s) · clique para abrir`) : h('div', {}, 'Clique para abrir'));
  $tip.hidden = false; const w = $tip.offsetWidth; $tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px'; $tip.style.top = Math.min(e.clientY + 14, innerHeight - $tip.offsetHeight - 8) + 'px';
}

// ---------- painel da atividade ----------
function overlay(centro) { const v = h('div', { class: 'veu' + (centro ? ' centro' : ''), onmousedown: e => e.target === v && v.remove() }); document.body.append(v); return v; }
async function drawer(p, t) {
  $tip.hidden = true; const v = overlay(), box = h('aside', { class: 'drawer' }); v.append(box); const eq = U.tipo === 'equipe';
  const fio = h('div', { class: 'fio' }), err = h('div'); const txt = h('textarea', { rows: 3, placeholder: 'Escreva uma informação, dúvida ou observação…' }); const file = h('input', { type: 'file' });
  const carregar = async () => {
    const { itens } = await api('GET', `/api/tarefas/${t.id}/itens`); fio.replaceChildren(...(itens.length ? itens.map(i => h('div', { class: 'msg' + (i.tipoAutor === 'equipe' ? ' eq' : '') }, h('div', { class: 'quem' }, `${i.autor} `, h('span', { class: 'muted' }, `${i.tipoAutor === 'equipe' ? 'Equipe Manda4' : 'Cliente'} · ${fmtTs(i.ts)}`)),
      i.texto && h('p', {}, i.texto), i.arquivo && h('p', {}, h('a', { href: '/api/arquivos/' + i.arquivo.id, download: i.arquivo.nome }, '📎 ' + i.arquivo.nome), h('span', { class: 'muted small' }, ` (${Math.ceil(i.arquivo.tamanho / 1024)} KB)`)))) : [h('p', { class: 'muted' }, 'Nenhum registro ainda.')]));
  };
  box.append(h('div', { class: 'row' }, h('h2', { class: 'grow' }, t.nome), h('button', { class: 'btn sm', onclick: () => v.remove() }, 'Fechar')), chip(t.status.cor, t.status.rotulo),
    h('p', { class: 'muted' }, t.descricao), h('p', {}, `📅 ${fmt(t.inicio)} → ${fmt(t.fim)} · ${t.progresso}% concluído`), h('p', {}, '👷 Quem está trabalhando: ', h('b', {}, t.responsavel || 'a definir')),
    (t.deps || []).length > 0 && h('p', { class: 'muted small' }, 'Depende de: ' + t.deps.map(d => { const o = p.tarefas.find(x => x.id === d.de); return o ? `${o.nome} (${d.tipo === 'SS' ? 'começam juntas' : 'espera terminar'}${d.lag ? ', ' + d.lag + 'd' : ''})` : null; }).filter(Boolean).join('; ')),
    eq && h('button', { class: 'btn sm', onclick: () => { v.remove(); modalTarefa(p, t); } }, 'Editar atividade'),
    h('h3', { style: 'margin-top:18px' }, 'Informações e documentos'), fio, h('label', {}, 'Adicionar texto'), txt, h('label', {}, 'Anexar documento (até 10 MB)'), file, err,
    h('button', { class: 'btn pri', style: 'margin-top:12px', onclick: async ev => {
      err.replaceChildren(); const body = { texto: txt.value }; const f = file.files[0]; ev.target.disabled = true;
      try {
        if (f) { if (f.size > 10 * 1024 * 1024) throw new Error('Arquivo acima de 10 MB.'); const buf = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768)); body.arquivo = { nome: f.name, base64: btoa(s) }; }
        await api('POST', `/api/tarefas/${t.id}/itens`, body); txt.value = ''; file.value = ''; await carregar();
      } catch (e) { err.append(h('div', { class: 'erro' }, e.message)); } ev.target.disabled = false;
    } }, 'Enviar'));
  carregar().catch(e => fio.append(h('div', { class: 'erro' }, e.message)));
}

// ---------- equipe: projeto e tarefa ----------
async function modalProjeto(p) {
  const v = overlay(true), err = h('div'); const { clientes } = await api('GET', '/api/clientes'); const sel = new Set((p && p.clientes || []).map(c => c.id));
  const nome = h('input', { value: p ? p.nome : '' }), desc = h('textarea', { rows: 3 }, p ? p.descricao : ''), ger = h('input', { value: p ? p.gerente : U.nome }), sit = h('select', {}, [['andamento', 'Em andamento'], ['pausado', 'Pausado'], ['concluido', 'Concluído']].map(([k, t]) => h('option', { value: k }, t)));
  if (p) sit.value = p.situacao;
  const lista = h('div', { style: 'max-height:200px;overflow:auto;border:1px solid var(--linha);border-radius:10px;padding:6px 10px' }, clientes.length ? clientes.filter(c => c.ativo).map(c => h('label', { style: 'display:flex;gap:8px;align-items:center;margin:4px 0;font-weight:400;color:var(--tinta)' }, h('input', { type: 'checkbox', style: 'width:auto', checked: sel.has(c.id), onchange: e => e.target.checked ? sel.add(c.id) : sel.delete(c.id) }), `${c.nome} · ${c.empresa || c.email}`)) : h('span', { class: 'muted' }, 'Nenhum cliente cadastrado no portal ainda.'));
  v.append(h('div', { class: 'modal' }, h('h2', {}, p ? 'Editar projeto' : 'Novo projeto'), h('label', {}, 'Nome'), nome, h('label', {}, 'Descrição'), desc, h('div', { class: 'g2' }, h('div', {}, h('label', {}, 'Gerente'), ger), h('div', {}, h('label', {}, 'Situação'), sit)),
    h('label', {}, 'Clientes com acesso a este projeto'), lista, err, h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async () => {
      try { const b = { nome: nome.value, descricao: desc.value, gerente: ger.value, situacao: sit.value, clientes: [...sel] }; const r = p ? await api('PATCH', '/api/projetos/' + p.id, b) : await api('POST', '/api/projetos', b); v.remove(); go({ nome: 'projeto', id: r.projeto.id }); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); }
    } }, 'Salvar'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'), p && U.admin && h('button', { class: 'btn perigo', onclick: async () => { if (confirm('Excluir o projeto e todas as atividades, registros e arquivos?')) { await api('DELETE', '/api/projetos/' + p.id); v.remove(); go({ nome: 'projetos' }); } } }, 'Excluir'))));
}
function modalTarefa(p, t) {
  const v = overlay(true), err = h('div'); const outras = p.tarefas.filter(x => !t || x.id !== t.id); const deps = (t ? t.deps || [] : []).map(d => ({ ...d }));
  const f = { nome: h('input', { value: t ? t.nome : '' }), inicio: h('input', { type: 'date', value: t ? t.inicio : p.hoje }), fim: h('input', { type: 'date', value: t ? t.fim : p.hoje }), prog: h('input', { type: 'number', min: 0, max: 100, value: t ? t.progresso : 0 }), resp: h('input', { value: t ? t.responsavel : '', placeholder: 'Quem está trabalhando nela' }), desc: h('textarea', { rows: 3 }, t ? t.descricao : ''), interna: h('input', { type: 'checkbox', style: 'width:auto', checked: t && t.interna }) };
  const depsBox = h('div'); const pintaDeps = () => depsBox.replaceChildren(...deps.map((d, i) => h('div', { class: 'row', style: 'margin:6px 0' },
    h('select', { onchange: e => d.de = e.target.value }, outras.map(o => h('option', { value: o.id, selected: o.id === d.de }, o.nome))),
    h('select', { style: 'width:auto', onchange: e => d.tipo = e.target.value }, [['FS', 'Espera terminar'], ['SS', 'Começa junto']].map(([k, tt]) => h('option', { value: k, selected: k === d.tipo }, tt))),
    h('input', { type: 'number', style: 'width:80px', value: d.lag, title: 'Defasagem em dias', onchange: e => d.lag = +e.target.value }), h('button', { class: 'btn sm', onclick: () => { deps.splice(i, 1); pintaDeps(); } }, '✕')))); pintaDeps();
  v.append(h('div', { class: 'modal' }, h('h2', {}, t ? 'Editar atividade' : 'Nova atividade'), h('label', {}, 'Nome'), f.nome, h('div', { class: 'g2' }, h('div', {}, h('label', {}, 'Início'), f.inicio), h('div', {}, h('label', {}, 'Término'), f.fim), h('div', {}, h('label', {}, '% concluído'), f.prog), h('div', {}, h('label', {}, 'Responsável'), f.resp)),
    h('label', {}, 'Descrição'), f.desc, h('label', {}, 'Dependências (as datas se ajustam sozinhas)'), depsBox, outras.length > 0 && h('button', { class: 'btn sm', onclick: () => { deps.push({ de: outras[0].id, tipo: 'FS', lag: 0 }); pintaDeps(); } }, '+ Dependência'),
    h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:400;color:var(--tinta)' }, f.interna, 'Atividade interna (o cliente não vê)'), err,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async () => {
      try { const b = { nome: f.nome.value, inicio: f.inicio.value, fim: f.fim.value, progresso: f.prog.value, responsavel: f.resp.value, descricao: f.desc.value, interna: f.interna.checked, deps }; if (t) await api('PATCH', '/api/tarefas/' + t.id, b); else await api('POST', `/api/projetos/${p.id}/tarefas`, b); v.remove(); render(); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); }
    } }, 'Salvar'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'), t && h('button', { class: 'btn perigo', onclick: async () => { if (confirm('Excluir esta atividade?')) { await api('DELETE', '/api/tarefas/' + t.id); v.remove(); render(); } } }, 'Excluir'))));
}

// ---------- solicitações ----------
const SOL = { nova: 'Nova', em_analise: 'Em análise', aprovada: 'Aprovada', recusada: 'Recusada', concluida: 'Concluída' };
async function telaSolic(m) {
  const { solicitacoes } = await api('GET', '/api/solicitacoes'); const eq = U.tipo === 'equipe';
  m.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Suporte e solicitações'), !eq && h('button', { class: 'btn pri', onclick: novaSolic }, '+ Abrir chamado')));
  if (!solicitacoes.length) return m.append(h('div', { class: 'card vazio' }, 'Nenhum chamado por aqui. Precisa de algo? Abra um chamado de suporte.'));
  m.append(h('div', { class: 'cards' }, solicitacoes.map(s => {
    const st = h('select', { onchange: e => api('PATCH', '/api/solicitacoes/' + s.id, { status: e.target.value }).then(render) }, Object.entries(SOL).map(([k, t]) => h('option', { value: k, selected: k === s.status }, t)));
    const rs = h('textarea', { rows: 2, placeholder: 'Resposta ao cliente' }, s.resposta);
    return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, s.assunto), eq ? st : chip(s.status === 'recusada' ? 'vermelho' : s.status === 'nova' || s.status === 'em_analise' ? 'amarelo' : 'verde', SOL[s.status])),
      h('p', { class: 'muted small' }, `${eq ? s.cliente + (s.empresa ? ' · ' + s.empresa : '') + ' · ' : ''}${s.projeto || 'Geral'} · ${fmtTs(s.criadoEm)}`), h('p', { style: 'white-space:pre-wrap' }, s.texto),
      eq ? [rs, h('button', { class: 'btn sm', style: 'margin-top:8px', onclick: () => api('PATCH', '/api/solicitacoes/' + s.id, { resposta: rs.value }).then(render) }, 'Salvar resposta')] : s.resposta && h('div', { class: 'msg eq' }, h('div', { class: 'quem' }, 'Resposta da equipe'), h('p', {}, s.resposta)));
  })));
}
async function novaSolic() {
  const v = overlay(true), err = h('div'); const { projetos } = await api('GET', '/api/projetos');
  const pj = h('select', {}, h('option', { value: '' }, 'Geral (sem projeto)'), projetos.map(p => h('option', { value: p.id }, p.nome))), as = h('input', { maxlength: 160 }), tx = h('textarea', { rows: 5 });
  v.append(h('div', { class: 'modal' }, h('h2', {}, 'Abrir chamado de suporte'), h('label', {}, 'Projeto'), pj, h('label', {}, 'Assunto'), as, h('label', {}, 'Descreva o que você precisa (dúvida, problema ou nova solicitação)'), tx, err,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async () => { try { await api('POST', '/api/solicitacoes', { projetoId: pj.value, assunto: as.value, texto: tx.value }); v.remove(); render(); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); } } }, 'Enviar'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'))));
}

// ---------- equipe: clientes e log ----------
async function telaClientes(m) {
  const { clientes } = await api('GET', '/api/clientes'); m.append(h('h1', {}, 'Clientes do portal'), h('p', { class: 'muted' }, 'Quem criou conta no portal. Para dar acesso, abra o projeto → Editar projeto → marque o cliente.'));
  m.append(h('div', { class: 'card', style: 'margin-top:16px;overflow:auto' }, clientes.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Cliente', 'Empresa', 'Projetos', 'Último acesso', ''].map(t => h('th', {}, t)))), h('tbody', {}, clientes.map(c => h('tr', {},
    h('td', {}, c.nome, h('div', { class: 'muted small' }, c.email)), h('td', {}, c.empresa || '—'), h('td', {}, c.projetos.join(', ') || h('span', { class: 'muted' }, 'sem projeto')), h('td', {}, c.ultimoAcesso ? fmtTs(c.ultimoAcesso) : 'nunca'),
    h('td', {}, h('button', { class: 'btn sm', onclick: () => api('PATCH', '/api/clientes/' + c.id, { ativo: !c.ativo }).then(render) }, c.ativo ? 'Bloquear' : 'Reativar')))))) : h('div', { class: 'vazio' }, 'Nenhum cliente cadastrado ainda.')));
}
async function telaLog(m) {
  const { logs } = await api('GET', '/api/logs'); m.append(h('h1', {}, 'Acessos e atividade'), h('p', { class: 'muted' }, 'Últimos 300 eventos: logins, projetos abertos, comentários, documentos e solicitações.'));
  m.append(h('div', { class: 'card', style: 'margin-top:16px;overflow:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ['Quando', 'Quem', 'Ação', 'Projeto', 'Detalhe'].map(t => h('th', {}, t)))),
    h('tbody', {}, logs.map(l => h('tr', {}, h('td', {}, fmtTs(l.ts)), h('td', {}, l.quem, h('span', { class: 'muted small' }, l.tipo === 'cliente' ? ' · cliente' : ' · equipe')), h('td', {}, l.acao.replace(/_/g, ' ')), h('td', {}, l.projeto || ''), h('td', { class: 'muted' }, l.detalhe)))))));
}
boot();
