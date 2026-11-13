'use strict';
/* Hub do Escritório — interface. Sem dependências; roteamento por hash. */
const $app = document.getElementById('app');
const state = { me: null, portal: '', wizard: null, clientes: { q: '', items: [], loading: false, hasMore: false, loaded: false }, drawer: null };

/* ---------- utilidades ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digits = (s) => String(s ?? '').replace(/\D+/g, '');
const IC = {
  back: 'M15 18l-6-6 6-6', arrow: 'M5 12h14M13 6l6 6-6 6', check: 'M20 6L9 17l-5-5', search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.3-4.3',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0', plus: 'M12 5v14M5 12h14', x: 'M18 6L6 18M6 6l12 12',
  shield: 'M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6l8-3zM9 12l2 2 4-4', building: 'M4 21V5l8-2v18M12 9h8v12M8 8h.01M8 12h.01M8 16h.01M16 13h.01M16 17h.01', users: 'M16 11a3 3 0 100-6 3 3 0 000 6zM8 12a3 3 0 100-6 3 3 0 000 6zM2 20a6 6 0 0112 0M14 14a6 6 0 018 6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z', info: 'M12 16v-4M12 8h.01M12 22a10 10 0 100-20 10 10 0 000 20z',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5', cal: 'M8 3v4M16 3v4M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  doc: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5M9 13h6M9 17h6', coin: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v10M15 9.5c-.6-.9-1.7-1.5-3-1.5-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.3 0 1.3-1.3 2.2-3 2.2-1.3 0-2.4-.6-3-1.5', link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.700l1-1',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

function fmtCnpj(v) {
  const d = digits(v).slice(0, 14);
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
}
function fmtCpf(v) {
  const d = digits(v).slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
}
function validCnpj(v) {
  const d = digits(v); if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv = (b) => { let s = 0, w = b.length - 7; for (const c of b) { s += +c * w--; if (w < 2) w = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  const a = dv(d.slice(0, 12)); return d.endsWith(`${a}${dv(d.slice(0, 12) + a)}`);
}
function validCpf(v) {
  const d = digits(v); if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const dv = (b) => { let s = 0; for (let i = 0; i < b.length; i++) s += +b[i] * (b.length + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  const a = dv(d.slice(0, 9)); return d.endsWith(`${a}${dv(d.slice(0, 9) + a)}`);
}
function fmtPhone(v) {
  const d = digits(v).replace(/^55(?=\d{10,11}$)/, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return d.length <= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
const money = (n) => (n ? Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
const enderecoStr = (e) => e ? [[e.logradouro, e.numero].filter(Boolean).join(', '), e.complemento, e.bairro, [e.municipio, e.uf].filter(Boolean).join('/'), e.cep].filter(Boolean).join(' · ') : '';
function situacaoBadge(s) {
  if (!s) return '<span class="badge">Sem validação</span>';
  const k = /ativa/i.test(s) ? 'ok' : /suspens|inapt/i.test(s) ? 'warn' : 'bad';
  return `<span class="badge ${k}">${esc(s)}</span>`;
}

async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch(path, { method, headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'X-Hub': '1' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch { throw Object.assign(new Error('Sem conexão com o servidor. Verifique sua internet.'), { code: 'NETWORK' }); }
  let j = null; try { j = await r.json(); } catch { /* vazio */ }
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `Erro ${r.status}`), { code: j?.error?.code, status: r.status });
  return j;
}
function toast(msg, bad) {
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  document.getElementById('toasts').append(t); setTimeout(() => t.remove(), bad ? 6000 : 3500);
}
function openInBitrix(path) { if (state.portal) window.top.location.href = `https://${state.portal}${path}`; }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- roteamento ---------- */
function go(h) { if (location.hash === h) render(); else location.hash = h; }
window.addEventListener('hashchange', render);
function render() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (h === '/' || h === '') return renderHub();
  if (h.startsWith('/novo')) return renderShell('novo');
  if (h.startsWith('/clientes')) return renderShell('clientes');
  go('#/');
}

