'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createJobs } = require('../lib/jobs');
const espera = ms => new Promise(r => setTimeout(r, ms));

test('tarefa longa: inicia sem bloquear, informa progresso, entrega o resultado e não roda em duplicidade', async () => {
  let execucoes = 0;
  const jobs = createJobs({ lenta: async (b, passo) => { execucoes++; passo('lendo…'); await espera(60); passo('analisando…'); await espera(60); return { ok: true, eco: b.x }; }, quebra: async () => { throw new Error('Bitrix fora'); } });
  assert.equal(jobs.estado('lenta').status, 'nenhum');
  const t0 = Date.now(), j = jobs.iniciar('lenta', { x: 7 });
  assert.ok(Date.now() - t0 < 30); assert.equal(j.status, 'rodando');                    // devolve na hora
  await espera(20); assert.equal(jobs.estado('lenta').passo, 'lendo…');
  assert.equal(jobs.iniciar('lenta', { x: 8 }).status, 'rodando'); assert.equal(execucoes, 1);   // 2º pedido não dispara outra execução
  await espera(150);
  const fim = jobs.estado('lenta'); assert.equal(fim.status, 'concluido'); assert.deepEqual(fim.resultado, { ok: true, eco: 7 }); assert.ok(fim.fim >= fim.inicio);
  assert.equal(jobs.iniciar('lenta', { x: 9 }).status, 'rodando'); await espera(5); assert.equal(execucoes, 2);   // depois de concluir, pode rodar de novo
  jobs.iniciar('quebra'); await espera(20);
  assert.equal(jobs.estado('quebra').status, 'erro'); assert.match(jobs.estado('quebra').erro, /Bitrix fora/);
  assert.throws(() => jobs.iniciar('nada'), /desconhecida/);
});
