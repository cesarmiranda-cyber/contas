'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../lib/rules');
const { createStore } = require('../lib/store'); const { createService } = require('../lib/service'); const { criarFake } = require('./fake');

const vendedor = { id: '7', nome: 'Vera', papel: 'usuario', config: false };
const admin = { id: '1', nome: 'Admin', papel: 'admin', config: true };
function mundo() {
  const f = criarFake(), store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vis-')));
  store.setConfig({ ativo: true, exigirUltimaVisita: false });
  f.s.empresas.push(
    { ID: '100', TITLE: 'Alfa Motores', UF_V: '7', UF_C: '1', UF_P: '', UF_U: '' },
    { ID: '101', TITLE: 'Beta Diesel', UF_V: '7', UF_C: '2' },
    { ID: '102', TITLE: 'Gama sem classe', UF_V: '7', UF_C: '' },
    { ID: '103', TITLE: 'Delta sem vendedor', UF_V: '', UF_C: '3' },
  );
  const svc = createService({ bitrix: f.bx, store, now: () => new Date('2026-11-18T15:00:00Z') });
  return { f, store, svc };
}
const fila = f => f.s.itens[1036];

test('sync cria um card por empresa+segmento+vendedor e é idempotente', async () => {
  const { f, svc } = mundo();
  const r = await svc.sync();
  assert.equal(r.criados, 2); assert.equal(fila(f).length, 2);
  assert.ok(fila(f).every(c => c.ufData >= '2026-11-23' && c.stageId === 'DT1036_19:NEW' && c.assignedById === '7'));
  assert.equal(f.s.empresas[0].UF_P, fila(f)[0].ufData);        // grava próxima visita no cadastro (primeiro campo duplicado)
  svc.invalidar(); const r2 = await svc.sync();
  assert.equal(r2.criados, 0); assert.equal(fila(f).length, 2);
});
test('sem a fila ativa só mostra a prévia, sem gravar', async () => {
  const { f, store, svc } = mundo(); store.setConfig({ ativo: false });
  const r = await svc.sync(); assert.equal(r.previa, true); assert.equal(r.criados, 2); assert.equal(fila(f).length, 0);
});
test('empresa que perde a classe tem o card removido', async () => {
  const { f, svc } = mundo(); await svc.sync();
  f.s.empresas[1].UF_C = ''; svc.invalidar(); const r = await svc.sync();
  assert.equal(r.removidos, 1); assert.equal(fila(f).find(c => c.companyId == 101).stageId, 'DT1036_19:FAIL');
});
test('registrar encerra o card, atualiza o cadastro e gera o próximo', async () => {
  const { f, svc } = mundo(); await svc.sync();
  const card = fila(f).find(c => c.companyId == 100);
  await assert.rejects(svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: '' }, vendedor), /Fatos e dados/);
  await assert.rejects(svc.registrar(card.id, { dataHora: '2027-01-01T10:00', fatos: 'x' }, vendedor), /futuro/);
  const r = await svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'Visita ok', contatos: [5] }, vendedor);
  assert.equal(card.stageId, 'DT1036_19:UC_EFR0YE');
  const reg = f.s.itens[1032][0]; assert.equal(reg.ufIdFila, String(card.id)); assert.deepEqual(reg.contactIds, [5]);
  assert.equal(f.s.empresas[0].UF_U, '2026-11-18'); assert.equal(f.s.empresas[0].UF_P, '2026-12-18');   // classe A = 30 dias
  const novo = fila(f).find(c => c.id === r.proximoCard); assert.equal(novo.ufData, '2026-12-18'); assert.equal(novo.stageId, 'DT1036_19:NEW');
  await assert.rejects(svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'x' }, vendedor), /não está aberto/);
  svc.invalidar(); await svc.sync(); assert.equal(fila(f).filter(c => c.companyId == 100).length, 2);   // não duplica
});
test('reprogramar exige motivo (classe E é livre) e permite reverter', async () => {
  const { f, svc, store } = mundo(); await svc.sync();
  const card = fila(f).find(c => c.companyId == 100), antes = card.ufData;
  await assert.rejects(svc.reprogramar(card.id, { data: '2026-12-10' }, vendedor), /motivo/);
  await assert.rejects(svc.reprogramar(card.id, { data: '2026-11-01', motivo: 'x' }, vendedor), /passado/);
  await svc.reprogramar(card.id, { data: '2026-12-10', motivo: 'Cliente viajando' }, vendedor);
  assert.equal(card.ufData, '2026-12-10'); assert.equal(store.historico[0].motivo, 'Cliente viajando');
  await svc.reverter(card.id, vendedor); assert.equal(card.ufData, antes);
  f.s.empresas[1].UF_C = '4'; svc.invalidar(); await svc.sync();
  const e = fila(f).find(c => c.companyId == 101); assert.equal(e.ufClasse, 'Clientes Estratégicos');
});
test('não realizada: motivo obrigatório, gera tarefa e próximo card', async () => {
  const { f, svc, store } = mundo(); store.setConfig({ tarefaAtiva: true }); await svc.sync();
  const card = fila(f).find(c => c.companyId == 100);
  await assert.rejects(svc.naoRealizada(card.id, {}, vendedor), /motivo/);
  const r = await svc.naoRealizada(card.id, { motivo: 'Cliente pediu para remarcar', detalhe: 'ligou' }, vendedor);
  assert.equal(card.stageId, 'DT1036_19:NAOREAL'); assert.equal(card.ufMotivo, '10'); assert.equal(f.s.tarefas.length, 1); assert.ok(r.proximoCard);
});
test('mês vencido sem visita vira Não realizada na varredura', async () => {
  const { f, svc } = mundo(); await svc.sync();
  const card = fila(f).find(c => c.companyId == 100); card.ufData = '2026-10-20'; card.stageId = 'DT1036_19:LATE'; svc.invalidar();
  const r = await svc.varrer(); assert.equal(r.ajustados, 1); assert.equal(card.stageId, 'DT1036_19:NAOREAL');
  assert.ok(fila(f).some(c => c.companyId == 100 && c.stageId !== 'DT1036_19:NAOREAL'));
});
test('exclusão só para autorizados; restaurar volta o card', async () => {
  const { f, svc, store } = mundo(); await svc.sync();
  const card = fila(f).find(c => c.companyId == 100);
  await assert.rejects(svc.excluir(card.id, {}, vendedor), /pode excluir/);
  store.setConfig({ podeExcluir: ['7'] });
  await svc.excluir(card.id, { gerarProxima: false }, vendedor); assert.equal(card.stageId, 'DT1036_19:FAIL');
  await svc.restaurar(card.id, vendedor); assert.equal(card.stageId, 'DT1036_19:NEW');
});
test('vendedor só vê o que é seu; supervisor (chefe do departamento) vê a equipe', async () => {
  const { f, svc } = mundo(); f.s.empresas.push({ ID: '104', TITLE: 'Épsilon', UF_V: '8', UF_C: '1' }); await svc.sync();
  const outro = { id: '8', nome: 'Outro', papel: 'usuario' };
  assert.deepEqual((await svc.listar(vendedor, { de: '2026-11-01', ate: '2027-12-31' })).itens.map(i => i.empresa).sort(), ['Alfa Motores', 'Beta Diesel']);
  assert.equal((await svc.listar(admin, { de: '2026-11-01', ate: '2027-12-31' })).itens.length, 3);
  await assert.rejects(svc.registrar(fila(f).find(c => c.companyId == 104).id, { dataHora: '2026-11-18', fatos: 'x' }, vendedor), /não é seu/);
  assert.equal((await svc.listar(outro, { de: '2026-11-01', ate: '2027-12-31' })).itens.length, 1);
});
test('campos descobertos por rótulo, com duplicados e sem faltas', async () => {
  const { svc } = mundo(); const i = await svc.camposInfo();
  assert.deepEqual(i.faltando, []); assert.equal(i.segmentos[0].nome, 'Motores'); assert.equal(i.segmentos[0].duplicados, true); assert.equal(i.etapas.ENC, 'DT1036_19:UC_EFR0YE');
});
test('dashboard: indicadores, série mensal, por vendedor e filtros cruzados', async () => {
  const { f, svc } = mundo(); await svc.sync();
  const card = f.s.itens[1036].find(c => c.companyId == 100);
  await svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'Visita muito boa com o cliente', supervisor: '9' }, vendedor); svc.invalidar();
  const d = await svc.dashboard(admin, { de: '2026-01-01' });
  assert.equal(d.kpis.programadas, 3); assert.equal(d.kpis.realizadas, 1); assert.equal(d.kpis.abertas, 2); assert.equal(d.kpis.taxa, 100);
  assert.ok(d.serie.length >= 1 && d.serie.every(x => /^\d{4}-\d{2}$/.test(x.mes))); assert.equal(d.porVendedor[0].nome, 'Vera Vendedora'); assert.equal(d.porSegmento[0].nome, 'Motores');
  const so = await svc.dashboard(admin, { de: '2026-01-01', classe: 'A' }); assert.equal(so.kpis.programadas, 2);
  assert.deepEqual(so.opcoes.classes, ['A', 'B', 'C', 'E']); assert.equal(so.opcoes.vendedores.length, 1);   // opções não encolhem com o filtro de classe
});
test('registros: lista, busca, paginação e permissão de edição', async () => {
  const { f, svc } = mundo(); await svc.sync();
  const card = f.s.itens[1036].find(c => c.companyId == 100);
  await svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'Cliente quer revisão de turbina' }, vendedor); svc.invalidar();
  const r = await svc.registros(admin, { de: '2026-01-01' });
  assert.equal(r.total, 1); assert.equal(r.itens[0].empresa, 'Alfa Motores'); assert.equal(r.itens[0].podeEditar, true); assert.match(r.itens[0].resumo, /turbina/);
  assert.equal((await svc.registros(admin, { de: '2026-01-01', q: 'TURBINA' })).total, 1); assert.equal((await svc.registros(admin, { de: '2026-01-01', q: 'inexistente' })).total, 0);
  assert.equal((await svc.registros(vendedor, {})).itens[0].podeEditar, true);
  assert.equal((await svc.registros({ id: '8', papel: 'usuario' }, {})).total, 0);          // outro vendedor não vê
});
test('acesso por departamento (com subdepartamentos); admin sempre entra', async () => {
  const { f, svc, store } = mundo();
  f.bx.call = (orig => async (m, p) => (m === 'user.get' && p?.FILTER?.ID ? { result: [{ ID: p.FILTER.ID, UF_DEPARTMENT: p.FILTER.ID === '7' ? ['1'] : ['99'] }] } : orig(m, p)))(f.bx.call);
  assert.equal(await svc.temAcesso({ id: '8', papel: 'usuario' }), true);          // sem restrição = todos
  store.setConfig({ deptsAcesso: ['1'] }); svc.invalidar();
  assert.equal(await svc.temAcesso({ id: '7', papel: 'usuario' }), true);
  assert.equal(await svc.temAcesso({ id: '8', papel: 'usuario' }), false);
  assert.equal(await svc.temAcesso({ id: '8', papel: 'admin' }), true);
});
test('lista mostra todos os cards do SPA, inclusive datas antigas e etapas fora do padrão', async () => {
  const { f, svc } = mundo(); await svc.sync();
  f.s.itens[1036].push({ id: 900, title: 'Antigo', companyId: 100, categoryId: 19, stageId: 'DT1036_19:SUCCESS', assignedById: '7', ufSeg: 'Motores', ufClasse: 'A', ufData: '2025-03-10' },
    { id: 901, title: 'Estranho', companyId: 101, categoryId: 19, stageId: 'DT1036_19:XYZ', assignedById: '7', ufSeg: 'Motores', ufData: '2026-01-05' });
  svc.invalidar(); const r = await svc.listar(admin, { finalizados: '1' });
  assert.equal(r.total, 4); assert.ok(r.itens.some(i => i.etapa === 'SUCCESS')); assert.ok(r.itens.some(i => i.etapa === 'OUTRA'));
});
test('paginação: página, total, contagem por etapa e nomes só da página', async () => {
  const { f, svc } = mundo();
  for (let i = 0; i < 25; i++) f.s.empresas.push({ ID: String(200 + i), TITLE: `Emp ${i}`, UF_V: '7', UF_C: '3' });
  await svc.sync(); svc.invalidar();
  f.s.chamadas.length = 0;
  const p1 = await svc.listar(admin, { pageSize: 10, page: 1 }), p3 = await svc.listar(admin, { pageSize: 10, page: 3 });
  assert.equal(p1.total, 27); assert.equal(p1.pages, 3); assert.equal(p1.itens.length, 10); assert.equal(p3.itens.length, 7); assert.equal(p1.porEtapa.NEW, 27);
  assert.equal((await svc.listar(admin, { pageSize: 10, page: 99 })).page, 3);            // página fora do intervalo é corrigida
  assert.ok(new Set([...p1.itens, ...p3.itens].map(i => i.id)).size === 17);
});
test('validação: anexo inválido, motivo fora da lista e texto gigante são tratados', async () => {
  const { f, svc } = mundo(); await svc.sync();
  const card = f.s.itens[1036].find(c => c.companyId == 100);
  await assert.rejects(svc.naoRealizada(card.id, { motivo: 'qualquer coisa' }, vendedor), /Motivo inválido/);
  f.s.itens[1032];
  await svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'x'.repeat(50000), contatos: Array(80).fill(5) }, vendedor);
  assert.equal(f.s.itens[1032][0].ufFatos.length, 20000); assert.equal(f.s.itens[1032][0].contactIds.length, 50);
});
test('cache da lista: serve o antigo na hora após expirar, e uma gravação nunca é mascarada', async () => {
  const { f, svc } = mundo(); await svc.sync();
  let agora = Date.now(); const real = Date.now; Date.now = () => agora;
  try {
    await svc.listar(admin, {}); f.s.chamadas.length = 0;
    agora += 60000;                                                    // expirou (45 s), mas dentro do limite "stale"
    const r = await svc.listar(admin, {}); assert.equal(r.total, 2);
    await new Promise(ok => setTimeout(ok, 20)); assert.ok(f.s.chamadas.includes('crm.item.list'));   // atualizou em segundo plano
    const card = f.s.itens[1036].find(c => c.companyId == 100);
    await svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'ok' }, vendedor);
    const depois = await svc.listar(admin, {}); assert.equal(depois.itens.find(i => i.id === card.id).etapa, 'ENC');   // sem dado velho após gravar
  } finally { Date.now = real; }
});
function renomeiaData(f, label, tipo) {
  const orig = f.bx.call;
  f.bx.call = async (m, p = {}) => { const r = await orig(m, p); if (m === 'crm.item.fields' && +p.entityTypeId === 1036) { r.result.fields = { ...r.result.fields, ufData: { title: label, formLabel: label, type: tipo } }; } return r; };
}
test('data programada com rótulo diferente é achada pelo tipo date; ajuste manual vence', async () => {
  const { f, svc, store } = mundo(); renomeiaData(f, 'Agendamento', 'date'); svc.resetModelo();
  assert.equal((await svc.camposInfo()).fila.data, 'ufData');
  const m = mundo(); renomeiaData(m.f, 'Quando', 'string'); m.svc.resetModelo();
  assert.notEqual((await m.svc.camposInfo()).fila.data, 'ufData');                 // texto: não adivinha
  m.store.setConfig({ mapa: { fila: { data: 'ufData' } } }); m.svc.resetModelo();
  assert.equal((await m.svc.camposInfo()).fila.data, 'ufData');
  const ajuste = (await m.svc.camposInfo()).disponiveis.find(x => x.key === 'ufData'); assert.equal(ajuste.label, 'Quando');
  void f; void svc; void store;
});
test('card sem responsável (0) aparece como "Sem vendedor"', async () => {
  const { f, svc } = mundo(); await svc.sync();
  f.s.itens[1036].push({ id: 700, title: 'Órfão', companyId: 100, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '0', ufSeg: 'Peças', ufClasse: 'B', ufData: '2026-12-01' });
  svc.invalidar(); const r = await svc.listar(admin, {});
  assert.equal(r.itens.find(i => i.id === 700).vendedor, 'Sem vendedor'); assert.equal(r.itens.find(i => i.id === 700).vendedorId, '');
});
test('agrupar por cliente: segmentos do mesmo cliente nunca se separam entre páginas; busca por nome', async () => {
  const { f, svc } = mundo();
  for (let i = 0; i < 12; i++) f.s.empresas.push({ ID: String(300 + i), TITLE: `Cliente ${String(i).padStart(2, '0')}`, UF_V: '7', UF_C: '3' });
  await svc.sync();
  for (const seg of ['Peças', 'Serviços']) f.s.itens[1036].push({ id: 800 + seg.length, title: 'x', companyId: 100, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '7', ufSeg: seg, ufClasse: 'A', ufData: '2026-11-24' });
  svc.invalidar();
  const p1 = await svc.listar(admin, { agrupar: '1', pageSize: 10, page: 1 }), p2 = await svc.listar(admin, { agrupar: '1', pageSize: 10, page: 2 });
  assert.equal(p1.totalGrupos, 14); assert.equal(p1.total, 16); assert.equal(p1.pages, 2);
  const nas = [p1, p2].map(p => new Set(p.itens.filter(i => i.empresaId === 100).map(i => i.segmento)));
  assert.ok(nas.some(s => s.size === 3) && nas.every(s => s.size === 0 || s.size === 3));         // Motores+Peças+Serviços juntos, em uma única página
  assert.ok(p1.itens.length + p2.itens.length === 16);
  assert.equal((await svc.listar(admin, { q: 'cliente 07' })).total, 1);
  assert.equal((await svc.listar(admin, { all: '1' })).itens.length, 16);                     // kanban: tudo de uma vez
});
test('filtro "sem vendedor" no painel e na lista', async () => {
  const { f, svc } = mundo(); await svc.sync();
  f.s.itens[1036].push({ id: 710, title: 'Órfão', companyId: 100, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '0', ufSeg: 'Peças', ufClasse: 'B', ufData: '2026-12-01' }); svc.invalidar();
  assert.deepEqual((await svc.listar(admin, { vendedor: 'sem' })).itens.map(i => i.id), [710]);
  const d = await svc.dashboard(admin, {}); assert.ok(d.opcoes.vendedores.some(v => v.id === 'sem')); assert.equal((await svc.dashboard(admin, { vendedor: 'sem' })).kpis.programadas, 1);
});
test('Finalizado fica oculto por padrão e aparece a pedido; datas em formatos variados são normalizadas', async () => {
  const { f, svc } = mundo(); await svc.sync();
  f.s.itens[1036].push({ id: 720, title: 'Velho', companyId: 100, categoryId: 19, stageId: 'DT1036_19:SUCCESS', assignedById: '7', ufSeg: 'Motores', ufClasse: 'A', ufData: '18/07/2025' },
    { id: 721, title: 'ISO', companyId: 101, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '7', ufSeg: 'Peças', ufClasse: 'A', ufData: '2026-12-05T03:00:00+03:00' },
    { id: 722, title: 'Lixo', companyId: 101, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '7', ufSeg: 'Serviços', ufClasse: 'A', ufData: 'amanhã' });
  svc.invalidar();
  const padrao = await svc.listar(admin, {}); assert.ok(!padrao.itens.some(i => i.id === 720)); assert.equal(padrao.porEtapa.SUCCESS, undefined);
  const todos = await svc.listar(admin, { finalizados: '1' }), vel = todos.itens.find(i => i.id === 720); assert.equal(vel.data, '2025-07-18');
  assert.equal(todos.itens.find(i => i.id === 721).data, '2026-12-05'); assert.equal(todos.itens.find(i => i.id === 722).data, '');
  assert.ok((await svc.listar(admin, { etapa: 'SUCCESS' })).itens.some(i => i.id === 720));        // filtrar pela etapa também mostra
});
test('registros mostram todos os campos do SPA com rótulo e valor; rótulo parecido é achado e o ajuste manual vence', async () => {
  const { f, svc, store } = mundo(); await svc.sync();
  const orig = f.bx.call;
  f.bx.call = async (m, p = {}) => { const r = await orig(m, p); if (m === 'crm.item.fields' && +p.entityTypeId === 1032) r.result.fields = { ...r.result.fields,
    ufFatos: { title: 'Fatos e Dados Relevantes', type: 'string' }, ufSup: { title: 'Supervisor que acompanhou', type: 'employee' }, ufExtra: { title: 'Observação interna', type: 'string' }, ufAnt: { title: 'Visita antecipada', type: 'boolean' } }; return r; };
  svc.resetModelo();
  assert.equal((await svc.camposInfo()).visitaDetectada.fatos, 'ufFatos');                           // rótulo diferente, achado por semelhança
  const card = f.s.itens[1036].find(c => c.companyId == 100);
  await svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'Cliente quer turbina', supervisor: '9', contatos: [5] }, vendedor);
  f.s.itens[1032][0].ufExtra = 'nota interna'; f.s.itens[1032][0].ufAnt = 'Y'; f.s.contatos.push({ ID: '5', NAME: 'João', LAST_NAME: 'Silva' }); svc.invalidar();
  const r = await svc.registros(admin, {}), item = r.itens[0], rot = Object.fromEntries(r.colunas.map(c => [c.label, c.k]));
  assert.ok(['Criado em', 'Criado por', 'Contatos', 'Fatos e Dados Relevantes', 'Observação interna', 'Visita antecipada'].every(l => rot[l]));
  assert.ok(!r.colunas.some(c => c.label === 'Segmento' || c.label === 'Data/Hora da Visita'));      // já aparecem nas colunas fixas
  assert.equal(item.valores[rot['Fatos e Dados Relevantes']], 'Cliente quer turbina'); assert.equal(item.valores[rot['Observação interna']], 'nota interna');
  assert.equal(item.valores[rot['Supervisor que acompanhou']], 'Sérgio Supervisor'); assert.equal(item.valores[rot['Contatos']], 'João Silva'); assert.equal(item.valores[rot['Visita antecipada']], 'Sim');
  const um = await svc.registroDoCard(card.id, admin); assert.ok(um.campos.some(c => c.label === 'Observação interna' && c.valor === 'nota interna')); assert.equal(um.raw, undefined);
  store.setConfig({ mapa: { visita: { fatos: 'ufExtra' } } }); svc.resetModelo(); assert.equal((await svc.camposInfo()).visitaDetectada.fatos, 'ufExtra');   // ajuste manual
});
test('regra: sem "Última visita" no cadastro a empresa não entra na fila nem aparece no app', async () => {
  const { f, svc, store } = mundo(); store.setConfig({ exigirUltimaVisita: true });
  f.s.empresas[0].UF_U = '2026-10-20';                                  // só a Alfa (classe A) tem última visita
  const r = await svc.sync();
  assert.equal(r.criados, 1); assert.equal(r.semUltima, 1);              // Beta tem vendedor+classe mas não tem última: não gera card
  const cards = f.s.itens[1036]; assert.equal(cards.length, 1); assert.equal(+cards[0].companyId, 100);
  assert.equal(cards[0].ufData, R.proximaVisita('A', '2026-10-20'));        // última visita + 30 dias (classe A), em dia útil
  // card antigo de empresa sem última visita fica no Bitrix, mas oculto no app
  f.s.itens[1036].push({ id: 900, title: 'Beta', companyId: 101, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '7', ufSeg: 'Motores', ufClasse: 'B', ufData: '2026-12-10' }); svc.invalidar();
  const l = await svc.listar(admin, {}); assert.deepEqual(l.itens.map(i => i.empresaId), [100]); assert.equal(l.ocultos, 1); assert.equal(l.itens[0].ultimaVisita, '2026-10-20');
  assert.equal((await svc.dashboard(admin, {})).kpis.programadas, 1);
  store.setConfig({ exigirUltimaVisita: false }); assert.equal((await svc.listar(admin, {})).itens.length, 2);       // desligando a regra, volta a aparecer
});
test('registrar mantém o cache da última visita: o card seguinte continua visível', async () => {
  const { f, svc, store } = mundo(); store.setConfig({ exigirUltimaVisita: true }); f.s.empresas[0].UF_U = '2026-10-20'; await svc.sync();
  const card = f.s.itens[1036].find(c => c.companyId == 100); await svc.listar(admin, {});          // aquece o cache
  await svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'ok' }, vendedor);
  const l = await svc.listar(admin, { finalizados: '1' }); assert.equal(l.itens.filter(i => i.empresaId === 100).length, 2); assert.equal(l.itens[0].ultimaVisita, '2026-11-18');
});
test('diagnóstico das datas: contagens, intervalos observados e exemplos', async () => {
  const { f, svc } = mundo();
  Object.assign(f.s.empresas[0], { UF_U: '2026-10-01', UF_P: '2026-10-31' }); Object.assign(f.s.empresas[1], { UF_U: '2026-10-01', UF_P: '2026-12-01' });
  f.s.empresas.push({ ID: '110', TITLE: 'Invertida', UF_V: '7', UF_C: '1', UF_U: '2026-11-01', UF_P: '2026-10-01' });
  const d = await svc.diagnosticoDatas(), s = d.segmentos[0];
  assert.equal(d.empresas, 5); assert.equal(s.nome, 'Motores'); assert.equal(s.comUltima, 3); assert.equal(s.aptas, 3); assert.equal(s.semUltima, 0);
  assert.equal(s.proximaAntesDaUltima, 1); assert.match(s.exemplos.inconsistentes[0], /Invertida/);
  assert.deepEqual(s.intervalosObservados.A, [{ dias: 30, empresas: 1 }]); assert.deepEqual(s.intervalosObservados.B, [{ dias: 61, empresas: 1 }]);
  assert.ok(s.campos.ultima.includes('[Motores] Última Visita'));
});
test('desempenho: datas do cadastro leem só as empresas com card, uma vez, e o aquecimento prepara tudo', async () => {
  const { f, svc, store } = mundo(); store.setConfig({ exigirUltimaVisita: true }); f.s.empresas[0].UF_U = '2026-10-20'; f.s.empresas[1].UF_U = '2026-10-21';
  await svc.sync(); svc.resetModelo(); svc.invalidar();
  const lidas = []; const orig = f.bx.call;
  f.bx.call = async (m, p = {}) => { if (m === 'crm.company.list' && p.select?.includes('UF_U')) lidas.push(p.filter?.ID); return orig(m, p); };   // só leituras das datas (não a de nomes)
  await svc.aquecer();
  assert.equal(lidas.length, 1); assert.deepEqual([...lidas[0]].sort(), ['100', '101']);          // um lote, só as empresas dos cards (não a base inteira)
  const r = await svc.listar(admin, {}); assert.equal(r.itens.length, 2);
  await svc.listar(admin, {}); await svc.dashboard(admin, {});
  assert.equal(lidas.length, 1);                                                                    // listar/dashboard não voltam a ler as datas
});
test('formulário do registro: Alçada e outros campos extras do SPA, validados e editáveis', async () => {
  const { f, svc } = mundo(); await svc.sync();
  const orig = f.bx.call;
  f.bx.call = async (m, p = {}) => { const r = await orig(m, p); if (m === 'crm.item.fields' && +p.entityTypeId === 1032) r.result.fields = { ...r.result.fields,
    ufAlc: { title: 'Alçada', type: 'enumeration', items: [{ ID: '1', VALUE: 'Gerente' }, { ID: '2', VALUE: 'Diretor' }] },
    ufNum: { title: 'Valor estimado', type: 'double' }, ufOk: { title: 'Cliente ativo', type: 'boolean' }, ufRet: { title: 'Retorno em', type: 'date' }, ufQtd: { title: 'Qtd de motores', type: 'integer' },
    ufMulti: { title: 'Vários', type: 'string', isMultiple: true }, ufArq: { title: 'Arquivo extra', type: 'file' }, ufLead: { title: 'Lead', type: 'crm' } }; return r; };
  svc.resetModelo(); const card = f.s.itens[1036].find(c => c.companyId == 100);
  const form = await svc.formCard(card.id, vendedor);
  assert.deepEqual(form.opcoes.alcada, ['Gerente', 'Diretor']); assert.equal(form.campos.alcada, true);
  assert.deepEqual(form.extras.map(e => e.label).sort(), ['Cliente ativo', 'Qtd de motores', 'Retorno em', 'Valor estimado']);   // conhecidos, múltiplos, arquivo e lead ficam de fora
  await svc.registrar(card.id, { dataHora: '2026-11-18T10:00', fatos: 'ok', alcada: 'Diretor', extras: { ufNum: '1500,5', ufOk: 'Sim', ufQtd: 'abc', ufRet: '2026-12-15', ufMulti: 'hack', naoExiste: 'x' } }, vendedor);
  const it = f.s.itens[1032][0];
  assert.equal(it.ufAlc, '2'); assert.equal(it.ufNum, '1500.5'); assert.equal(it.ufOk, 'Y'); assert.equal(it.ufQtd, ''); assert.equal(it.ufRet, '2026-12-15');
  assert.equal(it.ufMulti, undefined); assert.equal(it.naoExiste, undefined);                       // só campos conhecidos entram
  const reg = await svc.registroDoCard(card.id, vendedor);
  assert.equal(reg.alcada, 'Diretor'); assert.deepEqual([reg.extras.ufOk, reg.extras.ufNum, reg.extras.ufRet], ['Y', '1500.5', '2026-12-15']);
  assert.ok(reg.campos.some(c => c.label === 'Alçada' && c.valor === 'Diretor'));
  await svc.editarRegistro(reg.id, { fatos: 'ok', alcada: 'Gerente', extras: { ufOk: 'Não' } }, vendedor);
  assert.equal(it.ufAlc, '1'); assert.equal(it.ufOk, 'N');
});
test('opções dos filtros trazem todos os segmentos e vendedores do escopo, sem encolher com o filtro', async () => {
  const { f, svc } = mundo(); await svc.sync();
  for (const seg of ['Peças', 'Serviços']) f.s.itens[1036].push({ id: 950 + seg.length, title: 'x', companyId: 100, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '0', ufSeg: seg, ufClasse: 'A', ufData: '2026-12-01' });
  svc.invalidar();
  const todos = await svc.listar(admin, {}), so = await svc.listar(admin, { segmento: 'Peças' });
  assert.deepEqual(todos.opcoes.segmentos, ['Motores', 'Peças', 'Serviços']); assert.deepEqual(so.opcoes.segmentos, ['Motores', 'Peças', 'Serviços']);
  assert.ok(so.opcoes.vendedores.some(v => v.id === 'sem') && so.opcoes.vendedores.some(v => v.nome === 'Vera Vendedora')); assert.equal(so.total, 1);
  assert.deepEqual((await svc.listar(vendedor, {})).opcoes.segmentos, ['Motores']);                 // opções respeitam o escopo: o vendedor só vê os segmentos dos seus cards
});
test('cadastrar Última visita sem abrir a empresa: lista ocultos, grava no cadastro, respeita escopo e cria o card', async () => {
  const { f, svc, store } = mundo(); store.setConfig({ exigirUltimaVisita: true });
  f.s.empresas.push({ ID: '104', TITLE: 'Épsilon', UF_V: '8', UF_C: '2' }, { ID: '105', TITLE: 'Zeta sem card', UF_V: '7', UF_C: '3' });
  const novo = (id, emp, vend, data) => f.s.itens[1036].push({ id, title: 'x', companyId: emp, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: vend, ufSeg: 'Motores', ufClasse: 'A', ufData: data });
  novo(910, 100, '7', '2026-12-01'); novo(911, 101, '7', '2026-12-02'); novo(912, 104, '8', '2026-12-03');
  const lista = await svc.semUltima(admin, {}); assert.equal(lista.total, 3); assert.deepEqual(lista.itens.map(i => i.empresa), ['Alfa Motores', 'Beta Diesel', 'Épsilon']);
  assert.equal((await svc.semUltima(vendedor, {})).total, 2);                                         // vendedor só vê as suas
  assert.equal((await svc.semUltima(admin, { q: 'beta' })).total, 1); assert.equal((await svc.semUltima(admin, { vendedor: '8' })).total, 1);
  const r = await svc.salvarUltimas(vendedor, [
    { empresaId: 100, segmento: 'Motores', data: '2026-10-20' }, { empresaId: 101, segmento: 'Motores', data: '2027-01-01' },
    { empresaId: 104, segmento: 'Motores', data: '2026-10-20' }, { empresaId: 100, segmento: 'Peças', data: '2026-10-20' }, { empresaId: 105, segmento: 'Motores', data: '2026-11-10' }]);
  assert.deepEqual(r.resultados.map(x => x.ok), [true, false, false, false, true]);
  assert.match(r.resultados[1].erro, /futuro/); assert.match(r.resultados[2].erro, /sua nem da sua equipe/); assert.match(r.resultados[3].erro, /Segmento sem campo/);
  const alfa = f.s.empresas.find(e => e.ID === '100');
  assert.equal(alfa.UF_U, '2026-10-20'); assert.equal(alfa.UF_P, R.proximaVisita('A', '2026-10-20'));         // grava a Última e calcula a Próxima (estava vazia)
  const zeta = f.s.itens[1036].find(c => c.companyId === 105); assert.ok(zeta); assert.equal(zeta.ufData, R.proximaVisita('C', '2026-11-10'));   // sem card e fila ativa: criou na hora
  const visiveis = await svc.listar(admin, {}); assert.deepEqual(visiveis.itens.map(i => i.empresa).sort(), ['Alfa Motores', 'Zeta sem card']); assert.equal(visiveis.ocultos, 2);
  assert.equal((await svc.semUltima(admin, {})).total, 2);                                             // some da lista de pendentes
  f.s.empresas.find(e => e.ID === '101').UF_P = '2027-03-01'; await svc.salvarUltimas(admin, [{ empresaId: 101, segmento: 'Motores', data: '2026-10-25' }]);
  assert.equal(f.s.empresas.find(e => e.ID === '101').UF_P, '2027-03-01');                              // Próxima já preenchida não é sobrescrita
});
// ===== Auditoria do processo: card da fila -> registro (SPA 1032) -> próxima etapa -> próxima visita -> app atualizado =====
function mundoAtivo() {
  const w = mundo(); w.store.setConfig({ exigirUltimaVisita: true });
  Object.assign(w.f.s.empresas[0], { UF_U: '2026-10-20' }); Object.assign(w.f.s.empresas[1], { UF_U: '2026-10-10' });   // Alfa (A) e Beta (B) aptas; as demais ficam fora
  return w;
}
test('processo completo: cria a fila, registra, encerra o card, grava o registro, gera a próxima visita e a lista reflete', async () => {
  const { f, svc } = mundoAtivo();
  const s1 = await svc.sync(); assert.equal(s1.criados, 2);
  const [alfa, beta] = ['100', '101'].map(id => f.s.itens[1036].find(c => String(c.companyId) === id));
  assert.equal(alfa.ufData, R.proximaVisita('A', '2026-10-20')); assert.equal(beta.ufData, R.proximaVisita('B', '2026-10-10'));   // 1º card = última visita + prazo da classe
  assert.equal(f.s.empresas[0].UF_P, alfa.ufData);                                                                                  // cadastro recebe a próxima
  const r = await svc.registrar(alfa.id, { dataHora: '2026-11-18T10:00', fatos: 'Visita realizada', contatos: [5] }, vendedor);
  assert.deepEqual(r.avisos, []);
  assert.equal(f.s.itens[1032].length, 1); assert.equal(f.s.itens[1032][0].ufIdFila, String(alfa.id));                             // registro criado e ligado ao card
  assert.equal(alfa.stageId, 'DT1036_19:UC_EFR0YE');                                                                                  // card avançou para Encerrado
  assert.equal(f.s.empresas[0].UF_U, '2026-11-18'); const prox = f.s.itens[1036].find(c => c.id === r.proximoCard);
  assert.equal(prox.ufData, R.proximaVisita('A', '2026-11-18')); assert.equal(f.s.empresas[0].UF_P, prox.ufData);                    // próxima visita = cópia do card para o próximo ciclo
  assert.equal(prox.ufSeg, alfa.ufSeg); assert.equal(prox.assignedById, alfa.assignedById);
  svc.invalidar(); const l = await svc.listar(admin, { finalizados: '1' });
  assert.equal(l.itens.find(i => i.id === alfa.id).etapa, 'ENC'); assert.ok(l.itens.some(i => i.id === prox.id && i.etapa === 'NEW'));      // app atualizado
  const s2 = await svc.sync(); assert.equal(s2.criados, 0); assert.equal(f.s.itens[1036].length, 3);                                  // 2ª sincronização não duplica nada
});
test('falha ao encerrar o card NÃO duplica o registro na nova tentativa', async () => {
  const { f, svc } = mundoAtivo(); await svc.sync();
  const alfa = f.s.itens[1036].find(c => String(c.companyId) === '100'); const orig = f.bx.call; let falhou = false;
  f.bx.call = async (m, p = {}) => { if (m === 'crm.item.update' && +p.entityTypeId === 1036 && p.fields?.stageId && !falhou) { falhou = true; throw new Error('Bitrix indisponível'); } return orig(m, p); };
  await assert.rejects(svc.registrar(alfa.id, { dataHora: '2026-11-18T10:00', fatos: 'primeira tentativa' }, vendedor), /indisponível/);
  assert.equal(f.s.itens[1032].length, 1); assert.equal(alfa.stageId, 'DT1036_19:NEW');                                                 // registro existe, card ainda aberto
  const r = await svc.registrar(alfa.id, { dataHora: '2026-11-18T10:00', fatos: 'segunda tentativa' }, vendedor);
  assert.equal(f.s.itens[1032].length, 1); assert.equal(f.s.itens[1032][0].ufFatos, 'segunda tentativa');                              // atualizou o mesmo, sem duplicar
  assert.equal(alfa.stageId, 'DT1036_19:UC_EFR0YE'); assert.ok(r.proximoCard);
  assert.equal(f.s.itens[1036].filter(c => String(c.companyId) === '100').length, 2);                                                   // um único próximo card
});
test('falha depois de registrar vira aviso: a visita conta e o card encerra', async () => {
  const { f, svc } = mundoAtivo(); await svc.sync(); const alfa = f.s.itens[1036].find(c => String(c.companyId) === '100'); const orig = f.bx.call;
  f.bx.call = async (m, p = {}) => { if (m === 'crm.company.update') throw new Error('sem permissão na empresa'); return orig(m, p); };
  const r = await svc.registrar(alfa.id, { dataHora: '2026-11-18T10:00', fatos: 'ok' }, vendedor);
  assert.equal(r.ok, true); assert.ok(r.avisos.length >= 1 && /empresa/.test(r.avisos[0])); assert.equal(alfa.stageId, 'DT1036_19:UC_EFR0YE'); assert.equal(f.s.itens[1032].length, 1);
});
test('reconciliação: registro criado direto no Bitrix encerra o card e gera a próxima visita (idempotente)', async () => {
  const { f, svc } = mundoAtivo(); await svc.sync();
  const [alfa, beta] = ['100', '101'].map(id => f.s.itens[1036].find(c => String(c.companyId) === id));
  f.s.itens[1032].push({ id: 777, createdBy: '7', companyId: '100', ufIdFila: String(alfa.id), ufData: '2026-11-17T09:00:00', ufFatos: 'lançado à mão no Bitrix' }); svc.invalidar();
  const r = await svc.reconciliar(); assert.equal(r.movidos, 1); assert.equal(r.erros, 0);
  assert.equal(alfa.stageId, 'DT1036_19:UC_EFR0YE'); assert.equal(beta.stageId, 'DT1036_19:NEW');                                       // só o card com registro mudou
  assert.equal(f.s.empresas[0].UF_U, '2026-11-17'); assert.equal(f.s.itens[1036].filter(c => String(c.companyId) === '100').length, 2);
  svc.invalidar(); const r2 = await svc.reconciliar(); assert.equal(r2.movidos, 0); assert.equal(f.s.itens[1036].filter(c => String(c.companyId) === '100').length, 2);   // 2ª rodada: nada muda
  assert.equal(f.s.itens[1032].length, 1);                                                                                              // não cria registro novo
});
test('auditoria detecta cada tipo de problema e as correções seguras funcionam', async () => {
  const { f, svc } = mundoAtivo(); await svc.sync(); const it = f.s.itens[1036];
  const [alfa, beta] = ['100', '101'].map(id => it.find(c => String(c.companyId) === id));
  f.s.itens[1032].push({ id: 801, createdBy: '7', companyId: '100', ufIdFila: String(alfa.id), ufData: '2026-11-17T09:00:00', ufFatos: 'x' },   // registro com card aberto
    { id: 802, createdBy: '7', companyId: '100', ufIdFila: '99999', ufData: '2026-11-01T09:00:00', ufFatos: 'órfão' });                       // registro órfão
  it.push({ id: 850, title: 'dup', companyId: 101, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '7', ufSeg: 'Motores', ufClasse: 'B', ufData: '2027-01-10' });   // 2º aberto para Beta
  it.push({ id: 851, title: 'enc', companyId: 200, categoryId: 19, stageId: 'DT1036_19:UC_EFR0YE', assignedById: '7', ufSeg: 'Motores', ufClasse: 'B', ufData: '2026-09-01' });   // encerrado sem registro
  svc.invalidar(); const a = await svc.auditoria(), por = Object.fromEntries(a.checks.map(c => [c.id, c]));
  assert.equal(por.registro_card_aberto.contagem, 1); assert.equal(por.registro_card_aberto.severidade, 'erro'); assert.equal(por.registro_card_aberto.corrigivel, true);
  assert.equal(por.registro_orfao.contagem, 1); assert.equal(por.abertos_duplicados.contagem, 1); assert.equal(por.encerrado_sem_registro.contagem, 1);
  assert.equal(a.resumo.registros, 2); assert.equal(a.resumo.cards, 4);
  await svc.corrigirAuditoria('abertos_duplicados'); assert.equal(it.find(c => c.id === 850).stageId, 'DT1036_19:FAIL'); assert.equal(beta.stageId, 'DT1036_19:NEW');   // mantém o mais antigo
  await svc.corrigirAuditoria('registro_card_aberto'); assert.equal(alfa.stageId, 'DT1036_19:UC_EFR0YE');
  svc.invalidar(); const b = Object.fromEntries((await svc.auditoria()).checks.map(c => [c.id, c]));
  assert.equal(b.registro_card_aberto.severidade, 'ok'); assert.equal(b.abertos_duplicados.severidade, 'ok'); assert.equal(b.sem_proximo.severidade, 'ok');         // corrigido, e a próxima visita foi gerada
  await assert.rejects(svc.corrigirAuditoria('encerrado_sem_registro'), /não tem correção/);
  const quebra = it.find(c => String(c.companyId) === '101' && c.id === beta.id); quebra.stageId = 'DT1036_19:UC_EFR0YE'; svc.invalidar();      // ciclo quebrado: encerrado e sem aberto
  assert.equal(Object.fromEntries((await svc.auditoria()).checks.map(c => [c.id, c])).sem_proximo.contagem, 1);
  await svc.corrigirAuditoria('sem_proximo'); svc.invalidar(); assert.equal(Object.fromEntries((await svc.auditoria()).checks.map(c => [c.id, c])).sem_proximo.contagem, 0);
});
// ===== Auditoria de visibilidade: cada responsável vê só o seu; "Quem vê tudo" vê todos =====
async function mundoIsolado() {
  const w = mundo(); w.f.s.empresas.push({ ID: '104', TITLE: 'Épsilon', UF_V: '8', UF_C: '1' }); await w.svc.sync();
  const card = id => w.f.s.itens[1036].find(c => String(c.companyId) === String(id));
  const u7 = { id: '7', nome: 'Vera', papel: 'usuario' }, u8 = { id: '8', nome: 'Outro', papel: 'usuario' }, u9 = { id: '9', nome: 'Chefe', papel: 'usuario' };
  await w.svc.registrar(card(100).id, { dataHora: '2026-11-18T10:00', fatos: 'visita do 7' }, u7);
  await w.svc.registrar(card(104).id, { dataHora: '2026-11-18T11:00', fatos: 'visita do 8' }, u8);
  await w.svc.reprogramar(card(101).id, { data: '2026-12-15', motivo: 'cliente viajando' }, u7);
  w.svc.invalidar();
  return { ...w, card, u7, u8, u9, adm: { id: '1', nome: 'Admin', papel: 'admin', config: true }, todos: { id: '3', nome: 'Diretor', papel: 'usuario' } };
}
test('visibilidade: com "Quem vê tudo" vazio só os administradores do portal veem tudo; chefe de departamento NÃO vê a equipe', async () => {
  const { svc, u7, u8, u9, adm } = await mundoIsolado();
  const n = async u => (await svc.listar(u, { finalizados: '1' })).total;
  assert.equal(await n(adm), 5); assert.equal(await n(u7), 3); assert.equal(await n(u8), 2);      // 7 tem 3 cards, 8 tem 2
  assert.equal(await n(u9), 0);                                                                       // 9 chefia o departamento do fake, mas não vê ninguém
  assert.equal(await svc.veTudo(adm), true); assert.equal(await svc.veTudo(u7), false); assert.equal(await svc.veTudo(u9), false);
});
test('visibilidade: com a lista preenchida, nem administrador vê o dos outros; quem está na lista vê tudo', async () => {
  const { f, svc, store, card, u7, u8, adm, todos } = await mundoIsolado();
  store.setConfig({ verTudo: ['3'] }); svc.invalidar();
  const n = async u => (await svc.listar(u, { finalizados: '1' })).total;
  assert.equal(await n(todos), 5); assert.equal(await n(adm), 0); assert.equal(await n(u7), 3); assert.equal(await n(u8), 2);
  // leituras
  for (const [u, esperado] of [[adm, 0], [u7, 3], [u8, 2], [todos, 5]]) {
    assert.equal((await svc.dashboard(u, {})).kpis.programadas, esperado, 'dashboard');
    assert.equal((await svc.registros(u, {})).total, { 0: 0, 3: 1, 2: 1, 5: 2 }[esperado], 'registros');
  }
  assert.equal((await svc.historico(adm)).total, 0); assert.equal((await svc.historico(u7)).total, 1); assert.equal((await svc.historico(u8)).total, 0); assert.equal((await svc.historico(todos)).total, 1);
  assert.equal((await svc.semUltima(adm, {})).total, 0);
  // filtros não ampliam o alcance
  assert.equal((await svc.listar(u8, { vendedor: '7', finalizados: '1' })).total, 0); assert.equal((await svc.dashboard(u8, { vendedor: '7' })).kpis.programadas, 0);
  assert.equal((await svc.listar(u8, { supervisor: '9', finalizados: '1' })).total, 0);               // filtro de supervisor só restringe, nunca amplia
  assert.equal((await svc.listar(u7, { excluidos: '1' })).total, 0);
  // acesso direto por ID aos cards e registros alheios é negado
  const c7 = card(100), c8 = card(104), reg7 = f.s.itens[1032].find(r => String(r.ufIdFila) === String(c7.id));
  for (const quem of [u8, adm]) {
    await assert.rejects(svc.formCard(c7.id, quem), /não é seu/); await assert.rejects(svc.registroDoCard(c7.id, quem), /não é seu/);
    await assert.rejects(svc.reprogramar(card(101).id, { data: '2027-01-10', motivo: 'x' }, quem), /não é seu/); await assert.rejects(svc.naoRealizada(card(101).id, { motivo: 'Outro motivo' }, quem), /não é seu/);
    await assert.rejects(svc.excluir(card(101).id, {}, quem), /não é seu|pode excluir/); await assert.rejects(svc.proxima(card(101).id, quem), /não é seu/); await assert.rejects(svc.reverter(card(101).id, quem), /não é seu|reverter/);
    await assert.rejects(svc.editarRegistro(reg7.id, { fatos: 'invadindo' }, quem), /não pode editar/);
  }
  const abre = f.s.itens[1036].find(c => c.id !== c7.id && String(c.companyId) === '100' && c.stageId === 'DT1036_19:NEW');
  await assert.rejects(svc.registrar(abre.id, { dataHora: '2026-11-18T10:00', fatos: 'x' }, u8), /não é seu/);
  const sal = await svc.salvarUltimas(adm, [{ empresaId: 100, segmento: 'Motores', data: '2026-10-01' }]); assert.match(sal.resultados[0].erro, /sua nem da sua equipe/);
  // quem é dono (ou vê tudo) consegue
  await svc.editarRegistro(reg7.id, { fatos: 'ajuste do dono' }, u7); assert.equal(reg7.ufFatos, 'ajuste do dono');
  await svc.editarRegistro(reg7.id, { fatos: 'ajuste do diretor' }, todos); assert.equal(reg7.ufFatos, 'ajuste do diretor');
  assert.equal((await svc.registros(u7, {})).itens[0].podeEditar, true); assert.equal((await svc.registros(todos, {})).itens.every(i => i.podeEditar), true);
  void c8;
});
test('exceção pontual: cards já agendados para o futuro entram no app sem Última visita e seguem o fluxo normal', async () => {
  const { f, svc, store } = mundo(); store.setConfig({ exigirUltimaVisita: true });
  const orig = f.bx.call;
  f.bx.call = async (m, p = {}) => { const r = await orig(m, p); if (m === 'crm.item.fields' && +p.entityTypeId === 1036) r.result.fields = { ...r.result.fields, ufAlc: { title: 'Alçada', type: 'enumeration', items: [{ ID: '1', VALUE: 'Gerente' }, { ID: '2', VALUE: 'Supervisor' }] } }; return r; };
  svc.resetModelo();
  const novo = (id, emp, data, extra = {}) => f.s.itens[1036].push({ id, title: 'x', companyId: emp, categoryId: 19, stageId: 'DT1036_19:NEW', assignedById: '7', ufSeg: 'Motores', ufClasse: 'A', ufData: data, ...extra });
  novo(930, 100, '2026-12-10', { ufAlc: '2' });                 // futuro, empresa sem Última visita
  novo(931, 101, '2026-10-05');                                  // data passada, empresa sem Última visita
  novo(932, 100, '2026-11-18', { ufSeg: 'Peças' });              // hoje, empresa sem Última visita (não é "futuro": não entra)
  let l = await svc.listar(admin, {}); assert.equal(l.itens.length, 0); assert.equal(l.ocultos, 3); assert.equal(l.agendados, 1);
  const r = await svc.admitirAgendados(admin); assert.equal(r.admitidos, 1);
  l = await svc.listar(admin, {}); assert.deepEqual(l.itens.map(i => i.id), [930]); assert.equal(l.ocultos, 2); assert.equal(l.agendados, 0); assert.equal(l.itens[0].alcada, 'Supervisor');   // Alçada aparece
  assert.equal((await svc.admitirAgendados(admin)).admitidos, 0);                                               // repetir não admite de novo
  // card admitido segue o fluxo: no dia da visita a varredura move a etapa; os não admitidos ficam intocados
  f.s.itens[1036].find(c => c.id === 930).ufData = '2026-11-18'; svc.invalidar();
  const v = await svc.varrer(); assert.equal(v.ajustados, 1); assert.equal(f.s.itens[1036].find(c => c.id === 930).stageId, 'DT1036_19:PREPARATION');
  assert.equal(f.s.itens[1036].find(c => c.id === 931).stageId, 'DT1036_19:NEW');
  assert.equal((await svc.listar(admin, {})).itens.length, 1);                                                 // continua visível no dia da visita (não some)
  // registrar encerra, grava a Última visita e a próxima nasce automática
  const rg = await svc.registrar(930, { dataHora: '2026-11-18T10:00', fatos: 'ok' }, vendedor);
  assert.equal(f.s.empresas[0].UF_U, '2026-11-18'); assert.ok(rg.proximoCard); assert.equal(f.s.itens[1036].find(c => c.id === rg.proximoCard).ufData, R.proximaVisita('A', '2026-11-18'));
  svc.invalidar(); const depois = await svc.listar(admin, { finalizados: '1' }); assert.ok(depois.itens.some(i => i.id === rg.proximoCard));      // próximo já visível (empresa agora tem Última visita)
});
test('cards admitidos persistem após reiniciar o servidor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-')); const a = createStore(dir); assert.equal(a.admitir([1, 2, 2]), 2); a.flush();
  const b = createStore(dir); assert.equal(b.admitido(1), true); assert.equal(b.admitido(3), false); assert.equal(b.totalAdmitidos, 2);
});
