'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { today, world, R } = require('../testkit/world');

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const venc = addDays(today, 15);
const base = (extra = {}) => ({ tipo: 'avulsa', companyId: '5', titulo: 'Licença Professional Vibe+', valor: 600, venc, forma: 'BOLETO', ...extra });

test('avulsa em boleto: grava link, boleto e linha digitável na deal; desconto, multa/juros e split vão ao Asaas', async () => {
  const w = world([]);
  w.store.addWallet({ nome: 'Parceiro A', walletId: 'wal-aaa' });
  const r = await w.svc.cobrar.nova(base({ desconto: { valor: 5, tipo: 'PERCENTAGE', dias: 3 }, split: 'Parceiro A=30%', categoria: 'Licença Bitrix24', plano: 'Professional Vibe+' }));
  assert.equal(r.ok, true); assert.ok(r.link.startsWith('https://asaas/i'));
  const sent = w.created[0];
  assert.equal(sent.billingType, 'BOLETO'); assert.equal(sent.value, 600); assert.equal(sent.dueDate, venc);
  assert.deepEqual(sent.discount, { value: 5, dueDateLimitDays: 3, type: 'PERCENTAGE' });
  assert.deepEqual(sent.split, [{ walletId: 'wal-aaa', percentualValue: 30 }]);
  assert.deepEqual(sent.fine, { value: 2 }); assert.deepEqual(sent.interest, { value: 1 });
  assert.match(sent.externalReference, /^bitrix-deal-\d+$/);
  const d = w.deals[0];
  assert.equal(d.STAGE_ID, R.STAGES.open); assert.equal(d.UF_CRM_CR_LINK, r.link); assert.equal(d.UF_CRM_CR_BOLETO, 'https://asaas/b');
  assert.match(d.UF_CRM_CR_LINHA, /^00190/); assert.ok(!d.UF_CRM_CR_PIX);                   // boleto não tem Pix
  assert.equal(d.UF_CRM_CR_SPLIT, 'Parceiro A=30%'); assert.equal(d.UF_CRM_CR_DOC, '11222333000181');
  assert.equal(d.UF_CRM_CR_CATEGORIA, '100'); assert.equal(d.UF_CRM_CR_PLANO, String(200 + R.PLANOS.indexOf('Professional Vibe+')));
  assert.ok(w.comments.some(c => /Cobrança emitida/.test(c.COMMENT)));
});

test('avulsa em Pix grava o "copia e cola"; Pix indisponível não derruba a emissão', async () => {
  const w = world([]);
  await w.svc.cobrar.nova(base({ forma: 'PIX' }));
  assert.match(w.deals[0].UF_CRM_CR_PIX, /^00020126PIX/);
  const w2 = world([]); w2.opts.noPix = true;
  const r = await w2.svc.cobrar.nova(base({ forma: 'PIX' }));
  assert.equal(r.ok, true); assert.ok(!w2.deals[0].UF_CRM_CR_PIX); assert.ok(w2.deals[0].UF_CRM_CR_LINK);
});

test('se o Asaas recusar, nenhum card órfão fica no Bitrix', async () => {
  const w = world([]); w.opts.failCreate = 'Customer inválido';
  await assert.rejects(() => w.svc.cobrar.nova(base()), /Customer inválido/);
  assert.equal(w.deals.length, 0);
  for (const tipo of ['parcelada', 'assinatura']) {
    await assert.rejects(() => w.svc.cobrar.nova(base({ tipo, parcelas: 3, ciclo: 'MENSAL' })), /Customer inválido/);
    assert.equal(w.deals.length, 0);
  }
});

test('parcelada no cartão usa o parcelamento do Asaas e cria 1 card por parcela ligado ao contrato', async () => {
  const w = world([]);
  const r = await w.svc.cobrar.nova(base({ tipo: 'parcelada', forma: 'CREDIT_CARD', parcelas: 3, valor: 900, titulo: 'Plano Enterprise' }));
  assert.equal(r.parcelas, 3);
  const sent = w.created[0];
  assert.equal(sent.installmentCount, 3); assert.equal(sent.totalValue, 900); assert.equal(sent.billingType, 'CREDIT_CARD');
  assert.equal(Object.keys(w.pays).length, 3);
  const master = w.deals.find(d => d.TITLE === 'Plano Enterprise');
  assert.equal(master.STAGE_ID, R.STAGES.contrato); assert.equal(master.UF_CRM_CR_QTD, 3);
  const kids = w.deals.filter(d => d.UF_CRM_CR_ORIGEM == master.ID);
  assert.deepEqual(kids.map(k => k.TITLE), ['Plano Enterprise — 1/3', 'Plano Enterprise — 2/3', 'Plano Enterprise — 3/3']);
  assert.deepEqual(kids.map(k => k.UF_CRM_CR_PARCELA), ['1/3', '2/3', '3/3']);
  assert.ok(kids.every(k => k.UF_CRM_CR_LINK && k.STAGE_ID === R.STAGES.open && k.OPPORTUNITY === 300));
  const s = await w.svc.sync();                                                                        // o sync não duplica e liga o contrato ao próximo link
  assert.equal(s.errors.length, 0, s.errors.join(';'));
  assert.equal(Object.keys(w.pays).length, 3);
  assert.equal(w.deals.find(d => d.ID == master.ID).UF_CRM_CR_LINK_PROX, kids[0].UF_CRM_CR_LINK);
});

