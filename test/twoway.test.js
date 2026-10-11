'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FORMA_ID, TIPO_ID, today, world, R } = require('../testkit/world');

const due = R.addMonths(today, 1);
const card = (extra = {}) => ({ ID: '7', TITLE: 'Licença Standard — mensal', STAGE_ID: R.STAGES.open, OPPORTUNITY: '200', COMPANY_ID: '5', CONTACT_ID: '0', ASSIGNED_BY_ID: '1',
  UF_CRM_CR_FORMA: FORMA_ID('BOLETO'), UF_CRM_CR_TIPO: TIPO_ID('UNICA'), UF_CRM_CR_VENC: due + 'T00:00:00+03:00', ...extra });
const emitido = async (w) => { await w.svc.sync(); const id = w.deals[0].UF_CRM_CR_ASAAS_ID; assert.ok(id, 'cobrança emitida'); return id; };

test('mudança no Bitrix (valor, vencimento, forma) é enviada ao Asaas uma única vez', async () => {
  const w = world([card()]);
  const pid = await emitido(w);
  assert.equal(w.updates.length, 0);                         // nada a enviar logo após emitir
  const novoVenc = R.addMonths(today, 2);
  Object.assign(w.deals[0], { OPPORTUNITY: '250', UF_CRM_CR_VENC: novoVenc + 'T00:00:00+03:00', UF_CRM_CR_FORMA: FORMA_ID('PIX') });
  const r = await w.svc.sync();
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(w.updates.length, 1);
  assert.deepEqual(w.updates[0], [pid, { value: 250, dueDate: novoVenc, billingType: 'PIX' }]);
  assert.equal(w.pays[pid].value, 250);
  await w.svc.sync();
  assert.equal(w.updates.length, 1);                         // estável: não reenvia
});

test('mudança feita no Asaas é trazida ao Bitrix, sem reenviar de volta', async () => {
  const w = world([card()]);
  const pid = await emitido(w);
  const novo = R.addMonths(today, 3);
  w.pays[pid].dueDate = novo; w.pays[pid].value = 180;
  await w.svc.sync();
  assert.equal(w.updates.length, 0);
  assert.equal(w.deals[0].UF_CRM_CR_VENC, novo);
  assert.equal(w.deals[0].OPPORTUNITY, 180);
  await w.svc.sync(); assert.equal(w.updates.length, 0);
});

test('campos diferentes mudam em lados diferentes; no mesmo campo vale o Bitrix', async () => {
  const w = world([card()]);
  const pid = await emitido(w);
  w.deals[0].OPPORTUNITY = '300';                            // Bitrix muda o valor
  const venc2 = R.addMonths(today, 4);
  w.pays[pid].dueDate = venc2;                               // Asaas muda o vencimento
  await w.svc.sync();
  assert.equal(w.pays[pid].value, 300);                      // valor foi para o Asaas
  assert.equal(w.deals[0].UF_CRM_CR_VENC, venc2);            // vencimento veio para o Bitrix
  w.deals[0].OPPORTUNITY = '310'; w.pays[pid].value = 999;   // os dois mudam o mesmo campo
  await w.svc.sync();
  assert.equal(w.pays[pid].value, 310);                      // Bitrix vence
});

test('cobrança paga não é alterada: edição bloqueada e avisada uma vez', async () => {
  const w = world([card()]);
  const pid = await emitido(w);
  w.pays[pid].status = 'RECEIVED'; w.pays[pid].paymentDate = today;
  await w.svc.sync();
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.paid);
  await assert.rejects(() => w.svc.editar({ id: 7, valor: 200, venc: due, forma: 'BOLETO', statusAsaas: 'RECEIVED', asaasId: pid }, { valor: 999 }), /não é possível alterar o valor/);
  assert.equal(w.updates.length, 0);
});

test('mover o card para Cancelado cancela no Asaas; Pago sem pagamento fica sinalizado', async () => {
  const w = world([card(), card({ ID: '8', TITLE: 'Outra' })]);
  await w.svc.sync();
  w.deals[0].STAGE_ID = R.STAGES.cancelled;                  // usuário cancela no Bitrix
  w.deals[1].STAGE_ID = R.STAGES.paid;                       // usuário marca como pago sem o Asaas receber
  await w.svc.sync();
  assert.equal(w.cancelled.length, 1);
  assert.equal(w.deals[0].UF_CRM_CR_STATUS, 'DELETED');
  assert.equal(w.deals[1].STAGE_ID, R.STAGES.paid);          // não desfaz o que o usuário marcou
  const d = (await w.svc.dealsCached(0)).find(x => x.id === 8);
  assert.ok(d.pendencias.some(p => /Marcado como Pago no Bitrix/.test(p.msg)));
  await w.svc.sync(); assert.equal(w.cancelled.length, 1);   // não cancela de novo
});

