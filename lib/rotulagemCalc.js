'use strict';
// Conferência numérica da tabela de informação nutricional e da rotulagem frontal.
// Regras: RDC 429/2020 (arts. 7, 10, 12, 18, 32, 33) e IN 75/2020 (Anexos II, III, IV, VI, XV, XVII, XVIII, XXII).
const NUTRI = [   // chave, nome, unidade, VDR (Anexo II), limite de "não significativo" (Anexo IV), tolerância (RDC 429, art. 33: 'max' não passa de +20%, 'min' não fica 20% abaixo)
  { k: 'carbo', nome: 'Carboidratos', un: 'g', vdr: 300, ns: 0.5, tol: 'max' },
  { k: 'acucTot', nome: 'Açúcares totais', un: 'g', vdr: null, ns: 0.5, tol: 'max', n1: true },
  { k: 'acucAdic', nome: 'Açúcares adicionados', un: 'g', vdr: 50, ns: null, tol: 'max', n2: true },
  { k: 'prot', nome: 'Proteínas', un: 'g', vdr: 50, ns: 0.5, tol: 'min' },
  { k: 'gordTot', nome: 'Gorduras totais', un: 'g', vdr: 65, ns: 0.5, tol: 'max' },
  { k: 'gordSat', nome: 'Gorduras saturadas', un: 'g', vdr: 20, ns: 0.1, tol: 'max', n1: true },
  { k: 'gordTrans', nome: 'Gorduras trans', un: 'g', vdr: 2, ns: 0.1, tol: 'max', n1: true },
  { k: 'fibras', nome: 'Fibras alimentares', un: 'g', vdr: 25, ns: 0.5, tol: 'min' },
  { k: 'sodio', nome: 'Sódio', un: 'mg', vdr: 2000, ns: 5, tol: 'max' },
];
const LIMITES = { acucAdic: { solido: 15, liquido: 7.5, nome: 'AÇÚCAR ADICIONADO' }, gordSat: { solido: 6, liquido: 3, nome: 'GORDURA SATURADA' }, sodio: { solido: 600, liquido: 300, nome: 'SÓDIO' } };   // Anexo XV, por 100 g ou 100 ml
const num = v => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
const meio = (v, casas) => { const f = 10 ** casas; return Math.round(v * f + 1e-9) / f; };   // metade para cima

// Anexo III: arredondamento por faixa (g de 1 casa para <10; mg/µg de 2 casas para <1).
function arredondar(v, un) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 10) return meio(v, 0);
  if (v >= 1) return meio(v, 1);
  return un === 'g' ? meio(v, 1) : meio(v, 2);
}
const fmt = v => (v == null ? '—' : String(v).replace('.', ','));
// Anexo IV: abaixo do limite o valor é declarado como zero (quando as demais condições do anexo se cumprem).
const naoSignificativo = (n, v) => n.ns != null && v != null && v <= n.ns;
const energiaKcal = r => Math.round((4 * (r.carbo || 0) + 4 * (r.prot || 0) + 9 * (r.gordTot || 0) + 2 * (r.fibraSolUsada || 0)) + 1e-9);   // Anexo XXII, com os nutrientes já arredondados (RDC 429, art. 32 §1)

function porcoesPorEmbalagem(embalagem, porcao) {   // Anexo VI; embalagem individual (até 2 porções) não declara
  if (!(embalagem > 0 && porcao > 0)) return null; const n = embalagem / porcao;
  if (n <= 2 + 1e-9) return { declarar: false, texto: 'Embalagem individual: não declara o número de porções (RDC 429, art. 10); a porção é o conteúdo total (art. 9, I).' };
  const inteiro = Math.abs(n - Math.round(n)) < 1e-9;
  return { declarar: true, n, texto: inteiro ? `Porções por embalagem: ${Math.round(n)}` : `Porções por embalagem: Cerca de ${meio(n, 0)}` };
}

