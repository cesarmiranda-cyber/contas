'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sendMail, testConnection, isEmail, addrList } = require('../lib/smtp');

const { fakeServer, parse, flat } = require('../testkit/smtpServer');

const cfg = (port, extra = {}) => ({ host: '127.0.0.1', port, secure: 'none', user: 'usuario', pass: 'senha', timeoutMs: 5000, ...extra });

test('valida e-mails e bloqueia injeção de cabeçalho', () => {
  assert.ok(isEmail('a@b.com') && isEmail('nome.sobrenome+tag@empresa.com.br'));
  for (const x of ['', 'a@b', 'a b@c.com', 'a@b.com\r\nBcc: x@y.com', '<a@b.com>', 'a@b.com,c@d.com']) assert.ok(!isEmail(x), x);
  assert.deepEqual(addrList('a@b.com; c@d.com, a@b.com'), ['a@b.com', 'c@d.com']);
  assert.throws(() => addrList('ok@x.com, invalido'), /E-mail inválido/);
});

test('envia mensagem HTML + texto + anexo CSV em UTF-8 com assunto acentuado', async t => {
  const s = await fakeServer(); t.after(() => s.srv.close());
  const r = await sendMail(cfg(s.port), { from: 'financeiro@manda4.com.br', fromName: 'Manda4 Financeiro', to: ['parceiro@x.com'], cc: 'copia@x.com', subject: 'Demonstrativo — João & Cia',
    text: 'Olá, João!\nTotal: R$ 1.250,00 — ação ✓', html: '<p>Olá, <b>João</b>! Total: R$ 1.250,00 — ação ✓</p>', attachments: [{ filename: 'detalhe-março.csv', type: 'text/csv; charset=utf-8', content: '﻿col;valor\r\nAção;1.250,00\r\n' }] });
  assert.equal(r.ok, true); assert.deepEqual(r.para, ['parceiro@x.com']); assert.deepEqual(r.cc, ['copia@x.com']);
  assert.equal(s.msgs.length, 1);
  const m = parse(s.msgs[0]);
  assert.equal(m.headers.subject, 'Demonstrativo — João & Cia'); assert.equal(m.headers.to, 'parceiro@x.com'); assert.equal(m.headers.cc, 'copia@x.com');
  assert.match(m.headers.from, /Manda4 Financeiro.*<financeiro@manda4\.com\.br>/);
  const [alt, att] = m.parts;
  assert.equal(flat(alt)[0].text, 'Olá, João!\nTotal: R$ 1.250,00 — ação ✓');
  assert.match(flat(alt)[1].text, /<b>João<\/b>/);
  assert.match(att.headers['content-disposition'], /filename="detalhe-março\.csv"/);
  assert.ok(att.text.includes('Ação;1.250,00'));
  assert.deepEqual(s.cmds.filter(c => ['AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT'].includes(c)), ['AUTH', 'MAIL', 'RCPT', 'RCPT', 'DATA', 'QUIT']);
});

test('sem anexo vira multipart/alternative simples; login alternativo quando o servidor só oferece LOGIN', async t => {
  const s = await fakeServer({ caps: ['AUTH LOGIN'] }); t.after(() => s.srv.close());
  await sendMail(cfg(s.port), { from: 'a@b.com', to: 'c@d.com', subject: 'Oi', text: 'oi', html: '<p>oi</p>' });
  const m = parse(s.msgs[0]);
  assert.match(m.headers['content-type'], /multipart\/alternative/); assert.equal(m.parts.length, 2);
  assert.ok(s.cmds.filter(c => c === 'AUTH').length >= 1);
});

test('erros claros: senha errada, destinatário recusado, sem criptografia fora do localhost, servidor inexistente', async t => {
  const s = await fakeServer(); t.after(() => s.srv.close());
  const base = { from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't', html: '<p>t</p>' };
  await assert.rejects(() => sendMail(cfg(s.port, { pass: 'errada' }), base), /Autenticação recusada.*senha de app/);
  await assert.rejects(() => sendMail(cfg(s.port), { ...base, to: ['ok@x.com', 'bad@x.com'] }), /Destinatário recusado \(bad@x\.com\).*550/);
  await assert.rejects(() => sendMail({ host: 'smtp.exemplo.com', port: 25, secure: 'none' }, base), /só é permitida em localhost/);
  await assert.rejects(() => sendMail(cfg(1), base), /Não consegui conectar/);
  await assert.rejects(() => sendMail(cfg(s.port), { ...base, to: '' }), /destinatário/);
  await assert.rejects(() => sendMail(cfg(s.port), { ...base, from: 'invalido' }), /remetente inválido/);
  await assert.rejects(() => sendMail(cfg(s.port), { ...base, to: 'c@d.com\r\nBcc: x@y.com' }), /E-mail inválido/);
});

test('assunto com quebra de linha não injeta cabeçalho; testConnection autentica sem enviar', async t => {
  const s = await fakeServer(); t.after(() => s.srv.close());
  await sendMail(cfg(s.port), { from: 'a@b.com', to: 'c@d.com', subject: 'Linha 1\r\nBcc: espiao@x.com', text: 't', html: '<p>t</p>' });
  const m = parse(s.msgs[0]);
  assert.ok(!('bcc' in m.headers)); assert.match(m.headers.subject, /Linha 1 Bcc: espiao@x\.com/);
  const antes = s.msgs.length;
  const r = await testConnection(cfg(s.port)); assert.equal(r.ok, true); assert.equal(r.autenticado, true); assert.equal(s.msgs.length, antes);
  await assert.rejects(() => testConnection(cfg(s.port, { pass: 'x' })), /Autenticação recusada/);
});
