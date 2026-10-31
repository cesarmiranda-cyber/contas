'use strict';
const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('./rules');

// Persistência em arquivo JSON (escrita atômica). O estado de negócio vive no Bitrix;
// aqui ficam só configuração, controle de lembretes enviados e log de auditoria.
const PENDING = new Set();
for (const sig of ['exit', 'SIGTERM', 'SIGINT']) process.on(sig, () => { for (const f of PENDING) { try { f(); } catch { /* fim */ } } if (sig !== 'exit') process.exit(0); });
function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'state.json');
  let data = { config: { ...DEFAULT_CONFIG }, sends: {}, log: [], lastSync: null, customers: {}, snaps: {}, wallets: [], links: [] };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) {
    // Arquivo ilegível: guarda uma cópia para recuperação em vez de sobrescrever com o padrão em silêncio.
    if (e.code !== 'ENOENT') { try { fs.renameSync(file, `${file}.corrompido-${Date.now()}`); console.error('state.json ilegível: cópia guardada como .corrompido-*'); } catch { /* sem permissão */ } }
  }
  data.config = { ...DEFAULT_CONFIG, ...data.config };

  // Gravação imediata para o que é raro e importante; em lote (a cada 1,5 s) para o que acontece por cobrança
  // (snapshots, log, clientes) — antes cada item reescrevia o arquivo inteiro e travava o servidor durante o sync.
  let timer = null;
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const save = () => flush();
  const later = () => { if (!timer) { timer = setTimeout(() => { timer = null; try { flush(); } catch (e) { console.error('state', e.message); } }, 1500); timer.unref?.(); } };
  PENDING.add(() => { if (timer) flush(); });
  return {
    get config() { return data.config; },
    setConfig(patch) { data.config = { ...data.config, ...patch }; save(); return data.config; },
    sent(dealId) { return (data.sends[dealId] || []).map(s => s.offset); },
    markSent(dealId, offset, channel) {
      (data.sends[dealId] ||= []).push({ offset, channel, at: new Date().toISOString() });
      save();
    },
    flush,
    log(type, msg, extra) {
      data.log.unshift({ at: new Date().toISOString(), type, msg, ...(extra || {}) });
      data.log.length = Math.min(data.log.length, 500);
      later();
    },
    get logs() { return data.log; },
    get ap() { return data.ap || null; },
    setAP(v) { data.ap = v; save(); },
    get wallets() { return data.wallets || []; },
    addWallet(w) { data.wallets = [...(data.wallets || []).filter(x => x.walletId !== w.walletId), w]; save(); return data.wallets; },
    removeWallet(walletId) { data.wallets = (data.wallets || []).filter(x => x.walletId !== walletId); save(); return data.wallets; },
    get links() { return data.links || []; },
    addLink(l) { data.links = [l, ...(data.links || [])].slice(0, 500); save(); },
    removeLink(id) { data.links = (data.links || []).filter(x => x.id !== id); save(); },
    get recs() { return data.recs || []; },
    addRec(r) { data.recs = [...(data.recs || []), r]; save(); return r; },
    setRec(id, patch) { data.recs = (data.recs || []).map(x => (x.id === id ? { ...x, ...patch } : x)); save(); },
    removeRec(id) { data.recs = (data.recs || []).filter(x => x.id !== id); save(); },
    snap(id) { return data.snaps[id]; },
    setSnap(id, v) { if (JSON.stringify(data.snaps[id]) === JSON.stringify(v)) return; data.snaps[id] = v; later(); },
    customerMap() { return data.customers; },
    setCustomer(k, v) { if (JSON.stringify(data.customers[k]) === JSON.stringify(v)) return; data.customers[k] = v; later(); },
    get lastQuick() { return data.lastQuick || null; },
    setLastQuick(v) { data.lastQuick = v; later(); },
    get lastSync() { return data.lastSync; },
    setLastSync(v) { data.lastSync = v; later(); },
  };
}
module.exports = { createStore };
