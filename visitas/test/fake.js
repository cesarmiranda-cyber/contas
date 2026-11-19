'use strict';
// Bitrix simulado em memória (só o que o app usa).
function criarFake() {
  const s = { empresas: [], contatos: [], itens: { 1036: [], 1032: [] }, prox: 1, chamadas: [], tarefas: [] };
  const lab = (title, extra = {}) => ({ title, formLabel: title, ...extra });
  const empresaFields = {
    UF_V: lab('[Motores] Vendedor Responsável'), UF_G: lab('[Motores] Gerente Responsável'),
    UF_C: lab('Classe Motores', { items: [{ ID: '1', VALUE: 'A' }, { ID: '2', VALUE: 'B' }, { ID: '3', VALUE: 'C' }, { ID: '4', VALUE: 'Clientes Estratégicos' }] }),
    UF_P: lab('[Motores] Data Próxima Visita'), UF_U: lab('[Motores] Última Visita'), UF_P2: lab('[Motores] Data Próxima Visita'),
  };
  const filaFields = {
    ufSeg: lab('Segmento'), ufCargo: lab('Cargo'), ufClasse: lab('Classe'), ufData: lab('Data programada'),
    ufMotivo: lab('Motivo da não realização', { items: [{ ID: '10', VALUE: 'Cliente pediu para remarcar' }, { ID: '11', VALUE: 'Outro motivo' }] }), ufDet: lab('Detalhe do motivo'),
  };
  const visitaFields = { ufData: lab('Data/Hora da Visita'), ufFatos: lab('Fatos e dados'), ufInt: lab('Interesses'), ufIdFila: lab('ID Fila'), ufSeg: lab('Segmento'), ufSup: lab('Supervisor que acompanhou') };
  const status = [['NEW', 'Aguardando'], ['PREPARATION', 'Dia da visita'], ['LATE', 'Atrasada'], ['UC_EFR0YE', 'Encerrado'], ['NAOREAL', 'Não realizada'], ['SUCCESS', 'Finalizado', 'S'], ['FAIL', 'Removido', 'F']]
    .map(([id, NAME, SEMANTICS]) => ({ STATUS_ID: `DT1036_19:${id}`, NAME, SEMANTICS: SEMANTICS || '' }));
  const casa = (it, filter = {}) => Object.entries(filter).every(([k, v]) => v === undefined || (Array.isArray(v) ? v.map(String).includes(String(it[k])) : String(it[k]) === String(v)));
  const handlers = {
    'crm.company.fields': () => ({ result: empresaFields }),
    'crm.item.fields': p => ({ result: { fields: +p.entityTypeId === 1036 ? filaFields : visitaFields } }),
    'crm.category.list': () => ({ result: { categories: [{ id: 19, name: 'Fila' }] } }),
    'crm.status.list': () => ({ result: status }),
    'crm.company.list': p => ({ result: s.empresas.filter(e => casa({ ID: e.ID }, p.filter)) }),
    'crm.company.update': p => { Object.assign(s.empresas.find(e => e.ID == p.id), p.fields); return { result: true }; },
    'crm.contact.list': () => ({ result: s.contatos }),
    'crm.item.list': p => ({ result: { items: s.itens[p.entityTypeId].filter(i => casa(i, p.filter)) } }),
    'crm.item.get': p => { const it = s.itens[p.entityTypeId].find(i => i.id == p.id); if (!it) { const e = { error: 'NOT_FOUND', error_description: 'x' }; return e; } return { result: { item: it } }; },
    'crm.item.add': p => { const it = { id: s.prox++, createdBy: '7', createdTime: '2026-11-18', ...p.fields }; s.itens[p.entityTypeId].push(it); return { result: { item: { id: it.id } } }; },
    'crm.item.update': p => { Object.assign(s.itens[p.entityTypeId].find(i => i.id == p.id), p.fields); return { result: { item: {} } }; },
    'user.get': () => ({ result: [{ ID: '7', NAME: 'Vera', LAST_NAME: 'Vendedora' }, { ID: '9', NAME: 'Sérgio', LAST_NAME: 'Supervisor' }] }),
    'department.get': () => ({ result: [{ ID: '1', NAME: 'Comercial', PARENT: '', UF_HEAD: '9' }] }),
    'tasks.task.add': p => { s.tarefas.push(p.fields); return { result: { task: { id: 500 + s.tarefas.length } } }; },
    'tasks.task.complete': () => ({ result: true }),
    'crm.status.add': () => ({ result: 1 }), 'userfieldconfig.add': () => ({ result: 1 }),
  };
  const bx = {
    enabled: true,
    async call(m, p = {}) { s.chamadas.push(m); const h = handlers[m]; if (!h) throw new Error(`fake: ${m}`); const r = h(p); if (r.error) { const e = new Error(r.error); e.code = r.error; throw e; } return r; },
    async listAll(m, p) { const r = await bx.call(m, p); return Array.isArray(r.result) ? r.result : r.result.items; },
  };
  return { bx, s };
}
module.exports = { criarFake };
