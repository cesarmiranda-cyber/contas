'use strict';
const fs = require('fs');
const { defaults } = require('./finCad');
const path = require('path');

// Persistência do módulo financeiro (arquivo JSON, escrita atômica): empresas, funcionários,
// contas a pagar, recebimentos manuais, avisos de contrato enviados e configuração.
// As chaves do Asaas de cada empresa NÃO ficam aqui — vão para secrets.json (modo 0600).
const DEFAULTS = () => ({
  empresas: [], funcionarios: [], pagar: [], receber: [], avisos: {}, folhas: {},
  config: { folhaAuto: true, contratoCampoVenc: '', contratoEtapasAtivas: [], marcosAviso: [60, 30, 15, 7, 0], saldoInicial: {} },
});

function createFinStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'financeiro.json');
  let data = DEFAULTS();
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); data = { ...data, ...d, config: { ...data.config, ...d.config } }; } catch { /* primeiro uso */ }
  // cadastros novos: formas, condições e categorias nascem com padrões (só na 1ª vez); o resto começa vazio
  const seed = defaults();
  for (const k of ['formas', 'condicoes', 'categorias']) if (!Array.isArray(data[k])) data[k] = seed[k];
  for (const k of ['contas', 'centros', 'fornecedores', 'transferencias', 'extratos', 'recorrencias', 'orcamentos', 'notas', 'produtos', 'movimentos']) if (!Array.isArray(data[k])) data[k] = [];
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); };
  const table = k => ({
    all: () => data[k],
    get: id => data[k].find(x => x.id === id),
    add(items) { data[k].push(...[].concat(items)); save(); return items; },
    put(item) { const i = data[k].findIndex(x => x.id === item.id); if (i < 0) throw new Error('Registro não encontrado'); data[k][i] = item; save(); return item; },
    remove(id) { data[k] = data[k].filter(x => x.id !== id); save(); },
  });
  return {
    empresas: table('empresas'), funcionarios: table('funcionarios'), pagar: table('pagar'), receber: table('receber'),
    contas: table('contas'), formas: table('formas'), condicoes: table('condicoes'), categorias: table('categorias'), centros: table('centros'), fornecedores: table('fornecedores'), transferencias: table('transferencias'), extratos: table('extratos'), recorrencias: table('recorrencias'), orcamentos: table('orcamentos'), notas: table('notas'), produtos: table('produtos'), movimentos: table('movimentos'),
    get config() { return data.config; },
    setConfig(patch) { data.config = { ...data.config, ...patch }; save(); return data.config; },
    avisos: id => data.avisos[id] || [],
    markAviso(id, marco) { (data.avisos[id] ||= []).push(marco); save(); },
    folhaGerada(empresaId, competencia) { return data.folhas[`${empresaId}|${competencia}`] || null; },
    markFolha(empresaId, competencia, info) { data.folhas[`${empresaId}|${competencia}`] = info; save(); },
    get folhas() { return data.folhas; },
    save,
  };
}
module.exports = { createFinStore };
