'use strict';
const crypto = require('crypto');
const hash = (senha, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(senha, salt, 64).toString('hex')}`;
const confere = (senha, h) => {
  const [salt, k] = String(h || '').split(':'); if (!salt || !k) return false;
  const a = Buffer.from(k, 'hex'), b = crypto.scryptSync(senha, salt, 64); return a.length === b.length && crypto.timingSafeEqual(a, b);
};
// Token de sessão sem estado: id.expiração.HMAC
const TTL = 7 * 86400e3;
const sign = (secret, p) => crypto.createHmac('sha256', secret).update(p).digest('hex');
const emitir = (secret, uid) => { const p = `${uid}.${Date.now() + TTL}`; return `${p}.${sign(secret, p)}`; };
const ler = (secret, tok) => {
  const m = /^([0-9a-f]+)\.(\d+)\.([0-9a-f]{64})$/.exec(String(tok || '')); if (!m) return null;
  const a = Buffer.from(m[3]), b = Buffer.from(sign(secret, `${m[1]}.${m[2]}`));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || +m[2] < Date.now()) return null; return m[1];
};
const cookies = h => Object.fromEntries(String(h || '').split(';').map(s => s.trim().split(/=(.*)/s).slice(0, 2)).filter(x => x[0]));
module.exports = { hash, confere, emitir, ler, cookies, TTL };
