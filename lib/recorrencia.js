'use strict';
const R = require('./rules');

// Recorrência de contas a pagar e a receber (manuais). A regra fica no app; cada ocorrência é um título normal no Bitrix,
// marcado com "regra:número" (CP_RECOR / CR_RECOR). Geramos sempre 12 meses à frente e completamos a cada sincronização,
// então a recorrência "sem fim" nunca acaba e as com fim aparecem inteiras no fluxo de caixa.
const FREQS = {
  semanal: { dias: 7, nome: 'Semanal' }, quinzenal: { dias: 14, nome: 'Quinzenal' }, mensal: { meses: 1, nome: 'Mensal' },
  bimestral: { meses: 2, nome: 'Bimestral' }, trimestral: { meses: 3, nome: 'Trimestral' }, semestral: { meses: 6, nome: 'Semestral' }, anual: { meses: 12, nome: 'Anual' },
};
const HORIZONTE_MESES = 12, MAX_POR_RODADA = 60, MAX_TOTAL = 600;
const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
const isDay = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '')); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// i = 0 é a data de início; mensal+ preserva o dia do mês (31 → fim do mês) sem "derrapar".
function dataOcorrencia(inicio, freq, i) { const f = FREQS[freq]; return f.dias ? addDays(inicio, f.dias * i) : R.addMonths(inicio, f.meses * i); }

// Ocorrências que já deveriam existir: do início até o horizonte (ou até o fim da regra). idx é 1-based.
function ocorrencias(regra, hoje, { max = MAX_POR_RODADA } = {}) {
  const limite = R.addMonths(hoje, HORIZONTE_MESES), out = [];
  for (let i = 0; i < MAX_TOTAL; i++) {
    if (regra.qtd && i >= regra.qtd) break;
    const venc = dataOcorrencia(regra.inicio, regra.freq, i);
    if (regra.fim && venc > regra.fim) break;
    if (venc > limite) break;
    out.push({ idx: i + 1, venc });
    if (out.length >= max) break;
  }
  return out;
}

function normalizar(i = {}, hoje = R.todayBR()) {
  const freq = String(i.freq || '');
  if (!FREQS[freq]) throw fail(400, 'Frequência inválida.');
  if (!isDay(i.inicio)) throw fail(400, 'Informe a data da primeira ocorrência.');
  if (i.inicio < hoje) throw fail(400, 'A primeira ocorrência não pode estar no passado.');
  const qtd = i.qtd ? parseInt(i.qtd, 10) : 0, fim = i.fim || '';
  if (i.qtd && !(qtd >= 1 && qtd <= MAX_TOTAL)) throw fail(400, `A quantidade de ocorrências deve ficar entre 1 e ${MAX_TOTAL}.`);
  if (fim && (!isDay(fim) || fim < i.inicio)) throw fail(400, 'A data final precisa ser igual ou depois da primeira ocorrência.');
  if (qtd && fim) throw fail(400, 'Escolha o fim por quantidade OU por data, não os dois.');
  return { freq, inicio: i.inicio, qtd, fim };
}

