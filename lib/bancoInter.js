'use strict';
const https = require('https');
const crypto = require('crypto');

// Banco Inter (API PJ): OAuth2 client_credentials + certificado do cliente (mTLS). Endereços e escopos seguem a documentação
// pública do Inter; qualquer divergência aparece no "Testar conexão" com a resposta crua do banco.
const BASE = 'https://cdpj.partners.bancointer.com.br';
const ESCOPOS = 'extrato.read';
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const LIM_PERIODO = 90 * 864e5;

// Adaptador HTTP com certificado de cliente. Trocável nos testes.
function requisicaoTls({ cert, key, ca }) {
  const agent = new https.Agent({ cert, key, ...(ca ? { ca } : {}), keepAlive: false });
  return (method, url, { headers = {}, body } = {}) => new Promise((ok, no) => {
    const u = new URL(url), req = https.request({ method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, agent, timeout: 30000 }, res => {
      let b = ''; res.on('data', c => { b += c; if (b.length > 8e6) { req.destroy(); no(bad('Resposta grande demais do Inter.')); } });
      res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch { /* não-JSON */ } ok({ status: res.statusCode, json: j, text: b }); });
    });
    req.on('timeout', () => req.destroy(new Error('O Inter demorou demais para responder.'))); req.on('error', no); if (body) req.write(body); req.end();
  });
}

// Valida e descreve o par certificado/chave colados no painel.
function inspecionaCertificado(certPem, keyPem) {
  const c = String(certPem || '').trim(), k = String(keyPem || '').trim();
  if (!/-----BEGIN CERTIFICATE-----/.test(c)) throw bad('O certificado precisa ser o conteúdo do arquivo .crt (começa com -----BEGIN CERTIFICATE-----).');
  if (!/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(k)) throw bad('A chave precisa ser o conteúdo do arquivo .key (começa com -----BEGIN PRIVATE KEY-----). Chaves protegidas por senha não são aceitas.');
  let x509, priv; try { x509 = new crypto.X509Certificate(c); priv = crypto.createPrivateKey(k); } catch (e) { throw bad(`Certificado ou chave ilegível: ${e.message}`); }
  if (!x509.checkPrivateKey(priv)) throw bad('A chave não corresponde ao certificado. Use os dois arquivos da mesma integração.');
  const fim = new Date(x509.validTo), dias = Math.floor((fim.getTime() - Date.now()) / 864e5);
  return { validade: fim.toISOString().slice(0, 10), diasParaVencer: dias, vencido: dias < 0, titular: x509.subject.replace(/\n/g, ', ').slice(0, 160) };
}

