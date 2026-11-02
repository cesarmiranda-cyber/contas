'use strict';
// Processo BK — licença sanitária e Responsável Técnico (RT) por unidade.
// Lógica pura (sem I/O): validação, importação CSV, situação/alertas, esteira e medição mensal.
const crypto = require('crypto');
const uid = p => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const bad = m => { const e = new Error(m); e.status = 400; return e; };

const ETAPAS = [
  ['aguardando', 'Aguardando documentos'], ['enviado', 'Protocolo enviado'], ['reenviado', 'Reenviado'],
  ['em_analise', 'Em análise'], ['aguarda_licenca', 'Aguarda licença'], ['deferido', 'Deferido'], ['desligado', 'Desligado'],
];
const ETAPA_NOME = Object.fromEntries(ETAPAS);
const CRN = { 1: 'DF/GO/MT/TO', 2: 'RS', 3: 'SP/MS', 4: 'RJ/ES', 5: 'BA/SE', 6: 'PE/AL/PB/RN', 7: 'AM/AC/RO/RR', 8: 'PR', 9: 'MG', 10: 'SC', 11: 'CE/PI/MA', 12: 'PA/AP' };

const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const digits = v => String(v || '').replace(/\D/g, '');
const dataOk = v => { v = txt(v, 10); if (!v) return ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw bad(`Data inválida: ${v}. Use AAAA-MM-DD.`); return v; };
const sim = v => ['sim', 's', 'yes', 'true', '1'].includes(String(v).trim().toLowerCase());
const triplo = v => { const s = String(v == null ? '' : v).trim().toLowerCase(); return ['sim', 's', 'true', '1'].includes(s) ? 'sim' : ['nao', 'não', 'n', 'false', '0'].includes(s) ? 'nao' : 'pendente'; };

function validaUnidade(p) {
  const bkn = txt(p.bkn, 20).replace(/\s+/g, ''); if (!bkn) throw bad('Informe o código BKN da unidade.');
  const nome = txt(p.nome, 120); if (nome.length < 2) throw bad('Informe o nome da unidade.');
  const etapa = ETAPA_NOME[p.etapa] ? p.etapa : 'aguardando';
  const valor = p.valorMensal === '' || p.valorMensal == null ? null : Number(p.valorMensal);
  if (valor !== null && (!Number.isFinite(valor) || valor < 0 || valor > 1e7)) throw bad('Valor mensal inválido.');
  const r = p.rt || {};
  return {
    bkn, nome, cnpj: digits(p.cnpj).slice(0, 14), endereco: txt(p.endereco, 200), cep: digits(p.cep).slice(0, 8), cidade: txt(p.cidade, 80), uf: txt(p.uf, 2).toUpperCase(),
    licenca: triplo(p.licenca), licencaValidade: dataOk(p.licencaValidade), necessitaRt: triplo(p.necessitaRt), visitas: Math.max(0, Math.min(31, Number(p.visitas) || 0)),
    rt: { nome: txt(r.nome, 120), crn: txt(r.crn, 30), validade: dataOk(r.validade), anterior: txt(r.anterior, 120) },
    previsaoVirada: dataOk(p.previsaoVirada), etapa, prazo: dataOk(p.prazo), responsavel: txt(p.responsavel, 12).replace(/\D/g, ''), observacao: txt(p.observacao, 500),
    empresaBitrixId: txt(p.empresaBitrixId, 12).replace(/\D/g, ''), valorMensal: valor, contratoId: txt(p.contratoId, 20).replace(/\D/g, ''), ativa: p.ativa !== false && etapa !== 'desligado',
  };
}

