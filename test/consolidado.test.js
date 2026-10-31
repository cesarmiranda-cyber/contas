'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { today, world, R } = require('../testkit/world');

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
async function pronto() {
  const w = world([]); await w.svc.pagar.ensure(); const p = w.svc.pagar;
  const A = (await p.salvarParceiro({ nome: 'Connect Think', email: 'fin@connect.com', pix: 'pix-connect', pixTipo: 'Chave aleatória' })).id;
  const B = (await p.salvarParceiro({ nome: 'Almah Condos' })).id;
  return { w, p, A, B };
}
const conta = (p, o) => p.criarConta({ categoria: 'Repasse a parceiro', ...o }).then(r => r.ids[0]);
const get = async (w, id) => (await w.svc.pagar.contas()).find(c => c.id === id);

test('consolida títulos do mesmo parceiro: soma, etapa "Em consolidado" nos originais e fora das somas', async () => {
  const { w, p, A } = await pronto();
  const i1 = await conta(p, { titulo: 'Repasse jan', valor: 100, venc: addDays(today, 10), parceiroId: A });
  const i2 = await conta(p, { titulo: 'Repasse fev', valor: 250.5, venc: addDays(today, 3), parceiroId: A });
  const i3 = await conta(p, { titulo: 'Repasse mar', valor: 49.5, venc: addDays(today, -4), parceiroId: A });      // atrasado também entra
  const r = await p.consolidar({ ids: [i1, i2, i3], forma: 'Pix', obs: 'fechamento do trimestre' });
  assert.equal(r.total, 400); assert.equal(r.titulos, 3);
  const c = await get(w, r.id);
  assert.deepEqual([c.estado, c.valor, c.beneficiario, c.forma, c.pix, c.itens.length], ['proximo', 400, 'Connect Think', 'Pix', 'pix-connect', 3]);
  assert.ok(c.venc >= today && c.venc <= addDays(today, 3));                                                // vencimento padrão: o mais cedo, nunca no passado
  for (const id of [i1, i2, i3]) { const x = await get(w, id); assert.deepEqual([x.estado, x.lote], ['consolidado', r.id]); }
  const lista = await p.contas();
  const rs = p.resumoContas(lista);
  assert.equal(rs.aPagar.valor, 400); assert.equal(rs.aPagar.qtd, 1);                                       // só o consolidado conta como obrigação
  const par = p.parceirosComResumo(await p.parceiros(true), lista).find(x => x.id === A);
  assert.equal(par.aPagar, 400);                                                                            // lente do parceiro: títulos, sem dobrar o consolidado
  assert.ok(w.comments.some(x => /Incluído no pagamento consolidado/.test(x.COMMENT)));
});