/* ---------- Hub ---------- */
function renderHub() {
  closeDrawer();
  const nome = state.me?.name || '';
  const hora = new Date().getHours();
  const saud = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
  const soon = [['cal', 'Prazos e audiências', 'Controle de prazos processuais e agenda de audiências.'], ['doc', 'Contratos e documentos', 'Modelos, assinatura e arquivo dos documentos do cliente.'], ['coin', 'Honorários', 'Acompanhe propostas, cobranças e recebimentos.']];
  $app.innerHTML = `
  <div class="hub">
    <header class="hub-hero">
      <div class="hub-top">
        <div class="brand"><span class="brand-mark">${icon('shield')}</span><span>Hub do Escritório</span></div>
        ${nome ? `<div class="user-chip"><span class="avatar" aria-hidden="true">${esc(initials(nome))}</span><span>${esc(nome)}</span></div>` : ''}
      </div>
      <h1>${saud}${nome ? `, ${esc(nome.split(' ')[0])}` : ''}.</h1>
      <p>Escolha a ferramenta que você vai usar agora. Tudo conectado ao cadastro de clientes do escritório.</p>
    </header>
    <div class="hub-body"><div class="modules" id="main" role="list">
      <button class="module" role="listitem" data-go="#/novo">
        <span class="ico">${icon('shield')}</span>
        <h3>Validador de Cadastro</h3>
        <p>Cadastre clientes a partir do CNPJ com dados da Receita Federal, vincule contatos e consulte a base de clientes.</p>
        <span class="go">Abrir módulo ${icon('arrow')}</span>
      </button>
      ${soon.map(([i, t, d]) => `<div class="module soon" role="listitem" aria-disabled="true"><span class="tag">Em breve</span><span class="ico">${icon(i)}</span><h3>${t}</h3><p>${d}</p></div>`).join('')}
    </div></div>
  </div>`;
  $app.querySelector('[data-go]').onclick = (e) => go(e.currentTarget.dataset.go);
}

/* ---------- Estrutura do módulo ---------- */
function renderShell(tab) {
  $app.innerHTML = `
  <div class="shell">
    <div class="bar"><div class="bar-in">
      <button class="back" id="back" aria-label="Voltar ao Hub">${icon('back')}<span>Hub</span></button>
      <div class="mod-title">${icon('shield')}<span>Validador de Cadastro</span></div>
      <nav class="tabs" aria-label="Seções">
        <button class="tab" data-t="novo" aria-label="Novo cadastro" ${tab === 'novo' ? 'aria-current="page"' : ''}>${icon('plus')}<span>Novo cadastro</span></button>
        <button class="tab" data-t="clientes" aria-label="Clientes" ${tab === 'clientes' ? 'aria-current="page"' : ''}>${icon('building')}<span>Clientes</span></button>
      </nav>
    </div></div>
    <main id="main"></main>
  </div>`;
  $app.querySelector('#back').onclick = () => go('#/');
  $app.querySelectorAll('.tab').forEach((b) => (b.onclick = () => go(`#/${b.dataset.t}`)));
  const main = $app.querySelector('main');
  if (tab === 'novo') { closeDrawer(); renderWizard(main); } else renderClientes(main);
}

/* ---------- Novo cadastro (3 passos) ---------- */
function newWizard() {
  return { step: 1, cnpj: '', status: 'idle', msg: '', receita: null, existing: null, manual: false, empresa: null, contatos: [], busy: false, result: null };
}
function empresaFromReceita(r) {
  return {
    title: r.nomeFantasia || r.razaoSocial, razaoSocial: r.razaoSocial, cnpj: r.cnpj, situacao: r.situacao,
    cnae: [r.cnae?.codigo && r.cnae.codigo.replace(/^(\d{4})(\d)(\d{2})$/, '$1-$2/$3'), r.cnae?.descricao].filter(Boolean).join(' · '),
    porte: r.porte, natureza: r.naturezaJuridica, abertura: r.abertura, endereco: enderecoStr(r.endereco),
    telefone: r.telefones?.[0] || '', email: r.email || '',
  };
}
const emptyEmpresa = (cnpj) => ({ title: '', razaoSocial: '', cnpj, situacao: '', cnae: '', porte: '', natureza: '', abertura: '', endereco: '', telefone: '', email: '' });

function stepsBar(n) {
  const L = ['Empresa', 'Contatos', 'Revisão'];
  return `<ol class="steps" style="list-style:none;padding:0">${L.map((t, i) => `<li class="step ${i + 1 === n ? 'on' : i + 1 < n ? 'done' : ''}"><b>${i + 1 < n ? '✓' : i + 1}</b>${t}</li>`).join('')}</ol>`;
}
function renderWizard(main) {
  if (!state.wizard) state.wizard = newWizard();
  const w = state.wizard;
  if (w.result) return renderSuccess(main);
  main.innerHTML = `<div class="page-h"><h2>Novo cadastro de cliente</h2><p>Digite o CNPJ: buscamos os dados na Receita Federal e preenchemos o cadastro para você.</p></div>${stepsBar(w.step)}<div id="wz"></div>`;
  const box = main.querySelector('#wz');
  ({ 1: stepEmpresa, 2: stepContatos, 3: stepRevisao })[w.step](box, w);
}

