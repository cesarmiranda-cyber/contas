'use strict';
const R = require('./rules');

// Card do contrato (etapa "Gerar cobranças") -> cards por parcela + cobranças no Asaas,
// e importação do que existe no Asaas e ainda não tem card no Bitrix.
function createContracts(ctx) {
  const { bitrix, asaas, store, UF, enc, updateDeal, timeline } = ctx;
  const lastError = new Map(); // dealId -> última mensagem comentada (evita repetir comentário a cada sync)

  async function moveTo(c, stageId, extra = {}) {
    await updateDeal(c.id, { STAGE_ID: stageId, ...extra });
    c.stageId = stageId;
  }

  function childFields(master, s, of) {
    return {
      TITLE: `${master.titulo} — ${s.n}/${of}`,
      CATEGORY_ID: R.CATEGORY_ID, STAGE_ID: R.STAGES.open,
      OPPORTUNITY: s.value, CURRENCY_ID: master.moeda || 'BRL', IS_MANUAL_OPPORTUNITY: 'Y',
      ...(master.responsavel ? { ASSIGNED_BY_ID: master.responsavel } : {}),
      ...(master.companyId && master.companyId !== '0' ? { COMPANY_ID: master.companyId } : {}),
      ...(master.contactId && master.contactId !== '0' ? { CONTACT_ID: master.contactId } : {}),
      [UF('CR_VENC')]: s.due, [UF('CR_FORMA')]: enc('forma', master.forma || 'UNDEFINED'),
      [UF('CR_TIPO')]: enc('tipo', master.tipo), [UF('CR_PARCELA')]: s.label || `${s.n}/${of}`,
      [UF('CR_ORIGEM')]: master.id, [UF('CR_DOC')]: master.doc,
      ...(master.categoriaId ? { [UF('CR_CATEGORIA')]: master.categoriaId } : {}),
      ...(master.planoId ? { [UF('CR_PLANO')]: master.planoId } : {}),
    };
  }

  // Expande um contrato. `all` = todos os cards do funil (para achar filhos já criados).
  async function expand(c, all) {
    const probs = R.contractIssues({ ...c, hojeRef: R.todayBR() });
    if (probs.length) {
      const msg = `Não foi possível gerar as cobranças. Falta: ${probs.join('; ')}.`;
      if (lastError.get(c.id) !== msg) { lastError.set(c.id, msg); await timeline(c.id, msg); store.log('contrato', `Deal ${c.id}: ${msg}`, { deal: c.id }); }
      return { ok: false, motivo: msg };
    }
    lastError.delete(c.id);
    const created = [];
    const kids = all.filter(d => String(d.origem) === String(c.id));

    if (c.tipo === 'RECORRENTE' && !c.qtd) {
      // mensalidade sem fim -> assinatura no Asaas; os cards vêm das cobranças que ela gera
      if (!asaas.enabled) return { ok: false, motivo: 'Asaas não configurado' };
      let subId = c.assinatura;
      if (!subId) {
        const cus = await asaas.findOrCreateCustomer({ name: c.cliente, cpfCnpj: c.doc, email: c.email, phone: c.telefone });
        const cfg = store.config;
        const sub = await asaas.createSubscription({
          customer: cus.id, billingType: c.forma || 'UNDEFINED', value: c.valor, nextDueDate: c.venc, cycle: 'MONTHLY',
          description: c.titulo.slice(0, 500), externalReference: `bitrix-contract-${c.id}`,
          ...(cfg.multaPct ? { fine: { value: cfg.multaPct } } : {}), ...(cfg.jurosMensalPct ? { interest: { value: cfg.jurosMensalPct } } : {}),
        });
        subId = sub.id;
        await updateDeal(c.id, { [UF('CR_ASSINATURA')]: subId });
        c.assinatura = subId;
      }
      const pays = (await asaas.subscriptionPayments(subId)).data || [];
      for (const p of pays) { const r = await cardFromPayment(p, { master: c, all }); if (r) created.push(r.id); }
      await moveTo(c, R.STAGES.contrato, { [UF('CR_FILHOS')]: created.join(',') });
      await timeline(c.id, `Assinatura mensal criada no Asaas (${subId}). Cobranças acompanhadas automaticamente; novos meses viram cards sozinhos.`);
      store.log('contrato', `Deal ${c.id}: assinatura ${subId} criada (${created.length} card(s))`, { deal: c.id });
      return { ok: true, assinatura: subId, filhos: created };
    }

    const sched = R.buildSchedule({ total: c.valor, parcelas: c.qtd, mensal: c.qtd, primeiroVenc: c.venc, tipo: c.tipo });
    for (const s of sched) {
      const label = `${s.n}/${s.of}`;
      const have = kids.find(k => k.parcela === label);
      if (have) { created.push(have.id); continue; }
      const r = await bitrix.call('crm.deal.add', { fields: childFields(c, { ...s, label }, s.of), params: { REGISTER_SONET_EVENT: 'N' } });
      created.push(r.result);
    }
    await moveTo(c, R.STAGES.contrato, { [UF('CR_FILHOS')]: created.join(',') });
    await timeline(c.id, `Contrato expandido em ${created.length} cobrança(s): cards ${created.join(', ')}. As cobranças no Asaas são emitidas a seguir.`);
    store.log('contrato', `Deal ${c.id} expandido em ${created.length} card(s)`, { deal: c.id });
    return { ok: true, filhos: created };
  }

  // ---------- Asaas -> Bitrix ----------
  const custMemo = new Map(); // asaasCustomerId -> { companyId, contactId, doc, nome }

  async function bitrixEntityFor(cus) {
    const doc = R.digits(cus.cpfCnpj);
    const key = doc || cus.id;
    const known = store.customerMap()[key];
    if (known) return known;
    let found = null;
    if (doc) {
      const isCnpj = doc.length === 14;
      try {
        const rq = await bitrix.call('crm.requisite.list', { filter: { [isCnpj ? 'RQ_CNPJ' : 'RQ_CPF']: doc }, select: ['ENTITY_TYPE_ID', 'ENTITY_ID'] });
        const r = (rq.result || [])[0];
        if (r) found = r.ENTITY_TYPE_ID == 4 ? { companyId: r.ENTITY_ID } : r.ENTITY_TYPE_ID == 3 ? { contactId: r.ENTITY_ID } : null;
      } catch { /* sem requisitos */ }
    }
    if (!found && cus.email) {
      try {
        const d = await bitrix.call('crm.duplicate.findbycomm', { type: 'EMAIL', values: [cus.email] });
        const res = d.result || {};
        if (res.COMPANY?.length) found = { companyId: res.COMPANY[0] };
        else if (res.CONTACT?.length) found = { contactId: res.CONTACT[0] };
      } catch { /* sem duplicidade */ }
    }
    if (!found) {
      const multi = (arr, v) => (v ? [{ VALUE: v, VALUE_TYPE: 'WORK' }] : undefined);
      if (doc.length === 14 || !doc) {
        const r = await bitrix.call('crm.company.add', { fields: { TITLE: cus.name || `Cliente Asaas ${cus.id}`, EMAIL: multi('e', cus.email), PHONE: multi('p', cus.mobilePhone || cus.phone) } });
        found = { companyId: r.result };
      } else {
        const [first, ...rest] = String(cus.name || 'Cliente Asaas').split(' ');
        const r = await bitrix.call('crm.contact.add', { fields: { NAME: first, LAST_NAME: rest.join(' '), EMAIL: multi('e', cus.email), PHONE: multi('p', cus.mobilePhone || cus.phone) } });
        found = { contactId: r.result };
      }
      store.log('cliente', `Cliente criado no Bitrix a partir do Asaas: ${cus.name} (${doc || cus.id})`);
    }
    store.setCustomer(key, found);
    return found;
  }

  async function cardFromPayment(p, { master = null, all = [], dryRun = false, label = '' } = {}) {
    // já existe card para esta cobrança?
    const mine = all.find(d => d.asaasId === p.id);
    if (mine) return { id: mine.id, created: false };
    const ref = String(p.externalReference || '');
    const m = ref.match(/^bitrix-deal-(\d+)$/);
    if (m) { const d = all.find(x => x.id === +m[1]); if (d) return { id: d.id, created: false }; }
    if (p.status === 'DELETED') return null;
    let origem = master;
    if (!origem && p.subscription) origem = all.find(d => d.assinatura === p.subscription) || null;
    const state = R.mapAsaasStatus(p.status);
    const stage = R.stageFor(state, p.dueDate, R.todayBR(), store.config.diasProximo);
    if (dryRun) return { created: true, preview: { asaasId: p.id, valor: p.value, venc: p.dueDate, status: p.status, descricao: p.description || '' } };

    let cus = custMemo.get(p.customer);
    if (!cus) { cus = await asaas.getCustomer(p.customer); custMemo.set(p.customer, cus); }
    const who = origem ? { companyId: origem.companyId, contactId: origem.contactId } : await bitrixEntityFor(cus);
    const titulo = origem ? (label ? `${origem.titulo} — ${label}` : `${origem.titulo} — mensal ${String(p.dueDate).slice(0, 7)}`) : (String(p.description || '').replace(/\s+/g, ' ').trim() || `Cobrança Asaas ${p.id}`).slice(0, 200);
    const guess = R.guessClass(titulo);
    const fields = {
      TITLE: titulo, CATEGORY_ID: R.CATEGORY_ID, STAGE_ID: stage,
      OPPORTUNITY: p.value, CURRENCY_ID: 'BRL', IS_MANUAL_OPPORTUNITY: 'Y',
      ...(who.companyId && who.companyId !== '0' ? { COMPANY_ID: who.companyId } : {}),
      ...(who.contactId && who.contactId !== '0' ? { CONTACT_ID: who.contactId } : {}),
      ...(origem?.responsavel ? { ASSIGNED_BY_ID: origem.responsavel } : {}),
      [UF('CR_ASAAS_ID')]: p.id, [UF('CR_LINK')]: p.invoiceUrl || '', [UF('CR_STATUS')]: p.status,
      [UF('CR_VENC')]: p.dueDate, [UF('CR_FORMA')]: enc('forma', p.billingType), [UF('CR_VALOR_ASAAS')]: p.value,
      [UF('CR_DOC')]: R.digits(cus.cpfCnpj), [UF('CR_TIPO')]: enc('tipo', p.subscription ? 'RECORRENTE' : p.installment ? 'PARCELADO' : 'UNICA'),
      ...(label ? { [UF('CR_PARCELA')]: label } : p.installmentNumber ? { [UF('CR_PARCELA')]: String(p.installmentNumber) } : {}),
      ...(state === 'paid' && (p.clientPaymentDate || p.paymentDate) ? { [UF('CR_PAGO_EM')]: R.toDay(p.clientPaymentDate || p.paymentDate) } : {}),
      ...(origem ? { [UF('CR_ORIGEM')]: origem.id } : {}),
      ...(origem?.categoriaId ? { [UF('CR_CATEGORIA')]: origem.categoriaId } : {}),
      ...(origem?.planoId ? { [UF('CR_PLANO')]: origem.planoId } : {}),
    };
    if (!origem && guess.categoria) Object.assign(fields, ctx.classFields(guess.categoria, guess.plano));
    const r = await bitrix.call('crm.deal.add', { fields, params: { REGISTER_SONET_EVENT: 'N' } });
    await timeline(r.result, `Card criado a partir do Asaas (${p.id}) · ${p.status} · vence ${p.dueDate}.`);
    store.log('importar', `Asaas ${p.id} → card ${r.result} (${titulo})`, { deal: r.result });
    all.push({ id: +r.result, asaasId: p.id, origem: origem?.id || '', parcela: '' });
    return { id: +r.result, created: true };
  }

  // Cobranças do Asaas sem card no Bitrix (janela em dias, pelo vencimento).
  async function importFromAsaas({ dias, dryRun = false } = {}) {
    if (!asaas.enabled) throw new Error('Asaas não configurado');
    const d = Math.max(1, Math.min(730, Number(dias || store.config.importDias)));
    const since = new Date(Date.now() - d * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const all = await ctx.deals();
    const pays = await asaas.allPayments({ 'dueDate[ge]': since });
    const novos = [];
    for (const p of pays) {
      const r = await cardFromPayment(p, { all, dryRun });
      if (r?.created) novos.push(dryRun ? r.preview : r.id);
    }
    return { dias: d, desde: since, analisadas: pays.length, novos: novos.length, itens: dryRun ? novos : undefined };
  }

  return { expand, importFromAsaas, cardFromPayment, bitrixEntityFor };
}
module.exports = { createContracts };
