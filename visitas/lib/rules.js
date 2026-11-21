'use strict';
// Regras puras (sem I/O). Todas as datas são "AAAA-MM-DD" no fuso de Brasília.
const TZ = 'America/Sao_Paulo';
const CLASSES = ['A', 'B', 'C', 'E'];
const CARGOS = ['Diretor', 'Gerente', 'Coordenador', 'Supervisor', 'Vendedor'];
const FERIADOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
const MOTIVOS = ['Cliente não estava disponível', 'Cliente pediu para remarcar', 'Vendedor ausente (férias/atestado)', 'Sem veículo / deslocamento inviável',
  'Cliente inativo ou fechado', 'Prioridade em outro cliente', 'Agenda cheia no mês', 'Outro motivo'];

const DEFAULT_CONFIG = {
  intervalos: { A: 30, B: 60, C: 90, E: 6 },        // dias (A/B/C) ou meses (E)
  periodos: { A: 30, B: 60, C: 90 },                // janela (dias úteis) para distribuir a primeira visita
  mesClasseE: 3,
  horaJob: 7, sweepSegundos: 30,
  tarefaAtiva: false, atualizarProxima: true, removerSemClasse: true,
  cargosFila: ['Vendedor'],
  supervisoresDepts: [], supervisoresExtras: [],
  motivosNaoRealizada: MOTIVOS,
  verTudo: [],                 // usuários que veem tudo
  admins: [],                  // acesso às configurações (vazio = administradores do portal)
  deptsAcesso: [],
  mapa: { fila: {} },          // ajuste manual de campos da Fila (quando o rótulo difere do esperado)             // departamentos com acesso ao app (vazio = todos do portal); inclui subdepartamentos
  podeExcluir: [],             // usuários autorizados a excluir
  visibilidade: 'app',         // app | bitrix
  hierarquiaAuto: false, ativo: false,
};

const norm = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const pad = n => String(n).padStart(2, '0');
function todayBR(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p;  // en-CA => AAAA-MM-DD
}
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = dt => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number), t = (m - 1) + n, ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}
const dayDiff = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
const dow = s => toDate(s).getUTCDay();
const isBusinessDay = s => dow(s) !== 0 && dow(s) !== 6 && !FERIADOS.includes(s.slice(5));
function nextBusinessDay(s) { while (!isBusinessDay(s)) s = addDays(s, 1); return s; }
function addBusinessDays(s, n) { s = nextBusinessDay(s); while (n > 0) { s = nextBusinessDay(addDays(s, 1)); n--; } return s; }
const nextMonday = s => { let d = addDays(s, 1); while (dow(d) !== 1) d = addDays(d, 1); return d; };
const monthOf = s => s.slice(0, 7);
const monthEnd = s => fmt(new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)));

// Lê a classe pelo NOME (nunca pela primeira letra: "Clientes Estratégicos" = E).
function classeLetra(nome) {
  const t = norm(nome);
  if (!t) return '';
  if (/estrateg/.test(t) || t === 'e' || /^classe e\b/.test(t)) return 'E';
  const m = t.match(/^(?:classe\s+)?([abc])$/);
  return m ? m[1].toUpperCase() : '';
}
const classeNome = l => (l === 'E' ? 'Clientes Estratégicos' : l || '');

// Próxima visita depois de uma visita feita em `dataVisita`.
function proximaVisita(classe, dataVisita, cfg = DEFAULT_CONFIG) {
  const iv = cfg.intervalos || DEFAULT_CONFIG.intervalos;
  if (classe === 'E') return nextBusinessDay(addMonths(dataVisita, iv.E || 6));
  return nextBusinessDay(addDays(dataVisita, iv[classe] || 30));
}
// Primeira visita: distribui `indice` de `total` empresas da mesma classe pelo período (dias úteis).
function primeiraVisita(classe, indice, total, hoje, cfg = DEFAULT_CONFIG) {
  if (classe === 'E') {
    const mes = cfg.mesClasseE || 3;
    let ano = +hoje.slice(0, 4);
    if (+hoje.slice(5, 7) > mes) ano++;
    const ini = `${ano}-${pad(mes)}-01`, fim = monthEnd(ini);
    const dias = []; for (let d = nextBusinessDay(ini); d <= fim; d = nextBusinessDay(addDays(d, 1))) dias.push(d);
    if (+hoje.slice(5, 7) === mes && +hoje.slice(0, 4) === ano) { const f = dias.filter(d => d >= hoje); if (f.length) return f[Math.floor(indice * f.length / Math.max(total, 1))]; }
    return dias[Math.floor(indice * dias.length / Math.max(total, 1))] || dias[0];
  }
  const per = (cfg.periodos || DEFAULT_CONFIG.periodos)[classe] || 30;
  return addBusinessDays(nextMonday(hoje), Math.floor(indice * per / Math.max(total, 1)));
}
// Etapa conforme a data programada. mês vencido => NAOREAL.
function etapaPorData(data, hoje) {
  if (data === hoje) return 'PREPARATION';
  if (data > hoje) return 'NEW';
  return monthOf(data) < monthOf(hoje) ? 'NAOREAL' : 'LATE';
}
const chaveCard = (empresa, segmento, cargo) => `${empresa}|${norm(segmento)}|${norm(cargo)}`;

module.exports = { TZ, CLASSES, CARGOS, FERIADOS, MOTIVOS, DEFAULT_CONFIG, norm, todayBR, addDays, addMonths, dayDiff, isBusinessDay, nextBusinessDay, addBusinessDays,
  nextMonday, monthOf, monthEnd, classeLetra, classeNome, proximaVisita, primeiraVisita, etapaPorData, chaveCard };
