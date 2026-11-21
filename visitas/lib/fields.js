'use strict';
// Descoberta de tudo por RÓTULO: o app não depende dos códigos UF_* do Bitrix (que mudam de portal para portal).
const { norm, CARGOS } = require('./rules');
const ETYPE = { visita: +process.env.SPA_VISITA || 1032, fila: +process.env.SPA_FILA || 1036 };

const label = f => String(f?.formLabel || f?.listLabel || f?.title || f?.EDIT_FORM_LABEL || '').trim();
const A = v => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

// Campos da empresa -> { segmentos: { chave: { nome, cargos:{Vendedor:[campos]}, classe:[campos], proxima:[campos], ultima:[campos] } }, enums }
function mapearEmpresa(fields) {
  const segs = {}, enums = {}, rotulos = {};
  const seg = nome => (segs[norm(nome)] ||= { nome: nome.trim(), cargos: {}, classe: [], proxima: [], ultima: [] });
  for (const [campo, f] of Object.entries(fields || {})) {
    if (!/^UF_/.test(campo)) continue;
    const l = label(f), n = norm(l); rotulos[campo] = l;
    if (f.items) enums[campo] = Object.fromEntries(f.items.map(i => [String(i.ID), i.VALUE]));
    let m;
    if ((m = l.match(/^\[(.+?)\]\s*(.+)$/))) {
      const s = seg(m[1]), r = norm(m[2]);
      const cargo = CARGOS.find(c => r.startsWith(norm(c)));
      if (cargo) (s.cargos[cargo] ||= []).push(campo);
      else if (/proxima visita/.test(r)) s.proxima.push(campo);
      else if (/ultima visita/.test(r)) s.ultima.push(campo);
      else if (/^classe/.test(r)) s.classe.push(campo);
    } else if ((m = n.match(/^classe\s+(.+)$/))) {
      seg(l.replace(/^classe\s+/i, '')).classe.push(campo);
    }
  }
  for (const k of Object.keys(segs)) if (!segs[k].classe.length && !Object.keys(segs[k].cargos).length) delete segs[k];
  return { segmentos: segs, enums, rotulos };
}

// Procura campo de SPA por rótulo (regex sobre o texto normalizado). Devolve a chave (camelCase do crm.item).
function achar(fields, re) {
  return Object.entries(fields || {}).filter(([, f]) => re.test(norm(label(f)))).map(([k]) => k);
}
const FILA_CAMPOS = {
  segmento: /^segmento$/, cargo: /^(cargo|alcada)$/, classe: /^classe$/, usuario: /^usuario$/, idEmpresa: /^id (da )?empresa$/, data: /^data programada$/,
  motivo: /^motivo da nao realizacao$/, detalhe: /^detalhe do motivo$/, vendedor: /^vendedor$/, alcada: /^alcada$/,
};
const VISITA_CAMPOS = {
  data: /^data\/?\s*hora da visita$|^data da visita$/, fatos: /^fatos e dados$/, interesses: /^interesses$/, sentimentos: /^sentimentos$/, valores: /^valores$/,
  populacao: /^populacao de motores$/, regime: /^regime de trabalho$/, oportunidades: /^mapeamento de oportunidades futuras$/, antecipada: /^reuniao antecipada\??$/,
  segmento: /^segmento$/, idFila: /^id fila$/, resultado: /^resultado/, acompanhamento: /^acompanhamento$/, anexos: /^anexos$/, supervisor: /^supervisor que acompanhou$/,
  alcada: /^alcada$/, lead: /^lead$/,
};
// Segunda tentativa (só campos personalizados ainda não usados): rótulos parecidos com o esperado.
const VISITA_LOOSE = { data: /data.*(hora|visita)|^data$/, fatos: /fatos/, interesses: /interess/, sentimentos: /sentiment/, valores: /valores?/, populacao: /popula/, regime: /regime/, oportunidades: /oportunidade/,
  antecipada: /antecipad/, segmento: /segmento/, idFila: /id.*fila|fila.*id|^fila$/, resultado: /resultado|observac/, acompanhamento: /acompanhament/, anexos: /anexo|arquivo/, supervisor: /supervisor/, alcada: /alcad/, lead: /^lead/ };
