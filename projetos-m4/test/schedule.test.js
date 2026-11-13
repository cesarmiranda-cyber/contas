'use strict';
const test = require('node:test'); const assert = require('node:assert');
const S = require('../lib/schedule');
const T = (id, inicio, fim, extra = {}) => ({ id, inicio, fim, progresso: 0, deps: [], ...extra });

test('FS empurra a sucessora e mantém a duração', () => {
  const a = T('a', '2026-01-05', '2026-01-09'), b = T('b', '2026-01-06', '2026-01-08', { deps: [{ de: 'a', tipo: 'FS', lag: 0 }] });
  assert.deepStrictEqual(S.reagendar([a, b]), ['b']);
  assert.deepStrictEqual([b.inicio, b.fim], ['2026-01-10', '2026-01-12']);
});
test('SS começa junto e respeita lag; cascata em cadeia', () => {
  const a = T('a', '2026-01-05', '2026-01-09'), b = T('b', '2026-01-01', '2026-01-02', { deps: [{ de: 'a', tipo: 'SS', lag: 2 }] });
  const c = T('c', '2026-01-01', '2026-01-01', { deps: [{ de: 'b', tipo: 'FS', lag: 0 }] });
  S.reagendar([c, b, a]);
  assert.strictEqual(b.inicio, '2026-01-07'); assert.strictEqual(c.inicio, '2026-01-09');
});
test('não puxa tarefa para trás', () => {
  const a = T('a', '2026-01-05', '2026-01-06'), b = T('b', '2026-02-01', '2026-02-02', { deps: [{ de: 'a', tipo: 'FS', lag: 0 }] });
  assert.deepStrictEqual(S.reagendar([a, b]), []); assert.strictEqual(b.inicio, '2026-02-01');
});
test('ciclo é rejeitado', () => {
  const a = T('a', '2026-01-05', '2026-01-06', { deps: [{ de: 'b', tipo: 'FS' }] }), b = T('b', '2026-01-05', '2026-01-06', { deps: [{ de: 'a', tipo: 'FS' }] });
  assert.throws(() => S.reagendar([a, b]), /circular/);
});
test('status: verde, amarelo e vermelho', () => {
  const hoje = '2026-03-10';
  assert.strictEqual(S.status(T('x', '2026-03-01', '2026-03-09'), [], hoje).cor, 'vermelho');
  assert.strictEqual(S.status(T('x', '2026-03-01', '2026-03-09', { progresso: 100 }), [], hoje).codigo, 'concluida');
  assert.strictEqual(S.status(T('x', '2026-03-01', '2026-03-20', { progresso: 5 }), [], hoje).cor, 'amarelo'); // abaixo do ritmo
  assert.strictEqual(S.status(T('x', '2026-03-05', '2026-03-12', { progresso: 70 }), [], hoje).cor, 'amarelo'); // prazo próximo
  assert.strictEqual(S.status(T('x', '2026-03-01', '2026-03-30', { progresso: 40 }), [], hoje).cor, 'verde');
  const atras = T('p', '2026-03-01', '2026-03-05'), fut = T('f', '2026-03-15', '2026-03-20', { deps: [{ de: 'p', tipo: 'FS' }] });
  assert.strictEqual(S.status(fut, [atras, fut], hoje).cor, 'amarelo');
});
test('atividade de um dia, no próprio dia, não fica em alerta com andamento parcial', () => {
  assert.strictEqual(S.status(T('x', '2026-03-10', '2026-03-10', { progresso: 50 }), [], '2026-03-10').cor, 'verde');
  assert.strictEqual(S.status(T('x', '2026-03-10', '2026-03-10', { progresso: 0 }), [], '2026-03-10').cor, 'verde');
  assert.strictEqual(S.status(T('x', '2026-03-10', '2026-03-10', { progresso: 50 }), [], '2026-03-11').cor, 'vermelho'); // passou o dia sem concluir
});
test('resumo do projeto', () => {
  const r = S.resumo([T('a', '2026-03-01', '2026-03-09'), T('b', '2026-03-20', '2026-03-25')], '2026-03-10');
  assert.strictEqual(r.cor, 'vermelho'); assert.strictEqual(r.vermelho, 1); assert.strictEqual(r.fim, '2026-03-25');
});
test('datas', () => { assert.ok(S.isDate('2026-02-28')); assert.ok(!S.isDate('2026-02-30')); assert.ok(!S.isDate('x')); });
