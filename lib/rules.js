'use strict';
// Regras de negócio puras (sem I/O) — cobertas por test/rules.test.js.

const CATEGORY_ID = 90;
const STAGES = {
  open: 'C90:NEW',                 // Em Aberto
  soon: 'C90:PREPAYMENT_INVOIC',   // Próximo do Vencimento
  late: 'C90:PREPARATION',         // Atrasado
  paid: 'C90:WON',                 // Pago
  cancelled: 'C90:LOSE',           // Cancelado
};
const STAGE_LABEL = {
  [STAGES.open]: 'Em aberto', [STAGES.soon]: 'Próximo do vencimento', [STAGES.late]: 'Atrasado',
  [STAGES.paid]: 'Pago', [STAGES.cancelled]: 'Cancelado',
};
const FINAL_STAGES = new Set([STAGES.paid, STAGES.cancelled]);

const DEFAULT_CONFIG = {
  autoCreate: true,        // cria a cobrança no Asaas para deals sem cobrança
  reguaAtiva: false,       // só dispara lembretes ao cliente quando ligada
  reguaOffsets: [-3, 0, 1, 5, 15], // dias em relação ao vencimento
  diasProximo: 3,          // dias antes do vencimento para a etapa "Próximo do vencimento"
  multaPct: 2,             // multa por atraso (%)
  jurosMensalPct: 1,       // juros ao mês (%)
  alertaAtrasoDias: 30,    // atraso que vira alerta crítico
};

