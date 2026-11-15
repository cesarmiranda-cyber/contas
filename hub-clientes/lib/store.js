'use strict';
const fs = require('fs');
const path = require('path');

// Registros mensais guardados em JSON no disco persistente do servidor (gravação atômica).
function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'registros.json');
  let regs = [];
  try { regs = JSON.parse(fs.readFileSync(file, 'utf8')).registros || []; } catch { /* primeira execução */ }
  const flush = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ registros: regs }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const idx = (dealId, mes) => regs.findIndex(r => r.dealId === dealId && r.mes === mes);
  // Dados do módulo Apps: app informado à mão por licença e app inferido do histórico (cache).
  const appsFile = path.join(dir, 'apps.json');
  let apps = { over: {}, inf: {} };
  try { apps = { over: {}, inf: {}, ...JSON.parse(fs.readFileSync(appsFile, 'utf8')) }; } catch { /* primeira execução */ }
  const flushApps = () => { const tmp = appsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(apps), { mode: 0o600 }); fs.renameSync(tmp, appsFile); };
  return {
    apps: { over: () => ({ ...apps.over }), inf: () => ({ ...apps.inf }),
      setOver(id, app) { if (app) apps.over[id] = app; else delete apps.over[id]; flushApps(); },
      setInf(id, app) { apps.inf[id] = app; flushApps(); } },
    all: () => regs.slice(),
    get: (dealId, mes) => regs[idx(dealId, mes)] || null,
    upsert(reg) {
      const i = idx(reg.dealId, reg.mes);
      if (i >= 0) regs[i] = { ...reg, criadoEm: regs[i].criadoEm, criadoPor: regs[i].criadoPor };
      else regs.push(reg);
      flush(); return reg;
    },
    remove(dealId, mes) {
      const i = idx(dealId, mes); if (i < 0) return false;
      regs.splice(i, 1); flush(); return true;
    },
  };
}
module.exports = { createStore };
