'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const B = require('../lib/bk');
const { createFinStore } = require('../lib/finStore');
const { createBkApi } = require('../lib/bkApi');

const H = '2026-06-15';
const un = (o = {}) => B.validaUnidade({ bkn: '100', nome: 'Loja A', necessitaRt: 'sim', licenca: 'sim', rt: { nome: 'Fulana' }, ...o });

test('validação da unidade', () => {
  assert.throws(() => B.validaUnidade({ nome: 'x' }), /BKN/);
  assert.throws(() => B.validaUnidade({ bkn: '1', nome: 'Loja', licencaValidade: '31/12/2026' }), /Data inválida/);
  const u = un({ cnpj: '13.574.594/0001-00', uf: 'sp', licenca: 'Sim' });
  assert.equal(u.cnpj, '13574594000100'); assert.equal(u.uf, 'SP'); assert.equal(u.licenca, 'sim');
});

test('alertas e pendências', () => {
  const u = un({ licencaValidade: '2026-06-10', rt: { nome: '', validade: '2026-06-20' }, etapa: 'aguarda_licenca' });
  const al = B.alertasUnidade(u, H);
  assert.equal(al.find(a => a.tipo === 'licenca').nivel, 'vencido');
  assert.equal(al.find(a => a.tipo === 'rt').nivel, 'critico');
  const p = B.pendencias(u, H);
  assert.ok(p.some(x => /sem nutricionista|não tem nutricionista/i.test(x)) && p.some(x => /vencida há 5/.test(x)) && p.some(x => /aguardando a licença/.test(x)));
  assert.deepEqual(B.pendencias(un({ ativa: false }), H), []);
  assert.deepEqual(B.pendencias(un(), H), []);
});

test('aviso por marco: um por vez e só uma vez', () => {
  const m = [60, 30, 15, 7, 0];
  assert.equal(B.avisoDevido(90, m, []), null);
  assert.equal(B.avisoDevido(28, m, []), 30);
  assert.equal(B.avisoDevido(28, m, [30]), null);
  assert.equal(B.avisoDevido(6, m, [30]), 7);
  assert.equal(B.avisoDevido(-3, m, [7]), -1);
  assert.equal(B.avisoDevido(-3, m, [-1]), null);
});

test('importação CSV (ponto e vírgula, aspas, datas BR, status)', () => {
  const csv = '﻿BKNs;CNPJ;NOME DA LOJA;ESTADO;CIDADE;LICENÇA SANITARIA (interno);STATUS DA DOCUMENTAÇÃO;PREVISÃO DE VIRADA;NUTRICIONISTA RT\n17959;13.574.594/0937-71;"Loja ""Centro"" SP";MG;Uberlândia;Sim ;DEFERIDO;30/07/2026;Fulana\n;;;;;;;;\n123;;Outra;SP;Santos;Não;aguarda licença;;\n';
  const r = B.importarCsv(csv);
  assert.equal(r.unidades.length, 2); assert.equal(r.unidades[0].nome, 'Loja "Centro" SP');
  assert.equal(r.unidades[0].etapa, 'deferido'); assert.equal(r.unidades[0].previsaoVirada, '2026-07-30'); assert.equal(r.unidades[0].licenca, 'sim');
  assert.equal(r.unidades[1].etapa, 'aguarda_licenca'); assert.equal(r.unidades[1].licenca, 'nao');
  assert.throws(() => B.importarCsv('a;b\n1;2'), /BKN/);
});

test('esteira: mover registra histórico e desligar inativa', () => {
  const { unidade, evento } = B.mover(un({ prazo: '2026-06-20' }), 'deferido', 'ok', 'ana', H);
  assert.equal(unidade.prazo, ''); assert.equal(evento.para, 'deferido');
  assert.equal(B.mover(un(), 'desligado', '', '', H).unidade.ativa, false);
  assert.throws(() => B.mover(un(), 'aguardando', '', '', H), /já está/);
  assert.throws(() => B.mover(un(), 'xx', '', '', H), /inválida/);
});

