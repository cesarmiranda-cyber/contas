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
  assert.match(R.validarReprogramacao({ ...ok, nova: '2026-06-01' }), /dentro de 05\/2026/);
  assert.match(R.validarReprogramacao({ ...ok, nova: '' }), /nova data/i);
  assert.match(R.validarReprogramacao({ ...ok, nova: '2026-05-10' }), /igual/);
});
test('prazo em horas úteis pula o fim de semana', () => {
  // sexta 16:00 (BRT) + 8h úteis = segunda 15:00
  assert.equal(R.prazoUtil(new Date('2026-05-08T19:00:00Z'), 8), '2026-05-11T15:00:00-03:00');
});

test('brIso formata a data com deslocamento de Brasília', () => {
  assert.equal(R.brIso('2026-10-22T00:11:05.000Z'), '2026-10-21T21:11:05-03:00');
});

test('alteração da data: só do dia seguinte em diante e dentro do mês da visita', () => {
  const base = { atual: '2026-05-20', motivo: 'Cliente pediu', hoje: '2026-05-10' };
  assert.equal(R.validarReprogramacao({ ...base, nova: '2026-05-11' }), null);
  assert.equal(R.validarReprogramacao({ ...base, nova: '2026-05-31' }), null);
  assert.match(R.validarReprogramacao({ ...base, nova: '2026-06-01' }), /não é permitido passar a visita para outro mês/i);
  assert.match(R.validarReprogramacao({ ...base, nova: '2026-05-10' }), /a partir de amanhã \(11\/05\/2026\) e até 31\/05\/2026/);
  assert.match(R.validarReprogramacao({ ...base, nova: '2026-05-02' }), /a partir de amanhã/);
  assert.equal(R.mesLimite('2026-03-10', '2026-05-02'), '2026-05', 'card nascido vencido ganha o mês em que nasceu');
  assert.equal(R.mesLimite('2026-06-10', '2026-05-02'), '2026-06');
  assert.equal(R.ultimoDiaDoMes('2026-02'), '2026-02-28');
});