const traduz = e => (e && /^(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN)$/.test(e.code || '') ? bad(`Não consegui conectar ao servidor do Inter (${e.code}). Verifique se o servidor do app tem acesso à internet para cdpj.partners.bancointer.com.br.`, 502) : /certificate|handshake|ssl|alert/i.test(String(e && e.message)) ? bad(`Falha no certificado de cliente com o Inter: ${e.message}. Confira se o .crt e o .key são os da integração e se estão dentro da validade.`, 502) : e);
function createBancoInter({ secrets, agora = () => Date.now(), http }) {
  let tok = null;
  const cfg = () => secrets.get('inter') || {};
  const pronto = () => { const c = cfg(); return !!(c.clientId && c.clientSecret && c.cert && c.key); };
  const adapter = () => http || requisicaoTls({ cert: cfg().cert, key: cfg().key, ca: cfg().ca });
  async function token() {
    if (tok && tok.exp > agora() + 30000) return tok.v;
    need(pronto(), 'O Banco Inter ainda não foi configurado.', 409);
    const c = cfg(), body = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials', scope: c.escopos || ESCOPOS }).toString();
    const r = await adapter()('POST', `${c.base || BASE}/oauth/v2/token`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body }).catch(e => { throw traduz(e); });
    if (!r.json || !r.json.access_token) throw bad(`O Inter recusou a autenticação (${r.status}): ${String((r.json && (r.json.error_description || r.json.error || r.json.title || r.json.message)) || r.text).slice(0, 200)}`, 502);
    tok = { v: r.json.access_token, exp: agora() + (Number(r.json.expires_in) || 3600) * 1000 }; return tok.v;
  }
  function need(c, m, s) { if (!c) throw bad(m, s); }
  async function get(caminho, params = {}) {
    const c = cfg(), t = await token(), q = new URLSearchParams(params).toString();
    const r = await adapter()('GET', `${c.base || BASE}${caminho}${q ? '?' + q : ''}`, { headers: { Authorization: `Bearer ${t}`, ...(c.contaCorrente ? { 'x-conta-corrente': c.contaCorrente } : {}) } }).catch(e => { throw traduz(e); });
    if (r.status === 401) tok = null;
    if (r.status >= 400 || !r.json) throw bad(`Inter ${caminho} respondeu ${r.status}: ${String((r.json && (r.json.detail || r.json.title || r.json.message)) || r.text).slice(0, 200)}`, 502);
    return r.json;
  }
  return {
    pronto, inspecionaCertificado,
    saldo: async data => { const j = await get('/banking/v2/saldo', data ? { dataSaldo: data } : {}); return { disponivel: Number(j.disponivel), bloqueado: Number(j.bloqueadoCheque || 0) + Number(j.bloqueadoJudicialmente || 0) + Number(j.bloqueadoAdministrativo || 0), limite: Number(j.limite || 0) }; },
    // Extrato do período (em janelas de até 90 dias) já no formato do importador de extratos.
    async extrato(de, ate) {
      need(/^\d{4}-\d{2}-\d{2}$/.test(de) && /^\d{4}-\d{2}-\d{2}$/.test(ate) && de <= ate, 'Período inválido.');
      const linhas = []; let ini = Date.parse(de + 'T00:00:00Z'); const fim = Date.parse(ate + 'T00:00:00Z');
      while (ini <= fim) { const f = Math.min(ini + LIM_PERIODO - 864e5, fim), j = await get('/banking/v2/extrato', { dataInicio: new Date(ini).toISOString().slice(0, 10), dataFim: new Date(f).toISOString().slice(0, 10) }); linhas.push(...parseExtratoInter(j).linhas); ini = f + 864e5; }
      let saldoFinal = null, saldoEm = ''; try { const s = await this.saldo(ate); saldoFinal = s.disponivel; saldoEm = ate; } catch { /* saldo é opcional */ }
      return { banco: '077', conta: cfg().contaCorrente || '', inicio: de, fim: ate, saldoFinal, saldoEm, linhas };
    },
    async testar() { const s = await this.saldo(); return { ok: true, saldoDisponivel: s.disponivel }; },
  };
}

// Resposta do extrato → linhas (+ entrada, − saída). Aceita valor como número ou texto com ponto decimal.
function parseExtratoInter(j) {
  const l = (j && (j.transacoes || j.transacao || [])) || [];
  return { linhas: l.map(t => { const v = Math.round(Number(String(t.valor).replace(',', '.')) * 100) / 100; if (!Number.isFinite(v)) throw bad('Lançamento do Inter com valor inválido.'); const d = String(t.dataEntrada || t.dataTransacao || t.dataInclusao || '').slice(0, 10);
    return { fitid: String(t.idTransacao || `${d}|${v}|${t.titulo || ''}`), data: d, valor: String(t.tipoOperacao || '').toUpperCase().startsWith('D') ? -Math.abs(v) : Math.abs(v), tipo: t.tipoTransacao || '', descricao: [t.titulo, t.descricao].filter(Boolean).join(' — ').replace(/\s+/g, ' ').slice(0, 200) || 'Lançamento Inter', doc: '' }; }).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.data)) };
}
module.exports = { createBancoInter, inspecionaCertificado, parseExtratoInter, BASE };
