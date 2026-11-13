'use strict';
// Regras de cronograma (puras e testáveis): datas em AAAA-MM-DD, dependências FS (termina→começa) e SS (começa junto).
const DAY = 86400000;
const toMs = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const toStr = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => toStr(toMs(s) + n * DAY);
const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY); // b - a
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toStr(toMs(s)) === s;
const hojeSP = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);

// Feriados nacionais do Brasil (fixos + Sexta-feira Santa). Carnaval e Corpus Christi são pontos facultativos: entram como feriados extras do projeto.
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1; return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}
const feriadosBR = ano => [`${ano}-01-01`, addDays(pascoa(ano), -2), `${ano}-04-21`, `${ano}-05-01`, `${ano}-09-07`, `${ano}-10-12`, `${ano}-11-02`, `${ano}-11-15`, `${ano}-11-20`, `${ano}-12-25`];
// Calendário do projeto. Desligado = dias corridos (comportamento original). Ligado = só segunda a sexta, sem feriados.
function calendario(opts = {}) {
  const ativo = !!opts.diasUteis, extras = new Set(opts.extras || []), cache = new Map();
  const feriado = s => { const a = +s.slice(0, 4); if (!cache.has(a)) cache.set(a, new Set(feriadosBR(a))); return cache.get(a).has(s) || extras.has(s); };
  const dow = s => new Date(toMs(s)).getUTCDay();
  const util = s => !ativo || (dow(s) !== 0 && dow(s) !== 6 && !feriado(s));
  const proximoUtil = s => { while (!util(s)) s = addDays(s, 1); return s; };
  const anteriorUtil = s => { while (!util(s)) s = addDays(s, -1); return s; };
  const somaUteis = (s, n) => { if (!ativo) return addDays(s, n); let d = n >= 0 ? proximoUtil(s) : anteriorUtil(s), k = Math.abs(n); const passo = n >= 0 ? 1 : -1; while (k > 0) { d = addDays(d, passo); if (util(d)) k--; } return d; };
  const diffUteis = (a, b) => { if (!ativo) return diffDays(a, b); if (b === a) return 0; const [x, y, sinal] = b > a ? [a, b, 1] : [b, a, -1]; let n = 0; for (let d = addDays(x, 1); d <= y; d = addDays(d, 1)) if (util(d)) n++; return sinal * n; };
  const feriadosEntre = (a, b) => { const out = []; if (!ativo) return out; for (let d = a; d <= b; d = addDays(d, 1)) if (feriado(d)) out.push(d); return out; };
  return { ativo, util, feriado, proximoUtil, anteriorUtil, somaUteis, diffUteis, feriadosEntre };
}
const CAL_CORRIDOS = calendario();
// Início mínimo que a dependência permite (FS: depois do fim da anterior + defasagem; SS: junto com o início da anterior + defasagem).
const minimoDep = (p, tipo, lag, cal = CAL_CORRIDOS) => tipo === 'SS' ? cal.somaUteis(p.inicio, +lag || 0) : cal.somaUteis(p.fim, 1 + (+lag || 0));
const baseDep = (p, tipo, cal = CAL_CORRIDOS) => tipo === 'SS' ? cal.somaUteis(p.inicio, 0) : cal.somaUteis(p.fim, 1); // início sem defasagem
// Em dias úteis, início e término caem em dias úteis. Retorna os ids alterados.
function normalizar(tarefas, cal) {
  const mudou = []; if (!cal.ativo) return mudou;
  for (const t of tarefas) { const i = cal.proximoUtil(t.inicio); let f = cal.anteriorUtil(t.fim); if (f < i) f = i; if (i !== t.inicio || f !== t.fim) { t.inicio = i; t.fim = f; mudou.push(t.id); } }
  return mudou;
}

