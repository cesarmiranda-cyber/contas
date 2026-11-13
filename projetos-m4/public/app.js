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
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.erro || 'Erro inesperado.'), { status: r.status, dados: j }); return j;
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
const NS_SVG = 'http://www.w3.org/2000/svg';
// append seguro: ignora false/null (condições falsas não viram o texto "false")
const juntar = (el, ...kids) => el.append(...kids.flat().filter(c => c != null && c !== false));
const lerArquivo = async f => { if (f.size > 10 * 1024 * 1024) throw new Error(`“${f.name}” passa de 10 MB.`); const buf = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768)); return { nome: f.name, base64: btoa(s) }; };
const estrelas = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const VERSAO = (document.querySelector('meta[name=versao]') || {}).content || '';
// Avisa quando há uma versão nova publicada (evita ficar usando uma cópia antiga em cache).
async function checaVersao() {
  try { const r = await (await fetch('/api/versao', { cache: 'no-store' })).json(); if (r.versao && VERSAO && r.versao !== VERSAO && !document.querySelector('.nova-versao')) document.body.append(h('div', { class: 'nova-versao', role: 'status' }, 'Há uma nova versão do portal. ', h('button', { class: 'btn sm pri', onclick: () => location.reload() }, 'Atualizar agora'))); } catch { /* offline */ }
}
setInterval(checaVersao, 3 * 60e3); document.addEventListener('visibilitychange', () => { if (!document.hidden) checaVersao(); });
let U = null, view = { nome: 'projetos' };
const go = v => { view = v; render(); };

// ---------- shell ----------
async function boot() { try { U = (await api('GET', '/api/me')).usuario; } catch { U = null; } if (U && U.tipo === 'cliente' && view.nome === 'projetos') view = { nome: 'inicio' }; render(); }
function render() {
  $app.replaceChildren(); $tip.hidden = true;
  if (!U) return $app.append(telaLogin());
  const eq = U.tipo === 'equipe';
  const nav = [...(eq ? [['fila', 'Minha fila']] : [['inicio', 'Início']]), ['projetos', 'Projetos'], ['solicitacoes', 'Suporte'], ['ajuda', 'Ajuda'], ...(eq ? [['clientes', 'Clientes'], ['acessos', 'Acessos e log'], ...(U.admin ? [['integracao', 'Integração']] : [])] : [])];
  const top = h('header', { class: 'top' }, h('div', { class: 'logo clicavel', role: 'link', tabindex: 0, 'aria-label': 'Manda4 · Projetos e Suporte (início)', onclick: () => go({ nome: eq ? 'projetos' : 'inicio' }) }, LOGO(), NOME, h('span', { class: 'logo-sub' }, 'Projetos e Suporte')),
    h('nav', {}, nav.map(([k, t]) => h('a', { 'data-k': k, class: view.nome === k || (k === 'projetos' && view.nome === 'projeto') ? 'on' : '', onclick: () => go({ nome: k }) }, t))),
    h('span', { class: 'muted small' }, `${U.nome}${eq ? ' · equipe' : ''}`),
    !eq && sino(), !eq && h('button', { class: 'btn sm', onclick: async () => { await api('POST', '/api/auth/logout', {}); U = null; render(); } }, 'Sair'));
  if (eq) api('GET', '/api/fila').then(f => { const a = top.querySelector('nav a[data-k=fila]'); if (a && f.total) a.append(h('span', { class: 'n' }, f.total)); }).catch(() => {});
  const main = h('main', { class: 'wrap' }); $app.append(top, main, h('footer', { class: 'rodape' }, `Projetos M4 · ${eq ? 'visão da equipe' : 'área do cliente'} · versão ${VERSAO || '—'}`));
  ({ fila: telaFila, inicio: telaInicio, projetos: telaProjetos, projeto: telaProjeto, solicitacoes: telaSolic, ajuda: telaAjuda, clientes: telaClientes, acessos: telaLog, integracao: telaIntegracao }[view.nome])(main).catch(e => main.append(h('div', { class: 'erro' }, e.message)));
}

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

// ---------- login / cadastro ----------
function telaLogin(modo = 'login') {
  const err = h('div'), campos = {};
  const f = (k, rot, tipo = 'text', ac) => { campos[k] = h('input', { type: tipo, autocomplete: ac, required: true }); return [h('label', {}, rot), campos[k]]; };
  const cad = modo === 'cadastro';
  const box = h('form', { class: 'cartao', onsubmit: async ev => {
    ev.preventDefault(); err.replaceChildren(); const bt = ev.submitter; bt.disabled = true;
    try { await api('POST', cad ? '/api/auth/cadastro' : '/api/auth/login', Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, v.value]))); await boot(); } catch (e) { err.append(h('div', { class: 'erro' }, e.message)); bt.disabled = false; }
  } }, h('h2', {}, cad ? 'Criar sua conta de cliente' : 'Entrar na área do cliente'), h('p', { class: 'muted small' }, cad ? 'Use o e-mail que a equipe Manda4 tem no seu cadastro. Leva menos de um minuto.' : 'Projetos, documentos e suporte em um só lugar.'),
    cad && f('nome', 'Nome completo', 'text', 'name'), cad && h('div', {}, h('label', {}, 'Empresa'), (campos.empresa = h('input', { autocomplete: 'organization' }))), cad && h('div', {}, h('label', {}, 'Telefone / WhatsApp (opcional)'), (campos.telefone = h('input', { type: 'tel', autocomplete: 'tel' }))),
    f('email', 'E-mail profissional', 'email', 'email'), f('senha', cad ? 'Senha (mín. 8 caracteres)' : 'Senha', 'password', cad ? 'new-password' : 'current-password'),
    err, h('button', { class: 'btn pri', type: 'submit' }, cad ? 'Criar conta' : 'Entrar'),
    h('p', { class: 'troca muted small' }, cad ? 'Já tem conta? ' : 'Ainda não tem conta? ', h('a', { tabindex: 0, onclick: () => $app.replaceChildren(telaLogin(cad ? 'login' : 'cadastro')) }, cad ? 'Entrar' : 'Criar conta')),
    h('p', { class: 'nota muted small' }, 'Equipe Manda4? Abra o app "Projetos M4" dentro do Bitrix24.'), h('p', { class: 'nota small' }, h('a', { class: 'site', href: 'https://manda4.com.br/', target: '_blank', rel: 'noopener noreferrer' }, '← Voltar ao site manda4.com.br')));
  const selo = (cls, txt) => h('span', { class: 'selo ' + cls }, txt);
  return h('div', { class: 'login' },
    h('header', { class: 'lt' }, h('div', { class: 'logo', role: 'img', 'aria-label': 'Manda4' }, LOGO(), NOME), h('a', { class: 'btn sm', href: 'https://manda4.com.br/', target: '_blank', rel: 'noopener noreferrer' }, 'Ir para o site manda4.com.br')),
    h('main', { class: 'cena' },
      h('div', { class: 'esq' }, h('div', { class: 'selos' }, selo('or', 'Parceiro Gold Bitrix24'), selo('az', 'Centro de Treinamento Autorizado')),
        h('h1', { class: 'tit' }, h('em', {}, 'Projetos e Suporte'), ': acompanhe o seu Bitrix24 com quem implantou'),
        h('p', { class: 'sub' }, 'Veja o andamento do seu projeto, envie documentos e fale com a equipe Manda4. Implantamos no seu processo e seguimos ao lado, com suporte que responde.'),
        h('ul', { class: 'bene' }, ['Projetos: cronograma e status de cada atividade (no prazo, alerta ou atrasado)', 'Envie documentos e informações direto na atividade', 'Suporte: abra chamados e acompanhe as respostas'].map(t => h('li', {}, t)))),
      box));
}

