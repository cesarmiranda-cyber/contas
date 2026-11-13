'use strict';
const fs = require('fs'); const path = require('path');
// Credenciais salvas pelo painel: arquivo 0600 no diretório de dados; nunca voltam inteiras ao navegador.
function createSecrets(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'secrets.json'); let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* sem segredos */ }
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(tmp, file); };
  return { get: k => data[k], set(p) { data = { ...data, ...p }; save(); }, clear(...ks) { for (const k of ks) delete data[k]; save(); } };
}
const hint = v => { const s = String(v || '').trim().replace(/\/+$/, ''); return s ? `••••${s.slice(-4)}` : ''; };
const hostOk = h => /(^|\.)bitrix24\.[a-z.]+$/i.test(h) || String(process.env.ALLOWED_BITRIX_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(h.toLowerCase());
function checkWebhook(w) {
  try {
    const u = new URL(String(w).trim());
    if (u.protocol !== 'https:') return 'A URL do webhook deve começar com https://';
    if (u.username || u.password || u.port) return 'URL do webhook inválida.';
    if (!hostOk(u.hostname)) return 'O webhook deve ser de um portal Bitrix24 (ex.: seu-portal.bitrix24.com.br).';
    if (!/\/rest\/\d+\/[^/]+\/?$/.test(u.pathname)) return 'Formato esperado: https://seu-portal.bitrix24.com.br/rest/1/CODIGO/';
    return null;
  } catch { return 'URL inválida.'; }
}
const hostDe = w => { try { return new URL(w).host; } catch { return ''; } };
module.exports = { createSecrets, hint, checkWebhook, hostDe };
