'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FORMA_ID, TIPO_ID, today, world, R } = require('../testkit/world');

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const WALLET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const recebivel = (extra = {}) => ({ ID: '1', TITLE: 'Licença Professional', STAGE_ID: R.STAGES.open, OPPORTUNITY: '1000', COMPANY_ID: '5', CONTACT_ID: '0', ASSIGNED_BY_ID: '1',
  UF_CRM_CR_FORMA: FORMA_ID('PIX'), UF_CRM_CR_TIPO: TIPO_ID('UNICA'), UF_CRM_CR_VENC: addDays(today, 20) + 'T00:00:00+03:00', ...extra });
async function pronto(initial = []) { const w = world(initial); await w.svc.pagar.ensure(); return w; }
const contas = w => w.svc.pagar.contas();

test('prepara o funil "Contas a Pagar" (etapas do plano), campos de contas e de parceiros — e é idempotente', async () => {
  const w = world([]);
  const r = await w.svc.pagar.ensure();
  assert.equal(w.categories.filter(c => c.NAME === 'Contas a Pagar').length, 1);
  const ap = w.store.ap;
  assert.deepEqual(Object.keys(ap.stages).sort(), ['aguardando', 'cancelled', 'late', 'open', 'paid', 'soon']);
  const ent = w.statuses['DEAL_STAGE_' + ap.categoryId];
  assert.deepEqual(ent.map(s => s.NAME).sort(), ['A pagar', 'Aguardando recebimento', 'Atrasado', 'Cancelado', 'Pago', 'Próximo do Vencimento']);   // etapas padrão extras foram removidas
  assert.ok(ent.every(s => !/EXECUTING|FINAL_INVOICE|APOLOGY/.test(s.STATUS_ID)));
  assert.ok(w.dealFields.some(f => f.FIELD_NAME === 'UF_CRM_CP_ORIGEM') && w.companyFields.some(f => f.FIELD_NAME === 'UF_CRM_PAR_WALLET'));
  assert.ok(r.campos.length >= 20);
  const antes = { cats: w.categories.length, fields: w.dealFields.length + w.companyFields.length };
  await w.svc.pagar.ensure();
  assert.equal(w.categories.length, antes.cats); assert.equal(w.dealFields.length + w.companyFields.length, antes.fields);
});

test('parceiros: cadastro validado, promover empresa existente, sem nomes duplicados', async () => {
  const w = await pronto();
  const p = w.svc.pagar;
  const r = await p.salvarParceiro({ nome: 'Parceiro A', tipo: 'PARTNER', doc: '11.222.333/0001-81', wallet: WALLET, perc: 30, base: 'LIQUIDO', prazo: 5, pixTipo: 'E-mail', pix: 'fin@a.com', email: 'a@a.com', banco: 'Itaú 0001 12345-6' });
  const lista = await p.parceiros(true);
  const a = lista.find(x => x.id === r.id);
  assert.deepEqual([a.nome, a.doc, a.wallet, a.perc, a.base, a.prazo, a.pixTipo, a.pix, a.email, a.tipo], ['Parceiro A', '11222333000181', WALLET, 30, 'LIQUIDO', 5, 'E-mail', 'fin@a.com', 'a@a.com', 'PARTNER']);
  const bad = async (sp, re) => assert.rejects(() => p.salvarParceiro(sp), re);
  await bad({ nome: 'x' }, /nome do parceiro/);
  await bad({ nome: 'Novo', doc: '123' }, /CPF\/CNPJ inválido/);
  await bad({ nome: 'Novo', wallet: 'abc' }, /walletId inválido/);
  await bad({ nome: 'Novo', perc: 150 }, /entre 0 e 100/);
  await bad({ nome: 'Novo', perc: 10, fixo: 50 }, /percentual OU valor fixo/);
  await bad({ nome: 'Novo', prazo: 999 }, /entre 0 e 365/);
  await bad({ nome: 'Novo', pixTipo: 'E-mail', pix: 'semarroba' }, /precisa ter @/);
  await bad({ nome: 'Novo', email: 'nao-e-email' }, /E-mail inválido/);
  await bad({ nome: 'A=B' }, /caracteres/);
  await bad({ nome: 'parceiro a' }, /Já existe/);
  await bad({ nome: 'Outro', wallet: WALLET }, /já está em outro parceiro/);
  await p.salvarParceiro({ perc: 40, email: 'novo@a.com', inativo: true }, { id: r.id });
  const a2 = (await p.parceiros(true)).find(x => x.id === r.id);
  assert.equal(a2.perc, 40); assert.equal(a2.email, 'novo@a.com'); assert.equal(a2.inativo, true); assert.equal(a2.nome, 'Parceiro A');   // edição parcial preserva o resto
  const prom = await p.salvarParceiro({ empresaId: '77', nome: 'Fornecedor Z', tipo: 'SUPPLIER' });
  assert.equal(prom.id, 77); assert.equal((await p.parceiros(true)).find(x => x.id === 77).tipo, 'SUPPLIER');
});