test('editar pelo painel grava no Bitrix (categoria, licença, obs) e envia ao Asaas na hora', async () => {
  const w = world([card({ TITLE: 'Contrato' })]);
  const pid = await emitido(w);
  const c = (await w.svc.dealsCached(0))[0];
  const r = await w.svc.editar(c, { titulo: 'Licença Professional Vibe+', valor: 420.5, categoria: 'Licença Bitrix24', plano: 'Professional Vibe+', forma: 'PIX', obs: 'Renovação anual', doc: '11.222.333/0001-81' });
  assert.equal(r.alterado, true);
  assert.deepEqual(r.asaas.enviado.sort(), ['descrição', 'forma de pagamento', 'valor']);
  assert.equal(w.pays[pid].value, 420.5); assert.equal(w.pays[pid].billingType, 'PIX'); assert.equal(w.pays[pid].description, 'Licença Professional Vibe+');
  const d = w.deals[0];
  assert.equal(d.TITLE, 'Licença Professional Vibe+'); assert.equal(d.COMMENTS, 'Renovação anual'); assert.equal(d.UF_CRM_CR_DOC, '11222333000181');
  const v = (await w.svc.dealsCached(0))[0];
  assert.equal(v.categoria, 'Licença Bitrix24'); assert.equal(v.plano, 'Professional Vibe+');
  await assert.rejects(() => w.svc.editar(v, { valor: -1 }), /Valor inválido/);
  await assert.rejects(() => w.svc.editar(v, { plano: 'Inexistente' }), /Tipo de licença inexistente/);
  await assert.rejects(() => w.svc.editar(v, { doc: '123' }), /CPF\/CNPJ inválido/);
});

test('primeiro contato: cards importados não têm a descrição sobrescrita e divergência antiga vem do Asaas', async () => {
  const w = world([]);
  w.pays.px = { id: 'px', status: 'PENDING', value: 100, dueDate: R.addMonths(today, 1), billingType: 'PIX', customer: 'cus_x', description: '', installment: 'inst_1', installmentNumber: 3, invoiceUrl: 'u' };
  w.pays.py = { id: 'py', status: 'PENDING', value: 80, dueDate: R.addMonths(today, 1), billingType: 'BOLETO', customer: 'cus_x', description: 'Descrição original do Asaas', invoiceUrl: 'u' };
  await w.svc.importar({ dias: 90 });
  w.pays.py.dueDate = R.addMonths(today, 2);                 // mudou no Asaas depois do import e antes do 1º sync
  const r = await w.svc.sync();
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(w.updates.length, 0);                          // nada enviado ao Asaas (nem descrição)
  assert.equal(w.pays.px.description, ''); assert.equal(w.pays.py.description, 'Descrição original do Asaas');
  const cy = w.deals.find(d => d.UF_CRM_CR_ASAAS_ID === 'py');
  assert.equal(cy.UF_CRM_CR_VENC, R.addMonths(today, 2));     // veio do Asaas
  await w.svc.sync(); assert.equal(w.updates.length, 0);
  // depois do baseline, editar o título no Bitrix passa a valer
  w.deals.find(d => d.UF_CRM_CR_ASAAS_ID === 'py').TITLE = 'Novo título';
  await w.svc.sync();
  assert.equal(w.pays.py.description, 'Novo título'); assert.equal(w.updates.length, 1);
});

test('sync consulta o Asaas em lote: cobranças ativas não são buscadas uma a uma', async () => {
  const w = world([card({ ID: '1' }), card({ ID: '2', TITLE: 'B' }), card({ ID: '3', TITLE: 'C' })]);
  await w.svc.sync();
  w.gets.length = 0;
  await w.svc.sync();
  assert.equal(w.gets.length, 0);                             // 3 cobranças ativas, 0 consultas individuais
  const id = w.deals[0].UF_CRM_CR_ASAAS_ID;
  w.pays[id].status = 'RECEIVED'; w.pays[id].paymentDate = today;   // saiu do lote -> só ela é consultada
  await w.svc.sync();
  assert.deepEqual(w.gets, [id]);
  assert.equal(w.deals[0].STAGE_ID, R.STAGES.paid);
});

test('valor guardado arredondado no campo antigo não gera alerta falso nem envia valor ao Asaas', async () => {
  const w = world([]);
  w.pays.pz = { id: 'pz', status: 'PENDING', value: 1927.7, dueDate: R.addMonths(today, 1), billingType: 'BOLETO', customer: 'cus_x', description: 'Parcela\n2 de 12', invoiceUrl: 'u' };
  await w.svc.importar({ dias: 90 });
  const d = w.deals.find(x => x.UF_CRM_CR_ASAAS_ID === 'pz');
  assert.equal(d.TITLE, 'Parcela 2 de 12');                  // título em uma linha
  d.UF_CRM_CR_VALOR_ASAAS = '1928';                           // como o campo sem casas decimais gravava
  const r = await w.svc.sync();
  assert.equal(r.errors.length, 0, r.errors.join(';'));
  assert.equal(w.updates.length, 0);                          // nada enviado ao Asaas
  assert.equal(w.pays.pz.value, 1927.7);
  assert.equal(d.UF_CRM_CR_VALOR_ASAAS, 1927.7);              // campo corrigido com os centavos
  const v = (await w.svc.dealsCached(0)).find(x => x.id === +d.ID);
  assert.ok(!v.pendencias.some(p => /difere/.test(p.msg)));
});
