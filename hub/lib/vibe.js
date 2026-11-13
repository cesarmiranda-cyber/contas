'use strict';
// Cliente da API Vibe (entity API do Bitrix24). Em produção cada requisição usa a chave do app
// (VIBE_APP_KEY) + o token da sessão do usuário que o gateway injeta em X-Vibe-Authorization.
// Em automações/desenvolvimento, VIBE_API_KEY (chave pessoal) dispensa a sessão.

class VibeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createVibe({ baseUrl = 'https://vibecode.bitrix24.com', appKey, apiKey, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  return function forSession(sessionAuth) {
    async function request(method, path, { query, body } = {}) {
      const key = apiKey || appKey;
      if (!key) throw new VibeError(500, 'NO_KEY', 'Chave do app não configurada no servidor.');
      if (!apiKey && !sessionAuth) throw new VibeError(401, 'NO_SESSION', 'Sessão não encontrada. Abra o app pelo Bitrix24.');
      const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '')).toString() : '';
      const headers = { 'X-Api-Key': key, Accept: 'application/json' };
      if (!apiKey) headers.Authorization = sessionAuth.replace(/^Bearer\s+/i, 'Bearer ');
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      let r;
      try {
        r = await fetchImpl(`${baseUrl}/v1${path}${qs}`, { method, headers, signal: ctl.signal, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        throw new VibeError(502, 'NETWORK', 'Não foi possível falar com o Bitrix24 agora.');
      } finally { clearTimeout(t); }
      let j = null;
      try { j = await r.json(); } catch { /* sem corpo */ }
      if (!r.ok || (j && j.success === false)) {
        const e = j?.error || {};
        const status = r.status === 401 || e.code === 'TOKEN_MISSING' ? 401 : (r.status >= 400 ? r.status : 502);
        throw new VibeError(status, e.code || 'VIBE_ERROR', e.message || `Erro ${r.status} na API do Bitrix24.`);
      }
      return j;
    }
    return {
      get: (path, query) => request('GET', path, { query }),
      post: (path, body) => request('POST', path, { body: body ?? {} }),
      patch: (path, body) => request('PATCH', path, { body }),
      put: (path, body) => request('PUT', path, { body }),
      del: (path) => request('DELETE', path),
    };
  };
}
module.exports = { createVibe, VibeError };
