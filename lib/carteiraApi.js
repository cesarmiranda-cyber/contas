'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./carteira');
const B = require('./bk');
const R = require('./rules');
const { norm } = require('./feriados');

// API da Carteira de clientes (/api/car/*): lê empresas e funis do Bitrix24 e guarda o que a equipe marca à mão.
function createCarteiraApi({ bitrix, bx, funil, store, dir, areasDe = () => ['contratos'] }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'carteira.json');
  let d = { clientes: [], campanhas: [], avisos: {}, sincEm: '' };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* primeiro uso */ }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, file); };
  const hoje = () => R.todayBR();
  const need = (c, m, s = 400) => { if (!c) throw Object.assign(new Error(m), { status: s }); };
  const achar = id => d.clientes.find(c => c.empresaId === String(id)) || (() => { throw Object.assign(new Error('Cliente não encontrado.'), { status: 404 }); })();

  // ---------- sincronização com o Bitrix24 ----------
  async function sincronizar() {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const h = hoje(), emp = await bx.listar(true), cn = await funil.camposNegocio();
    const f = nome => cn[nome] || { cod: '', itens: {} }, fTipo = f('tipo de contrato'), fIni = f('data de inicio da vigencia'), fFim = f('data de termino da vigencia'), fVal = f('valor mensal (r$)');
    const extra = [fTipo.cod, fIni.cod, fFim.cod, fVal.cod].filter(Boolean);
    const [ctr, docs, regs, cursos] = await Promise.all([funil.negocios(15, extra), funil.negocios(4), funil.negocios(14), funil.negocios(2)]);
    const [eCtr, eDoc, eReg, eCur] = await Promise.all([15, 4, 14, 2].map(c => funil.estagios(c)));
    const nome = (est, id) => (est.find(e => e.id === id) || {}).nome || '';
    const ehN = (n, t) => norm(n).includes(norm(t));
    const por = (lista, id) => lista.filter(x => String(x.COMPANY_ID) === String(id));
    let novos = 0;
    for (const e of emp) {
      if (/nutri\s*mix/i.test(e.nome) && /assessoria e consultoria/i.test(e.nome)) continue;   // a própria empresa
      let c = d.clientes.find(x => x.empresaId === e.id);
      if (!c) { c = { empresaId: e.id, tipo: '', esporadicos: [], contrato: { inicio: '', fim: '', valor: null, dealId: '' }, manual: {}, ativoManual: null, optOut: false, obs: '', auto: {} }; d.clientes.push(c); novos++; }
      Object.assign(c, { nome: e.nome, razao: e.razao, email: e.email, cidade: e.cidade, uf: e.uf, responsavel: e.responsavel, situacao: e.situacao, categoria: e.categoria, cnpj: e.cnpj });
      const ctrs = por(ctr, e.id).filter(x => !ehN(nome(eCtr, x.STAGE_ID), 'cancelad') && !ehN(nome(eCtr, x.STAGE_ID), 'encerrad') && !ehN(nome(eCtr, x.STAGE_ID), 'recusad')).sort((a, b) => Number(b.ID) - Number(a.ID));
      const k = ctrs[0], tipoNome = k && fTipo.itens[String(k[fTipo.cod])];
      const r = C.deriva({ empresa: e, hoje: h, tipoNome,
        contrato: k ? { id: k.ID, inicio: String(k[fIni.cod] || '').slice(0, 10), fim: String(k[fFim.cod] || '').slice(0, 10), valor: k[fVal.cod] ? Number(k[fVal.cod]) : null } : null,
        docs: por(docs, e.id).map(x => ({ entregue: ehN(nome(eDoc, x.STAGE_ID), 'entregue'), cancelado: ehN(nome(eDoc, x.STAGE_ID), 'cancelad') })),
        regs: por(regs, e.id).map(x => ({ emitida: ehN(nome(eReg, x.STAGE_ID), 'licenca emitida') })),
        cursos: por(cursos, e.id).map(x => ({ ganho: ehN(nome(eCur, x.STAGE_ID), 'ganho') })) });
      c.ativoAuto = r.ativoAuto; c.auto = r.auto; if (e.validadeAlvara) c.alvaraValidade = c.alvaraValidade || e.validadeAlvara;
      if (r.tipoBitrix && !c.tipo) c.tipo = r.tipoBitrix;
      if (r.contratoBitrix && !c.contratoManual) c.contrato = { ...c.contrato, ...r.contratoBitrix };
    }
    d.sincEm = new Date().toISOString(); save(); store.log('carteira', `Carteira sincronizada: ${emp.length} empresa(s), ${novos} nova(s)`);
    return { empresas: emp.length, novos, comEmail: d.clientes.filter(c => c.email).length };
  }

  // ---------- consultas ----------
  // Valores, datas e proposta do contrato só para quem tem a área "contratos"; os demais veem apenas o estado (em dia, vencendo).
  const vendoContratos = u => !u || areasDe(u).includes('contratos');
  const mascara = (c, u) => vendoContratos(u) ? c : { ...c, contrato: { inicio: '', fim: '', valor: null, dealId: '' }, contratoRestrito: true };
  const vis = (o, u) => vendoContratos(u) ? o : { ...o, contrato: { inicio: '', fim: '', valor: null, dealId: '' }, contratoRestrito: true, contratoSituacao: { estado: o.contratoSituacao.estado, dias: o.contratoSituacao.dias } };
  const out = c => { const s = C.contratoSituacao(c, hoje()); return { ...c, ativo: C.ativo(c), tipoNome: c.tipo ? C.TIPOS[c.tipo] : '', contratoSituacao: s,
    itens: Object.fromEntries(Object.keys(C.ITENS).map(k => [k, { valor: C.item(c, k), origem: C.origemItem(c, k) }])) }; };
  const ordem = (a, b) => (b.ativo === true) - (a.ativo === true) || (a.nome || '').localeCompare(b.nome || '');
  const routes = [], on = (m, re, h) => routes.push([m, new RegExp(`^/api/car${re}$`), h]);
  on('GET', '/bootstrap', async () => {
    const l = d.clientes.map(out);
    return { hoje: hoje(), host: bx.host(), bitrixOn: bitrix.enabled, sincEm: d.sincEm, tipos: C.TIPOS, esporadicos: C.ESPORADICOS, total: l.length, ativos: l.filter(c => c.ativo === true).length, inativos: l.filter(c => c.ativo === false).length, prospectos: l.filter(c => c.ativo === null).length,
      semTipo: l.filter(c => c.ativo === true && !c.tipo).length, vencendo: l.filter(c => c.ativo === true && ['vencendo', 'vencido'].includes(c.contratoSituacao.estado)).length };
  });
  on('GET', '/clientes', async (_, u, __, user) => {
    const q = u.searchParams, aba = q.get('aba') || 'ativos', t = (q.get('q') || '').toLowerCase(), tipo = q.get('tipo') || '', venc = q.get('venc') === '1', pp = 40, pg = Math.max(1, Number(q.get('page')) || 1);
    let l = d.clientes.map(out).filter(c => (aba === 'todos' || (aba === 'ativos' ? c.ativo === true : aba === 'inativos' ? c.ativo === false : c.ativo === null)) && (!t || `${c.nome} ${c.razao || ''} ${c.cnpj || ''}`.toLowerCase().includes(t)) && (!tipo || (tipo === 'sem' ? !c.tipo : c.tipo === tipo)) && (!venc || ['vencendo', 'vencido'].includes(c.contratoSituacao.estado)));
    l.sort(ordem); const paginas = Math.max(1, Math.ceil(l.length / pp)), p = Math.min(pg, paginas);
    return { total: l.length, pagina: p, paginas, itens: l.slice((p - 1) * pp, p * pp).map(c => vis(c, user)) };
  });
  on('GET', '/clientes/([\\d]+)', async ([id], _, __, user) => vis(out(achar(id)), user));
  on('PUT', '/clientes/([\\d]+)', async ([id], _, b, user) => { const c = achar(id), v = C.validaEdicao(b); need(!v.contrato || vendoContratos(user), 'Você não tem acesso aos contratos.', 403); if (v.contrato) c.contratoManual = true; Object.assign(c, v); save(); return vis(out(c), user); });
  // Define o tipo de serviço (e/ou a situação) de vários clientes de uma vez.
  on('POST', '/clientes/lote', async (_, __, b) => {
    const ids = [].concat(b.ids || []).map(String).slice(0, 500); need(ids.length, 'Selecione ao menos um cliente.');
    const v = C.validaEdicao({ ...(b.tipo !== undefined ? { tipo: b.tipo } : {}), ...(b.ativoManual !== undefined ? { ativoManual: b.ativoManual } : {}) }); need(Object.keys(v).length, 'Nada a aplicar.');
    let n = 0; for (const id of ids) { const c = d.clientes.find(x => x.empresaId === id); if (c) { Object.assign(c, v); n++; } } save(); return { atualizados: n };
  });
  on('POST', '/sincronizar', async () => sincronizar());
  // Resumo de serviços dos clientes ativos com contrato de consultoria: o que já foi e o que não foi executado.
  on('GET', '/resumo', async (_, u, __, user) => {
    const t = (u.searchParams.get('q') || '').toLowerCase(), so = u.searchParams.get('pendencia') === '1';
    let l = d.clientes.map(out).filter(c => c.ativo === true && C.CONSULTORIA.includes(c.tipo)).filter(c => !t || (c.nome || '').toLowerCase().includes(t));
    const comp = c => Object.keys(C.ITENS).every(k => c.itens[k].valor === 'sim'); const completos = l.filter(comp).length;
    if (so) l = l.filter(c => !comp(c)); l.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    const cont = Object.fromEntries(Object.keys(C.ITENS).map(k => [k, l.filter(c => c.itens[k].valor === 'sim').length]));
    return { total: l.length, completos, porItem: cont, itens: l.map(c => ({ empresaId: c.empresaId, nome: c.nome, tipoNome: c.tipoNome, contratoSituacao: vis(c, user).contratoSituacao, itens: c.itens })) };
  });
  on('GET', '/vencimentos', async (_, u, __, user) => {
    need(vendoContratos(user), 'Você não tem acesso aos contratos.', 403);
    const lim = Math.min(365, Math.max(1, Number(u.searchParams.get('dias')) || 60));
    return d.clientes.map(out).filter(c => c.ativo === true && c.contratoSituacao.dias !== null && c.contratoSituacao.dias <= lim).sort((a, b) => a.contratoSituacao.dias - b.contratoSituacao.dias)
      .map(c => ({ empresaId: c.empresaId, nome: c.nome, tipoNome: c.tipoNome, fim: c.contrato.fim, dias: c.contratoSituacao.dias, estado: c.contratoSituacao.estado, valor: c.contrato.valor }));
  });
  // Aviso no Bitrix24 ao responsável da empresa: faltando 30, 15, 7 dias, no dia e depois de vencer (uma vez cada).
  async function avisar({ simular = false } = {}) {
    const marcos = [30, 15, 7, 0], enviados = [], erros = [], h = hoje();
    for (const c of d.clientes.map(out).filter(x => x.ativo === true && x.contratoSituacao.dias !== null)) {
      const key = `${c.empresaId}|${c.contrato.fim}`, m = B.avisoDevido(c.contratoSituacao.dias, marcos, d.avisos[key] || []); if (m === null) continue;
      const dd = c.contratoSituacao.dias, msg = dd < 0 ? `Contrato de ${c.nome} venceu há ${-dd} dia(s) (${c.contrato.fim}).` : dd === 0 ? `O contrato de ${c.nome} vence HOJE.` : `O contrato de ${c.nome} vence em ${dd} dia(s) (${c.contrato.fim}).`;
      if (simular) { enviados.push({ nome: c.nome, marco: m, msg }); continue; }
      if (!bitrix.enabled || !c.responsavel) { erros.push(`${c.nome}: sem responsável ou Bitrix24 desconectado`); continue; }
      try { await bitrix.call('im.notify.personal.add', { USER_ID: c.responsavel, MESSAGE: `${msg} [URL=https://${bx.host()}/crm/company/details/${c.empresaId}/]Abrir cliente[/URL]`, TAG: `contrato-${c.empresaId}-${m}` }); (d.avisos[key] ||= []).push(m); save(); enviados.push({ nome: c.nome, marco: m, msg }); } catch (e) { erros.push(`${c.nome}: ${e.message}`); }
    }
    if (enviados.length && !simular) store.log('carteira', `${enviados.length} aviso(s) de vencimento de contrato`);
    return { enviados, erros };
  }
  on('POST', '/avisar', async (_, __, b) => avisar({ simular: !!b.simular }));

  // ---------- e-mail marketing ----------
  const audiencia = pub => d.clientes.map(out).filter(c => c.email && !c.optOut && (pub === 'ativos' ? c.ativo === true : c.ativo === false));
  on('GET', '/email/publicos', async () => ['ativos', 'inativos'].map(p => ({ publico: p, nome: p === 'ativos' ? 'Clientes ativos' : 'Clientes inativos', destinatarios: audiencia(p).length, semEmail: d.clientes.map(out).filter(c => !c.email && (p === 'ativos' ? c.ativo === true : c.ativo === false)).length, descadastrados: d.clientes.filter(c => c.optOut && (p === 'ativos' ? C.ativo(c) === true : C.ativo(c) === false)).length })));
  on('GET', '/email/exportar', async (_, u) => { const p = u.searchParams.get('publico'); need(['ativos', 'inativos'].includes(p), 'Público inválido.'); const q = v => '"' + String(v || '').replace(/"/g, '""') + '"'; return { __csv: ['Nome;E-mail;Cidade;Tipo de serviço', ...audiencia(p).map(c => [c.nome, c.email, c.cidade, c.tipoNome].map(q).join(';'))].join('\r\n'), nome: `emails-${p}.csv` }; });
  on('GET', '/email/campanhas', async () => d.campanhas.slice().reverse());
  const validaCamp = b => { const nome = String(b.nome || '').trim().slice(0, 100), assunto = String(b.assunto || '').trim().slice(0, 150), corpo = String(b.corpo || '').slice(0, 20000); need(nome.length >= 2, 'Dê um nome à campanha.'); need(assunto.length >= 2, 'Informe o assunto.'); need(corpo.trim().length >= 5, 'Escreva a mensagem.'); need(['ativos', 'inativos'].includes(b.publico), 'Escolha o público.'); return { nome, assunto, corpo, publico: b.publico }; };
  on('POST', '/email/campanhas', async (_, __, b, user) => { const v = validaCamp(b), x = { id: B.uid('cp'), ...v, status: 'rascunho', criadaEm: hoje(), por: (user && user.nome) || '', total: audiencia(v.publico).length }; d.campanhas.push(x); save(); return x; });
  on('PUT', '/email/campanhas/([\\w-]+)', async ([id], _, b) => { const x = d.campanhas.find(c => c.id === id); need(x, 'Campanha não encontrada.', 404); need(x.status !== 'enviada', 'Campanha já enviada.'); Object.assign(x, validaCamp({ ...x, ...b }), { total: audiencia(b.publico || x.publico).length }); save(); return x; });
  on('POST', '/email/campanhas/([\\w-]+)/enviada', async ([id], _, b, user) => { const x = d.campanhas.find(c => c.id === id); need(x, 'Campanha não encontrada.', 404); x.status = 'enviada'; x.enviadaEm = hoje(); x.total = audiencia(x.publico).length; x.enviadaPor = (user && user.nome) || ''; save(); return x; });
  on('DELETE', '/email/campanhas/([\\w-]+)', async ([id]) => { d.campanhas = d.campanhas.filter(c => c.id !== id); save(); return { ok: true }; });

  return { sincronizar, avisar, dados: () => d,
    async handle(method, pathname, u, readBody, user) {
      for (const [m, re, h] of routes) { const g = m === method && pathname.match(re); if (g) return { json: await h(g.slice(1), u, ['POST', 'PUT'].includes(method) ? await readBody() : {}, user) }; }
      return null;
    } };
}
module.exports = { createCarteiraApi };
