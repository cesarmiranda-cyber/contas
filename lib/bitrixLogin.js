'use strict';
const crypto = require('crypto');
const { request } = require('./http');

// Login com as credenciais do Bitrix24.
//  1) Dentro do Bitrix24: o portal abre o app enviando AUTH_ID/DOMAIN; confirmamos o token no próprio portal (user.current).
//  2) Fora do Bitrix24: OAuth (tela de login do próprio Bitrix24) com o client_id/secret do aplicativo local.
// Em ambos os casos só entra quem o administrador liberou em "Usuários e acessos" (nunca por ser do portal).
function createBitrixLogin({ bitrix, secrets, auth, log = () => {}, agora = () => Date.now() }) {
  const estados = new Map(), pend = new Map(), taxa = new Map();   // pend: e-mail → código pendente; taxa: limites de pedidos   // state -> { exp, redirect }
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

  // Limite simples por chave (IP ou e-mail): `max` ocorrências por janela.
  const estoura = (chave, max, janela) => { const t = agora(), l = (taxa.get(chave) || []).filter(x => t - x < janela); l.push(t); taxa.set(chave, l); if (taxa.size > 5000) for (const [k, v] of taxa) if (!v.length || t - v[v.length - 1] > janela) taxa.delete(k); return l.length > max; };
  const sha = (c, sal) => crypto.createHash('sha256').update(sal + c).digest('hex');
  const MIN = 60000, GENERICO = 'Se este e-mail pertence a um usuário do Bitrix24 liberado, enviamos um código para as notificações dele no Bitrix24 (ícone de sino). Ele vale por 10 minutos.';
  return {
    // Entrada pela conta do Bitrix24 sem aplicativo OAuth: o código chega nas notificações da pessoa dentro do próprio Bitrix24.
    async pedirCodigo(email, ip) {
      const em = String(email || '').trim().toLowerCase(); if (!/^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,}$/.test(em)) throw erro(400, 'Informe o e-mail da sua conta do Bitrix24.');
      if (!bitrix.enabled) throw erro(503, 'O Bitrix24 ainda não está conectado ao sistema. Fale com o administrador.');
      if (estoura('ip|' + ip, 10, 15 * MIN)) throw erro(429, 'Muitas tentativas. Aguarde alguns minutos.');
      if (estoura('em|' + em, 4, 15 * MIN)) return { ok: true, mensagem: GENERICO };   // não revela o excesso nem a existência
      try {
        const us = ((await bitrix.call('user.get', { FILTER: { EMAIL: em, ACTIVE: true } })).result || []).filter(u => String(u.EMAIL || '').toLowerCase() === em), u = us.length === 1 ? us[0] : null;
        if (u && auth.acharPorBitrix(String(u.ID))) {
          const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0'), sal = crypto.randomBytes(8).toString('hex');
          pend.set(em, { id: String(u.ID), nome: [u.NAME, u.LAST_NAME].filter(Boolean).join(' '), email: em, sal, h: sha(codigo, sal), exp: agora() + 10 * MIN, tent: 0 });
          await bitrix.call('im.notify.personal.add', { USER_ID: String(u.ID), MESSAGE: `Seu código de acesso ao Nutrimix: ${codigo}. Vale por 10 minutos. Se não foi você, ignore esta mensagem.`, TAG: `nutrimix-login-${u.ID}` });
          log('acesso', `Código de acesso enviado a ${em}`);
        } else log('acesso', `Pedido de código para e-mail sem acesso liberado (${em.slice(0, 3)}…)`);
      } catch (e) { log('erro', `Código de acesso: ${e.message}`); throw erro(502, 'Não consegui falar com o Bitrix24 agora. Tente de novo em instantes.'); }
      return { ok: true, mensagem: GENERICO };
    },
    async confirmarCodigo(email, codigo, ip) {
      const em = String(email || '').trim().toLowerCase(), c = String(codigo || '').replace(/\D/g, ''), p = pend.get(em), ruim = erro(401, 'Código inválido ou expirado. Peça um novo código.');
      if (estoura('cf|' + ip, 20, 15 * MIN)) throw erro(429, 'Muitas tentativas. Aguarde alguns minutos.');
      if (!p || p.exp < agora() || c.length !== 6) { if (p && p.exp < agora()) pend.delete(em); throw ruim; }
      const a = Buffer.from(sha(c, p.sal)), b = Buffer.from(p.h);
      if (!crypto.timingSafeEqual(a, b)) { p.tent++; if (p.tent >= 5) { pend.delete(em); log('acesso', `Código de ${em} invalidado por tentativas erradas`); } throw ruim; }
      pend.delete(em); return entrar({ id: p.id, nome: p.nome, email: p.email });
    },
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
