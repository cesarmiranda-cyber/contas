'use strict';
const R = require('./rules');

const ETYPE = { visita: 1032, fila: 1036 };
const CAMPOS_EMPRESA = {
  diretor: /diretor/, gerente: /gerente/, coordenador: /coordenador/, supervisor: /supervisor/, vendedor: /vendedor/,
  classe: /\bclasse\b/, proxima: /proxima visita/, ultima: /ultima visita/,
};
const label = f => {
  const v = f.formLabel || f.listLabel || f.EDIT_FORM_LABEL || f.LIST_COLUMN_LABEL || f.title || '';
  return typeof v === 'object' ? String(Object.values(v)[0] || '') : String(v);
};
const enumItems = f => (f.items || f.ENUM || []).map(i => ({ id: String(i.ID ?? i.id), value: String(i.VALUE ?? i.value ?? i.title ?? '') }));

// Descobre os códigos técnicos pelos nomes (rótulos) dos campos. Devolve o mapa, o que faltou e o que ficou ambíguo.
async function descobrir(bitrix, cfg) {
  const faltando = [], ambiguos = [];
  const ef = (await bitrix.call('crm.company.fields')).result || {};
  const empresaMeta = {};
  const empresa = {}, alt = {};
  for (const seg of R.SEGMENTOS) {
    empresa[seg] = {}; alt[seg] = {};
    const ns = R.norm(seg);
    const cands = Object.entries(ef).filter(([k, f]) => k.startsWith('UF_CRM') && R.norm(label(f)).includes(ns));
    for (const [campo, re] of Object.entries(CAMPOS_EMPRESA)) {
      let m = cands.filter(([, f]) => re.test(R.norm(label(f))));
      if (campo === 'proxima' || campo === 'ultima') {
        // Motores tem campos extras ("Data Próxima Visita"/"Última Visita") que duplicam os da seção
        const extra = m.filter(([, f]) => /^data /.test(R.norm(label(f)).replace(ns, '').trim()) || /data proxima/.test(R.norm(label(f))));
        if (m.length > 1 && seg === 'Motores') {
          const pref = cfg.motoresDatas === 'extra' ? extra : m.filter(x => !extra.includes(x));
          if (pref.length) m = pref;
        }
      }
      if (campo === 'diretor' || campo === 'gerente' || campo === 'coordenador' || campo === 'supervisor' || campo === 'vendedor') m = m.filter(([, f]) => !/classe|visita/.test(R.norm(label(f))));
      // campos com o mesmo nome: o app lê os dois (usa o que tiver valor) e grava no primeiro
      if (m.length > 1) { alt[seg][campo] = m.slice(1).map(([k]) => k); ambiguos.push({ onde: `Empresa ${seg} ${campo}`, opcoes: m.map(([k, f]) => `${k} (${label(f)})`) }); }
      for (const [k, f] of m) empresaMeta[k] = { tipo: f.type, itens: enumItems(f) };
      if (m[0]) empresa[seg][campo] = m[0][0];
      else faltando.push(`Empresa · ${seg} · ${campo}`);
    }
  }
  const tipoEmp = Object.entries(ef).find(([k, f]) => k.startsWith('UF_CRM') && /tipo.*empresa|segmento.*empresa|industrial/.test(R.norm(label(f))));
  if (tipoEmp) empresaMeta[tipoEmp[0]] = { tipo: tipoEmp[1].type, itens: enumItems(tipoEmp[1]) };

  const itemMap = async (et, wanted) => {
    const fs = (await bitrix.call('crm.item.fields', { entityTypeId: et })).result?.fields || {};
    const out = {}, meta = {};
    for (const [nome, re] of Object.entries(wanted)) {
      const m = Object.entries(fs).find(([k, f]) => k.startsWith('ufCrm') && re.test(R.norm(f.title || f.formLabel || '')));
      if (m) { out[nome] = m[0]; meta[m[0]] = { tipo: m[1].type, itens: enumItems(m[1]) }; }
    }
    return { out, meta, fs };
  };
  const fila = await itemMap(ETYPE.fila, { segmento: /segmento|setor/, cargo: /cargo/, classe: /classe/, data: /data (programada|prevista)|programada/ });
  const visita = await itemMap(ETYPE.visita, {
    segmento: /setor|segmento/, filaId: /id da fila|fila/, antecipada: /antecipad/, resultado: /resultado|observac|conclus/,
    acompanhamento: /acompanhamento/, dataHora: /data.*(hora|visita)/, responsavel: /responsavel|vendedor/,
  });

  // etapas do kanban da fila (categoria padrão)
  const cats = (await bitrix.call('crm.category.list', { entityTypeId: ETYPE.fila })).result?.categories || [];
  const cat = cats.find(c => c.isDefault === 'Y' || c.isDefault === true) || cats[0];
  const categoriaFila = cat ? +cat.id : 0;
  const st = (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: `DYNAMIC_${ETYPE.fila}_STAGE_${categoriaFila}` } })).result || [];
  const etapas = {};
  for (const s of st) {
    const n = R.norm(s.NAME);
    if (/dia da visita|hoje/.test(n)) etapas.dia = s.STATUS_ID;
    else if (/atrasad/.test(n)) etapas.atrasada = s.STATUS_ID;
    else if (!etapas.aguardando && /aguard|nova|novo|fila|programad/.test(n)) etapas.aguardando = s.STATUS_ID;
  }
  // etapa final: a coluna que o time usa ("Encerrado"); senão "Finalizado"/similar; senão a etapa de sucesso do Bitrix
  const porNome = re => st.find(s => re.test(R.norm(s.NAME)) && s.SEMANTICS !== 'F');
  const final = porNome(/encerr/) || porNome(/finaliz|conclu|fechad|realizad/) || st.find(s => s.SEMANTICS === 'S');
  if (final) etapas.finalizado = final.STATUS_ID;
  // etapas "fechadas": qualquer card nelas não é mais uma visita em aberto
  const sucesso = st.filter(s => s.SEMANTICS === 'S').map(s => s.STATUS_ID);
  etapas.concluidas = [...new Set([etapas.finalizado, ...sucesso].filter(Boolean))];
  etapas.fechadas = [...new Set([...etapas.concluidas, ...st.filter(s => s.SEMANTICS === 'F').map(s => s.STATUS_ID)])];
  etapas.abertas = st.map(s => s.STATUS_ID).filter(x => !etapas.fechadas.includes(x)); // o Bitrix não aceita "não está em" com lista: filtra pelas abertas
  if (!etapas.aguardando && st[0]) etapas.aguardando = st[0].STATUS_ID;
  for (const e of ['aguardando', 'dia', 'atrasada', 'finalizado']) if (!etapas[e]) faltando.push(`Etapa da fila · ${e} (crie a etapa no kanban 1036)`);
  if (!fila.out.data) faltando.push('Fila · Data programada (usando "Data de encerramento" padrão)');
  if (!visita.out.dataHora) faltando.push('Registro · Data/Hora da visita (usando "Data de início" padrão)');

  const map = { empresa, alt, fila: fila.out, visita: visita.out, etapas, categoriaFila, tipoEmpresa: tipoEmp?.[0] || null };
  // sobrescritas manuais da tela de configurações
  const man = cfg.mapaManual || {};
  for (const k of ['fila', 'visita', 'etapas']) Object.assign(map[k], man[k] || {});
  for (const seg of R.SEGMENTOS) Object.assign(map.empresa[seg], (man.empresa || {})[seg] || {});
  if (man.tipoEmpresa) map.tipoEmpresa = man.tipoEmpresa;
  return { map, meta: { ...empresaMeta, ...fila.meta, ...visita.meta }, faltando, ambiguos, em: new Date().toISOString() };
}

// Valor de enumeração: converte texto <-> id quando o campo é lista.
const encode = (meta, k, texto) => {
  const it = meta[k]?.itens;
  if (!it || !it.length) return texto;
  const t = R.norm(texto);
  return (it.find(i => R.norm(i.value) === t) || {}).id ?? texto;
};
const decode = (meta, k, v) => {
  const it = meta[k]?.itens;
  if (v === null || v === undefined || v === '') return '';
  if (!it || !it.length) return String(v);
  return (it.find(i => i.id === String(v)) || {}).value ?? String(v);
};
module.exports = { descobrir, encode, decode, ETYPE, label };