function frontal(v100, base, painelCm2) {
  const lim = Object.entries(LIMITES).filter(([k, l]) => v100[k] != null && v100[k] >= l[base]).map(([k, l]) => ({ k, nome: l.nome, limite: l[base], valor: v100[k] }));
  const perto = Object.entries(LIMITES).filter(([k, l]) => v100[k] != null && v100[k] < l[base] && v100[k] >= l[base] * 0.9).map(([k, l]) => `${l.nome}: ${fmt(v100[k])} está a menos de 10% do limite (${fmt(l[base])}); confirme o valor exato sem arredondar.`);
  const ks = lim.map(x => x.k), tem = k => ks.includes(k), a = tem('acucAdic'), g = tem('gordSat'), s = tem('sodio');
  const modelo = !lim.length ? 0 : a && g && s ? 1 : a && g ? 2 : a && s ? 3 : g && s ? 4 : a ? 5 : g ? 6 : 7;
  const out = { obrigatoria: lim.length > 0, nutrientes: lim, modeloAnexoXVII: modelo, blocos: lim.length ? lim.length + 1 : 0, perto, observacoes: [] };
  if (lim.length && painelCm2 > 0) {
    if (painelCm2 < 35) { out.opcional = true; out.observacoes.push('Painel principal menor que 35 cm²: a rotulagem frontal é opcional (RDC 429, art. 18 §3º, I).'); }
    else { const pct = painelCm2 <= 100 ? { 2: 3.5, 3: 5.25, 4: 7 }[out.blocos] : { 2: 2, 3: 3, 4: 4 }[out.blocos]; out.ocupacaoPct = pct; out.areaMinCm2 = meio(painelCm2 * pct / 100, 2); out.fonte = painelCm2 <= 100 ? { min: null, max: 9 } : { min: 9, max: 15 };
      out.observacoes.push(`Área mínima: ${pct}% do painel principal = ${fmt(out.areaMinCm2)} cm². Fonte Arial Narrow negrito, ${painelCm2 <= 100 ? 'até 9 pt' : 'de 9 a 15 pt'}; metade superior do painel, preto em fundo branco (Anexo XVIII).`); }
  }
  return out;
}