function stepEmpresa(box, w) {
  const d = digits(w.cnpj), full = d.length === 14, ok = full && validCnpj(d);
  const cls = full ? (ok ? 'good' : 'bad') : '';
  box.innerHTML = `
  <div class="stack">
    <section class="card card-p">
      <label for="cnpj" class="section-t">CNPJ da empresa</label>
      <div class="cnpj-box ${cls}">
        <input id="cnpj" inputmode="numeric" autocomplete="off" placeholder="00.000.000/0000-00" value="${esc(fmtCnpj(w.cnpj))}" aria-describedby="cnpj-hint" ${full && !ok ? 'aria-invalid="true"' : ''} autofocus>
        <button class="btn primary" id="buscar" ${ok && w.status !== 'loading' ? '' : 'disabled'}>${w.status === 'loading' ? '<span class="spin"></span> Consultando…' : `${icon('search')} Buscar na Receita`}</button>
      </div>
      <p class="hint ${full ? (ok ? 'good' : 'bad') : ''}" id="cnpj-hint">${full ? (ok ? '✓ CNPJ válido' : 'CNPJ inválido: confira os dígitos.') : 'Somente números — a formatação é automática.'}</p>
    </section>
    ${w.status === 'loading' ? skeletonCard() : ''}
    ${w.status === 'error' ? `<div class="banner ${w.errCode === 'CNPJ_NOT_FOUND' ? 'bad' : 'warn'}">${icon('alert')}<div><b>${esc(w.msg)}</b>${w.errCode === 'CNPJ_NOT_FOUND' ? 'Confira o número com o cliente. ' : ''}<button class="btn sm ghost" id="manual" style="margin-top:10px">Preencher manualmente</button></div></div>` : ''}
    ${w.existing ? duplicateBanner(w.existing) : ''}
    ${w.empresa && !w.existing ? empresaForm(w) : ''}
  </div>`;
  const inp = box.querySelector('#cnpj');
  inp.setSelectionRange?.(inp.value.length, inp.value.length);
  inp.addEventListener('input', () => {
    const before = digits(w.cnpj); w.cnpj = digits(inp.value).slice(0, 14);
    if (w.cnpj !== before) { w.status = 'idle'; w.receita = w.existing = w.empresa = null; w.manual = false; }
    if (w.cnpj.length === 14 && validCnpj(w.cnpj)) return lookup();
    stepEmpresa(box, w); const i2 = box.querySelector('#cnpj'); i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length);
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ok) lookup(); });
  box.querySelector('#buscar')?.addEventListener('click', lookup);
  box.querySelector('#manual')?.addEventListener('click', () => { w.manual = true; w.status = 'idle'; w.empresa = emptyEmpresa(w.cnpj); stepEmpresa(box, w); });
  box.querySelector('#open-existing')?.addEventListener('click', () => { state.wizard = null; go('#/clientes'); openCompany(w.existing.id); });
  box.querySelector('#new-cnpj')?.addEventListener('click', () => { state.wizard = newWizard(); renderWizard(box.closest('main')); });
  bindEmpresaForm(box, w);

  async function lookup() {
    if (w.status === 'loading') return;
    w.status = 'loading'; w.msg = ''; stepEmpresa(box, w);
    try {
      const r = await api(`/api/cnpj?v=${digits(w.cnpj)}`);
      w.existing = r.existing; w.receita = r.receita;
      if (r.receita) { w.empresa = empresaFromReceita(r.receita); w.status = 'ok'; }
      else if (!r.existing) { w.status = 'error'; w.msg = r.receitaError?.message || 'Consulta indisponível.'; w.errCode = r.receitaError?.code; }
      else w.status = 'ok';
    } catch (e) { w.status = 'error'; w.msg = e.message; w.errCode = e.code; }
    stepEmpresa(box, w);
  }
}
function skeletonCard() {
  return `<section class="card card-p" aria-busy="true"><div class="stack"><div class="skel" style="width:40%;height:22px"></div><div class="skel" style="width:70%"></div><div class="grid2"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div><p class="small muted">Consultando a Receita Federal e conferindo se o cliente já está cadastrado…</p></div></section>`;
}
function duplicateBanner(c) {
  return `<div class="banner warn">${icon('alert')}<div><b>Este CNPJ já está cadastrado</b>${esc(c.title)} · ${esc(c.cnpj)}. Para evitar duplicidade, abra o cadastro existente para ver ou vincular contatos.
    <div class="row" style="margin-top:12px"><button class="btn primary sm" id="open-existing">Abrir cadastro existente</button><button class="btn ghost sm" id="new-cnpj">Digitar outro CNPJ</button></div></div></div>`;
}
function empresaForm(w) {
  const e = w.empresa, r = w.receita;
  const sit = e.situacao && !/ativa/i.test(e.situacao);
  return `
  ${r ? `<div class="banner ${sit ? 'warn' : 'ok'}">${icon(sit ? 'alert' : 'check')}<div><b>${sit ? `Atenção: situação cadastral ${esc(e.situacao)}` : 'Empresa localizada e ativa na Receita Federal'}</b>${r.situacaoData ? `Situação desde ${esc(r.situacaoData)}. ` : ''}${sit ? 'Confirme com o cliente antes de seguir com o cadastro.' : `Dados obtidos via ${esc(r.fonte)}; revise e ajuste se necessário.`}</div></div>` : (w.manual ? `<div class="banner info">${icon('info')}<div><b>Preenchimento manual</b>Os dados não foram validados na Receita Federal.</div></div>` : '')}
  <section class="card card-p stack">
    <div class="company-head"><div><div class="section-t" style="margin:0">Dados da empresa</div><h3>${esc(e.title || 'Nova empresa')}</h3></div>${situacaoBadge(e.situacao)}</div>
    <div class="grid2">
      <label class="f"><span>Nome do cliente</span><input class="in" data-f="title" value="${esc(e.title)}" required></label>
      <label class="f"><span>Razão social</span><input class="in" data-f="razaoSocial" value="${esc(e.razaoSocial)}"></label>
      <label class="f"><span>Telefone</span><input class="in" data-f="telefone" inputmode="tel" value="${esc(e.telefone)}"></label>
      <label class="f"><span>E-mail</span><input class="in" data-f="email" type="email" value="${esc(e.email)}"></label>
    </div>
    <label class="f"><span>Endereço</span><input class="in" data-f="endereco" value="${esc(e.endereco)}"></label>
    <dl class="kv">
      <div><dt>Atividade principal</dt><dd>${esc(e.cnae) || '—'}</dd></div>
      <div><dt>Porte</dt><dd>${esc(e.porte) || '—'}</dd></div>
      <div><dt>Natureza jurídica</dt><dd>${esc(e.natureza) || '—'}</dd></div>
      <div><dt>Abertura</dt><dd>${esc(e.abertura) || '—'}</dd></div>
      ${r ? `<div><dt>Capital social</dt><dd>${money(r.capitalSocial)}</dd></div><div><dt>Tipo</dt><dd>${r.matriz === null ? '—' : r.matriz ? 'Matriz' : 'Filial'}</dd></div>` : ''}
    </dl>
    <div class="actions"><span></span><button class="btn primary" id="to2" ${e.title.trim() ? '' : 'disabled'}>Continuar para contatos ${icon('arrow')}</button></div>
  </section>`;
}
function bindEmpresaForm(box, w) {
  box.querySelectorAll('[data-f]').forEach((i) => i.addEventListener('input', () => {
    w.empresa[i.dataset.f] = i.value;
    if (i.dataset.f === 'telefone') { /* livre: números fixos e celulares */ }
    const b = box.querySelector('#to2'); if (b) b.disabled = !w.empresa.title.trim();
    if (i.dataset.f === 'title') { const h = box.querySelector('.company-head h3'); if (h) h.textContent = i.value || 'Nova empresa'; }
  }));
  box.querySelector('#to2')?.addEventListener('click', () => {
    const em = w.empresa.email.trim();
    if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return toast('E-mail da empresa inválido.', true);
    w.step = 2; renderWizard(box.closest('main')); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function stepContatos(box, w) {
  const socios = (w.receita?.socios || []).filter((s) => !w.contatos.some((c) => c.nome.toLowerCase() === s.nome.toLowerCase()));
  box.innerHTML = `
  <div class="stack">
    ${socios.length ? `<section class="card card-p"><div class="section-t">Sócios e administradores (Receita Federal)</div><p class="small muted" style="margin-bottom:12px">Toque para adicionar como contato da empresa.</p><div class="chips">${socios.map((s, i) => `<button class="chip" data-socio="${i}">${icon('plus')}<span>${esc(s.nome)}</span> <small>${esc(s.qualificacao)}</small></button>`).join('')}</div></section>` : ''}
    <section class="card card-p stack">
      <div class="section-t" style="margin:0">Contatos desta empresa <span class="badge info">${w.contatos.length}</span></div>
      ${w.contatos.length ? w.contatos.map((c, i) => personRow(c, `<button class="btn danger sm" data-rm="${i}">Remover</button>`)).join('') : `<p class="muted small">Nenhum contato adicionado ainda. Você pode pular esta etapa e vincular depois.</p>`}
      <div class="row"><button class="btn gold" id="add-new">${icon('plus')} Novo contato</button><button class="btn ghost" id="add-link">${icon('link')} Vincular contato existente</button></div>
      <div id="contact-panel"></div>
    </section>
    <div class="actions"><button class="btn ghost" id="b1">${icon('back')} Voltar</button><button class="btn primary" id="to3">Revisar ${icon('arrow')}</button></div>
  </div>`;
  box.querySelectorAll('[data-socio]').forEach((b) => (b.onclick = () => { const s = socios[+b.dataset.socio]; w.contatos.push({ nome: s.nome, cargo: s.qualificacao }); stepContatos(box, w); }));
  box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { w.contatos.splice(+b.dataset.rm, 1); stepContatos(box, w); }));
  box.querySelector('#b1').onclick = () => { w.step = 1; renderWizard(box.closest('main')); };
  box.querySelector('#to3').onclick = () => { w.step = 3; renderWizard(box.closest('main')); window.scrollTo({ top: 0 }); };
  const panel = box.querySelector('#contact-panel');
  box.querySelector('#add-new').onclick = () => contactForm(panel, (c) => { w.contatos.push(c); stepContatos(box, w); });
  box.querySelector('#add-link').onclick = () => contactPicker(panel, w.contatos.filter((c) => c.contactId).map((c) => c.contactId), (c) => { w.contatos.push({ contactId: c.id, nome: c.nome, cargo: c.cargo, telefone: c.telefones[0], email: c.emails[0] }); stepContatos(box, w); });
}
function personRow(c, right = '') {
  const sub = [c.cargo, c.telefone || c.telefones?.[0], c.email || c.emails?.[0]].filter(Boolean).map(esc).join(' · ');
  return `<div class="person"><span class="avatar" aria-hidden="true">${esc(initials(c.nome))}</span><div class="info"><b>${esc(c.nome)} ${c.contactId ? '<span class="badge info">Já cadastrado</span>' : ''}</b><span>${sub || 'Sem telefone ou e-mail'}</span></div>${right}</div>`;
}
function contactForm(panel, onSave) {
  panel.innerHTML = `<form class="card card-p stack" style="box-shadow:none;background:#fafbfd" novalidate>
    <div class="section-t" style="margin:0">Novo contato</div>
    <div class="grid2">
      <label class="f"><span>Nome completo</span><input class="in" name="nome" required autocomplete="off"></label>
      <label class="f"><span>Cargo <em>(opcional)</em></span><input class="in" name="cargo"></label>
      <label class="f"><span>Telefone / WhatsApp</span><input class="in" name="telefone" inputmode="tel" placeholder="(00) 00000-0000"></label>
      <label class="f"><span>E-mail</span><input class="in" name="email" type="email"></label>
      <label class="f"><span>CPF <em>(opcional)</em></span><input class="in" name="cpf" inputmode="numeric" placeholder="000.000.000-00"></label>
    </div>
    <p class="hint bad" id="cf-err" role="alert"></p>
    <div class="row"><button class="btn primary" type="submit">Adicionar contato</button><button class="btn ghost" type="button" id="cf-cancel">Cancelar</button></div></form>`;
  const f = panel.querySelector('form');
  f.telefone.addEventListener('input', () => (f.telefone.value = fmtPhone(f.telefone.value)));
  f.cpf.addEventListener('input', () => (f.cpf.value = fmtCpf(f.cpf.value)));
  f.nome.focus();
  panel.querySelector('#cf-cancel').onclick = () => (panel.innerHTML = '');
  f.onsubmit = (e) => {
    e.preventDefault();
    const c = { nome: f.nome.value.trim(), cargo: f.cargo.value.trim(), telefone: f.telefone.value.trim(), email: f.email.value.trim(), cpf: f.cpf.value.trim() };
    const err = !c.nome ? 'Informe o nome do contato.' : c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email) ? 'E-mail inválido.' : c.cpf && !validCpf(c.cpf) ? 'CPF inválido.' : '';
    if (err) { panel.querySelector('#cf-err').textContent = err; return; }
    onSave(c);
  };
}
function contactPicker(panel, exclude, onPick) {
  panel.innerHTML = `<div class="stack"><div class="search"><span aria-hidden="true">${icon('search')}</span><input class="in" id="cp-q" placeholder="Buscar contato pelo nome…" autocomplete="off"></div><div id="cp-res" aria-live="polite"></div></div>`;
  const q = panel.querySelector('#cp-q'), res = panel.querySelector('#cp-res'); q.focus();
  const run = debounce(async () => {
    if (q.value.trim().length < 2) { res.innerHTML = ''; return; }
    res.innerHTML = '<div class="skel" style="height:44px"></div>';
    try {
      const { items } = await api(`/api/contacts?q=${encodeURIComponent(q.value.trim())}`);
      const list = items.filter((c) => !exclude.includes(c.id));
      res.innerHTML = list.length ? `<div class="results">${list.map((c, i) => `<button data-i="${i}"><span><b>${esc(c.nome)}</b><br><span class="small muted">${[c.cargo, c.emails[0], c.telefones[0]].filter(Boolean).map(esc).join(' · ') || 'Sem detalhes'}</span></span><span class="badge info">Vincular</span></button>`).join('')}</div>` : '<p class="small muted">Nenhum contato encontrado. Use “Novo contato”.</p>';
      res.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => onPick(list[+b.dataset.i])));
    } catch (e) { res.innerHTML = `<p class="hint bad">${esc(e.message)}</p>`; }
  }, 300);
  q.addEventListener('input', run);
}

