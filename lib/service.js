'use strict';
const R = require('./rules');
const { createContracts } = require('./contracts');
const { dashboard } = require('./dashboard');
const { createCobrar } = require('./cobrar');

const FIELDS = [
  { name: 'CR_ASAAS_ID', type: 'string', label: 'CR · ID cobrança Asaas' },
  { name: 'CR_LINK', type: 'string', label: 'CR · Link de pagamento' },
  { name: 'CR_STATUS', type: 'string', label: 'CR · Status Asaas' },
  { name: 'CR_VENC', type: 'date', label: 'CR · Vencimento' },
  { name: 'CR_FORMA', type: 'enumeration', label: 'CR · Forma de pagamento', list: R.FORMAS.map(f => f.label) },
  { name: 'CR_TIPO', type: 'enumeration', label: 'CR · Tipo (à vista, parcelado, recorrente)', list: R.TIPOS.map(t => t.label) },
  { name: 'CR_QTD', type: 'integer', label: 'CR · Nº de parcelas/meses (recorrente: vazio = assinatura sem fim)' },
  { name: 'CR_FILHOS', type: 'string', label: 'CR · Cobranças geradas (IDs dos cards)' },
  { name: 'CR_ASSINATURA', type: 'string', label: 'CR · ID da assinatura no Asaas' },
  { name: 'CR_PARCELA', type: 'string', label: 'CR · Parcela (n/N)' },
  { name: 'CR_ORIGEM', type: 'integer', label: 'CR · Deal de origem (venda)' },
  { name: 'CR_DOC', type: 'string', label: 'CR · CPF/CNPJ do pagador' },
  { name: 'CR_PAGO_EM', type: 'date', label: 'CR · Pago em' },
  { name: 'CR_VALOR_ASAAS', type: 'double', label: 'CR · Valor no Asaas' },
  { name: 'CR_ULT_AVISO', type: 'string', label: 'CR · Último aviso (data/hora)' },
  { name: 'CR_CATEGORIA', type: 'enumeration', label: 'CR · Categoria', list: R.CATEGORIAS },
  { name: 'CR_PLANO', type: 'enumeration', label: 'CR · Plano da licença', list: R.PLANOS },
  { name: 'CR_BOLETO', type: 'string', label: 'CR · Boleto (PDF)' },
  { name: 'CR_PIX', type: 'string', label: 'CR · Pix copia e cola' },
  { name: 'CR_LINHA', type: 'string', label: 'CR · Linha digitável do boleto' },
  { name: 'CR_SPLIT', type: 'string', label: 'CR · Split (ex.: Parceiro A=30%; Parceiro B=R$ 50,00)' },
  { name: 'CR_LINK_PROX', type: 'string', label: 'CR · Link da próxima cobrança em aberto (contrato)' },
  { name: 'CR_GATILHO', type: 'string', label: 'CR · Gatilho de cobrança (D-3, D0, D+1...)' },
];
const UF = n => `UF_CRM_${n}`;
const BILLING = { boleto: 'BOLETO', pix: 'PIX', cartao: 'CREDIT_CARD', 'cartão': 'CREDIT_CARD', credit_card: 'CREDIT_CARD' };
const normBilling = v => BILLING[String(v || '').toLowerCase()] || (['BOLETO', 'PIX', 'CREDIT_CARD'].includes(String(v)) ? v : 'UNDEFINED');
const num = v => (v === '' || v == null ? 0 : Number(v));

