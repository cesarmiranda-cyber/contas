'use strict';
// Quem consultou cada cliente e quando. Guardado em arquivo (DATA_DIR/consultas.json, modo 600), últimas `max` por cliente.
const fs = require('fs');
const path = require('path');

function criarHistorico(dir, { agora = Date.now, max = 20, janelaMs = 10 * 60e3 } = {}) {
  const arq = path.join(dir, 'consultas.json');
  let dados = {};
  try { dados = JSON.parse(fs.readFileSync(arq, 'utf8')) || {}; } catch { /* primeira execução */ }
  function salvar() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${arq}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(dados), { mode: 0o600 });
    fs.renameSync(tmp, arq);
  }
  return {
    ler: chave => (dados[chave] || []).slice(),                 // mais recente primeiro: [{u, t}]
    registrar(chave, usuario) {
      const lista = dados[chave] || (dados[chave] = []);
      const t = agora();
      // a mesma pessoa consultando de novo em poucos minutos atualiza a hora em vez de repetir a linha
      const i = lista.findIndex(e => e.u === String(usuario) && t - Date.parse(e.t) < janelaMs);
      if (i >= 0) lista.splice(i, 1);
      lista.unshift({ u: String(usuario), t: new Date(t).toISOString() });
      lista.length = Math.min(lista.length, max);
      salvar();
    },
  };
}
module.exports = { criarHistorico };