test('medição: pula já medidas e sem valor', () => {
  const a = { id: 'a', ...un({ bkn: '1', valorMensal: 1000 }) }, b = { id: 'b', ...un({ bkn: '2' }) }, c = { id: 'c', ...un({ bkn: '3', valorMensal: 500 }) };
  const p = B.planejarMedicao({ unidades: [a, b, c], competencia: '2026-05', valorPadrao: 0, medidas: [{ competencia: '2026-05', unidadeId: 'c' }], hoje: H });
  assert.equal(p.geram, 1); assert.equal(p.total, 1000); assert.equal(p.ignoradas, 2);
  assert.equal(B.planejarMedicao({ unidades: [b], competencia: '2026-05', valorPadrao: 800, medidas: [], hoje: H }).total, 800);
  assert.throws(() => B.compOk('2026-13'), /inválida/);
  assert.equal(B.mesAnterior('2026-01-10'), '2025-12');
});

test('API: cadastro, esteira, medição gerando A Receber, desfazer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const fin = createFinStore(dir); fin.empresas.add({ id: 'e1', nome: 'Nutri Mix', ativa: true });
  const api = createBkApi({ fin, bitrix: { enabled: false }, store: { log() {} }, dir });
  const call = async (m, p, b) => { const u = new URL('http://x' + p); const r = await api.handle(m, u.pathname, u, async () => b || {}); return r.json; };
  const x = await call('POST', '/api/bk/unidades', { bkn: '10', nome: 'Loja 10', valorMensal: 1200, licenca: 'sim', necessitaRt: 'sim' });
  await assert.rejects(call('POST', '/api/bk/unidades', { bkn: '10', nome: 'Dup' }), /Já existe/);
  await call('POST', `/api/bk/unidades/${x.id}/mover`, { etapa: 'enviado', nota: 'protocolado' });
  assert.equal((await call('GET', `/api/bk/unidades/${x.id}`)).historico.length, 1);
  await call('POST', '/api/bk/demo/carregar'); const lista = await call('GET', '/api/bk/unidades?pp=5&page=2');
  assert.equal(lista.itens.length, 5); assert.ok(lista.paginas >= 3);
  await assert.rejects(call('POST', '/api/bk/medicao/gerar', { competencia: '2026-05' }), /empresa/i);
  await call('PUT', '/api/bk/config', { empresaId: 'e1', diaVenc: 10, valorPadrao: 1000 });
  const g = await call('POST', '/api/bk/medicao/gerar', { competencia: '2026-05' });
  assert.ok(g.geradas >= 2); assert.equal(g.venc, '2026-06-10');
  assert.equal(fin.receber.all().filter(r => r.origem === 'bk').length, g.geradas);
  await assert.rejects(call('POST', '/api/bk/medicao/gerar', { competencia: '2026-05' }), /Nenhuma unidade/);
  assert.equal((await call('GET', '/api/bk/medicoes'))[0].unidades, g.geradas);
  await call('POST', '/api/bk/medicao/desfazer', { competencia: '2026-05' });
  assert.equal(fin.receber.all().length, 0);
  await call('DELETE', '/api/bk/demo'); assert.equal((await call('GET', '/api/bk/bootstrap')).resumo.total, 1);
  const av = await call('POST', '/api/bk/avisar', { simular: true }); assert.ok(Array.isArray(av.enviados));
  const imp = await call('POST', '/api/bk/importar', { csv: 'BKN;Unidade BK;Estado\n10;Loja 10 nova;SP\n11;Loja 11;MG\n' });
  assert.deepEqual([imp.criadas, imp.atualizadas], [1, 1]);
});