function stepRevisao(box, w) {
  const e = w.empresa;
  box.innerHTML = `<div class="stack">
    <section class="card card-p stack">
      <div class="company-head"><div><div class="section-t" style="margin:0">Empresa</div><h3>${esc(e.title)}</h3><p class="muted small mono">${esc(fmtCnpj(e.cnpj)) || 'CNPJ não informado'}</p></div>${situacaoBadge(e.situacao)}</div>
      <dl class="kv">
        <div><dt>Razão social</dt><dd>${esc(e.razaoSocial) || '—'}</dd></div><div><dt>Telefone</dt><dd>${esc(e.telefone) || '—'}</dd></div>
        <div><dt>E-mail</dt><dd>${esc(e.email) || '—'}</dd></div><div><dt>Endereço</dt><dd>${esc(e.endereco) || '—'}</dd></div>
      </dl>
      ${w.receita ? '' : `<div class="banner warn">${icon('alert')}<div><b>Cadastro sem validação da Receita</b>Os dados foram digitados manualmente.</div></div>`}
    </section>
    <section class="card card-p stack"><div class="section-t" style="margin:0">Contatos (${w.contatos.length})</div>
      ${w.contatos.length ? w.contatos.map((c) => personRow(c)).join('') : '<p class="muted small">Nenhum contato será vinculado agora.</p>'}</section>
    <p class="hint bad" id="save-err" role="alert">${esc(w.saveErr || '')}</p>
    <div class="actions"><button class="btn ghost" id="b2">${icon('back')} Voltar</button><button class="btn gold" id="save" ${w.busy ? 'disabled' : ''}>${w.busy ? '<span class="spin"></span> Cadastrando…' : `${icon('check')} Cadastrar no Bitrix24`}</button></div>
  </div>`;
  box.querySelector('#b2').onclick = () => { w.step = 2; renderWizard(box.closest('main')); };
  box.querySelector('#save').onclick = async () => {
    w.busy = true; w.saveErr = ''; stepRevisao(box, w);
    try {
      const empresa = { ...e, cnpj: e.cnpj || undefined, telefones: e.telefone ? [e.telefone] : [], emails: e.email ? [e.email] : [], validadoEm: w.receita ? new Date().toLocaleDateString('pt-BR') : undefined };
      delete empresa.telefone; delete empresa.email;
      w.result = await api('/api/companies', { method: 'POST', body: { empresa, contatos: w.contatos } });
      w.result.nome = e.title;
    } catch (err) { w.saveErr = err.message; }
    w.busy = false; renderWizard(box.closest('main'));
  };
}
function renderSuccess(main) {
  const w = state.wizard, r = w.result, falhas = r.contatos.filter((c) => !c.ok), okc = r.contatos.length - falhas.length;
  main.innerHTML = `<section class="card success">
    <div class="check">${icon('check')}</div><h2>${esc(r.nome)} cadastrado!</h2>
    <p class="muted">${okc ? `${okc} contato${okc > 1 ? 's' : ''} vinculado${okc > 1 ? 's' : ''}.` : 'Empresa criada sem contatos vinculados.'}</p>
    ${falhas.length ? `<div class="banner bad" style="text-align:left;max-width:520px">${icon('alert')}<div><b>Alguns contatos não foram salvos</b>${falhas.map((f) => `${esc(f.nome)}: ${esc(f.error)}`).join('<br>')}<br>Abra o cliente para tentar novamente.</div></div>` : ''}
    <div class="row" style="justify-content:center"><button class="btn primary" id="s-open">Ver cliente</button>${state.portal ? `<button class="btn ghost" id="s-bx">${icon('ext')} Abrir no Bitrix24</button>` : ''}<button class="btn ghost" id="s-new">Novo cadastro</button></div></section>`;
  main.querySelector('#s-open').onclick = () => { const id = r.id; state.wizard = null; state.clientes.loaded = false; go('#/clientes'); openCompany(id); };
  main.querySelector('#s-bx')?.addEventListener('click', () => openInBitrix(`/crm/company/details/${r.id}/`));
  main.querySelector('#s-new').onclick = () => { state.wizard = newWizard(); state.clientes.loaded = false; renderWizard(main); };
}

