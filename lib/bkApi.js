'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./bk');
const C = require('./finCad');
const R = require('./rules');

// API do processo BK (/api/bk/*). Dados próprios em bk.json (escrita atômica); títulos da medição vão para o A Receber.
function createBkApi({ fin, empresas, bitrix, bx, funil, cnpjApi, store, dir, seedFile }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bk.json');
  let d = { unidades: [], historico: [], medicoes: [], avisos: {}, config: { valorPadrao: 0, responsavelPadrao: '', empresaId: '', cliente: 'BK Brasil', diaVenc: 10, categoria: 'Serviços BK', marcos: [60, 30, 15, 7, 0] } };
  try { const x = JSON.parse(fs.readFileSync(file, 'utf8')); d = { ...d, ...x, config: { ...d.config, ...x.config } }; } catch { /* primeiro uso */ }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, file); };
  const hoje = () => R.todayBR();
  // Carga inicial (uma única vez): arquivo de unidades preparado fora do repositório, usado só se ainda não há unidades.
  if (seedFile && !d.semeado && !d.unidades.length && fs.existsSync(seedFile)) {
    try {
      const itens = JSON.parse(fs.readFileSync(seedFile, 'utf8')), vistos = new Set();
      for (const x of itens) { try { const v = B.validaUnidade({ ...x, etapa: B.etapaDeTexto(x.etapaTxt) }); if (!vistos.has(v.bkn)) { vistos.add(v.bkn); d.unidades.push({ id: B.uid('bk'), ...v }); } } catch { /* linha inválida: ignora */ } }
      d.semeado = true; save(); store.log('bk', `Carga inicial: ${d.unidades.length} unidade(s)`);
    } catch (e) { store.log('erro', `BK: carga inicial falhou: ${e.message}`); }
  }
  const need = (c, m) => { if (!c) throw Object.assign(new Error(m), { status: 400 }); };
  const nf = what => Object.assign(new Error(`${what} não encontrada.`), { status: 404 });
  const achar = id => d.unidades.find(u => u.id === id) || (() => { throw nf('Unidade'); })();
  const dupBkn = (bkn, exceto) => d.unidades.some(u => u.bkn === bkn && u.id !== exceto);

  const filtra = (q, h) => {
    const t = String(q.get('q') || '').toLowerCase().trim(), uf = String(q.get('uf') || '').toUpperCase(), et = q.get('etapa') || '', sit = q.get('situacao') || '';
    return d.unidades.map(u => B.comSituacao(u, h)).filter(u =>
      (!t || `${u.bkn} ${u.nome} ${u.cidade} ${u.rt.nome} ${u.cnpj}`.toLowerCase().includes(t)) && (!uf || u.uf === uf) && (!et || u.etapa === et) &&
      (!sit || (sit === 'pendente' ? u.pendencias.length > 0 : sit === 'conforme' ? u.ativa && !u.pendencias.length : sit === 'vencendo' ? u.alertas.some(a => a.nivel === 'critico' || (a.nivel === 'vencido' && a.tipo !== 'virada')) : sit === 'semrt' ? u.ativa && u.necessitaRt === 'sim' && !u.rt.nome : true)));
  };

  async function avisar({ simular = false } = {}) {
    const h = hoje(), enviados = [], erros = [];
    for (const u of d.unidades) {
      for (const a of B.alertasUnidade(u, h)) {
        if (a.tipo === 'prazo' && a.dias > 3) continue;
        const key = `${u.id}|${a.tipo}|${a.data}`, marco = B.avisoDevido(a.dias, d.config.marcos, d.avisos[key] || []);
        if (marco === null) continue;
        const msg = a.dias < 0 ? `BK ${u.bkn} — ${u.nome}: ${a.rotulo} vencida há ${-a.dias} dia(s) (${a.data}).` : a.dias === 0 ? `BK ${u.bkn} — ${u.nome}: ${a.rotulo} vence HOJE.` : `BK ${u.bkn} — ${u.nome}: ${a.rotulo} em ${a.dias} dia(s) (${a.data}).`;
        const resp = u.responsavel || d.config.responsavelPadrao;
        if (simular) { enviados.push({ unidade: u.bkn, tipo: a.tipo, marco, msg, responsavel: resp }); continue; }
        if (!bitrix.enabled || !resp) { erros.push(`${u.bkn}: sem responsável ou Bitrix não conectado`); continue; }
        try { await bitrix.call('im.notify.personal.add', { USER_ID: resp, MESSAGE: msg, TAG: `bk-${u.id}-${a.tipo}-${marco}` }); (d.avisos[key] ||= []).push(marco); save(); enviados.push({ unidade: u.bkn, tipo: a.tipo, marco, msg, responsavel: resp }); store.log('bk', `Aviso enviado: ${msg}`); }
        catch (e) { erros.push(`${u.bkn}: ${e.message}`); }
      }
    }
    return { enviados, erros };
  }

  const routes = [];
  const on = (m, re, h) => routes.push([m, new RegExp(`^/api/bk${re}$`), h]);
  const resp = () => ({ hoje: hoje(), demo: d.unidades.some(u => u.demo), config: d.config, etapas: B.ETAPAS, crn: B.CRN, resumo: B.resumo(d.unidades, hoje()), empresas: fin.empresas.all().map(e => ({ id: e.id, nome: e.nome })), bitrixHost: bx ? bx.host() : '', bitrixOn: !!(bx && bitrix.enabled), semEmpresa: d.unidades.filter(u => u.ativa && !u.empresaBitrixId).length, comNegocio: d.unidades.filter(u => u.dealId).length });

  on('GET', '/bootstrap', async () => resp());
  on('GET', '/unidades', async (_, u) => {
    const q = u.searchParams, lista = filtra(q, hoje()), pp = Math.min(100, Math.max(5, Number(q.get('pp')) || 25)), paginas = Math.max(1, Math.ceil(lista.length / pp)), p = Math.min(paginas, Math.max(1, Number(q.get('page')) || 1));
    return { itens: lista.slice((p - 1) * pp, p * pp), total: lista.length, pagina: p, paginas };
  });
  on('GET', '/unidades/([\\w-]+)', async ([id]) => ({ ...B.comSituacao(achar(id), hoje()), historico: d.historico.filter(e => e.unidadeId === id).reverse() }));
  on('POST', '/unidades', async (_, __, b) => {
    const v = B.validaUnidade(b); need(!dupBkn(v.bkn), `Já existe a unidade BKN ${v.bkn}.`);
    if (bx && bitrix.enabled) { need(v.empresaBitrixId, 'Escolha a empresa no cadastro do Bitrix24 (ou crie-a por lá) para não duplicar clientes.'); need(await bx.porId(v.empresaBitrixId), 'Empresa não encontrada no Bitrix24.'); }
    const x = { id: B.uid('bk'), ...v }; d.unidades.push(x); save(); store.log('bk', `Unidade ${x.bkn} cadastrada`); return x;
  });
  on('PUT', '/unidades/([\\w-]+)', async ([id], _, b) => {
    const u = achar(id), v = B.validaUnidade({ ...u, ...b, rt: { ...u.rt, ...(b.rt || {}) } }); need(!dupBkn(v.bkn, id), `Já existe a unidade BKN ${v.bkn}.`);
    if (bx && bitrix.enabled && v.empresaBitrixId && v.empresaBitrixId !== u.empresaBitrixId) need(await bx.porId(v.empresaBitrixId), 'Empresa não encontrada no Bitrix24.');
    const x = { id, ...v, demo: u.demo }; if (x.etapa !== u.etapa) d.historico.push(B.mover(u, x.etapa, 'Alterada na edição', '', hoje()).evento);
    d.unidades[d.unidades.findIndex(y => y.id === id)] = x; save(); return x;
  });
  on('DELETE', '/unidades/([\\w-]+)', async ([id]) => { achar(id); d.unidades = d.unidades.filter(u => u.id !== id); d.historico = d.historico.filter(e => e.unidadeId !== id); save(); return { ok: true }; });
  on('POST', '/unidades/([\\w-]+)/mover', async ([id], _, b) => {
    const { unidade, evento } = B.mover(achar(id), b.etapa, b.nota, b.por, hoje());
    d.unidades[d.unidades.findIndex(y => y.id === id)] = unidade; d.historico.push(evento);
    if (funil && bitrix.enabled && unidade.dealId) funil.achaEtapa(CAT, PARA_ETAPA[unidade.etapa]).then(e => e && funil.mover(unidade.dealId, e.id).then(() => { const x = d.unidades.find(y => y.id === id); if (x) { x.stageSync = e.id; save(); } })).catch(err => store.log('erro', `BK: não consegui mover o negócio ${unidade.dealId}: ${err.message}`)); if (d.historico.length > 20000) d.historico.splice(0, d.historico.length - 20000); save();
    store.log('bk', `Unidade ${unidade.bkn}: ${B.ETAPA_NOME[evento.de]} → ${B.ETAPA_NOME[evento.para]}`); return unidade;
  });
  on('POST', '/importar', async (_, __, b) => {
    const r = B.importarCsv(b.csv); let criadas = 0, atualizadas = 0;
    for (const v of r.unidades) {
      const ex = d.unidades.find(u => u.bkn === v.bkn);
      if (ex) { d.unidades[d.unidades.indexOf(ex)] = { ...ex, ...v, rt: { ...ex.rt, ...Object.fromEntries(Object.entries(v.rt).filter(([, x]) => x)) }, valorMensal: v.valorMensal != null ? v.valorMensal : ex.valorMensal, id: ex.id }; atualizadas++; }
      else { d.unidades.push({ id: B.uid('bk'), ...v }); criadas++; }
    }
    save(); store.log('bk', `Importação: ${criadas} nova(s), ${atualizadas} atualizada(s)`); return { criadas, atualizadas, erros: r.erros, totalErros: r.totalErros };
  });
  on('GET', '/esteira', async (_, u) => {
    const lista = filtra(u.searchParams, hoje()), lim = Math.min(300, Math.max(10, Number(u.searchParams.get('lim')) || 40));
    return B.ETAPAS.map(([k, nome]) => { const l = lista.filter(x => x.etapa === k); return { etapa: k, nome, itens: l.slice(0, lim), total: l.length }; });
  });
  // ---------- empresas do Bitrix24 como origem dos clientes ----------
  on('GET', '/empresas', async (_, u) => bx.buscar(u.searchParams.get('q') || ''));
  on('GET', '/unidades/([\\w-]+)/sugestoes', async ([id]) => { const u = achar(id); const [porCnpj, porNome] = await Promise.all([bx.porCnpj(u.cnpj), bx.sugestoes(u.nome, 4)]); const ids = new Set(porCnpj.map(e => e.id)); return [...porCnpj.map(e => ({ ...e, motivo: 'mesmo CNPJ' })), ...porNome.filter(e => !ids.has(e.id)).map(e => ({ ...e, motivo: 'nome parecido' }))]; });
  on('POST', '/vincular-empresas', async () => {   // só por CNPJ completo e único: sem chute
    const l = await bx.listar(true); let n = 0;
    for (const u of d.unidades.filter(x => !x.empresaBitrixId && x.cnpj.length === 14)) { const m = l.filter(e => e.cnpj === u.cnpj); if (m.length === 1) { u.empresaBitrixId = m[0].id; n++; } }
    if (n) save(); return { vinculadas: n, semEmpresa: d.unidades.filter(u => u.ativa && !u.empresaBitrixId).length };
  });
  on('POST', '/unidades/([\\w-]+)/criar-empresa', async ([id]) => {   // cria no Bitrix24 só se não houver CNPJ/nome iguais lá
    const u = achar(id); need(!u.empresaBitrixId, 'A unidade já está vinculada a uma empresa.');
    const e = await bx.criar({ nome: u.nome, cnpj: u.cnpj, cidade: u.cidade, uf: u.uf }); u.empresaBitrixId = e.id; save(); store.log('bk', `Empresa criada no Bitrix24 para a unidade ${u.bkn}: ${e.id}`); return u;
  });
  // ---------- funil Regularização (categoria 14): a esteira e as etapas do funil andam juntas ----------
  const CAT = 14;
  const PARA_ETAPA = { aguardando: 'Plano de adequação', enviado: 'Protocolado', em_analise: 'Aguardando vistoria', reenviado: 'Exigências', aguarda_licenca: 'Aguardando vistoria', deferido: 'Licença emitida', desligado: 'Cancelado' };
  const DE_ETAPA = [['diagnóstico', 'aguardando'], ['plano de adequação', 'aguardando'], ['adequações', 'aguardando'], ['documentação pronta', 'aguardando'], ['protocolado', 'enviado'], ['aguardando vistoria', 'em_analise'], ['exigências', 'reenviado'], ['licença emitida', 'deferido'], ['cancelado', 'desligado']];
  const nrm = x => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  async function sincronizarFunil({ simular = true } = {}) {
    need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const rel = { vinculadasCnpj: 0, criados: 0, vinculados: 0, doBitrix: 0, paraBitrix: 0, semEmpresa: 0, erros: [], itens: [] };
    const emp = await bx.listar(true);
    const viaCnpj = new Map();
    for (const u of d.unidades.filter(x => !x.empresaBitrixId && x.cnpj.length === 14)) { const m = emp.filter(e => e.cnpj === u.cnpj); if (m.length === 1) { rel.vinculadasCnpj++; viaCnpj.set(u.id, m[0].id); if (!simular) u.empresaBitrixId = m[0].id; } }
    const est = await funil.estagios(CAT), porNome = trecho => est.find(e => nrm(e.nome).includes(nrm(trecho))), deals = await funil.negocios(CAT);
    for (const u of d.unidades.filter(x => (x.empresaBitrixId || viaCnpj.has(x.id)) && !x.demo)) {
      const emId = u.empresaBitrixId || viaCnpj.get(u.id);
      let dl = u.dealId && deals.find(x => String(x.ID) === u.dealId);
      if (!dl) { dl = deals.find(x => String(x.COMPANY_ID) === emId && new RegExp('(^|\\D)' + u.bkn.replace(/\D/g, '') + '(\\D|$)').test(x.TITLE || '')); if (dl) { rel.vinculados++; if (!simular) u.dealId = String(dl.ID); } }
      const alvo = porNome(PARA_ETAPA[u.etapa]);
      if (!dl) {
        if (!alvo) { rel.erros.push(`${u.bkn}: etapa "${PARA_ETAPA[u.etapa]}" não existe no funil`); continue; }
        rel.criados++; rel.itens.push({ unidade: u.bkn, acao: 'criar', etapa: alvo.nome }); if (simular) continue;
        try { u.dealId = await funil.criar({ TITLE: `BKN ${u.bkn} — ${u.nome}`.slice(0, 250), CATEGORY_ID: CAT, COMPANY_ID: emId, STAGE_ID: alvo.id }); u.stageSync = alvo.id; deals.push({ ID: u.dealId, COMPANY_ID: emId, STAGE_ID: alvo.id, TITLE: `BKN ${u.bkn}` }); } catch (e) { rel.criados--; rel.erros.push(`${u.bkn}: ${e.message}`); }
        continue;
      }
      if (simular) continue;
      const mudouNoBitrix = u.stageSync && dl.STAGE_ID !== u.stageSync, mudouNoApp = alvo && !mudouNoBitrix && alvo.id !== dl.STAGE_ID;
      try {
        if (!u.stageSync) { u.stageSync = dl.STAGE_ID; if (alvo && alvo.id !== dl.STAGE_ID) { await funil.mover(String(dl.ID), alvo.id); u.stageSync = alvo.id; rel.paraBitrix++; } }
        else if (mudouNoBitrix) {   // o Bitrix24 manda quando os dois mudaram
          const nome = (est.find(e => e.id === dl.STAGE_ID) || {}).nome || '', par = DE_ETAPA.find(([t]) => nrm(nome).includes(nrm(t)));
          if (par && par[1] !== u.etapa) { d.historico.push({ id: B.uid('ev'), unidadeId: u.id, data: hoje(), de: u.etapa, para: par[1], nota: 'Etapa alterada no Bitrix24', por: 'Bitrix24' }); u.etapa = par[1]; u.ativa = par[1] !== 'desligado'; rel.doBitrix++; }
          u.stageSync = dl.STAGE_ID;
        } else if (mudouNoApp) { await funil.mover(String(dl.ID), alvo.id); u.stageSync = alvo.id; rel.paraBitrix++; }
      } catch (e) { rel.erros.push(`${u.bkn}: ${e.message}`); }
    }
    rel.semEmpresa = d.unidades.filter(u => u.ativa && !u.empresaBitrixId).length;
    if (!simular) { save(); store.log('bk', `Funil Regularização: ${rel.criados} negócio(s) criado(s), ${rel.vinculados} vinculado(s), ${rel.doBitrix} etapa(s) vinda(s) do Bitrix24, ${rel.paraBitrix} enviada(s)`); }
    return rel;
  }
  // ---------- Kanban do funil 18 (BK): cada negócio é uma solicitação; as colunas são as etapas do funil ----------
  const CAT_SOL = 18, COD_TIPO = 'UF_CRM_1795613816';
  let tiposCache = { at: 0, multiplo: true, itens: [] };
  async function tiposSolicitacao() {   // opções do campo "Tipo de Solicitação" lidas do Bitrix24 (nada fixo no código)
    if (Date.now() - tiposCache.at < 10 * 60 * 1000 && tiposCache.itens.length) return tiposCache;
    const f = ((await bitrix.call('crm.deal.fields', {})).result || {})[COD_TIPO] || {};
    tiposCache = { at: Date.now(), multiplo: !!f.isMultiple, itens: (f.items || []).map(i => ({ id: String(i.ID), nome: String(i.VALUE) })) }; return tiposCache;
  }
  const asArr = v => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(x => x && x !== '0');
  const bknDe = t => (/BKN\s*[:#\-]?\s*(\d{1,6})/i.exec(String(t || '')) || [])[1] || '';
  const digitos = v => String(v || '').replace(/\D/g, '');
  const unidadeDoNegocio = (x, porBkn, porEmp) => { const k = bknDe(x.TITLE); if (k && porBkn.has(k)) return porBkn.get(k); const l = porEmp.get(String(x.COMPANY_ID || '')); return l && l.length === 1 ? l[0] : null; };
  const indices = () => ({ porBkn: new Map(d.unidades.map(u => [digitos(u.bkn), u])), porEmp: d.unidades.reduce((m, u) => { if (u.empresaBitrixId) (m.get(u.empresaBitrixId) || m.set(u.empresaBitrixId, []).get(u.empresaBitrixId)).push(u); return m; }, new Map()) });
  async function kanban() {
    need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.');
    const [est, deals, tp, emp] = await Promise.all([funil.estagios(CAT_SOL, true), funil.negocios(CAT_SOL, [COD_TIPO, 'DATE_CREATE']), tiposSolicitacao(), bx.listar()]), { porBkn, porEmp } = indices(), nomeTipo = new Map(tp.itens.map(i => [i.id, i.nome])), pe = new Map(emp.map(e => [e.id, e]));
    const cards = deals.map(x => {
      const un = unidadeDoNegocio(x, porBkn, porEmp), tipos = asArr(x[COD_TIPO]), e = pe.get(String(x.COMPANY_ID || ''));
      return { id: String(x.ID), titulo: x.TITLE || `Negócio ${x.ID}`, etapa: x.STAGE_ID, bkn: bknDe(x.TITLE) || (un ? digitos(un.bkn) : ''), criado: String(x.DATE_CREATE || '').slice(0, 10), url: `https://${bx.host()}/crm/deal/details/${x.ID}/`,
        unidade: un ? { id: un.id, bkn: un.bkn, nome: un.nome, cidade: un.cidade, uf: un.uf, rt: un.rt.nome, cnpj: un.cnpj } : null, empresa: x.COMPANY_ID && Number(x.COMPANY_ID) ? { id: String(x.COMPANY_ID), nome: e ? e.nome : `Empresa ${x.COMPANY_ID}`, cnpj: e ? e.cnpj : '' } : null,
        tipos, tiposNomes: tipos.map(t => nomeTipo.get(t) || t), semEmpresa: !(x.COMPANY_ID && Number(x.COMPANY_ID)), semTipo: !tipos.length, semUnidade: !un };
    }).sort((a, b) => (Number(b.semEmpresa || b.semTipo) - Number(a.semEmpresa || a.semTipo)) || Number(b.id) - Number(a.id));
    return { etapas: est.map(e => ({ id: e.id, nome: e.nome, tom: /WON$/.test(e.id) ? 'ok' : /LOSE$/.test(e.id) ? 'n' : '' })), tipos: tp.itens, multiplo: tp.multiplo, cards,
      resumo: { total: cards.length, semEmpresa: cards.filter(c => c.semEmpresa).length, semTipo: cards.filter(c => c.semTipo).length, semUnidade: cards.filter(c => c.semUnidade).length } };
  }
  const negocioSol = async id => { const x = (await bitrix.call('crm.deal.get', { id })).result; need(x && String(x.CATEGORY_ID) === String(CAT_SOL), 'Negócio não encontrado no funil BK.'); return x; };
  on('GET', '/kanban', async () => kanban());
  on('POST', '/kanban/(\\d+)/mover', async ([id], _, b) => {   // arrastar o card muda a etapa no Bitrix24
    need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.'); const x = await negocioSol(id), est = await funil.estagios(CAT_SOL, true), alvo = est.find(e => e.id === b.etapa); need(alvo, 'Etapa inválida.');
    if (x.STAGE_ID !== alvo.id) { await funil.mover(id, alvo.id); store.log('bk', `Solicitação ${id}: ${(est.find(e => e.id === x.STAGE_ID) || {}).nome || x.STAGE_ID} → ${alvo.nome}`); }
    return { ok: true, etapa: alvo.id };
  });
  on('PUT', '/kanban/(\\d+)/tipos', async ([id], _, b) => {
    need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.'); await negocioSol(id); const tp = await tiposSolicitacao(), ids = [...new Set(asArr(b.tipos))]; need(ids.every(i => tp.itens.some(t => t.id === i)), 'Tipo de solicitação inválido.');
    need(tp.multiplo || ids.length <= 1, 'O campo Tipo de Solicitação aceita só um valor no Bitrix24.'); await bitrix.call('crm.deal.update', { id, fields: { [COD_TIPO]: tp.multiplo ? ids : (ids[0] || '') } }); return { ok: true, tipos: ids };
  });
  // Vínculo da empresa direto no card: busca pelo CNPJ (campo CNPJ da empresa e requisitos), confirma, e grava COMPANY_ID no negócio. Nada é vinculado sem confirmação.
  on('POST', '/kanban/(\\d+)/empresa/buscar', async ([id], _, b) => {
    need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.'); await negocioSol(id); const dg = digitos(b.cnpj); need(dg.length === 14 && (!cnpjApi || cnpjApi.cnpjValido(dg)), 'CNPJ inválido.');
    const ach = new Map((await bx.listar(true)).filter(e => e.cnpj === dg).map(e => [e.id, e]));
    try { for (const r of (await bitrix.call('crm.requisite.list', { filter: { RQ_INN: dg, ENTITY_TYPE_ID: 4 }, select: ['ID', 'ENTITY_ID'] })).result || []) { const e = await bx.porId(r.ENTITY_ID); if (e) ach.set(e.id, e); } } catch { /* requisitos são opcionais */ }
    let receita = null; if (!ach.size && cnpjApi) { try { const r = await cnpjApi.consultar(dg); receita = { razao: r.razao, fantasia: r.fantasia, cidade: r.cidade, uf: r.uf }; } catch { /* a Receita é opcional */ } }
    return { cnpj: dg, encontradas: [...ach.values()].map(e => ({ id: e.id, nome: e.nome, cnpj: e.cnpj, cidade: e.cidade, uf: e.uf })), receita };
  });
  const vincularNegocio = async (id, empresaId) => {
    const e = await bx.porId(empresaId); need(e, 'Empresa não encontrada no Bitrix24.'); const x = await negocioSol(id); await bitrix.call('crm.deal.update', { id, fields: { COMPANY_ID: e.id } });
    const { porBkn } = indices(), un = porBkn.get(bknDe(x.TITLE)); if (un && !un.empresaBitrixId) { un.empresaBitrixId = e.id; if (!un.cnpj && e.cnpj) un.cnpj = e.cnpj; save(); }
    store.log('bk', `Solicitação ${id} vinculada à empresa ${e.nome} (${e.id})`); return { ok: true, empresa: { id: e.id, nome: e.nome, cnpj: e.cnpj } };
  };
  on('POST', '/kanban/(\\d+)/empresa/vincular', async ([id], _, b) => { need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.'); return vincularNegocio(id, String(b.empresaId || '')); });
  on('POST', '/kanban/(\\d+)/empresa/criar', async ([id], _, b) => {
    need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.'); await negocioSol(id); const dg = digitos(b.cnpj), nome = String(b.nome || '').trim().slice(0, 200); need(dg.length === 14 && (!cnpjApi || cnpjApi.cnpjValido(dg)), 'CNPJ inválido.'); need(nome.length >= 2, 'Informe o nome da empresa.');
    let extra = {}; if (cnpjApi) { try { const r = await cnpjApi.consultar(dg); extra = { razao: r.razao, cep: r.cep, bairro: r.bairro, cidade: r.cidade, uf: r.uf }; } catch { /* opcional */ } }
    let e; try { e = await bx.criar({ nome, cnpj: dg, ...extra }); } catch (er) { if (er.status === 409 && er.existente) e = er.existente; else throw er; }
    return vincularNegocio(id, e.id);
  });
  // Cria a unidade no app a partir do card quando o BKN do título ainda não existe.
  on('POST', '/kanban/(\\d+)/unidade', async ([id], _, b) => {
    const x = await negocioSol(id), bkn = digitos(b.bkn || bknDe(x.TITLE)); need(bkn, 'Informe o BKN da unidade (o título do card não traz).'); need(!dupBkn(bkn), `Já existe a unidade BKN ${bkn}.`);
    const nome = String(b.nome || String(x.TITLE || '').replace(/^.*?BKN\s*[:#\-]?\s*\d+\s*[—–\-:]*\s*/i, '') || `Unidade ${bkn}`).trim().slice(0, 120);
    const v = B.validaUnidade({ bkn, nome, empresaBitrixId: x.COMPANY_ID && Number(x.COMPANY_ID) ? String(x.COMPANY_ID) : '' }), u = { id: B.uid('bk'), ...v }; d.unidades.push(u); save(); store.log('bk', `Unidade ${bkn} criada a partir da solicitação ${id}`); return { ok: true, unidade: { id: u.id, bkn: u.bkn, nome: u.nome } };
  });
  on('POST', '/funil/sincronizar', async (_, __, b) => sincronizarFunil({ simular: b.simular !== false }));
  // Cria no Bitrix24 a empresa de cada unidade que ainda não tem. Confere CNPJ e nome antes (se já existe, só vincula) e completa a razão social pela Receita quando possível.
  on('POST', '/empresas/criar-pendentes', async (_, __, b) => {
    need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409); const simular = b.simular !== false, lote = Math.min(40, Math.max(1, Number(b.lote) || 20)), emp = await bx.listar(true);
    const pend = d.unidades.filter(u => u.ativa && !u.demo && !u.empresaBitrixId).map(u => ({ u, ig: u.cnpj.length === 14 ? emp.find(e => e.cnpj === u.cnpj) : null }));
    const cont = { vincular: pend.filter(x => x.ig).length, criar: pend.filter(x => !x.ig).length, semCnpj: pend.filter(x => !x.ig && x.u.cnpj.length !== 14).length };
    if (simular) return { simulacao: true, ...cont, itens: pend.slice(0, 300).map(x => ({ unidade: `${x.u.bkn} — ${x.u.nome}`, acao: x.ig ? 'vincular' : 'criar', empresa: x.ig ? x.ig.nome : '' })) };
    let criadas = 0, vinculadas = 0; const erros = [];
    for (const x of pend.slice(0, lote)) {
      try {
        if (x.ig) { x.u.empresaBitrixId = x.ig.id; vinculadas++; continue; }
        let extra = {}; if (cnpjApi && x.u.cnpj.length === 14) { try { const r = await cnpjApi.consultar(x.u.cnpj); extra = { razao: r.razao, cep: r.cep, bairro: r.bairro, cidade: x.u.cidade || r.cidade, uf: x.u.uf || r.uf }; } catch { /* a Receita é opcional */ } }
        try { const e = await bx.criar({ nome: x.u.nome, cnpj: x.u.cnpj, cidade: x.u.cidade, uf: x.u.uf, ...extra }); x.u.empresaBitrixId = e.id; criadas++; }
        catch (er) { if (er.status === 409 && er.existente) { x.u.empresaBitrixId = er.existente.id; vinculadas++; } else throw er; }
      } catch (er) { erros.push(`${x.u.bkn}: ${er.message}`); }
    }
    save(); store.log('bk', `Empresas no Bitrix24: ${criadas} criada(s), ${vinculadas} vinculada(s) a existentes`);
    return { criadas, vinculadas, restantes: Math.max(0, pend.length - lote), erros: erros.slice(0, 10) };
  });
  on('POST', '/avisar', async (_, __, b) => avisar({ simular: !!b.simular }));
  on('PUT', '/config', async (_, __, b) => {
    const c = { ...d.config };
    if (b.valorPadrao !== undefined) { const v = Number(b.valorPadrao); need(Number.isFinite(v) && v >= 0 && v < 1e7, 'Valor padrão inválido.'); c.valorPadrao = v; }
    if (b.responsavelPadrao !== undefined) c.responsavelPadrao = String(b.responsavelPadrao).replace(/\D/g, '').slice(0, 12);
    if (b.empresaId !== undefined) { need(!b.empresaId || fin.empresas.get(b.empresaId), 'Empresa não encontrada.'); c.empresaId = b.empresaId; }
    if (b.cliente !== undefined) c.cliente = String(b.cliente).trim().slice(0, 120);
    if (b.diaVenc !== undefined) { const v = Number(b.diaVenc); need(Number.isInteger(v) && v >= 1 && v <= 28, 'Dia de vencimento: de 1 a 28.'); c.diaVenc = v; }
    if (b.categoria !== undefined) c.categoria = String(b.categoria).trim().slice(0, 80);
    if (b.marcos !== undefined) { const m = [].concat(b.marcos).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 365); need(m.length, 'Informe ao menos um marco de aviso.'); c.marcos = [...new Set(m)].sort((a, b2) => b2 - a); }
    d.config = c; save(); return c;
  });

  // ---------- medição mensal → A Receber ----------
  const plano = q => B.planejarMedicao({ unidades: d.unidades, competencia: q, valorPadrao: d.config.valorPadrao, medidas: d.medicoes, hoje: hoje() });
  on('GET', '/medicao/previa', async (_, u) => ({ ...plano(u.searchParams.get('competencia') || B.mesAnterior(hoje())), config: d.config }));
  on('GET', '/medicoes', async () => {
    const por = {}; for (const m of d.medicoes) { const x = por[m.competencia] ||= { competencia: m.competencia, unidades: 0, total: 0 }; x.unidades++; x.total += m.valor; }
    return Object.values(por).sort((a, b) => b.competencia.localeCompare(a.competencia)).map(x => ({ ...x, total: Math.round(x.total * 100) / 100 }));
  });
  on('POST', '/medicao/gerar', async (_, __, b) => {
    const cfg = d.config, empresaId = String(b.empresaId || cfg.empresaId || ''); need(empresaId && fin.empresas.get(empresaId), 'Escolha a empresa que vai faturar (Configurações da medição).');
    const p = plano(b.competencia), ids = Array.isArray(b.unidades) ? new Set(b.unidades) : null, itens = p.itens.filter(i => i.gerar && (!ids || ids.has(i.unidadeId)));
    need(itens.length, 'Nenhuma unidade para faturar nesta competência.');
    const [y, m] = p.competencia.split('-').map(Number), ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1, venc = `${ny}-${String(nm).padStart(2, '0')}-${String(cfg.diaVenc).padStart(2, '0')}`;
    const mes = `${String(m).padStart(2, '0')}/${y}`, novos = [], med = [];
    const ctx = { formas: fin.formas.all(), condicoes: fin.condicoes.all(), hoje: hoje() };
    for (const i of itens) {
      const [l] = C.criarLancamentos({ empresaId, descricao: `RT nutricionista ${mes} — BKN ${i.bkn} ${i.nome}`.slice(0, 200), cliente: cfg.cliente, categoria: cfg.categoria, valor: i.valor, venc, forma: 'BOLETO', parcelas: 1, obs: `Medição mensal BK · competência ${p.competencia}` }, 'receber', ctx);
      novos.push({ ...l, origem: 'bk', bkUnidadeId: i.unidadeId, bkCompetencia: p.competencia });
      med.push({ id: B.uid('md'), competencia: p.competencia, unidadeId: i.unidadeId, bkn: i.bkn, valor: i.valor, lancamentoId: l.id, empresaId, em: hoje() });
    }
    fin.receber.add(novos); d.medicoes.push(...med); save();
    store.log('bk', `Medição ${p.competencia}: ${novos.length} título(s) em A Receber, total ${itens.reduce((s, i) => s + i.valor, 0).toFixed(2)}`);
    return { geradas: novos.length, total: Math.round(itens.reduce((s, i) => s + i.valor, 0) * 100) / 100, venc };
  });
  on('POST', '/medicao/desfazer', async (_, __, b) => {
    const c = B.compOk(b.competencia), ms = d.medicoes.filter(m => m.competencia === c); need(ms.length, 'Não há medição nesta competência.');
    const abertos = ms.filter(m => { const l = fin.receber.get(m.lancamentoId); return l && l.status !== 'aberto'; });
    need(!abertos.length, `${abertos.length} título(s) desta medição já foram baixados. Estorne-os antes de desfazer.`);
    for (const m of ms) fin.receber.remove(m.lancamentoId);
    d.medicoes = d.medicoes.filter(m => m.competencia !== c); save(); return { removidos: ms.length };
  });

  // ---------- demonstração ----------
  on('POST', '/demo/carregar', async () => { need(!d.unidades.some(u => u.demo), 'Os dados de demonstração já estão carregados.'); const x = B.demoUnidades(hoje()); d.unidades.push(...x.filter(u => !dupBkn(u.bkn))); save(); return { unidades: x.length }; });
  on('DELETE', '/demo', async () => { const ids = new Set(d.unidades.filter(u => u.demo).map(u => u.id)); d.unidades = d.unidades.filter(u => !u.demo); d.historico = d.historico.filter(e => !ids.has(e.unidadeId)); const md = d.medicoes.filter(m => ids.has(m.unidadeId)); for (const m of md) fin.receber.remove(m.lancamentoId); d.medicoes = d.medicoes.filter(m => !ids.has(m.unidadeId)); save(); return { removidas: ids.size }; });

  return {
    empresaIds: () => new Set(d.unidades.filter(u => u.empresaBitrixId && !u.demo).map(u => String(u.empresaBitrixId))),
    unidades: () => d.unidades, sincronizarFunil, avisar,
    async handle(method, pathname, u, readBody) {
      for (const [m, re, h] of routes) { const g = m === method && pathname.match(re); if (g) return { json: await h(g.slice(1), u, ['POST', 'PUT'].includes(method) ? await readBody() : {}) }; }
      return null;
    },
  };
}
module.exports = { createBkApi };