test('assinatura: ciclo, término e máximo vão ao Asaas; gerir valor e cancelar reflete no Bitrix', async () => {
  const w = world([]); w.opts.autoFirst = true;
  const fim = addDays(venc, 400);
  const r = await w.svc.cobrar.nova(base({ tipo: 'assinatura', ciclo: 'TRIMESTRAL', valor: 250, fim, maxCobrancas: 8, forma: 'PIX', titulo: 'Mensalidade Standard' }));
  const sub = Object.values(w.subs)[0];
  assert.equal(sub.cycle, 'QUARTERLY'); assert.equal(sub.endDate, fim); assert.equal(sub.maxPayments, 8); assert.equal(sub.nextDueDate, venc); assert.equal(sub.value, 250);
  const master = w.deals.find(d => d.TITLE === 'Mensalidade Standard');
  assert.equal(master.UF_CRM_CR_ASSINATURA, sub.id); assert.equal(master.STAGE_ID, R.STAGES.contrato);
  assert.equal(w.deals.filter(d => d.UF_CRM_CR_ORIGEM == master.ID).length, 1);                        // 1ª cobrança já virou card
  w.customers.cus_1 = { id: 'cus_1', name: 'ACME Ltda' };
  const lista = await w.svc.cobrar.assinaturas();
  assert.equal(lista.length, 1); assert.equal(lista[0].cliente, 'ACME Ltda'); assert.equal(lista[0].dealId, +master.ID);
  const novoVenc = addDays(venc, 30);
  await w.svc.cobrar.editarAssinatura(sub.id, { valor: 300, vencimento: novoVenc, atualizarPendentes: true });
  assert.deepEqual(w.subUpdates[0][1], { value: 300, nextDueDate: novoVenc, updatePendingPayments: true });
  assert.equal(master.OPPORTUNITY, 300);
  await w.svc.cobrar.cancelarAssinatura(sub.id);
  assert.deepEqual(w.subCancelled, [sub.id]);
  assert.ok(w.comments.some(c => /cancelada pelo painel/.test(c.COMMENT)));
  await assert.rejects(() => w.svc.cobrar.editarAssinatura(sub.id, { valor: -5 }), /Valor inválido/);
  await assert.rejects(() => w.svc.cobrar.editarAssinatura(sub.id, { ciclo: 'DIARIO' }), /Ciclo inválido/);
  await assert.rejects(() => w.svc.cobrar.editarAssinatura(sub.id, {}), /Nada para alterar/);
});

test('validações barram erro antes de falar com o Asaas', async () => {
  const w = world([]);
  const bad = async (patch, re) => { await assert.rejects(() => w.svc.cobrar.nova(base(patch)), re); };
  await bad({ venc: addDays(today, -1) }, /passado/);
  await bad({ companyId: '', contactId: '' }, /cliente/);
  await bad({ valor: 0 }, /Valor inválido/);
  await bad({ forma: 'CHEQUE' }, /Forma de pagamento/);
  await bad({ titulo: '  ' }, /título/);
  await bad({ tipo: 'parcelada', parcelas: 1 }, /entre 2 e 60/);
  await bad({ tipo: 'parcelada', parcelas: 30, forma: 'CREDIT_CARD' }, /entre 2 e 21/);
  await bad({ tipo: 'assinatura', ciclo: 'DIARIO' }, /Ciclo/);
  await bad({ tipo: 'assinatura', ciclo: 'MENSAL', fim: venc }, /posterior/);
  await bad({ desconto: { valor: 100, tipo: 'PERCENTAGE' } }, /menor que 100/);
  await bad({ desconto: { valor: 700, tipo: 'FIXED' } }, /menor que o valor/);
  await bad({ split: 'Fulano=10%' }, /não cadastrado/);
  w.store.addWallet({ nome: 'P', walletId: 'w1' });
  await bad({ split: 'P=700' }, /excede/);
  await bad({ split: 'P=70%; P=10%' }, /mais de uma vez/);
  assert.equal(w.created.length, 0); assert.equal(w.deals.length, 0);                                  // nada foi enviado nem criado
});

