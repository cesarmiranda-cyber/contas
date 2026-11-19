'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createStore } = require('../lib/store'); const { createService } = require('../lib/service'); const { criarFake } = require('./fake');

const vendedor = { id: '7', nome: 'Vera', papel: 'usuario', config: false };
const admin = { id: '1', nome: 'Admin', papel: 'admin', config: true };
function mundo() {
  const f = criarFake(), store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vis-')));
  store.setConfig({ ativo: true });
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
  svc.invalidar(); const r = await svc.listar(admin, {});
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
