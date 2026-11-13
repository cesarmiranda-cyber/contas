'use strict';
const test = require('node:test'); const assert = require('node:assert');
const A = require('../lib/auditoria');
test('diff: só o que mudou, com "de → para" legível', () => {
  const d = A.diff({ nome: 'A', inicio: '2030-01-01', fim: '2030-01-03', progresso: 10, interna: undefined, deps: [] }, { nome: 'A', inicio: '2030-01-02', fim: '2030-01-03', progresso: 40, interna: false, deps: [{ de: 'x', tipo: 'SS', lag: 2 }] }, A.CAMPOS_TAREFA, id => id === 'x' ? 'Outra' : id);
  assert.deepStrictEqual(d, [{ campo: 'Início', de: '2030-01-01', para: '2030-01-02' }, { campo: 'Andamento', de: '10%', para: '40%' }, { campo: 'Dependências', de: '—', para: 'Outra (começam juntas, +2d)' }]); // undefined→false não é mudança
  assert.deepStrictEqual(A.diff({ a: 1 }, { a: 1 }, { a: 'A' }), []);
});
test('diff do projeto marca campos internos', () => {
  const d = A.diff({ valor: 100, nome: 'P', situacao: 'andamento' }, { valor: 250.5, nome: 'Q', situacao: 'pausado' }, A.CAMPOS_PROJETO, x => x, A.INTERNOS_PROJETO);
  assert.strictEqual(d.find(x => x.campo === 'Valor do projeto').interno, true); assert.strictEqual(d.find(x => x.campo === 'Situação').para, 'Pausado'); assert.ok(!d.find(x => x.campo === 'Nome').interno);
});
test('visão do cliente: sem internos, sem acessos, sem atividade interna', () => {
  const L = (acao, extra = {}) => ({ id: acao, ts: '2030-01-01T10:00:00Z', quem: 'Ana', tipo: 'equipe', acao, detalhe: 'X', projetoId: 'p', diff: [], ...extra });
  assert.strictEqual(A.paraCliente(L('abriu_projeto')), null); assert.strictEqual(A.paraCliente(L('login')), null); assert.strictEqual(A.paraCliente(L('ativou_cliente')), null);
  assert.strictEqual(A.paraCliente(L('editou_tarefa', { interna: true, diff: [{ campo: 'Início', de: 'a', para: 'b' }] })), null);
  assert.strictEqual(A.paraCliente(L('editou_projeto', { diff: [{ campo: 'Valor do projeto', de: '1', para: '2', interno: true }] })), null); // só havia campo interno
  const e = A.paraCliente(L('editou_projeto', { diff: [{ campo: 'Valor do projeto', de: '1', para: '2', interno: true }, { campo: 'Nome', de: 'a', para: 'b' }] })); assert.deepStrictEqual(e.diff.map(d => d.campo), ['Nome']);
  const v = A.paraCliente(L('editou_tarefa', { diff: [{ campo: 'Atividade interna', de: 'Sim', para: 'Não' }], snap: { inicio: '2030-02-01', fim: '2030-02-03' } })); assert.strictEqual(v.acao, 'criou_tarefa'); assert.strictEqual(v.diff[0].para, '2030-02-01'); // passou a ser visível
  const r = A.paraCliente(L('reagendada_dependencia', { motivo: 'por causa de Y', diff: [{ campo: 'Início', de: 'a', para: 'b' }] })); assert.strictEqual(r.motivo, undefined);
});
test('CSV: cabeçalho, escape e proteção contra fórmula', () => {
  const t = A.csv([{ ts: '2030-01-01T10:00:00Z', quem: '=cmd|"x"', tipo: 'equipe', rotulo: 'alterou', detalhe: 'a;b', projetoId: 'p', diff: [{ campo: 'Início', de: '1', para: '2' }] }], () => 'Proj');
  assert.ok(t.startsWith('﻿Data/hora;Quem;Perfil;Ação;Projeto;Detalhe;Alterações\r\n')); assert.ok(t.includes('"\'=cmd|""x"""')); assert.ok(t.includes('"a;b"')); assert.ok(t.includes('Início: 1 → 2'));
});