// ---------- projetos ----------
const primeiroNome = n => String(n || '').trim().split(/\s+/)[0] || '';
function espera(m) {
  const ico = document.createElementNS(NS_SVG, 'svg'); ico.setAttribute('viewBox', '0 0 24 24'); ico.setAttribute('aria-hidden', 'true');
  ico.innerHTML = '<path d="M6 2h12M6 22h12M7 2v4.5L12 12l5-5.5V2M7 22v-4.5L12 12l5 5.5V22" fill="none" stroke="#a37800" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  const passo = (cls, n, t, st) => h('li', { class: cls }, h('span', { class: 'n' }, cls === 'feito' ? '✓' : n), h('b', {}, t), h('span', { class: 's' }, st));
  juntar(m, h('div', { class: 'card espera', role: 'status' }, h('div', { class: 'ico' }, ico), h('span', { class: 'chip amarelo pulso' }, 'Aguardando ativação'),
    h('h2', {}, 'Sua conta foi criada. Estamos ativando o seu acesso.'),
    h('p', {}, `Olá, ${primeiroNome(U.nome)}! A equipe Manda4 vai vincular você ao seu projeto. Assim que for ativado, o cronograma e o status aparecem aqui. Você não precisa fazer nada.`),
    h('ol', { class: 'passos' }, passo('feito', 1, 'Conta criada', 'Concluído'), passo('agora', 2, 'Manda4 vincula seu projeto', 'Em andamento'), passo('', 3, 'Acompanhe e envie documentos', 'Em breve')),
    h('div', { class: 'acoes' }, h('button', { class: 'btn pri', onclick: novaSolic }, 'Abrir chamado de suporte'), h('button', { class: 'btn', onclick: render }, 'Atualizar'), h('a', { class: 'btn', href: 'https://manda4.com.br/', target: '_blank', rel: 'noopener noreferrer' }, 'Conhecer a Manda4')),
    h('p', { class: 'muted small', style: 'margin-top:18px' }, `Conta: ${U.email}`)));
}
const saudacao = () => { const hr = +new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(new Date()); return hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite'; };
const rel = ts => { const d = (Date.now() - Date.parse(ts)) / 1000; if (d < 60) return 'agora'; if (d < 3600) return `há ${Math.floor(d / 60)} min`; if (d < 86400) return `há ${Math.floor(d / 3600)} h`; if (d < 7 * 86400) return `há ${Math.floor(d / 86400)} dia(s)`; return fmtTs(ts).split(',')[0]; };
const ICONES = { projetos: '<rect x="3" y="5" width="9" height="3.2" rx="1.6"/><rect x="8" y="10.4" width="12" height="3.2" rx="1.6"/><rect x="5" y="15.8" width="8" height="3.2" rx="1.6"/>', suporte: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.9 5.9l3.7 3.7M14.4 14.4l3.7 3.7M18.1 5.9l-3.7 3.7M9.6 14.4l-3.7 3.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  doc: '<path d="M7 3h7l4 4v14H7z M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' };
const icone = n => { const s = document.createElementNS(NS_SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('fill', 'currentColor'); s.innerHTML = ICONES[n]; return s; };
const anel = pct => { const s = document.createElementNS(NS_SVG, 'svg'); s.setAttribute('viewBox', '0 0 80 80'); s.setAttribute('class', 'anel'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', `${pct}% concluído`); const c = 2 * Math.PI * 34;
  s.innerHTML = `<circle cx="40" cy="40" r="34" fill="none" stroke="var(--linha)" stroke-width="8"/><circle cx="40" cy="40" r="34" fill="none" stroke="var(--destaque)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="46" text-anchor="middle" font-size="19" font-weight="800" fill="currentColor">${pct}%</text>`; return s; };
const contaChips = r => [r.verde > 0 && chip('verde', `${r.verde} no prazo`), r.amarelo > 0 && chip('amarelo', `${r.amarelo} em alerta`), r.vermelho > 0 && chip('vermelho', `${r.vermelho} atrasado(s)`)];

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
  juntar(m, h('section', { class: 'hero-cli' }, h('p', { class: 'eyebrow' }, U.empresa || 'Área do cliente'), h('h1', {}, `${saudacao()}, `, h('em', {}, primeiroNome(U.nome)), '.'), h('p', { class: 'sub' }, 'Acompanhe os seus projetos e fale com o suporte da Manda4.')),
    h('div', { class: 'acessos' }, cardProj, cardSup));
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

// ---------- histórico / log de alterações ----------
const fv = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmt(v) : v;
const fmtDia = s => { const x = new Date(s).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }); return x.charAt(0).toUpperCase() + x.slice(1); };
async function desfazerLog(e) {
  if (!confirm('Desfazer esta alteração? Os valores voltam ao que eram antes dela.')) return;
  try { const r = await api('POST', `/api/logs/${e.id}/desfazer`, {}); avisaAjustes(r.ajustes); toast('Alteração desfeita. Ela fica registrada no histórico.'); render(); }
  catch (er) {
    if (er.dados && er.dados.codigo === 'ALTERADO_DEPOIS') { if (!confirm(`${er.dados.campos.join(', ')} foi alterado depois desta mudança. Desfazer mesmo assim? Os valores voltarão ao que eram antes dela.`)) return; try { const r = await api('POST', `/api/logs/${e.id}/desfazer`, { forcar: true }); avisaAjustes(r.ajustes); toast('Alteração desfeita.'); render(); } catch (e2) { toast(e2.message, 6000); } }
    else toast(er.message, 6000);
  }
}
function entradaLog(e, comProjeto) {
  return h('div', { class: 'log-item ' + e.categoria }, h('i', { class: 'log-ponto', title: e.categoria === 'acessos' ? 'Acesso' : e.categoria === 'comunicacao' ? 'Comunicação' : 'Alteração' }),
    h('div', { class: 'grow' }, h('div', {}, h('b', {}, e.quem), ' ', h('span', { class: 'chip-mini ' + e.tipo }, e.tipo === 'equipe' ? 'Equipe' : 'Cliente'), ` ${e.rotulo}`, e.detalhe && [' ', h('b', {}, `“${e.detalhe}”`)], comProjeto && e.projeto && h('span', { class: 'muted' }, ` · ${e.projeto}`)),
      e.motivo && h('div', { class: 'muted small' }, e.motivo),
      e.diff && e.diff.length > 0 && h('ul', { class: 'diff' }, e.diff.map(d => h('li', {}, h('span', { class: 'muted' }, d.campo + ': '), h('s', {}, fv(d.de)), ' → ', h('b', {}, fv(d.para)), d.interno && h('span', { class: 'muted small' }, ' (interno)'))))),
    h('div', { class: 'log-dir' }, h('div', { class: 'muted small log-hora' }, fmtTs(e.ts)), U.tipo === 'equipe' && e.podeDesfazer && h('button', { class: 'btn sm', title: 'Volta aos valores de antes desta alteração', onclick: () => desfazerLog(e) }, 'Desfazer'), e.desfeito && h('span', { class: 'chip-mini', title: 'Desfeita por ' + e.desfeitoPor }, 'Desfeita')));
}
function listaLog(itens, comProjeto) {
  if (!itens.length) return h('div', { class: 'vazio' }, 'Nada registrado neste filtro.'); const out = []; let dia = '';
  for (const e of itens) { const d = e.ts.slice(0, 10); if (d !== dia) { dia = d; out.push(h('h3', { class: 'log-dia' }, fmtDia(e.ts))); } out.push(entradaLog(e, comProjeto)); } return h('div', {}, out);
}
async function historicoProjeto(p) {
  const eq = U.tipo === 'equipe'; const caixa = h('div', { class: 'card' }); let cat = view.cat || '';
  const carrega = async () => { caixa.replaceChildren(h('div', { class: 'vazio' }, 'Carregando…')); try { const r = await api('GET', `/api/projetos/${p.id}/historico?limite=300${cat ? '&cat=' + cat : ''}`); caixa.replaceChildren(listaLog(r.itens, false)); } catch (e) { caixa.replaceChildren(h('div', { class: 'erro' }, e.message)); } };
  const sel = eq && h('select', { style: 'width:auto', onchange: e => { cat = view.cat = e.target.value; carrega(); } }, [['', 'Tudo'], ['alteracoes', 'Alterações'], ['acessos', 'Acessos do cliente'], ['comunicacao', 'Comunicação']].map(([k, t]) => h('option', { value: k, selected: k === cat }, t)));
  carrega();
  return h('div', {}, h('div', { class: 'row', style: 'margin:4px 0 12px' }, h('p', { class: 'muted grow', style: 'margin:0' }, eq ? 'Tudo o que foi alterado, aberto e enviado neste projeto: quem, quando e de qual valor para qual.' : 'O que mudou no seu projeto e o que foi enviado, para todo mundo estar na mesma página. Registramos acessos e alterações por segurança e transparência.'),
    sel, eq && h('button', { class: 'btn sm', onclick: () => go({ nome: 'acessos', projeto: p.id }) }, 'Ver no log completo')), caixa);
}

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
      h('button', { class: 'btn sm sem-print', onclick: () => window.print() }, 'Imprimir / PDF'), eq && p.tarefas.length > 0 && h('button', { class: 'btn sm', onclick: () => modalSalvarModelo(p) }, 'Salvar como modelo'), eq && h('button', { class: 'btn sm', onclick: () => modalProjeto(p) }, 'Editar projeto'), eq && h('button', { class: 'btn pri sm', onclick: () => modalTarefa(p) }, '+ Atividade')),
    h('div', { class: 'ph-corpo' }, anel(p.resumo.progresso), h('div', { class: 'grow' }, h('h1', {}, p.nome), h('p', { class: 'muted', style: 'margin:2px 0 8px' }, [p.codigo, p.tipo, p.empresa].filter(Boolean).join(' · ') || 'Projeto Manda4'),
      h('div', { class: 'ac-chips' }, chip(p.resumo.cor, COR[p.resumo.cor]), SITUACAO[p.situacao] && chip('amarelo', SITUACAO[p.situacao]), contaChips(p.resumo)))),
    h('div', { class: 'ph-fatos' }, fato('Previsão de término', prazo), fato('Término contratado', fmt(p.fimPrevisto)), fato('Atividades concluídas', `${p.resumo.concluidas} de ${p.resumo.total}`), fato('Próxima entrega', proxima ? `${proxima.nome} · ${fmt(proxima.fim)}` : null), fato('Gerente', p.gerente))),
    h('p', { class: 'so-print' }, `Relatório do projeto ${p.codigo || ''} · gerado em ${fmtTs(new Date().toISOString())} · Manda4 Projetos e Suporte`),
    p.resumo.total > 0 && p.resumo.concluidas === p.resumo.total && h('div', { class: 'parabens' }, h('b', {}, 'Projeto concluído! '), 'Obrigado pela parceria. ', !eq && h('a', { onclick: () => go({ nome: 'solicitacoes' }) }, 'Precisa de algo? Abra um chamado →')),
    pend.length > 0 && h('div', { class: 'card precisa' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, eq ? 'Aguardando o cliente' : 'Precisamos de você neste projeto'), chip('amarelo', `${pend.length} pendência(s)`)),
      pend.map(t => h('div', { class: 'pend' }, h('div', { class: 'grow' }, h('b', {}, t.nome), h('div', { class: 'muted small' }, `até ${fmt(t.fim)}`), h('p', { style: 'margin:6px 0 0' }, aprPend(t) ? 'Esta entrega aguarda a aprovação do cliente.' : t.pedido || 'A equipe aguarda o retorno do cliente.')), t.respondidoEm && !aprPend(t) ? chip('verde', eq ? 'Cliente respondeu' : 'Você respondeu') : null,
        h('button', { class: 'btn pri sm', onclick: () => drawer(p, t) }, eq ? 'Abrir' : aprPend(t) ? 'Revisar e aprovar' : t.respondidoEm ? 'Ver conversa' : 'Responder')))));
  const tabs = h('div', { class: 'tabs' }, [['gantt', 'Cronograma'], ['lista', 'Atividades'], ['docs', 'Documentos'], ['dados', 'Dados do projeto'], ['historico', 'Histórico']].map(([k, tt]) => h('a', { class: aba === k ? 'on' : '', onclick: () => { view.aba = k; render(); } }, tt)));
  if (view.abrir) { const t0 = p.tarefas.find(x => x.id === view.abrir); view.abrir = null; if (t0) setTimeout(() => drawer(p, t0), 50); }
  juntar(m, tabs);
  if (aba === 'historico') return juntar(m, await historicoProjeto(p)); if (aba === 'docs') return juntar(m, await documentosProjeto(p)); if (aba === 'dados') return juntar(m, ficha(p));
  if (!p.tarefas.length) return juntar(m, h('div', { class: 'card vazio' }, 'Nenhuma atividade cadastrada ainda.'));
  if (aba === 'gantt') juntar(m, h('div', { class: 'legenda small' }, h('span', { class: 'chip verde' }, 'No prazo'), h('span', { class: 'chip amarelo' }, 'Alerta'), h('span', { class: 'chip vermelho' }, 'Atrasado'), h('span', { class: 'muted' }, eq ? 'Arraste o bloco para mover as datas · arraste as pontas para mudar início/término · arraste do círculo de uma atividade até outra para criar a dependência · clique na seta para remover' : 'Passe o mouse para detalhes · clique para abrir · para pedir mudança de prazo, abra a atividade')), gantt(p));
  else if (!eq) juntar(m, listaCliente(p));
  else juntar(m, h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['Atividade', 'Início', 'Término', '%', 'Responsável', 'Status', ''].map(x => h('th', {}, x)))),
    h('tbody', {}, p.tarefas.map(t => h('tr', { style: 'cursor:pointer', onclick: () => drawer(p, t) }, h('td', {}, t.nome, t.interna && h('span', { class: 'muted small' }, ' (interna)')), h('td', {}, fmt(t.inicio)), h('td', {}, fmt(t.fim)), h('td', {}, t.progresso + '%'), h('td', {}, t.responsavel || '—'),
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
  b.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return; ev.preventDefault();
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
  });
}
function tip(e, t) {
  $tip.replaceChildren(h('b', {}, t.nome), chip(t.status.cor, t.status.rotulo), t.aguardaCliente && t.progresso < 100 && h('div', { style: 'margin-top:4px;color:#ffd33d' }, (U.tipo === 'equipe' ? 'Aguardando o cliente: ' : 'Aguardando você: ') + (t.pedido || 'retorno pendente')), h('div', {}, `${fmt(t.inicio)} → ${fmt(t.fim)} · ${t.progresso}%`), h('div', {}, 'Quem está trabalhando: ' + (t.responsavel || 'a definir')), t.itens ? h('div', {}, `${t.itens} registro(s) · clique para abrir`) : h('div', {}, 'Clique para abrir'));
  $tip.hidden = false; const w = $tip.offsetWidth; $tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px'; $tip.style.top = Math.min(e.clientY + 14, innerHeight - $tip.offsetHeight - 8) + 'px';
}

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
  const fio = h('div', { class: 'fio' }), err = h('div'); const txt = h('textarea', { rows: 3, placeholder: 'Escreva uma informação, dúvida ou observação…' }); const file = h('input', { type: 'file' });
  const carregar = async () => {
    const { itens } = await api('GET', `/api/tarefas/${t.id}/itens`); fio.replaceChildren(...(itens.length ? itens.map(i => h('div', { class: 'msg' + (i.tipoAutor === 'equipe' ? ' eq' : '') }, h('div', { class: 'quem' }, `${i.autor} `, h('span', { class: 'muted' }, `${i.tipoAutor === 'equipe' ? 'Equipe Manda4' : 'Cliente'} · ${fmtTs(i.ts)}`)),
      i.texto && h('p', {}, i.texto), i.arquivo && h('p', {}, h('a', { href: '/api/arquivos/' + i.arquivo.id, download: i.arquivo.nome }, '📎 ' + i.arquivo.nome), h('span', { class: 'muted small' }, ` (${Math.ceil(i.arquivo.tamanho / 1024)} KB)`)))) : [h('p', { class: 'muted' }, 'Nenhum registro ainda.')]));
  };
  juntar(box, h('div', { class: 'row' }, h('h2', { class: 'grow' }, t.nome), eq && h('button', { class: 'btn pri sm', onclick: () => { v.remove(); modalTarefa(p, t); } }, 'Editar atividade'), !eq && t.status.codigo !== 'concluida' && h('button', { class: 'btn sm', title: 'O prazo é ajustado pela equipe Manda4. Peça por aqui.', onclick: () => { v.remove(); novaSolic({ projetoId: p.id, categoria: 'mudanca', assunto: `Pedido de ajuste de prazo: ${t.nome}`, texto: `Gostaria de pedir um ajuste de prazo na atividade “${t.nome}” (hoje: ${fmt(t.inicio)} a ${fmt(t.fim)}).\n\nNovo prazo desejado:\nMotivo:` }); } }, 'Pedir ajuste de prazo'), h('button', { class: 'btn sm', onclick: () => v.remove() }, 'Fechar')), chip(t.status.cor, t.status.rotulo),
    t.aguardaCliente && t.progresso < 100 && h('div', { class: 'callout' }, h('b', {}, U.tipo === 'equipe' ? 'Aguardando o cliente' : 'A equipe precisa de você'), h('p', {}, t.pedido || 'A equipe aguarda o seu retorno para continuar.'), t.respondidoEm && h('p', { class: 'small' }, `${U.tipo === 'equipe' ? 'Cliente respondeu' : 'Você respondeu'} em ${fmtTs(t.respondidoEm)}.`)),
    blocoAprovacao(t, () => v.remove()),
    h('p', { class: 'muted' }, t.descricao), h('p', {}, `📅 ${fmt(t.inicio)} → ${fmt(t.fim)} · ${t.progresso}% concluído`), h('p', {}, '👷 Quem está trabalhando: ', h('b', {}, t.responsavel || 'a definir')),
    (t.deps || []).length > 0 && h('p', { class: 'muted small' }, 'Depende de: ' + t.deps.map(d => { const o = p.tarefas.find(x => x.id === d.de); return o ? `${o.nome} (${d.tipo === 'SS' ? 'começam juntas' : 'espera terminar'}${d.lag ? ', ' + d.lag + 'd' : ''})` : null; }).filter(Boolean).join('; ')),
    eq && rapido(p, t, v),
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
function modalSalvarModelo(p) {
  const v = overlay(true), err = h('div'), nome = h('input', { maxlength: 80, placeholder: 'Ex.: Implantação Bitrix24 — varejo' });
  juntar(v, h('div', { class: 'modal', style: 'max-width:480px' }, h('h2', {}, 'Salvar como modelo'), h('p', { class: 'muted small' }, 'As atividades deste projeto (durações, dependências, pedidos ao cliente e aprovações) viram um modelo para criar novos projetos. Datas e responsáveis não vão junto.'), h('label', {}, 'Nome do modelo'), nome, err,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async () => { try { await api('POST', '/api/modelos', { projetoId: p.id, nome: nome.value }); v.remove(); toast('Modelo salvo. Ele aparece em “Novo projeto”.'); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); } } }, 'Salvar modelo'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'))));
}
async function modalModelos() {
  const v = overlay(true), caixa = h('div'); const carrega = async () => { const { modelos } = await api('GET', '/api/modelos'); caixa.replaceChildren(...modelos.map(m => h('div', { class: 'modelo' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, m.nome), m.embutido ? h('span', { class: 'chip-mini' }, 'Padrão') : h('button', { class: 'btn sm perigo', onclick: async () => { if (confirm(`Excluir o modelo “${m.nome}”? Projetos já criados não mudam.`)) { await api('DELETE', '/api/modelos/' + m.id); toast('Modelo excluído.'); carrega(); } } }, 'Excluir')),
    h('div', { class: 'muted small' }, `${m.qtdTarefas} atividades${m.diasUteis ? ' · dias úteis' : ''}${m.tipo ? ' · ' + m.tipo : ''}`), h('div', { class: 'small', style: 'margin-top:4px' }, m.tarefas.map(x => `${x.nome} (${x.dur}d)`).join(' → '))))); };
  juntar(v, h('div', { class: 'modal' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Modelos de projeto'), h('button', { class: 'btn sm', onclick: () => v.remove() }, 'Fechar')), h('p', { class: 'muted small' }, 'Para criar um modelo, abra um projeto com as atividades prontas e use “Salvar como modelo”.'), caixa)); await carrega();
}
async function modalProjeto(p, pre) {
  const v = overlay(true), err = h('div'); const { clientes } = await api('GET', '/api/clientes'); const modelos = p ? [] : (await api('GET', '/api/modelos')).modelos; const sel = new Set(((p || pre || {}).clientes || []).map(c => c.id)); const x = p || pre || {};
  const inp = (val, extra) => h('input', { value: val ?? '', ...extra });
  const f = {
    nome: inp(x.nome, { maxlength: 160 }), codigo: inp(x.codigo, { placeholder: 'Automático (PRJ-0001)' }),
    tipo: h('select', {}, h('option', { value: '' }, 'Selecione…'), ['Implantação Bitrix24', 'Treinamento', 'Integração / Automação', 'Customização', 'Suporte / Sustentação', 'Outro'].map(t => h('option', { value: t }, t))),
    prio: h('select', {}, Object.entries(PRIO).map(([k, t]) => h('option', { value: k }, t))), empresa: inp(x.empresa, { placeholder: 'Empresa contratante' }),
    cnome: inp(x.contatoNome), cemail: inp(x.contatoEmail, { type: 'email' }), ctel: inp(x.contatoTelefone, { type: 'tel' }),
    ini: inp(x.inicioPrevisto, { type: 'date' }), fim: inp(x.fimPrevisto, { type: 'date' }), valor: inp(x.valor, { type: 'number', min: 0, step: '0.01', placeholder: '0,00' }), neg: inp(x.negocioBitrix, { inputmode: 'numeric', placeholder: 'Ex.: 1234' }),
    desc: h('textarea', { rows: 4, placeholder: 'O que será entregue, etapas e o que o cliente precisa fornecer' }, x.descricao || ''), link: inp(x.link, { type: 'url', placeholder: 'https://…' }),
    obs: h('textarea', { rows: 3 }, x.obsInternas || ''), uteis: h('input', { type: 'checkbox', style: 'width:auto', checked: !!x.diasUteis }), feriados: h('textarea', { rows: 2, placeholder: 'AAAA-MM-DD, um por linha (ex.: 2027-02-09)' }, (x.feriadosExtras || []).join('\n')), ger: inp(p ? x.gerente : U.nome),
    sit: h('select', {}, [['andamento', 'Em andamento'], ['pausado', 'Pausado'], ['concluido', 'Concluído']].map(([k, t]) => h('option', { value: k }, t)))
  };
  f.modelo = h('select', {}, h('option', { value: '' }, 'Em branco (sem atividades)'), modelos.map(m => h('option', { value: m.id }, `${m.nome} · ${m.qtdTarefas} atividades${m.embutido ? '' : ' (seu modelo)'}`))); f.inicioModelo = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }); f.previa = h('div', { class: 'muted small', style: 'margin:6px 0 0' });
  f.modelo.addEventListener('change', () => { const m = modelos.find(z => z.id === f.modelo.value); f.previa.textContent = m ? `${m.descricao ? m.descricao + ' ' : ''}Atividades: ${m.tarefas.map(x => `${x.nome} (${x.dur}d)`).join(' → ')}.` : ''; if (m) { if (m.tipo) f.tipo.value = m.tipo; f.uteis.checked = m.diasUteis; if (!f.desc.value) f.desc.value = m.descricao; } });
  f.tipo.value = x.tipo || ''; f.prio.value = x.prioridade || 'media'; f.sit.value = x.situacao || 'andamento';
  const c = (rot, el) => h('div', {}, h('label', {}, rot), el); const sec = t => h('h3', { class: 'sec' }, t);
  const lista = h('div', { style: 'max-height:200px;overflow:auto;border:1px solid var(--linha);border-radius:10px;padding:6px 10px' }, clientes.length ? clientes.filter(c => c.ativo).map(c => h('label', { style: 'display:flex;gap:8px;align-items:center;margin:4px 0;font-weight:400;color:var(--tinta)' }, h('input', { type: 'checkbox', style: 'width:auto', checked: sel.has(c.id), onchange: e => e.target.checked ? sel.add(c.id) : sel.delete(c.id) }), `${c.nome} · ${c.empresa || c.email}`)) : h('span', { class: 'muted' }, 'Nenhum cliente cadastrado no portal ainda.'));
  juntar(v, h('div', { class: 'modal' }, h('h2', {}, p ? 'Editar projeto' : 'Novo projeto'),
    !p && modelos.length > 0 && [sec('Começar de um modelo (opcional)'), h('div', { class: 'g2' }, c('Modelo', f.modelo), c('Início do projeto', f.inicioModelo)), f.previa],
    sec('Identificação'), h('div', { class: 'g2' }, c('Nome do projeto *', f.nome), c('Código', f.codigo), c('Tipo', f.tipo), c('Prioridade', f.prio), c('Gerente do projeto', f.ger), c('Situação', f.sit)),
    sec('Cliente contratante'), h('div', { class: 'g2' }, c('Empresa', f.empresa), c('Nome do contato', f.cnome), c('E-mail do contato', f.cemail), c('Telefone do contato', f.ctel)),
    sec('Prazos e valores'), h('div', { class: 'g2' }, c('Início previsto', f.ini), c('Término contratado', f.fim), c('Valor do projeto (R$) · interno', f.valor), c('ID do negócio no Bitrix24 · interno', f.neg)),
    sec('Escopo'), c('Objetivo e escopo (o cliente vê)', f.desc), c('Link da pasta de documentos (o cliente vê)', f.link), c('Observações internas (o cliente não vê)', f.obs),
    sec('Calendário'), h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:600;color:var(--tinta)' }, f.uteis, 'Contar só dias úteis (segunda a sexta, sem feriados nacionais)'),
    h('p', { class: 'muted small', style: 'margin:4px 0 0' }, 'Com isso ligado, as datas das atividades caem em dias úteis, e dependências e durações pulam fins de semana e feriados. Ao mudar, as atividades existentes são reajustadas.'), c('Feriados extras do projeto (Carnaval, feriados locais…)', f.feriados),
    sec('Acesso dos clientes'), h('label', {}, 'Clientes com acesso a este projeto'), lista, err,
    h('p', { class: 'muted small' }, 'Depois de salvar, adicione as atividades do projeto (botão “+ Atividade”).'),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn pri', onclick: async () => {
      try {
        const b = { nome: f.nome.value, codigo: f.codigo.value, tipo: f.tipo.value, prioridade: f.prio.value, gerente: f.ger.value, situacao: f.sit.value, empresa: f.empresa.value, contatoNome: f.cnome.value, contatoEmail: f.cemail.value, contatoTelefone: f.ctel.value,
          inicioPrevisto: f.ini.value, fimPrevisto: f.fim.value, valor: f.valor.value, negocioBitrix: f.neg.value, descricao: f.desc.value, link: f.link.value, obsInternas: f.obs.value, diasUteis: f.uteis.checked, feriadosExtras: f.feriados.value, clientes: [...sel] }; if (!p && f.modelo.value) { b.modeloId = f.modelo.value; b.inicioModelo = f.inicioModelo.value; }
        const r = p ? await api('PATCH', '/api/projetos/' + p.id, b) : await api('POST', '/api/projetos', b); v.remove(); go({ nome: 'projeto', id: r.projeto.id });
      } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); }
    } }, 'Salvar'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'), p && U.admin && h('button', { class: 'btn perigo', onclick: async () => { if (confirm('Excluir o projeto e todas as atividades, registros e arquivos?')) { await api('DELETE', '/api/projetos/' + p.id); v.remove(); go({ nome: 'projetos' }); } } }, 'Excluir'))));
}
function modalTarefa(p, t) {
  const v = overlay(true), err = h('div'); const outras = p.tarefas.filter(x => !t || x.id !== t.id); const deps = (t ? t.deps || [] : []).map(d => ({ ...d }));
  const f = { nome: h('input', { value: t ? t.nome : '' }), inicio: h('input', { type: 'date', value: t ? t.inicio : p.hoje }), fim: h('input', { type: 'date', value: t ? t.fim : p.hoje }), dur: h('input', { type: 'number', min: 1, step: 1 }), prog: h('input', { type: 'number', min: 0, max: 100, value: t ? t.progresso : 0 }), resp: h('input', { value: t ? t.responsavel : '', placeholder: 'Quem está trabalhando nela' }), desc: h('textarea', { rows: 3 }, t ? t.descricao : ''), interna: h('input', { type: 'checkbox', style: 'width:auto', checked: t && t.interna }), aguarda: h('input', { type: 'checkbox', style: 'width:auto', checked: t && t.aguardaCliente }), aprov: h('input', { type: 'checkbox', style: 'width:auto', checked: t && t.requerAprovacao }), pedido: h('textarea', { rows: 2, maxlength: 500, placeholder: 'O que você precisa do cliente? Ex.: lista de usuários e permissões' }, t ? t.pedido || '' : '') };
  // datas: mudar o início leva o término junto (mantém a duração); mudar a duração muda o término
  const cal = calCli(p); let ini0 = f.inicio.value;
  const pintaDur = () => { f.dur.value = f.inicio.value && f.fim.value ? Math.max(1, cal.dif(f.inicio.value, f.fim.value) + 1) : ''; f.fim.min = f.inicio.value; };
  f.inicio.addEventListener('change', () => { if (!f.inicio.value) return; const dur = f.fim.value && ini0 ? cal.dif(ini0, f.fim.value) : 0; f.inicio.value = cal.prox(f.inicio.value); if (f.fim.value) f.fim.value = cal.soma(f.inicio.value, Math.max(0, dur)); ini0 = f.inicio.value; pintaDur(); });
  f.fim.addEventListener('change', () => { if (f.fim.value) f.fim.value = cal.ant(f.fim.value); if (f.fim.value && f.inicio.value && f.fim.value < f.inicio.value) { f.inicio.value = f.fim.value; ini0 = f.inicio.value; } pintaDur(); });
  f.dur.addEventListener('input', () => { const n = Math.max(1, Math.round(+f.dur.value) || 1); if (f.inicio.value) { f.fim.value = cal.soma(f.inicio.value, n - 1); f.fim.min = f.inicio.value; } });
  pintaDur();
  const depsBox = h('div'); const pintaDeps = () => depsBox.replaceChildren(...deps.map((d, i) => h('div', { class: 'row', style: 'margin:6px 0' },
    h('select', { onchange: e => d.de = e.target.value }, outras.map(o => h('option', { value: o.id, selected: o.id === d.de }, o.nome))),
    h('select', { style: 'width:auto', onchange: e => d.tipo = e.target.value }, [['FS', 'Espera terminar'], ['SS', 'Começa junto']].map(([k, tt]) => h('option', { value: k, selected: k === d.tipo }, tt))),
    h('input', { type: 'number', style: 'width:80px', value: d.lag, min: -365, max: 365, title: 'Defasagem em dias: 0 = sem espera; 5 = espera mais 5 dias; negativo = adianta', onchange: e => d.lag = +e.target.value }), h('span', { class: 'muted small' }, 'dia(s) de defasagem'), h('button', { class: 'btn sm', onclick: () => { deps.splice(i, 1); pintaDeps(); } }, '✕')))); pintaDeps();
  juntar(v, h('div', { class: 'modal' }, h('h2', {}, t ? 'Editar atividade' : 'Nova atividade'), h('label', {}, 'Nome'), f.nome, h('div', { class: 'g2' }, h('div', {}, h('label', {}, 'Início'), f.inicio), h('div', {}, h('label', {}, 'Término'), f.fim), h('div', {}, h('label', {}, p.diasUteis ? 'Duração (dias úteis)' : 'Duração (dias)'), f.dur), h('div', {}, h('label', {}, '% concluído'), f.prog), h('div', {}, h('label', {}, 'Responsável'), f.resp)),
    h('label', {}, 'Descrição'), f.desc, h('label', {}, 'Dependências (as datas se ajustam sozinhas) · defasagem: 0 = sem espera, 5 = espera mais 5 dias, negativo = adianta'), depsBox, outras.length > 0 && h('button', { class: 'btn sm', onclick: () => { deps.push({ de: outras[0].id, tipo: 'FS', lag: 0 }); pintaDeps(); } }, '+ Dependência'),
    h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:400;color:var(--tinta)' }, f.interna, 'Atividade interna (o cliente não vê)'),
    h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:400;color:var(--tinta)' }, f.aprov, 'Requer aprovação do cliente (você envia a entrega e ele aprova ou pede ajustes)'),
    h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:600;color:var(--tinta)' }, f.aguarda, 'Aguardando o cliente (aparece em “Precisamos de você” para ele)'), f.pedido, err,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async () => {
      try { const b = { nome: f.nome.value, inicio: f.inicio.value, fim: f.fim.value, progresso: f.prog.value, responsavel: f.resp.value, descricao: f.desc.value, interna: f.interna.checked, aguardaCliente: f.aguarda.checked, requerAprovacao: f.aprov.checked, pedido: f.pedido.value, deps }; if (t) { if (!(await patchTarefa(t, b))) return; } else { const r = await api('POST', `/api/projetos/${p.id}/tarefas`, b); avisaAjustes(r.ajustes); } v.remove(); render(); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); }
    } }, 'Salvar'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'), t && h('button', { class: 'btn perigo', onclick: async () => { if (confirm('Excluir esta atividade?')) { await api('DELETE', '/api/tarefas/' + t.id); v.remove(); render(); } } }, 'Excluir'))));
}

