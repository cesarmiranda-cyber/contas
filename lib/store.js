'use strict';
const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('./rules');

// Persistência em arquivo JSON (escrita atômica). O estado de negócio vive no Bitrix;
// aqui ficam só configuração, controle de lembretes enviados e log de auditoria.
function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  let data = { config: { ...DEFAULT_CONFIG }, sends: {}, log: [], lastSync: null, customers: {} };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* primeiro uso */ }
  data.config = { ...DEFAULT_CONFIG, ...data.config };

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  return {
    get config() { return data.config; },
    setConfig(patch) { data.config = { ...data.config, ...patch }; save(); return data.config; },
    sent(dealId) { return (data.sends[dealId] || []).map(s => s.offset); },
    markSent(dealId, offset, channel) {
      (data.sends[dealId] ||= []).push({ offset, channel, at: new Date().toISOString() });
      save();
    },
    log(type, msg, extra) {
      data.log.unshift({ at: new Date().toISOString(), type, msg, ...(extra || {}) });
      data.log.length = Math.min(data.log.length, 500);
      save();
    },
    get logs() { return data.log; },
    customerMap() { return data.customers; },
    setCustomer(k, v) { data.customers[k] = v; save(); },
    get lastSync() { return data.lastSync; },
    setLastSync(v) { data.lastSync = v; save(); },
  };
}
module.exports = { createStore };