const rotulo = r => `${FREQS[r.freq].nome}${r.qtd ? ` · ${r.qtd}x` : r.fim ? ` · até ${r.fim.split('-').reverse().join('/')}` : ' · sem fim'}`;
const parseRecor = v => { const m = /^(rc_[a-z0-9]+):(\d+)$/.exec(String(v || '')); return m ? { id: m[1], idx: +m[2] } : null; };
const novoId = () => 'rc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// adapters[tipo]: { existentes(), criar(regra, {idx, venc}), futuras(regraId, hoje), atualizar(ids, patch), cancelar(ids) } — implementados em pagar.js e service.js.
function createRecorrencias({ store, adapters }) {
  let fila = Promise.resolve();
  const serial = fn => (...a) => { const run = fila.then(() => fn(...a)); fila = run.catch(() => {}); return run; };

  async function gerarRegra(regra, hoje) {
    if (!regra.ativa) return 0;
    const ad = adapters[regra.tipo];
    const have = new Set((await ad.existentes()).filter(x => x.recorId === regra.id).map(x => x.idx));
    let n = 0;
    for (const o of ocorrencias(regra, hoje)) { if (have.has(o.idx)) continue; await ad.criar(regra, o); n++; }
    return n;
  }
  async function gerarTodas() {
    const hoje = R.todayBR(), out = { criadas: 0, erros: [] };
    for (const r of store.recs) {
      if (!adapters[r.tipo]) continue;
      try { out.criadas += await gerarRegra(r, hoje); } catch (e) { out.erros.push(`${r.id}: ${e.message}`); }
    }
    return out;
  }

  async function criar({ tipo, template, recorrencia }) {
    if (!adapters[tipo]) throw fail(400, 'Tipo de recorrência inválido.');
    const cfg = normalizar(recorrencia);
    const regra = { id: novoId(), tipo, ...cfg, template, ativa: true, criadaEm: new Date().toISOString() };
    store.addRec(regra);
    try { const n = await gerarRegra(regra, R.todayBR()); store.log('recorrencia', `Recorrência ${regra.id} (${tipo}) criada: ${rotulo(regra)} · ${n} ocorrência(s) gerada(s)`); return { regra, geradas: n }; }
    catch (e) { const have = (await adapters[tipo].existentes().catch(() => [])).filter(x => x.recorId === regra.id).length; if (!have) store.removeRec(regra.id); throw e; }   // falhou antes de gerar algo: não deixa regra órfã
  }

  async function listar() {
    const hoje = R.todayBR(), out = [];
    for (const r of store.recs) {
      const ex = adapters[r.tipo] ? (await adapters[r.tipo].existentes().catch(() => [])).filter(x => x.recorId === r.id) : [];
      const prox = ex.filter(x => x.venc >= hoje && x.aberta).map(x => x.venc).sort()[0] || '';
      out.push({ ...r, rotulo: rotulo(r), geradas: ex.length, proxima: prox, abertas: ex.filter(x => x.aberta).length });
    }
    return out;
  }

  async function editar(id, { valor, titulo, ativa, fim } = {}) {
    const r = store.recs.find(x => x.id === id);
    if (!r) throw fail(404, 'Recorrência não encontrada.');
    const ad = adapters[r.tipo], patch = {}, tpl = { ...r.template }, hoje = R.todayBR();
    if (valor !== undefined && valor !== '') { const v = Math.round(Number(valor) * 100) / 100; if (!(v > 0) || !Number.isFinite(v) || v >= 1e10) throw fail(400, 'Valor inválido.'); tpl.valor = v; }
    if (titulo !== undefined) { const t = String(titulo).trim(); if (!t) throw fail(400, 'A descrição não pode ficar vazia.'); tpl.titulo = t.slice(0, 255); }
    if (typeof ativa === 'boolean') patch.ativa = ativa;
    if (fim !== undefined) { if (fim && (!isDay(fim) || fim < hoje)) throw fail(400, 'Data final inválida.'); patch.fim = fim || ''; if (fim) patch.qtd = 0; }
    patch.template = tpl;
    store.setRec(id, patch);
    // valor/descrição novos valem daqui para frente: atualiza as ocorrências futuras ainda não pagas
    let atualizadas = 0;
    if (tpl.valor !== r.template.valor || tpl.titulo !== r.template.titulo) {
      const ids = await ad.futuras(id, hoje);
      if (ids.length) { await ad.atualizar(ids, { valor: tpl.valor !== r.template.valor ? tpl.valor : undefined, titulo: tpl.titulo !== r.template.titulo ? tpl.titulo : undefined }); atualizadas = ids.length; }
    }
    store.log('recorrencia', `Recorrência ${id} editada${atualizadas ? ` (${atualizadas} ocorrência(s) futura(s) atualizada(s))` : ''}`);
    if (patch.ativa || (patch.ativa === undefined && (store.recs.find(x => x.id === id) || {}).ativa)) await gerarRegra(store.recs.find(x => x.id === id), hoje);
    return { ok: true, atualizadas };
  }

  async function encerrar(id, { cancelarFuturas = false } = {}) {
    const r = store.recs.find(x => x.id === id);
    if (!r) throw fail(404, 'Recorrência não encontrada.');
    store.setRec(id, { ativa: false, encerradaEm: new Date().toISOString() });
    let canceladas = 0;
    if (cancelarFuturas) { const ids = await adapters[r.tipo].futuras(id, R.todayBR()); if (ids.length) { await adapters[r.tipo].cancelar(ids); canceladas = ids.length; } }
    store.log('recorrencia', `Recorrência ${id} encerrada${canceladas ? ` (${canceladas} futura(s) cancelada(s))` : ''}`);
    return { ok: true, canceladas };
  }

  return { criar: serial(criar), gerarTodas: serial(gerarTodas), listar, editar: serial(editar), encerrar: serial(encerrar) };
}

module.exports = { FREQS, ocorrencias, dataOcorrencia, normalizar, rotulo, parseRecor, createRecorrencias, HORIZONTE_MESES };
