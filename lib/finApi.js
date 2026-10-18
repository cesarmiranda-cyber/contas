'use strict';
const R = require('./rules');
const F = require('./fin');

const CAT_DEAL = 15;   // funil "Contratos" (Nutrimix)
const notFound = what => { const e = new Error(`${what} não encontrado.`); e.status = 404; return e; };

// Rotas /api/fin/*: empresas, contas a pagar/receber, folha, fluxo de caixa, relatórios e contratos (funil 15).
function createFinApi({ fin, empresas, svc, bitrix, asaas, store }) {
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
  const saldoInicial = empresaId => {
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
    let l = deals.filter(d => todos || etapaAtiva(d, stages)).map(d => F.contratoDeDeal(d, { campoVenc: fin.config.contratoCampoVenc, hoje: hoje(), empresaDe: d2 => empresas.empresaDe(d2) }));
    if (empresaId) l = l.filter(c => c.empresaId === empresaId);
    const nomes = await nomesEmpresasBitrix(l);
    return l.map(c => ({ ...c, cliente: nomes[c.companyId] || nomes[`p${c.contactId}`] || '' })).sort((a, b) => (a.venc || '9999').localeCompare(b.venc || '9999'));
  }
  async function nomesEmpresasBitrix(list) {
    const out = {}, ids = [...new Set(list.map(c => c.companyId).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 50) {
      try { for (const c of (await bitrix.call('crm.company.list', { filter: { ID: ids.slice(i, i + 50) }, select: ['ID', 'TITLE'] })).result || []) out[c.ID] = c.TITLE; } catch { /* sem nomes */ }
    }
    return out;
  }
  async function contratoDaDeal(dealId) {
    const all = await contratos({ todos: true });
    const c = all.find(x => x.id === +dealId);
    if (!c) throw notFound('Contrato');
    let cliente = { nome: c.cliente, doc: '', email: '', telefone: '' };
    try {
      if (c.companyId) {
        const e = (await bitrix.call('crm.company.get', { id: c.companyId })).result || {};
        cliente = { nome: e.TITLE || c.cliente, doc: R.findDoc(e, ['UF_CRM_CNPJ', 'UF_CRM_6675B86EE950A']), email: e.EMAIL?.[0]?.VALUE || '', telefone: e.PHONE?.[0]?.VALUE || '' };
      } else if (c.contactId) {
        const e = (await bitrix.call('crm.contact.get', { id: c.contactId })).result || {};
        cliente = { nome: [e.NAME, e.LAST_NAME].filter(Boolean).join(' '), doc: '', email: e.EMAIL?.[0]?.VALUE || '', telefone: e.PHONE?.[0]?.VALUE || '' };
      }
    } catch { /* cliente parcial */ }
    // só o financeiro deste cliente (mesma empresa/contato do contrato)
    const rec = (await receber()).filter(r => r.origem === 'bitrix');
    const deals = bitrix.enabled ? await svc.dealsCached() : [];
    const mine = deals.filter(d => !R.CONTRACT_STAGES.has(d.stageId) && ((c.companyId && String(d.companyId) === c.companyId) || (!c.companyId && c.contactId && String(d.contactId) === c.contactId)));
    const ids = new Set(mine.map(d => `deal_${d.id}`));
    const parcelas = rec.filter(r => ids.has(r.id)).map(r => F.statusReceber(r, hoje()) === r.status ? r : { ...r, status: F.statusReceber(r, hoje()) }).sort((a, b) => (a.venc || '').localeCompare(b.venc || ''));
    const abertas = parcelas.filter(p => p.status !== 'pago' && p.status !== 'cancelado');
    return {
      contrato: { ...c, empresa: empresas.get(c.empresaId)?.nome || '' }, cliente,
      financeiro: { parcelas, aberto: F.round2(abertas.reduce((a, p) => a + p.valor, 0)), atrasado: F.round2(parcelas.filter(p => p.status === 'atrasado').reduce((a, p) => a + p.valor, 0)), pago: F.round2(parcelas.filter(p => p.status === 'pago').reduce((a, p) => a + p.valor, 0)) },
      avisos: fin.avisos(String(c.id)),
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

  on('GET', '/bootstrap', async () => ({
    empresas: empresas.list(), config: fin.config, formas: F.FORMAS_PAG, categorias: F.CATEGORIAS_DESPESA, hoje: hoje(), campoEmpresa: empresas.FIELD,
    bitrix: bitrix.enabled, host: bitrix.enabled ? new URL(bitrix.base).host : '',
  }));
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
    return F.resumo({ receber: rec, pagar: pag, funcionarios: func, contratos: ct, empresaId: e, hoje: hoje(), saldoInicial: saldoInicial(e) });
  });
  on('GET', '/caixa', async (_, u) => { const { rec, pag, e } = await ctx(u); return F.fluxoCaixa({ receber: rec, pagar: pag, empresaId: e, hoje: hoje(), saldoInicial: saldoInicial(e), mesesAtras: Number(u.searchParams.get('atras') ?? 2), mesesFrente: Number(u.searchParams.get('frente') ?? 6) }); });
  // receber
  on('GET', '/receber', async (_, u) => { const { rec, e } = await ctx(u); return F.pick(rec, e).map(r => ({ ...r, status: F.statusReceber(r, hoje()), empresa: empresas.get(r.empresaId)?.nome || '' })).sort((a, b) => (a.venc || '').localeCompare(b.venc || '')); });
  on('POST', '/receber', async (_, __, b) => {
    empresaOk(String(b.empresaId || ''));
    const valor = Number(b.valor); need(valor > 0, 'Informe o valor.'); need(F.isDay(b.venc), 'Vencimento inválido.');
    const r = { id: F.uid('rc'), origem: 'manual', empresaId: String(b.empresaId), descricao: String(b.descricao || '').trim().slice(0, 200) || 'Recebimento', cliente: String(b.cliente || '').slice(0, 120), valor: F.round2(valor), venc: b.venc, status: 'aberto', pagoEm: '', forma: F.FORMAS_PAG.includes(b.forma) ? b.forma : '' };
    fin.receber.add(r); return r;
  });
  on('POST', '/receber/([\\w-]+)/baixar', async ([id], _, b) => {
    const r = fin.receber.get(id); if (!r) throw notFound('Recebimento');
    const dia = b.data || hoje(); need(F.isDay(dia) && dia <= hoje(), 'Data inválida.');
    return fin.receber.put({ ...r, status: 'pago', pagoEm: dia });
  });
  on('DELETE', '/receber/([\\w-]+)', async ([id]) => { need(fin.receber.get(id), 'Recebimento não encontrado.'); fin.receber.remove(id); return { ok: true }; });
  // pagar
  on('GET', '/pagar', async (_, u) => {
    const e = scope(u), st = u.searchParams.get('status');
    return F.pick(fin.pagar.all(), e).map(c => ({ ...c, situacao: F.statusConta(c, hoje()), empresa: empresas.get(c.empresaId)?.nome || '' }))
      .filter(c => !st || c.situacao === st).sort((a, b) => a.venc.localeCompare(b.venc));
  });
  on('POST', '/pagar', async (_, __, b) => { empresaOk(String(b.empresaId || '')); const l = F.criarContas(b, hoje()); fin.pagar.add(l); store.log('pagar', `${l.length} conta(s) a pagar criada(s): ${l[0].descricao}`); return l; });
  on('PUT', '/pagar/([\\w-]+)', async ([id], _, b) => {
    const c = fin.pagar.get(id); if (!c) throw notFound('Conta');
    need(c.status === 'aberta', 'Só contas em aberto podem ser editadas.');
    const v = F.criarContas({ ...c, ...b, parcelas: 1, valor: b.valor ?? c.valor }, hoje())[0];
    return fin.pagar.put({ ...c, descricao: v.descricao, valor: v.valor, venc: v.venc, forma: v.forma, fornecedor: v.fornecedor, categoria: v.categoria, codigoBarras: v.codigoBarras, obs: v.obs, chavePix: String(b.chavePix ?? c.chavePix ?? '').slice(0, 120) });
  });
  on('POST', '/pagar/([\\w-]+)/baixar', async ([id], _, b) => { const c = fin.pagar.get(id); if (!c) throw notFound('Conta'); const n = F.baixar(c, b, hoje()); fin.pagar.put(n); store.log('pagar', `Conta paga: ${c.descricao}`); return n; });
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

  return {
    avisarContratos, contratos, receber, folhaAuto, gerarFolhaEmpresa,
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
