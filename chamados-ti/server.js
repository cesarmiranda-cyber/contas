// Portal de chamados de TI — grava os chamados no SPA do Bitrix24 (via VibeCode API).
// Node >= 20, sem dependências. Env: VIBE_API_KEY (obrigatória), SPA_TYPE_ID (1074), PORT (3000).
const http = require('http');
const fs = require('fs');
const path = require('path');

const API = 'https://vibecode.bitrix24.com/v1';
const KEY = process.env.VIBE_API_KEY;
const TYPE = Number(process.env.SPA_TYPE_ID || 1074);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');

const bx = async (method, p, body) => {
  const r = await fetch(API + p, { method, headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) { const e = new Error(j.error?.message || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
};

// Descoberta dos campos/etapas (cache de 5 min)
let meta = null, metaAt = 0;
async function loadMeta() {
  if (meta && Date.now() - metaAt < 300000) return meta;
  const fields = (await bx('GET', `/items/${TYPE}/fields`)).data.fields;
  const uf = (suffix) => Object.keys(fields).find((k) => k.toLowerCase() === `ufcrm${suffix}`.toLowerCase() || k.toLowerCase().endsWith(suffix.toLowerCase()) && k.toLowerCase().startsWith('ufcrm'));
  const f = { solic: uf('TiSolic'), email: uf('TiEmail'), setor: uf('TiSetor'), categ: uf('TiCateg'), prior: uf('TiPrior'), desc: uf('TiDesc') };
  if (Object.values(f).some((v) => !v)) throw new Error('Campos do chamado não encontrados no SPA — rode setup.js');
  const opts = (name) => fields[name].items.map((i) => ({ id: String(i.ID), label: i.VALUE }));
  const cats = (await bx('GET', `/categories/${TYPE}`)).data;
  const cat = cats.find((c) => c.isDefault) || cats[0];
  const stages = (await bx('GET', `/statuses?filter%5BentityId%5D=DYNAMIC_${TYPE}_STAGE_${cat.id}&limit=50`)).data
    .sort((a, b) => a.sort - b.sort).map((s) => ({ id: s.statusId, name: s.name, semantics: s.semantics || null }));
  meta = { f, categories: opts(f.categ), priorities: opts(f.prior), categoryId: cat.id, stages };
  metaAt = Date.now();
  return meta;
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function createTicket(b) {
  const m = await loadMeta();
  const t = {
    nome: clean(b.nome, 120), email: clean(b.email, 160).toLowerCase(), setor: clean(b.setor, 120),
    assunto: clean(b.assunto, 200), descricao: clean(b.descricao, 5000),
    categoria: String(b.categoria || ''), prioridade: String(b.prioridade || ''),
  };
  const err = [];
  if (!t.nome) err.push('Informe seu nome.');
  if (!EMAIL.test(t.email)) err.push('Informe um e-mail válido.');
  if (!t.assunto) err.push('Informe o assunto.');
  if (t.descricao.length < 10) err.push('Descreva o problema (mín. 10 caracteres).');
  if (!m.categories.some((c) => c.id === t.categoria)) err.push('Escolha a categoria.');
  if (!m.priorities.some((c) => c.id === t.prioridade)) err.push('Escolha a prioridade.');
  if (err.length) { const e = new Error(err.join(' ')); e.status = 400; throw e; }
  const r = await bx('POST', `/items/${TYPE}`, {
    title: t.assunto, categoryId: m.categoryId, stageId: m.stages[0].id,
    sourceDescription: 'Portal de chamados de TI',
    [m.f.solic]: t.nome, [m.f.email]: t.email, [m.f.setor]: t.setor,
    [m.f.categ]: t.categoria, [m.f.prior]: t.prioridade, [m.f.desc]: t.descricao,
  });
  return { id: r.data.id ?? r.data.item?.id };
}

async function listTickets(email) {
  const m = await loadMeta();
  const r = await bx('POST', `/items/${TYPE}/search`, { filter: { [m.f.email]: email }, sort: { id: 'desc' }, limit: 100 });
  const rows = Array.isArray(r.data) ? r.data : r.data.items || [];
  const label = (list, id) => list.find((x) => x.id === String(id))?.label || '';
  const stage = (id) => m.stages.find((s) => s.id === id);
  return rows.filter((i) => String(i[m.f.email] || '').toLowerCase() === email).map((i) => ({
    id: i.id, assunto: i.title, categoria: label(m.categories, i[m.f.categ]), prioridade: label(m.priorities, i[m.f.prior]),
    descricao: i[m.f.desc] || '', etapa: stage(i.stageId)?.name || i.stageId, resultado: stage(i.stageId)?.semantics || null,
    criadoEm: i.createdTime, atualizadoEm: i.updatedTime,
  }));
}

// Limite simples por IP (anti-abuso do formulário)
const hits = new Map();
const limited = (ip, max = 20, win = 60000) => {
  const now = Date.now(); const a = (hits.get(ip) || []).filter((t) => now - t < win);
  a.push(now); hits.set(ip, a); return a.length > max;
};

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 50000) { no(Object.assign(new Error('Corpo muito grande'), { status: 413 })); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { no(Object.assign(new Error('JSON inválido'), { status: 400 })); } });
});
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) {
      if (!KEY) return send(res, 500, { error: 'VIBE_API_KEY não configurada no servidor.' });
      if (limited(ip)) return send(res, 429, { error: 'Muitas requisições. Aguarde um instante.' });
      if (url.pathname === '/api/config' && req.method === 'GET') {
        const m = await loadMeta();
        return send(res, 200, { categories: m.categories, priorities: m.priorities, stages: m.stages });
      }
      if (url.pathname === '/api/tickets' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.website) return send(res, 201, { id: 0 }); // honeypot
        return send(res, 201, await createTicket(b));
      }
      if (url.pathname === '/api/tickets' && req.method === 'GET') {
        const email = clean(url.searchParams.get('email'), 160).toLowerCase();
        if (!EMAIL.test(email)) return send(res, 400, { error: 'Informe um e-mail válido.' });
        return send(res, 200, { tickets: await listTickets(email) });
      }
      return send(res, 404, { error: 'Rota não encontrada' });
    }
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, url.pathname, e.message);
    send(res, e.status && e.status < 500 ? e.status : 502, { error: e.status && e.status < 500 ? e.message : 'Não foi possível falar com o Bitrix24. Tente novamente.' });
  }
}).listen(PORT, () => console.log('Portal de chamados TI na porta', PORT));