// ---------- suporte (chamados) ----------
const SOL = { nova: 'Nova', em_analise: 'Em análise', aprovada: 'Aprovada', recusada: 'Recusada', concluida: 'Concluída' };
const CATS = { duvida: 'Dúvida', problema: 'Problema / erro', mudanca: 'Solicitação de mudança', acesso: 'Acesso e usuários', financeiro: 'Financeiro', outro: 'Outro' };
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

// ---------- central de ajuda (artigos) ----------
const semAcento = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function modalArtigo(a) {
  const v = overlay(true), err = h('div'); const f = { titulo: h('input', { value: a ? a.titulo : '', maxlength: 140 }), texto: h('textarea', { rows: 9 }, a ? a.texto : ''), palavras: h('input', { value: a ? a.palavras || '' : '', placeholder: 'palavras que o cliente costuma usar (ajuda a sugerir o artigo)' }), pub: h('input', { type: 'checkbox', style: 'width:auto', checked: !a || a.publicado !== false }) };
  juntar(v, h('div', { class: 'modal' }, h('h2', {}, a ? 'Editar artigo' : 'Novo artigo'), h('label', {}, 'Título *'), f.titulo, h('label', {}, 'Texto *'), f.texto, h('label', {}, 'Palavras-chave'), f.palavras, h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:400;color:var(--tinta)' }, f.pub, 'Publicado (o cliente vê e recebe como sugestão)'), err,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async () => { try { const b = { titulo: f.titulo.value, texto: f.texto.value, palavras: f.palavras.value, publicado: f.pub.checked }; if (a) await api('PATCH', '/api/artigos/' + a.id, b); else await api('POST', '/api/artigos', b); v.remove(); render(); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); } } }, 'Salvar'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'))));
}
async function telaAjuda(m) {
  const { artigos } = await api('GET', '/api/artigos'); const eq = U.tipo === 'equipe'; const lista = h('div'); let q = '';
  const pinta = () => { const qq = semAcento(q).trim(); const vis = artigos.filter(a => !qq || semAcento([a.titulo, a.texto, a.palavras].join(' ')).includes(qq));
    lista.replaceChildren(...(vis.length ? vis.map(a => h('details', { class: 'card artigo' }, h('summary', {}, h('b', {}, a.titulo), eq && a.publicado === false && h('span', { class: 'chip-mini', style: 'margin-left:8px' }, 'Rascunho')),
      h('p', { style: 'white-space:pre-wrap;margin:10px 0' }, a.texto),
      eq ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => modalArtigo(a) }, 'Editar'), h('button', { class: 'btn sm', onclick: () => api('PATCH', '/api/artigos/' + a.id, { publicado: a.publicado === false }).then(render) }, a.publicado === false ? 'Publicar' : 'Despublicar'),
        h('button', { class: 'btn sm perigo', onclick: async () => { if (confirm('Excluir este artigo?')) { await api('DELETE', '/api/artigos/' + a.id); render(); } } }, 'Excluir'), h('span', { class: 'muted small' }, `${a.vistas || 0} sugestões · ${a.uteis || 0} resolveram · ${a.naoUteis || 0} não resolveram`))
        : h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Isso resolveu?'), h('button', { class: 'btn sm', onclick: () => api('POST', `/api/artigos/${a.id}/util`, { resolveu: true }).then(() => toast('Obrigado pelo retorno!')) }, 'Sim'), h('button', { class: 'btn sm', onclick: () => { api('POST', `/api/artigos/${a.id}/util`, { resolveu: false }).catch(() => {}); novaSolic({ assunto: a.titulo }); } }, 'Não, abrir um chamado')))) : [h('div', { class: 'card vazio' }, artigos.length ? 'Nenhum artigo encontrado para essa busca.' : eq ? 'Nenhum artigo ainda. Crie o primeiro.' : 'Ainda não há artigos publicados.')])); };
  juntar(m, h('div', { class: 'row' }, h('h1', { class: 'grow' }, eq ? 'Central de ajuda' : 'Ajuda'), eq && h('button', { class: 'btn pri', onclick: () => modalArtigo() }, '+ Novo artigo')), h('p', { class: 'muted', style: 'margin:4px 0 12px' }, eq ? 'Artigos que o cliente encontra aqui e que são sugeridos quando ele vai abrir um chamado.' : 'Respostas para as dúvidas mais comuns. Se não achar, abra um chamado em Suporte.'),
    h('input', { type: 'search', class: 'busca', style: 'max-width:520px;margin-bottom:12px', placeholder: 'Buscar na ajuda', oninput: e => { q = e.target.value; pinta(); } }), lista); pinta();
}

// ---------- equipe: clientes e ativação ----------
const iniciais = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
function situacaoCliente(c) { return !c.ativo ? 'bloqueado' : c.projetoIds.length ? 'ativo' : 'aguardando'; }
async function telaClientes(m) {
  const [{ clientes }, { projetos }] = await Promise.all([api('GET', '/api/clientes'), api('GET', '/api/projetos')]);
  const n = { aguardando: 0, ativo: 0, bloqueado: 0 }; clientes.forEach(c => n[situacaoCliente(c)]++);
  if (!view.filtro) view.filtro = n.aguardando ? 'aguardando' : 'todos'; if (view.busca == null) view.busca = '';
  const lista = h('div'); const pinta = () => {
    const q = view.busca.trim().toLowerCase();
    const l = clientes.filter(c => (view.filtro === 'todos' || situacaoCliente(c) === view.filtro) && (!q || [c.nome, c.email, c.empresa, c.telefone, ...c.projetos].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => ({ aguardando: 0, ativo: 1, bloqueado: 2 }[situacaoCliente(a)] - { aguardando: 0, ativo: 1, bloqueado: 2 }[situacaoCliente(b)]) || b.criadoEm.localeCompare(a.criadoEm));
    lista.replaceChildren(l.length ? h('div', { class: 'card tabela' }, h('table', {}, h('thead', {}, h('tr', {}, ['Cliente', 'Empresa', 'Situação', 'Projetos', 'Cadastro · último acesso', ''].map(x => h('th', {}, x)))), h('tbody', {}, l.map(c => {
      const sit = situacaoCliente(c);
      return h('tr', {}, h('td', {}, h('div', { class: 'quem-cli' }, h('span', { class: 'avatar' }, iniciais(c.nome)), h('div', {}, h('b', {}, c.nome), h('div', { class: 'muted small' }, c.email), c.telefone && h('div', { class: 'muted small' }, c.telefone)))),
        h('td', {}, c.empresa || h('span', { class: 'muted' }, '—')), h('td', {}, sit === 'bloqueado' ? chip('vermelho', 'Bloqueado') : sit === 'ativo' ? chip('verde', 'Ativo') : chip('amarelo', 'Aguardando ativação')),
        h('td', {}, c.projetos.length ? c.projetos.map(p => h('div', { class: 'small' }, p)) : h('span', { class: 'muted' }, 'sem projeto'), c.chamados > 0 && h('div', { class: 'muted small' }, `${c.chamados} chamado(s)`)),
        h('td', { class: 'small' }, h('div', {}, 'Cadastro: ' + fmtTs(c.criadoEm)), h('div', { class: 'muted' }, 'Acesso: ' + (c.ultimoAcesso ? fmtTs(c.ultimoAcesso) : 'nunca'))),
        h('td', { class: 'acoes-cli' }, sit === 'bloqueado' ? h('button', { class: 'btn sm', onclick: () => api('PATCH', '/api/clientes/' + c.id, { ativo: true }).then(() => { toast('Cliente reativado.'); render(); }) }, 'Reativar')
          : [h('button', { class: 'btn sm' + (sit === 'aguardando' ? ' pri' : ''), onclick: () => modalAcesso(c, projetos) }, sit === 'aguardando' ? 'Ativar acesso' : 'Gerenciar projetos'),
            h('button', { class: 'btn sm perigo', onclick: () => confirm(`Bloquear ${c.nome}? Ele perde o acesso ao portal.`) && api('PATCH', '/api/clientes/' + c.id, { ativo: false }).then(() => { toast('Cliente bloqueado.'); render(); }) }, 'Bloquear')]));
    })))) : h('div', { class: 'card vazio' }, clientes.length ? 'Nenhum cliente neste filtro.' : 'Nenhum cliente cadastrado ainda. Quando alguém criar conta no portal, aparece aqui.'));
  };
  const aba = (k, t, q) => h('button', { class: 'filtro' + (view.filtro === k ? ' on' : ''), onclick: ev => { view.filtro = k; ev.target.parentNode.querySelectorAll('.filtro').forEach(b => b.classList.toggle('on', b === ev.target)); pinta(); } }, `${t} `, h('span', { class: 'n' }, q));
  juntar(m, h('h1', {}, 'Clientes do portal'), h('p', { class: 'muted' }, 'Quem criou conta no portal. Para liberar o acesso, ative o cliente em um ou mais projetos.'),
    n.aguardando > 0 && h('div', { class: 'aviso' }, h('b', {}, `${n.aguardando} cliente(s) aguardando ativação. `), 'Eles já criaram a conta e estão esperando você vincular um projeto.'),
    h('div', { class: 'toolbar' }, h('div', { class: 'filtros' }, aba('aguardando', 'Aguardando ativação', n.aguardando), aba('ativo', 'Ativos', n.ativo), aba('bloqueado', 'Bloqueados', n.bloqueado), aba('todos', 'Todos', clientes.length)),
      h('input', { class: 'busca', type: 'search', placeholder: 'Buscar por nome, e-mail, empresa ou projeto', value: view.busca, oninput: e => { view.busca = e.target.value; pinta(); } })), lista); pinta();
}
function modalAcesso(c, projetos) {
  const v = overlay(true), err = h('div'); const sel = new Set(c.projetoIds); const ativar = c.projetoIds.length === 0;
  const pre = { empresa: c.empresa, contatoNome: c.nome, contatoEmail: c.email, contatoTelefone: c.telefone, clientes: [{ id: c.id }] };
  const caixa = h('div', { class: 'lista-proj' }, projetos.length ? projetos.map(p => h('label', { class: 'item-proj' }, h('input', { type: 'checkbox', checked: sel.has(p.id), onchange: e => e.target.checked ? sel.add(p.id) : sel.delete(p.id) }),
    h('span', {}, h('b', {}, p.nome), h('span', { class: 'muted small' }, ` ${[p.codigo, p.empresa].filter(Boolean).join(' · ')}`)))) : h('p', { class: 'muted' }, 'Ainda não há projetos. Crie o primeiro para este cliente.'));
  juntar(v, h('div', { class: 'modal' }, h('h2', {}, ativar ? 'Ativar acesso' : 'Projetos do cliente'), h('div', { class: 'quem-cli', style: 'margin:8px 0 4px' }, h('span', { class: 'avatar' }, iniciais(c.nome)), h('div', {}, h('b', {}, c.nome), h('div', { class: 'muted small' }, [c.empresa, c.email].filter(Boolean).join(' · ')))),
    h('label', {}, ativar ? 'Em quais projetos este cliente pode entrar?' : 'Projetos que este cliente pode acompanhar'), caixa,
    h('button', { class: 'btn sm', style: 'margin-top:10px', onclick: () => { v.remove(); modalProjeto(null, pre); } }, '+ Criar novo projeto para este cliente'), err,
    h('div', { class: 'row', style: 'margin-top:18px' }, h('button', { class: 'btn pri', onclick: async ev => { ev.target.disabled = true; try {
      if (ativar && sel.size === 0) throw new Error('Marque ao menos um projeto para ativar o acesso.');
      const r = await api('POST', `/api/clientes/${c.id}/projetos`, { projetos: [...sel] }); v.remove(); toast(r.projetos ? `Acesso ativado: ${c.nome} vê ${r.projetos} projeto(s).` : `${c.nome} ficou sem projetos (aguardando ativação).`); render();
    } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); ev.target.disabled = false; } } }, ativar ? 'Ativar acesso' : 'Salvar'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'))));
}

// ---------- equipe: integração com o funil de suporte (administradores) ----------
async function telaIntegracao(m) {
  const e = await api('GET', '/api/config/suporte'); const slaCfg = (await api('GET', '/api/config/sla')).sla; let funis = null;
  const msg = h('div'), selF = h('select', {}), selE = h('select', {}), wh = h('input', { type: 'password', autocomplete: 'off', placeholder: e.configurado ? `Webhook salvo (${e.dica}). Cole outro só para trocar.` : 'https://seu-portal.bitrix24.com.br/rest/1/CODIGO/' });
  const pintaEtapas = () => { const f = (funis || []).find(x => String(x.id) === selF.value); selE.replaceChildren(...(f ? f.etapas : []).map(x => h('option', { value: x.id, selected: x.id === e.estagioId }, x.nome))); };
  const carrega = async ev => { ev.target.disabled = true; msg.replaceChildren(); try { funis = (await api('POST', '/api/config/suporte/testar', { webhook: wh.value })).funis;
      selF.replaceChildren(...funis.map(f => h('option', { value: f.id, selected: f.id === e.categoriaId }, f.nome))); pintaEtapas(); msg.append(h('div', { class: 'ok' }, `Conexão ok. ${funis.length} funil(is) encontrado(s). Escolha o funil e a etapa inicial dos chamados.`)); }
    catch (x) { msg.append(h('div', { class: 'erro' }, x.message)); } ev.target.disabled = false; };
  selF.addEventListener('change', pintaEtapas);
  juntar(m, h('h1', {}, 'Integração · funil de suporte'), h('p', { class: 'muted' }, 'Cada chamado aberto pelo cliente vira um card no funil que você escolher no Bitrix24.'),
    h('div', { class: 'card integ' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Conexão com o Bitrix24'), e.pronto ? chip('verde', 'Funcionando') : chip('amarelo', 'Não configurada')),
      e.pronto && h('p', { class: 'muted small' }, `Portal ${e.host} · funil “${e.funilNome}” · etapa inicial “${e.etapaNome}”`),
      h('label', {}, 'Webhook de entrada do Bitrix24'), wh, h('p', { class: 'muted small' }, 'No Bitrix24: Recursos para desenvolvedores → Outros → Webhook de entrada, com permissão em CRM. O endereço fica guardado só no servidor e nunca volta inteiro para o navegador.'),
      h('button', { class: 'btn', style: 'margin-top:8px', onclick: carrega }, e.configurado ? 'Testar conexão e carregar funis' : 'Conectar e carregar funis'), msg,
      h('div', { class: 'g2' }, h('div', {}, h('label', {}, 'Funil de suporte'), selF), h('div', {}, h('label', {}, 'Etapa inicial dos chamados'), selE)),
      h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async ev => { ev.target.disabled = true; msg.replaceChildren(); try {
        if (!funis) throw new Error('Clique em “Conectar e carregar funis” primeiro.'); const f = funis.find(x => String(x.id) === selF.value), et = f && f.etapas.find(x => x.id === selE.value); if (!f || !et) throw new Error('Escolha o funil e a etapa.');
        const r = await api('POST', '/api/config/suporte', { webhook: wh.value, categoriaId: f.id, estagioId: et.id, funilNome: f.nome, etapaNome: et.nome }); toast(r.reenviados ? `Integração salva. ${r.reenviados} chamado(s) pendente(s) enviados.` : 'Integração salva.'); render();
      } catch (x) { msg.append(h('div', { class: 'erro' }, x.message)); ev.target.disabled = false; } } }, 'Salvar integração'),
        e.pendentes > 0 && h('button', { class: 'btn', onclick: async () => { const r = await api('POST', '/api/config/suporte/reenviar', {}); toast(`${r.reenviados} chamado(s) reenviado(s).`); render(); } }, `Reenviar ${e.pendentes} pendente(s)`))),
    h('div', { class: 'card integ', style: 'margin-top:16px' }, h('h3', {}, 'Prazo de resposta (SLA)'), h('p', { class: 'muted small' }, 'Tempo para a primeira resposta da equipe ao cliente, em horas corridas, conforme a prioridade do chamado.'),
      (() => { const inp = {}; const campos = Object.entries({ urgente: 'Urgente', alta: 'Alta', media: 'Média', baixa: 'Baixa' }).map(([k, rot]) => h('div', {}, h('label', {}, `${rot} (horas)`), (inp[k] = h('input', { type: 'number', min: 1, max: 720, value: slaCfg[k] }))));
        const err = h('div'); return h('div', {}, h('div', { class: 'g2' }, campos), err, h('button', { class: 'btn pri', style: 'margin-top:12px', onclick: async () => { try { await api('POST', '/api/config/sla', Object.fromEntries(Object.entries(inp).map(([k, el]) => [k, el.value]))); toast('Prazos de resposta salvos.'); } catch (x) { err.replaceChildren(h('div', { class: 'erro' }, x.message)); } } }, 'Salvar prazos')); })()),
    h('div', { class: 'card integ', style: 'margin-top:16px' }, h('h3', {}, 'O que vai no card'), h('ul', { class: 'bene2' }, ['Título: [SUP-0001] assunto — cliente (empresa), com a prioridade quando for alta ou urgente', 'Protocolo, data e hora, categoria e prioridade', 'Cliente, empresa, e-mail e telefone (o contato é criado ou reaproveitado pelo e-mail e vinculado ao card)', 'Projeto relacionado (nome e código)', 'Descrição completa escrita pelo cliente', 'Se o Bitrix24 estiver fora do ar, o chamado fica na fila e é reenviado automaticamente']
      .map(x => h('li', {}, x)))));
}

async function telaLog(m) {
  const { projetos } = await api('GET', '/api/projetos'); const f = view.f = view.f || { projeto: '', tipo: '', cat: '', dias: '30', q: '' }; if (view.projeto) { f.projeto = view.projeto; view.projeto = null; }
  const qs = () => new URLSearchParams(Object.fromEntries(Object.entries({ projeto: f.projeto, tipo: f.tipo, cat: f.cat, dias: f.dias, q: f.q, limite: 500 }).filter(([, v]) => v))).toString();
  const out = h('div', { class: 'card' }), cont = h('span', { class: 'muted small' }); let tmr;
  const carrega = async () => { try { const { logs } = await api('GET', '/api/logs?' + qs()); cont.textContent = `${logs.length} registro(s)${logs.length >= 500 ? ' (mostrando os 500 mais recentes; exporte para ver tudo)' : ''}`; out.replaceChildren(listaLog(logs, true)); } catch (e) { out.replaceChildren(h('div', { class: 'erro' }, e.message)); } };
  const sel = (k, op) => h('select', { style: 'width:auto', onchange: e => { f[k] = e.target.value; carrega(); } }, op.map(([v, t]) => h('option', { value: v, selected: v === f[k] }, t)));
  juntar(m, h('h1', {}, 'Acessos e log'), h('p', { class: 'muted' }, 'Registro permanente de tudo: alterações (de → para), acessos do cliente, documentos e chamados. Guardado também em arquivo no servidor.'),
    h('div', { class: 'toolbar' }, h('div', { class: 'filtros' }, sel('projeto', [['', 'Todos os projetos'], ...projetos.map(p => [p.id, p.nome])]), sel('tipo', [['', 'Equipe e cliente'], ['equipe', 'Só equipe'], ['cliente', 'Só cliente']]), sel('cat', [['', 'Tudo'], ['alteracoes', 'Alterações'], ['acessos', 'Acessos'], ['comunicacao', 'Comunicação']]), sel('dias', [['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'], ['', 'Todo o período']])),
      h('div', { class: 'filtros' }, h('input', { class: 'busca', type: 'search', placeholder: 'Buscar pessoa, atividade ou valor', value: f.q, oninput: e => { f.q = e.target.value; clearTimeout(tmr); tmr = setTimeout(carrega, 300); } }),
        h('button', { class: 'btn sm', onclick: async ev => { ev.target.disabled = true; try { const r = await fetch('/api/logs.csv?' + qs(), { credentials: 'same-origin' }); if (!r.ok) throw new Error('Não foi possível exportar.'); const u = URL.createObjectURL(await r.blob()); const a = h('a', { href: u, download: 'log-projetos-m4.csv' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); } catch (e) { toast(e.message); } ev.target.disabled = false; } }, 'Exportar CSV'))), cont, out);
  await carrega();
}
boot();
