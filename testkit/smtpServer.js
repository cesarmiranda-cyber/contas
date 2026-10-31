'use strict';
const net = require('node:net');

// Servidor SMTP falso: AUTH PLAIN/LOGIN (usuario/senha), recusa o destinatário "bad@x.com", guarda as mensagens recebidas.
function fakeServer({ user = 'usuario', pass = 'senha', caps = ['AUTH PLAIN LOGIN'] } = {}) {
  const msgs = [], cmds = [];
  const srv = net.createServer(sock => {
    let buf = '', data = null, step = null;
    const w = l => sock.write(l + '\r\n');
    w('220 fake ESMTP');
    sock.on('data', d => {
      buf += d.toString('utf8');
      for (;;) {
        if (data !== null) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; msgs.push(buf.slice(0, i + 2).replace(/\r\n\.\./g, '\r\n.')); buf = buf.slice(i + 5); data = null; w('250 queued'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); cmds.push(line.split(' ')[0]);
        if (step === 'user') { step = line === Buffer.from(user).toString('base64') ? 'pass' : 'bad'; w('334 UGFzc3dvcmQ6'); continue; }
        if (step === 'pass' || step === 'bad') { w(step === 'pass' && line === Buffer.from(pass).toString('base64') ? '235 ok' : '535 5.7.8 credenciais invalidas'); step = null; continue; }
        if (/^EHLO/i.test(line)) { const l = ['fake', ...caps]; l.forEach((c, k) => w(`250${k < l.length - 1 ? '-' : ' '}${c}`)); }
        else if (/^AUTH PLAIN/i.test(line)) w(Buffer.from(line.split(' ')[2], 'base64').toString() === `\0${user}\0${pass}` ? '235 ok' : '535 5.7.8 credenciais invalidas');
        else if (/^AUTH LOGIN/i.test(line)) { step = 'user'; w('334 VXNlcm5hbWU6'); }
        else if (/^MAIL FROM/i.test(line)) w('250 ok');
        else if (/^RCPT TO/i.test(line)) w(/bad@x\.com/.test(line) ? '550 5.1.1 usuario inexistente' : '250 ok');
        else if (/^DATA/i.test(line)) { data = ''; w('354 go'); }
        else if (/^QUIT/i.test(line)) { w('221 bye'); sock.end(); }
        else w('500 ?');
      }
    });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, msgs, cmds, port: srv.address().port })));
}
// decodificador mínimo de MIME (base64, multipart)
const decWord = s => s.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
function parse(raw) {
  const [h, ...rest] = raw.split('\r\n\r\n'); const body = rest.join('\r\n\r\n');
  const headers = {}; for (const l of h.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) { const k = l.indexOf(':'); headers[l.slice(0, k).toLowerCase()] = decWord(l.slice(k + 1).trim()); }
  const ct = headers['content-type'] || '', m = ct.match(/boundary="([^"]+)"/);
  if (!m) return { headers, text: Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') };
  const parts = body.split(`--${m[1]}`).slice(1, -1).map(p => p.replace(/^\r\n/, '').replace(/\r\n$/, '')).map(parse);
  return { headers, parts };
}
const flat = p => (p.parts ? p.parts.flatMap(flat) : [p]);


module.exports = { fakeServer, parse, flat };
