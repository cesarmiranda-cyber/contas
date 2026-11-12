'use strict';
// Banco em arquivo JSON (sem dependências): em memória + gravação atômica com atraso curto.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const VAZIO = () => ({ clientes: [], projetos: [], tarefas: [], itens: [], arquivos: [], solicitacoes: [], logs: [] });

function createStore(dir) {
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'db.json');
  let db = VAZIO();
  try { db = { ...VAZIO(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* primeira execução */ }
  let timer = null;
  const flush = () => {
    clearTimeout(timer); timer = null;
    const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(tmp, file);
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 150); };
  const id = () => crypto.randomBytes(8).toString('hex');
  const agora = () => new Date().toISOString();
  let secret; const sf = path.join(dir, 'secret');
  try { secret = fs.readFileSync(sf, 'utf8').trim(); } catch { secret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(sf, secret, { mode: 0o600 }); }
  const log = (quem, tipo, acao, detalhe = '', projetoId = null) => {
    db.logs.push({ id: id(), ts: agora(), quem, tipo, acao, detalhe: String(detalhe).slice(0, 300), projetoId });
    if (db.logs.length > 5000) db.logs.splice(0, db.logs.length - 5000);
    save();
  };
  return { db, save, flush, id, agora, log, secret, dir, file: n => path.join(dir, 'files', n) };
}
module.exports = { createStore };
