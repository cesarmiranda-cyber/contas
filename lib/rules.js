'use strict';
// Regras de negócio puras (sem I/O) — cobertas por test/rules.test.js.

const CATEGORY_ID = 90;
const STAGES = {
  gerar: 'C90:GERAR',              // Gerar cobranças (card do contrato, gatilho)
  contrato: 'C90:CONTRATADO',      // Contratado (card do contrato já expandido; fora dos totais)
  open: 'C90:NEW',                 // Em Aberto
  soon: 'C90:PREPAYMENT_INVOIC',   // Próximo do Vencimento
  late: 'C90:PREPARATION',         // Atrasado
  paid: 'C90:WON',                 // Pago
  cancelled: 'C90:LOSE',           // Cancelado
};
const STAGE_LABEL = {
  [STAGES.gerar]: 'Gerar cobranças', [STAGES.contrato]: 'Contratado',
  [STAGES.open]: 'Em aberto', [STAGES.soon]: 'Próximo do vencimento', [STAGES.late]: 'Atrasado',
  [STAGES.paid]: 'Pago', [STAGES.cancelled]: 'Cancelado',
};
// Classificação dos títulos (valores iniciais dos campos de lista criados no Bitrix; editáveis lá).
const CATEGORIAS = ['Licença Bitrix24', 'Serviço / Projeto', 'Aplicativo', 'Linha / WhatsApp', 'Outros'];
const CATEGORIA_LICENCA = 'Licença Bitrix24';
const PLANOS = ['Basic', 'Basic Vibe+', 'Standard', 'Standard Vibe+', 'Professional', 'Professional Vibe+', 'Enterprise', 'Enterprise Vibe+'];
const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// Sugere categoria/plano pelo título só quando o texto cita o plano explicitamente (nunca chuta no escuro).
function guessClass(titulo) {
  const t = norm(titulo);
  const base = ['enterprise', 'professional', 'standard', 'basic'].find(b => t.includes(b));
  if (!base) return { categoria: '', plano: '' };
  const vibe = /vibe\s*\+?|vibecode/.test(t);
  const plano = PLANOS.find(x => norm(x) === `${base}${vibe ? ' vibe+' : ''}`) || '';
  return { categoria: plano ? CATEGORIA_LICENCA : '', plano };
}

const FINAL_STAGES = new Set([STAGES.paid, STAGES.cancelled]);
const CONTRACT_STAGES = new Set([STAGES.gerar, STAGES.contrato]);

// Listas dos campos "Tipo" e "Forma de pagamento": código interno <-> rótulo no Bitrix.
const TIPOS = [{ code: 'UNICA', label: 'À vista' }, { code: 'PARCELADO', label: 'Parcelado' }, { code: 'RECORRENTE', label: 'Recorrente mensal' }];
const FORMAS = [{ code: 'UNDEFINED', label: 'Cliente escolhe' }, { code: 'BOLETO', label: 'Boleto' }, { code: 'PIX', label: 'Pix' }, { code: 'CREDIT_CARD', label: 'Cartão' }];

const DEFAULT_CONFIG = {
  autoCreate: true,        // cria a cobrança no Asaas para deals sem cobrança
  reguaAtiva: false,       // só dispara lembretes ao cliente quando ligada
  reguaOffsets: [-3, 0, 1, 5, 15], // dias em relação ao vencimento
  empresaNome: 'Manda4',   // aparece nos e-mails enviados a parceiros
  importAuto: false,       // traz para o Bitrix cobranças criadas direto no Asaas
  importDias: 90,          // janela da importação (dias para trás)
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

// ---- split de pagamento ----
// Texto compacto guardado na deal: "Parceiro A=30%; Parceiro B=R$ 50,00" (nome da carteira cadastrada ou o próprio walletId).
// "1.234,56" (pt-BR), "1234,5", "50.00" e "12.5" (ponto decimal). Ponto só é milhar quando há vírgula ou grupos de 3 dígitos.
const BR_NUM = s => {
  const t = String(s).trim();
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ''));
  return Number(t);
};
function parseSplit(text, wallets = []) {
  const out = [];
  for (const raw of String(text || '').split(/[;\n]/).map(x => x.trim()).filter(Boolean)) {
    const m = raw.match(/^(.+?)\s*=\s*(?:R\$\s*)?([\d.,]+)\s*(%)?$/i);
    if (!m) throw new Error(`Split inválido: "${raw}". Use "Nome=30%" ou "Nome=R$ 50,00".`);
    const nome = m[1].trim(), n = BR_NUM(m[2]), pct = !!m[3];
    const w = wallets.find(x => norm(x.nome) === norm(nome) || x.walletId === nome);
    if (!w) throw new Error(`Recebedor do split não cadastrado: "${nome}". Cadastre em Configurações → Split.`);
    if (!(n > 0)) throw new Error(`Valor inválido no split de "${nome}".`);
    out.push(pct ? { walletId: w.walletId, percentualValue: n } : { walletId: w.walletId, fixedValue: n });
  }
  return validateSplit(out);
}
function validateSplit(list) {
  const pct = list.reduce((a, s) => a + (s.percentualValue || 0), 0);
  if (pct > 100) throw new Error(`O split soma ${pct}% (máximo 100%).`);
  const ids = list.map(s => s.walletId);
  if (new Set(ids).size !== ids.length) throw new Error('O mesmo recebedor aparece mais de uma vez no split.');
  return list;
}
function splitToText(list, wallets = []) {
  return (list || []).map(s => {
    const w = wallets.find(x => x.walletId === s.walletId);
    const nome = w ? w.nome : s.walletId;
    return s.percentualValue ? `${nome}=${s.percentualValue}%` : `${nome}=R$ ${Number(s.fixedValue).toFixed(2).replace('.', ',')}`;
  }).join('; ');
}

