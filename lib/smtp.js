'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

// Cliente SMTP mínimo (sem dependências): SSL direto (465), STARTTLS (587) ou sem criptografia só em localhost (testes).
// Monta mensagem MIME com texto + HTML (+ anexos) em UTF-8, com proteção contra injeção de cabeçalhos.
const CRLF = '\r\n';
const ADDR = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]+$/;
const isEmail = v => ADDR.test(String(v || '').trim());
const oneLine = s => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const hdrWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const b64 = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')).toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

function addrList(list) {
  const out = (Array.isArray(list) ? list : String(list || '').split(/[;,]/)).map(s => String(s).trim()).filter(Boolean);
  for (const a of out) if (!isEmail(a)) throw new Error(`E-mail inválido: "${oneLine(a).slice(0, 80)}"`);
  return [...new Set(out)];
}

function buildMessage({ from, fromName, to, cc = [], subject, text, html, attachments = [], domain = 'contas.local' }) {
  const id = `<${crypto.randomBytes(12).toString('hex')}@${domain}>`;
  const nome = oneLine(fromName);
  const head = [
    `From: ${nome ? `${/^[\x20-\x7e]*$/.test(nome) ? `"${nome.replace(/"/g, '')}"` : hdrWord(nome)} ` : ''}<${from}>`,
    `To: ${to.join(', ')}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${hdrWord(oneLine(subject))}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${id}`, 'MIME-Version: 1.0',
  ];
  const b1 = '=_mix_' + crypto.randomBytes(8).toString('hex'), b2 = '=_alt_' + crypto.randomBytes(8).toString('hex');
  const part = (type, body) => `Content-Type: ${type}; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${b64(body)}`;
  const alt = `--${b2}${CRLF}${part('text/plain', text || '')}${CRLF}--${b2}${CRLF}${part('text/html', html || '')}${CRLF}--${b2}--`;
  let body;
  if (attachments.length) {
    const atts = attachments.map(a => {
      const fn = hdrWord(oneLine(a.filename).replace(/"/g, ''));
      return `--${b1}${CRLF}Content-Type: ${a.type || 'application/octet-stream'}; name="${fn}"${CRLF}Content-Transfer-Encoding: base64${CRLF}Content-Disposition: attachment; filename="${fn}"${CRLF}${CRLF}${b64(a.content)}`;
    }).join(CRLF);
    head.push(`Content-Type: multipart/mixed; boundary="${b1}"`);
    body = `--${b1}${CRLF}Content-Type: multipart/alternative; boundary="${b2}"${CRLF}${CRLF}${alt}${CRLF}${atts}${CRLF}--${b1}--`;
  } else {
    head.push(`Content-Type: multipart/alternative; boundary="${b2}"`);
    body = alt;
  }
  return { raw: head.join(CRLF) + CRLF + CRLF + body + CRLF, id };
}

// Leitor de respostas SMTP (linhas "250-..." continuam; "250 ..." encerra).
function wrap(sock) {
  let buf = '', waiting = null; const q = [];
  const pump = () => {
    for (;;) {
      const m = buf.match(/^(?:\d{3}-.*\r?\n)*\d{3} .*\r?\n/);
      if (!m) return;
      buf = buf.slice(m[0].length);
      const lines = m[0].trim().split(/\r?\n/);
      const r = { code: +lines[0].slice(0, 3), lines: lines.map(l => l.slice(4)) };
      if (waiting) { const w = waiting; waiting = null; w.res(r); } else q.push(r);
    }
  };
  sock.on('data', d => { buf += d.toString('utf8'); pump(); });
  const fail = e => { if (waiting) { const w = waiting; waiting = null; w.rej(e); } };
  sock.on('error', fail); sock.on('close', () => fail(new Error('Conexão encerrada pelo servidor de e-mail.')));
  return {
    sock,
    reply: () => (q.length ? Promise.resolve(q.shift()) : new Promise((res, rej) => { waiting = { res, rej }; })),
    send: l => sock.write(l + CRLF),
  };
}

// Abre a conexão, negocia criptografia e autentica. Devolve a sessão pronta para MAIL FROM.
async function session(cfg) {
  const host = String(cfg.host || '').trim(), port = Number(cfg.port) || (cfg.secure === 'ssl' ? 465 : 587), mode = cfg.secure || 'starttls';
  if (!host) throw new Error('Servidor SMTP não configurado.');
  if (mode === 'none' && !LOCAL.has(host)) throw new Error('Conexão sem criptografia só é permitida em localhost. Use SSL (465) ou STARTTLS (587).');
  const timeout = cfg.timeoutMs || 30000;
  const raw = await new Promise((res, rej) => {
    const s = mode === 'ssl' ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); rej(new Error(`Tempo esgotado ao conectar em ${host}:${port}.`)); }, timeout);
    s.once(mode === 'ssl' ? 'secureConnect' : 'connect', () => { clearTimeout(t); res(s); });
    s.once('error', e => { clearTimeout(t); rej(new Error(`Não consegui conectar em ${host}:${port}: ${e.code || e.message}`)); });
  });
  const st = { c: wrap(raw) };
  const watchdog = setTimeout(() => st.c.sock.destroy(), timeout * 2);
  const expect = async (codes, what) => {
    const r = await st.c.reply();
    if (!codes.includes(r.code)) throw new Error(`${what}: ${r.code} ${oneLine(r.lines.join(' ')).slice(0, 200)}`);
    return r;
  };
  const close = () => { clearTimeout(watchdog); st.c.sock.destroy(); };
  try {
    await expect([220], 'Servidor não aceitou a conexão');
    const ehlo = async () => { st.c.send('EHLO contas.local'); return (await expect([250], 'EHLO recusado')).lines.map(l => l.toUpperCase()); };
    let caps = await ehlo();
    if (mode === 'starttls') {
      if (!caps.some(l => l.startsWith('STARTTLS'))) throw new Error('O servidor não oferece STARTTLS (criptografia).');
      st.c.send('STARTTLS'); await expect([220], 'STARTTLS recusado');
      const secured = await new Promise((res, rej) => { const s = tls.connect({ socket: st.c.sock, servername: host }, () => res(s)); s.once('error', rej); });
      st.c = wrap(secured); caps = await ehlo();
    }
    if (cfg.user) {
      const auth = caps.find(l => l.startsWith('AUTH')) || '';
      const dica = 'Autenticação recusada (confira usuário e senha; no Gmail/Microsoft use senha de app)';
      if (/PLAIN/.test(auth) || !auth) { st.c.send('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`).toString('base64')); await expect([235], dica); }
      else {
        st.c.send('AUTH LOGIN'); await expect([334], 'AUTH LOGIN recusado');
        st.c.send(Buffer.from(cfg.user).toString('base64')); await expect([334], dica);
        st.c.send(Buffer.from(cfg.pass || '').toString('base64')); await expect([235], dica);
      }
    }
  } catch (e) { close(); throw e; }
  // QUIT educado: espera o 221 do servidor (até 2 s) antes de fechar a conexão.
  const quit = async () => { st.c.send('QUIT'); await Promise.race([st.c.reply().catch(() => null), new Promise(r => setTimeout(r, 2000))]); };
  return { host, port, send: l => st.c.send(l), write: d => st.c.sock.write(d), expect, close, quit };
}

async function sendMail(cfg, msg) {
  if (!isEmail(msg.from)) throw new Error('E-mail do remetente inválido.');
  const to = addrList(msg.to), cc = addrList(msg.cc);
  if (!to.length) throw new Error('Informe pelo menos um destinatário.');
  const { raw, id } = buildMessage({ ...msg, to, cc, domain: msg.from.split('@')[1] || 'contas.local' });
  const s = await session(cfg);
  try {
    s.send(`MAIL FROM:<${msg.from}>`); await s.expect([250], 'Remetente recusado');
    for (const a of [...to, ...cc]) { s.send(`RCPT TO:<${a}>`); await s.expect([250, 251], `Destinatário recusado (${a})`); }
    s.send('DATA'); await s.expect([354], 'DATA recusado');
    s.write(raw.replace(/\r\n\./g, '\r\n..') + '.' + CRLF);
    await s.expect([250], 'Mensagem recusada');
    await s.quit();
    return { ok: true, messageId: id, para: to, cc };
  } finally { s.close(); }
}

// Só abre a conexão e autentica (botão "Testar conexão"); não envia nada.
async function testConnection(cfg) {
  const s = await session(cfg);
  try { await s.quit(); return { ok: true, servidor: `${s.host}:${s.port}`, autenticado: !!cfg.user }; } finally { s.close(); }
}
module.exports = { sendMail, testConnection, buildMessage, isEmail, addrList };
