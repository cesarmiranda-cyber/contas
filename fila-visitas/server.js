'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createBitrix } = require('./lib/bitrix');
const { createStore } = require('./lib/store');
const { createService } = require('./lib/service');
const { request } = require('./lib/http');
const R = require('./lib/rules');
const { createAcesso } = require('./lib/acesso');
const D = require('./lib/duplicados');
const P = require('./lib/preparar');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = createStore(DATA_DIR);
const bitrix = createBitrix(process.env.BITRIX_WEBHOOK || '');
const acesso = createAcesso({ apiKey: process.env.VIBE_APP_KEY, log: m => store.log('aviso', m) });
const svc = createService({ bitrix, store, acesso });
const EVENT_TOKEN = process.env.EVENT_TOKEN || '';

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req, limite = 1e6) => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > limite) { no(Object.assign(new Error('Arquivo grande demais: o total dos anexos não pode passar de 25 MB.'), { status: 413 })); req.destroy(); } });
  req.on('end', () => {
    try { ok(b ? ((req.headers['content-type'] || '').includes('json') ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b))) : {}); } catch (e) { no(e); }
  });
});
const exige = () => { if (!bitrix.enabled) throw Object.assign(new Error('Defina BITRIX_WEBHOOK (webhook de entrada do Bitrix24).'), { status: 503 }); };

// Usuário logado: gateway da Vibe injeta X-Vibe-Authorization (precisa da chave do app em VIBE_APP_KEY); senão, o seletor da tela (?uid).
async function quem(req, u) {
  const bearer = req.headers['x-vibe-authorization'];
  if (bearer && process.env.VIBE_APP_KEY) {
    try {
      const r = await request('https://vibecode.bitrix24.com/v1/me', { headers: { 'X-Api-Key': process.env.VIBE_APP_KEY, Authorization: bearer } });
      const id = r.json?.data?.currentUser?.bitrixUserId;
      if (id) return { uid: +id, verificado: true, bearer };
    } catch { /* cai no seletor */ }
  }
  const uid = +(u.searchParams.get('uid') || 0);
  return { uid: uid || null, verificado: false };
}

