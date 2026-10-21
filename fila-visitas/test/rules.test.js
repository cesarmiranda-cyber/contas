'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/rules');

test('data programada = última visita + intervalo do cargo/classe', () => {
  assert.equal(R.dataProgramada(R.DEFAULT_CONFIG, { cargo: 'Vendedor', classe: 'A', ultima: '2026-01-10', hoje: '2026-06-01' }), '2026-02-09');
  assert.equal(R.dataProgramada(R.DEFAULT_CONFIG, { cargo: 'Diretor', classe: 'C', ultima: '2026-01-01', hoje: '2026-06-01' }), '2026-07-30');
  assert.equal(R.dataProgramada(R.DEFAULT_CONFIG, { cargo: 'Gerente', classe: 'B', ultima: null, hoje: '2026-06-01' }), '2026-10-29');
  assert.equal(R.dataProgramada(R.DEFAULT_CONFIG, { cargo: 'Gerente', classe: '', ultima: null, hoje: '2026-06-01' }), null);
});
test('antecipada: visita antes da data programada', () => {
  assert.equal(R.antecipada('2026-05-01', '2026-05-10'), true);
  assert.equal(R.antecipada('2026-05-10', '2026-05-10'), false);
  assert.equal(R.antecipada('2026-05-12', '2026-05-10'), false);
});
test('etapa por data', () => {
  assert.equal(R.etapaPara('2026-05-09', '2026-05-10'), 'atrasada');
  assert.equal(R.etapaPara('2026-05-10', '2026-05-10'), 'dia');
  assert.equal(R.etapaPara('2026-05-11', '2026-05-10'), 'aguardando');
});
test('reprogramação: motivo obrigatório e mesmo mês', () => {
  const ok = { atual: '2026-05-10', nova: '2026-05-25', motivo: 'Cliente viajando' };
  assert.equal(R.validarReprogramacao(ok), null);
  assert.match(R.validarReprogramacao({ ...ok, motivo: ' ' }), /motivo/i);
  assert.match(R.validarReprogramacao({ ...ok, nova: '2026-06-01' }), /mesmo mês.*05\/2026/);
  assert.match(R.validarReprogramacao({ ...ok, nova: '' }), /nova data/i);
  assert.match(R.validarReprogramacao({ ...ok, nova: '2026-05-10' }), /igual/);
});
test('prazo em horas úteis pula o fim de semana', () => {
  // sexta 16:00 (BRT) + 8h úteis = segunda 15:00
  assert.equal(R.prazoUtil(new Date('2026-05-08T19:00:00Z'), 8), '2026-05-11T15:00:00-03:00');
});