// entrada: { base:'solido'|'liquido', porcao, embalagem, painel, energia, v100:{...}, lab:{...} }
function calcular(e) {
  const base = e.base === 'liquido' ? 'liquido' : 'solido', porcao = num(e.porcao), emb = num(e.embalagem), painel = num(e.painel), un100 = base === 'liquido' ? 'ml' : 'g', alertas = [];
  const v = {}; for (const n of NUTRI) v[n.k] = num((e.v100 || {})[n.k]);
  const faltam = NUTRI.filter(n => v[n.k] == null && n.k !== 'acucAdic' || (n.k === 'acucAdic' && v.acucAdic == null)).map(n => n.nome);
  if (faltam.length) alertas.push(`Itens obrigatórios sem valor informado (RDC 429, art. 5º): ${faltam.join(', ')}. Se for zero, informe 0.`);
  if (v.acucAdic != null && v.acucTot != null && v.acucAdic > v.acucTot + 1e-9) alertas.push('Açúcares adicionados não podem ser maiores que os açúcares totais.');
  if (v.acucTot != null && v.carbo != null && v.acucTot > v.carbo + 1e-9) alertas.push('Açúcares totais não podem ser maiores que os carboidratos.');
  if (v.gordSat != null && v.gordTot != null && v.gordSat + (v.gordTrans || 0) > v.gordTot + 1e-9) alertas.push('Gorduras saturadas + trans não podem passar das gorduras totais.');
  const linhas = [], r100 = {}, rPorc = {};
  for (const n of NUTRI) {
    const x = v[n.k]; if (x == null) continue; const xp = porcao > 0 ? x * porcao / 100 : null;
    const a100 = arredondar(x, n.un), ap = xp == null ? null : arredondar(xp, n.un), ns100 = naoSignificativo(n, x), nsp = xp != null && naoSignificativo(n, xp);
    r100[n.k] = ns100 ? 0 : a100; rPorc[n.k] = ap == null ? null : nsp ? 0 : ap;
    const vd = n.vdr && rPorc[n.k] != null ? meio(rPorc[n.k] / n.vdr * 100, 0) : null;
    linhas.push({ k: n.k, nome: n.nome, un: n.un, indent: n.n2 ? 2 : n.n1 ? 1 : 0, bruto100: x, v100: r100[n.k], vPorcao: rPorc[n.k], vd, ns100, nsPorcao: nsp, vdr: n.vdr });
  }
  if (v.acucAdic != null && v.acucAdic === 0) alertas.push('Açúcares adicionados = 0 só pode ser declarado se o produto não tem açúcar nem ingrediente com açúcar adicionado (Anexo IV).');
  const calc = r => (['carbo', 'prot', 'gordTot'].every(k => r[k] != null) ? Math.round(4 * r.carbo + 4 * r.prot + 9 * r.gordTot + 2 * (r.fibraSolUsada || 0) + 1e-9) : null);
  const k100 = calc(r100), kP = porcao > 0 ? calc(rPorc) : null, inf = num(e.energia);
  const energia = { informada100: inf, calculada100: k100 == null ? null : (k100 <= 4 ? 0 : k100), calculadaPorcao: kP == null ? null : (kP <= 4 ? 0 : kP), ok: null };
  if (inf != null && energia.calculada100 != null) { energia.ok = Math.abs(inf - energia.calculada100) <= 1; if (!energia.ok) alertas.push(`Valor energético informado (${fmt(inf)} kcal) difere do calculado pelos fatores do Anexo XXII (${fmt(energia.calculada100)} kcal por 100 ${un100}). Calcule a partir dos nutrientes já arredondados (RDC 429, art. 32 §1º). Se houver polióis, álcool ou fibras solúveis, ajuste os fatores.`); }
  const porcoes = porcoesPorEmbalagem(emb, porcao), fr = frontal(Object.fromEntries(Object.entries(r100).map(([k, x]) => [k, v[k] == null ? null : (['acucAdic', 'gordSat', 'sodio'].includes(k) ? v[k] : x)])), base, painel);
  const tolerancia = [];
  for (const n of NUTRI) { const d = v[n.k], l = num((e.lab || {})[n.k]); if (d == null || l == null) continue;
    const ok = n.tol === 'max' ? l <= d * 1.2 + 1e-9 : l >= d * 0.8 - 1e-9; tolerancia.push({ nome: n.nome, un: n.un, declarado: d, analise: l, limite: n.tol === 'max' ? meio(d * 1.2, 2) : meio(d * 0.8, 2), regra: n.tol === 'max' ? 'análise não pode passar de 120% do declarado' : 'análise não pode ficar abaixo de 80% do declarado', ok });
    if (!ok) alertas.push(`${n.nome}: fora da tolerância de 20% (RDC 429, art. 33).`); }
  return { base, un100, porcao, linhas, energia, porcoes, frontal: fr, tolerancia, alertas };
}
function relatorioTexto(r) {
  const L = [`CONFERÊNCIA NUMÉRICA — por 100 ${r.un100}${r.porcao ? ` e por porção de ${fmt(r.porcao)} ${r.un100}` : ''}`];
  for (const l of r.linhas) L.push(`${'  '.repeat(l.indent)}${l.nome}: ${fmt(l.v100)} ${l.un}${l.ns100 ? ' (não significativo → 0)' : ''}${l.vPorcao != null ? ` | porção ${fmt(l.vPorcao)} ${l.un}` : ''}${l.vd != null ? ` | %VD ${l.vd}%` : ''}`);
  L.push(`Valor energético: ${fmt(r.energia.calculada100)} kcal por 100 ${r.un100}${r.energia.calculadaPorcao != null ? `, ${fmt(r.energia.calculadaPorcao)} kcal por porção` : ''}${r.energia.informada100 != null ? ` (informado: ${fmt(r.energia.informada100)})` : ''}`);
  if (r.porcoes) L.push(r.porcoes.texto);
  L.push(r.frontal.obrigatoria ? `Rotulagem frontal OBRIGATÓRIA: ${r.frontal.nutrientes.map(n => `${n.nome} (${fmt(n.valor)} ≥ ${fmt(n.limite)})`).join('; ')} — modelo ${r.frontal.modeloAnexoXVII} do Anexo XVII, ${r.frontal.blocos} blocos. ${r.frontal.observacoes.join(' ')}` : 'Rotulagem frontal: nenhum nutriente atinge o limite do Anexo XV.');
  for (const p of r.frontal.perto) L.push('ATENÇÃO: ' + p);
  for (const t of r.tolerancia) L.push(`Tolerância ${t.nome}: declarado ${fmt(t.declarado)}, análise ${fmt(t.analise)} → ${t.ok ? 'dentro' : 'FORA'} (${t.regra})`);
  for (const a of r.alertas) L.push('ALERTA: ' + a);
  return L.join('\n');
}
module.exports = { NUTRI, LIMITES, arredondar, naoSignificativo, porcoesPorEmbalagem, frontal, calcular, relatorioTexto, fmt };