// ---- repasses a parceiros (contas a pagar ligadas ao contas a receber) ----
// Lê o campo "CR · Split" ("Parceiro A=30%; Parceiro B=R$ 50,00") contra o cadastro de parceiros e a lista de carteiras (legado).
// Cada item vira { nome, partner|null, walletId|'' , percentualValue | fixedValue }. Parceiro com walletId = split nativo do Asaas;
// parceiro sem walletId = repasse manual (título a pagar). Nome que não existe em lugar nenhum é erro (nunca ignora em silêncio).
function parseRepasses(text, { partners = [], wallets = [] } = {}) {
  const out = [];
  for (const raw of String(text || '').split(/[;\n]/).map(x => x.trim()).filter(Boolean)) {
    const m = raw.match(/^(.+?)\s*=\s*(-)?\s*(?:R\$\s*)?([\d.,]+)\s*(%)?$/i);
    if (!m) throw new Error(`Split inválido: "${raw}". Use "Nome=30%", "Nome=R$ 50,00" ou, para custo de fornecedor, "Nome=-20%" (Manda4 retém 20%).`);
    const nome = m[1].trim(), n = BR_NUM(m[3]), pct = !!m[4], retem = !!m[2];
    if (!(n > 0)) throw new Error(`Valor inválido no split de "${nome}".`);
    if (retem && pct && n >= 100) throw new Error(`"${nome}": a retenção da Manda4 deve ser menor que 100%.`);
    const partner = partners.find(p => !p.inativo && norm(p.nome) === norm(nome)) || null;
    const wallet = partner ? null : wallets.find(w => norm(w.nome) === norm(nome) || w.walletId === nome) || null;
    if (!partner && !wallet) throw new Error(`Recebedor do split não cadastrado: "${nome}". Cadastre em Parceiros.`);
    const walletId = partner ? (partner.wallet || '') : wallet.walletId;
    out.push({ nome: partner ? partner.nome : wallet.nome, partner, walletId, ...(retem ? { retem: true } : {}), ...(pct ? { percentualValue: n } : { fixedValue: n }) });
  }
  const pctTotal = out.reduce((a, s) => a + (s.percentualValue ? (s.retem ? 100 - s.percentualValue : s.percentualValue) : 0), 0);
  if (pctTotal > 100) throw new Error(`O split soma ${pctTotal}% (máximo 100%).`);
  const keys = out.map(s => (s.partner ? 'p' + s.partner.id : 'w' + s.walletId));
  if (new Set(keys).size !== keys.length) throw new Error('O mesmo recebedor aparece mais de uma vez no split.');
  return out;
}
// Parte do split que o Asaas executa sozinho (só quem tem walletId).
// Com "retém" (custo de fornecedor), o recebedor fica com o valor MENOS a retenção da Manda4: % → 100−%, fixo → valor−fixo (precisa do valor da cobrança).
const nativeSplit = (entries, valor) => entries.filter(e => e.walletId).map(e => (e.retem
  ? (e.percentualValue ? { walletId: e.walletId, percentualValue: Math.round((100 - e.percentualValue) * 100) / 100 } : { walletId: e.walletId, fixedValue: Math.max(0.01, Math.round((Number(valor) - e.fixedValue) * 100) / 100) })
  : { walletId: e.walletId, ...(e.percentualValue ? { percentualValue: e.percentualValue } : { fixedValue: e.fixedValue }) }));
// Valor do repasse sobre uma base (arredonda em centavos). Fixo nunca passa da base.
function repasseValor(entry, base) {
  const ret = entry.percentualValue ? (base * entry.percentualValue) / 100 : entry.fixedValue;
  const v = entry.retem ? base - ret : ret;
  return Math.max(0, Math.min(Math.round(v * 100) / 100, Math.round(base * 100) / 100));
}
const repasseRegra = (entry, baseNome) => (entry.retem
  ? (entry.percentualValue ? `Manda4 retém ${entry.percentualValue}% do ${baseNome}` : `Manda4 retém R$ ${entry.fixedValue.toFixed(2).replace('.', ',')}`)
  : (entry.percentualValue ? `${entry.percentualValue}% do ${baseNome}` : `R$ ${entry.fixedValue.toFixed(2).replace('.', ',')} fixo`));

