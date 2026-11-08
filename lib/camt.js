'use strict';
// Extrato eletrônico ISO 20022 camt.053 (XML), como o do Itaú Empresas, no mesmo formato do leitor de OFX.
const bad = m => Object.assign(new Error(m), { status: 400 });
const MAX = 2e6, MAX_LINHAS = 5000;
const un = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
const tag = (s, n) => { const m = new RegExp(`<(?:\\w+:)?${n}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${n}>`, 'i').exec(s); return m ? m[1] : ''; };
const txt = (s, n) => un(tag(s, n).replace(/<[^>]+>/g, ' '));
const all = (s, n) => s.match(new RegExp(`<(?:\\w+:)?${n}(?:\\s[^>]*)?>[\\s\\S]*?</(?:\\w+:)?${n}>`, 'gi')) || [];
const dia = v => { const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; };
const num = v => { const n = Number(String(v).trim()); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };

function ehCamt(t) { return /BkToCstmrStmt/i.test(String(t || '')); }
function parseCamt053(texto) {
  const t = String(texto || ''); if (t.length > MAX) throw bad('Arquivo muito grande (máx. 2 MB).'); if (!ehCamt(t)) throw bad('Este arquivo não parece um extrato camt.053.');
  const linhas = []; let saldoFinal = null, saldoEm = '', conta = '', inicio = '', fim = '';
  for (const st of all(t, 'Stmt')) {
    conta = conta || txt(tag(st, 'Acct'), 'Id');
    for (const b of all(st, 'Bal')) { const cod = txt(tag(b, 'Tp'), 'Cd'); if (/CLBD|CLAV/i.test(cod)) { let v = num(txt(b, 'Amt')); if (/DBIT/i.test(txt(b, 'CdtDbtInd'))) v = -v; saldoFinal = v; saldoEm = dia((/<(?:\w+:)?Dt>\s*(\d{4}-\d{2}-\d{2})/.exec(b) || [])[1] || '') || saldoEm; } }
    for (const e of all(st, 'Ntry')) {
      let v = num(txt(e, 'Amt')); const d = dia(txt(tag(e, 'BookgDt'), 'Dt')) || dia(txt(tag(e, 'ValDt'), 'Dt')) || dia(txt(tag(e, 'BookgDt'), 'DtTm')); if (Number.isNaN(v) || !d) throw bad(`Lançamento ${linhas.length + 1} do camt.053 com data ou valor inválido.`);
      if (/DBIT/i.test(txt(e, 'CdtDbtInd'))) v = -Math.abs(v); else v = Math.abs(v);
      const ref = txt(e, 'AcctSvcrRef') || txt(e, 'NtryRef') || txt(e, 'EndToEndId'), nome = txt(tag(e, 'RltdPties'), 'Nm'), info = txt(e, 'AddtlNtryInf') || txt(tag(e, 'RmtInf'), 'Ustrd');
      linhas.push({ fitid: ref ? `${d}|${ref}` : '', data: d, valor: v, tipo: '', descricao: [info, nome].filter(Boolean).join(' — ').slice(0, 200) || 'Lançamento sem descrição', doc: txt(e, 'EndToEndId') });
      inicio = !inicio || d < inicio ? d : inicio; fim = !fim || d > fim ? d : fim;
    }
  }
  if (!linhas.length) throw bad('O arquivo camt.053 não tem lançamentos.'); if (linhas.length > MAX_LINHAS) throw bad(`O arquivo tem mais de ${MAX_LINHAS} lançamentos. Importe por períodos menores.`);
  return { banco: '', conta, agencia: '', inicio, fim, saldoFinal, saldoEm, linhas };
}
module.exports = { parseCamt053, ehCamt };
