'use strict';
// Regras de cronograma (puras e testáveis): datas em AAAA-MM-DD, dependências FS (termina→começa) e SS (começa junto).
const DAY = 86400000;
const toMs = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const toStr = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => toStr(toMs(s) + n * DAY);
const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY); // b - a
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toStr(toMs(s)) === s;
const hojeSP = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);

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

// Empurra tarefas para frente quando a dependência exige (mantém a duração). Retorna ids alterados.
function reagendar(tarefas) {
  const byId = new Map(tarefas.map(t => [t.id, t]));
  const mudou = [];
  for (const t of ordenar(tarefas)) {
    let min = null;
    for (const d of t.deps || []) {
      const p = byId.get(d.de); if (!p) continue;
      const lag = +d.lag || 0;
      const c = d.tipo === 'SS' ? addDays(p.inicio, lag) : addDays(p.fim, 1 + lag);
      if (min === null || c > min) min = c;
    }
    if (min && t.inicio < min) {
      const dur = diffDays(t.inicio, t.fim);
      t.inicio = min; t.fim = addDays(min, dur); mudou.push(t.id);
    }
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

module.exports = { isDate, addDays, diffDays, hojeSP, ordenar, reagendar, status, resumo };
