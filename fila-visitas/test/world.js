'use strict';
// Bitrix24 falso, em memória, só com o que o app usa.
const SEG = ['Motores', 'Peças', 'Serviços', 'Novos Negócios'];
function createWorld() {
  const w = { companies: {}, items: { 1032: {}, 1036: {} }, seq: 100, comments: [], notifs: [], tasks: [], users: {}, depts: [] };
  const companyFields = {};
  for (const s of SEG) for (const [k, l] of [['Diretor', 'Diretor Responsável'], ['Gerente', 'Gerente Responsável'], ['Coordenador', 'Coordenador Responsável'], ['Supervisor', 'Supervisor Responsável'], ['Vendedor', 'Vendedor Responsável'], ['Classe', 'Classe'], ['Proxima', 'Próxima Visita'], ['Ultima', 'Última Visita']]) {
    companyFields[`UF_CRM_${s.slice(0, 3).toUpperCase()}_${k.toUpperCase()}`] = { formLabel: `[${s}] ${l}`, type: k === 'Classe' ? 'enumeration' : 'string', items: k === 'Classe' ? [{ ID: '1', VALUE: 'A' }, { ID: '2', VALUE: 'B' }, { ID: '3', VALUE: 'C' }] : undefined };
  }
  w.companyFields = companyFields;
  const stages = [{ STATUS_ID: 'DT1036_1:NEW', NAME: 'Aguardando' }, { STATUS_ID: 'DT1036_1:DIA', NAME: 'Dia da Visita' }, { STATUS_ID: 'DT1036_1:LATE', NAME: 'Atrasada' }, { STATUS_ID: 'DT1036_1:DONE', NAME: 'Finalizado' }];
  w.stageList = stages;
  w.stages = { aguardando: 'DT1036_1:NEW', dia: 'DT1036_1:DIA', atrasada: 'DT1036_1:LATE', finalizado: 'DT1036_1:DONE' };
  const match = (it, filter = {}) => Object.entries(filter).every(([k, v]) => {
    if (Array.isArray(v)) return k.startsWith('!') ? !v.includes(it[k.slice(1)]) : v.includes(it[k]);
    if (k.startsWith('!')) return it[k.slice(1)] !== v;
    if (k.startsWith('>')) return String(it[k.slice(1)] || '') > String(v);
    return String(it[k]) === String(v);
  });
  w.call = async (method, p = {}) => {
    switch (method) {
      case 'crm.company.fields': return { result: companyFields };
      case 'crm.item.fields': {
        const base = p.entityTypeId === 1036
          ? { ufCrm_seg: { title: 'Segmento', type: 'string' }, ufCrm_cargo: { title: 'Cargo', type: 'string' }, ufCrm_classe: { title: 'Classe', type: 'string' }, ufCrm_data: { title: 'Data programada', type: 'date' } }
          : { ufCrm_setor: { title: 'Setor', type: 'string' }, ufCrm_fila: { title: 'ID da Fila', type: 'string' }, ufCrm_ant: { title: 'Antecipada', type: 'string' }, ufCrm_res: { title: 'Resultado ou observações', type: 'string', isRequired: true }, ufCrm_nota: { title: 'Nota do cliente', type: 'integer' }, ufCrm_ret: { title: 'Precisa retorno', type: 'boolean' }, ufCrm_dh: { title: 'Data/Hora da visita', type: 'datetime' } };
        return { result: { fields: { ...base, ...(w.extraFields?.[p.entityTypeId] || {}) } } };
      }
      case 'crm.category.list': return { result: { categories: [{ id: 1, isDefault: 'Y' }] } };
      case 'crm.status.list': return { result: stages };
      case 'crm.company.get': { const c = w.companies[p.id]; return { result: c ? { ...c } : null }; }
      case 'crm.company.list': return { result: Object.values(w.companies).filter(c => match(c, p.filter)).map(c => ({ ID: c.ID })) };
      case 'crm.company.update': Object.assign(w.companies[p.id], p.fields); return { result: true };
      case 'crm.item.get': return { result: { item: w.items[p.entityTypeId][p.id] } };
      case 'crm.item.list': { const l = Object.values(w.items[p.entityTypeId]).filter(i => match(i, p.filter)); return { result: { items: l.map(i => ({ ...i })) } }; }
      case 'crm.item.add': { const id = ++w.seq; const it = { id, createdTime: new Date().toISOString(), ...p.fields }; w.items[p.entityTypeId][id] = it; return { result: { item: { ...it } } }; }
      case 'crm.item.update': Object.assign(w.items[p.entityTypeId][p.id], p.fields); w.items[p.entityTypeId][p.id].updatedTime = new Date(Date.now() + 1000).toISOString(); return { result: { item: {} } };
      case 'crm.item.delete': delete w.items[p.entityTypeId][p.id]; return { result: [] };
      case 'user.get': if (p.ID) return { result: w.users[p.ID] ? [w.users[p.ID]] : [] }; return { result: Object.values(w.users) };
      case 'department.get': if (p.ID) return { result: w.depts.filter(d => String(d.ID) === String(p.ID)) }; return { result: w.depts };
      case 'crm.timeline.comment.add': w.comments.push(p.fields); return { result: 1 };
      case 'im.notify.system.add': w.notifs.push(p); return { result: 1 };
      case 'tasks.task.add': w.tasks.push(p.fields); return { result: { task: { id: 1 } } };
      default: throw new Error('método não suportado no mock: ' + method);
    }
  };
  w.empresa = (id, nome, props) => { w.companies[id] = { ID: String(id), TITLE: nome, ...props }; return w.companies[id]; };
  w.users = { 10: { ID: 10, NAME: 'Vera', LAST_NAME: 'Vendedora', UF_DEPARTMENT: [5] }, 20: { ID: 20, NAME: 'Gil', LAST_NAME: 'Gerente', UF_DEPARTMENT: [5] }, 30: { ID: 30, NAME: 'Dora', LAST_NAME: 'Diretora', UF_DEPARTMENT: [1] } };
  w.depts = [{ ID: 1, NAME: 'Diretoria', UF_HEAD: '30' }, { ID: 5, NAME: 'Comercial', PARENT: '1', UF_HEAD: '20' }];
  return w;
}
module.exports = { createWorld };
