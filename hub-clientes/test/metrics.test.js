'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/metrics');

const statuses = [
  ...Array.from({ length: 13 }, (_, i) => ({ statusId: 'S' + i, name: 'Mês ' + i, sort: 20 + i * 10 })),
  { statusId: 'WON', name: 'Assinado', sort: 150, semantics: 'S' }, { statusId: 'LOSE', name: 'CANCELADOS', sort: 160, semantics: 'F' },
];
const et = M.etapas(statuses);
const hoje = '2026-11-14';
const deal = (id, stage, extra = {}) => ({ id, title: 'c' + id + '.bitrix24.com.br', stageId: stage, companyId: 0, assignedById: 1, begindate: '2026-01-10T00:00:00.000Z', movedTime: '2026-11-01T00:00:00.000Z', ...extra });
const reg = (dealId, mes, extra = {}) => ({ dealId, mes, reuniaoRealizada: false, contatoFeito: false, ...extra });

test('etapas: reconhece Mês N, assinado e cancelados', () => {
  assert.equal(et.meses.length, 13); assert.equal(et.mes0.id, 'S0'); assert.equal(et.ultimo.mes, 12);
  assert.equal(et.ganho.id, 'WON'); assert.equal(et.perdido.id, 'LOSE');
});
test('situacao: registro, pendente, atrasado e cliente ainda inexistente', () => {
  assert.equal(M.situacao(reg(1, '2026-11', { reuniaoRealizada: true }), '2026-11', hoje), 'reuniao');
  assert.equal(M.situacao(reg(1, '2026-11', { contatoFeito: true }), '2026-11', hoje), 'contato');
  assert.equal(M.situacao(reg(1, '2026-11'), '2026-11', hoje), 'sem_contato');
  assert.equal(M.situacao(null, '2026-11', hoje), 'pendente');
  assert.equal(M.situacao(null, '2026-11', '2026-11-25'), 'atrasado');
  assert.equal(M.situacao(null, '2026-10', hoje), 'atrasado');
  assert.equal(M.situacao(null, '2025-12', hoje, '2026-01-10'), 'na');
});
test('clientes: sequência, dias sem contato e sugestão de mover', () => {
  const regs = [reg(1, '2026-09', { contatoFeito: true, data: '2026-09-10' }), reg(1, '2026-10', { reuniaoRealizada: true, data: '2026-10-20', saude: 'amarelo' })];
  const l = M.clientes({ deals: [deal(1, 'S5', { movedTime: '2026-10-05T00:00:00.000Z' }), deal(2, 'S12'), deal(3, 'LOSE')], etapa: et, registros: regs, mes: '2026-11', hoje });
  const c = l.find(x => x.id === 1);
  assert.equal(c.status, 'pendente'); assert.equal(c.sequencia, 2); assert.equal(c.diasSemContato, 25);
  assert.equal(c.saude, 'amarelo'); assert.deepEqual(c.mover, { tipo: 'avancar', vencida: true });
  assert.equal(l.find(x => x.id === 2).mover.tipo, 'decidir');
  assert.equal(l.find(x => x.id === 3).tipoEtapa, 'perdido');
});
test('dashboard: cobertura, alertas e série', () => {
  const regs = [reg(1, '2026-11', { reuniaoRealizada: true, data: '2026-11-05', saude: 'vermelho' }), reg(2, '2026-11', { contatoFeito: true, data: '2026-11-06', renovacao: 'improvavel' })];
  const l = M.clientes({ deals: [deal(1, 'S1'), deal(2, 'S2'), deal(3, 'S2'), deal(4, 'WON')], etapa: et, registros: regs, mes: '2026-11', hoje });
  const D = M.dashboard({ lista: l, etapa: et, registros: regs, mes: '2026-11', hoje });
  assert.equal(D.geral.total, 3); assert.equal(D.geral.reuniao, 1); assert.equal(D.geral.contato, 1); assert.equal(D.geral.pendente, 1);
  assert.equal(+D.cobertura.toFixed(2), 0.67); assert.equal(D.encerrados.assinados, 1);
  assert.equal(D.resumoAlertas.saude, 1); assert.equal(D.resumoAlertas.renovacao, 1);
  assert.equal(D.serie.length, 6); assert.equal(D.serie[5].mes, '2026-11');
  assert.equal(D.porEtapa.find(e => e.mes === 2).total, 2);
});
test('destino: avançar, renovar e cancelar respeitam o ciclo', () => {
  assert.equal(M.destino('avancar', et.porId.S3, et).etapa.id, 'S4');
  assert.ok(M.destino('avancar', et.porId.S12, et).erro);
  assert.equal(M.destino('renovar', et.porId.S12, et).etapa.id, 'S0');
  assert.ok(M.destino('renovar', et.porId.S5, et).erro);
  assert.equal(M.destino('cancelar', et.porId.S5, et).etapa.id, 'LOSE');
  assert.ok(M.destino('avancar', et.porId.WON, et).erro);
});