/* ---------- Clientes ---------- */
function renderClientes(main) {
  const c = state.clientes;
  main.innerHTML = `<div class="page-h"><h2>Clientes</h2><p>Consulte empresas e contatos cadastrados no Bitrix24.</p></div>
    <div class="toolbar"><div class="search"><span aria-hidden="true">${icon('search')}</span><input class="in" id="q" placeholder="Buscar por nome, razão social ou CNPJ…" value="${esc(c.q)}" autocomplete="off" aria-label="Buscar clientes"></div>
    <button class="btn primary" id="nov">${icon('plus')} Novo cadastro</button></div>
    <div class="card" style="overflow:hidden"><div id="list"></div></div><div class="row" style="justify-content:center;margin-top:16px" id="more"></div>`;
  main.querySelector('#nov').onclick = () => go('#/novo');
  const q = main.querySelector('#q');
  q.addEventListener('input', debounce(() => { c.q = q.value.trim(); loadClientes(true); }, 300));
  if (!c.loaded) loadClientes(true); else paintClientes();
  const m = /^#\/clientes\/(\d+)/.exec(location.hash); if (m) openCompany(+m[1]);
}
async function loadClientes(reset) {
  const c = state.clientes; if (c.loading) { c.again = true; return; }
  c.loading = true; c.err = ''; if (reset) { c.items = []; c.hasMore = false; }
  paintClientes();
  try {
    const r = await api(`/api/companies?limit=30&offset=${reset ? 0 : c.items.length}&q=${encodeURIComponent(c.q)}`);
    c.items = reset ? r.items : c.items.concat(r.items); c.hasMore = r.hasMore && !c.q; c.loaded = true;
  } catch (e) { c.err = e.message; }
  c.loading = false; paintClientes();
  if (c.again) { c.again = false; loadClientes(true); }
}
function paintClientes() {
  const c = state.clientes, list = document.getElementById('list'); if (!list) return;
  if (c.loading && !c.items.length) list.innerHTML = Array.from({ length: 5 }, () => '<div style="padding:18px"><div class="skel" style="width:45%;margin-bottom:8px"></div><div class="skel" style="width:25%"></div></div>').join('');
  else if (c.err) list.innerHTML = `<div class="empty"><div class="ico">${icon('alert')}</div><b>Não foi possível carregar</b><p>${esc(c.err)}</p><button class="btn" id="retry" style="margin-top:12px">Tentar de novo</button></div>`;
  else if (!c.items.length) list.innerHTML = `<div class="empty"><div class="ico">${icon('building')}</div><b>${c.q ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado ainda'}</b><p>${c.q ? 'Tente outro nome ou CNPJ.' : 'Comece pelo primeiro cadastro.'}</p><button class="btn gold" id="nov2" style="margin-top:12px">${icon('plus')} Novo cadastro</button></div>`;
  else list.innerHTML = `<table class="t"><thead><tr><th>Cliente</th><th>CNPJ</th><th>Situação</th><th class="hide-s">Contato</th></tr></thead><tbody>${c.items.map((x) => `<tr class="click" tabindex="0" data-id="${x.id}"><td class="name-cell"><b>${esc(x.title)}</b><span>${esc(x.razaoSocial && x.razaoSocial !== x.title ? x.razaoSocial : x.endereco.split(',').slice(-2).join(',').trim())}</span></td><td class="mono">${esc(x.cnpj) || '—'}</td><td>${situacaoBadge(x.situacao)}</td><td class="hide-s">${esc(x.telefones[0] || x.emails[0] || '—')}</td></tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('tr.click').forEach((r) => { const open = () => openCompany(+r.dataset.id); r.onclick = open; r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }; });
  list.querySelector('#retry')?.addEventListener('click', () => loadClientes(true));
  list.querySelector('#nov2')?.addEventListener('click', () => go('#/novo'));
  const more = document.getElementById('more');
  if (more) { more.innerHTML = c.hasMore ? `<button class="btn ghost" id="lm" ${c.loading ? 'disabled' : ''}>Carregar mais</button>` : ''; more.querySelector('#lm')?.addEventListener('click', () => loadClientes(false)); }
}