const VISITA_AJUSTAVEIS = Object.keys(VISITA_CAMPOS);
function mapearVisita(vf, mapa) {
  const out = {}, usados = new Set();
  for (const [k, re] of Object.entries(VISITA_CAMPOS)) { const c = achar(vf, re)[0]; if (c) { out[k] = c; usados.add(c); } }
  for (const [k, re] of Object.entries(VISITA_LOOSE)) if (!out[k]) { const c = achar(vf, re).find(x => !usados.has(x) && /^uf/i.test(x)); if (c) { out[k] = c; usados.add(c); } }
  for (const k of VISITA_AJUSTAVEIS) if (mapa?.visita?.[k] && vf[mapa.visita[k]]) out[k] = mapa.visita[k];     // ajuste manual do administrador
  for (const k of VISITA_AJUSTAVEIS) { out[k] ||= null; out[`${k}_todos`] = out[k] ? [out[k]] : []; }
  return out;
}
const FILA_OBRIG = ['segmento', 'cargo', 'classe', 'data'];
const VISITA_OBRIG = ['data', 'fatos', 'idFila', 'segmento'];

function mapear(fields, defs) {
  const out = {};
  for (const [k, re] of Object.entries(defs)) { const r = achar(fields, re); out[k] = r[0] || null; out[`${k}_todos`] = r; }
  return out;
}
const enumMap = f => Object.fromEntries((f?.items || []).map(i => [String(i.ID), i.VALUE]));

const STAGE_NOMES = [
  ['NEW', /^aguardando/], ['PREPARATION', /^dia da visita/], ['LATE', /^atrasad/], ['ENC', /^encerrad/], ['NAOREAL', /^nao realizad/], ['SUCCESS', /^finalizad/], ['FAIL', /^removid/],
];

// "Data programada" com rótulo diferente: tenta rótulos parecidos, depois qualquer campo de data do SPA, depois begindate/closedate.
function acharData(ff) {
  const c = Object.entries(ff || {}).map(([k, f]) => [k, norm(label(f)), String(f.type || '')]);
  const uf = k => /^uf/i.test(k);
  return c.find(([, n]) => /^data (programada|da visita|agendada|prevista|de visita|proxima visita)|programad/.test(n))?.[0]
    || c.find(([k, n]) => uf(k) && /data/.test(n) && /(visita|program|agend|previst)/.test(n))?.[0]
    || c.find(([k, , t]) => uf(k) && /^date/.test(t))?.[0]
    || ['begindate', 'closedate'].find(k => ff[k]) || null;
}
const CAMPOS_AJUSTAVEIS = ['data', 'vendedor', 'segmento', 'classe', 'cargo', 'motivo', 'detalhe', 'alcada', 'usuario', 'idEmpresa'];

