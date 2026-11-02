'use strict';
const crypto = require('crypto');
const { request } = require('./http');

// Login com as credenciais do Bitrix24.
//  1) Dentro do Bitrix24: o portal abre o app enviando AUTH_ID/DOMAIN; confirmamos o token no próprio portal (user.current).
//  2) Fora do Bitrix24: OAuth (tela de login do próprio Bitrix24) com o client_id/secret do aplicativo local.
// Em ambos os casos só entra quem o administrador liberou em "Usuários e acessos" (nunca por ser do portal).
function createBitrixLogin({ bitrix, secrets, auth, log = () => {} }) {
  const estados = new Map();   // state -> { exp, redirect }
  const erro = (s, m) => Object.assign(new Error(m), { status: s });
  const host = () => { try { return bitrix.enabled ? new URL(bitrix.base).host.toLowerCase() : ''; } catch { return ''; } };
  const cfg = () => secrets.get('bitrixOauth') || {};
  const oauthPronto = () => !!(host() && cfg().clientId && cfg().clientSecret);

  async function usuarioAtual(dominio, token) {
    const h = host(); if (!h) throw erro(503, 'O Bitrix24 ainda não está conectado ao app. Fale com o administrador.');
    if (String(dominio || '').toLowerCase() !== h) throw erro(403, 'Este portal Bitrix24 não é o autorizado para este app.');
    if (!/^[\w.-]{10,200}$/.test(String(token || ''))) throw erro(401, 'Token do Bitrix24 inválido.');
    const r = await request(`https://${h}/rest/user.current.json?auth=${encodeURIComponent(token)}`, { retries: 0, timeout: 15000 });
    const x = r.json && r.json.result;
    if (!r.ok || !x || !x.ID) throw erro(401, 'O Bitrix24 não confirmou o seu login. Entre no portal e tente de novo.');
    return { id: String(x.ID), nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') || 'Usuário Bitrix24', email: x.EMAIL || '' };
  }
  const entrar = async bx => { try { return await auth.entrarBitrix(bx); } catch (e) { log('acesso', `Bitrix: acesso negado ao usuário ${bx.id}`); throw e; } };

  return {
    oauthPronto, host,
    // POST do Bitrix ao abrir o app (AUTH_ID + DOMAIN)
    async porPlacement({ AUTH_ID, DOMAIN }) { return entrar(await usuarioAtual(DOMAIN, AUTH_ID)); },
    inicio(redirectUri) {
      if (!oauthPronto()) throw erro(400, 'Login pelo Bitrix24 ainda não foi configurado pelo administrador.');
      const now = Date.now(); for (const [k, v] of estados) if (v.exp < now) estados.delete(k);
      if (estados.size > 500) throw erro(429, 'Muitas tentativas. Tente de novo em instantes.');
      const state = crypto.randomBytes(24).toString('base64url'); estados.set(state, { exp: now + 10 * 60000, redirectUri });
      return `https://${host()}/oauth/authorize/?${new URLSearchParams({ client_id: cfg().clientId, response_type: 'code', redirect_uri: redirectUri, state })}`;
    },
    async retorno({ code, state }) {
      const e = estados.get(String(state || '')); estados.delete(String(state || ''));
      if (!e || e.exp < Date.now()) throw erro(400, 'Pedido de login expirou. Comece de novo.');
      if (!/^[\w.-]{5,200}$/.test(String(code || ''))) throw erro(400, 'Código de login inválido.');
      const r = await request(`https://oauth.bitrix.info/oauth/token/?${new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg().clientId, client_secret: cfg().clientSecret, code })}`, { retries: 0, timeout: 15000 });
      const t = r.json || {}; if (!t.access_token) throw erro(401, 'O Bitrix24 recusou o login.');
      let dom = host(); try { if (t.client_endpoint) dom = new URL(t.client_endpoint).host.toLowerCase(); } catch { /* usa o do portal */ }
      return entrar(await usuarioAtual(dom, t.access_token));
    },
    config: () => ({ clientId: cfg().clientId || '', segredoDefinido: !!cfg().clientSecret, pronto: oauthPronto(), portal: host() }),
    salvaConfig({ clientId, clientSecret }) {
      const c = { ...cfg() };
      if (clientId !== undefined) { const v = String(clientId).trim(); if (v && !/^[\w.-]{5,120}$/.test(v)) throw erro(400, 'Client ID inválido.'); c.clientId = v; }
      if (clientSecret) { const v = String(clientSecret).trim(); if (!/^[\w.-]{10,200}$/.test(v)) throw erro(400, 'Client Secret inválido.'); c.clientSecret = v; }
      secrets.set({ bitrixOauth: c }); log('acesso', 'Login pelo Bitrix24 (OAuth) configurado'); return this.config();
    },
    async usuariosBitrix() {
      if (!bitrix.enabled) throw erro(503, 'Conecte o webhook do Bitrix24 em Integrações primeiro.');
      const out = []; let start = 0;
      for (let i = 0; i < 20; i++) {
        const r = await bitrix.call('user.get', { FILTER: { ACTIVE: true, USER_TYPE: 'employee' }, start });
        for (const x of r.result || []) out.push({ id: String(x.ID), nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') || `Usuário ${x.ID}`, email: x.EMAIL || '' });
        if (r.next === undefined) break; start = r.next;
      }
      return out;
    },
  };
}
module.exports = { createBitrixLogin };
