'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Persistência em JSON (escrita atômica) + arquivos de currículo em DATA_DIR/cv. Nada de segredo aqui.
function createStore(dir) {
  fs.mkdirSync(path.join(dir, 'cv'), { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'state.json');
  let data = { admins: [], modulos: {}, candidatos: [], audit: [] };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) {
    if (e.code !== 'ENOENT') { try { fs.renameSync(file, `${file}.corrompido-${Date.now()}`); console.error('state.json ilegível: cópia guardada'); } catch { /* sem permissão */ } }
  }
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(tmp, file); };
  const cvPath = nome => path.join(dir, 'cv', path.basename(nome));
  return {
    get admins() { return data.admins; },
    setAdmins(a) { data.admins = a; save(); },
    get modulos() { return data.modulos; },
    setModulo(id, lista) { data.modulos[id] = lista; save(); },
    get candidatos() { return data.candidatos; },
    addCandidato(c) { data.candidatos.unshift(c); save(); return c; },
    touch() { save(); },
    removeCandidato(id) {
      const c = data.candidatos.find(x => x.id === id); if (!c) return false;
      data.candidatos = data.candidatos.filter(x => x.id !== id);
      if (c.cv?.arquivo) { try { fs.unlinkSync(cvPath(c.cv.arquivo)); } catch { /* já removido */ } }
      save(); return true;
    },
    saveCv(buf, ext) { const nome = `${crypto.randomBytes(12).toString('hex')}.${ext}`; fs.writeFileSync(cvPath(nome), buf, { mode: 0o600 }); return nome; },
    removeCv(nome) { try { fs.unlinkSync(cvPath(nome)); } catch { /* já removido */ } },
    readCv(nome) { return fs.readFileSync(cvPath(nome)); },
    audit(user, acao, detalhe) {
      data.audit.unshift({ em: new Date().toISOString(), por: user?.id || 'externo', nome: user?.nome || '', acao, detalhe: String(detalhe || '').slice(0, 300) });
      data.audit.length = Math.min(data.audit.length, 3000);
      save();
    },
    get auditoria() { return data.audit; },
  };
}
module.exports = { createStore };
