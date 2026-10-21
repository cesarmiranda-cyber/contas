'use strict';
// Regras de negócio puras (sem I/O): intervalos, datas, antecipada, limite de mês e etapa.
const SEGMENTOS = ['Motores', 'Peças', 'Serviços', 'Novos Negócios'];
const CARGOS = ['Vendedor', 'Supervisor', 'Coordenador', 'Gerente', 'Diretor'];
const CLASSES = ['A', 'B', 'C'];

// Dias entre visitas por cargo e classe (tabela da Odin). Configurável na tela de configurações.
const INTERVALOS = {
  Vendedor: { A: 30, B: 60, C: 90 },
  Supervisor: { A: 60, B: 90, C: 120 },
  Coordenador: { A: 90, B: 120, C: 150 },
  Gerente: { A: 120, B: 150, C: 180 },
  Diretor: { A: 150, B: 180, C: 210 },
};

const DEFAULT_CONFIG = {
  intervalos: INTERVALOS,
  horaJob: 7,
  tarefaAtiva: false,          // tarefa "Realizar Visita" é opcional
  tarefaHorasUteis: 8,
  baseSemUltimaVisita: 'hoje', // sem Última Visita: ciclo parte de hoje
  atualizarProxima: true,      // grava "Próxima Visita" do segmento na empresa
  motoresDatas: 'secao',       // 'secao' | 'extra' (campos duplicados em Motores: a confirmar)
  admins: [],                  // ids que podem corrigir registros de visita
  mapaManual: {},              // sobrescritas do mapeamento de campos
  sweepSegundos: 60,
};

const pad = n => String(n).padStart(2, '0');
const isoDate = s => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);
function todayBR(now = new Date()) { return now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function hourBR(now = new Date()) { return +now.toLocaleString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }) % 24; }
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
const sameMonth = (a, b) => !!a && !!b && a.slice(0, 7) === b.slice(0, 7);
const fmtBR = iso => (iso ? iso.split('-').reverse().join('/') : '');

function intervalo(cfg, cargo, classe) {
  const n = ((cfg && cfg.intervalos) || INTERVALOS)[cargo]?.[classe];
  return Number.isFinite(+n) ? +n : null;
}
// Última visita + intervalo do cargo/classe. Sem classe válida não há data.
function dataProgramada(cfg, { cargo, classe, ultima, hoje }) {
  const n = intervalo(cfg, cargo, classe);
  if (n === null) return null;
  return addDays(isoDate(ultima) || hoje, n);
}
// Visita é antecipada quando ocorre antes da data programada.
const antecipada = (visitaIso, programadaIso) => !!programadaIso && visitaIso < programadaIso;

// Etapa desejada de um card aberto: vencido -> atrasada, hoje -> dia, futuro -> aguardando.
function etapaPara(dataIso, hoje) {
  if (!dataIso) return 'aguardando';
  if (dataIso < hoje) return 'atrasada';
  if (dataIso === hoje) return 'dia';
  return 'aguardando';
}

// Reprogramação: motivo obrigatório, data válida, mesmo mês da data programada original.
function validarReprogramacao({ atual, nova, motivo }) {
  if (!isoDate(nova)) return 'Informe a nova data.';
  if (String(motivo || '').trim().length < 3) return 'O motivo da reprogramação é obrigatório.';
  if (!sameMonth(atual, nova)) {
    const [y, m] = atual.split('-');
    return `A nova data precisa ficar no mesmo mês da data programada (${m}/${y}). Escolha um dia de ${m}/${y}.`;
  }
  if (nova === atual) return 'A nova data é igual à data atual.';
  return null;
}

// Prazo em horas úteis (seg-sex, 09h-18h, fuso de Brasília). Devolve ISO com -03:00.
function prazoUtil(now, horas) {
  const BR = -3 * 3600e3;
  let t = new Date(now.getTime() + BR); // "relógio de parede" em UTC
  let restante = horas * 60;
  while (restante > 0) {
    const dow = t.getUTCDay(), h = t.getUTCHours() + t.getUTCMinutes() / 60;
    if (dow === 0 || dow === 6 || h >= 18) { t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, 9, 0)); continue; }
    if (h < 9) { t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 9, 0)); continue; }
    const livre = Math.round((18 - h) * 60), usa = Math.min(livre, restante);
    t = new Date(t.getTime() + usa * 60e3); restante -= usa;
  }
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00-03:00`;
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const chaveFila = (empresaId, seg, cargo) => `${empresaId}|${norm(seg)}|${norm(cargo)}`;

module.exports = {
  SEGMENTOS, CARGOS, CLASSES, INTERVALOS, DEFAULT_CONFIG, todayBR, hourBR, addDays, dayDiff, sameMonth, fmtBR, isoDate,
  intervalo, dataProgramada, antecipada, etapaPara, validarReprogramacao, prazoUtil, norm, chaveFila,
};