test('BK: unidade nasce de empresa do Bitrix24 (sem duplicar), vínculo por CNPJ e criação com checagem', async () => {
  const { createBxEmpresas } = require('../lib/bxEmpresas');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), fin = createFinStore(dir), lista = [{ ID: '5', TITLE: 'BK Anhaia Mello', UF_C: '13.574.594/0654-84', UF_CID: 'São Paulo', UF_UF: 'SP' }], calls = [];
  const bitrix = { enabled: true, base: 'https://p.bitrix24.com.br/rest/1/x', async call(m, p) { calls.push(m);
    if (m === 'crm.company.userfield.list') return { result: [{ FIELD_NAME: 'UF_C', EDIT_FORM_LABEL: 'CNPJ' }, { FIELD_NAME: 'UF_CID', EDIT_FORM_LABEL: 'Cidade' }, { FIELD_NAME: 'UF_UF', EDIT_FORM_LABEL: 'Estado' }] };
    if (m === 'crm.company.list') return { result: lista }; if (m === 'crm.company.add') { lista.push({ ID: '6', TITLE: p.fields.TITLE }); return { result: '6' }; } return { result: true }; } };
  const api = createBkApi({ fin, bitrix, bx: createBxEmpresas({ bitrix }), funil: require('../lib/bxFunil').createBxFunil({ bitrix }), store: { log() {} }, dir });
  const call = async (m, p, b) => { const u = new URL('http://x' + p); return (await api.handle(m, u.pathname, u, async () => b || {})).json; };
  await assert.rejects(call('POST', '/api/bk/unidades', { bkn: '1', nome: 'Loja 1' }), /cadastro do Bitrix24/);
  await assert.rejects(call('POST', '/api/bk/unidades', { bkn: '1', nome: 'Loja 1', empresaBitrixId: '99' }), /não encontrada/);
  const a = await call('POST', '/api/bk/unidades', { bkn: '1', nome: 'Loja 1', empresaBitrixId: '5' }); assert.equal(a.empresaBitrixId, '5');
  const csv = 'BKN;Unidade BK;CNPJ\n7;Anhaia Mello;13574594065484\n8;Outra;99999999000199\n';
  await call('POST', '/api/bk/importar', { csv }); assert.equal((await call('POST', '/api/bk/vincular-empresas', {})).vinculadas, 1);
  const outra = (await call('GET', '/api/bk/unidades?q=Outra')).itens[0], s = await call('GET', `/api/bk/unidades/${outra.id}/sugestoes`); assert.ok(Array.isArray(s));
  const c = await call('POST', `/api/bk/unidades/${outra.id}/criar-empresa`, {}); assert.equal(c.empresaBitrixId, '6');
  const dup = (await call('POST', '/api/bk/unidades', { bkn: '9', nome: 'Zeta', cnpj: '13574594065484', empresaBitrixId: '5' })); const r = await call('POST', `/api/bk/unidades/${dup.id}/criar-empresa`, {}).catch(e => e); assert.match(String(r.message), /já está vinculada/);
});


test('BK ↔ funil Regularização: cria negócio por unidade com empresa, etapa nos dois sentidos, sem duplicar', async () => {
  const { createBxEmpresas } = require('../lib/bxEmpresas'), { createBxFunil } = require('../lib/bxFunil');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), fin = createFinStore(dir), deals = [], calls = [];
  const stages = [['C14:NEW', 'Diagnóstico'], ['C14:A', 'Plano de adequação'], ['C14:B', 'Protocolado'], ['C14:C', 'Aguardando vistoria'], ['C14:D', 'Exigências (loop)'], ['C14:E', 'Licença emitida'], ['C14:F', 'Cancelado']].map(([STATUS_ID, NAME]) => ({ STATUS_ID, NAME }));
  const bitrix = { enabled: true, base: 'https://p.bitrix24.com.br/rest/1/x', async call(m, p) { calls.push(m);
    if (m === 'crm.company.fields') return { result: { UF_C: { formLabel: 'CNPJ' } } };
    if (m === 'crm.company.list') return { result: [{ ID: '5', TITLE: 'BK Anhaia', UF_C: '13.574.594/0654-84' }] };
    if (m === 'crm.status.list') return { result: stages };
    if (m === 'crm.deal.list') return { result: deals.slice() };
    if (m === 'crm.deal.add') { const id = '70' + deals.length; deals.push({ ID: id, ...p.fields, CLOSED: 'N' }); return { result: id }; }
    if (m === 'crm.deal.update') { deals.find(x => x.ID === p.id).STAGE_ID = p.fields.STAGE_ID; return { result: true }; } return { result: true }; } };
  const api = createBkApi({ fin, bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), store: { log() {} }, dir });
  const call = async (m, p, b) => { const u = new URL('http://x' + p); return (await api.handle(m, u.pathname, u, async () => b || {})).json; };
  await call('POST', '/api/bk/importar', { csv: 'BKN;Unidade BK;CNPJ;Status da documentação\n7;Anhaia Mello;13574594065484;ENVIADO\n8;Outra;99999999000199;DEFERIDO\n' });
  const sim = await api.sincronizarFunil({ simular: true }); assert.equal(sim.criados, 1); assert.equal(sim.vinculadasCnpj, 1); assert.equal(deals.length, 0);
  const r = await api.sincronizarFunil({ simular: false }); assert.equal(r.criados, 1); assert.equal(deals[0].STAGE_ID, 'C14:B'); assert.equal(deals[0].COMPANY_ID, '5'); assert.equal(deals[0].CATEGORY_ID, 14);
  assert.equal((await api.sincronizarFunil({ simular: false })).criados, 0);
  const u = (await call('GET', '/api/bk/unidades?q=Anhaia')).itens[0];
  await call('POST', `/api/bk/unidades/${u.id}/mover`, { etapa: 'deferido' }); await new Promise(r => setTimeout(r, 30)); assert.equal(deals[0].STAGE_ID, 'C14:E');   // app → Bitrix24 na hora
  deals[0].STAGE_ID = 'C14:D';                                                                                                                 // Bitrix24 → app
  const r2 = await api.sincronizarFunil({ simular: false }); assert.equal(r2.doBitrix, 1);
  assert.equal((await call('GET', `/api/bk/unidades/${u.id}`)).etapa, 'reenviado'); assert.match((await call('GET', `/api/bk/unidades/${u.id}`)).historico[0].nota, /Bitrix24/);
});