async function descobrir(bx, mapa = {}) {
  const [emp, fila, visita, cats] = await Promise.all([
    bx.call('crm.company.fields'), bx.call('crm.item.fields', { entityTypeId: ETYPE.fila }), bx.call('crm.item.fields', { entityTypeId: ETYPE.visita }),
    bx.call('crm.category.list', { entityTypeId: ETYPE.fila }).catch(() => ({ result: { categories: [] } })),
  ]);
  const empresa = mapearEmpresa(emp.result);
  const ff = fila.result?.fields || fila.result || {}, vf = visita.result?.fields || visita.result || {};
  const categorias = cats.result?.categories || [];
  const cat = categorias.find(c => +c.id === 19) || categorias.find(c => /fila/i.test(c.name)) || categorias[0];
  const categoryId = cat ? +cat.id : 19;
  let stages = [];
  try { stages = (await bx.call('crm.status.list', { filter: { ENTITY_ID: `DYNAMIC_${ETYPE.fila}_STAGE_${categoryId}` } })).result || []; } catch { /* sem escopo */ }
  const etapas = {}, etapaNomes = {};
  const SUFIXO = { NEW: 'NEW', PREPARATION: 'PREPARATION', LATE: 'LATE', UC_EFR0YE: 'ENC', NAOREAL: 'NAOREAL', SUCCESS: 'SUCCESS', FAIL: 'FAIL' };
  for (const s of stages) {
    etapaNomes[s.STATUS_ID] = s.NAME;
    const cod0 = SUFIXO[String(s.STATUS_ID).split(':').pop()];
    if (cod0 && !etapas[cod0]) etapas[cod0] = s.STATUS_ID;
    const n = norm(s.NAME);
    for (const [cod, re] of STAGE_NOMES) if (re.test(n) && !etapas[cod]) etapas[cod] = s.STATUS_ID;
    if (s.SEMANTICS === 'S' && !etapas.SUCCESS) etapas.SUCCESS = s.STATUS_ID;
    if (s.SEMANTICS === 'F' && !etapas.FAIL) etapas.FAIL = s.STATUS_ID;
  }
  // O SPA pode ter só 4 etapas (Aguardando, Dia da Visita, Finalizado, Removido): Finalizado é a etapa de conclusão;
  // sem etapa "Atrasada", o atraso fica em "Dia da Visita" (o app mostra como atrasada pela data); sem "Não realizada", o app não marca nem gera nada sozinho.
  if (!etapas.ENC && etapas.SUCCESS) etapas.ENC = etapas.SUCCESS;
  if (!etapas.LATE && etapas.PREPARATION) etapas.LATE = etapas.PREPARATION;
  const filaMap = mapear(ff, FILA_CAMPOS);
  if (!filaMap.data) filaMap.data = acharData(ff);
  for (const k of CAMPOS_AJUSTAVEIS) if (mapa?.fila?.[k] && ff[mapa.fila[k]]) filaMap[k] = mapa.fila[k];   // ajuste manual do administrador
  const m = {
    empresa, categoryId, etapas, etapaNomes,
    fila: { ...filaMap, motivoEnum: enumMap(ff[filaMap.motivo]) },
    disponiveis: { visita: Object.entries(vf).filter(([k]) => /^uf/i.test(k)).map(([key, f]) => ({ key, label: label(f) || key, type: String(f.type || '') })).sort((a, b) => a.label.localeCompare(b.label)), fila: Object.entries(ff).map(([key, f]) => ({ key, label: label(f) || key, type: String(f.type || '') })).sort((a, b) => a.label.localeCompare(b.label)) },
    visita: (() => { const v = mapearVisita(vf, mapa); return { ...v, ...Object.fromEntries(['regime', 'oportunidades', 'antecipada', 'acompanhamento', 'alcada'].map(k => [`${k}Enum`, enumMap(vf[v[k]])])) }; })(),
    filaFields: ff, visitaFields: vf,
  };
  m.etapaReal = { LATE: etapas.LATE !== etapas.PREPARATION, NAOREAL: !!etapas.NAOREAL, ENC: etapas.ENC !== etapas.SUCCESS };   // false = a etapa não existe de fato no SPA
  m.faltando = [
    ...Object.keys(empresa.segmentos).length ? [] : ['Empresa: nenhum segmento encontrado (campos "[Motores] Vendedor Responsável", "Classe Motores"...)'],
    ...FILA_OBRIG.filter(k => !m.fila[k]).map(k => `Fila (SPA ${ETYPE.fila}): campo "${k}"`),
    ...['NEW', 'PREPARATION', 'ENC', 'FAIL'].filter(c => !etapas[c]).map(c => `Fila: etapa ${c}`),
    ...VISITA_OBRIG.filter(k => !m.visita[k]).map(k => `Registro (SPA ${ETYPE.visita}): campo "${k}"`),
  ];
  return m;
}
module.exports = { VISITA_AJUSTAVEIS, CAMPOS_AJUSTAVEIS, ETYPE, descobrir, mapearEmpresa, achar, label, A, enumMap, FILA_CAMPOS, VISITA_CAMPOS, STAGE_NOMES };
