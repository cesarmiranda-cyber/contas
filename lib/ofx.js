'use strict';
// Leitor de extrato OFX (formato dos bancos brasileiros: SGML da versão 1 ou XML da versão 2).
const bad = msg => { const e = new Error(msg); e.status = 400; return e; };
const MAX_BYTES = 2e6, MAX_LINHAS = 5000;

const tag = (s, name) => { const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(s); return m ? m[1].trim() : ''; };
const dia = v => { const m = String(v).match(/^(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
// "1.234,56" | "1234,56" | "-1234.56" -> número
function valor(v) {
  let s = String(v).trim().replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
const limpa = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function parseOfx(texto) {
  const t = String(texto || '');
  if (t.length > MAX_BYTES) throw bad('Arquivo OFX muito grande (máx. 2 MB).');
  if (!/<OFX>/i.test(t) && !/OFXHEADER/i.test(t)) throw bad('Este arquivo não parece um extrato OFX.');
  const blocos = t.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|<\/STMTRS>|<\/CCSTMTRS>)/gi) || [];
  if (!blocos.length) throw bad('O arquivo OFX não tem lançamentos.');
  if (blocos.length > MAX_LINHAS) throw bad(`O arquivo tem mais de ${MAX_LINHAS} lançamentos. Importe por períodos menores.`);
  const linhas = blocos.map((b, i) => {
    const data = dia(tag(b, 'DTPOSTED')), v = valor(tag(b, 'TRNAMT'));
    if (!data || Number.isNaN(v)) throw bad(`Lançamento ${i + 1} do OFX com data ou valor inválido.`);
    const memo = limpa(tag(b, 'MEMO')), nome = limpa(tag(b, 'NAME'));
    return { fitid: tag(b, 'FITID'), data, valor: v, tipo: tag(b, 'TRNTYPE'), descricao: memo || nome || 'Lançamento sem descrição', doc: tag(b, 'CHECKNUM') || tag(b, 'REFNUM') };
  });
  const bal = /<LEDGERBAL>([\s\S]*?)(?=<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i.exec(t);
  return {
    banco: tag(t, 'BANKID'), conta: tag(t, 'ACCTID'), agencia: tag(t, 'BRANCHID'),
    inicio: dia(tag(t, 'DTSTART')), fim: dia(tag(t, 'DTEND')),
    saldoFinal: bal ? valor(tag(bal[1], 'BALAMT')) : null, saldoEm: bal ? dia(tag(bal[1], 'DTASOF')) : '',
    linhas,
  };
}
module.exports = { parseOfx, valor };