test('links de pagamento: criar (avulso, parcelado, recorrente), registrar e remover', async () => {
  const w = world([]);
  const a = await w.svc.cobrar.nova({ tipo: 'link', nome: 'Renovação Bitrix24', valor: 1200, forma: 'UNDEFINED', diasVenc: 5 });
  assert.equal(a.ok, true); assert.ok(a.link.startsWith('https://asaas/l/'));
  assert.deepEqual({ ...w.links[0] }, { name: 'Renovação Bitrix24', billingType: 'UNDEFINED', chargeType: 'DETACHED', notificationEnabled: true, value: 1200, dueDateLimitDays: 5 });
  await w.svc.cobrar.nova({ tipo: 'link', nome: 'Plano em até 12x', forma: 'CREDIT_CARD', tipoCobranca: 'INSTALLMENT', maxParcelas: 12 });
  await w.svc.cobrar.nova({ tipo: 'link', nome: 'Assinatura mensal', forma: 'BOLETO', tipoCobranca: 'RECURRENT', ciclo: 'MENSAL', valor: 99.9 });
  assert.equal(w.links[1].maxInstallmentCount, 12); assert.equal(w.links[2].subscriptionCycle, 'MONTHLY'); assert.ok(!('value' in w.links[1]));
  assert.equal(w.store.links.length, 3);
  await assert.rejects(() => w.svc.cobrar.nova({ tipo: 'link', nome: 'x', tipoCobranca: 'INSTALLMENT', maxParcelas: 1 }), /entre 2 e 21/);
  await assert.rejects(() => w.svc.cobrar.nova({ tipo: 'link', nome: '' }), /nome do link/);
  await w.svc.cobrar.removerLink('lnk_1');
  assert.deepEqual(w.deletedLinks, ['lnk_1']); assert.equal(w.store.links.length, 2);
});

test('detalhe da cobrança, receber em dinheiro e estorno', async () => {
  const w = world([]); w.store.addWallet({ nome: 'Parceiro A', walletId: 'wal-aaa' });
  await w.svc.cobrar.nova(base({ forma: 'UNDEFINED', split: 'Parceiro A=10%' }));
  const pid = w.deals[0].UF_CRM_CR_ASAAS_ID;
  w.pays[pid].split = [{ walletId: 'wal-aaa', percentualValue: 10, status: 'PENDING' }];
  w.deals[0].UF_CRM_CR_PIX = ''; w.deals[0].UF_CRM_CR_LINHA = '';
  let c = (await w.svc.dealsCached(0))[0];
  const d = await w.svc.detalhe(c);
  assert.equal(d.id, pid); assert.equal(d.ativa, true); assert.equal(d.paga, false);
  assert.match(d.pix, /^00020126PIX/); assert.match(d.linha, /^00190/); assert.equal(d.pixImagem, 'iVBORw0KGgo');
  assert.deepEqual(d.split, [{ nome: 'Parceiro A', walletId: 'wal-aaa', percentual: 10, fixo: null, status: 'PENDING' }]);
  assert.match(w.deals[0].UF_CRM_CR_PIX, /^00020126PIX/);                                              // detalhe também grava na deal
  await assert.rejects(() => w.svc.estornar(c, {}), /Só dá para estornar cobrança paga/);
  await assert.rejects(() => w.svc.receberDinheiro(c, { data: addDays(today, 2) }), /não pode ser futura/);
  await w.svc.receberDinheiro(c, { data: today, valor: 600, notificar: false });
  assert.deepEqual(w.receipts[0], [pid, { paymentDate: today, value: 600, notifyCustomer: false }]);
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.paid);
  c = (await w.svc.dealsCached(0))[0];
  await assert.rejects(() => w.svc.receberDinheiro(c, {}), /já está/);
  await assert.rejects(() => w.svc.estornar(c, { valor: 9999 }), /Valor do estorno inválido/);
  await w.svc.estornar(c, { valor: 100, motivo: 'Cobrança em duplicidade' });
  assert.deepEqual(w.refunds[0], [pid, { value: 100, description: 'Cobrança em duplicidade' }]);
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.cancelled);
});

test('split pode vir escrito na deal do Bitrix e é aplicado na emissão (inclusive nas parcelas de contrato)', async () => {
  const w = world([{ ID: '9', TITLE: 'Venda', STAGE_ID: R.STAGES.open, OPPORTUNITY: '400', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_VENC: venc + 'T00:00:00+03:00', UF_CRM_CR_SPLIT: 'Parceiro A=25%; Parceiro B=R$ 40,00' }]);
  w.store.addWallet({ nome: 'Parceiro A', walletId: 'wal-aaa' }); w.store.addWallet({ nome: 'Parceiro B', walletId: 'wal-bbb' });
  const r = await w.svc.sync();
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.deepEqual(w.created[0].split, [{ walletId: 'wal-aaa', percentualValue: 25 }, { walletId: 'wal-bbb', fixedValue: 40 }]);
  const w2 = world([{ ID: '9', TITLE: 'Venda', STAGE_ID: R.STAGES.open, OPPORTUNITY: '400', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_VENC: venc + 'T00:00:00+03:00', UF_CRM_CR_SPLIT: 'Desconhecido=25%' }]);
  const r2 = await w2.svc.sync();
  assert.equal(w2.created.length, 0); assert.ok(r2.errors.some(e => /não cadastrado/.test(e)));       // recebedor inexistente: não emite
});
