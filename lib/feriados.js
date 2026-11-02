'use strict';
// Feriados por cidade/UF: nacionais (calculados, incluindo os que dependem da Páscoa), estaduais e municipais
// de uma tabela interna, mais os cadastrados à mão. Pontos facultativos (Carnaval, Corpus Christi) vêm marcados.
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const somaDias = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function pascoa(y) {   // algoritmo de Meeus/Jones/Butcher
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, mes, dia);
}
function nacionais(y) {
  const p = pascoa(y), L = [
    [iso(y, 1, 1), 'Confraternização Universal'], [somaDias(p, -48), 'Carnaval (segunda)', 1], [somaDias(p, -47), 'Carnaval (terça)', 1], [somaDias(p, -2), 'Sexta-feira Santa'],
    [iso(y, 4, 21), 'Tiradentes'], [iso(y, 5, 1), 'Dia do Trabalho'], [somaDias(p, 60), 'Corpus Christi', 1], [iso(y, 9, 7), 'Independência'], [iso(y, 10, 12), 'Nossa Senhora Aparecida'],
    [iso(y, 11, 2), 'Finados'], [iso(y, 11, 15), 'Proclamação da República'], ...(y >= 2024 ? [[iso(y, 11, 20), 'Consciência Negra']] : []), [iso(y, 12, 25), 'Natal'],
  ];
  return L.map(([data, nome, fac]) => ({ data, nome, nivel: 'nacional', facultativo: !!fac }));
}
const ESTADUAIS = { SP: [[7, 9, 'Revolução Constitucionalista']], RJ: [[4, 23, 'São Jorge']], BA: [[7, 2, 'Independência da Bahia']], PE: [[3, 6, 'Data Magna de Pernambuco']], RS: [[9, 20, 'Revolução Farroupilha']],
  PR: [[12, 19, 'Emancipação do Paraná']], SC: [[8, 11, 'Dia de Santa Catarina']], CE: [[3, 25, 'Data Magna do Ceará']], DF: [[11, 30, 'Dia do Evangélico']], AM: [[9, 5, 'Elevação do Amazonas']],
  PA: [[8, 15, 'Adesão do Grão-Pará']], RN: [[10, 3, 'Mártires de Cunhaú e Uruaçu']], PB: [[8, 5, 'Fundação do Estado']], SE: [[7, 8, 'Autonomia de Sergipe']], MA: [[7, 28, 'Adesão do Maranhão']],
  PI: [[10, 19, 'Dia do Piauí']], TO: [[10, 5, 'Criação do Tocantins']], MS: [[10, 11, 'Criação do Estado']], AL: [[6, 24, 'São João'], [9, 16, 'Emancipação de Alagoas']] };
// Municipais conhecidos (cidade|UF → [mês, dia, nome]). O que não estiver aqui pode ser cadastrado à mão.
const MUNICIPAIS = { 'SAO PAULO|SP': [[1, 25, 'Aniversário de São Paulo']], 'SANTOS|SP': [[1, 26, 'Aniversário de Santos']], 'CAMPINAS|SP': [[7, 14, 'Aniversário de Campinas']],
  'GUARULHOS|SP': [[12, 8, 'Nossa Senhora do Desterro']], 'SAO BERNARDO DO CAMPO|SP': [[8, 20, 'Aniversário de São Bernardo do Campo']], 'SANTO ANDRE|SP': [[4, 8, 'Aniversário de Santo André']],
  'SOROCABA|SP': [[8, 15, 'Aniversário de Sorocaba']], 'SAO JOSE DOS CAMPOS|SP': [[7, 27, 'Aniversário de São José dos Campos']], 'JUNDIAI|SP': [[12, 15, 'Aniversário de Jundiaí']],
  'OSASCO|SP': [[2, 19, 'Aniversário de Osasco']], 'RIBEIRAO PRETO|SP': [[6, 19, 'Aniversário de Ribeirão Preto']], 'RIO DE JANEIRO|RJ': [[1, 20, 'São Sebastião']],
  'BELO HORIZONTE|MG': [[8, 15, 'Assunção de Nossa Senhora']], 'CURITIBA|PR': [[3, 29, 'Aniversário de Curitiba']], 'PORTO ALEGRE|RS': [[2, 2, 'Nossa Senhora dos Navegantes']] };
const UFS = new Set(Object.keys({ ...ESTADUAIS, MG: 1, GO: 1, ES: 1, MT: 1, AC: 1, AP: 1, RO: 1, RR: 1 }));

// → Map data → [{nome, nivel, facultativo}] para a cidade/UF no ano. `custom`: [{data|'MM-DD', cidade, uf, nome}] (cidade vazia = todas).
function feriados({ cidade, uf, ano, custom = [] }) {
  const m = new Map(), add = (data, nome, nivel, fac) => { if (!m.has(data)) m.set(data, []); if (!m.get(data).some(x => x.nome === nome)) m.get(data).push({ nome, nivel, facultativo: !!fac }); };
  for (const f of nacionais(ano)) add(f.data, f.nome, f.nivel, f.facultativo);
  const U = String(uf || '').toUpperCase().slice(0, 2), C = norm(cidade);
  for (const [mm, dd, nome] of ESTADUAIS[U] || []) add(iso(ano, mm, dd), nome, 'estadual');
  for (const [mm, dd, nome] of MUNICIPAIS[`${C}|${U}`] || []) add(iso(ano, mm, dd), nome, 'municipal');
  for (const c of custom) {
    if (c.cidade && norm(c.cidade) !== C) continue; if (c.uf && String(c.uf).toUpperCase() !== U) continue;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(c.data) ? c.data : /^\d{2}-\d{2}$/.test(c.data) ? `${ano}-${c.data}` : ''; if (d && d.startsWith(String(ano))) add(d, c.nome, c.cidade ? 'municipal' : 'estadual');
  }
  return m;
}
const ehUtil = (data, f) => { const dow = new Date(data + 'T00:00:00Z').getUTCDay(); if (dow === 0 || dow === 6) return false; return !(f.get(data) || []).some(x => !x.facultativo); };
// Próximo dia útil livre (sem feriado de verdade) a partir do dia seguinte, no máximo `lim` dias à frente.
function proximoUtil(data, f, lim = 7) { let d = data; for (let i = 0; i < lim; i++) { d = somaDias(d, 1); if (ehUtil(d, f)) return d; } return ''; }
module.exports = { feriados, nacionais, pascoa, norm, somaDias, ehUtil, proximoUtil, UFS, MUNICIPAIS };
