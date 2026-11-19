'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const R = require('../lib/rules');

test('classe é lida pelo nome (Clientes Estratégicos = E)', () => {
  assert.equal(R.classeLetra('Clientes Estratégicos'), 'E'); assert.equal(R.classeLetra('A'), 'A'); assert.equal(R.classeLetra('classe c'), 'C'); assert.equal(R.classeLetra(''), '');
});
test('próxima visita por classe cai em dia útil', () => {
  assert.equal(R.proximaVisita('A', '2026-11-18'), '2026-12-18');       // 30 dias, sexta
  assert.equal(R.proximaVisita('B', '2026-11-18'), '2027-01-18');       // 60 dias, segunda
  assert.equal(R.proximaVisita('C', '2026-11-18'), '2027-02-16');      
  assert.equal(R.proximaVisita('E', '2026-11-18'), '2027-05-18');
});
test('feriado e fim de semana são pulados', () => {
  assert.equal(R.nextBusinessDay('2026-11-20'), '2026-11-23');          // Consciência Negra (sex) -> segunda
  assert.equal(R.nextBusinessDay('2026-11-21'), '2026-11-23');
  assert.equal(R.addMonths('2026-08-31', 6), '2027-02-28');
});
test('primeira visita é distribuída a partir da próxima segunda', () => {
  assert.equal(R.primeiraVisita('A', 0, 10, '2026-11-18'), '2026-11-23');
  const ds = Array.from({ length: 10 }, (_, i) => R.primeiraVisita('A', i, 10, '2026-11-18'));
  assert.deepEqual(ds, [...ds].sort()); assert.ok(new Set(ds).size >= 8); assert.ok(ds.every(R.isBusinessDay));
  assert.equal(R.primeiraVisita('E', 0, 3, '2026-11-18').slice(0, 7), '2027-03');
});
test('etapa pela data: futuro/hoje/atrasada/mês vencido', () => {
  assert.equal(R.etapaPorData('2026-11-25', '2026-11-18'), 'NEW'); assert.equal(R.etapaPorData('2026-11-18', '2026-11-18'), 'PREPARATION');
  assert.equal(R.etapaPorData('2026-11-10', '2026-11-18'), 'LATE'); assert.equal(R.etapaPorData('2026-10-30', '2026-11-18'), 'NAOREAL');
});
test('todayBR usa o fuso de Brasília', () => { assert.equal(R.todayBR(new Date('2026-11-18T01:30:00Z')), '2026-11-17'); });
