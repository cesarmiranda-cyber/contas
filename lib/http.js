'use strict';
// Pequeno wrapper de fetch com timeout e retry em 429/5xx.
async function request(url, { method = 'GET', headers = {}, body, timeout = 30000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctl.signal });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
      if ((res.status === 429 || res.status >= 500) && i < retries) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      return { status: res.status, ok: res.ok, json, text };
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}
module.exports = { request };