test('regras: mínimo 2, mesmo beneficiário, só pagáveis, sem consolidar o consolidado nem split automático', async () => {
  const { w, p, A, B } = await pronto();
  const a1 = await conta(p, { titulo: 'a1', valor: 10, venc: addDays(today, 5), parceiroId: A }), a2 = await conta(p, { titulo: 'a2', valor: 20, venc: addDays(today, 5), parceiroId: A });
  const b1 = await conta(p, { titulo: 'b1', valor: 30, venc: addDays(today, 5), parceiroId: B });
  const l1 = await conta(p, { titulo: 'l1', valor: 5, venc: addDays(today, 5), beneficiario: 'João Contador' }), l2 = await conta(p, { titulo: 'l2', valor: 7, venc: addDays(today, 5), beneficiario: 'joão contador' });
  await assert.rejects(() => p.consolidar({ ids: [a1] }), /pelo menos 2/);
  await assert.rejects(() => p.consolidar({ ids: [a1, b1] }), /mesmo beneficiário/);
  await assert.rejects(() => p.consolidar({ ids: [a1, a2], venc: addDays(today, -1) }), /passado/);
  await assert.rejects(() => p.consolidar({ ids: [a1, a2], forma: 'Split Asaas' }), /Forma de pagamento inválida/);
  await assert.rejects(() => p.consolidar({ ids: [a1, 999999] }), /não encontrado/);
  const livre = await p.consolidar({ ids: [l1, l2] });                                                      // nome livre, ignorando maiúsculas/acentos
  assert.equal((await get(w, livre.id)).beneficiario, 'João Contador'); assert.equal(livre.total, 12);
  await assert.rejects(() => p.consolidar({ ids: [l1, a2] }), /não pode ser consolidado: já está no consolidado/);
  const ok = await p.consolidar({ ids: [a1, a2] });
  await assert.rejects(() => p.consolidar({ ids: [ok.id, a2] }), /já é um consolidado|já está no consolidado/);
  // pago, cancelado, aguardando e split automático não entram
  const pg = await conta(p, { titulo: 'pg', valor: 1, venc: addDays(today, 5), parceiroId: B }); await p.pagarConta(pg, {});
  const cc = await conta(p, { titulo: 'cc', valor: 1, venc: addDays(today, 5), parceiroId: B }); await p.cancelarConta(cc);
  await assert.rejects(() => p.consolidar({ ids: [b1, pg] }), /está pago/); await assert.rejects(() => p.consolidar({ ids: [b1, cc] }), /está cancelado/);
  const d = w.deals.find(x => +x.ID === b1); const sp = await conta(p, { titulo: 'sp', valor: 9, venc: addDays(today, 5), parceiroId: B, forma: 'Pix' });
  w.deals.find(x => +x.ID === sp).UF_CRM_CP_FORMA = (w.dealFields.find(f => f.FIELD_NAME === 'UF_CRM_CP_FORMA').LIST.find(i => i.VALUE === 'Split Asaas')).ID;
  await assert.rejects(() => p.consolidar({ ids: [b1, sp] }), /split automático/);
  const ag = await conta(p, { titulo: 'ag', valor: 9, venc: addDays(today, 5), parceiroId: B }); w.deals.find(x => +x.ID === ag).STAGE_ID = w.store.ap.stages.aguardando;
  await assert.rejects(() => p.consolidar({ ids: [b1, ag] }), /aguarda o recebimento/);
});

test('títulos dentro do consolidado ficam travados; detalhe mostra cliente e cobrança de origem', async () => {
  const w = await world([{ ID: '9338', TITLE: 'Licença Pro', STAGE_ID: R.STAGES.paid, OPPORTUNITY: '1000', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_PAGO_EM: today }]);
  await w.svc.pagar.ensure(); const p = w.svc.pagar;
  const A = (await p.salvarParceiro({ nome: 'Connect Think', email: 'fin@connect.com' })).id;
  const i1 = await conta(p, { titulo: 'Repasse 1', valor: 100, venc: addDays(today, 5), parceiroId: A }), i2 = await conta(p, { titulo: 'Repasse 2', valor: 60, venc: addDays(today, 5), parceiroId: A });
  w.deals.find(x => +x.ID === i1).UF_CRM_CP_ORIGEM = 9338; w.deals.find(x => +x.ID === i1).UF_CRM_CP_REGRA = '10% do bruto';
  const r = await p.consolidar({ ids: [i1, i2] });
  await assert.rejects(() => p.pagarConta(i1, {}), /faz parte do consolidado/);
  await assert.rejects(() => p.cancelarConta(i1), /faz parte do consolidado/);
  await assert.rejects(() => p.editarConta(i1, { valor: 1 }), /faz parte do consolidado/);
  await assert.rejects(() => p.editarConta(r.id, { valor: 1 }), /soma dos títulos/);
  const d = await p.detalheConsolidado(r.id);
  assert.equal(d.total, 160); assert.equal(d.emailPara, 'fin@connect.com'); assert.equal(d.itens.length, 2);
  const it = d.itens.find(x => x.id === i1);
  assert.deepEqual([it.cobranca, it.cliente, it.cobrancaTitulo, it.regra], [9338, 'ACME Ltda', 'Licença Pro', '10% do bruto']);
  await assert.rejects(() => p.detalheConsolidado(i1), /não encontrado/);
});

