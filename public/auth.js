/* Sessão do navegador: o token fica no próprio navegador e vai em cada pedido (Authorization). Nenhum dado do app é carregado sem login. */
const NM = {
  get token() { try { return localStorage.getItem('nm.token') || ''; } catch { return ''; } },
  set token(t) { try { t ? localStorage.setItem('nm.token', t) : localStorage.removeItem('nm.token'); } catch { /* sem armazenamento */ } },
  // volta para a tela de login, lembrando para onde ir depois
  paraLogin() { NM.token = ''; const v = location.pathname + location.search + location.hash; location.href = '/' + (v !== '/' ? '?voltar=' + encodeURIComponent(v) : ''); },
};
async function nmFetch(url, o = {}) {
  const h = { ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(NM.token ? { Authorization: 'Bearer ' + NM.token } : {}) };
  const r = await fetch(url, { method: o.method || 'GET', headers: h, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const novo = r.headers.get('X-Auth-Token'); if (novo) NM.token = novo;   // renovação automática da sessão
  return r;
}
async function nmJson(m, u, b, { semRedirect } = {}) {
  const r = await nmFetch(u, { method: m, body: b }), j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.auth && !semRedirect) { NM.paraLogin(); throw new Error('Sessão expirada. Faça login novamente.'); }
  if (r.status === 403 && j.trocarSenha && !semRedirect) { location.href = '/'; throw new Error('Defina uma nova senha.'); }
  if (!r.ok) throw new Error(j.error || ('Erro ' + r.status));
  return j;
}
// download de arquivo protegido (anexos, CSV): busca com o token e entrega ao navegador
async function nmBaixar(url, nome) {
  const r = await nmFetch(url);
  if (r.status === 401) { NM.paraLogin(); return; }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Não foi possível baixar o arquivo.'); }
  const cd = r.headers.get('Content-Disposition') || '', m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = m ? decodeURIComponent(m[1]) : (nome || 'arquivo'); document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
