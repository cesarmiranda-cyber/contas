'use strict';
const R = require('./rules');

// Nova cobrança de qualquer tipo + gestão de assinaturas e links de pagamento.
// Todo valor é validado aqui antes de qualquer chamada ao Asaas (que cobra de verdade em produção).
const CICLOS = { SEMANAL: 'WEEKLY', QUINZENAL: 'BIWEEKLY', MENSAL: 'MONTHLY', BIMESTRAL: 'BIMONTHLY', TRIMESTRAL: 'QUARTERLY', SEMESTRAL: 'SEMIANNUALLY', ANUAL: 'YEARLY' };
const CICLO_API = new Set(Object.values(CICLOS));
const FORMAS_API = new Set(R.FORMAS.map(f => f.code));
const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function createCobrar(ctx) {
  const { bitrix, asaas, store, UF, enc, classFields, updateDeal, timeline, loadDeals, customerFor, createCharge, contracts, loadEnums, parceiros } = ctx;
  const need = () => { if (!asaas.enabled) throw fail(400, 'Asaas não configurado (Configurações → Integração com o Asaas).'); };

  function discountOf(d, valor) {
    if (!d || !(Number(d.valor) > 0)) return null;
    const type = d.tipo === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED';
    const v = Number(d.valor), dias = Math.max(0, Math.min(30, parseInt(d.dias ?? 0, 10) || 0));
    if (type === 'PERCENTAGE' && v >= 100) throw fail(400, 'Desconto percentual deve ser menor que 100%.');
    if (type === 'FIXED' && v >= Number(valor)) throw fail(400, 'Desconto fixo deve ser menor que o valor da cobrança.');
    return { value: v, dueDateLimitDays: dias, type };
  }
  // Lê o split contra parceiros e carteiras. Devolve a parte NATIVA (com walletId) que o Asaas executa; a manual vira título a pagar.
  async function splitOf(text, valor, { soNativo = false } = {}) {
    let ps = []; try { ps = await parceiros(); } catch { /* sem cadastro */ }
    let entries;
    try { entries = R.parseRepasses(text, { partners: ps, wallets: store.wallets }); } catch (e) { throw fail(400, e.message); }
    const fixo = entries.reduce((a, s) => a + (s.fixedValue || 0), 0);
    if (valor && fixo > Number(valor)) throw fail(400, `O split fixo (R$ ${fixo.toFixed(2)}) excede o valor da cobrança.`);
    if (soNativo && entries.some(e => !e.walletId)) throw fail(400, 'Link de pagamento só aceita recebedores com walletId (split automático do Asaas). Parceiro sem walletId recebe por repasse manual, que depende de uma cobrança com card no funil.');
    return R.nativeSplit(entries);
  }

  function checkCommon(sp) {
    if (!['avulsa', 'parcelada', 'assinatura'].includes(sp.tipo)) throw fail(400, 'Tipo de cobrança inválido');
    if (!FORMAS_API.has(sp.forma || 'UNDEFINED')) throw fail(400, 'Forma de pagamento inválida');
    if (!(Number(sp.valor) > 0)) throw fail(400, 'Valor inválido');
    if (!sp.companyId && !sp.contactId) throw fail(400, 'Selecione o cliente (empresa ou contato do Bitrix).');
    if (!String(sp.titulo || '').trim()) throw fail(400, 'Informe o título/descrição da cobrança.');
    if (!isDay(sp.venc)) throw fail(400, 'Informe o vencimento.');
    if (sp.venc < R.todayBR()) throw fail(400, 'O vencimento não pode estar no passado.');
  }

  async function prepare(sp) {
    checkCommon(sp);
    need();
    await loadEnums();                       // ids das listas (forma, tipo, categoria) precisam estar carregados antes de montar a deal
    const cust = await customerFor(sp.companyId, sp.contactId);
    const doc = R.validDoc(sp.doc) ? R.digits(sp.doc) : cust.doc;
    if (!doc) throw fail(400, 'O cliente não tem CPF/CNPJ válido. Informe o documento no formulário.');
    const forma = sp.forma || 'UNDEFINED';
    const valor = Number(sp.valor);
    const splitText = sp.split ? String(sp.split).trim() : '';
    const splitList = splitText ? await splitOf(splitText, valor) : [];
    const discount = discountOf(sp.desconto, valor);
    return { cust: { ...cust, doc }, forma, valor, splitText, splitList, discount };
  }

  const baseFields = (sp, p, tipo, stage, extra = {}) => ({
    TITLE: String(sp.titulo).trim().slice(0, 255), CATEGORY_ID: R.CATEGORY_ID, STAGE_ID: stage,
    OPPORTUNITY: p.valor, CURRENCY_ID: 'BRL', IS_MANUAL_OPPORTUNITY: 'Y',
    ...(sp.companyId ? { COMPANY_ID: sp.companyId } : {}), ...(sp.contactId ? { CONTACT_ID: sp.contactId } : {}),
    [UF('CR_VENC')]: sp.venc, [UF('CR_FORMA')]: enc('forma', p.forma), [UF('CR_TIPO')]: enc('tipo', tipo), [UF('CR_DOC')]: p.cust.doc,
    ...(p.splitText ? { [UF('CR_SPLIT')]: p.splitText } : {}),
    ...Object.fromEntries(Object.entries(classFields(sp.categoria || '', sp.plano || '')).filter(([, v]) => v)),
    ...extra,
  });
  const delDeal = async id => { try { await bitrix.call('crm.deal.delete', { id }); } catch { /* melhor esforço */ } };
  const bodyExtras = (p, cfg) => ({
    ...(cfg.multaPct ? { fine: { value: cfg.multaPct } } : {}), ...(cfg.jurosMensalPct ? { interest: { value: cfg.jurosMensalPct } } : {}),
    ...(p.discount ? { discount: p.discount } : {}), ...(p.splitList.length ? { split: p.splitList } : {}),
  });

  // ---- cobrança avulsa: 1 card + 1 cobrança ----
  async function avulsa(sp, p) {
    const dealId = (await bitrix.call('crm.deal.add', { fields: baseFields(sp, p, 'UNICA', R.STAGES.open), params: { REGISTER_SONET_EVENT: 'N' } })).result;
    try {
      const c = (await loadDeals()).find(d => d.id === +dealId);
      await createCharge(c, { discount: p.discount, splitList: p.splitList });
      return { dealId: +dealId, link: c.link, boleto: c.boleto, pix: c.pix, linha: c.linha, asaasId: c.asaasId };
    } catch (e) {
      // Se a cobrança chegou a ser emitida no Asaas, cancela antes de apagar o card (senão o cliente recebe uma cobrança sem registro).
      try { const ex = await asaas.listPayments({ externalReference: `bitrix-deal-${dealId}`, limit: 1 }); if (ex.data?.[0]) await asaas.cancelPayment(ex.data[0].id); } catch { /* melhor esforço */ }
      await delDeal(dealId); throw e;
    }
  }

  // ---- parcelada (plano do Asaas: boleto/Pix em N vezes ou cartão parcelado) ----
  async function parcelada(sp, p) {
    const n = parseInt(sp.parcelas, 10);
    const max = p.forma === 'CREDIT_CARD' ? 21 : 60;
    if (!(n >= 2 && n <= max)) throw fail(400, `Nº de parcelas deve ficar entre 2 e ${max}.`);
    const masterId = (await bitrix.call('crm.deal.add', { fields: baseFields(sp, p, 'PARCELADO', R.STAGES.contrato, { [UF('CR_QTD')]: n }), params: { REGISTER_SONET_EVENT: 'N' } })).result;
    let pay;
    try {
      const cus = await asaas.findOrCreateCustomer({ name: p.cust.nome, cpfCnpj: p.cust.doc, email: p.cust.email, phone: p.cust.telefone });
      pay = await asaas.createPayment({
        customer: cus.id, billingType: p.forma, installmentCount: n, totalValue: p.valor, dueDate: sp.venc,
        description: String(sp.titulo).trim().slice(0, 500), externalReference: `bitrix-contract-${masterId}`, ...bodyExtras(p, store.config),
      });
    } catch (e) { await delDeal(masterId); throw e; }
    try {
      const inst = pay.installment;
      const list = inst ? ((await asaas.installmentPayments(inst)).data || []) : [pay];
      list.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
      const all = await loadDeals();
      const master = all.find(d => d.id === +masterId);
      const kids = [];
      for (let i = 0; i < list.length; i++) { const r = await contracts.cardFromPayment(list[i], { master, all, label: `${i + 1}/${list.length}` }); if (r) kids.push(r.id); }
      await updateDeal(masterId, { [UF('CR_FILHOS')]: kids.join(',') });
      await timeline(masterId, `Parcelamento criado no Asaas (${inst || pay.id}): ${list.length}x de R$ ${list[0].value}. Cards: ${kids.join(', ')}.`);
      store.log('cobranca', `Parcelamento ${inst || pay.id} criado (${list.length}x) para deal ${masterId}`, { deal: +masterId });
      return { dealId: +masterId, parcelas: list.length, filhos: kids, link: list[0].invoiceUrl };
    } catch (e) {
      throw fail(502, `A cobrança foi criada no Asaas (${pay.installment || pay.id}), mas houve erro ao criar os cards no Bitrix: ${e.message}. Use "Importar do Asaas" para trazê-los.`);
    }
  }

  // ---- assinatura ----
  async function assinatura(sp, p) {
    const cycle = CICLOS[sp.ciclo] || (CICLO_API.has(sp.ciclo) ? sp.ciclo : '');
    if (!cycle) throw fail(400, 'Ciclo da assinatura inválido');
    const maxPay = sp.maxCobrancas ? parseInt(sp.maxCobrancas, 10) : 0;
    if (sp.maxCobrancas && !(maxPay >= 1)) throw fail(400, 'Nº máximo de cobranças inválido');
    if (sp.fim && (!isDay(sp.fim) || sp.fim <= sp.venc)) throw fail(400, 'A data de término deve ser posterior ao 1º vencimento.');
    const masterId = (await bitrix.call('crm.deal.add', { fields: baseFields(sp, p, 'RECORRENTE', R.STAGES.contrato, maxPay ? { [UF('CR_QTD')]: maxPay } : {}), params: { REGISTER_SONET_EVENT: 'N' } })).result;
    let sub;
    try {
      const cus = await asaas.findOrCreateCustomer({ name: p.cust.nome, cpfCnpj: p.cust.doc, email: p.cust.email, phone: p.cust.telefone });
      sub = await asaas.createSubscription({
        customer: cus.id, billingType: p.forma, value: p.valor, nextDueDate: sp.venc, cycle,
        description: String(sp.titulo).trim().slice(0, 500), externalReference: `bitrix-contract-${masterId}`,
        ...(sp.fim ? { endDate: sp.fim } : {}), ...(maxPay ? { maxPayments: maxPay } : {}), ...bodyExtras(p, store.config),
      });
    } catch (e) { await delDeal(masterId); throw e; }
    try {
      await updateDeal(masterId, { [UF('CR_ASSINATURA')]: sub.id });
      const all = await loadDeals();
      const master = all.find(d => d.id === +masterId);
      const pays = (await asaas.subscriptionPayments(sub.id)).data || [];
      const kids = [];
      for (const pay of pays) { const r = await contracts.cardFromPayment(pay, { master, all }); if (r) kids.push(r.id); }
      await updateDeal(masterId, { [UF('CR_FILHOS')]: kids.join(',') });
      await timeline(masterId, `Assinatura criada no Asaas (${sub.id}) · ${sp.ciclo || cycle} · R$ ${p.valor.toFixed(2)}. Novas cobranças viram cards automaticamente.`);
      store.log('cobranca', `Assinatura ${sub.id} criada para deal ${masterId}`, { deal: +masterId });
      return { dealId: +masterId, assinatura: sub.id, filhos: kids, link: pays[0]?.invoiceUrl || '' };
    } catch (e) {
      throw fail(502, `A assinatura foi criada no Asaas (${sub.id}), mas houve erro ao criar os cards no Bitrix: ${e.message}. Use "Importar do Asaas" para trazê-los.`);
    }
  }

  async function nova(sp) {
    if (sp.tipo === 'link') return criarLink(sp);
    const p = await prepare(sp);
    const out = sp.tipo === 'avulsa' ? await avulsa(sp, p) : sp.tipo === 'parcelada' ? await parcelada(sp, p) : await assinatura(sp, p);
    ctx.invalidate();
    return { ok: true, tipo: sp.tipo, ...out };
  }

  // ---- links de pagamento reutilizáveis ----
  async function criarLink(sp) {
    need();
    const nome = String(sp.nome || sp.titulo || '').trim();
    if (!nome) throw fail(400, 'Informe o nome do link.');
    const forma = sp.forma || 'UNDEFINED';
    if (!FORMAS_API.has(forma)) throw fail(400, 'Forma de pagamento inválida');
    const chargeType = ['DETACHED', 'RECURRENT', 'INSTALLMENT'].includes(sp.tipoCobranca) ? sp.tipoCobranca : 'DETACHED';
    const body = { name: nome.slice(0, 255), billingType: forma, chargeType, notificationEnabled: sp.notificar !== false };
    if (sp.descricao) body.description = String(sp.descricao).slice(0, 500);
    if (sp.valor !== undefined && sp.valor !== '' && sp.valor !== null) { if (!(Number(sp.valor) > 0)) throw fail(400, 'Valor inválido'); body.value = Number(sp.valor); }
    if (chargeType === 'RECURRENT') {
      const cycle = CICLOS[sp.ciclo] || (CICLO_API.has(sp.ciclo) ? sp.ciclo : '');
      if (!cycle) throw fail(400, 'Ciclo da assinatura inválido');
      body.subscriptionCycle = cycle;
    }
    if (chargeType === 'INSTALLMENT') {
      const m = parseInt(sp.maxParcelas, 10);
      if (!(m >= 2 && m <= 21)) throw fail(400, 'Máximo de parcelas deve ficar entre 2 e 21.');
      body.maxInstallmentCount = m;
    }
    if (sp.diasVenc !== undefined && sp.diasVenc !== '') { const d = parseInt(sp.diasVenc, 10); if (!(d >= 1 && d <= 365)) throw fail(400, 'Dias para vencer inválido'); body.dueDateLimitDays = d; }
    if (sp.fim) { if (!isDay(sp.fim) || sp.fim < R.todayBR()) throw fail(400, 'Data de término inválida'); body.endDate = sp.fim; }
    if (sp.split) { body.split = await splitOf(String(sp.split), body.value, { soNativo: true }); }
    const r = await asaas.createPaymentLink(body);
    store.addLink({ id: r.id, nome: body.name, url: r.url, tipo: chargeType, valor: body.value || null, forma, criado: new Date().toISOString(), split: sp.split ? String(sp.split) : '' });
    store.log('cobranca', `Link de pagamento criado: ${body.name}`);
    return { ok: true, tipo: 'link', id: r.id, link: r.url };
  }
  async function removerLink(id) {
    need();
    try { await asaas.deletePaymentLink(id); } catch (e) { if (e.status !== 404) throw e; }
    store.removeLink(id);
    store.log('cobranca', `Link de pagamento removido: ${id}`);
    return { ok: true };
  }

  // ---- assinaturas: listar, editar, cancelar ----
  const custNames = new Map();
  async function assinaturas({ status } = {}) {
    need();
    const subs = await asaas.allSubscriptions(status ? { status } : {});
    const deals = await loadDeals({ lite: true });
    const masterOf = id => deals.find(d => d.assinatura === id);
    const out = [];
    for (const s of subs) {
      const m = masterOf(s.id);
      let nome = m?.cliente || custNames.get(s.customer);
      if (!nome) { try { nome = (await asaas.getCustomer(s.customer)).name || ''; custNames.set(s.customer, nome); } catch { nome = ''; } }
      out.push({ id: s.id, status: s.status, valor: s.value, ciclo: s.cycle, proximoVenc: s.nextDueDate, forma: s.billingType, descricao: s.description || '', fim: s.endDate || '', cliente: nome, dealId: m?.id || null, criada: s.dateCreated || '' });
    }
    return out.sort((a, b) => String(a.proximoVenc).localeCompare(String(b.proximoVenc)));
  }
  async function editarAssinatura(id, p) {
    need();
    const body = {};
    if (p.valor !== undefined) { if (!(Number(p.valor) > 0)) throw fail(400, 'Valor inválido'); body.value = Number(p.valor); }
    if (p.vencimento !== undefined && p.vencimento !== '') { if (!isDay(p.vencimento) || p.vencimento < R.todayBR()) throw fail(400, 'Próximo vencimento inválido'); body.nextDueDate = p.vencimento; }
    if (p.ciclo !== undefined && p.ciclo !== '') { const c = CICLOS[p.ciclo] || (CICLO_API.has(p.ciclo) ? p.ciclo : ''); if (!c) throw fail(400, 'Ciclo inválido'); body.cycle = c; }
    if (p.forma !== undefined && p.forma !== '') { if (!FORMAS_API.has(p.forma)) throw fail(400, 'Forma de pagamento inválida'); body.billingType = p.forma; }
    if (p.descricao !== undefined) body.description = String(p.descricao).slice(0, 500);
    if (p.status !== undefined && p.status !== '') { if (!['ACTIVE', 'INACTIVE'].includes(p.status)) throw fail(400, 'Status inválido'); body.status = p.status; }
    if (!Object.keys(body).length) throw fail(400, 'Nada para alterar');
    if (p.atualizarPendentes) body.updatePendingPayments = true;
    const sub = await asaas.updateSubscription(id, body);
    const m = (await loadDeals({ lite: true })).find(d => d.assinatura === id);
    if (m) {
      const f = {};
      if (body.value) { f.OPPORTUNITY = body.value; f.IS_MANUAL_OPPORTUNITY = 'Y'; }
      if (body.billingType) f[UF('CR_FORMA')] = enc('forma', body.billingType);
      if (Object.keys(f).length) await updateDeal(m.id, f);
      await timeline(m.id, `Assinatura alterada pelo painel: ${Object.keys(body).filter(k => k !== 'updatePendingPayments').join(', ')}${body.updatePendingPayments ? ' (cobranças pendentes também atualizadas)' : ''}.`);
    }
    store.log('cobranca', `Assinatura ${id} alterada: ${Object.keys(body).join(', ')}`, m ? { deal: m.id } : undefined);
    ctx.invalidate();
    return { ok: true, assinatura: { id: sub.id, status: sub.status, valor: sub.value, proximoVenc: sub.nextDueDate } };
  }
  async function cancelarAssinatura(id) {
    need();
    await asaas.cancelSubscription(id);
    const m = (await loadDeals({ lite: true })).find(d => d.assinatura === id);
    if (m) await timeline(m.id, `Assinatura ${id} cancelada pelo painel. As cobranças pendentes dela são canceladas no Asaas.`);
    store.log('cobranca', `Assinatura ${id} cancelada`, m ? { deal: m.id } : undefined);
    ctx.invalidate();
    return { ok: true };
  }

  return { nova, criarLink, removerLink, assinaturas, editarAssinatura, cancelarAssinatura, CICLOS };
}
module.exports = { createCobrar, CICLOS };
