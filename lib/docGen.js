'use strict';
// Geração de documentos a partir de modelos: .docx e .xlsx com marcadores {{campo}} e certificado em PDF (sobreposição).
const { lerZip, criarZip } = require('./zip');
const RE_PH = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const norm = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n');
const bad = m => Object.assign(new Error(m), { status: 400 });

// Troca os marcadores dentro de cada "parágrafo" (w:p no Word, si no Excel), mesmo quando o Word os parte em vários trechos.
function preencherXml(xml, valores, { paragrafo, no, word }, faltam) {
  return xml.replace(paragrafo, p => {
    const nos = []; p.replace(no, (m, attrs, txt, off) => { nos.push({ ini: off, fim: off + m.length, attrs: attrs || '', txt: unesc(txt) }); return m; });
    if (!nos.length) return p;
    const todo = nos.map(n => n.txt).join(''); if (!todo.includes('{{')) return p;
    const ms = [...todo.matchAll(RE_PH)]; if (!ms.length) return p;
    const val = k => { if (!(k in valores)) faltam && faltam.add(k); return norm(valores[k]); };
    if (word && ms.length === 1 && todo.trim() === ms[0][0] && !val(ms[0][1]).trim()) return '';   // parágrafo só com um campo vazio some do documento
    const base = []; let acc = 0; for (const n of nos) { base.push(acc); acc += n.txt.length; }
    const novo = nos.map(n => n.txt), noDe = pos => { let i = nos.length - 1; while (i > 0 && base[i] > pos) i--; return i; };
    for (const m of ms.reverse()) {
      const ini = m.index, fim = m.index + m[0].length, a = noDe(ini), b = noDe(fim - 1), v = val(m[1]);
      if (a === b) novo[a] = novo[a].slice(0, ini - base[a]) + v + novo[a].slice(fim - base[a]);
      else { novo[a] = novo[a].slice(0, ini - base[a]) + v; for (let k = a + 1; k < b; k++) novo[k] = ''; novo[b] = novo[b].slice(fim - base[b]); }
    }
    let r = p; for (let i = nos.length - 1; i >= 0; i--) {
      const n = nos[i], t = word ? esc(novo[i]).replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">') : esc(novo[i]), attrs = / xml:space=/.test(n.attrs) ? n.attrs : n.attrs + ' xml:space="preserve"';
      r = r.slice(0, n.ini) + (word ? `<w:t${attrs}>${t}</w:t>` : `<t${attrs}>${t}</t>`) + r.slice(n.fim);
    }
    return r;
  });
}
const WORD = { paragrafo: /<w:p[ >][\s\S]*?<\/w:p>/g, no: /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, word: true };
const SHEET = { paragrafo: /<si>[\s\S]*?<\/si>/g, no: /<t(\s[^>]*)?>([\s\S]*?)<\/t>/g, word: false };

// Campos {{...}} que o modelo (.docx ou .xlsx) usa.
function campos(buf, formato) {
  const achados = new Set();
  for (const e of lerZip(buf)) {
    const w = formato === 'docx' && /^word\/(document|header\d*|footer\d*)\.xml$/.test(e.nome), x = formato === 'xlsx' && e.nome === 'xl/sharedStrings.xml'; if (!w && !x) continue;
    const cfg = w ? WORD : SHEET; preencherXml(e.dados.toString('utf8'), new Proxy({}, { has: () => true, get: (_, k) => { achados.add(String(k)); return ''; } }), cfg);
  }
  return [...achados];
}
function gerarDocx(buf, valores) {
  const faltam = new Set(), ent = lerZip(buf).map(e => /^word\/(document|header\d*|footer\d*)\.xml$/.test(e.nome) ? { ...e, dados: Buffer.from(preencherXml(e.dados.toString('utf8'), valores, WORD, faltam), 'utf8') } : e);
  return { buf: criarZip(ent), faltam: [...faltam] };
}
function gerarXlsxCampos(buf, valores) {
  const faltam = new Set(), ent = lerZip(buf).map(e => e.nome === 'xl/sharedStrings.xml' ? { ...e, dados: Buffer.from(preencherXml(e.dados.toString('utf8'), valores, SHEET, faltam), 'utf8') } : e);
  return { buf: criarZip(ent), faltam: [...faltam] };
}
const serial = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 864e5) : null; };
// Plano de ação (planilha): título e responsáveis nas linhas do cabeçalho; uma linha por inadequação, no mesmo estilo do modelo.
const COLS_PLANO = [['B', 'inadequacao', 2], ['C', 'consequencia', 3], ['D', 'dataFicha', 4, 1], ['E', 'dataAuditoria', 4, 1], ['F', 'acao', 3], ['G', 'responsavel', 3], ['H', 'prazo', 4, 1], ['I', 'status', 13], ['J', 'evidencia', 10], ['K', 'observacao', 9]];
function gerarPlanoXlsx(buf, { titulo, subtitulo, linhas }) {
  const ent = lerZip(buf), shNome = 'xl/worksheets/sheet1.xml', i = ent.findIndex(e => e.nome === shNome); if (i < 0) throw bad('Modelo de planilha inválido.');
  let x = ent[i].dados.toString('utf8');
  const inl = (ref, s, txt) => x.replace(new RegExp(`<c r="${ref}"( s="\\d+")? t="s"><v>\\d+</v></c>`), (_, st) => `<c r="${ref}"${st || ''} t="inlineStr"><is><t xml:space="preserve">${esc(txt)}</t></is></c>`);
  if (titulo) x = inl('C2', 0, titulo); if (subtitulo) x = inl('B3', 0, subtitulo);
  const cabIdx = x.indexOf('<row r="7"'), fimDados = x.indexOf('</sheetData>'); if (fimDados < 0) throw bad('Modelo de planilha inválido.');
  const antes = cabIdx >= 0 ? x.slice(0, cabIdx) : x.slice(0, fimDados), apos = x.slice(fimDados);
  const rows = (linhas && linhas.length ? linhas : [{}]).map((l, k) => {
    const r = 7 + k, cels = COLS_PLANO.map(([col, campo, s, data]) => { const v = l[campo]; const ref = `${col}${r}`; if (v === undefined || v === null || v === '') return `<c r="${ref}" s="${s}"/>`; if (data) { const n = serial(v); return n ? `<c r="${ref}" s="${s}"><v>${n}</v></c>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`; } return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(norm(v))}</t></is></c>`; }).join('');
    return `<row r="${r}" spans="2:11">${cels}</row>`;
  }).join('');
  x = (antes + rows + apos).replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="B1:K${6 + Math.max(1, (linhas || []).length)}"/>`);
  ent[i] = { ...ent[i], dados: Buffer.from(x, 'utf8') }; return { buf: criarZip(ent) };
}
module.exports = { campos, gerarDocx, gerarXlsxCampos, gerarPlanoXlsx, preencherXml, serial };