test('BK: cria no Bitrix24 as empresas das unidades (CNPJ igual só vincula; completa pela Receita), em lotes', async () => {
  const { createBxEmpresas } = require('../lib/bxEmpresas'), { createBxFunil } = require('../lib/bxFunil'), { createCnpj } = require('../lib/cnpj');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), fin = createFinStore(dir), lista = [{ ID: '5', TITLE: 'BK Anhaia', UF_C: '13.574.594/0654-84' }], adds = [];
  const bitrix = { enabled: true, base: 'https://p.bitrix24.com.br/rest/1/x', async call(m, p) {
    if (m === 'crm.company.fields') return { result: { UF_C: { formLabel: 'CNPJ' }, UF_R: { formLabel: 'Razão Social' }, UF_CID: { formLabel: 'Cidade' }, UF_UF: { formLabel: 'Estado' }, UF_CEP: { formLabel: 'CEP' } } };
    if (m === 'crm.company.list') return { result: lista }; if (m === 'crm.company.add') { adds.push(p.fields); lista.push({ ID: String(50 + adds.length), TITLE: p.fields.TITLE, UF_C: p.fields.UF_C }); return { result: String(50 + adds.length) }; } return { result: true }; } };
  const cnpjApi = createCnpj({ fetchFn: async url => url.endsWith('11222333000181') ? { status: 200, ok: true, json: async () => ({ razao_social: 'OUTRA COMERCIO LTDA', municipio: 'SANTOS', uf: 'SP', cep: '11000000', bairro: 'CENTRO', descricao_tipo_de_logradouro: 'RUA', logradouro: 'DAS FLORES' }) } : { status: 404, ok: false } });
  const api = createBkApi({ fin, bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), cnpjApi, store: { log() {} }, dir });
  const call = async (m, p, b) => { const u = new URL('http://x' + p); return (await api.handle(m, u.pathname, u, async () => b || {})).json; };
  await call('POST', '/api/bk/importar', { csv: 'BKN;Unidade BK;CNPJ;Cidade\n7;Anhaia Mello;13574594065484;São Paulo\n8;Outra Loja;11222333000181;\n9;Sem CNPJ;;Curitiba\n' });
  const sim = await call('POST', '/api/bk/empresas/criar-pendentes', {}); assert.deepEqual([sim.vincular, sim.criar, sim.semCnpj], [1, 2, 1]); assert.equal(adds.length, 0);
  const r = await call('POST', '/api/bk/empresas/criar-pendentes', { simular: false, lote: 2 }); assert.equal(r.restantes, 1); assert.equal(adds.length, 1); assert.equal(adds[0].UF_R, 'OUTRA COMERCIO LTDA'); assert.equal(adds[0].UF_CEP, '11000000'); assert.equal(adds[0].UF_C, '11.222.333/0001-81');
  const r2 = await call('POST', '/api/bk/empresas/criar-pendentes', { simular: false, lote: 5 }); assert.equal(r2.restantes, 0); assert.equal(adds.length, 2);
  const us = (await call('GET', '/api/bk/unidades?pp=100')).itens; assert.ok(us.every(u => u.empresaBitrixId)); assert.equal(us.find(u => u.bkn === '7').empresaBitrixId, '5');
});
