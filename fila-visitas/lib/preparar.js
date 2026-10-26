'use strict';
const R = require('./rules');
const F = require('./fields');

// Cria no Bitrix o que o app precisa e ainda não existe: etapa "Atrasada" da Fila e os campos de Cargo,
// Data programada (1036) e Resultado/Acompanhamento (1032). Idempotente: só cria o que falta.
async function preparar(bitrix, svc) {
  const d = await svc.campos(true);
  const feito = [], erros = [];
  const cat = d.map.categoriaFila;
  if (!d.map.etapas.atrasada) {
    try {
      const st = (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: `DYNAMIC_${F.ETYPE.fila}_STAGE_${cat}` } })).result || [];
      const dia = st.find(s => s.STATUS_ID === d.map.etapas.dia), fin = st.find(s => s.STATUS_ID === d.map.etapas.finalizado);
      const sort = dia && fin ? Math.round((+dia.SORT + +fin.SORT) / 2) : 500;
      await bitrix.call('crm.status.add', { fields: { ENTITY_ID: `DYNAMIC_${F.ETYPE.fila}_STAGE_${cat}`, STATUS_ID: `DT${F.ETYPE.fila}_${cat}:LATE`, NAME: 'Atrasada', SORT: sort, COLOR: '#FF5752' } });
      feito.push('Etapa "Atrasada" criada no kanban 1036');
    } catch (e) { erros.push(`Etapa Atrasada: ${e.message}`); }
  }
  if (!d.map.etapas.naoRealizada) {
    try {
      const st = (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: `DYNAMIC_${F.ETYPE.fila}_STAGE_${cat}` } })).result || [];
      const fim = st.find(s => s.STATUS_ID === d.map.etapas.finalizado);
      await bitrix.call('crm.status.add', { fields: { ENTITY_ID: `DYNAMIC_${F.ETYPE.fila}_STAGE_${cat}`, STATUS_ID: `DT${F.ETYPE.fila}_${cat}:NAOREAL`, NAME: 'Não realizada', SORT: fim ? +fim.SORT + 5 : 600, COLOR: '#94A3B8' } });
      feito.push('Etapa "Não realizada" criada no kanban 1036');
    } catch (e) { erros.push(`Etapa Não realizada: ${e.message}`); }
  }
  const criar = async (entityId, tipo, nome, tipoCampo, titulo, extra = {}) => {
    try {
      await bitrix.call('userfieldconfig.add', { moduleId: 'crm', field: { entityId, fieldName: `UF_${entityId}_${nome}`, userTypeId: tipoCampo, editFormLabel: { br: titulo, en: titulo }, listColumnLabel: { br: titulo, en: titulo }, listFilterLabel: { br: titulo, en: titulo }, mandatory: 'N', showFilter: 'N', ...extra } });
      feito.push(`${tipo}: campo "${titulo}" criado`);
    } catch (e) { erros.push(`${tipo} · ${titulo}: ${e.message}`); }
  };
  const fila = F.ETYPE.fila, vis = F.ETYPE.visita;
  const eFila = `CRM_${(d.map.fila.segmento || '').match(/^ufCrm(\d+)_/)?.[1] || 11}`, eVis = `CRM_${(d.map.visita.segmento || '').match(/^ufCrm(\d+)_/)?.[1] || 9}`;
  if (!d.map.fila.cargo) await criar(eFila, 'Fila', 'CARGO', 'string', 'Cargo');
  if (!d.map.fila.data) await criar(eFila, 'Fila', 'DATA_PROGRAMADA', 'date', 'Data programada');
  if (!d.map.visita.resultado) await criar(eVis, 'Registro', 'RESULTADO', 'string', 'Resultado / observações', { settings: { ROWS: 5 } });
  if (!d.map.visita.acompanhamento) await criar(eVis, 'Registro', 'ACOMPANHAMENTO', 'string', 'Acompanhamento');
  // Anexo do registro: o campo "Anexo" existente é de TEXTO e não guarda arquivo. Cria um campo de ARQUIVO (múltiplo).
  try {
    const defs = (await bitrix.call('crm.item.fields', { entityTypeId: vis })).result?.fields || {};
    if (!Object.values(defs).some(x => x.type === 'file')) await criar(eVis, 'Registro', 'ANEXOS', 'file', 'Anexos', { multiple: 'Y' });
  } catch (e) { erros.push(`Registro · Anexos: ${e.message}`); }
  const depois = await svc.campos(true);
  return { feito, erros, faltando: depois.faltando };
}
module.exports = { preparar };