test('contas a pagar: criar (única e mensal), pagar, editar, cancelar e desfazer', async () => {
  const w = await pronto();
  const p = w.svc.pagar;
  const forn = (await p.salvarParceiro({ nome: 'Imobiliária X', tipo: 'SUPPLIER', pix: '12345678000199', pixTipo: 'CPF/CNPJ' })).id;
  const r = await p.criarConta({ titulo: 'Aluguel', valor: 4500, venc: addDays(today, 10), categoria: 'Estrutura e software', parceiroId: forn, repetir: 3, forma: 'Boleto', linha: '00190.00009 01234  5678' });
  assert.equal(r.ids.length, 3);
  let l = (await contas(w)).sort((a, b) => a.id - b.id);
  assert.deepEqual(l.map(c => c.titulo), ['Aluguel — 1/3', 'Aluguel — 2/3', 'Aluguel — 3/3']);
  assert.deepEqual(l.map(c => c.parcela), ['1/3', '2/3', '3/3']);
  assert.equal(l[0].beneficiario, 'Imobiliária X'); assert.equal(l[0].categoria, 'Estrutura e software'); assert.equal(l[0].forma, 'Boleto'); assert.equal(l[0].linha, '00190.00009 01234 5678');
  assert.equal(l[0].pix, '12345678000199'); assert.equal(l[0].estado, 'aberto'); assert.equal(l[1].venc, R.addMonths(addDays(today, 10), 1));
  const livre = (await p.criarConta({ titulo: 'Contador', valor: 800, venc: addDays(today, -2), beneficiario: 'João Contador' })).ids[0];   // vencida: já nasce atrasada
  assert.equal((await contas(w)).find(c => c.id === livre).estado, 'atrasado');
  assert.equal((await contas(w)).find(c => c.id === livre).beneficiario, 'João Contador');
  // validações
  const bad = async (sp, re) => assert.rejects(() => p.criarConta({ titulo: 'x', valor: 10, venc: addDays(today, 1), beneficiario: 'Fulano', ...sp }), re);
  await bad({ titulo: ' ' }, /descrição/); await bad({ valor: 0 }, /Valor inválido/); await bad({ venc: '' }, /vencimento/); await bad({ categoria: 'Xis' }, /Categoria/);
  await bad({ forma: 'Cheque' }, /Forma/); await bad({ repetir: 99 }, /entre 1 e 60/); await bad({ beneficiario: '' }, /beneficiário/); await bad({ parceiroId: 99999 }, /não encontrado/);
  // pagar
  await assert.rejects(() => p.pagarConta(livre, { data: addDays(today, 2) }), /não pode ser futura/);
  await assert.rejects(() => p.pagarConta(livre, { forma: 'Split Asaas' }), /Forma de pagamento inválida/);
  await p.pagarConta(livre, { data: today, forma: 'Pix', valor: 850, comprovante: 'E2E123' });
  const pago = (await contas(w)).find(c => c.id === livre);
  assert.deepEqual([pago.estado, pago.pagoEm, pago.forma, pago.valor, pago.valorPago, pago.comprovante], ['pago', today, 'Pix', 800, 850, 'E2E123']);   // previsto preservado; pago registrado à parte
  assert.ok(w.comments.some(c => /valor pago R\$ 850.00 \(previsto R\$ 800.00\)/.test(c.COMMENT)));
  await assert.rejects(() => p.pagarConta(livre, {}), /já está paga/);
  await assert.rejects(() => p.editarConta(livre, { valor: 1 }), /não pode mais ser editada/);
  await assert.rejects(() => p.cancelarConta(livre), /Desfazer pagamento/);
  await p.desfazerPagamento(livre);
  const volta = (await contas(w)).find(c => c.id === livre);
  assert.equal(volta.estado, 'atrasado'); assert.equal(volta.pagoEm, ''); assert.equal(volta.valorPago, 0); assert.equal(volta.valor, 800);   // desfazer restaura tudo
  // editar e cancelar
  const id1 = l[0].id;
  await p.editarConta(id1, { valor: 4700, venc: addDays(today, 1), obs: 'reajuste' });
  const e = (await contas(w)).find(c => c.id === id1);
  assert.equal(e.valor, 4700); assert.equal(e.estado, 'proximo'); assert.equal(e.obs, 'reajuste');           // vencimento novo reposiciona a etapa
  await p.cancelarConta(id1, { motivo: 'contrato encerrado' });
  assert.equal((await contas(w)).find(c => c.id === id1).estado, 'cancelado');
  await assert.rejects(() => p.cancelarConta(id1), /já está cancelada/);
  // resumo
  const rs = p.resumoContas(await contas(w));
  assert.equal(rs.cancelado.qtd, 1); assert.equal(rs.aPagar.qtd, 3); assert.equal(rs.atrasado.valor, 800);
});

