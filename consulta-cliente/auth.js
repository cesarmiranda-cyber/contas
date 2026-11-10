'use strict';
// Login pelo próprio Bitrix24: ao abrir o app o Bitrix faz POST com AUTH_ID e DOMAIN. O servidor confirma o token
// no portal (profile) e entrega à página um token assinado de curta duração, enviado depois em cada consulta.
const crypto = require('crypto');
const b64 = b => Buffer.from(b).toString('base64url');

function createAuth({ portal, secret, ttlMs = 12 * 3600e3, fetchImpl = fetch, now = Date.now }) {
  if (!secret) throw new Error('SESSION_SECRET não configurado');
  const sign = p => crypto.createHmac('sha256', secret).update(p).digest('base64url');
  const emitir = id => { const p = b64(JSON.stringify({ id: String(id), exp: now() + ttlMs })); return `${p}.${sign(p)}`; };
  function verificar(tok) {
    const [p, s] = String(tok || '').split('.');
    if (!p || !s) return null;
    const esperado = Buffer.from(sign(p)), dado = Buffer.from(s);
    if (esperado.length !== dado.length || !crypto.timingSafeEqual(esperado, dado)) return null;
    try { const v = JSON.parse(Buffer.from(p, 'base64url')); return v.exp > now() && /^\d+$/.test(v.id) ? v : null; } catch { return null; }
  }
  // Troca o AUTH_ID do Bitrix por um token nosso. A validação real é o `profile` no portal configurado (nunca em outro host);
  // se o Bitrix informar um DOMAIN diferente, recusa. Algumas versões do Bitrix mandam o DOMAIN só na URL, ou não mandam.
  async function entrar({ authId, domain }) {
    if (!authId || (domain && String(domain).toLowerCase() !== portal.toLowerCase())) return null;
    const r = await fetchImpl(`https://${portal}/rest/profile.json?auth=${encodeURIComponent(authId)}`).catch(() => null);
    const j = r && await r.json().catch(() => null);
    return j?.result?.ID ? emitir(j.result.ID) : null;
  }
  // Acesso por senha única (quando o app é aberto por link, fora do Bitrix). Limita tentativas por IP.
  const falhas = new Map();
  function entrarSenha(senha, esperada, ip) {
    const f = falhas.get(ip) || { n: 0, ate: 0 };
    if (f.n >= 5 && now() < f.ate) return 'bloqueado';
    const a = crypto.createHash('sha256').update(String(senha || '')).digest(), b = crypto.createHash('sha256').update(String(esperada || '')).digest();
    if (!esperada || !crypto.timingSafeEqual(a, b)) { falhas.set(ip, { n: f.n + 1, ate: now() + 15 * 60e3 }); return null; }
    falhas.delete(ip); return emitir('0');
  }
  return { emitir, verificar, entrar, entrarSenha };
}
module.exports = { createAuth };
