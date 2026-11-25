'use strict';
// Leitura e escrita de arquivos ZIP (docx e xlsx são ZIPs) sem dependências: usa só o zlib do Node.
const zlib = require('zlib');
const TAB = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = TAB[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const bad = m => Object.assign(new Error(m), { status: 400 });

function lerZip(buf) {
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw bad('O arquivo não é um .docx/.xlsx válido (ZIP não encontrado).');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw bad('Arquivo ZIP corrompido.');
    const metodo = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42), nome = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28), ini = off + 30 + lnl + lel, bruto = buf.subarray(ini, ini + csize);
    out.push({ nome, dados: metodo === 0 ? Buffer.from(bruto) : metodo === 8 ? zlib.inflateRawSync(bruto) : (() => { throw bad('Compressão de ZIP não suportada.'); })() });
    p += 46 + nl + el + cl;
  }
  return out;
}
function criarZip(entradas) {
  const partes = [], cd = []; let off = 0;
  for (const { nome, dados } of entradas) {
    const nb = Buffer.from(nome, 'utf8'), crc = crc32(dados), comprimivel = !/\.(png|jpe?g|gif|zip)$/i.test(nome) && dados.length > 64, c = comprimivel ? zlib.deflateRawSync(dados) : dados, metodo = comprimivel ? 8 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(metodo, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(c.length, 18); lh.writeUInt32LE(dados.length, 22); lh.writeUInt16LE(nb.length, 26);
    partes.push(lh, nb, c);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(metodo, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(c.length, 20); ch.writeUInt32LE(dados.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, nb); off += 30 + nb.length + c.length;
  }
  const cdb = Buffer.concat(cd), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entradas.length, 8); eocd.writeUInt16LE(entradas.length, 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...partes, cdb, eocd]);
}
module.exports = { lerZip, criarZip, crc32 };
