'use strict';
const smtp = require('./smtp');

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
      try { return await smtp.testConnection(conn(c)); } catch (e) { throw friendly(e); }
    },
    async save(input) {
      const c = normalize(input);
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
