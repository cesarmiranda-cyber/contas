'use strict';
const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('./rules');

// Banco do app (arquivo JSON, escrita atômica). Não é uma segunda fila: guarda só configuração,
// histórico de reprogramações, log/auditoria, controle de duplicidade e snapshots para detectar edições.
function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  let d = { config: {}, historico: [], log: [], bloqueios: [], cards: {}, chaves: {}, snapCards: {}, snapVisitas: {}, snapEmpresas: {}, jobs: {}, lastSweep: null };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* primeiro uso */ }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, file); };
  return {
    get config() { return { ...DEFAULT_CONFIG, ...d.config, intervalos: { ...DEFAULT_CONFIG.intervalos, ...(d.config.intervalos || {}) } }; },
    setConfig(p) { d.config = { ...d.config, ...p }; save(); return this.config; },
    // duplicidade: chave empresa+segmento+cargo -> id do card aberto
    chave(k) { return d.chaves[k]; },
    setChave(k, id) { if (id) d.chaves[k] = id; else delete d.chaves[k]; save(); },
    chaves() { return d.chaves; },
    card(id) { return d.cards[id]; },
    setCard(id, v) { d.cards[id] = v; save(); },
    snapCard(id) { return d.snapCards[id]; }, setSnapCard(id, v) { d.snapCards[id] = v; save(); },
    snapVisita(id) { return d.snapVisitas[id]; }, setSnapVisita(id, v) { d.snapVisitas[id] = v; save(); },
    snapEmpresa(id) { return d.snapEmpresas[id]; }, setSnapEmpresa(id, v) { d.snapEmpresas[id] = v; save(); },
    addHistorico(h) { d.historico.unshift({ at: new Date().toISOString(), ...h }); save(); },
    get historico() { return d.historico; },
    log(tipo, msg, extra) { d.log.unshift({ at: new Date().toISOString(), tipo, msg, ...(extra || {}) }); d.log.length = Math.min(d.log.length, 1000); save(); },
    get logs() { return d.log; },
    addBloqueio(b) { d.bloqueios.unshift({ at: new Date().toISOString(), ...b }); d.bloqueios.length = Math.min(d.bloqueios.length, 500); save(); },
    get bloqueios() { return d.bloqueios; },
    job(k) { return d.jobs[k]; }, setJob(k, v) { d.jobs[k] = v; save(); },
    get lastSweep() { return d.lastSweep; }, setLastSweep(v) { d.lastSweep = v; save(); },
  };
}
module.exports = { createStore };