/* ---------- Gaveta do cliente ---------- */
function closeDrawer() { document.querySelectorAll('.scrim, .drawer').forEach((n) => n.remove()); state.drawer = null; document.removeEventListener('keydown', escClose); }
function escClose(e) { if (e.key === 'Escape') closeDrawer(); }
async function openCompany(id) {
  closeDrawer();
  const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.onclick = closeDrawer;
  const dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Detalhes do cliente');
  dr.innerHTML = `<div class="drawer-h"><b>Cliente</b><button class="x" aria-label="Fechar">${icon('x')}</button></div><div class="drawer-b"><div class="skel" style="height:26px;width:60%"></div><div class="skel"></div><div class="skel" style="width:80%"></div></div>`;
  document.body.append(scrim, dr); state.drawer = id; document.addEventListener('keydown', escClose);
  dr.querySelector('.x').onclick = closeDrawer; dr.querySelector('.x').focus();
  try { paintDrawer(dr, await api(`/api/companies/${id}`)); }
  catch (e) { dr.querySelector('.drawer-b').innerHTML = `<div class="banner bad">${icon('alert')}<div><b>Não foi possível abrir o cliente</b>${esc(e.message)}</div></div>`; }
}
function paintDrawer(dr, c) {
  const body = dr.querySelector('.drawer-b');
  body.innerHTML = `
    <section class="card card-p stack">
      <div class="company-head"><div><h3>${esc(c.title)}</h3><p class="muted small mono">${esc(c.cnpj) || 'CNPJ não informado'}</p></div>${situacaoBadge(c.situacao)}</div>
      <dl class="kv">
        <div><dt>Razão social</dt><dd>${esc(c.razaoSocial) || '—'}</dd></div><div><dt>Telefone</dt><dd>${c.telefones.map(esc).join('<br>') || '—'}</dd></div>
        <div><dt>E-mail</dt><dd>${c.emails.map(esc).join('<br>') || '—'}</dd></div><div><dt>Endereço</dt><dd>${esc(c.endereco) || '—'}</dd></div>
        <div><dt>Atividade principal</dt><dd>${esc(c.cnae) || '—'}</dd></div><div><dt>Porte</dt><dd>${esc(c.porte) || '—'}</dd></div>
        <div><dt>Abertura</dt><dd>${esc(c.abertura) || '—'}</dd></div><div><dt>Validado na Receita</dt><dd>${esc(c.validadoEm) || 'Não validado'}</dd></div>
      </dl>
      ${!c.cnpj ? `<div class="banner warn">${icon('alert')}<div><b>Cadastro sem CNPJ</b>Informe o CNPJ para validar este cliente.</div></div>` : ''}
      <div class="row">${state.portal ? `<button class="btn ghost sm" id="d-bx">${icon('ext')} Abrir no Bitrix24</button>` : ''}</div>
    </section>
    <section class="card card-p stack">
      <div class="section-t" style="margin:0">Contatos <span class="badge info">${c.contatos.length}</span></div>
      ${c.contatos.length ? c.contatos.map((p) => personRow(p, `<button class="btn danger sm" data-un="${p.id}" aria-label="Desvincular ${esc(p.nome)}">Desvincular</button>`)).join('') : '<p class="muted small">Nenhum contato vinculado.</p>'}
      <div class="row"><button class="btn gold sm" id="d-new">${icon('plus')} Novo contato</button><button class="btn ghost sm" id="d-link">${icon('link')} Vincular existente</button></div>
      <div id="d-panel"></div>
    </section>`;
  body.querySelector('#d-bx')?.addEventListener('click', () => openInBitrix(`/crm/company/details/${c.id}/`));
  const panel = body.querySelector('#d-panel');
  const after = (r) => { paintDrawer(dr, r.empresa); state.clientes.loaded = false; toast('Contato vinculado.'); };
  const fail = (e) => toast(e.message, true);
  body.querySelector('#d-new').onclick = () => contactForm(panel, (ct) => api(`/api/companies/${c.id}/contacts`, { method: 'POST', body: ct }).then(after, fail));
  body.querySelector('#d-link').onclick = () => contactPicker(panel, c.contatos.map((p) => p.id), (ct) => api(`/api/companies/${c.id}/contacts`, { method: 'POST', body: { contactId: ct.id } }).then(after, fail));
  body.querySelectorAll('[data-un]').forEach((b) => (b.onclick = () => {
    if (!confirm('Desvincular este contato da empresa? O contato continua existindo no Bitrix24.')) return;
    api(`/api/companies/${c.id}/contacts/${b.dataset.un}`, { method: 'DELETE' }).then((r) => { paintDrawer(dr, r); toast('Contato desvinculado.'); }, fail);
  }));
}

/* ---------- início ---------- */
(async function init() {
  render();
  try { const m = await api('/api/me'); state.me = m.user; state.portal = m.portal || ''; if ((location.hash || '#/') === '#/') renderHub(); }
  catch (e) {
    if (e.status === 401) $app.innerHTML = `<div class="hub"><div class="hub-body" style="margin-top:80px"><div class="card card-p stack" style="max-width:520px;margin:auto;text-align:center"><div class="empty"><div class="ico">${icon('shield')}</div><h2>Entre pelo Bitrix24</h2><p>Para usar o Hub, abra o app pelo menu do Bitrix24 ou conceda o acesso quando solicitado.</p></div></div></div></div>`;
  }
})();
