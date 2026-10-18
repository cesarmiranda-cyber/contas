'use strict';
const R = require('./rules');
const F = require('./fin');
const C = require('./finCad');
const X = require('./finExtra');
const S = require('./finEstoque');
const { parseNfe } = require('./nfe');
const { parseOfx } = require('./ofx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CAT_DEAL = 15;   // funil "Contratos" (Nutrimix)
const notFound = what => { const e = new Error(`${what} não encontrado.`); e.status = 404; return e; };

// Rotas /api/fin/*: empresas, contas a pagar/receber, folha, fluxo de caixa, relatórios e contratos (funil 15).
function createFinApi({ fin, empresas, svc, bitrix, asaas, store, dataDir }) {
  const hoje = () => R.todayBR();
  const scope = u => { const e = u.searchParams.get('empresa'); return e && e !== 'todas' ? e : ''; };
  const need = (cond, msg) => { if (!cond) throw F.bad(msg); };
  const empresaOk = id => { need(empresas.get(id), 'Empresa não encontrada.'); return id; };

  // ---------- recebíveis: deals do funil 90 + lançamentos manuais ----------
  async function receber() {
    let deals = [];
    if (bitrix.enabled) { try { deals = await svc.dealsCached(); } catch (e) { store.log('erro', `fin: leitura de deals: ${e.message}`); } }
    return [...F.recebiveisDeDeals(deals, d => d.empresa), ...fin.receber.all()];
  }
  const dadosContas = () => ({ pagar: fin.pagar.all(), receber: fin.receber.all(), transferencias: fin.transferencias.all() });
  const contasDe = e => fin.contas.all().filter(c => c.ativa && (!e || c.empresaId === e));
  // saldo no início da janela do fluxo de caixa: contas bancárias cadastradas (saldo inicial + baixas + transferências) ou o valor manual antigo
  const saldoInicial = (empresaId, dia) => {
    const cs = contasDe(empresaId);
    if (cs.length) return F.round2(cs.reduce((a, c) => a + C.saldoAntes(c, dadosContas(), dia || hoje()), 0));
    const m = fin.config.saldoInicial || {};
    return empresaId ? Number(m[empresaId]) || 0 : Object.values(m).reduce((a, v) => a + (Number(v) || 0), 0);
  };


  // ---------- contratos (funil 15) ----------
  let cc = { at: 0, deals: [], stages: [] };
  async function loadContratos(force) {
    if (!bitrix.enabled) { const e = new Error('Bitrix24 não configurado: informe o webhook em Configurações (tela de cobranças).'); e.status = 503; throw e; }
    if (!force && Date.now() - cc.at < 60000) return cc;
    await empresas.loadEnum().catch(() => {});
    const deals = await bitrix.listAll('crm.deal.list', { filter: { CATEGORY_ID: CAT_DEAL }, select: ['*', 'UF_*'], order: { ID: 'DESC' } });
    let stages = [];
    try { stages = ((await bitrix.call('crm.status.list', { filter: { ENTITY_ID: `DEAL_STAGE_${CAT_DEAL}` } })).result || []).map(s => ({ id: s.STATUS_ID, nome: s.NAME, semantica: s.EXTRA?.SEMANTICS || '' })); } catch { /* sem etapas */ }
    cc = { at: Date.now(), deals, stages };
    return cc;
  }
  const etapaAtiva = (d, stages) => {
    const ativas = fin.config.contratoEtapasAtivas || [];
    if (ativas.length) return ativas.includes(d.STAGE_ID);
    return (stages.find(s => s.id === d.STAGE_ID)?.semantica || '') !== 'F';   // sem configuração: tudo que não foi perdido
  };
  async function contratos({ empresaId = '', todos = false } = {}) {
    const { deals, stages } = await loadContratos();
    let l = deals.filter(d => todos || etapaAtiva(d, stages)).map(d => ({ ...F.contratoDeDeal(d, { campoVenc: fin.config.contratoCampoVenc, hoje: hoje(), empresaDe: d2 => empresas.empresaDe(d2) }), etapaNome: stages.find(x => x.id === d.STAGE_ID)?.nome || d.STAGE_ID }));
    if (empresaId) l = l.filter(c => c.empresaId === empresaId);
    const [nomes, users] = await Promise.all([nomesBitrix(l), nomesUsuarios(l)]);
    return l.map(c => {
      const ct = { ...c, cliente: nomes[`c${c.companyId}`] || nomes[`p${c.contactId}`] || '', responsavelNome: users[c.responsavel] || '', empresa: empresas.get(c.empresaId)?.nome || nomes[`c${c.mycompanyId}`] || '' };
      return { ...ct, faltas: F.faltasContrato(ct) };
    }).sort((a, b) => (a.venc || '9999').localeCompare(b.venc || '9999'));
  }
  // nomes de empresas e contatos em lote (c<id> = empresa, p<id> = contato)
  async function nomesBitrix(list) {
    const out = {};
    const run = async (method, ids, fn) => {
      for (let i = 0; i < ids.length; i += 50) {
        try { for (const x of (await bitrix.call(method, { filter: { ID: ids.slice(i, i + 50) }, select: ['ID', 'TITLE', 'NAME', 'LAST_NAME'] })).result || []) fn(x); } catch { /* sem nomes */ }
      }
    };
    await run('crm.company.list', [...new Set(list.flatMap(c => [c.companyId, c.mycompanyId]).filter(Boolean))], x => { out[`c${x.ID}`] = x.TITLE; });
    await run('crm.contact.list', [...new Set(list.map(c => c.contactId).filter(Boolean))], x => { out[`p${x.ID}`] = [x.NAME, x.LAST_NAME].filter(Boolean).join(' '); });
    return out;
  }
  async function nomesUsuarios(list) {
    const ids = [...new Set(list.map(c => c.responsavel).filter(Boolean))], out = {};
    if (!ids.length) return out;
    try { for (const u of (await bitrix.call('user.get', { filter: { ID: ids } })).result || []) out[u.ID] = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || u.EMAIL; } catch { /* sem nomes */ }
    return out;
  }
  // rótulos e opções dos campos personalizados da deal (para mostrar os dados do contrato como no Bitrix)
  let ufCache = { at: 0, map: {} };
  async function camposDeal() {
    if (Date.now() - ufCache.at < 300000) return ufCache.map;
    const map = {};
    try {
      for (const f of (await bitrix.call('crm.deal.userfield.list', {})).result || []) {
        const lb = f.EDIT_FORM_LABEL; const nome = typeof lb === 'string' ? lb : (lb?.br || lb?.pt || lb?.en || Object.values(lb || {})[0] || f.FIELD_NAME);
        map[f.FIELD_NAME] = { nome, tipo: f.USER_TYPE_ID, opcoes: Object.fromEntries((f.LIST || []).map(i => [String(i.ID), i.VALUE])) };
      }
    } catch { /* sem rótulos */ }
    ufCache = { at: Date.now(), map };
    return map;
  }
  const valorCampo = (v, def) => {
    if (v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) return '';
    const one = x => (def?.opcoes && def.opcoes[String(x)]) || (x === true || x === 'Y' ? 'Sim' : x === 'N' ? 'Não' : String(x));
    if (Array.isArray(v)) return v.map(one).join(', ');
    if (def?.tipo === 'date' || def?.tipo === 'datetime') return R.toDay(v);
    if (def?.tipo === 'boolean') return one(v === '1' || v === 1 ? 'Y' : v);
    if (def?.tipo === 'money') return String(v).split('|')[0];
    return one(v);
  };
  async function contratoDaDeal(dealId) {
    const all = await contratos({ todos: true });
    const c = all.find(x => x.id === +dealId);
    if (!c) throw notFound('Contrato');
    const raw = cc.deals.find(d => +d.ID === c.id) || {};
    let cliente = { nome: c.cliente, tipo: '', doc: '', email: '', telefone: '', endereco: '', contatos: [] };
    const tel = e => e.PHONE?.[0]?.VALUE || '', mail = e => e.EMAIL?.[0]?.VALUE || '';
    try {
      if (c.companyId) {
        const e = (await bitrix.call('crm.company.get', { id: c.companyId })).result || {};
        let doc = R.findDoc(e, ['UF_CRM_CNPJ', 'UF_CRM_6675B86EE950A']);
        if (!doc) { try { const rq = (await bitrix.call('crm.requisite.list', { filter: { ENTITY_TYPE_ID: 4, ENTITY_ID: c.companyId }, select: ['RQ_CNPJ', 'RQ_CPF'] })).result || []; doc = R.findDoc(rq[0] || {}, ['RQ_CNPJ', 'RQ_CPF']); } catch { /* sem requisitos */ } }
        cliente = { nome: e.TITLE || c.cliente, tipo: 'Empresa', doc, email: mail(e), telefone: tel(e), endereco: [e.ADDRESS, e.ADDRESS_CITY, e.ADDRESS_PROVINCE].filter(Boolean).join(' · '), contatos: [] };
      }
      const cids = [c.contactId].filter(Boolean);
      try { for (const x of (await bitrix.call('crm.deal.contact.items.get', { id: c.id })).result || []) if (!cids.includes(String(x.CONTACT_ID))) cids.push(String(x.CONTACT_ID)); } catch { /* sem contatos extras */ }
      for (const id of cids.slice(0, 5)) {
        const e = (await bitrix.call('crm.contact.get', { id })).result || {};
        const nome = [e.NAME, e.LAST_NAME].filter(Boolean).join(' ');
        cliente.contatos.push({ nome, cargo: e.POST || '', email: mail(e), telefone: tel(e) });
        if (!c.companyId && id === c.contactId) cliente = { ...cliente, nome, tipo: 'Pessoa', email: mail(e), telefone: tel(e) };
      }
    } catch { /* cliente parcial */ }
    // campos personalizados preenchidos na deal (rótulos do Bitrix)
    const defs = await camposDeal();
    const dados = Object.entries(raw).filter(([k]) => k.startsWith('UF_CRM_') && k !== empresas.FIELD).map(([k, v]) => ({ campo: k, nome: defs[k]?.nome || k, valor: valorCampo(v, defs[k]) })).filter(x => x.valor);
    // só o financeiro deste cliente (mesma empresa/contato do contrato)
    const deals = bitrix.enabled ? await svc.dealsCached() : [];
    const mine = deals.filter(d => !R.CONTRACT_STAGES.has(d.stageId) && ((c.companyId && String(d.companyId) === c.companyId) || (!c.companyId && c.contactId && String(d.contactId) === c.contactId)));
    const parcelas = F.recebiveisDeDeals(mine, d => d.empresa).map(r => ({ ...r, status: F.statusReceber(r, hoje()), link: (mine.find(d => d.id === r.dealId) || {}).link || '' })).sort((a, b) => (a.venc || '').localeCompare(b.venc || ''));
    const abertas = parcelas.filter(p => p.status !== 'pago' && p.status !== 'cancelado');
    return {
      contrato: c, cliente, dados,
      financeiro: { parcelas, aberto: F.round2(abertas.reduce((a, p) => a + p.valor, 0)), atrasado: F.round2(parcelas.filter(p => p.status === 'atrasado').reduce((a, p) => a + p.valor, 0)), pago: F.round2(parcelas.filter(p => p.status === 'pago').reduce((a, p) => a + p.valor, 0)) },
      avisos: fin.avisos(String(c.id)), host: new URL(bitrix.base).host,
    };
  }

  // Avisa o responsável (notificação do Bitrix + comentário na deal) quando o contrato atinge um marco de vencimento.
  async function avisarContratos({ simular = false } = {}) {
    const marcos = (fin.config.marcosAviso || [30, 7, 0]).map(Number).filter(Number.isFinite);
    const lista = await contratos(), enviados = [], erros = [];
    for (const c of lista) {
      const marco = F.avisoDevido(c.diasParaVencer, marcos, fin.avisos(String(c.id)));
      if (marco === null) continue;
      const msg = marco === -1 ? `Contrato vencido há ${-c.diasParaVencer} dia(s): ${c.titulo} (${c.cliente || 'sem cliente'}) venceu em ${c.venc}.`
        : marco === 0 && c.diasParaVencer === 0 ? `O contrato "${c.titulo}" (${c.cliente || 'sem cliente'}) vence HOJE (${c.venc}).`
          : `O contrato "${c.titulo}" (${c.cliente || 'sem cliente'}) vence em ${c.diasParaVencer} dia(s) (${c.venc}).`;
      if (simular) { enviados.push({ id: c.id, marco, msg }); continue; }
      try {
        if (c.responsavel) await bitrix.call('im.notify.personal.add', { USER_ID: c.responsavel, MESSAGE: `${msg} [URL=https://${new URL(bitrix.base).host}/crm/deal/details/${c.id}/]Abrir contrato[/URL]`, TAG: `contrato-${c.id}-${marco}` });
        try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: c.id, ENTITY_TYPE: 'deal', COMMENT: msg } }); } catch { /* opcional */ }
        fin.markAviso(String(c.id), marco);
        store.log('contrato', `Aviso de vencimento (${marco === -1 ? 'vencido' : 'D-' + marco}) enviado ao responsável ${c.responsavel}: ${c.titulo}`, { deal: c.id });
        enviados.push({ id: c.id, marco, msg });
      } catch (e) { erros.push(`contrato ${c.id}: ${e.message}`); }
    }
    return { analisados: lista.length, enviados, erros };
  }

  // ---------- pagamento pelo Asaas (contas a pagar) — sempre com confirmação explícita ----------
  async function pagarPeloAsaas(c, { confirmar, chavePix, tipoChave } = {}) {
    need(confirmar === true, 'Confirme o pagamento: ele movimenta dinheiro real da conta Asaas da empresa.');
    need(c.status !== 'paga' && c.status !== 'cancelada', 'Conta já paga ou cancelada.');
    return asaas.as(c.empresaId, async () => {
      need(asaas.enabled, 'A empresa não tem chave do Asaas.');
      let r;
      if (c.forma === 'BOLETO') {
        need(R.digits(c.codigoBarras).length >= 44, 'Informe a linha digitável/código de barras da conta.');
        r = await asaas.payBill({ identificationField: R.digits(c.codigoBarras), scheduleDate: c.venc < hoje() ? hoje() : c.venc, description: c.descricao.slice(0, 100) });
      } else if (c.forma === 'PIX') {
        need(chavePix || c.chavePix, 'Informe a chave Pix do favorecido.');
        r = await asaas.transfer({ value: c.valor, pixAddressKey: chavePix || c.chavePix, pixAddressKeyType: tipoChave || 'EVP', description: c.descricao.slice(0, 100), operationType: 'PIX' });
      } else throw F.bad('O pagamento pelo Asaas vale para boleto e Pix.');
      return { asaasId: r.id, status: r.status };
    });
  }

  // Lança no contas a pagar a folha de uma competência (idempotente: só cria o que ainda não existe).
  function gerarFolhaEmpresa(empresaId, competencia) {
    const keys = new Set(fin.pagar.all().map(c => c.folhaKey).filter(Boolean));
    const contas = F.gerarFolha({ funcionarios: fin.funcionarios.all(), competencia, empresaId, jaGeradas: keys }, hoje());
    if (contas.length) fin.pagar.add(contas);
    const info = { em: new Date().toISOString(), contas: contas.length, total: F.round2(contas.reduce((a, c) => a + c.valor, 0)) };
    if (contas.length || !fin.folhaGerada(empresaId, competencia)) fin.markFolha(empresaId, competencia, info);
    store.log('folha', `Folha ${competencia} (${empresas.get(empresaId).nome}): ${contas.length} lançamento(s) a pagar`);
    return { ...info, novas: contas.length };
  }
  // Todo mês: gera sozinho a folha da competência corrente das empresas ativas (se ainda não foi gerada).
  function folhaAuto() {
    if (fin.config.folhaAuto === false) return [];
    const comp = hoje().slice(0, 7), out = [];
    for (const e of fin.empresas.all().filter(x => x.ativa)) {
      if (fin.folhaGerada(e.id, comp) || !fin.funcionarios.all().some(f => f.empresaId === e.id && F.naFolha(f, comp))) continue;
      out.push({ empresa: e.nome, ...gerarFolhaEmpresa(e.id, comp) });
    }
    return out;
  }

  // ---------- dispatcher ----------
  const routes = [];
  const on = (method, re, h) => routes.push([method, new RegExp(`^/api/fin${re}$`), h]);
  const ctx = async u => ({ rec: await receber(), pag: fin.pagar.all(), func: fin.funcionarios.all(), e: scope(u) });

  const cadastros = () => ({ contas: fin.contas.all(), formas: fin.formas.all(), condicoes: fin.condicoes.all(), categorias: fin.categorias.all(), centros: fin.centros.all(), fornecedores: fin.fornecedores.all() });
  on('GET', '/bootstrap', async () => ({
    empresas: empresas.list(), config: fin.config, formas: F.FORMAS_PAG, categorias: F.CATEGORIAS_DESPESA, hoje: hoje(), campoEmpresa: empresas.FIELD,
    bitrix: bitrix.enabled, host: bitrix.enabled ? new URL(bitrix.base).host : '', cad: cadastros(), bancos: C.BANCOS, tiposConta: C.TIPOS_CONTA, tiposForma: C.TIPOS_FORMA,
  }));
  // cadastros: contas bancárias, formas e condições de pagamento, categorias, centros de custo, fornecedores
  const CAD = Object.keys(C.VALID).join('|');
  const nm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const semDuplicar = (t, v, id) => need(!fin[t].all().some(x => x.id !== id && nm(x.nome) === nm(v.nome) && (t !== 'contas' || x.empresaId === v.empresaId) && (t !== 'categorias' || x.tipo === v.tipo)), 'Já existe um cadastro com esse nome.');
  on('GET', `/cad/(${CAD})`, async ([t]) => fin[t].all());
  on('POST', `/cad/(${CAD})`, async ([t], _, b) => {
    const v = C.VALID[t](b); semDuplicar(t, v);
    if (t === 'contas') { empresaOk(v.empresaId); if (v.padrao) for (const o of fin.contas.all().filter(x => x.empresaId === v.empresaId && x.padrao)) fin.contas.put({ ...o, padrao: false }); }
    if (t === 'formas' && v.contaId) contaOk(v.contaId, fin.contas.get(v.contaId)?.empresaId);
    const item = { id: F.uid(t.slice(0, 3)), ...v }; fin[t].add(item); store.log('cadastro', `${t}: ${item.nome} criado`); return item;
  });
  on('PUT', `/cad/(${CAD})/([\\w-]+)`, async ([t, id], _, b) => {
    const a = fin[t].get(id); if (!a) throw notFound('Cadastro');
    const v = C.VALID[t]({ ...a, ...b }); semDuplicar(t, v, id);
    if (t === 'contas' && v.padrao) for (const o of fin.contas.all().filter(x => x.empresaId === v.empresaId && x.padrao && x.id !== id)) fin.contas.put({ ...o, padrao: false });
    return fin[t].put({ id, ...v });
  });
  on('DELETE', `/cad/(${CAD})/([\\w-]+)`, async ([t, id]) => {
    const a = fin[t].get(id); if (!a) throw notFound('Cadastro');
    const n = C.usos(t, a, { pagar: fin.pagar.all(), receber: fin.receber.all(), contas: fin.contas.all() }) + (t === 'contas' ? fin.transferencias.all().filter(x => x.de === id || x.para === id).length : 0);
    if (n) { fin[t].put({ ...a, ativa: false }); return { ok: true, inativado: true, usos: n }; }
    fin[t].remove(id); return { ok: true, removido: true };
  });
  // contas bancárias: saldos, extrato e transferências
  on('GET', '/contas/saldos', async (_, u) => {
    const e = scope(u), d = dadosContas();
    return F.pick(fin.contas.all(), e).map(c => ({ ...c, empresa: empresas.get(c.empresaId)?.nome || '', saldo: C.saldoConta(c, d, hoje()), movimentos: C.movimentos(c, d).length }));
  });
  on('GET', '/contas/([\\w-]+)/extrato', async ([id], u) => { const c = fin.contas.get(id); if (!c) throw notFound('Conta'); return C.extrato(c, dadosContas(), { de: u.searchParams.get('de') || '', ate: u.searchParams.get('ate') || '' }); });
  on('GET', '/transferencias', async (_, u) => { const e = scope(u); return fin.transferencias.all().filter(t => !e || fin.contas.get(t.de)?.empresaId === e || fin.contas.get(t.para)?.empresaId === e).sort((a, b) => b.data.localeCompare(a.data)); });
  on('POST', '/transferencias', async (_, __, b) => { const t = { id: F.uid('tr'), ...C.validarTransferencia(b, fin.contas.all(), hoje()) }; fin.transferencias.add(t); store.log('transferencia', `Transferência de ${t.valor} entre contas`); return t; });
  on('DELETE', '/transferencias/([\\w-]+)', async ([id]) => { need(fin.transferencias.get(id), 'Transferência não encontrada.'); fin.transferencias.remove(id); return { ok: true }; });

  // checklist de implantação: o que já está conectado e o que falta
  on('GET', '/status', async () => {
    const out = { bitrix: { ok: false, msg: 'Webhook não configurado' }, campoEmpresa: false, empresas: fin.empresas.all().length, empresasAsaas: empresas.list().filter(e => e.asaas.configurado).length, funcionarios: fin.funcionarios.all().length, contratos: 0, cobrancas: 0, minhas: [] };
    if (!bitrix.enabled) return out;
    try { const u = (await bitrix.call('profile', {})).result || {}; out.bitrix = { ok: true, usuario: [u.NAME, u.LAST_NAME].filter(Boolean).join(' '), admin: !!u.ADMIN, host: new URL(bitrix.base).host }; } catch (e) { out.bitrix = { ok: false, msg: e.message }; return out; }
    try { out.campoEmpresa = ((await bitrix.call('crm.deal.userfield.list', {})).result || []).some(f => f.FIELD_NAME === empresas.FIELD); } catch { /* sem campo */ }
    try { out.contratos = (await contratos()).length; } catch { /* sem contratos */ }
    try { out.cobrancas = (await receber()).filter(r => r.origem === 'bitrix').length; } catch { /* sem cobranças */ }
    try { out.minhas = await empresas.minhasBitrix(); } catch { /* sem minhas empresas */ }
    return out;
  });
  on('POST', '/empresas/importar-bitrix', async () => empresas.importarMinhas());
  // empresas
  on('GET', '/empresas', async () => empresas.list());
  on('POST', '/empresas', async (_, __, b) => { const e = empresas.add(b); store.log('empresa', `Empresa cadastrada: ${e.nome}`); return e; });
  on('POST', '/empresas/sincronizar-campo', async () => empresas.sincronizarCampo());
  on('PUT', '/empresas/([\\w-]+)', async ([id], _, b) => empresas.update(id, b));
  on('DELETE', '/empresas/([\\w-]+)', async ([id]) => { empresas.remove(id); return { ok: true }; });
  on('PUT', '/empresas/([\\w-]+)/asaas', async ([id], _, b) => { const e = empresas.setAsaas(id, b); store.log('config', `Chave Asaas da empresa ${e.nome} atualizada (${e.asaas.env})`); return e; });
  on('DELETE', '/empresas/([\\w-]+)/asaas', async ([id]) => empresas.removeAsaas(id));
  on('POST', '/empresas/([\\w-]+)/asaas/test', async ([id]) => empresas.testAsaas(id));
  // configuração
  on('PUT', '/config', async (_, __, b) => {
    const p = {};
    if (typeof b.folhaAuto === 'boolean') p.folhaAuto = b.folhaAuto;
    if (typeof b.contratoCampoVenc === 'string') need(/^(|UF_CRM_[A-Z0-9_]+|CLOSEDATE|BEGINDATE)$/.test(b.contratoCampoVenc), 'Campo inválido.'), p.contratoCampoVenc = b.contratoCampoVenc;
    if (Array.isArray(b.contratoEtapasAtivas)) p.contratoEtapasAtivas = b.contratoEtapasAtivas.map(String).filter(s => /^[\w:]+$/.test(s)).slice(0, 50);
    if (Array.isArray(b.marcosAviso)) p.marcosAviso = [...new Set(b.marcosAviso.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b2) => b2 - a).slice(0, 10);
    if (b.saldoInicial && typeof b.saldoInicial === 'object') p.saldoInicial = Object.fromEntries(Object.entries(b.saldoInicial).filter(([k]) => empresas.get(k)).map(([k, v]) => [k, F.round2(Number(v) || 0)]));
    cc.at = 0;
    return fin.setConfig(p);
  });
  // painel e caixa
  on('GET', '/resumo', async (_, u) => {
    const { rec, pag, func, e } = await ctx(u);
    let ct = []; if (bitrix.enabled) { try { ct = await contratos({ empresaId: e }); } catch { /* sem contratos */ } }
    const r = F.resumo({ receber: rec, pagar: pag, funcionarios: func, contratos: ct, empresaId: e, hoje: hoje(), saldoInicial: saldoInicial(e, R.addMonths(hoje().slice(0, 7) + '-01', 0)) });
    const orc = X.orcamentoMes({ orcamentos: fin.orcamentos.all(), receber: rec, pagar: pag, empresaId: e, mes: hoje().slice(0, 7) }).linhas.filter(l => l.tipo === 'despesa' && l.status === 'estourado');
    if (orc.length) r.alertas.push({ sev: 'media', msg: `${orc.length} categoria(s) de despesa acima do orçamento este mês: ${orc.slice(0, 3).map(l => l.categoria).join(', ')}` });
    r.recorrencias = fin.recorrencias.all().filter(x => x.ativa && (!e || x.empresaId === e)).length;
    return r;
  });
  on('GET', '/caixa', async (_, u) => {
    let { rec, pag, e } = await ctx(u); const cid = u.searchParams.get('conta') || '', atras = Number(u.searchParams.get('atras') ?? 2);
    if (cid) {
      const conta = fin.contas.get(cid); need(conta, 'Conta não encontrada.');
      rec = rec.filter(r => r.contaId === cid); pag = pag.filter(c => c.contaId === cid);
      return F.fluxoCaixa({ receber: rec, pagar: pag, hoje: hoje(), saldoInicial: C.saldoAntes(conta, dadosContas(), R.addMonths(hoje().slice(0, 7) + '-01', -atras)), mesesAtras: atras, mesesFrente: Number(u.searchParams.get('frente') ?? 6) });
    }
    return F.fluxoCaixa({ receber: rec, pagar: pag, empresaId: e, hoje: hoje(), saldoInicial: saldoInicial(e, R.addMonths(hoje().slice(0, 7) + '-01', -Number(u.searchParams.get('atras') ?? 2))), mesesAtras: Number(u.searchParams.get('atras') ?? 2), mesesFrente: Number(u.searchParams.get('frente') ?? 6) });
  });
  // receber
  on('GET', '/receber', async (_, u) => { const { rec, e } = await ctx(u); return F.pick(rec, e).map(r => ({ ...r, status: F.statusReceber(r, hoje()), empresa: empresas.get(r.empresaId)?.nome || '' })).sort((a, b) => (a.venc || '').localeCompare(b.venc || '')); });
  const lctx = () => ({ formas: fin.formas.all(), condicoes: fin.condicoes.all(), hoje: hoje() });
  const contaOk = (id, empresaId) => { if (!id) return; const c = fin.contas.get(id); need(c && c.empresaId === empresaId, 'A conta bancária escolhida não pertence a esta empresa.'); };
  on('POST', '/parcelas/preview', async (_, __, b) => {
    const cond = fin.condicoes.get(b.condicaoId);
    return C.planejarParcelas({ total: b.valor, modo: b.modo, parcelas: b.parcelas, dias: cond ? cond.dias : b.dias, base: b.base || b.venc || hoje(), venc: b.venc, util: !!b.util });
  });
  on('POST', '/receber', async (_, __, b) => {
    empresaOk(String(b.empresaId || '')); contaOk(b.contaId, String(b.empresaId));
    const l = C.criarLancamentos(b, 'receber', lctx()); fin.receber.add(l);
    store.log('receber', `${l.length} recebimento(s) lançado(s): ${l[0].descricao}`); return l;
  });
  on('PUT', '/receber/([\\w-]+)', async ([id], _, b) => { const r = fin.receber.get(id); if (!r) throw notFound('Recebimento'); return fin.receber.put(editarLanc(r, b, 'receber')); });
  on('POST', '/receber/([\\w-]+)/baixar', async ([id], _, b) => {
    const r = fin.receber.get(id); if (!r) throw notFound('Recebimento'); contaOk(b.contaId, r.empresaId);
    const { pago, saldo } = C.baixarLancamento(r, b, hoje()); fin.receber.put(pago); if (saldo) fin.receber.add(saldo);
    store.log('receber', `Recebimento baixado: ${r.descricao}${saldo ? ' (parcial, saldo ' + saldo.valor + ')' : ''}`); return { pago, saldo };
  });
  on('POST', '/receber/([\\w-]+)/cancelar', async ([id]) => { const r = fin.receber.get(id); if (!r) throw notFound('Recebimento'); need(r.status !== 'pago', 'Recebimento já baixado.'); return fin.receber.put({ ...r, status: 'cancelado' }); });
  on('DELETE', '/receber/([\\w-]+)', async ([id]) => { need(fin.receber.get(id), 'Recebimento não encontrado.'); fin.receber.remove(id); return { ok: true }; });
  // pagar
  on('GET', '/pagar', async (_, u) => {
    const e = scope(u), st = u.searchParams.get('status');
    return F.pick(fin.pagar.all(), e).map(c => ({ ...c, situacao: F.statusConta(c, hoje()), empresa: empresas.get(c.empresaId)?.nome || '' }))
      .filter(c => !st || c.situacao === st).sort((a, b) => a.venc.localeCompare(b.venc));
  });
  on('POST', '/pagar', async (_, __, b) => {
    empresaOk(String(b.empresaId || '')); contaOk(b.contaId, String(b.empresaId));
    const l = C.criarLancamentos(b, 'pagar', lctx()); fin.pagar.add(l);
    store.log('pagar', `${l.length} conta(s) a pagar criada(s): ${l[0].descricao}`); return l;
  });
  // edição de um lançamento em aberto (título, anotações, vencimento, valor, categoria, forma, conta...)
  function editarLanc(c, b, tipo) {
    need(c.status === 'aberta' || c.status === 'aberto', 'Só lançamentos em aberto podem ser editados.');
    const titulo = String(b.descricao ?? c.descricao).trim(); need(titulo.length >= 2 && titulo.length <= 200, 'O título precisa ter de 2 a 200 caracteres.');
    const valor = b.valor === undefined || b.valor === '' ? c.valor : Number(b.valor); need(valor > 0, 'Valor inválido.');
    const venc = b.venc || c.venc; need(F.isDay(venc), 'Vencimento inválido.');
    contaOk(b.contaId, c.empresaId);
    const forma = fin.formas.get(b.formaId ?? c.formaId) || null;
    const out = { ...c, descricao: titulo, obs: String(b.obs ?? c.obs ?? '').slice(0, 500), parcelaTitulo: String(b.parcelaTitulo ?? c.parcelaTitulo ?? '').slice(0, 200), parcelaObs: String(b.parcelaObs ?? c.parcelaObs ?? '').slice(0, 500),
      valor: F.round2(valor), venc, categoria: String(b.categoria ?? c.categoria ?? '').slice(0, 60), centro: String(b.centro ?? c.centro ?? '').slice(0, 60), contatoId: String(b.contatoId ?? c.contatoId ?? ''),
      contaId: String(b.contaId ?? c.contaId ?? ''), formaId: forma ? forma.id : '', forma: forma ? forma.tipo : (F.FORMAS_PAG.includes(b.forma) ? b.forma : c.forma) };
    if (tipo === 'pagar') Object.assign(out, { fornecedor: String(b.fornecedor ?? c.fornecedor ?? '').slice(0, 120), codigoBarras: String(b.codigoBarras ?? c.codigoBarras ?? '').slice(0, 120), chavePix: String(b.chavePix ?? c.chavePix ?? '').slice(0, 120) });
    else { const taxa = C.taxaForma(out.valor, forma); Object.assign(out, { cliente: String(b.cliente ?? c.cliente ?? '').slice(0, 120), taxa, valorLiquido: F.round2(out.valor - taxa), credito: C.creditoEm(venc, forma) }); }
    return out;
  }
  on('PUT', '/pagar/([\\w-]+)', async ([id], _, b) => { const c = fin.pagar.get(id); if (!c) throw notFound('Conta'); return fin.pagar.put(editarLanc(c, b, 'pagar')); });
  on('POST', '/pagar/([\\w-]+)/baixar', async ([id], _, b) => {
    const c = fin.pagar.get(id); if (!c) throw notFound('Conta'); contaOk(b.contaId, c.empresaId);
    const { pago, saldo } = C.baixarLancamento(c, b, hoje()); fin.pagar.put(pago); if (saldo) fin.pagar.add(saldo);
    store.log('pagar', `Conta paga: ${c.descricao}${saldo ? ' (parcial, saldo ' + saldo.valor + ')' : ''}`); return { pago, saldo };
  });
  on('POST', '/pagar/([\\w-]+)/cancelar', async ([id]) => { const c = fin.pagar.get(id); if (!c) throw notFound('Conta'); need(c.status !== 'paga', 'Conta já paga.'); return fin.pagar.put({ ...c, status: 'cancelada' }); });
  on('POST', '/pagar/([\\w-]+)/asaas', async ([id], _, b) => {
    const c = fin.pagar.get(id); if (!c) throw notFound('Conta');
    const r = await pagarPeloAsaas(c, b);
    fin.pagar.put({ ...c, asaasPagamento: r.asaasId, obs: `${c.obs || ''} Pagamento enviado ao Asaas (${r.asaasId}).`.trim().slice(0, 500) });
    store.log('pagar', `Pagamento enviado ao Asaas: ${c.descricao} (${r.asaasId})`); return r;
  });
  // funcionários e folha
  on('GET', '/funcionarios', async (_, u) => F.pick(fin.funcionarios.all(), scope(u)).map(f => ({ ...f, custoTotal: F.custoTotal(f), liquido: F.liquido(f), empresa: empresas.get(f.empresaId)?.nome || '' })));
  on('POST', '/funcionarios', async (_, __, b) => { empresaOk(String(b.empresaId || '')); const f = { id: F.uid('fn'), ...F.validarFuncionario(b) }; fin.funcionarios.add(f); return f; });
  on('PUT', '/funcionarios/([\\w-]+)', async ([id], _, b) => { const a = fin.funcionarios.get(id); if (!a) throw notFound('Funcionário'); return fin.funcionarios.put({ id, ...F.validarFuncionario({ ...a, ...b }) }); });
  on('DELETE', '/funcionarios/([\\w-]+)', async ([id]) => { const a = fin.funcionarios.get(id); if (!a) throw notFound('Funcionário'); fin.funcionarios.put({ ...a, ativo: false, desligamento: a.desligamento || hoje() }); return { ok: true, inativado: true }; });
  on('GET', '/folha', async (_, u) => {
    const e = scope(u), comp = u.searchParams.get('competencia') || hoje().slice(0, 7);
    need(F.isCompetencia(comp), 'Competência inválida.');
    const ids = e ? [e] : empresas.list().map(x => x.id);
    return { competencia: comp, empresas: ids.map(id => ({ empresaId: id, empresa: empresas.get(id)?.nome, gerada: fin.folhaGerada(id, comp), funcionarios: fin.funcionarios.all().filter(f => f.empresaId === id && F.naFolha(f, comp)).length, custo: F.round2(fin.funcionarios.all().filter(f => f.empresaId === id && F.naFolha(f, comp)).reduce((a, f) => a + F.custoTotal(f), 0)) })) };
  });
  on('POST', '/folha/gerar', async (_, __, b) => { empresaOk(String(b.empresaId || '')); return gerarFolhaEmpresa(String(b.empresaId), b.competencia); });
  // relatórios
  on('GET', '/relatorio', async (_, u) => {
    const { rec, pag, func, e } = await ctx(u);
    if (u.searchParams.get('tipo') === 'dre') {
      const d = C.dre({ receber: rec, pagar: pag, empresaId: e, de: u.searchParams.get('de') || '', ate: u.searchParams.get('ate') || '', regime: u.searchParams.get('regime') === 'competencia' ? 'competencia' : 'caixa' });
      const rel = { titulo: `DRE — regime de ${d.regime === 'caixa' ? 'caixa' : 'competência'}`, dre: d, colunas: ['Grupo', 'Categoria', 'Valor'],
        linhas: [...d.receitas.map(x => ['Receitas', x.categoria, x.valor]), ['Receitas', 'TOTAL DE RECEITAS', d.totalReceitas], ...d.despesas.map(x => ['Despesas', x.categoria, -x.valor]), ['Despesas', 'TOTAL DE DESPESAS', -d.totalDespesas], ['Resultado', 'RESULTADO DO PERÍODO', d.resultado]], total: d.resultado, totalLabel: `Resultado (margem ${d.margemPct}%)` };
      return u.searchParams.get('formato') === 'csv' ? { __csv: F.csv(rel), nome: `dre-${hoje()}.csv` } : rel;
    }
    const rel = F.relatorio({ tipo: u.searchParams.get('tipo'), receber: rec, pagar: pag, funcionarios: func, empresaId: e, de: u.searchParams.get('de') || '', ate: u.searchParams.get('ate') || '', hoje: hoje() });
    return u.searchParams.get('formato') === 'csv' ? { __csv: F.csv(rel), nome: `${u.searchParams.get('tipo')}-${hoje()}.csv` } : rel;
  });
  // contratos
  on('GET', '/contratos', async (_, u) => contratos({ empresaId: scope(u), todos: u.searchParams.get('todos') === '1' }));
  on('GET', '/contratos/campos', async () => {
    const [f, l] = await Promise.all([bitrix.call('crm.deal.userfield.list', {}), loadContratos(true)]);
    return { campos: (f.result || []).filter(x => ['date', 'datetime'].includes(x.USER_TYPE_ID)).map(x => ({ campo: x.FIELD_NAME, nome: x.EDIT_FORM_LABEL?.br || x.EDIT_FORM_LABEL || x.FIELD_NAME })), etapas: l.stages };
  });
  on('POST', '/contratos/avisar', async (_, __, b) => avisarContratos({ simular: !!b.simular }));
  on('GET', '/contratos/(\\d+)', async ([id]) => contratoDaDeal(id));


  // ---------- conciliação bancária (extrato OFX) ----------
  const linhaOk = id => { const l = fin.extratos.get(id); if (!l) throw notFound('Linha do extrato'); return l; };
  const tabela = tipo => (tipo === 'pagar' ? fin.pagar : tipo === 'nota' ? fin.notas : fin.receber);
  function aplicar(linha, lanc, tipo, modo) {
    need(linha.status === 'pendente', 'Esta linha do extrato já foi tratada.');
    const conta = fin.contas.get(linha.contaId);
    need(lanc.empresaId === conta.empresaId, 'O lançamento é de outra empresa.');
    need((linha.valor > 0) === (tipo === 'receber'), tipo === 'receber' ? 'Entrada do banco só concilia com conta a receber.' : 'Saída do banco só concilia com conta a pagar.');
    const { pago, saldo } = C.baixarLancamento(lanc, X.baixaPorExtrato(lanc, linha, { modo }), hoje());
    tabela(tipo).put(pago); if (saldo) tabela(tipo).add(saldo);
    return fin.extratos.put({ ...linha, status: 'conciliado', ref: { tipo, id: lanc.id, antes: lanc, saldoId: saldo ? saldo.id : '', criada: false }, conciliadoEm: hoje() });
  }
  const dadosSug = () => ({ pagar: fin.pagar.all(), receber: fin.receber.all() });
  const comSug = l => ({ ...l, ref: l.ref ? { tipo: l.ref.tipo, id: l.ref.id, criada: l.ref.criada } : null, sugestoes: l.status === 'pendente' ? X.sugestoes(l, fin.contas.get(l.contaId), dadosSug()) : [] });
  on('POST', '/conciliacao/importar', async (_, __, b) => {
    const conta = fin.contas.get(String(b.contaId || '')); need(conta, 'Escolha a conta bancária do extrato.');
    const parsed = parseOfx(b.ofx);
    const { novas, repetidas } = X.novasLinhas(parsed, conta.id, fin.extratos.all(), hoje());
    let anteriores = 0;
    for (const l of novas) if (l.data < conta.dataSaldo) { l.status = 'ignorado'; l.motivo = 'Anterior ao saldo inicial da conta'; anteriores++; }
    fin.extratos.add(novas);
    if (parsed.saldoFinal !== null && !Number.isNaN(parsed.saldoFinal)) fin.contas.put({ ...conta, saldoExtrato: parsed.saldoFinal, saldoExtratoEm: parsed.saldoEm });
    const dg = v => R.digits(v).replace(/^0+/, ''), pa = dg(parsed.conta), ca = dg(conta.numero);
    const aviso = pa && ca && !(pa.endsWith(ca) || ca.endsWith(pa)) ? `O número da conta no arquivo OFX (${parsed.conta}) é diferente da conta escolhida (${conta.numero}). Confira se escolheu a conta certa.` : '';
    store.log('conciliacao', `Extrato importado em ${conta.nome}: ${novas.length} nova(s), ${repetidas} repetida(s)`);
    return { novas: novas.length, repetidas, anteriores, periodo: [parsed.inicio, parsed.fim], saldoExtrato: parsed.saldoFinal, aviso };
  });
  on('GET', '/conciliacao', async (_, u) => {
    const e = scope(u), conta = u.searchParams.get('conta') || '', st = u.searchParams.get('status') || 'pendente';
    const l = fin.extratos.all().filter(x => (!conta || x.contaId === conta) && (!e || fin.contas.get(x.contaId)?.empresaId === e) && (st === 'todos' || x.status === st)).sort((a, b) => b.data.localeCompare(a.data));
    const cont = fin.extratos.all().filter(x => (!conta || x.contaId === conta) && (!e || fin.contas.get(x.contaId)?.empresaId === e)).reduce((a, x) => ({ ...a, [x.status]: (a[x.status] || 0) + 1 }), {});
    return { linhas: l.slice(0, 300).map(comSug), total: l.length, contadores: cont };
  });
  on('POST', '/conciliacao/auto', async (_, __, b) => {
    let n = 0;
    for (const l of fin.extratos.all().filter(x => x.status === 'pendente' && (!b.contaId || x.contaId === b.contaId))) {
      const s = X.sugestoes(l, fin.contas.get(l.contaId), dadosSug(), 2);
      if (s.length && X.forte(s[0]) && !(s[1] && X.forte(s[1]))) { try { aplicar(l, tabela(s[0].tipo).get(s[0].id), s[0].tipo, 'parcial'); n++; } catch { /* segue para a próxima */ } }
    }
    store.log('conciliacao', `Conciliação automática: ${n} linha(s)`); return { conciliadas: n };
  });
  on('POST', '/conciliacao/([\\w-]+)/conciliar', async ([id], _, b) => {
    const l = linhaOk(id), tipo = l.valor > 0 ? 'receber' : 'pagar', lanc = tabela(tipo).get(String(b.lancId || ''));
    need(lanc, 'Escolha o lançamento a conciliar.'); return comSug(aplicar(l, lanc, tipo, b.modo === 'desconto' ? 'desconto' : 'parcial'));
  });
  on('POST', '/conciliacao/([\\w-]+)/criar', async ([id], _, b) => {
    const l = linhaOk(id); need(l.status === 'pendente', 'Esta linha do extrato já foi tratada.');
    const conta = fin.contas.get(l.contaId), tipo = l.valor > 0 ? 'receber' : 'pagar', abs = F.round2(Math.abs(l.valor));
    const [novo] = C.criarLancamentos({ empresaId: conta.empresaId, descricao: b.descricao || l.descricao, categoria: b.categoria, centro: b.centro, contaId: conta.id, valor: abs, venc: l.data, forma: 'TRANSFERENCIA', [tipo === 'pagar' ? 'fornecedor' : 'cliente']: b.contra || '', obs: `Criado a partir do extrato: ${l.descricao}`.slice(0, 500) }, tipo, lctx());
    const { pago } = C.baixarLancamento(novo, { data: l.data, contaId: conta.id, valor: abs, obs: 'Criado pela conciliação' }, hoje());
    tabela(tipo).add(pago);
    return comSug(fin.extratos.put({ ...l, status: 'conciliado', ref: { tipo, id: pago.id, criada: true }, conciliadoEm: hoje() }));
  });
  on('POST', '/conciliacao/([\\w-]+)/ignorar', async ([id]) => { const l = linhaOk(id); need(l.status === 'pendente', 'Esta linha do extrato já foi tratada.'); return comSug(fin.extratos.put({ ...l, status: 'ignorado', motivo: 'Ignorado manualmente' })); });
  on('POST', '/conciliacao/([\\w-]+)/desfazer', async ([id]) => {
    const l = linhaOk(id);
    if (l.status === 'ignorado') return comSug(fin.extratos.put({ ...l, status: 'pendente', motivo: '' }));
    need(l.status === 'conciliado' && l.ref, 'Nada para desfazer.');
    const t = tabela(l.ref.tipo);
    if (l.ref.criada) t.remove(l.ref.id);
    else {
      if (l.ref.saldoId) { const sd = t.get(l.ref.saldoId); need(!sd || sd.status === 'aberta' || sd.status === 'aberto', 'O saldo restante já foi baixado: desfaça aquela baixa primeiro.'); if (sd) t.remove(sd.id); }
      t.put(l.ref.antes);
    }
    return comSug(fin.extratos.put({ ...l, status: 'pendente', ref: null, conciliadoEm: '' }));
  });

  // ---------- recorrências (contas fixas sem data final) ----------
  const recCtx = () => lctx();
  function gerarRecorrenciasAgora() {
    const novos = X.gerarRecorrentes({ recorrencias: fin.recorrencias.all(), existentes: [...fin.pagar.all(), ...fin.receber.all()], hoje: hoje(), ctx: recCtx() });
    const pg = novos.filter(x => x.tipo === 'pagar'), rc = novos.filter(x => x.tipo === 'receber');
    if (pg.length) fin.pagar.add(pg); if (rc.length) fin.receber.add(rc);
    return novos.length;
  }
  on('GET', '/recorrencias', async (_, u) => F.pick(fin.recorrencias.all(), scope(u)).map(r => ({ ...r, empresa: empresas.get(r.empresaId)?.nome || '', geradas: [...fin.pagar.all(), ...fin.receber.all()].filter(x => x.recId === r.id).length })));
  on('POST', '/recorrencias', async (_, __, b) => {
    empresaOk(String(b.empresaId || '')); contaOk(b.modelo?.contaId, String(b.empresaId));
    const v = X.validarRecorrencia(b, hoje());
    C.criarLancamentos({ ...v.modelo, empresaId: v.empresaId, venc: v.inicio, parcelas: 1 }, v.tipo, recCtx());   // valida o modelo
    const r = { id: F.uid('rec'), ...v }; fin.recorrencias.add(r);
    store.log('recorrencia', `Recorrência criada: ${v.modelo.descricao}`); return { ...r, geradas: gerarRecorrenciasAgora() };
  });
  on('PUT', '/recorrencias/([\\w-]+)', async ([id], _, b) => {
    const r = fin.recorrencias.get(id); if (!r) throw notFound('Recorrência');
    const modelo = { ...r.modelo, ...(b.valor !== undefined ? { valor: b.valor } : {}), ...(b.descricao ? { descricao: b.descricao } : {}) };
    const v = X.validarRecorrencia({ ...r, ativa: b.ativa ?? r.ativa, fim: b.fim ?? r.fim, modelo }, hoje());
    fin.recorrencias.put({ id, ...v });
    let ajustadas = 0;
    if (b.aplicarFuturos && b.valor !== undefined) for (const t of [fin.pagar, fin.receber]) for (const x of t.all().filter(y => y.recId === id && (y.status === 'aberta' || y.status === 'aberto') && y.venc >= hoje())) { t.put({ ...x, valor: v.modelo.valor, descricao: v.modelo.descricao }); ajustadas++; }
    return { ok: true, ajustadas, geradas: gerarRecorrenciasAgora() };
  });
  on('DELETE', '/recorrencias/([\\w-]+)', async ([id]) => {
    need(fin.recorrencias.get(id), 'Recorrência não encontrada.'); let removidas = 0;
    for (const t of [fin.pagar, fin.receber]) for (const x of t.all().filter(y => y.recId === id && (y.status === 'aberta' || y.status === 'aberto') && y.venc > hoje())) { t.remove(x.id); removidas++; }
    fin.recorrencias.remove(id); return { ok: true, removidas };
  });

  // ---------- orçamento por categoria ----------
  on('GET', '/orcamento', async (_, u) => {
    const mes = u.searchParams.get('mes') || hoje().slice(0, 7); need(F.isCompetencia(mes), 'Mês inválido.');
    const { rec, pag, e } = await ctx(u);
    return { ...X.orcamentoMes({ orcamentos: fin.orcamentos.all(), receber: rec, pagar: pag, empresaId: e, mes }), definidos: fin.orcamentos.all().filter(o => !e || o.empresaId === e) };
  });
  on('PUT', '/orcamento', async (_, __, b) => {
    const v = X.validarOrcamento(b, fin.empresas.all()), ja = fin.orcamentos.all().find(o => o.empresaId === v.empresaId && o.tipo === v.tipo && o.categoria === v.categoria && o.mes === v.mes);
    return ja ? fin.orcamentos.put({ id: ja.id, ...v }) : (fin.orcamentos.add({ id: F.uid('orc'), ...v }), v);
  });
  on('DELETE', '/orcamento/([\\w-]+)', async ([id]) => { need(fin.orcamentos.get(id), 'Orçamento não encontrado.'); fin.orcamentos.remove(id); return { ok: true }; });

  // ---------- fluxo de caixa por conta ----------
  on('GET', '/caixa/contas', async (_, u) => {
    const e = scope(u), d = dadosContas(), lim = C.addDias(hoje(), 30);
    return contasDe(e).map(c => {
      const rec = fin.receber.all().filter(r => r.contaId === c.id && r.status === 'aberto' && (r.credito || r.venc) <= lim), pag = fin.pagar.all().filter(p => p.contaId === c.id && p.status === 'aberta' && p.venc <= lim);
      const saldo = C.saldoConta(c, d, hoje()), ent = F.round2(rec.reduce((a, r) => a + (r.valorLiquido ?? r.valor), 0)), sai = F.round2(pag.reduce((a, p) => a + p.valor, 0));
      return { id: c.id, nome: c.nome, empresa: empresas.get(c.empresaId)?.nome || '', saldo, entradas30: ent, saidas30: sai, projetado30: F.round2(saldo + ent - sai) };
    });
  });

  // ---------- anexos (boleto, nota fiscal, comprovante) ----------
  const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', ofx: 'text/plain', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  const ANEXO_MAX = 8 * 1024 * 1024, anexoDir = () => { const d = path.join(dataDir || path.join(__dirname, '..', 'data'), 'anexos'); fs.mkdirSync(d, { recursive: true }); return d; };
  const achaAnexo = id => { for (const t of [fin.pagar, fin.receber]) for (const l of t.all()) { const a = (l.anexos || []).find(x => x.id === id); if (a) return { t, l, a }; } return null; };
  on('POST', '/anexos', async (_, __, b) => {
    const t = tabela(['pagar', 'nota'].includes(b.tipo) ? b.tipo : 'receber'), l = t.get(String(b.lancId || '')); need(l, 'Lançamento não encontrado.');
    const nome = path.basename(String(b.nome || 'arquivo')).replace(/[^\p{L}\p{N}._\- ()]/gu, '_').slice(0, 120), ext = (nome.split('.').pop() || '').toLowerCase();
    need(MIME[ext], 'Tipo de arquivo não permitido. Use PDF, imagem (PNG/JPG), XML, planilha, Word, CSV ou TXT.');
    const dados = Buffer.from(String(b.base64 || ''), 'base64'); need(dados.length > 0, 'Arquivo vazio.'); need(dados.length <= ANEXO_MAX, 'O arquivo passa de 8 MB.');
    need((l.anexos || []).length < 10, 'No máximo 10 anexos por lançamento.');
    const id = 'ax_' + crypto.randomBytes(9).toString('hex');
    fs.writeFileSync(path.join(anexoDir(), id), dados);
    const meta = { id, nome, ext, tamanho: dados.length, em: new Date().toISOString() };
    t.put({ ...l, anexos: [...(l.anexos || []), meta] }); store.log('anexo', `Anexo ${nome} em ${l.descricao}`); return meta;
  });
  on('GET', '/anexos/(ax_[0-9a-f]+)', async ([id]) => {
    const f = achaAnexo(id); if (!f) throw notFound('Anexo');
    return { __file: { nome: f.a.nome, mime: MIME[f.a.ext] || 'application/octet-stream', dados: fs.readFileSync(path.join(anexoDir(), id)) } };
  });
  on('DELETE', '/anexos/(ax_[0-9a-f]+)', async ([id]) => {
    const f = achaAnexo(id); if (!f) throw notFound('Anexo');
    f.t.put({ ...f.l, anexos: f.l.anexos.filter(x => x.id !== id) }); try { fs.unlinkSync(path.join(anexoDir(), id)); } catch { /* já removido */ } return { ok: true };
  });


  // ---------- NF-e de entrada: lê o XML, lança os títulos a pagar e dá entrada no estoque ----------
  const digitos = v => R.digits(v);
  const fornecedorDoXml = nf => fin.fornecedores.all().find(f => f.doc && f.doc === nf.fornecedor.doc) || null;
  on('POST', '/nfe/previa', async (_, __, b) => {
    const nf = parseNfe(b.xml);
    const dupl = nf.chave ? fin.notas.all().find(n => n.chave === nf.chave && n.status !== 'cancelada') : null;
    const emp = empresas.list().find(e => nf.destinatario.doc && digitos(e.cnpj) === nf.destinatario.doc && e.ativa) || null;
    const empresaId = emp ? emp.id : (b.empresaId || '');
    const f = fornecedorDoXml(nf);
    return { nota: nf, duplicada: dupl ? { id: dupl.id, numero: dupl.numero, entradaEm: dupl.entradaEm } : null, empresaSugerida: emp ? emp.id : '', destinatarioConhecido: !!emp,
      fornecedorId: f ? f.id : '', produtos: S.sugerirProdutos(nf, fin.produtos.all(), empresaId), formaSugerida: nf.formaSugerida };
  });
  on('POST', '/nfe/importar', async (_, __, b) => {
    const nf = parseNfe(b.xml), empresaId = String(b.empresaId || ''); empresaOk(empresaId);
    const emp = empresas.get(empresaId); contaOk(b.contaId, empresaId);
    const dupl = nf.chave ? fin.notas.all().find(n => n.chave === nf.chave && n.status !== 'cancelada') : null;
    need(!dupl, `Esta nota já foi importada (nº ${dupl && dupl.numero}, entrada em ${dupl && dupl.entradaEm.split('-').reverse().join('/')}).`);
    if (nf.destinatario.doc && digitos(emp.cnpj) && nf.destinatario.doc !== digitos(emp.cnpj) && !b.ignorarDestinatario) throw F.bad(`O destinatário da nota (${nf.destinatario.doc}) não é o CNPJ da empresa escolhida (${digitos(emp.cnpj)}). Escolha a empresa certa ou marque “Importar mesmo assim”.`);
    const entradaEm = b.entradaEm || hoje();
    // 1) estoque (valida tudo antes de gravar qualquer coisa)
    const ent = S.montarEntrada({ nota: nf, empresaId, entradaEm, escolhas: Array.isArray(b.itens) ? b.itens : [], produtos: fin.produtos.all(), darEntrada: b.darEntradaEstoque !== false, hoje: hoje() });
    // 2) títulos a pagar
    const T = b.titulos || {}, modo = T.modo || (nf.duplicatas.length ? 'duplicatas' : 'condicao');
    let linhas = [];
    if (modo === 'duplicatas') linhas = (Array.isArray(T.manual) && T.manual.length ? T.manual : nf.duplicatas).map((d, i) => ({ venc: d.venc, valor: d.valor, descricao: d.descricao || `Duplicata ${d.numero || String(i + 1).padStart(3, '0')}`, obs: d.obs || '' }));
    else if (modo === 'condicao') linhas = C.planejarParcelas({ total: nf.totais.total, dias: (fin.condicoes.get(T.condicaoId) || { dias: [0] }).dias, base: T.base || entradaEm, util: !!T.util });
    need(modo === 'nenhum' || linhas.length, 'Não há títulos para lançar. Escolha “não lançar títulos” ou informe as parcelas.');
    const fo = fornecedorDoXml(nf), nomeForn = nf.fornecedor.nome.slice(0, 120);
    const contaForn = fo || { id: F.uid('for'), nome: nomeForn, doc: nf.fornecedor.doc, email: nf.fornecedor.email, telefone: nf.fornecedor.telefone.slice(0, 30), chavePix: '', obs: `Criado pela NF-e ${nf.numero}`, ativa: true };
    const notaId = F.uid('nf');
    const titulos = modo === 'nenhum' ? [] : C.criarLancamentos({ empresaId, descricao: `NF-e ${nf.numero}${nf.serie ? '/' + nf.serie : ''} — ${nomeForn}`.slice(0, 200), obs: `Chave: ${nf.chave || '—'}${b.obs ? '\n' + b.obs : ''}`.slice(0, 500), fornecedor: nomeForn, contatoId: contaForn.id,
      categoria: b.categoria || '', centro: b.centro || '', formaId: b.formaId || '', forma: nf.formaSugerida, contaId: b.contaId || '', valor: F.round2(linhas.reduce((a, l) => a + l.valor, 0)), manual: linhas }, 'pagar', lctx()).map(t => ({ ...t, notaId }));
    // 3) tudo validado: grava
    if (!fo) fin.fornecedores.add(contaForn);
    for (const p of ent.novos) fin.produtos.add(p);
    for (const it of ent.itens) { const p = it.produtoId && fin.produtos.get(it.produtoId); const v = p && S.vincular(p, nf.fornecedor.doc, it.cProd); if (v) fin.produtos.put(v); }
    for (const m of ent.movs) fin.movimentos.add({ ...m, notaId });
    if (titulos.length) fin.pagar.add(titulos);
    const nota = { id: notaId, empresaId, chave: nf.chave, numero: nf.numero, serie: nf.serie, emissao: nf.emissao, entradaEm, natOp: nf.natOp, fornecedorId: contaForn.id, fornecedorNome: nomeForn, fornecedorDoc: nf.fornecedor.doc, totais: nf.totais, itens: ent.itens,
      titulos: titulos.map(t => t.id), status: 'lancada', estoque: ent.movs.length > 0, obs: String(b.obs || '').slice(0, 500), avisos: nf.avisos, criado: hoje(), anexos: [] };
    const axId = 'ax_' + crypto.randomBytes(9).toString('hex'), dados = Buffer.from(String(b.xml), 'utf8');
    fs.writeFileSync(path.join(anexoDir(), axId), dados);
    nota.anexos.push({ id: axId, nome: `NFe-${nf.numero || nf.chave.slice(-9)}.xml`, ext: 'xml', tamanho: dados.length, em: new Date().toISOString() });
    fin.notas.add(nota);
    store.log('nfe', `NF-e ${nf.numero} de ${nomeForn} importada: ${titulos.length} título(s), ${ent.movs.length} item(ns) no estoque`);
    return { nota, titulos: titulos.length, produtosNovos: ent.novos.length, movimentos: ent.movs.length, fornecedorCriado: !fo };
  });
  const notaView = n => ({ ...n, empresa: empresas.get(n.empresaId)?.nome || '', titulosInfo: n.titulos.map(id => fin.pagar.get(id)).filter(Boolean).map(t => ({ id: t.id, venc: t.venc, valor: t.valor, status: F.statusConta(t, hoje()), descricao: t.descricao, parcela: t.parcela, parcelaTitulo: t.parcelaTitulo })) });
  on('GET', '/notas', async (_, u) => F.pick(fin.notas.all(), scope(u)).sort((a, b) => b.entradaEm.localeCompare(a.entradaEm) || b.criado.localeCompare(a.criado)).map(notaView));
  on('GET', '/notas/([\\w-]+)', async ([id]) => { const n = fin.notas.get(id); if (!n) throw notFound('Nota'); return notaView(n); });
  on('POST', '/notas/([\\w-]+)/cancelar', async ([id]) => {
    const n = fin.notas.get(id); if (!n) throw notFound('Nota');
    const tit = n.titulos.map(t => fin.pagar.get(t)).filter(Boolean);
    S.checarCancelamento(n, tit, fin.produtos.all(), fin.movimentos.all());
    for (const t of tit) if (t.status === 'aberta') fin.pagar.put({ ...t, status: 'cancelada' });
    for (const m of fin.movimentos.all().filter(x => x.notaId === id)) fin.movimentos.remove(m.id);
    store.log('nfe', `NF-e ${n.numero} cancelada`); return notaView(fin.notas.put({ ...n, status: 'cancelada', canceladaEm: hoje() }));
  });

  // ---------- estoque ----------
  on('GET', '/produtos', async (_, u) => { const e = scope(u); return S.comPosicao(F.pick(fin.produtos.all(), e), fin.movimentos.all()).map(p => ({ ...p, empresa: empresas.get(p.empresaId)?.nome || '' })).sort((a, b) => a.nome.localeCompare(b.nome)); });
  on('POST', '/produtos', async (_, __, b) => { empresaOk(String(b.empresaId || '')); const v = S.validarProduto(b); const p = { id: F.uid('pr'), ...v }; fin.produtos.add(p); return p; });
  on('PUT', '/produtos/([\\w-]+)', async ([id], _, b) => { const a = fin.produtos.get(id); if (!a) throw notFound('Produto'); return fin.produtos.put({ id, ...S.validarProduto({ ...a, ...b, empresaId: a.empresaId }) }); });
  on('GET', '/produtos/([\\w-]+)/movimentos', async ([id]) => {
    const p = fin.produtos.get(id); if (!p) throw notFound('Produto');
    return { produto: p, movimentos: S.posicao([p], fin.movimentos.all().filter(m => m.produtoId === id)).porProduto.get(id).movimentos.reverse() };
  });
  on('POST', '/estoque/movimento', async (_, __, b) => { const m = S.validarMovimento(b, fin.produtos.all(), fin.movimentos.all(), hoje()); fin.movimentos.add(m); store.log('estoque', `${m.tipo} ${m.qtd} em ${b.produtoId}`); return m; });

  return {
    avisarContratos, contratos, receber, folhaAuto, gerarFolhaEmpresa, gerarRecorrenciasAgora,
    async handle(method, pathname, u, readBody) {
      for (const [m, re, h] of routes) {
        const g = m === method && pathname.match(re);
        if (g) return { json: await h(g.slice(1), u, ['POST', 'PUT'].includes(method) ? await readBody() : {}) };
      }
      return null;
    },
  };
}
module.exports = { createFinApi, CAT_DEAL };
