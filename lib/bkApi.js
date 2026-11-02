'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./bk');
const C = require('./finCad');
const R = require('./rules');

// API do processo BK (/api/bk/*). Dados próprios em bk.json (escrita atômica); títulos da medição vão para o A Receber.
function createBkApi({ fin, empresas, bitrix, store, dir, seedFile }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bk.json');
  let d = { unidades: [], historico: [], medicoes: [], avisos: {}, config: { valorPadrao: 0, responsavelPadrao: '', empresaId: '', cliente: 'BK Brasil', diaVenc: 10, categoria: 'Serviços BK', marcos: [60, 30, 15, 7, 0] } };
  try { const x = JSON.parse(fs.readFileSync(file, 'utf8')); d = { ...d, ...x, config: { ...d.config, ...x.config } }; } catch { /* primeiro uso */ }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, file); };
  const hoje = () => R.todayBR();
  // Carga inicial (uma única vez): arquivo de unidades preparado fora do repositório, usado só se ainda não há unidades.
  if (seedFile && !d.semeado && !d.unidades.length && fs.existsSync(seedFile)) {
    try {
      const itens = JSON.parse(fs.readFileSync(seedFile, 'utf8')), vistos = new Set();
      for (const x of itens) { try { const v = B.validaUnidade({ ...x, etapa: B.etapaDeTexto(x.etapaTxt) }); if (!vistos.has(v.bkn)) { vistos.add(v.bkn); d.unidades.push({ id: B.uid('bk'), ...v }); } } catch { /* linha inválida: ignora */ } }
      d.semeado = true; save(); store.log('bk', `Carga inicial: ${d.unidades.length} unidade(s)`);
    } catch (e) { store.log('erro', `BK: carga inicial falhou: ${e.message}`); }
  }
  const need = (c, m) => { if (!c) throw Object.assign(new Error(m), { status: 400 }); };
  const nf = what => Object.assign(new Error(`${what} não encontrada.`), { status: 404 });
  const achar = id => d.unidades.find(u => u.id === id) || (() => { throw nf('Unidade'); })();
  const dupBkn = (bkn, exceto) => d.unidades.some(u => u.bkn === bkn && u.id !== exceto);

  const filtra = (q, h) => {
    const t = String(q.get('q') || '').toLowerCase().trim(), uf = String(q.get('uf') || '').toUpperCase(), et = q.get('etapa') || '', sit = q.get('situacao') || '';
    return d.unidades.map(u => B.comSituacao(u, h)).filter(u =>
      (!t || `${u.bkn} ${u.nome} ${u.cidade} ${u.rt.nome} ${u.cnpj}`.toLowerCase().includes(t)) && (!uf || u.uf === uf) && (!et || u.etapa === et) &&
      (!sit || (sit === 'pendente' ? u.pendencias.length > 0 : sit === 'conforme' ? u.ativa && !u.pendencias.length : sit === 'vencendo' ? u.alertas.some(a => a.nivel === 'critico' || (a.nivel === 'vencido' && a.tipo !== 'virada')) : sit === 'semrt' ? u.ativa && u.necessitaRt === 'sim' && !u.rt.nome : true)));
  };

  async function avisar({ simular = false } = {}) {
    const h = hoje(), enviados = [], erros = [];
    for (const u of d.unidades) {
      for (const a of B.alertasUnidade(u, h)) {
        if (a.tipo === 'prazo' && a.dias > 3) continue;
        const key = `${u.id}|${a.tipo}|${a.data}`, marco = B.avisoDevido(a.dias, d.config.marcos, d.avisos[key] || []);
        if (marco === null) continue;
        const msg = a.dias < 0 ? `BK ${u.bkn} — ${u.nome}: ${a.rotulo} vencida há ${-a.dias} dia(s) (${a.data}).` : a.dias === 0 ? `BK ${u.bkn} — ${u.nome}: ${a.rotulo} vence HOJE.` : `BK ${u.bkn} — ${u.nome}: ${a.rotulo} em ${a.dias} dia(s) (${a.data}).`;
        const resp = u.responsavel || d.config.responsavelPadrao;
        if (simular) { enviados.push({ unidade: u.bkn, tipo: a.tipo, marco, msg, responsavel: resp }); continue; }
        if (!bitrix.enabled || !resp) { erros.push(`${u.bkn}: sem responsável ou Bitrix não conectado`); continue; }
        try { await bitrix.call('im.notify.personal.add', { USER_ID: resp, MESSAGE: msg, TAG: `bk-${u.id}-${a.tipo}-${marco}` }); (d.avisos[key] ||= []).push(marco); save(); enviados.push({ unidade: u.bkn, tipo: a.tipo, marco, msg, responsavel: resp }); store.log('bk', `Aviso enviado: ${msg}`); }
        catch (e) { erros.push(`${u.bkn}: ${e.message}`); }
      }
    }
    return { enviados, erros };
  }

  const routes = [];
  const on = (m, re, h) => routes.push([m, new RegExp(`^/api/bk${re}$`), h]);
  const resp = () => ({ hoje: hoje(), demo: d.unidades.some(u => u.demo), config: d.config, etapas: B.ETAPAS, crn: B.CRN, resumo: B.resumo(d.unidades, hoje()), empresas: fin.empresas.all().map(e => ({ id: e.id, nome: e.nome })) });

  on('GET', '/bootstrap', async () => resp());
  on('GET', '/unidades', async (_, u) => {
    const q = u.searchParams, lista = filtra(q, hoje()), pp = Math.min(100, Math.max(5, Number(q.get('pp')) || 25)), paginas = Math.max(1, Math.ceil(lista.length / pp)), p = Math.min(paginas, Math.max(1, Number(q.get('page')) || 1));
    return { itens: lista.slice((p - 1) * pp, p * pp), total: lista.length, pagina: p, paginas };
  });
  on('GET', '/unidades/([\\w-]+)', async ([id]) => ({ ...B.comSituacao(achar(id), hoje()), historico: d.historico.filter(e => e.unidadeId === id).reverse() }));
  on('POST', '/unidades', async (_, __, b) => {
    const v = B.validaUnidade(b); need(!dupBkn(v.bkn), `Já existe a unidade BKN ${v.bkn}.`);
    const x = { id: B.uid('bk'), ...v }; d.unidades.push(x); save(); store.log('bk', `Unidade ${x.bkn} cadastrada`); return x;
  });
  on('PUT', '/unidades/([\\w-]+)', async ([id], _, b) => {
    const u = achar(id), v = B.validaUnidade({ ...u, ...b, rt: { ...u.rt, ...(b.rt || {}) } }); need(!dupBkn(v.bkn, id), `Já existe a unidade BKN ${v.bkn}.`);
    const x = { id, ...v, demo: u.demo }; if (x.etapa !== u.etapa) d.historico.push(B.mover(u, x.etapa, 'Alterada na edição', '', hoje()).evento);
    d.unidades[d.unidades.findIndex(y => y.id === id)] = x; save(); return x;
  });
  on('DELETE', '/unidades/([\\w-]+)', async ([id]) => { achar(id); d.unidades = d.unidades.filter(u => u.id !== id); d.historico = d.historico.filter(e => e.unidadeId !== id); save(); return { ok: true }; });
  on('POST', '/unidades/([\\w-]+)/mover', async ([id], _, b) => {
    const { unidade, evento } = B.mover(achar(id), b.etapa, b.nota, b.por, hoje());
    d.unidades[d.unidades.findIndex(y => y.id === id)] = unidade; d.historico.push(evento); if (d.historico.length > 20000) d.historico.splice(0, d.historico.length - 20000); save();
    store.log('bk', `Unidade ${unidade.bkn}: ${B.ETAPA_NOME[evento.de]} → ${B.ETAPA_NOME[evento.para]}`); return unidade;
  });
  on('POST', '/importar', async (_, __, b) => {
    const r = B.importarCsv(b.csv); let criadas = 0, atualizadas = 0;
    for (const v of r.unidades) {
      const ex = d.unidades.find(u => u.bkn === v.bkn);
      if (ex) { d.unidades[d.unidades.indexOf(ex)] = { ...ex, ...v, rt: { ...ex.rt, ...Object.fromEntries(Object.entries(v.rt).filter(([, x]) => x)) }, valorMensal: v.valorMensal != null ? v.valorMensal : ex.valorMensal, id: ex.id }; atualizadas++; }
      else { d.unidades.push({ id: B.uid('bk'), ...v }); criadas++; }
    }
    save(); store.log('bk', `Importação: ${criadas} nova(s), ${atualizadas} atualizada(s)`); return { criadas, atualizadas, erros: r.erros, totalErros: r.totalErros };
  });
  on('GET', '/esteira', async (_, u) => {
    const lista = filtra(u.searchParams, hoje());
    return B.ETAPAS.map(([k, nome]) => ({ etapa: k, nome, itens: lista.filter(x => x.etapa === k).slice(0, 60), total: lista.filter(x => x.etapa === k).length }));
  });
  on('POST', '/avisar', async (_, __, b) => avisar({ simular: !!b.simular }));
  on('PUT', '/config', async (_, __, b) => {
    const c = { ...d.config };
    if (b.valorPadrao !== undefined) { const v = Number(b.valorPadrao); need(Number.isFinite(v) && v >= 0 && v < 1e7, 'Valor padrão inválido.'); c.valorPadrao = v; }
    if (b.responsavelPadrao !== undefined) c.responsavelPadrao = String(b.responsavelPadrao).replace(/\D/g, '').slice(0, 12);
    if (b.empresaId !== undefined) { need(!b.empresaId || fin.empresas.get(b.empresaId), 'Empresa não encontrada.'); c.empresaId = b.empresaId; }
    if (b.cliente !== undefined) c.cliente = String(b.cliente).trim().slice(0, 120);
    if (b.diaVenc !== undefined) { const v = Number(b.diaVenc); need(Number.isInteger(v) && v >= 1 && v <= 28, 'Dia de vencimento: de 1 a 28.'); c.diaVenc = v; }
    if (b.categoria !== undefined) c.categoria = String(b.categoria).trim().slice(0, 80);
    if (b.marcos !== undefined) { const m = [].concat(b.marcos).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 365); need(m.length, 'Informe ao menos um marco de aviso.'); c.marcos = [...new Set(m)].sort((a, b2) => b2 - a); }
    d.config = c; save(); return c;
  });

  // ---------- medição mensal → A Receber ----------
  const plano = q => B.planejarMedicao({ unidades: d.unidades, competencia: q, valorPadrao: d.config.valorPadrao, medidas: d.medicoes, hoje: hoje() });
  on('GET', '/medicao/previa', async (_, u) => ({ ...plano(u.searchParams.get('competencia') || B.mesAnterior(hoje())), config: d.config }));
  on('GET', '/medicoes', async () => {
    const por = {}; for (const m of d.medicoes) { const x = por[m.competencia] ||= { competencia: m.competencia, unidades: 0, total: 0 }; x.unidades++; x.total += m.valor; }
    return Object.values(por).sort((a, b) => b.competencia.localeCompare(a.competencia)).map(x => ({ ...x, total: Math.round(x.total * 100) / 100 }));
  });
  on('POST', '/medicao/gerar', async (_, __, b) => {
    const cfg = d.config, empresaId = String(b.empresaId || cfg.empresaId || ''); need(empresaId && fin.empresas.get(empresaId), 'Escolha a empresa que vai faturar (Configurações da medição).');
    const p = plano(b.competencia), ids = Array.isArray(b.unidades) ? new Set(b.unidades) : null, itens = p.itens.filter(i => i.gerar && (!ids || ids.has(i.unidadeId)));
    need(itens.length, 'Nenhuma unidade para faturar nesta competência.');
    const [y, m] = p.competencia.split('-').map(Number), ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1, venc = `${ny}-${String(nm).padStart(2, '0')}-${String(cfg.diaVenc).padStart(2, '0')}`;
    const mes = `${String(m).padStart(2, '0')}/${y}`, novos = [], med = [];
    const ctx = { formas: fin.formas.all(), condicoes: fin.condicoes.all(), hoje: hoje() };
    for (const i of itens) {
      const [l] = C.criarLancamentos({ empresaId, descricao: `RT nutricionista ${mes} — BKN ${i.bkn} ${i.nome}`.slice(0, 200), cliente: cfg.cliente, categoria: cfg.categoria, valor: i.valor, venc, forma: 'BOLETO', parcelas: 1, obs: `Medição mensal BK · competência ${p.competencia}` }, 'receber', ctx);
      novos.push({ ...l, origem: 'bk', bkUnidadeId: i.unidadeId, bkCompetencia: p.competencia });
      med.push({ id: B.uid('md'), competencia: p.competencia, unidadeId: i.unidadeId, bkn: i.bkn, valor: i.valor, lancamentoId: l.id, empresaId, em: hoje() });
    }
    fin.receber.add(novos); d.medicoes.push(...med); save();
    store.log('bk', `Medição ${p.competencia}: ${novos.length} título(s) em A Receber, total ${itens.reduce((s, i) => s + i.valor, 0).toFixed(2)}`);
    return { geradas: novos.length, total: Math.round(itens.reduce((s, i) => s + i.valor, 0) * 100) / 100, venc };
  });
  on('POST', '/medicao/desfazer', async (_, __, b) => {
    const c = B.compOk(b.competencia), ms = d.medicoes.filter(m => m.competencia === c); need(ms.length, 'Não há medição nesta competência.');
    const abertos = ms.filter(m => { const l = fin.receber.get(m.lancamentoId); return l && l.status !== 'aberto'; });
    need(!abertos.length, `${abertos.length} título(s) desta medição já foram baixados. Estorne-os antes de desfazer.`);
    for (const m of ms) fin.receber.remove(m.lancamentoId);
    d.medicoes = d.medicoes.filter(m => m.competencia !== c); save(); return { removidos: ms.length };
  });

  // ---------- demonstração ----------
  on('POST', '/demo/carregar', async () => { need(!d.unidades.some(u => u.demo), 'Os dados de demonstração já estão carregados.'); const x = B.demoUnidades(hoje()); d.unidades.push(...x.filter(u => !dupBkn(u.bkn))); save(); return { unidades: x.length }; });
  on('DELETE', '/demo', async () => { const ids = new Set(d.unidades.filter(u => u.demo).map(u => u.id)); d.unidades = d.unidades.filter(u => !u.demo); d.historico = d.historico.filter(e => !ids.has(e.unidadeId)); const md = d.medicoes.filter(m => ids.has(m.unidadeId)); for (const m of md) fin.receber.remove(m.lancamentoId); d.medicoes = d.medicoes.filter(m => !ids.has(m.unidadeId)); save(); return { removidas: ids.size }; });

  return {
    avisar,
    async handle(method, pathname, u, readBody) {
      for (const [m, re, h] of routes) { const g = m === method && pathname.match(re); if (g) return { json: await h(g.slice(1), u, ['POST', 'PUT'].includes(method) ? await readBody() : {}) }; }
      return null;
    },
  };
}
module.exports = { createBkApi };
