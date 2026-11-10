'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { criarHistorico } = require('../historico');

test('guarda em arquivo, mais recente primeiro, sem repetir a mesma pessoa em poucos minutos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')); let t = Date.parse('2026-11-10T10:00:00Z');
  const h = criarHistorico(dir, { agora: () => t, max: 3 });
  h.registrar('4_1', 5); t += 60e3; h.registrar('4_1', 5);          // repetida: só uma linha
  t += 60e3; h.registrar('4_1', 6); t += 20 * 60e3; h.registrar('4_1', 5);
  assert.deepEqual(h.ler('4_1').map(e => e.u), ['5', '6', '5']);
  h.registrar('4_1', 7); h.registrar('4_1', 8);
  assert.equal(h.ler('4_1').length, 3);                              // limite
  assert.deepEqual(criarHistorico(dir).ler('4_1').map(e => e.u), ['8', '7', '5']);   // persistiu
  assert.equal(fs.statSync(path.join(dir, 'consultas.json')).mode & 0o777, 0o600);
});