test('pagar o consolidado quita todos os títulos (valor pago distribuído em proporção) e desfazer devolve tudo', async () => {
  const { w, p, A } = await pronto();
  const ids = [await conta(p, { titulo: 'x1', valor: 100, venc: addDays(today, 5), parceiroId: A }), await conta(p, { titulo: 'x2', valor: 200, venc: addDays(today, 5), parceiroId: A }), await conta(p, { titulo: 'x3', valor: 300, venc: addDays(today, 5), parceiroId: A })];
  const r = await p.consolidar({ ids });
  await p.pagarConta(r.id, { data: today, forma: 'Pix', valor: 590, comprovante: 'E2E-9' });             // R$ 10 de desconto
  const c = await get(w, r.id);
  assert.deepEqual([c.estado, c.valor, c.valorPago, c.pagoEm], ['pago', 600, 590, today]);
  const filhos = await Promise.all(ids.map(i => get(w, i)));
  assert.ok(filhos.every(x => x.estado === 'pago' && x.pagoEm === today && x.forma === 'Pix' && /Consolidado #/.test(x.comprovante)));
  assert.deepEqual(filhos.map(x => x.valorPago), [98.33, 196.67, 295]);                                  // proporcional; centavos no último
  assert.equal(Math.round(filhos.reduce((a, x) => a + x.valorPago, 0) * 100) / 100, 590);
  const rs = p.resumoContas(await p.contas());
  assert.equal(rs.pago.valor, 590); assert.equal(rs.pago.qtd, 1); assert.equal(rs.aPagar.qtd, 0);        // contagem única
  const par = p.parceirosComResumo(await p.parceiros(true), await p.contas()).find(x => x.id === A);
  assert.equal(par.pagoTotal, 590);
  await assert.rejects(() => p.desfazerPagamento(ids[0]), /desfaça o pagamento do consolidado/);
  await assert.rejects(() => p.desfazerConsolidacao(r.id), /já pago/);
  await p.desfazerPagamento(r.id);
  assert.equal((await get(w, r.id)).estado, 'aberto');
  for (const i of ids) { const x = await get(w, i); assert.deepEqual([x.estado, x.valorPago, x.pagoEm, x.lote], ['consolidado', 0, '', r.id]); }
});

test('desfazer a consolidação e remover um título devolvem os originais e recalculam o total', async () => {
  const { w, p, A } = await pronto();
  const ids = [await conta(p, { titulo: 'y1', valor: 100, venc: addDays(today, 10), parceiroId: A }), await conta(p, { titulo: 'y2', valor: 200, venc: addDays(today, -2), parceiroId: A }), await conta(p, { titulo: 'y3', valor: 50, venc: addDays(today, 1), parceiroId: A })];
  const r = await p.consolidar({ ids });
  const rem = await p.removerDoConsolidado(r.id, ids[1]);
  assert.deepEqual([rem.total, rem.titulos], [150, 2]);
  const y2 = await get(w, ids[1]); assert.deepEqual([y2.estado, y2.lote], ['atrasado', 0]);                // volta na etapa certa pela data
  assert.equal((await get(w, r.id)).valor, 150); assert.equal((await get(w, r.id)).itens.length, 2);
  await assert.rejects(() => p.removerDoConsolidado(r.id, ids[1]), /não faz parte/);
  const des = await p.desfazerConsolidacao(r.id);
  assert.equal(des.liberados, 2);
  assert.equal((await get(w, r.id)).estado, 'cancelado');
  assert.deepEqual([(await get(w, ids[0])).estado, (await get(w, ids[2])).estado], ['aberto', 'proximo']);
  assert.ok((await Promise.all(ids.map(i => get(w, i)))).every(x => !x.lote));
  // remover o último título cancela o consolidado
  const r2 = await p.consolidar({ ids: [ids[0], ids[2]] });
  await p.removerDoConsolidado(r2.id, ids[0]);
  const fim = await p.removerDoConsolidado(r2.id, ids[2]);
  assert.equal(fim.cancelado, true); assert.equal((await get(w, r2.id)).estado, 'cancelado');
});

test('cancelarConta no consolidado desfaz a consolidação; o sync reconcilia títulos que ficaram para trás', async () => {
  const { w, p, A } = await pronto();
  const ids = [await conta(p, { titulo: 'z1', valor: 10, venc: addDays(today, 5), parceiroId: A }), await conta(p, { titulo: 'z2', valor: 20, venc: addDays(today, 5), parceiroId: A })];
  const r = await p.consolidar({ ids });
  await p.cancelarConta(r.id);
  assert.deepEqual([(await get(w, r.id)).estado, (await get(w, ids[0])).estado], ['cancelado', 'aberto']);
  // simula falha no meio do pagamento: consolidado pago, mas um filho ficou "Em consolidado"
  const r3 = await p.consolidar({ ids });
  await p.pagarConta(r3.id, { data: today, forma: 'Pix' });
  w.deals.find(x => +x.ID === ids[1]).STAGE_ID = w.store.ap.stages.consolidado;
  await p.tickDatas();
  assert.equal((await get(w, ids[1])).estado, 'pago');
});

test('cobrança de origem cancelada com repasse já consolidado: não cancela sozinho, avisa uma vez no consolidado', async () => {
  const w = world([{ ID: '1', TITLE: 'Licença', STAGE_ID: R.STAGES.open, OPPORTUNITY: '1000', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_SPLIT: 'Ana=10%', UF_CRM_CR_VENC: addDays(today, 20) + 'T00:00:00+03:00' }]);
  await w.svc.pagar.ensure(); const p = w.svc.pagar;
  const ana = (await p.salvarParceiro({ nome: 'Ana' })).id;
  await w.svc.sync();
  const rep = (await p.contas()).find(c => c.parceiroId === ana);
  const outro = await conta(p, { titulo: 'avulso', valor: 20, venc: addDays(today, 5), parceiroId: ana });
  w.deals.find(x => +x.ID === rep.id).STAGE_ID = w.store.ap.stages.open;                                 // repasse liberado
  const r = await p.consolidar({ ids: [rep.id, outro] });
  w.deals[0].STAGE_ID = R.STAGES.cancelled;                                                              // cobrança estornada depois
  await w.svc.sync(); await w.svc.sync();
  assert.equal((await get(w, rep.id)).estado, 'consolidado');
  assert.equal(w.comments.filter(c => /foi cancelada\/estornada\. Remova esse título/.test(c.COMMENT)).length, 1);
});

test('e-mail do consolidado: prévia, envio com CSV, registro na deal e erros claros', async () => {
  const w = world([{ ID: '9338', TITLE: 'Licença <Pro>', STAGE_ID: R.STAGES.paid, OPPORTUNITY: '1000', COMPANY_ID: '5', CONTACT_ID: '0', UF_CRM_CR_PAGO_EM: today }]);
  await w.svc.pagar.ensure(); const p = w.svc.pagar;
  w.store.setConfig({ empresaNome: 'Manda4 Tecnologia' });
  const A = (await p.salvarParceiro({ nome: 'Connect Think', email: 'fin@connect.com' })).id;
  const i1 = await conta(p, { titulo: 'Repasse 1', valor: 100, venc: addDays(today, 5), parceiroId: A }), i2 = await conta(p, { titulo: 'Repasse 2', valor: 60, venc: addDays(today, 5), parceiroId: A });
  w.deals.find(x => +x.ID === i1).UF_CRM_CP_ORIGEM = 9338;
  const r = await p.consolidar({ ids: [i1, i2], forma: 'Pix' });
  const prev = await p.emailConsolidado(r.id, { preview: true, mensagem: 'Segue o detalhe.' });
  assert.equal(prev.previa, true); assert.equal(prev.para, 'fin@connect.com'); assert.equal(prev.smtp, true);
  assert.match(prev.assunto, /^Demonstrativo de pagamento · Manda4 Tecnologia · Connect Think · #\d+ · /);
  assert.ok(prev.html.includes('R$ 160,00') && prev.html.includes('Repasse 1') && prev.html.includes('Repasse 2') && prev.html.includes('Segue o detalhe.'));
  assert.ok(prev.html.includes('ACME Ltda') && prev.html.includes('cobrança #9338')); assert.ok(!prev.html.includes('<Pro>'));      // cliente de origem aparece; texto do Bitrix é escapado
  assert.equal(w.emails.length, 0);                                                                                                  // prévia não envia
  const env = await p.emailConsolidado(r.id, { cc: 'diretoria@manda4.com.br', mensagem: 'Segue.' });
  assert.equal(env.enviado, true); assert.deepEqual(env.para, ['fin@connect.com']); assert.deepEqual(env.cc, ['diretoria@manda4.com.br']);
  const m = w.emails[0];
  assert.equal(m.to, 'fin@connect.com'); assert.equal(m.attachments.length, 1);
  assert.match(m.attachments[0].filename, /^demonstrativo-connect-think-\d+\.csv$/); assert.ok(m.attachments[0].content.includes('"TOTAL";"160,00"'));
  assert.ok(m.text.includes('TOTAL: R$ 160,00') && m.html.includes('<table'));
  const c = await get(w, r.id);
  assert.equal(c.enviadoPara, 'fin@connect.com'); assert.ok(c.enviadoEm);                                                          // fica registrado na deal
  assert.ok(w.comments.some(x => /Demonstrativo detalhado enviado por e-mail para fin@connect\.com \(cópia: diretoria@manda4\.com\.br\)/.test(x.COMMENT)));
  await p.emailConsolidado(r.id, { para: 'outro@x.com', anexo: false });
  assert.equal(w.emails[1].to, 'outro@x.com'); assert.equal(w.emails[1].attachments.length, 0);
  // erros
  w.mailer.ok = false;
  await assert.rejects(() => p.emailConsolidado(r.id, {}), /ainda não foi configurado/);
  assert.equal((await p.emailConsolidado(r.id, { preview: true })).smtp, false);                                                      // prévia continua funcionando sem SMTP
  w.mailer.ok = true;
  const sem = (await p.salvarParceiro({ nome: 'Sem Email' })).id;
  const s1 = await conta(p, { titulo: 's1', valor: 1, venc: addDays(today, 5), parceiroId: sem }), s2 = await conta(p, { titulo: 's2', valor: 2, venc: addDays(today, 5), parceiroId: sem });
  const rs = await p.consolidar({ ids: [s1, s2] });
  await assert.rejects(() => p.emailConsolidado(rs.id, {}), /parceiro não tem e-mail/);
  w.mailer.send = async () => { const e = new Error('Autenticação recusada'); throw e; };
  await assert.rejects(() => p.emailConsolidado(r.id, {}), /Não consegui enviar o e-mail: Autenticação recusada/);
  await assert.rejects(() => p.emailConsolidado(i1, {}), /não encontrado/);                                                           // só consolidados
});

test('e-mail do extrato do parceiro: período e situação, sem cancelados nem cabeçalho de consolidado', async () => {
  const { w, p, A } = await pronto();
  const x1 = await conta(p, { titulo: 'jan', valor: 100, venc: '2026-01-10', parceiroId: A }), x2 = await conta(p, { titulo: 'out', valor: 200, venc: '2026-10-20', parceiroId: A });
  const x3 = await conta(p, { titulo: 'cancelada', valor: 999, venc: '2026-10-21', parceiroId: A }); await p.cancelarConta(x3);
  const x4 = await conta(p, { titulo: 'nov', valor: 50, venc: addDays(today, 5), parceiroId: A }), x5 = await conta(p, { titulo: 'nov2', valor: 25, venc: addDays(today, 6), parceiroId: A });
  await p.consolidar({ ids: [x4, x5] });                                                                  // o cabeçalho do consolidado não deve aparecer duas vezes
  await p.pagarConta(x1, { data: today, forma: 'Pix', valor: 95 });
  const todos = await p.emailExtrato(A, { preview: true });
  assert.ok(todos.html.includes('R$ 370,00') || todos.html.includes('R$ 370'), todos.html.slice(0, 0) || '');   // 95 pago + 200 + 50 + 25
  assert.ok(!todos.html.includes('cancelada') && !todos.html.includes('Pagamento consolidado'));
  const out = await p.emailExtrato(A, { preview: true, de: '2026-10-01', ate: '2026-10-31' });
  assert.ok(out.html.includes('out') && !out.html.includes('jan') && out.html.includes('01/10/2026 a 31/10/2026'));
  const pagos = await p.emailExtrato(A, { preview: true, estados: ['pago'] });
  assert.ok(pagos.html.includes('R$ 95,00') && !pagos.html.includes('nov2'));
  await assert.rejects(() => p.emailExtrato(A, { preview: true, de: '2030-01-01' }), /Não há lançamentos/);
  const env = await p.emailExtrato(A, { para: 'a@b.com', de: '2026-10-01', ate: '2026-10-31' });
  assert.equal(env.enviado, true); assert.equal(w.emails.at(-1).to, 'a@b.com'); assert.match(w.emails.at(-1).attachments[0].filename, /^extrato-connect-think\.csv$/);
  const B = (await p.salvarParceiro({ nome: 'Almah Sem Email' })).id;
  await conta(p, { titulo: 'b1', valor: 10, venc: addDays(today, 5), parceiroId: B });
  await assert.rejects(() => p.emailExtrato(B, {}), /Informe o e-mail do destinatário/);                                              // parceiro sem e-mail e sem "para"
});