// Contas a pagar: estados e etapa pelo vencimento
const AP_CHAVES = ['aguardando', 'consolidado', 'open', 'soon', 'late', 'paid', 'cancelled'];
const AP_LABEL = { aguardando: 'Aguardando recebimento', consolidado: 'Em consolidado', open: 'A pagar', soon: 'Vence em breve', late: 'Atrasado', paid: 'Pago', cancelled: 'Cancelado' };
function apStageKey(venc, hoje, diasProximo = 3) {
  if (!venc) return 'open';
  const d = dayDiff(venc, hoje);
  return d < 0 ? 'late' : d <= diasProximo ? 'soon' : 'open';
}

// ---- validação do card do contrato (etapa "Gerar cobranças") ----
function contractIssues(c) {
  const out = [];
  if (!c.cliente) out.push('cliente (empresa ou contato)');
  if (!c.doc) out.push('CPF/CNPJ válido do cliente');
  if (!(c.valor > 0)) out.push(c.tipo === 'RECORRENTE' ? 'valor mensal (campo Valor)' : 'valor total (campo Valor)');
  if (!c.venc) out.push('1º vencimento (CR · Vencimento ou Data de término)');
  if (!c.tipo) out.push('tipo (À vista, Parcelado ou Recorrente mensal)');
  if (c.tipo === 'PARCELADO' && !(c.qtd >= 2)) out.push('nº de parcelas (2 ou mais)');
  if (c.tipo === 'RECORRENTE' && c.qtd && !(c.qtd >= 1)) out.push('nº de meses');
  if (c.venc && c.venc < c.hojeRef) out.push('1º vencimento no passado');
  return out;
}

// ---- pendências (o que "escapa" da cobrança) ----
// "Parcela 4 de 12. Renovação Bitrix24 Professional" (descrição que o Asaas dá às parcelas) → {n, total, base}.
function parseParcelaTitulo(t) {
  const nm = x => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  let m = /^\s*Parcela\s+(\d+)\s+de\s+(\d+)\s*[.:\-–—]\s*(.+?)\s*$/i.exec(String(t || ''));
  let n, total, base;
  if (m) { n = +m[1]; total = +m[2]; base = m[3]; }
  else if ((m = /^(.+?)\s*[—–-]\s*(\d+)\s*(?:\/|de)\s*(\d+)\s*$/i.exec(String(t || '')))) { base = m[1]; n = +m[2]; total = +m[3]; }   // "Título — 3/12" (parcelas manuais e do "Gerar parcelas")
  else return null;
  if (total < 2 || n < 1 || n > total || !String(base).trim()) return null;
  for (let i = 0; i < 3; i++) { const r = /^\s*Parcela\s+\d+\s+de\s+\d+\s*[.:\-–—]\s*(.+?)\s*$/i.exec(String(base)); if (!r) break; base = r[1]; }   // Asaas às vezes repete o prefixo
  return { n, total, base: nm(base) };
}

function issuesFor(c, cfg, today, asaasOn) {
  const out = [];
  if (c.stageId === STAGES.paid && c.asaasId && c.statusAsaas && mapAsaasStatus(c.statusAsaas) !== 'paid') {
    out.push({ sev: 'alta', msg: `Marcado como Pago no Bitrix, mas o Asaas informa "${c.statusAsaas}"` });
  }
  if (FINAL_STAGES.has(c.stageId) || c.stageId === STAGES.contrato) return out;
  if (c.stageId === STAGES.gerar) return contractIssues({ ...c, hojeRef: today }).map(m => ({ sev: 'alta', msg: `Falta: ${m}` }));
  if (!c.cliente) out.push({ sev: 'alta', msg: 'Sem cliente (empresa/contato) na deal' });
  if (!(c.valor > 0)) out.push({ sev: 'alta', msg: 'Valor zerado' });
  if (!c.venc) out.push({ sev: 'alta', msg: 'Sem data de vencimento' });
  if (!c.doc && !c.manual) out.push({ sev: 'alta', msg: 'Sem CPF/CNPJ válido (exigido pelo Asaas)' });
  if (!c.email && !c.telefone) out.push({ sev: 'media', msg: 'Cliente sem e-mail nem telefone — não receberá lembrete' });
  if (asaasOn && !c.asaasId && !c.manual) out.push({ sev: 'alta', msg: 'Cobrança ainda não emitida no Asaas' });
  if (c.asaasId && c.valorAsaas != null && Math.abs(c.valorAsaas - c.valor) > 0.009 && Math.round(c.valor) !== c.valorAsaas) {
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
  CONTRACT_STAGES, TIPOS, FORMAS, contractIssues, parseSplit, validateSplit, splitToText,
  parseRepasses, nativeSplit, repasseValor, repasseRegra, AP_CHAVES, AP_LABEL, apStageKey,
  CATEGORIAS, CATEGORIA_LICENCA, PLANOS, guessClass,
  CATEGORY_ID, STAGES, STAGE_LABEL, FINAL_STAGES, DEFAULT_CONFIG,
  todayBR, toDay, dayDiff, addMonths, validCPF, validCNPJ, validDoc, findDoc, digits,
  parseParcelaTitulo, mapAsaasStatus, stageFor, reminderDue, offsetLabel, splitInstallments, buildSchedule, issuesFor,
};
