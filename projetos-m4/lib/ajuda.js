'use strict';
// Sugestão de artigos da central de ajuda (busca simples por palavras, sem dependências).
const sem = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const PARADAS = new Set(['para', 'como', 'que', 'uma', 'com', 'por', 'nao', 'mas', 'meu', 'minha', 'esta', 'esse', 'essa', 'isso', 'sobre', 'quando', 'onde', 'tem', 'ter', 'fazer', 'preciso', 'quero', 'ajuda', 'erro', 'duvida', 'problema']);
const palavras = s => [...new Set(sem(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !PARADAS.has(w)))];
function sugerir(artigos, consulta, max = 3) {
  const q = palavras(consulta); if (!q.length) return [];
  return artigos.filter(a => a.publicado !== false).map(a => { const t = palavras(a.titulo), k = palavras(a.palavras), x = palavras(a.texto); let score = 0;
    for (const w of q) { if (t.some(y => y.startsWith(w) || w.startsWith(y))) score += 3; if (k.some(y => y.startsWith(w) || w.startsWith(y))) score += 2; if (x.includes(w)) score += 1; } return { a, score }; })
    .filter(r => r.score >= 2).sort((p, r) => r.score - p.score).slice(0, max).map(r => r.a);
}
module.exports = { sugerir, palavras };
