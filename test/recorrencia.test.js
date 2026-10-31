'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { today, world, R } = require('../testkit/world');
const Rec = require('../lib/recorrencia');

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test('datas: mensal preserva o dia (31 → fim do mês, sem derrapar), semanal e anual; respeita quantidade, fim e horizonte de 12 meses', () => {
  assert.deepEqual(Rec.ocorrencias({ freq: 'mensal', inicio: '2026-01-31', qtd: 4 }, '2026-01-01').map(o => o.venc), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(Rec.ocorrencias({ freq: 'semanal', inicio: '2026-11-02', fim: '2026-11-30' }, '2026-11-01').map(o => o.venc).length, 5);
  assert.equal(Rec.ocorrencias({ freq: 'mensal', inicio: '2026-11-05' }, '2026-11-01').length, 12);          // sem fim: 12 meses à frente
  assert.equal(Rec.ocorrencias({ freq: 'anual', inicio: '2026-11-05' }, '2026-11-01').length, 1);
  assert.equal(Rec.ocorrencias({ freq: 'trimestral', inicio: '2026-11-05', qtd: 3 }, '2026-11-01').length, 3);
  assert.throws(() => Rec.normalizar({ freq: 'quando-der', inicio: today }), /Frequência/);
  assert.throws(() => Rec.normalizar({ freq: 'mensal', inicio: addDays(today, -1) }), /passado/);
  assert.throws(() => Rec.normalizar({ freq: 'mensal', inicio: today, qtd: 3, fim: addDays(today, 90) }), /OU/);
});

async function pronto() {
  const w = world([]); await w.svc.ensureFields(); await w.svc.pagar.ensure();
  const A = (await w.svc.pagar.salvarParceiro({ nome: 'Imobiliária' })).id;
  return { w, A };
}

test('conta a pagar recorrente: gera as ocorrências, não duplica no sync, completa o horizonte, edita valor futuro e encerra', async () => {
  const { w, A } = await pronto(); const { recs, pagar } = w.svc;
  const r = await recs.criar({ tipo: 'pagar', template: { titulo: 'Aluguel', valor: 4500, categoria: 'Estrutura e software', parceiroId: A, forma: 'Boleto' }, recorrencia: { freq: 'mensal', inicio: addDays(today, 5) } });
  assert.equal(r.geradas, 12);
  let cs = (await pagar.contas()).filter(c => c.recor);
  assert.equal(cs.length, 12); assert.ok(cs.every(c => c.valor === 4500 && c.categoria === 'Estrutura e software' && c.parceiroId === A));
  assert.deepEqual(cs.map(c => Rec.parseRecor(c.recor).idx).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal((await recs.gerarTodas()).criadas, 0);                                   // idempotente
  const [a, b] = await Promise.all([recs.gerarTodas(), recs.gerarTodas()]);             // chamadas simultâneas não duplicam
  assert.equal(a.criadas + b.criadas, 0);
  assert.equal((await pagar.contas()).filter(c => c.recor).length, 12);
  // paga a primeira; muda o valor: só as futuras não pagas mudam
  const primeira = cs.find(c => Rec.parseRecor(c.recor).idx === 1);
  await pagar.pagarConta(primeira.id, { valor: 4500 });
  const e = await recs.editar(r.regra.id, { valor: 4800 });
  assert.equal(e.atualizadas, 11);
  cs = (await pagar.contas()).filter(c => c.recor);
  assert.equal(cs.find(c => c.id === primeira.id).valor, 4500);
  assert.equal(cs.filter(c => c.valor === 4800).length, 11);
  // lista com resumo
  const l = (await recs.listar()).find(x => x.id === r.regra.id);
  assert.equal(l.geradas, 12); assert.ok(l.proxima); assert.match(l.rotulo, /Mensal · sem fim/);
  // pausar não gera mais; encerrar com cancelamento das futuras
  await recs.editar(r.regra.id, { ativa: false });
  const enc = await recs.encerrar(r.regra.id, { cancelarFuturas: true });
  assert.equal(enc.canceladas, 11);
  cs = (await pagar.contas()).filter(c => c.recor);
  assert.equal(cs.filter(c => c.estado === 'cancelado').length, 11); assert.equal(cs.filter(c => c.estado === 'pago').length, 1);
});

test('recorrência com quantidade fixa gera só N; recebimento manual recorrente gera títulos a receber sem Asaas', async () => {
  const { w } = await pronto(); const { recs } = w.svc;
  w.asaas.enabled = true;
  const r = await w.svc.cobrar.nova({ tipo: 'manual', titulo: 'Mensalidade suporte', valor: 1200, venc: addDays(today, 3), companyId: '5', recorrencia: { freq: 'mensal', qtd: 6 } });
  assert.equal(r.parcelas, 6);
  const ds = (await w.svc.loadDeals()).filter(d => d.recor);
  assert.equal(ds.length, 6); assert.ok(ds.every(d => d.manual && d.valor === 1200 && !d.asaasId));
  await w.svc.sync(); assert.equal(Object.keys(w.pays).length, 0);                      // nunca cobra no Asaas
  assert.equal((await w.svc.loadDeals()).filter(d => d.recor).length, 6);
  const rule = (await recs.listar())[0];
  const e = await recs.editar(rule.id, { valor: 1300 });
  assert.equal(e.atualizadas, 6);
  assert.ok((await w.svc.loadDeals()).filter(d => d.recor).every(d => d.valor === 1300));
  await assert.rejects(() => recs.editar('rc_naoexiste', {}), /não encontrada/);
});