function createService({ bitrix, asaas, store }) {
  const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
  let running = false;
  let cache = { at: 0, deals: [] };
  const custCache = { at: 0, map: new Map() };   // clientes do Bitrix: reaproveitados entre leituras (TTL 10 min)
  let payMap = null;                             // cobranças ativas do Asaas, carregadas em lote no início de cada sync
  const getPay = async id => (payMap && payMap.get(id)) || asaas.getPayment(id);

  async function ensureFields() {
    await ensureStages();
    let have = await bitrix.call('crm.deal.userfield.list', {});
    // CR_TIPO e CR_FORMA nasceram como texto; viram listas de seleção (só migra se ainda estiverem vazios).
    for (const old of (have.result || []).filter(f => ['UF_CRM_CR_TIPO', 'UF_CRM_CR_FORMA'].includes(f.FIELD_NAME) && f.USER_TYPE_ID === 'string')) {
      const used = await bitrix.call('crm.deal.list', { filter: { ['!' + old.FIELD_NAME]: '' }, select: ['ID'] }).catch(() => ({ total: 1 }));
      if (!used.result?.length) { await bitrix.call('crm.deal.userfield.delete', { id: old.ID }); store.log('campos', `Campo ${old.FIELD_NAME} recriado como lista`); }
    }
    have = await bitrix.call('crm.deal.userfield.list', {});
    // campos numéricos nasceram sem casas decimais (1927,70 virava 1928): passa para 2 casas
    for (const f of (have.result || []).filter(x => x.FIELD_NAME === UF('CR_VALOR_ASAAS') && x.USER_TYPE_ID === 'double' && Number(x.SETTINGS?.PRECISION) < 2)) {
      await bitrix.call('crm.deal.userfield.update', { id: f.ID, fields: { SETTINGS: { PRECISION: 2 } } });
      store.log('campos', `Campo ${f.FIELD_NAME} ajustado para 2 casas decimais`);
    }
    const names = new Set((have.result || []).map(f => f.FIELD_NAME));
    const created = [];
    for (const f of FIELDS) {
      if (names.has(UF(f.name))) continue;
      await bitrix.call('crm.deal.userfield.add', { fields: {
        FIELD_NAME: f.name, USER_TYPE_ID: f.type, XML_ID: f.name,
        EDIT_FORM_LABEL: { br: f.label, en: f.label }, LIST_COLUMN_LABEL: { br: f.label, en: f.label },
        SHOW_IN_LIST: 'Y', EDIT_IN_LIST: 'Y', MULTIPLE: 'N',
        ...(f.list ? { LIST: f.list.map((v, i) => ({ VALUE: v, SORT: (i + 1) * 10, DEF: 'N' })) } : {}),
        ...(f.type === 'double' ? { SETTINGS: { PRECISION: 2 } } : {}),
      } });
      created.push(f.name);
    }
    if (created.length) store.log('campos', `Campos criados no Bitrix: ${created.join(', ')}`);
    return created;
  }

  // ---- etapas novas do funil (Gerar cobranças / Contratado) ----
  async function ensureStages() {
    const ent = `DEAL_STAGE_${R.CATEGORY_ID}`;
    const have = (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: ent } })).result || [];
    const ids = new Set(have.map(x => x.STATUS_ID));
    const want = [['GERAR', 'Gerar cobranças', 5, '#6366f1'], ['CONTRATADO', 'Contratado', 50, '#94a3b8']];
    for (const [id, name, sort, color] of want) {
      if (ids.has(id) || ids.has(`C${R.CATEGORY_ID}:${id}`)) continue;
      await bitrix.call('crm.status.add', { fields: { ENTITY_ID: ent, STATUS_ID: id, NAME: name, SORT: sort, COLOR: color } });
      store.log('campos', `Etapa criada no funil: ${name}`);
    }
  }

  // ---- listas (categoria/plano/tipo/forma): id do item no Bitrix <-> rótulo ----
  let enums = { at: 0, categoria: {}, plano: {}, tipo: {}, forma: {} };
  async function loadEnums(force) {
    if (!force && Date.now() - enums.at < 300000) return enums;
    const all = (await bitrix.call('crm.deal.userfield.list', {})).result || [];
    const pick = n => Object.fromEntries(((all.find(f => f.FIELD_NAME === UF(n)) || {}).LIST || []).map(i => [String(i.ID), i.VALUE]));
    enums = { at: Date.now(), categoria: pick('CR_CATEGORIA'), plano: pick('CR_PLANO'), tipo: pick('CR_TIPO'), forma: pick('CR_FORMA') };
    return enums;
  }
  const idOf = (map, label) => Object.keys(map).find(k => map[k] === label) || '';
  // código interno (PIX, PARCELADO...) <-> id do item de lista
  const TABLE = { tipo: R.TIPOS, forma: R.FORMAS };
  const enc = (kind, code) => idOf(enums[kind], (TABLE[kind].find(x => x.code === code) || {}).label);
  const dec = (kind, id) => (TABLE[kind].find(x => x.label === enums[kind][String(id)]) || {}).code || '';
  const classFields = (cat, pl) => ({ [UF('CR_CATEGORIA')]: idOf(enums.categoria, cat), [UF('CR_PLANO')]: idOf(enums.plano, pl) });

  // ---- clientes (empresa/contato) com cache por execução ----
  const custKey = deal => (deal.COMPANY_ID && deal.COMPANY_ID !== '0' ? `C${deal.COMPANY_ID}` : deal.CONTACT_ID && deal.CONTACT_ID !== '0' ? `P${deal.CONTACT_ID}` : null);
  const buildCustomer = (ent, isCompany, rqs = []) => {
    let doc = R.findDoc(ent, ['UF_CRM_CNPJ', 'UF_CRM_6675B86EE950A']);
    for (const r of rqs) doc = doc || R.findDoc(r, ['RQ_CNPJ', 'RQ_CPF', 'RQ_INN']);
    const nome = isCompany ? ent.TITLE : [ent.NAME, ent.LAST_NAME].filter(Boolean).join(' ');
    return { nome: nome || '', doc, email: ent.EMAIL?.[0]?.VALUE || '', telefone: ent.PHONE?.[0]?.VALUE || '' };
  };

  // Carrega empresas/contatos em lotes de 50 (2 chamadas por lote) em vez de 2 chamadas por cliente.
  async function prefetchCustomers(deals, memo) {
    const need = { C: new Set(), P: new Set() };
    for (const d of deals) { const k = custKey(d); if (k && !memo.has(k)) need[k[0]].add(k.slice(1)); }
    for (const [t, set] of Object.entries(need)) {
      const ids = [...set], isCompany = t === 'C';
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        try {
          const r = await bitrix.call(isCompany ? 'crm.company.list' : 'crm.contact.list', { filter: { ID: chunk }, select: isCompany ? ['ID', 'TITLE', 'EMAIL', 'PHONE', 'UF_*'] : ['ID', 'NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'UF_*'] });
          if (!Array.isArray(r.result)) continue;
          const rq = await bitrix.call('crm.requisite.list', { filter: { ENTITY_TYPE_ID: isCompany ? 4 : 3, ENTITY_ID: chunk }, select: ['ENTITY_ID', 'RQ_CNPJ', 'RQ_CPF', 'RQ_INN'] }).catch(() => ({ result: [] }));
          const by = {};
          for (const x of Array.isArray(rq.result) ? rq.result : []) (by[x.ENTITY_ID] ||= []).push(x);
          for (const ent of r.result) memo.set(t + ent.ID, buildCustomer(ent, isCompany, by[ent.ID]));
        } catch { /* cai para a leitura individual */ }
      }
    }
  }

  async function customerOf(deal, memo) {
    const key = custKey(deal);
    if (!key) return { nome: '', doc: '', email: '', telefone: '' };
    if (memo.has(key)) return memo.get(key);
    const isCompany = key[0] === 'C';
    const id = key.slice(1);
    const ent = (await bitrix.call(isCompany ? 'crm.company.get' : 'crm.contact.get', { id })).result || {};
    let rqs = [];
    try { rqs = (await bitrix.call('crm.requisite.list', { filter: { ENTITY_TYPE_ID: isCompany ? 4 : 3, ENTITY_ID: id }, select: ['RQ_CNPJ', 'RQ_CPF', 'RQ_INN', 'RQ_COMPANY_NAME'] })).result || []; } catch { /* requisitos são opcionais */ }
    const out = buildCustomer(ent, isCompany, rqs);
    memo.set(key, out);
    return out;
  }

  async function loadDeals({ lite = false } = {}) {
    const select = ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'COMPANY_ID', 'CONTACT_ID', 'ASSIGNED_BY_ID', 'CLOSEDATE', 'DATE_CREATE', 'COMMENTS', ...FIELDS.map(f => UF(f.name)), 'UF_CRM_CNPJ', 'UF_CRM_6675B86EE950A'];
    const deals = await bitrix.listAll('crm.deal.list', { filter: { CATEGORY_ID: R.CATEGORY_ID }, select, order: { ID: 'DESC' } });
    if (Date.now() - custCache.at > 600000) { custCache.map = new Map(); custCache.at = Date.now(); }
    const memo = custCache.map;
    const today = R.todayBR();
    const en = await loadEnums();
    const out = [];
    if (!lite) await prefetchCustomers(deals, memo);
    for (const d of deals) {
      const cli = lite ? { nome: '', doc: '', email: '', telefone: '' } : await customerOf(d, memo);
      const venc = R.toDay(d[UF('CR_VENC')]) || R.toDay(d.CLOSEDATE);
      const doc = R.validDoc(d[UF('CR_DOC')]) ? R.digits(d[UF('CR_DOC')]) : (R.findDoc(d, ['UF_CRM_CNPJ', 'UF_CRM_6675B86EE950A']) || cli.doc);
      const c = {
        id: +d.ID, titulo: d.TITLE, stageId: d.STAGE_ID, etapa: R.STAGE_LABEL[d.STAGE_ID] || d.STAGE_ID,
        valor: num(d.OPPORTUNITY), moeda: d.CURRENCY_ID || 'BRL', venc, cliente: cli.nome, doc,
        email: cli.email, telefone: cli.telefone, responsavel: d.ASSIGNED_BY_ID,
        companyId: d.COMPANY_ID, contactId: d.CONTACT_ID,
        asaasId: d[UF('CR_ASAAS_ID')] || '', link: d[UF('CR_LINK')] || '', statusAsaas: d[UF('CR_STATUS')] || '',
        forma: dec('forma', d[UF('CR_FORMA')]), tipo: dec('tipo', d[UF('CR_TIPO')]), parcela: d[UF('CR_PARCELA')] || '',
        qtd: num(d[UF('CR_QTD')]), assinatura: d[UF('CR_ASSINATURA')] || '', filhos: d[UF('CR_FILHOS')] || '',
        categoriaId: d[UF('CR_CATEGORIA')] || '', planoId: d[UF('CR_PLANO')] || '',
        origem: d[UF('CR_ORIGEM')] || '', pagoEm: R.toDay(d[UF('CR_PAGO_EM')]),
        valorAsaas: d[UF('CR_VALOR_ASAAS')] ? num(d[UF('CR_VALOR_ASAAS')]) : null,
        ultAviso: d[UF('CR_ULT_AVISO')] || '', gatilho: d[UF('CR_GATILHO')] || '',
        categoria: en.categoria[d[UF('CR_CATEGORIA')]] || '', plano: en.plano[d[UF('CR_PLANO')]] || '',
        obs: d.COMMENTS || '', criado: R.toDay(d.DATE_CREATE),
        boleto: d[UF('CR_BOLETO')] || '', pix: d[UF('CR_PIX')] || '', linha: d[UF('CR_LINHA')] || '', split: d[UF('CR_SPLIT')] || '', linkProx: d[UF('CR_LINK_PROX')] || '',
        avisos: store.sent(+d.ID),
      };
      c.atraso = c.venc && !R.FINAL_STAGES.has(c.stageId) ? Math.max(0, R.dayDiff(today, c.venc)) : 0;
      c.pendencias = R.issuesFor(c, store.config, today, asaas.enabled);
      out.push(c);
    }
    if (!lite) cache = { at: Date.now(), deals: out };
    return out;
  }

  async function classify(c, categoria, plano, origem = 'manual') {
    const en = await loadEnums();
    const catId = idOf(en.categoria, categoria), plId = idOf(en.plano, plano);
    if (categoria && !catId) throw new Error(`Categoria inexistente: ${categoria}`);
    if (plano && !plId) throw new Error(`Plano inexistente: ${plano}`);
    await updateDeal(c.id, { [UF('CR_CATEGORIA')]: catId, [UF('CR_PLANO')]: plId });
    c.categoria = categoria || ''; c.plano = plano || '';
    store.log('classificar', `Deal ${c.id}: ${categoria || '—'}${plano ? ' · ' + plano : ''} (${origem})`, { deal: c.id });
    cache.at = 0;
    return true;
  }

  async function updateDeal(id, fields) {
    await bitrix.call('crm.deal.update', { id, fields, params: { REGISTER_SONET_EVENT: 'N' } });
  }
  async function timeline(id, comment) {
    try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: id, ENTITY_TYPE: 'deal', COMMENT: comment } }); } catch { /* opcional */ }
  }

  // ---- emissão da cobrança no Asaas (idempotente por externalReference) ----
  // Boleto em PDF, linha digitável e Pix "copia e cola" de uma cobrança (best-effort: falha de um não derruba o resto).
  async function payInfo(pay) {
    const out = { boleto: pay.bankSlipUrl || '', pix: '', pixImagem: '', linha: '' };
    if (['BOLETO', 'UNDEFINED'].includes(pay.billingType)) {
      try { out.linha = (await asaas.identificationField(pay.id)).identificationField || ''; } catch { /* sem linha digitável */ }
    }
    if (['PIX', 'UNDEFINED'].includes(pay.billingType)) {
      try { const q = await asaas.pixQrCode(pay.id); out.pix = q.payload || ''; out.pixImagem = q.encodedImage || ''; } catch { /* Pix indisponível */ }
    }
    return out;
  }
  const payFields = (pay, info) => ({
    [UF('CR_ASAAS_ID')]: pay.id, [UF('CR_LINK')]: pay.invoiceUrl || '', [UF('CR_STATUS')]: pay.status,
    [UF('CR_VENC')]: pay.dueDate, [UF('CR_VALOR_ASAAS')]: pay.value, [UF('CR_FORMA')]: enc('forma', pay.billingType),
    ...(info.boleto ? { [UF('CR_BOLETO')]: info.boleto } : {}), ...(info.pix ? { [UF('CR_PIX')]: info.pix } : {}), ...(info.linha ? { [UF('CR_LINHA')]: info.linha } : {}),
  });

  // extras: { discount: { value, type: FIXED|PERCENTAGE, dueDateLimitDays }, splitList }
  async function createCharge(c, extras = {}) {
    if (!asaas.enabled) throw new Error('Asaas não configurado');
    if (c.asaasId) return c;
    const probs = c.pendencias.filter(p => p.sev === 'alta' && !/Asaas|atraso|Vencida/.test(p.msg));
    if (probs.length) throw new Error(probs.map(p => p.msg).join('; '));
    const ref = `bitrix-deal-${c.id}`;
    const existing = await asaas.listPayments({ externalReference: ref, limit: 1 });
    let pay = existing.data?.[0];
    if (!pay) {
      const cfg = store.config;
      const split = c.split ? R.parseSplit(c.split, store.wallets) : (extras.splitList || []);
      const customer = await asaas.findOrCreateCustomer({ name: c.cliente, cpfCnpj: c.doc, email: c.email, phone: c.telefone });
      pay = await asaas.createPayment({
        customer: customer.id, billingType: normBilling(c.forma), value: c.valor, dueDate: c.venc,
        description: descFor(c), externalReference: ref,
        ...(cfg.multaPct ? { fine: { value: cfg.multaPct } } : {}),
        ...(cfg.jurosMensalPct ? { interest: { value: cfg.jurosMensalPct } } : {}),
        ...(extras.discount ? { discount: extras.discount } : {}),
        ...(split.length ? { split } : {}),
      });
    }
    const info = await payInfo(pay);
    await updateDeal(c.id, payFields(pay, info));
    await timeline(c.id, `Cobrança emitida no Asaas: ${pay.id} · R$ ${pay.value} · vence ${pay.dueDate}\n${pay.invoiceUrl || ''}${info.linha ? `\nLinha digitável: ${info.linha}` : ''}`);
    store.log('cobranca', `Cobrança ${pay.id} emitida para deal ${c.id} (${c.cliente})`, { deal: c.id });
    Object.assign(c, { asaasId: pay.id, link: pay.invoiceUrl, statusAsaas: pay.status, valorAsaas: pay.value, boleto: info.boleto, pix: info.pix, linha: info.linha });
    return c;
  }

  // ---- painel da cobrança (links, boleto, Pix) e operações de pós-venda ----
  async function detalhe(c) {
    if (!asaas.enabled) throw fail(400, 'Asaas não configurado');
    if (!c.asaasId) throw fail(400, 'Esta deal ainda não tem cobrança no Asaas');
    const pay = await asaas.getPayment(c.asaasId);
    const info = await payInfo(pay);
    const upd = {};
    if (info.boleto && info.boleto !== c.boleto) upd[UF('CR_BOLETO')] = info.boleto;
    if (info.pix && info.pix !== c.pix) upd[UF('CR_PIX')] = info.pix;
    if (info.linha && info.linha !== c.linha) upd[UF('CR_LINHA')] = info.linha;
    if (pay.invoiceUrl && pay.invoiceUrl !== c.link) upd[UF('CR_LINK')] = pay.invoiceUrl;
    if (Object.keys(upd).length) { await updateDeal(c.id, upd); cache.at = 0; }
    const nome = id => (store.wallets.find(w => w.walletId === id) || {}).nome || id;
    return {
      id: pay.id, status: pay.status, valor: pay.value, venc: pay.dueDate, forma: pay.billingType, descricao: pay.description || '',
      link: pay.invoiceUrl || '', boleto: info.boleto, linha: info.linha, pix: info.pix, pixImagem: info.pixImagem, nossoNumero: pay.nossoNumero || '',
      pagoEm: R.toDay(pay.clientPaymentDate || pay.paymentDate), assinatura: pay.subscription || '', parcelamento: pay.installment || '',
      desconto: pay.discount && pay.discount.value ? pay.discount : null, multa: pay.fine?.value || 0, juros: pay.interest?.value || 0,
      split: (pay.split || []).map(s => ({ nome: nome(s.walletId), walletId: s.walletId, percentual: s.percentualValue || null, fixo: s.fixedValue || null, status: s.status || '' })),
      ativa: ACTIVE.has(pay.status), paga: R.mapAsaasStatus(pay.status) === 'paid',
    };
  }

  async function receberDinheiro(c, { data, valor, notificar } = {}) {
    if (!c.asaasId) throw fail(400, 'Esta deal não tem cobrança no Asaas');
    const pay = await asaas.getPayment(c.asaasId);
    if (!ACTIVE.has(pay.status)) throw fail(400, `Cobrança já está "${pay.status}" no Asaas.`);
    const hoje = R.todayBR();
    const dia = data || hoje;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || dia > hoje) throw fail(400, 'Data do recebimento inválida (não pode ser futura).');
    const v = valor === undefined || valor === '' ? Number(pay.value) : Number(valor);
    if (!(v > 0)) throw fail(400, 'Valor recebido inválido');
    await asaas.receiveInCash(c.asaasId, { paymentDate: dia, value: v, notifyCustomer: !!notificar });
    const novo = await asaas.getPayment(c.asaasId);
    await refreshCharge(c, hoje, novo);
    await timeline(c.id, `Recebimento em dinheiro registrado no Asaas: R$ ${v.toFixed(2)} em ${dia.split('-').reverse().join('/')}.`);
    store.log('cobranca', `Deal ${c.id}: recebimento em dinheiro R$ ${v.toFixed(2)}`, { deal: c.id });
    cache.at = 0;
    return { ok: true, status: novo.status };
  }

  async function estornar(c, { valor, motivo } = {}) {
    if (!c.asaasId) throw fail(400, 'Esta deal não tem cobrança no Asaas');
    const pay = await asaas.getPayment(c.asaasId);
    if (R.mapAsaasStatus(pay.status) !== 'paid') throw fail(400, `Só dá para estornar cobrança paga (status atual: ${pay.status}).`);
    const body = {};
    if (valor !== undefined && valor !== '') { const v = Number(valor); if (!(v > 0) || v > Number(pay.value)) throw fail(400, 'Valor do estorno inválido'); body.value = v; }
    if (motivo) body.description = String(motivo).slice(0, 200);
    await asaas.refund(c.asaasId, body);
    const novo = await asaas.getPayment(c.asaasId);
    await refreshCharge(c, R.todayBR(), novo);
    await timeline(c.id, `Estorno solicitado no Asaas${body.value ? `: R$ ${body.value.toFixed(2)}` : ' (valor total)'}${body.description ? ` · ${body.description}` : ''}.`);
    store.log('cobranca', `Deal ${c.id}: estorno solicitado`, { deal: c.id });
    cache.at = 0;
    return { ok: true, status: novo.status };
  }

  // ---- conciliação: Asaas -> etapa/campos do Bitrix ----
  async function refreshCharge(c, today, known) {
    const pay = known || await asaas.getPayment(c.asaasId);
    const state = R.mapAsaasStatus(pay.status);
    const stage = R.stageFor(state, pay.dueDate || c.venc, today, store.config.diasProximo);
    const fields = {};
    if (pay.status !== c.statusAsaas) fields[UF('CR_STATUS')] = pay.status;
    if (pay.invoiceUrl && pay.invoiceUrl !== c.link) fields[UF('CR_LINK')] = pay.invoiceUrl;
    if (pay.value !== c.valorAsaas) fields[UF('CR_VALOR_ASAAS')] = pay.value;
    const pagoEm = R.toDay(pay.clientPaymentDate || pay.paymentDate);
    if (state === 'paid' && pagoEm && pagoEm !== c.pagoEm) fields[UF('CR_PAGO_EM')] = pagoEm;
    if (stage !== c.stageId) fields.STAGE_ID = stage;
    if (Object.keys(fields).length) {
      await updateDeal(c.id, fields);
      if (fields.STAGE_ID) {
        store.log('etapa', `Deal ${c.id}: ${R.STAGE_LABEL[c.stageId]} → ${R.STAGE_LABEL[stage]} (${pay.status})`, { deal: c.id });
        if (state === 'paid') await timeline(c.id, `Pagamento confirmado no Asaas em ${pagoEm || 'data n/d'} (${pay.status}).`);
      }
    }
    return { state, pay, stage };
  }

  // ---- edições nos dois sentidos (Bitrix <-> Asaas) ----
  // Regra: só o Bitrix mudou -> envia ao Asaas; só o Asaas mudou -> traz ao Bitrix; os dois mudaram o mesmo campo -> vale o Bitrix.
  // A "foto" do último estado sincronizado (store.snap) é o que permite saber quem mudou.
  const descFor = c => ((c.parcela && !c.titulo.includes(c.parcela)) ? `${c.titulo} — parcela ${c.parcela}` : c.titulo).slice(0, 500);
  const ACTIVE = new Set(['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS']);
  const blockedMsg = new Map();
  const KEYMAP = { valor: 'value', venc: 'dueDate', forma: 'billingType', desc: 'description' };
  const LABEL = { valor: 'valor', venc: 'vencimento', forma: 'forma de pagamento', desc: 'descrição' };
  const fmt = (k, v) => (k === 'valor' ? `R$ ${Number(v).toFixed(2)}` : k === 'venc' ? v.split('-').reverse().join('/') : String(v));

  async function reconcile(c, pay) {
    const local = { valor: Number(c.valor), venc: c.venc, forma: c.forma || 'UNDEFINED', desc: descFor(c) };
    const remote = { valor: Number(pay.value), venc: pay.dueDate, forma: pay.billingType, desc: pay.description || '' };
    // Primeiro contato com este card (sem "foto"): assume que o Bitrix estava em dia, exceto o valor, cujo último
    // valor conhecido do Asaas está em CR_VALOR_ASAAS. Assim nada é enviado ao Asaas por diferença antiga:
    // vencimento/forma divergentes são trazidos do Asaas e a descrição nunca é enviada nesse momento.
    const known = c.valorAsaas != null && Math.round(remote.valor) === Number(c.valorAsaas) && remote.valor !== Number(c.valorAsaas) ? remote.valor : (c.valorAsaas != null ? Number(c.valorAsaas) : local.valor); // tolera valor antigo arredondado
    const snap = store.snap(c.id) || { valor: known, venc: local.venc, forma: local.forma, desc: remote.desc, descLocal: local.desc };
    const push = [], pull = [];
    for (const k of Object.keys(KEYMAP)) {
      if (local[k] === remote[k]) continue;
      if (k === 'desc') { if (local.desc !== snap.descLocal) push.push(k); continue; }   // título só vai ao Asaas se foi editado no Bitrix
      const bitrixChanged = local[k] !== snap[k];
      const asaasChanged = remote[k] !== snap[k];
      if (bitrixChanged) push.push(k);
      else if (asaasChanged) pull.push(k);
    }
    const out = { pay, pushed: [], pulled: [], blocked: null };
    const final = { ...local };

    if (push.length) {
      if (!ACTIVE.has(pay.status)) {
        out.blocked = `Alteração no Bitrix (${push.map(k => LABEL[k]).join(', ')}) não aplicada: a cobrança está "${pay.status}" no Asaas.`;
        if (blockedMsg.get(c.id) !== out.blocked) { blockedMsg.set(c.id, out.blocked); await timeline(c.id, out.blocked); store.log('asaas', `Deal ${c.id}: ${out.blocked}`, { deal: c.id }); }
        for (const k of push) final[k] = remote[k];
      } else {
        blockedMsg.delete(c.id);
        const body = Object.fromEntries(push.map(k => [KEYMAP[k], local[k]]));
        out.pay = await asaas.updatePayment(c.asaasId, body);
        out.pushed = push;
        await timeline(c.id, `Alteração enviada ao Asaas: ${push.map(k => `${LABEL[k]} ${fmt(k, remote[k])} → ${fmt(k, local[k])}`).join('; ')}.`);
        store.log('asaas', `Deal ${c.id} → Asaas: ${push.map(k => LABEL[k]).join(', ')}`, { deal: c.id });
      }
    }
    if (pull.length) {
      const f = {};
      for (const k of pull) {
        if (k === 'valor') { f.OPPORTUNITY = remote.valor; f.IS_MANUAL_OPPORTUNITY = 'Y'; }
        if (k === 'venc') f[UF('CR_VENC')] = remote.venc;
        if (k === 'forma') f[UF('CR_FORMA')] = enc('forma', remote.forma);
        final[k] = remote[k];
      }
      await updateDeal(c.id, f);
      out.pulled = pull;
      await timeline(c.id, `Alteração feita no Asaas trazida para o Bitrix: ${pull.map(k => `${LABEL[k]} ${fmt(k, local[k])} → ${fmt(k, remote[k])}`).join('; ')}.`);
      store.log('asaas', `Asaas → deal ${c.id}: ${pull.map(k => LABEL[k]).join(', ')}`, { deal: c.id });
      Object.assign(c, { valor: final.valor, venc: final.venc, forma: final.forma });
    }
    const cur = out.pay;
    store.setSnap(c.id, { valor: Number(cur.value), venc: cur.dueDate, forma: cur.billingType, desc: cur.description || '', descLocal: out.blocked ? snap.descLocal : local.desc });
    return out;
  }

  // Cards em etapa final: cancelamento manual cancela no Asaas; "Pago" sem pagamento é sinalizado.
  async function settleFinal(c) {
    const terminal = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'DUNNING_RECEIVED', 'DELETED', 'REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS']);
    if (!c.asaasId || terminal.has(c.statusAsaas)) return null;
    const pay = await getPay(c.asaasId);
    if (c.stageId === R.STAGES.cancelled) {
      if (ACTIVE.has(pay.status)) {
        await asaas.cancelPayment(c.asaasId);
        await updateDeal(c.id, { [UF('CR_STATUS')]: 'DELETED' });
        await timeline(c.id, 'Card movido para Cancelado: cobrança cancelada também no Asaas.');
        store.log('asaas', `Deal ${c.id} cancelada no Asaas (movida para Cancelado)`, { deal: c.id });
        return 'cancelada';
      }
      if (R.mapAsaasStatus(pay.status) === 'paid') {   // foi paga no Asaas: o pagamento prevalece
        await updateDeal(c.id, { STAGE_ID: R.STAGES.paid, [UF('CR_STATUS')]: pay.status, [UF('CR_PAGO_EM')]: R.toDay(pay.clientPaymentDate || pay.paymentDate) });
        await timeline(c.id, `Card estava em Cancelado, mas o Asaas confirmou o pagamento (${pay.status}). Movido para Pago.`);
        return 'paga';
      }
    }
    if (pay.status !== c.statusAsaas) await updateDeal(c.id, { [UF('CR_STATUS')]: pay.status });
    c.statusAsaas = pay.status;
    return 'status';
  }


  // ---- edição de um lançamento pelo painel: grava no Bitrix e, se houver cobrança ativa, envia ao Asaas na hora ----
  async function editar(c, p) {
    const inactive = !!(c.asaasId && c.statusAsaas && !ACTIVE.has(c.statusAsaas));
    const en = await loadEnums();
    const f = {};
    if (p.titulo !== undefined) { const t = String(p.titulo).trim(); if (!t) throw fail(400, 'O título não pode ficar vazio'); f.TITLE = t.slice(0, 255); }
    if (p.valor !== undefined) {
      const v = Number(p.valor);
      if (!(v > 0)) throw fail(400, 'Valor inválido');
      if (v !== Number(c.valor)) { if (inactive) throw fail(400, `Cobrança já ${c.statusAsaas} no Asaas: não é possível alterar o valor.`); f.OPPORTUNITY = v; f.IS_MANUAL_OPPORTUNITY = 'Y'; }
    }
    if (p.venc !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.venc)) throw fail(400, 'Vencimento inválido');
      if (p.venc !== c.venc) { if (inactive) throw fail(400, `Cobrança já ${c.statusAsaas} no Asaas: não é possível alterar o vencimento.`); f[UF('CR_VENC')] = p.venc; }
    }
    if (p.forma !== undefined) {
      if (!R.FORMAS.some(x => x.code === p.forma)) throw fail(400, 'Forma de pagamento inválida');
      if (p.forma !== (c.forma || 'UNDEFINED')) { if (inactive) throw fail(400, `Cobrança já ${c.statusAsaas} no Asaas: não é possível alterar a forma de pagamento.`); f[UF('CR_FORMA')] = enc('forma', p.forma); }
    }
    if (p.tipo !== undefined && p.tipo !== '') {
      if (!R.TIPOS.some(x => x.code === p.tipo)) throw fail(400, 'Tipo inválido');
      f[UF('CR_TIPO')] = enc('tipo', p.tipo);
    }
    if (p.obs !== undefined) f.COMMENTS = String(p.obs).slice(0, 5000);
    if (p.doc !== undefined && String(p.doc).trim() !== '') {
      if (!R.validDoc(p.doc)) throw fail(400, 'CPF/CNPJ inválido');
      f[UF('CR_DOC')] = R.digits(p.doc);
    }
    if (p.categoria !== undefined || p.plano !== undefined) {
      const cat = String(p.categoria ?? c.categoria ?? ''), pl = String(p.plano ?? c.plano ?? '');
      if (cat && !idOf(en.categoria, cat)) throw fail(400, `Categoria inexistente: ${cat}`);
      if (pl && !idOf(en.plano, pl)) throw fail(400, `Tipo de licença inexistente: ${pl}`);
      Object.assign(f, classFields(cat, pl));
    }
    if (!Object.keys(f).length) return { ok: true, alterado: false };
    await updateDeal(c.id, f);
    store.log('editar', `Deal ${c.id} editado pelo painel: ${Object.keys(f).filter(k => k !== 'IS_MANUAL_OPPORTUNITY').join(', ')}`, { deal: c.id });
    cache.at = 0;
    const out = { ok: true, alterado: true, asaas: null };
    if (asaas.enabled && c.asaasId && !inactive) {
      const fresh = (await loadDeals()).find(d => d.id === c.id);
      const rc = await reconcile(fresh, await asaas.getPayment(c.asaasId));
      out.asaas = { enviado: rc.pushed.map(k => LABEL[k]), bloqueado: rc.blocked };
    }
    return out;
  }

  // ---- gatilho da régua (o envio de e-mail/WhatsApp é feito pela automação do Bitrix) ----
  async function triggerReminder(c, offset, { manual = false } = {}) {
    const label = R.offsetLabel(offset);
    const stamp = new Date().toISOString();
    await updateDeal(c.id, { [UF('CR_GATILHO')]: `${label}|${stamp}`, [UF('CR_ULT_AVISO')]: stamp });
    await timeline(c.id, `Régua de cobrança: gatilho ${label} acionado${manual ? ' manualmente' : ''}. Link: ${c.link || 'n/d'}`);
    if (offset > 0 && c.responsavel) {
      try {
        await bitrix.call('im.notify.personal.add', { USER_ID: c.responsavel, MESSAGE: `Cobrança em atraso (${label}): ${c.cliente} · R$ ${c.valor} · deal ${c.id}` });
      } catch { /* notificação interna é opcional */ }
    }
    store.markSent(c.id, offset, 'bitrix-gatilho');
    store.log('regua', `Gatilho ${label} → deal ${c.id} (${c.cliente})${manual ? ' [manual]' : ''}`, { deal: c.id });
  }


  // ---- verificação rápida (a cada ~2 min): só movimenta cards por pagamento e por data ----
  let quickRunning = false;
  async function quick() {
    if (running || quickRunning) return { skipped: true };
    quickRunning = true;
    const t0 = Date.now();
    const res = { moved: 0, errors: [], pagos: 0 };
    try {
      const today = R.todayBR();
      let map = null;
      if (asaas.enabled && asaas.activePayments) map = new Map((await asaas.activePayments()).map(p => [p.id, p]));
      const deals = await loadDeals({ lite: true });
      for (const c of deals) {
        if (R.FINAL_STAGES.has(c.stageId) || R.CONTRACT_STAGES.has(c.stageId)) continue;
        try {
          if (c.asaasId && asaas.enabled) {
            const pay = (map && map.get(c.asaasId)) || await asaas.getPayment(c.asaasId);
            const state = R.mapAsaasStatus(pay.status);
            if (state === 'open' && pay.dueDate !== c.venc) continue;   // vencimento editado no Bitrix: o sync completo envia ao Asaas antes de mover
            const r = await refreshCharge(c, today, pay);
            if (r.stage !== c.stageId) { res.moved++; if (r.state === 'paid') res.pagos++; }
          } else if (!c.asaasId && c.venc) {
            const stage = R.stageFor('open', c.venc, today, store.config.diasProximo);
            if (stage !== c.stageId) {
              await updateDeal(c.id, { STAGE_ID: stage });
              store.log('etapa', `Deal ${c.id}: ${R.STAGE_LABEL[c.stageId]} → ${R.STAGE_LABEL[stage]} (vencimento)`, { deal: c.id });
              res.moved++;
            }
          }
        } catch (e) { res.errors.push(`deal ${c.id}: ${e.message}`); }
      }
    } catch (e) { res.errors.push(e.message); }
    finally {
      quickRunning = false;
      res.ms = Date.now() - t0; res.at = new Date().toISOString();
      res.errors = res.errors.slice(0, 5);
      store.setLastQuick(res);
      if (res.moved) cache.at = 0;
      if (res.errors.length) store.log('erro', `verificação rápida: ${res.errors[0]}`);
    }
    return res;
  }

  async function sync({ trigger = 'auto' } = {}) {
    if (running) return { skipped: true };
    running = true;
    const t0 = Date.now();
    const res = { created: 0, moved: 0, reminders: 0, errors: [], trigger, fases: {} };
    let tf = Date.now();
    const fase = n => { res.fases[n] = Date.now() - tf; tf = Date.now(); };
    try {
      await ensureFields(); fase('campos');
      const today = R.todayBR();
      if (trigger === 'manual') custCache.at = 0;                  // sincronização manual lê clientes de novo
      payMap = null;
      if (asaas.enabled && asaas.activePayments) {
        try { payMap = new Map((await asaas.activePayments()).map(p => [p.id, p])); }
        catch (e) { res.errors.push(`lote Asaas: ${e.message}`); store.log('erro', `lote Asaas: ${e.message}`); }
      }
      fase('lote');
      let deals = await loadDeals(); fase('leitura');
      // 1) contratos na etapa "Gerar cobranças" viram cards por parcela
      for (const m of deals.filter(d => d.stageId === R.STAGES.gerar)) {
        try { const r = await contracts.expand(m, deals); if (r.ok) res.contratos = (res.contratos || 0) + 1; }
        catch (e) { res.errors.push(`contrato ${m.id}: ${e.message}`); store.log('erro', `contrato ${m.id}: ${e.message}`, { deal: m.id }); }
      }
      if (res.contratos) deals = await loadDeals();
      // 2) o que existe no Asaas e não tem card vira card (quando a importação automática está ligada)
      if (asaas.enabled && store.config.importAuto) {
        try { const r = await contracts.importFromAsaas({}); res.importados = r.novos; if (r.novos) deals = await loadDeals(); }
        catch (e) { res.errors.push(`importação: ${e.message}`); store.log('erro', `importação: ${e.message}`); }
      }
      for (const c of deals) {
        if (R.CONTRACT_STAGES.has(c.stageId)) continue;
        if (R.FINAL_STAGES.has(c.stageId)) {
          if (asaas.enabled && c.asaasId) {
            try { if (await settleFinal(c)) res.moved++; }
            catch (e) { res.errors.push(`deal ${c.id}: ${e.message}`); store.log('erro', `deal ${c.id}: ${e.message}`, { deal: c.id }); }
          }
          continue;
        }
        try {
          if (!c.categoria) {
            const g = R.guessClass(c.titulo);
            if (g.categoria && await classify(c, g.categoria, g.plano, 'auto')) res.classified = (res.classified || 0) + 1;
          }
          if (!c.asaasId && asaas.enabled && store.config.autoCreate && !c.pendencias.some(p => p.sev === 'alta' && !/Asaas|atraso|Vencida/.test(p.msg))) {
            await createCharge(c); res.created++;
          }
          if (c.asaasId && asaas.enabled) {
            const before = c.stageId;
            const rc = await reconcile(c, await getPay(c.asaasId));
            if (rc.pushed.length || rc.pulled.length) res.edicoes = (res.edicoes || 0) + 1;
            const r = await refreshCharge(c, today, rc.pay);
            if (r.stage !== before) { res.moved++; c.stageId = r.stage; }
            c.statusAsaas = r.pay.status;
          } else if (!c.asaasId && c.venc) {
            const stage = R.stageFor('open', c.venc, today, store.config.diasProximo);
            if (stage !== c.stageId) { await updateDeal(c.id, { STAGE_ID: stage }); res.moved++; c.stageId = stage; }
          }
          if (store.config.reguaAtiva && !R.FINAL_STAGES.has(c.stageId) && c.venc && (c.asaasId || !asaas.enabled)) {
            const off = R.reminderDue(c.venc, today, store.config.reguaOffsets, store.sent(c.id));
            if (off !== null) { await triggerReminder(c, off); res.reminders++; }
          }
        } catch (e) {
          res.errors.push(`deal ${c.id}: ${e.message}`);
          store.log('erro', `deal ${c.id}: ${e.message}`, { deal: c.id });
        }
      }
      // card do contrato guarda o link da próxima cobrança em aberto
      for (const m of deals.filter(d => d.stageId === R.STAGES.contrato)) {
        const prox = deals.filter(k => String(k.origem) === String(m.id) && !R.FINAL_STAGES.has(k.stageId) && k.link).sort((a, b) => (a.venc || '').localeCompare(b.venc || ''))[0];
        const link = prox?.link || '';
        if (link !== (m.linkProx || '')) { try { await updateDeal(m.id, { [UF('CR_LINK_PROX')]: link }); } catch (e) { res.errors.push(`contrato ${m.id}: ${e.message}`); } }
      }
      fase('cards');
      cache.at = 0;
    } catch (e) {
      res.errors.push(e.message);
      store.log('erro', `sync: ${e.message}`);
    } finally {
      payMap = null;
      running = false;
      res.ms = Date.now() - t0;
      res.at = new Date().toISOString();
      store.setLastSync(res);
    }
    return res;
  }

  // Leitura para telas: dados recentes na hora. Passou de `maxAge` mas ainda é recente (até 5 min), devolve o que tem
  // e atualiza em segundo plano (uma leitura só, mesmo com várias telas pedindo). maxAge 0 ou cache invalidado (após
  // uma escrita) = leitura nova e espera.
  let refreshing = null;
  const STALE_MAX = 300000;
  async function dealsCached(maxAge = 30000) {
    const age = Date.now() - cache.at;
    if (age <= maxAge) return cache.deals;
    if (maxAge > 0 && cache.at > 0 && age <= STALE_MAX) {
      if (!refreshing) refreshing = loadDeals().catch(() => {}).finally(() => { refreshing = null; });
      return cache.deals;
    }
    await loadDeals();
    return cache.deals;
  }

  // Soma a receber / atrasado / pago por chave (usado nos cortes por categoria e plano).
  function group(deals, keyOf) {
    const m = new Map();
    for (const d of deals) {
      if (R.CONTRACT_STAGES.has(d.stageId)) continue;
      const k = keyOf(d);
      const g = m.get(k) || { nome: k, aReceber: 0, atrasado: 0, pago: 0, qtd: 0 };
      if (d.stageId === R.STAGES.paid) g.pago += d.valor;
      else if (d.stageId !== R.STAGES.cancelled) { g.aReceber += d.valor; g.qtd++; if (d.stageId === R.STAGES.late) g.atrasado += d.valor; }
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => (b.aReceber + b.pago) - (a.aReceber + a.pago));
  }

  function kpis(deals) {
    deals = deals.filter(d => !R.CONTRACT_STAGES.has(d.stageId));
    const sum = f => deals.filter(f).reduce((a, d) => a + d.valor, 0);
    const cnt = f => deals.filter(f).length;
    const open = d => d.stageId === R.STAGES.open || d.stageId === R.STAGES.soon;
    const month = R.todayBR().slice(0, 7);
    const aging = { '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const d of deals.filter(x => x.stageId === R.STAGES.late)) {
      const k = d.atraso <= 30 ? '1-30' : d.atraso <= 60 ? '31-60' : d.atraso <= 90 ? '61-90' : '90+';
      aging[k] += d.valor;
    }
    const aReceber = sum(d => !R.FINAL_STAGES.has(d.stageId));
    const pagoMes = sum(d => d.stageId === R.STAGES.paid && d.pagoEm.startsWith(month));
    const atrasado = sum(d => d.stageId === R.STAGES.late);
    return {
      aberto: { valor: sum(open), qtd: cnt(open) },
      atrasado: { valor: atrasado, qtd: cnt(d => d.stageId === R.STAGES.late) },
      pago: { valor: sum(d => d.stageId === R.STAGES.paid), qtd: cnt(d => d.stageId === R.STAGES.paid), mes: pagoMes },
      cancelado: { valor: sum(d => d.stageId === R.STAGES.cancelled), qtd: cnt(d => d.stageId === R.STAGES.cancelled) },
      inadimplenciaPct: aReceber > 0 ? Math.round((atrasado / aReceber) * 1000) / 10 : 0,
      aging,
      pendencias: cnt(d => d.pendencias.length > 0),
      porCategoria: group(deals, d => d.categoria || 'Sem categoria'),
      porPlano: group(deals.filter(d => d.plano), d => d.plano),
    };
  }

  // ---- geração de parcelas: cria N deals no funil 90 ----
  async function gerar(p) {
    const sched = R.buildSchedule(p);
    const tipo = p.tipo || 'PARCELADO';
    const en = await loadEnums();
    const catId = idOf(en.categoria, p.categoria), plId = idOf(en.plano, p.plano);
    const ids = [];
    for (const s of sched) {
      const fields = {
        TITLE: `${p.titulo || 'Cobrança'} — ${s.n}/${s.of}`,
        CATEGORY_ID: R.CATEGORY_ID, STAGE_ID: R.STAGES.open,
        OPPORTUNITY: s.value, CURRENCY_ID: 'BRL', IS_MANUAL_OPPORTUNITY: 'Y',
        ...(p.companyId ? { COMPANY_ID: p.companyId } : {}), ...(p.contactId ? { CONTACT_ID: p.contactId } : {}),
        [UF('CR_VENC')]: s.due, [UF('CR_FORMA')]: enc('forma', normBilling(p.forma)), [UF('CR_TIPO')]: enc('tipo', tipo),
        [UF('CR_PARCELA')]: `${s.n}/${s.of}`, ...(p.origem ? { [UF('CR_ORIGEM')]: p.origem } : {}),
        ...(p.doc ? { [UF('CR_DOC')]: R.digits(p.doc) } : {}),
        ...(catId ? { [UF('CR_CATEGORIA')]: catId } : {}), ...(plId ? { [UF('CR_PLANO')]: plId } : {}),
      };
      const r = await bitrix.call('crm.deal.add', { fields, params: { REGISTER_SONET_EVENT: 'N' } });
      ids.push(r.result);
    }
    store.log('gerar', `${ids.length} título(s) gerados: deals ${ids.join(', ')}`);
    cache.at = 0;
    return { ids, schedule: sched };
  }

  async function findCustomers(q) {
    const [co, ct] = await Promise.all([
      bitrix.call('crm.company.list', { filter: { '%TITLE': q }, select: ['ID', 'TITLE'], order: { ID: 'DESC' } }),
      bitrix.call('crm.contact.list', { filter: { '%NAME': q }, select: ['ID', 'NAME', 'LAST_NAME'], order: { ID: 'DESC' } }),
    ]);
    return [
      ...(co.result || []).slice(0, 10).map(x => ({ tipo: 'company', id: x.ID, nome: x.TITLE })),
      ...(ct.result || []).slice(0, 10).map(x => ({ tipo: 'contact', id: x.ID, nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') })),
    ];
  }

  // Estado do painel, opcionalmente restrito a um cliente (aba dentro da deal/empresa/contato).
  // Escopo: { deal } | { company } | { contact } — o cliente é resolvido pelo servidor, nunca pelo navegador.
  async function estado(scope = {}) {
    const all = await dealsCached();
    const num = v => (/^\d+$/.test(String(v || '')) ? String(v) : '');
    const dealId = num(scope.deal), companyArg = num(scope.company), contactArg = num(scope.contact);
    const pedido = [scope.deal, scope.company, scope.contact].some(v => v !== null && v !== undefined && v !== '');
    if (pedido && !dealId && !companyArg && !contactArg) throw fail(400, 'Escopo inválido');   // nunca cai no painel geral por parâmetro ruim
    if (!dealId && !companyArg && !contactArg) return { deals: all, kpis: kpis(all), escopo: null };

    let companyId = companyArg, contactId = contactArg;
    if (dealId) {
      const d = (await bitrix.call('crm.deal.get', { id: dealId })).result || {};
      companyId = d.COMPANY_ID && d.COMPANY_ID !== '0' ? String(d.COMPANY_ID) : '';
      contactId = d.CONTACT_ID && d.CONTACT_ID !== '0' ? String(d.CONTACT_ID) : '';
    }
    const mine = companyId ? all.filter(x => String(x.companyId) === companyId)
      : contactId ? all.filter(x => String(x.contactId) === contactId && (!x.companyId || x.companyId === '0')) : [];
    const first = mine[0];
    let nome = first?.cliente || '';
    if (!nome && (companyId || contactId)) {
      try {
        const e = (await bitrix.call(companyId ? 'crm.company.get' : 'crm.contact.get', { id: companyId || contactId })).result || {};
        nome = companyId ? e.TITLE : [e.NAME, e.LAST_NAME].filter(Boolean).join(' ');
      } catch { /* sem nome */ }
    }
    return {
      deals: mine, kpis: kpis(mine),
      escopo: { tipo: companyId ? 'company' : contactId ? 'contact' : 'nenhum', companyId, contactId, dealId,
        nome: nome || '', doc: first?.doc || '', email: first?.email || '', telefone: first?.telefone || '', qtd: mine.length },
    };
  }

  // Painel financeiro: calcula as 3 janelas (3, 6 e 12 meses) de uma vez — trocar de filtro na tela não precisa de nova consulta.
  async function painel(scope = {}) {
    const { deals, escopo } = await estado(scope);
    const hoje = R.todayBR();
    const dashes = {};
    for (const m of [3, 6, 12]) dashes[m] = dashboard(deals, hoje, { meses: m, individual: !!escopo });
    return { escopo, dashes };
  }

  async function byId(id) { return (await dealsCached(5000)).find(d => d.id === +id); }

  const customerFor = (companyId, contactId) => customerOf({ COMPANY_ID: companyId || '0', CONTACT_ID: contactId || '0' }, new Map());
  const contracts = createContracts({
    bitrix, asaas, store, UF, enc, updateDeal, timeline, classFields,
    deals: () => loadDeals(),
  });
  const cobrar = createCobrar({
    bitrix, asaas, store, UF, enc, classFields, updateDeal, timeline, loadDeals, customerFor, contracts,
    createCharge, loadEnums, invalidate: () => { cache.at = 0; },
  });

  return {
    ensureFields, sync, quick, estado, painel, dealsCached, kpis, gerar, findCustomers, byId, loadDeals,
    createCharge, triggerReminder, updateDeal, refreshCharge, classify, loadEnums, contracts, cobrar, editar, reconcile, detalhe, receberDinheiro, estornar, payInfo,
    async expandNow(c) { const r = await contracts.expand(c, await loadDeals()); cache.at = 0; return r; },
    async importar(opts) { await loadEnums(); const r = await contracts.importFromAsaas(opts); cache.at = 0; return r; },
    async cancel(c) {
      if (c.asaasId && asaas.enabled) await asaas.cancelPayment(c.asaasId);
      await updateDeal(c.id, { STAGE_ID: R.STAGES.cancelled, [UF('CR_STATUS')]: 'DELETED' });
      await timeline(c.id, 'Cobrança cancelada pelo Contas a Receber.');
      store.log('cancelar', `Deal ${c.id} cancelada`, { deal: c.id });
      cache.at = 0;
    },
    async setDoc(id, doc) {
      if (!R.validDoc(doc)) throw new Error('CPF/CNPJ inválido');
      await updateDeal(id, { [UF('CR_DOC')]: R.digits(doc) });
      cache.at = 0;
    },
    invalidate() { cache.at = 0; },
  };
}
module.exports = { createService, FIELDS };
