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
  const j = await r.json().catch(() => ({})); if (r.status === 401 && typeof U !== 'undefined' && U && U.tipo === 'cliente' && !url.startsWith('/api/auth/') && url !== '/api/me') sessaoExpirada('Sua sessão terminou. Entre novamente para continuar.'); if (!r.ok) throw Object.assign(new Error(j.erro || 'Erro inesperado.'), { status: r.status, dados: j }); return j;
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

