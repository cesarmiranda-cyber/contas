'use strict';
// Certificado em PDF a partir de um PDF modelo (feito no Canva): cobre o trecho do participante e escreve o texto novo por cima
// (atualização incremental do PDF, sem dependências). O restante do modelo (logo, moldura, assinatura, 2ª página) fica intacto.
const FONTES = require('./pdfFontes');
const zlib = require('zlib');
const bad = m => Object.assign(new Error(m), { status: 400 });
const ESC = { '(': '\\(', ')': '\\)', '\\': '\\\\' };
const bytes = s => Buffer.from(String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\u0000-ÿ]/g, '?'), 'latin1');
const larg = (s, fonte, tam) => { let w = 0; for (const b of bytes(s)) w += (FONTES[fonte][b - 32] || 0); return w * tam / 1000; };
const lit = s => { const b = bytes(s); let o = ''; for (const c of b) { const ch = String.fromCharCode(c); o += ESC[ch] || (c < 32 ? ' ' : ch); } return '(' + o + ')'; };
const num = n => (Math.round(n * 100) / 100).toString();

// Quebra "trechos" ([{t, f}] com f = 'tr' | 'tb') em linhas de até `maxW` pontos e devolve os comandos de texto (justificado, exceto a última linha).
function paragrafo(trechos, { x, yTopo, maxW, tam, entre, alturaTopo }) {
  const palavras = []; for (const tr of trechos) for (const p of String(tr.t).split(/(\s+)/)) { if (!p) continue; palavras.push({ t: p, f: tr.f, esp: /^\s+$/.test(p) }); }
  const linhas = []; let atual = [], w = 0;
  for (const p of palavras) { const pw = larg(p.t, p.f, tam); if (p.esp) { if (atual.length) { atual.push({ ...p, w: larg(' ', p.f, tam) }); w += larg(' ', p.f, tam); } continue; } if (atual.length && w + pw > maxW) { while (atual.length && atual[atual.length - 1].esp) { w -= atual.pop().w; } linhas.push({ ps: atual, w }); atual = []; w = 0; } atual.push({ ...p, w: pw }); w += pw; }
  while (atual.length && atual[atual.length - 1].esp) { w -= atual.pop().w; } if (atual.length) linhas.push({ ps: atual, w });
  let cmd = ''; linhas.forEach((l, i) => {
    const ultima = i === linhas.length - 1, espacos = l.ps.filter(p => p.esp).length, extra = !ultima && espacos ? (maxW - l.w) / espacos : 0, y = yTopo - alturaTopo - i * entre;
    let cx = x; cmd += 'BT\n'; for (const p of l.ps) { const pw = p.w + (p.esp ? extra : 0); if (!p.esp) cmd += `/${p.f === 'tb' ? 'NMB' : 'NMR'} ${num(tam)} Tf 1 0 0 1 ${num(cx)} ${num(y)} Tm ${lit(p.t)} Tj\n`; cx += pw; } cmd += 'ET\n';
  });
  return { cmd, linhas: linhas.length };
}
function lerXref(pdf) {
  const s = pdf.toString('latin1'), sx = s.lastIndexOf('startxref'), pos = parseInt(s.slice(sx + 9).trim(), 10); if (!/^xref/.test(s.slice(pos, pos + 4))) throw bad('PDF modelo não suportado (xref).');
  const linhas = s.slice(pos).split(/\r?\n/), off = new Map(); let i = 1;
  while (i < linhas.length && !/^trailer/.test(linhas[i])) { const m = /^(\d+) (\d+)$/.exec(linhas[i]); if (!m) { i++; continue; } let n = +m[1]; for (let k = 0; k < +m[2]; k++) { const e = /^(\d{10}) (\d{5}) ([nf])/.exec(linhas[i + 1 + k]); if (e && e[3] === 'n') off.set(n, +e[1]); n++; } i += 1 + +m[2]; }
  const tr = s.slice(s.indexOf('trailer', pos)); return { s, off, pos, size: +/\/Size (\d+)/.exec(tr)[1], root: /\/Root (\d+ \d+ R)/.exec(tr)[1], info: (/\/Info (\d+ \d+ R)/.exec(tr) || [])[1], id: (/\/ID \[[^\]]*\]/.exec(tr) || [])[0] };
}
// Primeira página do PDF: objeto /Type /Page cujo pai é a árvore de páginas.
function primeiraPagina(x) {
  const cat = x.s.slice(x.off.get(+x.root.split(' ')[0])), pages = +/\/Pages (\d+) 0 R/.exec(cat)[1], po = x.s.slice(x.off.get(pages)), kid = +/\/Kids \[\s*(\d+) 0 R/.exec(po)[1];
  const ini = x.off.get(kid), fim = x.s.indexOf('endobj', ini); return { num: kid, texto: x.s.slice(ini, fim) };
}
// O texto do participante (parágrafo e data) vive em dois "Form XObjects" do Canva; saem do desenho para o nome anterior não ficar escondido no arquivo.
const REMOVER = ['X29', 'X41'], ANTIGOS = ['AMANDA ALVES DA SILVA'];
function formSemTexto(x, pg) {
  const ref = /\/XObject\s*<<\s*\/\w+\s+(\d+) 0 R/.exec(pg.texto); if (!ref) throw bad('PDF modelo com estrutura não suportada (XObject).');
  const num = +ref[1], ini = x.off.get(num), fim = x.s.indexOf('endobj', ini), bruto = x.s.slice(ini, fim), ds = bruto.indexOf('stream'), cab = bruto.slice(bruto.indexOf('<<'), ds).trimEnd();
  const buf = Buffer.from(x.s.slice(0, fim), 'latin1'), a = buf.indexOf('stream', ini) + 6, dados = buf.subarray(buf[a] === 13 ? a + 2 : a + 1, buf.indexOf('endstream', a)); let cont = /\/FlateDecode/.test(cab) ? zlib.inflateSync(dados.subarray(0, dados.length)).toString('latin1') : dados.toString('latin1');
  const resXo = /\/XObject\s*<<([^>]*)>>/.exec(bruto), zerar = [];
  for (const nome of REMOVER) { const ro = new RegExp(`/${nome} (\\d+) 0 R`).exec(resXo ? resXo[1] : cab); if (ro) { const o = x.off.get(+ro[1]), sa = buf.indexOf('stream', o) + 6, sb = buf.indexOf('endstream', sa); if (o && sa > 5 && sb > sa) zerar.push([sa, sb]); } }
  for (const nome of REMOVER) { const r = new RegExp(`q\\n[^Q]*?\\/${nome} Do\\nEMC\\nQ\\n`); if (!r.test(cont)) throw bad('PDF modelo com conteúdo diferente do esperado.'); cont = cont.replace(r, ''); }
  const novoCab = cab.replace(new RegExp(`\\s*/(${REMOVER.join('|')}) \\d+ 0 R`, 'g'), '').replace(/\/Length \d+/, `/Length ${Buffer.byteLength(cont, 'latin1')}`).replace(/\/Filter\s*(\[\s*\/FlateDecode\s*\]|\/FlateDecode)\s*/, '');
  return { num, zerar, obj: Buffer.concat([Buffer.from(`${num} 0 obj\n${novoCab}\nstream\n`, 'latin1'), Buffer.from(cont, 'latin1'), Buffer.from('\nendstream\nendobj\n', 'latin1')]) };
}
const hoje = () => new Date();
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const dataExtenso = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]} de ${MESES[+m[2] - 1]} de ${m[1]}` : ''; };

// Certificado de capacitação: { nome, cpf, curso, cargaHoraria, cidade, data (AAAA-MM-DD) }
function gerarCertificado(pdf, d) {
  const nome = String(d.nome || '').trim().toUpperCase(), cpf = String(d.cpf || '').replace(/\D/g, ''); if (nome.length < 3) throw bad('Informe o nome do participante.'); if (cpf.length !== 11) throw bad(`CPF inválido para ${nome}.`);
  const curso = String(d.curso || 'Curso de Boas Práticas de Manipulação').trim(), carga = String(d.cargaHoraria || '04:00').trim(), cidade = String(d.cidade || 'São Paulo').trim(), data = dataExtenso(d.data) || dataExtenso(hoje().toISOString());
  const x = lerXref(pdf), pg = primeiraPagina(x), mb = /\/MediaBox \[([\d.\s-]+)\]/.exec(pg.texto); if (!mb) throw bad('PDF modelo sem MediaBox.'); const [, y0, , y1] = mb[1].trim().split(/\s+/).map(Number), topo = y1;
  const Y = yTopo => topo - yTopo;   // coordenada medida do topo da página → coordenada do PDF
  const corpo = paragrafo([{ t: 'Certificamos que o(a) Sr(a). ', f: 'tr' }, { t: nome, f: 'tb' }, { t: ' portador(a) do ', f: 'tr' }, { t: `CPF ${cpf}`, f: 'tb' }, { t: ' participou do ', f: 'tr' }, { t: `"${curso}"`, f: 'tb' },
    { t: `, oferecido pela Nutri Mix Assessoria & Consultoria Nutricional, com carga horária de ${carga} horas.`, f: 'tr' }], { x: 72.5, yTopo: Y(252), maxW: 645.2, tam: 18, entre: 23.9, alturaTopo: 19 });
  if (corpo.linhas > 5) throw bad('O texto do certificado ficou grande demais (nome ou curso muito longos).');
  const rodape = `${cidade}, ${data}`;
  const conteudo = Buffer.from(['0 0 0 rg', corpo.cmd, `BT /NMH 10.6 Tf 1 0 0 1 82 ${num(Y(521))} Tm ${lit(rodape)} Tj ET\n`].join('\n'), 'latin1');
  let n = x.size; const nR = n++, nB = n++, nH = n++, nC = n++;
  const objs = [[nR, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>'], [nB, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>'], [nH, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']];
  let pagina = pg.texto.replace(/\/Contents (\d+ 0 R)/, `/Contents [$1 ${nC} 0 R]`);
  if (pagina === pg.texto) throw bad('PDF modelo com estrutura de conteúdo não suportada.');
  pagina = pagina.replace(/\/Resources\s*<</, `/Resources << /Font << /NMR ${nR} 0 R /NMB ${nB} 0 R /NMH ${nH} 0 R >>`);
  const form = formSemTexto(x, pg), base = Buffer.from(pdf); for (const [a, b] of form.zerar) base.fill(0, a, b);
  for (const antigo of ANTIGOS) { const alvo = Buffer.from(antigo, 'latin1'); let i = base.indexOf(alvo); while (i >= 0) { base.fill(0x20, i, i + alvo.length); i = base.indexOf(alvo, i + alvo.length); } }   // índice/estrutura do PDF também guardam o nome do modelo   // o texto antigo do participante não fica no arquivo
  const partes = [Buffer.from('\n', 'latin1')]; let pos = pdf.length + 1; const offs = new Map();
  const add = (num_, corpoObj) => { offs.set(num_, pos); const b = Buffer.isBuffer(corpoObj) ? corpoObj : Buffer.from(corpoObj, 'latin1'); partes.push(b); pos += b.length; };
  for (const [k, t] of objs) add(k, `${k} 0 obj\n${t}\nendobj\n`);
  add(nC, Buffer.concat([Buffer.from(`${nC} 0 obj\n<< /Length ${conteudo.length} >>\nstream\n`, 'latin1'), conteudo, Buffer.from('\nendstream\nendobj\n', 'latin1')]));
  add(form.num, form.obj);
  add(pg.num, Buffer.from(pagina.trimEnd() + '\nendobj\n', 'latin1'));
  const nums = [...offs.keys()].sort((a, b) => a - b), xrefPos = pos; let xr = 'xref\n0 1\n0000000000 65535 f \n';
  // subseções contíguas
  let i = 0; while (i < nums.length) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; xr += `${nums[i]} ${j - i + 1}\n`; for (let k = i; k <= j; k++) xr += `${String(offs.get(nums[k])).padStart(10, '0')} 00000 n \n`; i = j + 1; }
  xr += `trailer\n<< /Size ${n} /Root ${x.root}${x.info ? ` /Info ${x.info}` : ''} /Prev ${x.pos}${x.id ? ' ' + x.id : ''} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  partes.push(Buffer.from(xr, 'latin1')); return Buffer.concat([base, ...partes]);
}
module.exports = { gerarCertificado, dataExtenso, larg };
