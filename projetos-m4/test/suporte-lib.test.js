'use strict';
const test = require('node:test'); const assert = require('node:assert'); const SLA = require('../lib/sla'); const Aj = require('../lib/ajuda');
test('SLA: prazo por prioridade, estados e primeira resposta', () => {
  const cfg = SLA.config({ config: { sla: { alta: 6, media: 'x', baixa: -1 } } }); assert.deepStrictEqual(cfg, { urgente: 2, alta: 6, media: 8, baixa: 24 }); // inválidos voltam ao padrão
  const t0 = Date.parse('2031-02-03T10:00:00Z'); const s = { criadoEm: new Date(t0).toISOString(), prioridade: 'alta', status: 'nova', mensagens: [] };
  assert.strictEqual(SLA.calcular(s, cfg, t0 + 60e3).estado, 'ok'); assert.strictEqual(SLA.calcular(s, cfg, t0 + 6 * 3600e3 - 3600e3).estado, 'vencendo'); // resta 1h de 6h (< 25%)
  assert.strictEqual(SLA.calcular(s, cfg, t0 + 7 * 3600e3).estado, 'estourado'); assert.strictEqual(SLA.calcular(s, cfg, t0).prazo, '2031-02-03T16:00:00.000Z'); assert.strictEqual(SLA.calcular(s, cfg, t0).restanteMin, 360);
  // nota interna não conta como resposta; resposta da equipe cumpre (ou cumpre atrasado)
  assert.strictEqual(SLA.calcular({ ...s, mensagens: [{ tipoAutor: 'equipe', interna: true, ts: new Date(t0 + 1e3).toISOString() }] }, cfg, t0 + 2e3).estado, 'ok');
  assert.strictEqual(SLA.calcular({ ...s, mensagens: [{ tipoAutor: 'cliente', ts: new Date(t0 + 1e3).toISOString() }] }, cfg, t0 + 2e3).estado, 'ok'); // mensagem do cliente também não conta
  assert.strictEqual(SLA.calcular({ ...s, mensagens: [{ tipoAutor: 'equipe', ts: new Date(t0 + 3600e3).toISOString() }] }, cfg, t0 + 99e9).estado, 'cumprido'); assert.strictEqual(SLA.calcular({ ...s, mensagens: [{ tipoAutor: 'equipe', ts: new Date(t0 + 8 * 3600e3).toISOString() }] }, cfg, t0 + 99e9).estado, 'cumprido_atrasado');
  assert.strictEqual(SLA.calcular({ ...s, status: 'concluida' }, cfg, t0 + 99e9).estado, 'encerrado');
});
test('ajuda: sugere artigos por título, palavras-chave e texto, sem acento e ignorando rascunhos', () => {
  const art = [{ id: 1, titulo: 'Como recuperar a senha do Bitrix24', texto: 'Clique em esqueci a senha na tela de login.', palavras: 'acesso login' }, { id: 2, titulo: 'Importar contatos por planilha', texto: 'Use o arquivo CSV ou XLSX.' }, { id: 3, titulo: 'Rascunho de senha', texto: 'senha', publicado: false }, { id: 4, titulo: 'Emitir nota fiscal', texto: 'Faturamento mensal.' }];
  assert.deepStrictEqual(Aj.sugerir(art, 'Esqueci minha SENHA de acesso').map(a => a.id), [1]); assert.deepStrictEqual(Aj.sugerir(art, 'não consigo importar os contatos').map(a => a.id), [2]);
  assert.deepStrictEqual(Aj.sugerir(art, 'nota fiscal faturamento').map(a => a.id), [4]); assert.deepStrictEqual(Aj.sugerir(art, 'ok'), []); assert.deepStrictEqual(Aj.sugerir(art, 'assunto sem relação alguma'), []);
  assert.deepStrictEqual(Aj.palavras('Importação de dados e planilhas'), ['importacao', 'dados', 'planilhas']);
});