// ---- datas (AAAA-MM-DD, fuso de São Paulo) ----
function todayBR(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function toDay(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function dayDiff(a, b) { // a - b em dias
  const pa = Date.UTC(...a.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  const pb = Date.UTC(...b.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  return Math.round((pa - pb) / 86400000);
}
function addMonths(day, n) { // mantém o dia, ajustando para o fim do mês quando preciso
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

// ---- documentos ----
const digits = s => String(s || '').replace(/\D/g, '');
function validCPF(s) {
  const c = digits(s);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const t of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += +c[i] * (t + 1 - i);
    if (((sum * 10) % 11) % 10 !== +c[t]) return false;
  }
  return true;
}
function validCNPJ(s) {
  const c = digits(s);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  for (const t of [12, 13]) {
    let sum = 0, w = t - 7;
    for (let i = 0; i < t; i++) { sum += +c[i] * w--; if (w < 2) w = 9; }
    if (((sum % 11) < 2 ? 0 : 11 - (sum % 11)) !== +c[t]) return false;
  }
  return true;
}
const validDoc = s => validCPF(s) || validCNPJ(s);

// Procura um CPF/CNPJ válido em um objeto (campos UF_* e RQ_*) — prioriza chaves com nome de documento.
function findDoc(obj, preferred = []) {
  if (!obj) return '';
  for (const k of preferred) if (validDoc(obj[k])) return digits(obj[k]);
  for (const [k, v] of Object.entries(obj)) {
    if ((k.startsWith('UF_') || k.startsWith('RQ_')) && typeof v === 'string' && validDoc(v)) return digits(v);
  }
  return '';
}

// ---- Asaas -> situação ----
function mapAsaasStatus(status) {
  switch (status) {
    case 'RECEIVED': case 'CONFIRMED': case 'RECEIVED_IN_CASH': case 'DUNNING_RECEIVED': return 'paid';
    case 'OVERDUE': case 'DUNNING_REQUESTED': return 'overdue';
    case 'DELETED': case 'REFUNDED': case 'REFUND_REQUESTED': case 'REFUND_IN_PROGRESS':
    case 'CHARGEBACK_REQUESTED': case 'CHARGEBACK_DISPUTE': case 'AWAITING_CHARGEBACK_REVERSAL': return 'cancelled';
    default: return 'open'; // PENDING, AWAITING_RISK_ANALYSIS...
  }
}
function stageFor(state, due, today, diasProximo = 3) {
  if (state === 'paid') return STAGES.paid;
  if (state === 'cancelled') return STAGES.cancelled;
  if (state === 'overdue') return STAGES.late;
  if (!due) return STAGES.open;
  const d = dayDiff(due, today);
  if (d < 0) return STAGES.late;
  if (d <= diasProximo) return STAGES.soon;
  return STAGES.open;
}

// ---- régua de cobrança ----
// Retorna o offset a disparar agora (ou null). Só considera o offset mais recente já alcançado,
// com tolerância de 2 dias (evita "rajada" de lembretes antigos no primeiro sync).
function reminderDue(due, today, offsets, alreadySent = []) {
  if (!due) return null;
  const diff = dayDiff(today, due); // >0 = dias de atraso; <0 = faltam dias
  const reached = offsets.filter(o => o <= diff).sort((a, b) => b - a);
  const latest = reached[0];
  if (latest === undefined || diff - latest > 2) return null;
  return alreadySent.includes(latest) ? null : latest;
}
const offsetLabel = o => (o === 0 ? 'D0' : o < 0 ? `D${o}` : `D+${o}`);

// ---- parcelas ----
function splitInstallments(totalCents, n) {
  const base = Math.floor(totalCents / n);
  const arr = Array(n).fill(base);
  arr[n - 1] += totalCents - base * n; // sobra de centavos na última
  return arr;
}
function buildSchedule({ total, parcelas = 1, primeiroVenc, tipo = 'PARCELADO', mensal = 0 }) {
  const cents = Math.round(Number(total) * 100);
  if (!(cents > 0)) throw new Error('Valor inválido');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(primeiroVenc || '')) throw new Error('Vencimento inválido');
  if (tipo === 'RECORRENTE') {
    const n = Math.max(1, Math.min(60, Number(mensal) || 12));
    return Array.from({ length: n }, (_, i) => ({ n: i + 1, of: n, value: cents / 100, due: addMonths(primeiroVenc, i) }));
  }
  const n = tipo === 'UNICA' ? 1 : Math.max(1, Math.min(60, Number(parcelas) || 1));
  return splitInstallments(cents, n).map((c, i) => ({ n: i + 1, of: n, value: c / 100, due: addMonths(primeiroVenc, i) }));
}

// ---- pendências (o que "escapa" da cobrança) ----
function issuesFor(c, cfg, today, asaasOn) {
  const out = [];
  if (FINAL_STAGES.has(c.stageId)) return out;
  if (!c.cliente) out.push({ sev: 'alta', msg: 'Sem cliente (empresa/contato) na deal' });
  if (!(c.valor > 0)) out.push({ sev: 'alta', msg: 'Valor zerado' });
  if (!c.venc) out.push({ sev: 'alta', msg: 'Sem data de vencimento' });
  if (!c.doc) out.push({ sev: 'alta', msg: 'Sem CPF/CNPJ válido (exigido pelo Asaas)' });
  if (!c.email && !c.telefone) out.push({ sev: 'media', msg: 'Cliente sem e-mail nem telefone — não receberá lembrete' });
  if (asaasOn && !c.asaasId) out.push({ sev: 'alta', msg: 'Cobrança ainda não emitida no Asaas' });
  if (c.asaasId && c.valorAsaas != null && Math.abs(c.valorAsaas - c.valor) > 0.009) {
    out.push({ sev: 'media', msg: `Valor da deal (${c.valor}) difere do Asaas (${c.valorAsaas})` });
  }
  if (c.venc) {
    const atraso = dayDiff(today, c.venc);
    if (atraso >= cfg.alertaAtrasoDias) out.push({ sev: 'alta', msg: `${atraso} dias de atraso` });
    else if (atraso > 0 && c.stageId !== STAGES.late) out.push({ sev: 'media', msg: 'Vencida, mas fora da etapa Atrasado' });
  }
  return out;
}

module.exports = {
  CATEGORY_ID, STAGES, STAGE_LABEL, FINAL_STAGES, DEFAULT_CONFIG,
  todayBR, toDay, dayDiff, addMonths, validCPF, validCNPJ, validDoc, findDoc, digits,
  mapAsaasStatus, stageFor, reminderDue, offsetLabel, splitInstallments, buildSchedule, issuesFor,
};
