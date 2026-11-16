'use strict';
// Memorial de cálculo de suplementos: composição por cápsula, dose e dia, %VD pelos VDR do Anexo VIII da IN 75/2020
// (suplementos e alimentos para fins especiais, por grupo populacional) e conferência contra os limites que a equipe cadastrar
// (mínimos e máximos da norma de suplementos: o sistema não traz esses limites; quem cadastra confere no texto oficial).
const { norm } = require('./feriados');
const GRUPOS = [['0-6m', '0 a 6 meses'], ['7-11m', '7 a 11 meses'], ['1-3a', '1 a 3 anos'], ['4-8a', '4 a 8 anos'], ['9-18a', '9 a 18 anos'], ['19a', '19 anos ou mais'], ['gest', 'Gestantes'], ['lact', 'Lactantes']];
const N = null;
// nome | unidade | valores nos 8 grupos (null = sem VDR para o grupo) | apelidos
const VDR = [
  ['Valor energético', 'kcal', [550, 700, 1000, 1500, 2500, 2000, 2300, 2600], ['energia', 'calorias']], ['Carboidratos', 'g', [60, 95, 150, 225, 375, 300, 345, 360]], ['Açúcares adicionados', 'g', [N, N, 25, 35, 60, 50, 55, 65]], ['Proteínas', 'g', [9, 11, 25, 35, 60, 50, 55, 65], ['proteina']],
  ['Gorduras totais', 'g', [30, 27, 33, 50, 80, 65, 75, 85]], ['Gorduras saturadas', 'g', [N, N, 11, 16, 27, 20, 25, 28]], ['Gorduras trans', 'g', [N, N, 1, 1.5, 2.5, 2, 2.5, 2.5]], ['Gorduras monoinsaturadas', 'g', [N, N, 11, 16, 27, 20, 25, 28]], ['Gorduras poli-insaturadas', 'g', [N, N, 11, 16, 27, 20, 25, 28]],
  ['Ômega 6', 'g', [N, N, 9, 13, 22, 18, 20, 23]], ['Ômega 3', 'mg', [N, N, 2000, 3000, 5000, 4000, 5000, 5000]], ['Colesterol', 'mg', [N, N, 300, 300, 300, 300, 300, 300]], ['Fibras alimentares', 'g', [N, N, 19, 25, 38, 25, 28, 29], ['fibras', 'fibra alimentar']], ['Sódio', 'mg', [120, 370, 1000, 2000, 2000, 2000, 2000, 2000]],
  ['Vitamina A', 'µg', [400, 500, 300, 400, 900, 800, 770, 1300], ['retinol', 'vitamina a rae']], ['Vitamina D', 'µg', [10, 10, 15, 15, 15, 15, 15, 15], ['colecalciferol']], ['Vitamina E', 'mg', [4, 5, 6, 7, 15, 15, 15, 15], ['alfa-tocoferol', 'tocoferol']], ['Vitamina K', 'µg', [2, 2.5, 30, 55, 75, 120, 90, 90]], ['Vitamina C', 'mg', [40, 50, 15, 25, 75, 100, 85, 120], ['acido ascorbico']],
  ['Tiamina', 'mg', [0.2, 0.3, 0.5, 0.6, 1.2, 1.2, 1.4, 1.4], ['vitamina b1']], ['Riboflavina', 'mg', [0.3, 0.4, 0.5, 0.6, 1.3, 1.2, 1.4, 1.6], ['vitamina b2']], ['Niacina', 'mg', [2, 4, 6, 8, 16, 15, 18, 17], ['vitamina b3']], ['Vitamina B6', 'mg', [0.1, 0.3, 0.5, 0.6, 1.3, 1.3, 1.9, 2], ['piridoxina']],
  ['Biotina', 'µg', [5, 6, 8, 12, 25, 30, 30, 35], ['vitamina b7']], ['Ácido fólico', 'µg', [65, 80, 150, 200, 400, 400, 600, 500], ['folato', 'vitamina b9']], ['Ácido pantotênico', 'mg', [1.7, 1.8, 2, 3, 5, 5, 6, 7], ['vitamina b5', 'pantotenico']], ['Vitamina B12', 'µg', [0.4, 0.5, 0.9, 1.2, 2.4, 2.4, 2.6, 2.8], ['cianocobalamina']],
  ['Cálcio', 'mg', [200, 260, 700, 1000, 1300, 1000, 1300, 1300]], ['Cloreto', 'mg', [180, 570, 1500, 1900, 2300, 2300, 2300, 2300]], ['Cobre', 'µg', [200, 220, 340, 440, 890, 900, 1000, 1300]], ['Cromo', 'µg', [0.2, 5.5, 11, 15, 35, 35, 30, 45]], ['Ferro', 'mg', [0.27, 11, 7, 10, 15, 14, 27, 10]], ['Flúor', 'mg', [0.01, 0.5, 0.7, 1, 3, 4, 3, 3]], ['Fósforo', 'mg', [100, 275, 460, 500, 1250, 700, 1250, 1250]],
  ['Iodo', 'µg', [110, 130, 90, 90, 150, 150, 220, 290]], ['Magnésio', 'mg', [30, 75, 80, 130, 410, 420, 400, 360]], ['Manganês', 'mg', [0.003, 0.6, 1.2, 1.5, 2.2, 3, 2, 2.6]], ['Molibdênio', 'µg', [2, 3, 17, 22, 43, 45, 5, 50]], ['Potássio', 'mg', [400, 700, 3000, 3500, 3500, 3500, 3500, 3500]], ['Selênio', 'µg', [15, 20, 20, 30, 55, 60, 60, 70]], ['Zinco', 'mg', [2, 3, 3, 5, 11, 11, 12, 13]], ['Colina', 'mg', [125, 150, 200, 250, 550, 550, 450, 550]],
];
const UN = { g: 1e6, mg: 1e3, 'µg': 1, ug: 1, mcg: 1, kcal: null };   // tudo em µg para comparar
const chave = s => norm(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const INDICE = new Map(); for (const [i, v] of VDR.entries()) for (const nome of [v[0], ...(v[3] || [])]) INDICE.set(chave(nome), i);
const achaVdr = ativo => { const c = chave(ativo); if (INDICE.has(c)) return VDR[INDICE.get(c)]; for (const [k, i] of INDICE) if (k.length > 4 && c.includes(k)) return VDR[i]; return null; };
const num = v => { if (v == null || String(v).trim() === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const meio = (v, c) => { const f = 10 ** c; return Math.round(v * f + 1e-9) / f; };
const fmt = v => (v == null ? '—' : String(meio(v, 3)).replace('.', ','));
const aUn = (valor, de, para) => (UN[de] == null || UN[para] == null ? (de === para ? valor : null) : valor * UN[de] / UN[para]);

// form: { grupo, capsulasPorDose, dosesPorDia, capacidadeCapsulaMg, lote, itens:[{materiaPrima, ativo, un, qtd (do ativo por cápsula), teor (% do ativo na matéria-prima), massaMg (da matéria-prima por cápsula, se não houver ativo), fornecedor}] }
function memorial(form, limites = {}) {
  const g = Math.max(0, GRUPOS.findIndex(x => x[0] === form.grupo)), cpd = num(form.capsulasPorDose) || 1, dpd = num(form.dosesPorDia) || 1, cap = num(form.capacidadeCapsulaMg), lote = num(form.lote);
  const linhas = [], alertas = []; let massaTotal = 0; const lim = Object.fromEntries(Object.entries(limites || {}).map(([k, v]) => [chave(k), v]));
  for (const it of form.itens || []) {
    const qtd = num(it.qtd), teor = num(it.teor), massaDireta = num(it.massaMg), un = it.un || 'mg'; if (!it.materiaPrima && !it.ativo) continue;
    let massa = massaDireta; if (massa == null && qtd != null) massa = aUn(qtd, un, 'mg') != null ? (teor > 0 ? aUn(qtd, un, 'mg') / (teor / 100) : aUn(qtd, un, 'mg')) : null;
    if (massa != null) massaTotal += massa;
    const l = { materiaPrima: it.materiaPrima || '', fornecedor: it.fornecedor || '', ativo: it.ativo || '', un, porCapsula: qtd, porDose: qtd == null ? null : qtd * cpd, porDia: qtd == null ? null : qtd * cpd * dpd, teor, massaMgPorCapsula: massa == null ? null : meio(massa, 3), vdr: null, vd: null, limite: null };
    if (it.ativo && qtd != null) {
      const v = achaVdr(it.ativo); if (v && v[2][g] != null) { const dose = aUn(l.porDose, un, v[1]); if (dose != null) { l.vdr = `${fmt(v[2][g])} ${v[1]}`; l.vd = meio(dose / v[2][g] * 100, 1); } else alertas.push(`${it.ativo}: unidade ${un} não compara com o VDR em ${v[1]}.`); }
      else if (v) alertas.push(`${it.ativo}: sem VDR para o grupo ${GRUPOS[g][1]} no Anexo VIII.`); else alertas.push(`${it.ativo}: sem VDR no Anexo VIII (confira a norma de suplementos para o limite).`);
      const L = lim[chave(it.ativo)]; if (L) { const pd = aUn(l.porDia, un, L.un || un); l.limite = { min: L.min ?? null, max: L.max ?? null, un: L.un || un, ref: L.ref || '', valorDia: pd, ok: pd != null && (L.min == null || pd >= L.min) && (L.max == null || pd <= L.max) }; if (!l.limite.ok) alertas.push(`${it.ativo}: ${fmt(pd)} ${L.un || un}/dia fora do limite cadastrado (${L.min != null ? 'mín. ' + fmt(L.min) : ''}${L.min != null && L.max != null ? ' · ' : ''}${L.max != null ? 'máx. ' + fmt(L.max) : ''} ${L.un || un}${L.ref ? ', ' + L.ref : ''}).`); }
      else alertas.push(`${it.ativo}: nenhum limite cadastrado para conferir (cadastre os limites da norma de suplementos).`);
    }
    linhas.push(l);
  }
  if (cap > 0 && massaTotal > cap + 1e-9) alertas.push(`Massa total por cápsula (${fmt(massaTotal)} mg) maior que a capacidade informada (${fmt(cap)} mg).`);
  const ordem = lote > 0 ? linhas.filter(l => l.massaMgPorCapsula != null).map(l => ({ materiaPrima: l.materiaPrima || l.ativo, fornecedor: l.fornecedor, g: meio(l.massaMgPorCapsula * lote / 1000, 2) })) : [];
  const r = { grupo: GRUPOS[g][1], capsulasPorDose: cpd, dosesPorDia: dpd, capacidadeCapsulaMg: cap, massaTotalMgPorCapsula: meio(massaTotal, 3), lote, linhas, ordem, alertas };
  r.texto = textoMemorial(r); return r;
}
function textoMemorial(r) {
  const L = [`MEMORIAL DE CÁLCULO — grupo: ${r.grupo} · ${r.capsulasPorDose} cápsula(s) por dose · ${r.dosesPorDia} dose(s) por dia`, ''];
  for (const l of r.linhas) L.push(`${l.ativo || l.materiaPrima}${l.materiaPrima && l.ativo ? ` (matéria-prima: ${l.materiaPrima}${l.fornecedor ? ', ' + l.fornecedor : ''}${l.teor ? ', teor ' + fmt(l.teor) + '%' : ''})` : ''}: ${l.porCapsula != null ? `${fmt(l.porCapsula)} ${l.un}/cápsula → ${fmt(l.porDose)} ${l.un}/dose → ${fmt(l.porDia)} ${l.un}/dia` : `${fmt(l.massaMgPorCapsula)} mg/cápsula`}${l.vd != null ? ` · %VD da dose: ${fmt(l.vd)}% (VDR ${l.vdr})` : ''}${l.limite ? ` · limite ${l.limite.ok ? 'atendido' : 'NÃO atendido'}` : ''}`);
  L.push('', `Massa total por cápsula: ${fmt(r.massaTotalMgPorCapsula)} mg${r.capacidadeCapsulaMg ? ` (capacidade ${fmt(r.capacidadeCapsulaMg)} mg)` : ''}`);
  if (r.ordem.length) { L.push('', `ORDEM DE PRODUÇÃO — lote de ${r.lote} cápsulas`); for (const o of r.ordem) L.push(`${o.materiaPrima}${o.fornecedor ? ` (${o.fornecedor})` : ''}: ${fmt(o.g)} g`); }
  for (const a of r.alertas) L.push('ALERTA: ' + a); return L.join('\n');
}
module.exports = { GRUPOS, VDR, achaVdr, memorial };
