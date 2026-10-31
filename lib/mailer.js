'use strict';
const dns = require('dns').promises;
const net = require('net');
const smtp = require('./smtp');

// Evita que o painel vire um "scanner" da rede interna (SSRF): só portas de e-mail e só endereços públicos.
const LOCAL = new Set(['localhost', '127.0.0.1']);
const privado = ip => {
  if (net.isIPv6(ip)) return /^(::1?$|f[cd]|fe[89ab]|::ffff:(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.))/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
};
async function checkDestino(c) {
  if (LOCAL.has(c.host)) { if (process.env.ALLOW_LOCAL_SMTP === '1') return; throw Object.assign(new Error('Servidor SMTP local não é permitido.'), { status: 400 }); }   // localhost só nos testes automáticos
  if (![25, 465, 587, 2525].includes(c.port)) throw Object.assign(new Error('Use uma porta de e-mail: 587 (STARTTLS), 465 (SSL), 25 ou 2525.'), { status: 400 });
  const ips = net.isIP(c.host) ? [{ address: c.host }] : await dns.lookup(c.host, { all: true }).catch(() => { throw Object.assign(new Error('Não encontrei esse servidor SMTP (verifique o endereço).'), { status: 400 }); });
  if (ips.some(i => privado(i.address))) throw Object.assign(new Error('O servidor SMTP precisa ser público (endereços internos não são permitidos).'), { status: 400 });
}

// Configuração e envio de e-mail (SMTP). A senha fica em DATA_DIR/secrets.json (0600) e nunca volta ao navegador.
const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };

function createMailer({ secrets }) {
  const stored = () => secrets.get('smtp') || null;
  const ready = c => !!(c && c.host && c.from);
  const view = () => {
    const c = stored();
    return c ? { configured: ready(c), host: c.host, port: c.port, secure: c.secure, user: c.user || '', hasPass: !!c.pass, from: c.from, fromName: c.fromName || '' } : { configured: false };
  };

  function normalize(i = {}) {
    const old = stored();
    const secure = ['ssl', 'starttls', 'none'].includes(i.secure) ? i.secure : 'starttls';
    const host = String(i.host || '').trim().toLowerCase();
    if (!host) throw fail(400, 'Informe o servidor SMTP (ex.: smtp.gmail.com).');
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) throw fail(400, 'Servidor SMTP inválido.');
    const port = i.port === undefined || i.port === '' ? (secure === 'ssl' ? 465 : 587) : Number(i.port);
    if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) throw fail(400, 'Porta inválida.');
    if (secure === 'none' && !['localhost', '127.0.0.1'].includes(host)) throw fail(400, 'Sem criptografia só é permitido em localhost. Use SSL (465) ou STARTTLS (587).');
    const from = String(i.from || '').trim();
    if (!smtp.isEmail(from)) throw fail(400, 'Informe o e-mail do remetente (o endereço que aparece como "De").');
    const user = String(i.user || '').trim().slice(0, 200);
    let pass = i.pass === undefined || i.pass === '' ? '' : String(i.pass).slice(0, 300);
    if (!pass && old && old.host === host && (old.user || '') === user) pass = old.pass || '';   // campo vazio = mantém a senha salva
    if (user && !pass) throw fail(400, 'Informe a senha (no Gmail e no Microsoft 365 use uma "senha de app").');
    return { host, port, secure, user, pass, from, fromName: String(i.fromName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100) };
  }
  const conn = c => ({ host: c.host, port: c.port, secure: c.secure, user: c.user, pass: c.pass });
  const friendly = e => fail(e.status || 400, e.message);

  return {
    configured: () => ready(stored()),
    view,
    async test(input) {
      const c = input && input.host ? normalize(input) : stored();
      if (!c) throw fail(400, 'E-mail ainda não configurado.');
      await checkDestino(c);
      try { return await smtp.testConnection(conn(c)); } catch (e) { throw friendly(e); }
    },
    async save(input) {
      const c = normalize(input);
      await checkDestino(c);
      try { await smtp.testConnection(conn(c)); } catch (e) { throw friendly(e); }     // só salva configuração que funciona
      secrets.set({ smtp: c });
      return view();
    },
    clear() { secrets.clear('smtp'); },
    async send(msg) {
      const c = stored();
      if (!ready(c)) throw fail(400, 'E-mail ainda não configurado (Configurações → E-mail).');
      return smtp.sendMail(conn(c), { from: c.from, fromName: c.fromName, ...msg });
    },
  };
}
module.exports = { createMailer };
