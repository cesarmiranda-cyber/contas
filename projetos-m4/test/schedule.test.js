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

const cal = S.calendario({ diasUteis: true });
test('dias úteis: fim de semana e feriados nacionais não contam', () => {
  assert.ok(cal.util('2030-01-04') && !cal.util('2030-01-05') && !cal.util('2030-01-06')); // sex útil, sáb e dom não
  assert.ok(!cal.util('2030-12-25') && !cal.util('2030-11-15') && !cal.util('2030-01-01') && !cal.util('2030-11-20')); // feriados
  assert.strictEqual(S.feriadosBR(2030).includes('2030-04-19'), true); assert.strictEqual(S.feriadosBR(2026).includes('2026-04-03'), true); // Sexta-feira Santa 2030 e 2026
  assert.strictEqual(cal.proximoUtil('2030-01-05'), '2030-01-07'); assert.strictEqual(cal.anteriorUtil('2030-01-06'), '2030-01-04');
  assert.strictEqual(cal.somaUteis('2030-01-04', 1), '2030-01-07'); assert.strictEqual(cal.somaUteis('2030-01-04', 5), '2030-01-11'); assert.strictEqual(cal.somaUteis('2030-01-07', -1), '2030-01-04');
  assert.strictEqual(cal.diffUteis('2030-01-04', '2030-01-09'), 3); assert.strictEqual(cal.diffUteis('2030-01-09', '2030-01-04'), -3);
  assert.strictEqual(cal.somaUteis('2030-12-24', 1), '2030-12-26'); // pula o Natal
  const ex = S.calendario({ diasUteis: true, extras: ['2030-03-05'] }); assert.ok(!ex.util('2030-03-05')); // Carnaval como feriado extra
  assert.strictEqual(S.calendario().util('2030-01-05'), true); assert.strictEqual(S.calendario().somaUteis('2030-01-04', 1), '2030-01-05'); // desligado: dias corridos
});
test('dias úteis: dependência, defasagem e duração em dias úteis', () => {
  const a = T('a', '2030-01-02', '2030-01-04'), b = T('b', '2030-01-02', '2030-01-03', { deps: [{ de: 'a', tipo: 'FS', lag: 0 }] }); // a termina na sexta
  assert.deepStrictEqual(S.reagendar([a, b], cal), ['b']); assert.deepStrictEqual([b.inicio, b.fim], ['2030-01-07', '2030-01-08']); // b começa na segunda, 2 dias úteis
  const c = T('c', '2030-01-02', '2030-01-02', { deps: [{ de: 'a', tipo: 'FS', lag: 2 }] }); S.reagendar([a, c], cal); assert.strictEqual(c.inicio, '2030-01-09'); // +2 dias úteis
  const d = T('d', '2030-01-02', '2030-01-02', { deps: [{ de: 'a', tipo: 'SS', lag: 1 }] }); S.reagendar([a, d], cal); assert.strictEqual(d.inicio, '2030-01-03'); // 1 dia útil depois do início de a
  const e = T('e', '2030-01-02', '2030-01-04', { deps: [{ de: 'a', tipo: 'FS', lag: 0 }] }); S.reagendar([a, e], cal); assert.deepStrictEqual([e.inicio, e.fim], ['2030-01-07', '2030-01-09']); // 3 dias úteis preservados (seg a qua)
  const f = T('f', '2030-01-04', '2030-01-09'); assert.strictEqual(cal.diffUteis(f.inicio, f.fim), 3); // sex a ter = 4 dias úteis de trabalho
  const g = T('g', '2030-01-02', '2030-01-02', { deps: [{ de: 'a', tipo: 'FS', lag: 0 }] }), a2 = T('a', '2030-12-23', '2030-12-24'); S.reagendar([a2, g], cal); assert.strictEqual(g.inicio, '2030-12-26'); // pula o Natal
  const x = T('x', '2030-01-02', '2030-01-04', { deps: [{ de: 'a', tipo: 'FS', lag: 0 }] }), y = T('y', '2030-01-02', '2030-01-04', { deps: [{ de: 'a', tipo: 'FS', lag: 0 }] }); S.reagendar([T('a', '2030-01-02', '2030-01-04'), x], S.CAL_CORRIDOS); assert.strictEqual(x.inicio, '2030-01-05'); assert.ok(y); // corridos: sábado
});
test('dias úteis: normalizar leva início e término para dias úteis', () => {
  const t = T('t', '2030-01-05', '2030-01-06'); assert.deepStrictEqual(S.normalizar([t], cal), ['t']); assert.deepStrictEqual([t.inicio, t.fim], ['2030-01-07', '2030-01-07']); // sáb–dom vira segunda
  const u = T('u', '2030-01-03', '2030-01-06'); S.normalizar([u], cal); assert.deepStrictEqual([u.inicio, u.fim], ['2030-01-03', '2030-01-04']); // término no domingo volta para sexta
  const v = T('v', '2030-01-07', '2030-01-08'); assert.deepStrictEqual(S.normalizar([v], cal), []); assert.deepStrictEqual(S.normalizar([T('w', '2030-01-05', '2030-01-06')], S.CAL_CORRIDOS), []); // corridos não mexe
  assert.strictEqual(S.minimoDep({ inicio: '2030-01-02', fim: '2030-01-04' }, 'FS', 3, cal), '2030-01-10'); assert.strictEqual(S.baseDep({ inicio: '2030-01-02', fim: '2030-01-04' }, 'FS', cal), '2030-01-07');
});
