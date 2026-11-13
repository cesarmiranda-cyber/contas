'use strict';
const crypto = require('crypto');
const hash = (senha, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(senha, salt, 64).toString('hex')}`;
const confere = (senha, h) => {
  const [salt, k] = String(h || '').split(':'); if (!salt || !k) return false;
  const a = Buffer.from(k, 'hex'), b = crypto.scryptSync(senha, salt, 64); return a.length === b.length && crypto.timingSafeEqual(a, b);
};
// Token de sessão sem estado: id.expiração.HMAC
const TTL = 40 * 60e3; // a sessão do cliente dura 40 minutos desde o login (não renova sozinha)
const sign = (secret, p) => crypto.createHmac('sha256', secret).update(p).digest('hex');
const emitir = (secret, uid) => { const p = `${uid}.${Date.now() + TTL}`; return `${p}.${sign(secret, p)}`; };
// Devolve { uid, emitidoEm, expiraEm } ou null (assinatura inválida ou sessão vencida).
const ler = (secret, tok) => {
  const m = /^([0-9a-f]+)\.(\d+)\.([0-9a-f]{64})$/.exec(String(tok || '')); if (!m) return null;
  const a = Buffer.from(m[3]), b = Buffer.from(sign(secret, `${m[1]}.${m[2]}`));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || +m[2] < Date.now()) return null; return { uid: m[1], emitidoEm: +m[2] - TTL, expiraEm: +m[2] };
};
const cookies = h => Object.fromEntries(String(h || '').split(';').map(s => s.trim().split(/=(.*)/s).slice(0, 2)).filter(x => x[0]));
// Política de senha: 8+ caracteres, com letra, número e um caractere especial.
const REGRAS_SENHA = [['8 ou mais caracteres', s => s.length >= 8], ['uma letra', s => /[A-Za-zÀ-ÿ]/.test(s)], ['um número', s => /\d/.test(s)], ['um caractere especial (ex.: ! @ # $ %)', s => /[^A-Za-zÀ-ÿ\d\s]/.test(s)]];
const validarSenha = senha => { const s = String(senha || ''); if (s.length > 200) return 'Senha longa demais.'; const falta = REGRAS_SENHA.filter(([, ok]) => !ok(s)).map(([t]) => t); return falta.length ? 'A senha precisa ter ' + falta.join(', ') + '.' : null; };
module.exports = { validarSenha, hash, confere, emitir, ler, cookies, TTL };