test('movimento por data nas contas a pagar e "Pago" marcado direto no Bitrix ganha a data', async () => {
  const w = await pronto();
  const p = w.svc.pagar;
  const a = (await p.criarConta({ titulo: 'Internet', valor: 300, venc: addDays(today, 30), beneficiario: 'ISP' })).ids[0];
  const d = w.deals.find(x => +x.ID === a);
  d.UF_CRM_CP_VENC = addDays(today, 2);                          // aproximou
  await p.tickDatas(); assert.equal((await contas(w)).find(c => c.id === a).estado, 'proximo');
  d.UF_CRM_CP_VENC = addDays(today, -1);                         // passou
  await p.tickDatas(); assert.equal((await contas(w)).find(c => c.id === a).estado, 'atrasado');
  d.STAGE_ID = w.store.ap.stages.paid;                           // usuário arrasta para Pago no Bitrix
  await p.tickDatas();
  assert.equal((await contas(w)).find(c => c.id === a).pagoEm, today);
});

test('repasse manual: nasce "aguardando", libera quando o cliente paga (prazo do parceiro, base bruta/líquida), acompanha mudanças e não duplica', async () => {
  const w = await pronto([recebivel({ UF_CRM_CR_SPLIT: 'Parceiro A=30%; Parceiro B=R$ 100,00; Parceiro C=10%' })]);
  const p = w.svc.pagar;
  const A = (await p.salvarParceiro({ nome: 'Parceiro A', prazo: 5, base: 'BRUTO', pix: 'a@x.com', pixTipo: 'E-mail' })).id;
  const B = (await p.salvarParceiro({ nome: 'Parceiro B', prazo: 0 })).id;
  const C = (await p.salvarParceiro({ nome: 'Parceiro C', prazo: 2, base: 'LIQUIDO', tipo: 'SUPPLIER' })).id;
  const venc = addDays(today, 20);
  let s = await w.svc.sync();
  assert.equal(s.errors.length, 0, s.errors.join(';'));
  assert.equal(s.repasses.criados, 3);
  let l = await contas(w);
  const por = id => l.find(c => c.parceiroId === id);
  assert.deepEqual([por(A).estado, por(A).valor, por(A).venc, por(A).regra, por(A).origem, por(A).forma], ['aguardando', 300, addDays(venc, 5), '30% do bruto', 1, 'Pix']);
  assert.deepEqual([por(B).estado, por(B).valor, por(B).venc, por(B).regra], ['aguardando', 100, venc, 'R$ 100,00 fixo']);
  assert.equal(por(C).valor, 100); assert.equal(por(C).categoria, 'Fornecedor');            // 10% do líquido (ainda = bruto até receber)
  assert.equal(w.deals[0].UF_CRM_CR_REPASSES.split(',').length, 3);                         // a cobrança lista os títulos que gerou
  assert.match(por(A).titulo, /^Repasse Parceiro A — Licença Professional/);
  assert.ok(w.comments.some(c => /Repasse gerado a partir da cobrança #1/.test(c.COMMENT)));
  s = await w.svc.sync(); assert.equal(s.repasses.criados, 0);                              // idempotente
  assert.equal((await contas(w)).length, 3);

  // mudança de valor da cobrança enquanto aguarda: repasses acompanham
  w.deals[0].OPPORTUNITY = '1200';
  await w.svc.sync();
  l = await contas(w);
  assert.equal(por(A).valor, 360); assert.equal(por(B).valor, 100); assert.equal(por(C).valor, 120);

  // cliente paga (líquido 1.176 após taxas)
  const pid = w.deals[0].UF_CRM_CR_ASAAS_ID;
  Object.assign(w.pays[pid], { status: 'RECEIVED', paymentDate: today, netValue: 1176 });
  s = await w.svc.sync();
  assert.equal(s.errors.length, 0, s.errors.join(';'));
  assert.equal(s.repasses.liberados, 3);
  l = await contas(w);
  assert.deepEqual([por(A).estado, por(A).venc], ['aberto', addDays(today, 5)]);            // 5 dias > janela de 3 -> "A pagar"
  assert.deepEqual([por(B).estado, por(B).venc], ['proximo', today]);                       // prazo 0: vence hoje
  assert.equal(por(A).valor, 360);                                                          // base bruta não muda
  assert.equal(por(C).valor, 117.6);                                                        // base líquida usa o valor líquido recebido
  assert.ok(w.comments.some(c => /repasse liberado para pagamento/.test(c.COMMENT)));
  await w.svc.sync(); assert.equal((await contas(w)).length, 3);

  // pagar um repasse; depois a cobrança é estornada: o pago só gera alerta, os abertos são cancelados
  await p.pagarConta(por(A).id, { data: today, forma: 'Pix', comprovante: 'E2E' });
  w.deals[0].STAGE_ID = R.STAGES.cancelled;
  s = await w.svc.sync();
  l = await contas(w);
  assert.equal(por(A).estado, 'pago'); assert.equal(por(B).estado, 'cancelado'); assert.equal(por(C).estado, 'cancelado');
});

test('repasse com split nativo do Asaas: vai na emissão, o título é só registro e fecha quando o split é concluído', async () => {
  const w = await pronto([recebivel({ UF_CRM_CR_SPLIT: 'Parceiro N=20%' })]);
  const p = w.svc.pagar;
  const N = (await p.salvarParceiro({ nome: 'Parceiro N', wallet: WALLET, prazo: 3, pix: 'n@x.com', pixTipo: 'E-mail' })).id;
  let s = await w.svc.sync();
  assert.equal(s.errors.length, 0, s.errors.join(';'));
  assert.deepEqual(w.created[0].split, [{ walletId: WALLET, percentualValue: 20 }]);          // split nativo enviado ao Asaas
  let c = (await contas(w)).find(x => x.parceiroId === N);
  assert.deepEqual([c.estado, c.forma, c.valor], ['aguardando', 'Split Asaas', 200]);   // antes de receber: estimativa sobre o bruto
  await assert.rejects(() => p.pagarConta(c.id, {}), /feito automaticamente pelo split/);   // não paga duas vezes
  // cliente paga; split ainda processando
  const pid = w.deals[0].UF_CRM_CR_ASAAS_ID;
  Object.assign(w.pays[pid], { status: 'RECEIVED', paymentDate: today, netValue: 980, split: [{ walletId: WALLET, status: 'PENDING', totalValue: 196 }] });
  await w.svc.sync();
  c = (await contas(w)).find(x => x.parceiroId === N);
  assert.deepEqual([c.estado, c.splitSt], ['aguardando', 'PENDING']);
  // split concluído: título quita sozinho com o valor real creditado
  w.pays[pid].split[0].status = 'DONE';
  s = await w.svc.sync();
  c = (await contas(w)).find(x => x.parceiroId === N);
  assert.deepEqual([c.estado, c.valor, c.valorPago, c.forma, c.pagoEm], ['pago', 196, 196, 'Split Asaas', today]);   // com o líquido conhecido (980), 20% = 196 — e foi isso que o Asaas creditou
  assert.equal(s.repasses.pagos, 1);
});

test('split com nome desconhecido não gera nada, avisa uma única vez; parceiro que sai do split cancela o título aberto', async () => {
  const w = await pronto([recebivel({ UF_CRM_CR_SPLIT: 'Fulano=10%' })]);
  const p = w.svc.pagar;
  const s = await w.svc.sync();
  assert.ok(s.errors.some(e => /não cadastrado/.test(e)));
  assert.equal((await contas(w)).length, 0); assert.equal(w.created.length, 0);               // nem cobrança nem repasse com split inválido
  await w.svc.sync();
  assert.equal(w.comments.filter(c => /Repasses não gerados/.test(c.COMMENT)).length, 1);
  // corrige o split com dois parceiros, depois tira um
  const A = (await p.salvarParceiro({ nome: 'Ana' })).id, B = (await p.salvarParceiro({ nome: 'Beto' })).id;
  w.deals[0].UF_CRM_CR_SPLIT = 'Ana=10%; Beto=10%';
  await w.svc.sync();
  assert.equal((await contas(w)).filter(c => c.estado === 'aguardando').length, 2);
  w.deals[0].UF_CRM_CR_SPLIT = 'Ana=10%';
  await w.svc.sync();
  const l = await contas(w);
  assert.equal(l.find(c => c.parceiroId === A).estado, 'aguardando'); assert.equal(l.find(c => c.parceiroId === B).estado, 'cancelado');
});

test('resumo por parceiro e visão geral das contas', async () => {
  const w = await pronto([recebivel({ UF_CRM_CR_SPLIT: 'Ana=25%' })]);
  const p = w.svc.pagar;
  const A = (await p.salvarParceiro({ nome: 'Ana', prazo: 0 })).id;
  await w.svc.sync();
  await p.criarConta({ titulo: 'Software', valor: 90, venc: addDays(today, -1), parceiroId: A });
  const lista = await contas(w);
  const rs = p.resumoContas(lista);
  assert.equal(rs.aguardando.valor, 250); assert.equal(rs.atrasado.valor, 90); assert.equal(rs.aPagar.valor, 90);
  const pr = p.parceirosComResumo(await p.parceiros(true), lista).find(x => x.id === A);
  assert.deepEqual([pr.aguardando, pr.aPagar, pr.atrasado, pr.pagoTotal, pr.qtd], [250, 90, 90, 0, 2]);
});

test('editar o split de uma cobrança: repasse manual pode mudar; split automático só na emissão; inválido é recusado', async () => {
  const w = await pronto([recebivel({ UF_CRM_CR_SPLIT: 'Manual=10%' })]);
  const p = w.svc.pagar;
  await p.salvarParceiro({ nome: 'Manual' }); await p.salvarParceiro({ nome: 'Auto', wallet: WALLET }); await p.salvarParceiro({ nome: 'Outro' });
  await w.svc.sync();                                                                          // cobrança emitida só com repasse manual
  const get = async () => (await w.svc.dealsCached(0))[0];
  let r = await w.svc.editar(await get(), { split: 'Manual=15%; Outro=5%' });                  // só manuais: permitido, mesmo com cobrança no Asaas
  assert.equal(r.alterado, true); assert.equal(w.deals[0].UF_CRM_CR_SPLIT, 'Manual=15%; Outro=5%');
  await assert.rejects(async () => w.svc.editar(await get(), { split: 'Manual=15%; Auto=10%' }), /só pode ser definido na emissão/);   // nativo novo com cobrança emitida
  await assert.rejects(async () => w.svc.editar(await get(), { split: 'Fantasma=10%' }), /não cadastrado/);
  await assert.rejects(async () => w.svc.editar(await get(), { split: 'Manual=70%; Outro=40%' }), /soma 110%/);
  await w.svc.editar(await get(), { split: '' });                                              // limpar o split é permitido
  assert.equal(w.deals[0].UF_CRM_CR_SPLIT, '');
  // repasses gerados antes continuam a existir até o sync reconciliar (parceiro removido do split -> cancelado)
  await w.svc.sync();
  assert.ok((await contas(w)).every(c => c.estado === 'cancelado'));
  // paga: não altera mais
  Object.assign(w.pays[w.deals[0].UF_CRM_CR_ASAAS_ID], { status: 'RECEIVED', paymentDate: today });
  await w.svc.sync();
  await assert.rejects(async () => w.svc.editar(await get(), { split: 'Manual=5%' }), /já paga|já foi|Cobrança já paga/);
});
