'use strict';
// Cronograma de visitas (Assessoria Recorrente / RT): lógica pura — semanas, validação, carga, recorrência e feriados.
const crypto = require('crypto');
const FER = require('./feriados');
const uid = p => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const bad = m => Object.assign(new Error(m), { status: 400 });
const STATUS = { agendada: 'Agendada', realizada: 'Realizada', remarcada: 'Remarcada', faltou: 'Não aconteceu', cancelada: 'Cancelada' };
const DIAS = ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira'];
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const dataOk = v => { v = txt(v, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw bad('Data inválida (use AAAA-MM-DD).'); return v; };
const dow = d => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;   // 0 = segunda … 6 = domingo
const segunda = d => FER.somaDias(d, -dow(d));
const semana = d => { const s = segunda(d); return [0, 1, 2, 3, 4].map(i => FER.somaDias(s, i)); };
const fmtMin = m => `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;

function validaVisita(p, { consultoraOk, clienteOk }) {
  const data = dataOk(p.data), min = Math.round(Number(p.min));
  if (!Number.isFinite(min) || min < 15 || min > 720) throw bad('A duração deve ficar entre 15 minutos e 12 horas.');
  const consultora = txt(p.consultora, 40); if (!consultora || !consultoraOk(consultora)) throw bad('Escolha a consultora.');
  const clienteId = txt(p.clienteId, 40); if (!clienteId || !clienteOk(clienteId)) throw bad('Escolha o cliente.');
  const status = STATUS[p.status] ? p.status : 'agendada';
  return { data, min, consultora, clienteId, status, obs: txt(p.obs, 500) };
}
function validaCliente(p) {
  const nome = txt(p.nome, 120); if (nome.length < 2) throw bad('Informe o nome do cliente.');
  return { nome, empresaBitrixId: txt(p.empresaBitrixId, 12).replace(/\D/g, ''), cidade: txt(p.cidade, 80), uf: txt(p.uf, 2).toUpperCase(), dealId: txt(p.dealId, 12).replace(/\D/g, ''), ativo: p.ativo !== false };
}
// Feriados do dia para o cliente (devolve lista de feriados que valem de fato, mais facultativos à parte).
function feriadoDoDia(cliente, data, custom, cacheAno) {
  const ano = Number(data.slice(0, 4)), k = `${ano}|${cliente.cidade}|${cliente.uf}`;
  const m = cacheAno.get(k) || (cacheAno.set(k, FER.feriados({ cidade: cliente.cidade, uf: cliente.uf, ano, custom })), cacheAno.get(k));
  const l = m.get(data) || []; return { feriado: l.filter(x => !x.facultativo), facultativo: l.filter(x => x.facultativo), mapa: m };
}
function marcaFeriados(visitas, clientesPorId, custom) {
  const cache = new Map();
  return visitas.map(v => {
    const c = clientesPorId.get(v.clienteId); if (!c) return { ...v, feriado: null };
    const f = feriadoDoDia(c, v.data, custom, cache), ativo = v.status === 'agendada' || v.status === 'remarcada';
    return { ...v, feriado: ativo && f.feriado.length ? f.feriado.map(x => x.nome).join(' / ') : null, facultativo: ativo && f.facultativo.length ? f.facultativo.map(x => x.nome).join(' / ') : null,
      sugestao: ativo && f.feriado.length ? FER.proximoUtil(v.data, f.mapa) : '' };
  });
}
const cargaPorConsultora = visitas => { const r = {}; for (const v of visitas) if (v.status !== 'cancelada' && v.status !== 'remarcada' && v.status !== 'faltou') r[v.consultora] = (r[v.consultora] || 0) + v.min; return r; };

// Recorrências a partir do histórico de semanas: aparece em toda semana = semanal; em semanas alternadas = quinzenal.
function derivaModelos(visitas, semanasBase) {
  const g = new Map();
  for (const v of visitas) { if (v.status === 'cancelada') continue; const k = `${v.clienteId}|${v.consultora}|${dow(v.data)}`, x = g.get(k) || { clienteId: v.clienteId, consultora: v.consultora, dow: dow(v.data), min: v.min, semanas: new Set() }; x.semanas.add(segunda(v.data)); g.set(k, x); }
  const out = [], n = semanasBase.length;
  for (const x of g.values()) {
    const idx = semanasBase.map((s, i) => (x.semanas.has(s) ? i : -1)).filter(i => i >= 0);
    if (idx.length === n && n >= 2) out.push({ id: uid('md'), clienteId: x.clienteId, consultora: x.consultora, dow: x.dow, min: x.min, freq: 'semanal', ancora: semanasBase[0], ativo: true });
    else if (n >= 3 && idx.length === Math.ceil(n / 2) && idx.every((i, k) => i === k * 2)) out.push({ id: uid('md'), clienteId: x.clienteId, consultora: x.consultora, dow: x.dow, min: x.min, freq: 'quinzenal', ancora: semanasBase[0], ativo: true });
  }
  return out;
}
const semanasEntre = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / (7 * 864e5));
// Visitas que o modelo prevê numa semana (segunda-feira `seg`).
function ocorreNaSemana(m, seg) { if (!m.ativo) return false; const n = semanasEntre(m.ancora, seg); return m.freq === 'semanal' ? true : Math.abs(n) % 2 === 0; }
function gerarSemana({ modelos, seg, existentes, clientesPorId, custom }) {
  const cache = new Map(), novas = [], ja = new Set(existentes.map(v => `${v.clienteId}|${v.consultora}|${v.data}`));
  for (const m of modelos) {
    if (!ocorreNaSemana(m, seg)) continue; const c = clientesPorId.get(m.clienteId); if (!c || c.ativo === false) continue;
    let data = FER.somaDias(seg, m.dow), obs = '', origem = 'recorrencia';
    const f = feriadoDoDia(c, data, custom, cache);
    if (f.feriado.length) { const prox = FER.proximoUtil(data, f.mapa); if (!prox) continue; obs = `Remarcada de ${data.split('-').reverse().join('/')}: feriado (${f.feriado.map(x => x.nome).join(' / ')})`; data = prox; }
    const k = `${m.clienteId}|${m.consultora}|${data}`; if (ja.has(k)) continue; ja.add(k);
    novas.push({ id: uid('vs'), data, min: m.min, consultora: m.consultora, clienteId: m.clienteId, status: 'agendada', obs, origem });
  }
  return novas;
}
module.exports = { uid, STATUS, DIAS, dow, segunda, semana, fmtMin, validaVisita, validaCliente, marcaFeriados, cargaPorConsultora, derivaModelos, gerarSemana, semanasEntre, dataOk, feriadoDoDia };