// Acesso: quem configura / quem vê o dashboard. Com listas definidas, exige identidade verificada pelo Bitrix (gateway).
const nega = (m, s = 403) => Object.assign(new Error(m), { status: s });
function exigeConfig(id) {
  if (!svc.acessoRestrito()) return;
  if (!id.verificado) throw nega('Abra o app pelo Bitrix24 para acessar as configurações.');
  if (!svc.podeConfigurar(id.uid)) throw nega('Você não tem acesso às configurações.');
}
function exigeDashboard(id) {
  if (!svc.acessoRestrito()) return;
  if (!id.verificado) throw nega('Abra o app pelo Bitrix24 para ver o dashboard.');
  if (!svc.podeDashboard(id.uid)) throw nega('Você não tem acesso ao dashboard.');
}
const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /api/eu': async (_, __, id) => ({ ...id, admin: id.uid ? svc.isAdmin(id.uid) : false, nome: id.uid ? await svc.nomeUsuario(id.uid) : '', podeConfig: svc.acessoRestrito() ? !!(id.verificado && svc.podeConfigurar(id.uid)) : true, podeDashboard: svc.acessoRestrito() ? !!(id.verificado && svc.podeDashboard(id.uid)) : true }),
  'GET /api/dashboard': async (_, __, id) => { exige(); exigeDashboard(id); return svc.dashboardDados({ uid: id.uid, bearer: id.bearer }); },
  'GET /api/usuarios': async () => { exige(); return svc.usuarios(); },
  'GET /api/visitas': async (u, _, id) => {
    exige();
    const g = k => u.searchParams.get(k) || '';
    if (g('page')) return svc.listarVisitasPag({ uid: id.uid, bearer: id.bearer, escopo: g('escopo') || 'auto', page: +g('page'), size: +g('size') || 20, q: g('q'), status: g('status') || 'abertas', per: g('per'), de: g('de'), ate: g('ate'), seg: g('seg'), tipo: g('tipo'), classe: g('classe'), resp: g('resp'), vend: g('vend'), ramo: g('ramo'), ord: g('ord') || 'data', dir: +g('dir') || 1, cardId: g('cardId'), soIds: g('soIds') === '1' }); return svc.listarVisitas({ uid: id.uid, escopo: u.searchParams.get('escopo') || 'auto', bearer: id.bearer, encerradas: u.searchParams.get('encerradas') === '1' }); },
  'GET /api/departamentos': async (_, __, id) => { exigeConfig(id); exige(); return { departamentos: await svc.departamentos() }; },
  'GET /api/ramos': async (_, __, id) => { exigeConfig(id); exige(); return { ramos: await svc.listaRamos() }; },
  'GET /api/historico': async (_, __, id) => { let base = null; try { base = new URL(bitrix.base).origin; } catch { /* sem webhook */ } return { reprogramacoes: id.uid ? await svc.historicoVisivel(id.uid, id.bearer) : [], base }; },
  'GET /api/log': async (_, __, id) => (exigeConfig(id), { log: store.logs.slice(0, 200), bloqueios: store.bloqueios }),
  'GET /api/config': async (_, __, id) => (exigeConfig(id), { config: store.config, hoje: R.todayBR(), webhook: bitrix.enabled, ultimaVarredura: store.lastSweep }),
  'PUT /api/config': async (_, b, id) => {
    exigeConfig(id);
    const p = {};
    if (b.intervalos && typeof b.intervalos === 'object') {
      p.intervalos = {};
      for (const c of R.CARGOS) for (const k of R.CLASSES) { const n = +b.intervalos?.[c]?.[k]; if (Number.isInteger(n) && n > 0 && n < 1000) (p.intervalos[c] ||= {})[k] = n; }
    }
    if (Number.isInteger(+b.horaJob) && +b.horaJob >= 0 && +b.horaJob < 24) p.horaJob = +b.horaJob;
    for (const k of ['tarefaAtiva', 'atualizarProxima', 'hierarquiaAuto', 'respeitarBitrix']) if (typeof b[k] === 'boolean') p[k] = b[k];
    if (typeof b.ativo === 'boolean') p.ativo = b.ativo;
    if (Number.isFinite(+b.tarefaHorasUteis) && +b.tarefaHorasUteis > 0) p.tarefaHorasUteis = +b.tarefaHorasUteis;
    if (['secao', 'extra'].includes(b.motoresDatas)) p.motoresDatas = b.motoresDatas;
    if (b.alcadas && typeof b.alcadas === 'object') {
      p.alcadas = {};
      for (const [d, r] of Object.entries(b.alcadas)) {
        const o = {};
        for (const k of ['supervisor', 'coordenador', 'gerente', 'diretor']) if (+r?.[k] > 0) o[k] = +r[k];
        if (/^\d+$/.test(d) && Object.keys(o).length) p.alcadas[d] = o;
      }
    }
    if (b.tipoPorRamo && typeof b.tipoPorRamo === 'object') { p.tipoPorRamo = {}; for (const [k, t] of Object.entries(b.tipoPorRamo)) if (['Industrial', 'Marítimo', ''].includes(t) && /^[\w-]+$/.test(k)) p.tipoPorRamo[k] = t; }
    for (const k of ['acessoConfig', 'acessoDashboard']) if (Array.isArray(b[k])) p[k] = b[k].map(Number).filter(Boolean);
    if (p.acessoConfig && p.acessoConfig.length && id.uid && !p.acessoConfig.includes(+id.uid)) p.acessoConfig.push(+id.uid); // evita se trancar para fora
    if (Array.isArray(b.verTudo)) p.verTudo = b.verTudo.map(Number).filter(Boolean);
    if (Array.isArray(b.admins)) p.admins = b.admins.map(Number).filter(Boolean);
    if (b.mapaManual && typeof b.mapaManual === 'object') p.mapaManual = b.mapaManual;
    store.log('config', `Configuração alterada por ${id.uid || 'desconhecido'}`);
    const c = store.setConfig(p); await svc.campos(true).catch(() => {}); return c;
  },
  'GET /api/campos': async (u, _, id) => { exigeConfig(id); exige(); return svc.campos(u.searchParams.get('refresh') === '1'); },
  'GET /api/duplicados': async (_, __, id) => { exigeConfig(id); exige(); const a = await D.analisar(bitrix); return { ...a, plano: D.planejar(a) }; },
  'POST /api/preparar': async (_, __, id) => { exigeConfig(id); exige(); if ((store.config.admins || []).length && !svc.isAdmin(id.uid)) throw Object.assign(new Error('Apenas administradores.'), { status: 403 }); const r = await P.preparar(bitrix, svc); store.log('config', `Preparar Bitrix: ${[...r.feito, ...r.erros].join('; ') || 'nada a fazer'}`); return r; },
  // Assina os eventos de empresa/itens do Bitrix para a fila nascer na hora (a conferência a cada 30 s continua como reserva).
  'POST /api/eventos/ativar': async (_, __, id) => {
    exigeConfig(id);
    if (!process.env.SERVER_ID || !process.env.VIBE_APP_KEY) throw nega('Servidor sem SERVER_ID/VIBE_APP_KEY.', 500);
    if (!id.bearer) throw nega('Abra o app pelo Bitrix24 (não pelo link direto) para ativar os eventos.', 400);
    const caminho = '/events' + (EVENT_TOKEN ? `?token=${EVENT_TOKEN}` : '');
    const out = [];
    for (const ev of ['ONCRMCOMPANYADD', 'ONCRMCOMPANYUPDATE', 'ONCRMDYNAMICITEMADD', 'ONCRMDYNAMICITEMUPDATE']) {
      const r = await request(`https://vibecode.bitrix24.com/v1/infra/servers/${process.env.SERVER_ID}/event-subscriptions`, { method: 'POST', headers: { 'X-Api-Key': process.env.VIBE_APP_KEY, Authorization: id.bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ event: ev, appPath: caminho }) });
      out.push({ evento: ev, ok: r.ok, erro: r.ok ? undefined : (r.json?.error?.message || `HTTP ${r.status}`) });
    }
    store.log('config', `Eventos do Bitrix: ${out.map(o => `${o.evento}=${o.ok ? 'ok' : o.erro}`).join('; ')}`);
    return { eventos: out };
  },
  'POST /api/sincronizar': async (_, b, id) => { exigeConfig(id); exige(); return b.empresa ? svc.sincronizarEmpresa(+b.empresa, { forcar: !!b.forcar }) : svc.sincronizarTodas(); },
  'POST /api/job': async (_, b, id) => { exigeConfig(id); exige(); return svc.jobDiario({ forcar: !!b.forcar }); },
  'POST /api/varrer': async (_, __, id) => { exigeConfig(id); exige(); return svc.varrer(); },
  'POST /api/visitas/corrigir': async (_, b, id) => { exige(); return svc.corrigirVisita(+b.id, { uid: id.uid, dataHora: b.dataHora, motivo: b.motivo }); },
};
// Eventos do Bitrix24 (ONCRMCOMPANYADD/UPDATE, ONCRMDYNAMICITEMUPDATE...): disparam uma varredura imediata.
let agendada = null;
const acorda = () => { if (agendada) return; agendada = setTimeout(() => { agendada = null; svc.varrer().catch(e => store.log('erro', `varredura: ${e.message}`)); }, 1500); };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/events' && req.method === 'POST') {
      if (EVENT_TOKEN && u.searchParams.get('token') !== EVENT_TOKEN) return send(res, 403, { error: 'token inválido' });
      await readBody(req).catch(() => ({})); acorda(); return send(res, 200, { ok: true });
    }
    const key = `${req.method} ${u.pathname}`;
    if (routes[key]) {
      const id = await quem(req, u);
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, await routes[key](u, body, id));
    }
    const mf = u.pathname.match(/^\/api\/cards\/(\d+)\/form$/);
    if (mf && req.method === 'GET') { exige(); { const idf = await quem(req, u); if (!(await svc.podeVerCard(idf.bearer, +mf[1]))) throw nega('Você não tem permissão no Bitrix24 para ver este registro.'); } return send(res, 200, await svc.camposVisita(+mf[1])); }
    let m = u.pathname.match(/^\/api\/cards\/(\d+)\/(registrar|reprogramar)$/);
    if (m && req.method === 'POST') {
      exige();
      const id = await quem(req, u), b = await readBody(req, m[2] === 'registrar' ? 36e6 : 1e6);
      if (!(await svc.podeVerCard(id.bearer, +m[1]))) throw nega('Você não tem permissão no Bitrix24 para este registro.');
      const uid = id.verificado ? id.uid : +(b.uid || id.uid) || null;
      return send(res, 200, m[2] === 'registrar' ? await svc.registrarVisita(+m[1], { ...b, uid }) : await svc.reprogramar(+m[1], { ...b, uid }));
    }
    if (req.method === 'GET') {
      const root = path.join(__dirname, 'public');
      const f = path.join(root, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); return fs.createReadStream(f).pipe(res); }
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    store.log('erro', `${req.method} ${u.pathname}: ${e.message}`);
    send(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Registro de Visitas DLC em :${PORT} · Bitrix ${bitrix.enabled ? 'configurado' : 'SEM WEBHOOK (defina BITRIX_WEBHOOK)'}`);
  const tick = () => bitrix.enabled && svc.varrer().then(r => r && !r.pulado && !r.pausado && console.log('varredura', JSON.stringify(r))).catch(e => { store.log('erro', `varredura: ${e.message}`); console.error('varredura:', e.message); });
  if (process.env.ATIVAR === '1' && !store.config.ativo) { store.setConfig({ ativo: true }); store.log('config', 'App ativado'); console.log('app ativado'); }
  if (bitrix.enabled && process.env.SYNC_EMPRESA) setTimeout(() => svc.sincronizarEmpresa(+process.env.SYNC_EMPRESA, { forcar: true }).then(r => console.log('sync-empresa', JSON.stringify(r))).catch(e => console.error('sync-empresa:', e.message)), 6000);
  if (bitrix.enabled && process.env.DIAG_DEPTS) setTimeout(async () => {
    try {
      const deps = (await bitrix.call('department.get', {})).result || [];
      const us = (await bitrix.call('user.get', { filter: { ACTIVE: true } })).result || [];
      const nome = Object.fromEntries(us.map(u => [u.ID, `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim()]));
      console.log('depts', JSON.stringify(deps.map(d => `${d.ID}|${d.NAME}|pai=${d.PARENT || '-'}|chefe=${d.UF_HEAD && d.UF_HEAD !== '0' ? d.UF_HEAD + ':' + (nome[d.UF_HEAD] || '?') : '-'}`)));
      const emp = (await bitrix.call('crm.company.get', { id: +process.env.DIAG_DEPTS })).result || {};
      const ids = Object.entries(emp).filter(([k, x]) => k.startsWith('UF_CRM') && /^\d+$/.test(String(Array.isArray(x) ? x[0] : x)) && nome[String(Array.isArray(x) ? x[0] : x)]).map(([k, x]) => `${k}=${Array.isArray(x) ? x[0] : x}:${nome[String(Array.isArray(x) ? x[0] : x)]}`);
      console.log('depts-empresa', JSON.stringify(ids));
      const vend = us.filter(u => ids.some(i => i.includes(`=${u.ID}:`)));
      console.log('depts-usuarios', JSON.stringify(vend.map(u => `${u.ID}:${u.NAME} ${u.LAST_NAME}|dept=${JSON.stringify(u.UF_DEPARTMENT)}|cargo=${u.WORK_POSITION || '-'}`)));
    } catch (e) { console.error('depts:', e.message); }
  }, 2000);
  if (bitrix.enabled && process.env.DIAG_TIPO) setTimeout(async () => {
    try {
      const f = (await bitrix.call('crm.company.fields')).result || {};
      const ach = Object.entries(f).filter(([k, x]) => { const lbl = JSON.stringify([x.formLabel, x.listLabel, x.title]).toLowerCase(); const its = JSON.stringify(x.items || []).toLowerCase(); return /industri|marit|mar[ií]tim|tipo|ramo|setor|segmento/.test(lbl) || /industri|marit/.test(its); })
        .map(([k, x]) => `${k}|${x.type}|${x.formLabel || x.title}|itens=${(x.items || []).slice(0, 12).map(i => i.VALUE || i.NAME || i.value).join('/')}`);
      console.log('tipo-campos', JSON.stringify(ach));
      for (const e of ['COMPANY_TYPE', 'INDUSTRY']) { const st = (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: e } })).result || []; console.log('tipo-status-' + e, JSON.stringify(st.map(x => x.NAME))); }
    } catch (e) { console.error('tipo:', e.message); }
  }, 2000);
  if (bitrix.enabled && process.env.SPA_DUPLICADOS) setTimeout(async () => {
    try {
      const { map } = await svc.campos(true);
      const prot = Object.values(map.visita);
      const modo = process.env.SPA_DUPLICADOS;
      if (modo === 'apagar') console.log('spa-apagar', JSON.stringify(await D.apagarSpa(bitrix, 1032, DATA_DIR, prot)));
      else { const a = await D.analisarSpa(bitrix, 1032, prot); console.log('spa-analise', JSON.stringify({ itens: a.itens, grupos: a.grupos.map(g => `${g.titulo}: padrão ${g.padrao}(${g.usoPadrao}) outros ${g.usoOutros.map(([k, n]) => k + '(' + n + ')').join(',')}`) })); }
    } catch (e) { console.error('spa-duplicados:', e.message); }
  }, 3000);
  if (bitrix.enabled && process.env.DIAG_OPORT) setTimeout(async () => {
    try {
      const f = (await bitrix.call('crm.company.fields')).result || {};
      const ach = Object.entries(f).filter(([k, x]) => /oportun|mapeament|potencial|futur|atende|segmentos?\b/i.test(JSON.stringify([x.formLabel, x.listLabel, x.title]))).map(([k, x]) => `${k}|${x.type}|${x.formLabel || x.title}|mult=${x.isMultiple}|itens=${(x.items || []).map(i => i.VALUE).join('/')}`);
      console.log('oport-empresa', JSON.stringify(ach));
      const g = (await bitrix.call('crm.item.fields', { entityTypeId: 1032 })).result?.fields || {};
      console.log('oport-visita', JSON.stringify(Object.entries(g).filter(([k, x]) => /mapeament/i.test(x.title || '')).map(([k, x]) => `${k}|${x.type}|mult=${x.isMultiple}|itens=${(x.items || []).map(i => i.ID + ':' + i.VALUE).join('/')}`)));
    } catch (e) { console.error('oport:', e.message); }
  }, 2000);
  if (bitrix.enabled && process.env.SYNC_RECENTES) setTimeout(() => svc.sincronizarTodas({ desde: new Date(Date.now() - (+process.env.SYNC_RECENTES) * 3600e3).toISOString() }).then(r => console.log('sync-recentes', JSON.stringify(r.map(e => ({ empresa: e.empresa, criados: (e.criados || []).length, atualizados: (e.atualizados || []).length, pendencias: e.pendencias, erro: e.erro }))))).catch(e => console.error('sync-recentes:', e.message)), 7000);
  if (bitrix.enabled && process.env.DIAG_EMPRESA) setTimeout(async () => {
    try {
      const { map } = await svc.campos(true);
      const nome = process.env.DIAG_EMPRESA;
      const emp = (await bitrix.call('crm.company.list', { filter: /^\d+$/.test(nome) ? { ID: nome } : { '%TITLE': nome }, select: ['ID', 'TITLE'] })).result || [];
      console.log('diag-empresas', JSON.stringify(emp));
      console.log('diag-etapas', JSON.stringify(((await bitrix.call('crm.status.list', { filter: { ENTITY_ID: `DYNAMIC_1036_STAGE_${map.categoriaFila}` } })).result || []).map(s => `${s.STATUS_ID}=${s.NAME}/${s.SEMANTICS || '-'}`)));
      for (const e of emp.slice(0, 3)) {
        const c = (await bitrix.call('crm.item.list', { entityTypeId: 1036, filter: { companyId: +e.ID }, select: ['*', 'uf*'] })).result?.items || [];
        console.log('diag-cards', e.ID, JSON.stringify(c.map(i => ({ id: i.id, t: i.title, st: i.stageId, d: i.closedate || i[map.fila.data], cr: i.createdTime, up: i.updatedTime }))));
        const v2 = (await bitrix.call('crm.item.list', { entityTypeId: 1032, filter: { companyId: +e.ID }, select: ['*', 'uf*'] })).result?.items || [];
        console.log('diag-visitas', e.ID, JSON.stringify(v2.map(i => ({ id: i.id, fila: i[map.visita.filaId], seg: i[map.visita.segmento], cr: i.createdTime, by: i.createdBy, resp: i.assignedById }))), 'campoFila=', map.visita.filaId);
      }
    } catch (e) { console.error('diag-empresa:', e.message); }
  }, 2000);
  if (bitrix.enabled && process.env.PREPARAR) setTimeout(() => P.preparar(bitrix, svc).then(r => { console.log('preparar', JSON.stringify(r)); store.log('config', `Preparar Bitrix: ${[...r.feito, ...r.erros].join('; ') || 'nada a fazer'}`); }).catch(e => console.error('preparar:', e.message)), 2000);
  if (bitrix.enabled && process.env.APAGAR_CAMPOS) setTimeout(() => D.apagar(bitrix, process.env.APAGAR_CAMPOS.split(',').map(Number).filter(Boolean), DATA_DIR).then(r => { console.log('campos-apagados', JSON.stringify(r)); store.log('config', `Campos duplicados apagados: ${(r.feitos || []).join('; ')}`); }).catch(e => console.error('campos-apagados:', e.message)), 3000);
  if (bitrix.enabled && process.env.ANALISE_DUPLICADOS) setTimeout(() => D.analisar(bitrix).then(a => { const p = D.planejar(a); console.log('duplicados', JSON.stringify({ empresas: a.empresas, apagar: p.apagar.map(c => `${c.id}:${c.campo}:${c.rotulo}`), manter: p.manter.map(c => `${c.id}:${c.campo}:${c.rotulo}:${c.comValor}`), conflitos: p.conflitos.map(g => g.campos.map(c => `${c.campo}=${c.comValor}`)) })); }).catch(e => console.error('duplicados:', e.message)), 3000);
  if (bitrix.enabled) setTimeout(() => svc.campos(true).then(d => console.log('campos', JSON.stringify({ faltando: d.faltando, ambiguos: d.ambiguos, fila: d.map.fila, visita: d.map.visita, etapas: d.map.etapas, cat: d.map.categoriaFila, tipo: d.map.tipoEmpresa, motores: d.map.empresa.Motores }))).catch(e => console.error('campos:', e.message)), 1000);
  setTimeout(tick, 5000);
  setInterval(tick, Math.max(30, store.config.sweepSegundos) * 1000);
});