// Ordem topológica; lança erro se houver ciclo.
function ordenar(tarefas) {
  const byId = new Map(tarefas.map(t => [t.id, t]));
  const state = new Map(); const out = [];
  const visit = (t, trilha) => {
    if (state.get(t.id) === 2) return;
    if (state.get(t.id) === 1) { const e = new Error('Dependência circular entre tarefas.'); e.status = 400; throw e; }
    state.set(t.id, 1);
    for (const d of t.deps || []) { const p = byId.get(d.de); if (p) visit(p, trilha); }
    state.set(t.id, 2); out.push(t);
  };
  tarefas.forEach(t => visit(t, []));
  return out;
}

// Empurra tarefas para frente quando a dependência exige (mantém a duração, em dias úteis se o calendário for de dias úteis). Retorna ids alterados.
function reagendar(tarefas, cal = CAL_CORRIDOS) {
  const byId = new Map(tarefas.map(t => [t.id, t])); const mudou = [];
  for (const t of ordenar(tarefas)) {
    let min = null;
    for (const d of t.deps || []) { const p = byId.get(d.de); if (!p) continue; const c = minimoDep(p, d.tipo, d.lag, cal); if (min === null || c > min) min = c; }
    if (min && t.inicio < min) { const dur = cal.diffUteis(t.inicio, t.fim); t.inicio = min; t.fim = cal.somaUteis(min, dur); mudou.push(t.id); }
  }
  return mudou;
}

// Status (cor) para o cliente: verde = no prazo, amarelo = alerta, vermelho = atrasado.
function status(t, tarefas, hoje) {
  const p = +t.progresso || 0;
  if (p >= 100) return { cor: 'verde', codigo: 'concluida', rotulo: 'Concluída' };
  if (t.fim < hoje) return { cor: 'vermelho', codigo: 'atrasada', rotulo: `Atrasada ${diffDays(t.fim, hoje)} dia(s)` };
  if (t.inicio <= hoje) {
    const dur = diffDays(t.inicio, t.fim) + 1, passou = diffDays(t.inicio, hoje); // dias completos já decorridos (o dia de hoje ainda está em curso)
    const esperado = Math.min(100, (passou / dur) * 100);
    if (p < esperado - 25) return { cor: 'amarelo', codigo: 'alerta', rotulo: 'Em alerta: abaixo do ritmo esperado' };
    if (dur >= 3 && diffDays(hoje, t.fim) <= 2 && p < 80) return { cor: 'amarelo', codigo: 'alerta', rotulo: 'Em alerta: prazo próximo' };
    return { cor: 'verde', codigo: 'no_prazo', rotulo: p > 0 ? 'Em andamento, no prazo' : 'No prazo' };
  }
  const byId = new Map(tarefas.map(x => [x.id, x]));
  for (const d of t.deps || []) {
    const q = byId.get(d.de);
    if (q && (+q.progresso || 0) < 100 && q.fim < hoje) return { cor: 'amarelo', codigo: 'alerta', rotulo: 'Em alerta: depende de tarefa atrasada' };
  }
  return { cor: 'verde', codigo: 'no_prazo', rotulo: 'Ainda não iniciada, no prazo' };
}

// Status geral do projeto a partir das tarefas.
function resumo(tarefas, hoje) {
  const r = { total: tarefas.length, verde: 0, amarelo: 0, vermelho: 0, concluidas: 0, progresso: 0, inicio: null, fim: null, cor: 'verde' };
  let soma = 0, dias = 0;
  for (const t of tarefas) {
    const s = status(t, tarefas, hoje);
    r[s.cor]++; if (s.codigo === 'concluida') r.concluidas++;
    const d = diffDays(t.inicio, t.fim) + 1; soma += (Math.min(100, +t.progresso || 0)) * d; dias += d;
    if (!r.inicio || t.inicio < r.inicio) r.inicio = t.inicio;
    if (!r.fim || t.fim > r.fim) r.fim = t.fim;
  }
  r.progresso = dias ? Math.round(soma / dias) : 0;
  r.cor = r.vermelho ? 'vermelho' : r.amarelo ? 'amarelo' : 'verde';
  return r;
}

module.exports = { isDate, addDays, diffDays, hojeSP, ordenar, reagendar, status, resumo, calendario, feriadosBR, minimoDep, baseDep, normalizar, CAL_CORRIDOS };
