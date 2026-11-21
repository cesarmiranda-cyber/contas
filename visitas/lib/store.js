'use strict';
const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('./rules');
// Estado do app (arquivo JSON, escrita atômica): configuração, histórico de reprogramações, log, tarefas. O negócio vive no Bitrix.
function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'state.json');
  let d = { config: {}, historico: [], log: [], tarefas: {}, snaps: {}, trocas: {}, excluidos: {}, admitidos: [], removidos: [] };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') { try { fs.renameSync(file, `${file}.corrompido-${Date.now()}`); } catch { /* sem permissão */ } } }
  d.config = { ...DEFAULT_CONFIG, ...d.config };
  const removidos = new Set((d.removidos || []).map(String));        // cards que o app moveu para Removido de propósito (Excluir, auditoria): nunca são restaurados em massa
  const admitidos = new Set((d.admitidos || []).map(String));      // cards aprovados à mão para aparecer mesmo sem Última visita no cadastro
  let timer = null;
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(d), { mode: 0o600 }); fs.renameSync(t, file); };
  const later = () => { if (!timer) { timer = setTimeout(() => { timer = null; try { flush(); } catch (e) { console.error('state', e.message); } }, 1500); timer.unref?.(); } };
  process.on('exit', () => { if (timer) try { flush(); } catch { /* fim */ } });
  return {
    get config() { return d.config; },
    setConfig(p) { d.config = { ...d.config, ...p }; flush(); return d.config; },
    log(type, msg, extra) { d.log.unshift({ at: new Date().toISOString(), type, msg, ...(extra || {}) }); d.log.length = Math.min(d.log.length, 500); later(); },
    get logs() { return d.log; },
    addHistorico(h) { d.historico.unshift(h); d.historico.length = Math.min(d.historico.length, 5000); flush(); },
    get historico() { return d.historico; },
    tarefa(cardId) { return d.tarefas[cardId]; },
    setTarefa(cardId, id) { if (id) d.tarefas[cardId] = id; else delete d.tarefas[cardId]; later(); },
    snap(cardId) { return d.snaps[cardId]; },
    setSnap(cardId, v) { if (v) d.snaps[cardId] = v; else delete d.snaps[cardId]; later(); },
    trocas(cardId) { return d.trocas[cardId] || []; },
    addTroca(cardId, t) { (d.trocas[cardId] ||= []).push(t); later(); },
    get ativo() { return !!d.config.ativo; },
    admitir(ids) { let n = 0; for (const i of ids) { if (!admitidos.has(String(i))) { admitidos.add(String(i)); n++; } } d.admitidos = [...admitidos]; flush(); return n; },
    admitido: id => admitidos.has(String(id)),
    marcarRemovido(id) { removidos.add(String(id)); d.removidos = [...removidos]; flush(); },
    removidoDeProposito: id => removidos.has(String(id)),
    get totalAdmitidos() { return admitidos.size; },
    flush,
  };
}
module.exports = { createStore };