// ---------- importação CSV (Excel → "Salvar como CSV") ----------
function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '', sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cur += c;
    if (rows.length > 5001) throw bad('Arquivo grande demais (máximo de 5.000 linhas).');
  }
  row.push(cur); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const COLUNAS = [
  ['bkn', ['bkn', 'bkns', 'codigo']], ['nome', ['nome da loja', 'unidade bk', 'unidade', 'loja', 'nome']], ['cnpj', ['cnpj']], ['endereco', ['endereco']], ['cep', ['cep']],
  ['uf', ['estado', 'uf']], ['cidade', ['cidade', 'municipio']], ['licenca', ['licenca sanitaria', 'licenca']], ['necessitaRt', ['precisa', 'necessidade nutricionista', 'rt']],
  ['licencaValidade', ['validade licenca', 'validade da licenca']], ['rtValidade', ['validade']], ['visitas', ['quantidade de visitas mensais', 'visitas']],
  ['etapa', ['status da documentacao', 'status documentacao', 'status']], ['previsaoVirada', ['previsao virada', 'previsao de virada']], ['rtNome', ['nutricionista rt', 'rt atual']],
  ['rtAnterior', ['rt anterior']], ['observacao', ['acoes', 'observacao']], ['valorMensal', ['valor mensal', 'valor']],
];
function etapaDeTexto(s) {
  const t = norm(s); if (!t) return 'aguardando';
  if (t.includes('desligad')) return 'desligado'; if (t.includes('deferid')) return 'deferido'; if (t.includes('reenvi')) return 'reenviado';
  if (t.includes('enviad')) return 'enviado'; if (t.includes('aguarda lic')) return 'aguarda_licenca'; if (t.includes('analise')) return 'em_analise'; return 'aguardando';
}
function dataBR(v) {
  v = String(v || '').trim(); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
function importarCsv(text) {
  const rows = parseCsv(text); if (rows.length < 2) throw bad('O arquivo precisa ter a linha de títulos e ao menos uma unidade.');
  const heads = rows[0].map(norm), idx = {};
  for (const [campo, nomes] of COLUNAS) { for (const n of nomes) { const i = heads.findIndex(h => h === n || h.startsWith(n + ' ')); if (i >= 0 && !(campo in idx) && !Object.values(idx).includes(i)) { idx[campo] = i; break; } } }
  if (!('bkn' in idx) || !('nome' in idx)) throw bad('Não encontrei as colunas "BKN" e "Nome da loja" (ou "Unidade BK") na primeira linha.');
  const out = [], erros = [];
  rows.slice(1).forEach((r, k) => {
    const g = c => (c in idx ? String(r[idx[c]] || '').trim() : '');
    const bkn = g('bkn').replace(/\D/g, ''); if (!bkn && !g('nome')) return;
    try {
      out.push(validaUnidade({ bkn, nome: g('nome'), cnpj: g('cnpj'), endereco: g('endereco'), cep: g('cep'), uf: g('uf'), cidade: g('cidade'), licenca: g('licenca'), necessitaRt: g('necessitaRt'),
        licencaValidade: dataBR(g('licencaValidade')), visitas: g('visitas').replace(/\D/g, ''), etapa: etapaDeTexto(g('etapa')), previsaoVirada: dataBR(g('previsaoVirada')),
        rt: { nome: g('rtNome'), validade: dataBR(g('rtValidade')), anterior: g('rtAnterior') }, observacao: g('observacao'), valorMensal: g('valorMensal').replace(/\./g, '').replace(',', '.') }));
    } catch (e) { erros.push(`Linha ${k + 2}: ${e.message}`); }
  });
  return { unidades: out, erros: erros.slice(0, 30), totalErros: erros.length };
}

// ---------- situação e alertas ----------
const dias = (de, ate) => Math.round((Date.parse(ate + 'T00:00:00Z') - Date.parse(de + 'T00:00:00Z')) / 864e5);
const nivel = d => (d < 0 ? 'vencido' : d <= 7 ? 'critico' : d <= 30 ? 'atencao' : 'ok');
function alertasUnidade(u, hoje) {
  if (!u.ativa) return [];
  const a = [], add = (tipo, data, rotulo) => { if (data) { const d = dias(hoje, data); a.push({ tipo, data, dias: d, nivel: nivel(d), rotulo }); } };
  add('licenca', u.licencaValidade, 'Licença sanitária'); add('rt', u.rt.validade, 'Validade do RT'); add('virada', u.previsaoVirada, 'Previsão de virada do RT'); add('prazo', u.etapa !== 'deferido' ? u.prazo : '', 'Prazo do protocolo');
  return a;
}
// Problemas de conformidade: o que está errado AGORA na unidade.
function pendencias(u, hoje) {
  if (!u.ativa) return [];
  const p = [];
  if (u.necessitaRt === 'sim' && !u.rt.nome) p.push('Precisa de RT e não tem nutricionista designado');
  if (u.necessitaRt === 'pendente') p.push('Necessidade de RT ainda não definida');
  if (u.licenca === 'nao') p.push('Sem licença sanitária'); else if (u.licenca === 'pendente') p.push('Licença sanitária não informada');
  for (const a of alertasUnidade(u, hoje)) if (a.nivel === 'vencido' && a.tipo !== 'virada') p.push(`${a.rotulo} vencida há ${-a.dias} dia(s)`);
  if (u.etapa === 'aguarda_licenca') p.push('Documentação aguardando a licença');
  return p;
}
function resumo(unidades, hoje) {
  const ativas = unidades.filter(u => u.ativa), porEtapa = {}, porUf = {};
  for (const [k] of ETAPAS) porEtapa[k] = 0;
  for (const u of unidades) porEtapa[u.etapa] = (porEtapa[u.etapa] || 0) + 1;
  let venc = 0, crit = 0, semRt = 0, semLic = 0, comPend = 0;
  for (const u of ativas) {
    const al = alertasUnidade(u, hoje); venc += al.filter(a => a.nivel === 'vencido' && a.tipo !== 'virada').length; crit += al.filter(a => a.nivel === 'critico').length;
    if (u.necessitaRt === 'sim' && !u.rt.nome) semRt++; if (u.licenca !== 'sim') semLic++; if (pendencias(u, hoje).length) comPend++;
    if (u.uf) { const x = porUf[u.uf] ||= { uf: u.uf, unidades: 0, pendentes: 0 }; x.unidades++; if (pendencias(u, hoje).length) x.pendentes++; }
  }
  return { total: unidades.length, ativas: ativas.length, vencidos: venc, criticos: crit, semRt, semLicenca: semLic, comPendencia: comPend, conformes: ativas.length - comPend, necessitamRt: ativas.filter(u => u.necessitaRt === 'sim').length,
    porEtapa: ETAPAS.map(([k, n]) => ({ etapa: k, nome: n, qtd: porEtapa[k] || 0 })), porUf: Object.values(porUf).sort((a, b) => b.unidades - a.unidades) };
}
const comSituacao = (u, hoje) => ({ ...u, alertas: alertasUnidade(u, hoje), pendencias: pendencias(u, hoje) });

// Aviso por marco (D-60, D-30, ...): devolve o menor marco já atingido que ainda não foi avisado.
function avisoDevido(d, marcos, enviados) {
  const m = [...marcos].sort((a, b) => b - a);
  if (d < 0) return enviados.includes(-1) ? null : -1;
  const hit = m.filter(x => d <= x); if (!hit.length) return null;
  const menor = Math.min(...hit); return enviados.includes(menor) ? null : menor;
}

// ---------- esteira ----------
function mover(u, etapa, nota, quem, hoje) {
  if (!ETAPA_NOME[etapa]) throw bad('Etapa inválida.');
  if (etapa === u.etapa) throw bad('A unidade já está nesta etapa.');
  const n = { ...u, etapa, ativa: etapa !== 'desligado' };
  if (etapa === 'deferido') n.prazo = '';
  return { unidade: n, evento: { id: uid('ev'), unidadeId: u.id, data: hoje, de: u.etapa, para: etapa, nota: txt(nota, 300), por: txt(quem, 60) } };
}

// ---------- medição mensal ----------
const compOk = c => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(c))) throw bad('Competência inválida (use AAAA-MM).'); return c; };
function planejarMedicao({ unidades, competencia, valorPadrao, medidas, hoje }) {
  compOk(competencia);
  const feitas = new Set(medidas.filter(m => m.competencia === competencia).map(m => m.unidadeId));
  const itens = unidades.filter(u => u.ativa).map(u => {
    const valor = u.valorMensal != null ? u.valorMensal : valorPadrao;
    const motivo = feitas.has(u.id) ? 'Já medida nesta competência' : !valor || valor <= 0 ? 'Sem valor mensal definido' : '';
    return { unidadeId: u.id, bkn: u.bkn, nome: u.nome, uf: u.uf, valor: valor || 0, gerar: !motivo, motivo };
  });
  const g = itens.filter(i => i.gerar);
  return { competencia, itens, geram: g.length, total: Math.round(g.reduce((s, i) => s + i.valor, 0) * 100) / 100, ignoradas: itens.length - g.length };
}
const mesAnterior = hoje => { const [y, m] = hoje.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

// ---------- dados de demonstração (fictícios) ----------
function demoUnidades(hoje) {
  const add = n => { const d = new Date(hoje + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const cid = [['São Paulo', 'SP'], ['Campinas', 'SP'], ['Santos', 'SP'], ['Uberlândia', 'MG'], ['Juiz de Fora', 'MG'], ['Salvador', 'BA'], ['Curitiba', 'PR'], ['Recife', 'PE'], ['Porto Alegre', 'RS'], ['Fortaleza', 'CE']];
  const nomes = ['Unidade Shopping Centro', 'Unidade Avenida Norte', 'Unidade Aeroporto', 'Unidade Plaza', 'Unidade Terminal', 'Unidade Praça', 'Unidade Boulevard', 'Unidade Park', 'Unidade Rodoviária', 'Unidade Marginal', 'Unidade Orla', 'Unidade Campus'];
  const rts = ['Marina Souza', 'Carlos Lima', 'Patrícia Gomes', 'Renato Alves', 'Juliana Prado', 'Felipe Rocha'];
  const etapas = ['deferido', 'deferido', 'deferido', 'enviado', 'reenviado', 'em_analise', 'aguarda_licenca', 'aguardando', 'deferido', 'desligado', 'deferido', 'reenviado'];
  return nomes.map((n, i) => {
    const [cidade, uf] = cid[i % cid.length], etapa = etapas[i], semRt = i === 3 || i === 7;
    return validaUnidade({
      bkn: String(30001 + i), nome: `${n} ${cidade}`, cnpj: `99000000${String(1000 + i)}`, endereco: `Av. Exemplo, ${100 + i * 7}`, cidade, uf, cep: '01000000',
      licenca: i === 6 ? 'nao' : i === 7 ? 'pendente' : 'sim', licencaValidade: i === 1 ? add(-12) : i === 2 ? add(5) : i === 4 ? add(24) : i === 8 ? add(140) : add(60 + i * 20),
      necessitaRt: 'sim', visitas: [2, 4, 2, 1, 4, 2, 1, 2, 4, 2, 2, 4][i], etapa, prazo: etapa === 'deferido' || etapa === 'desligado' ? '' : add(i % 3 ? 10 : -4),
      rt: { nome: semRt ? '' : rts[i % rts.length], crn: semRt ? '' : `CRN-${(i % 5) + 2} ${20000 + i * 137}`, validade: i === 0 ? add(18) : semRt ? '' : add(200 - i * 9), anterior: i === 5 ? 'Camila Reis' : '' },
      previsaoVirada: i === 5 ? add(9) : i === 9 ? '' : i % 4 === 0 ? add(45) : '', valorMensal: [1200, 1200, 1450, 980, 1200, 1450, 980, 1200, 1450, 1200, 1200, 980][i],
      observacao: i === 7 ? 'Sem nutricionista no estado; buscar RT na região.' : '',
    });
  }).map((u, i) => ({ id: `bk_demo${i}`, ...u, demo: true }));
}

module.exports = { etapaDeTexto, ETAPAS, ETAPA_NOME, CRN, uid, validaUnidade, parseCsv, importarCsv, alertasUnidade, pendencias, resumo, comSituacao, avisoDevido, mover, planejarMedicao, compOk, mesAnterior, demoUnidades, dias };
