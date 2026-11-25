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

// Bitrix24 de mentira para o funil 18 (negócios, campos do usuário, formulário, contatos).
function fakeFunil18() {
  const st = { deals: [], uf: new Map(), cfg: [{ name: 'main', title: 'Sobre o negócio', type: 'section', elements: [{ name: 'TITLE' }, { name: 'CLIENT' }, { name: 'UF_CRM_1795613816' }, { name: 'UF_CRM_1795615183' }] }], cfgSet: null, file: 900, calls: [], comentarios: [] };
  const add = (cod, o) => st.uf.set(cod, { ID: String(st.uf.size + 1), FIELD_NAME: cod, ...o });
  add('UF_CRM_1795613816', { MULTIPLE: 'N', USER_TYPE_ID: 'enumeration', LIST: [{ ID: '530', VALUE: 'Licença sanitária' }, { ID: '532', VALUE: 'ASO' }, { ID: '558', VALUE: 'Defesa' }] }); add('UF_CRM_1795615183', { MULTIPLE: 'Y', USER_TYPE_ID: 'crm' });
  const fields = () => Object.fromEntries([...st.uf.values()].map(f => [f.FIELD_NAME, { isMultiple: f.MULTIPLE === 'Y', items: (f.LIST || []).map(i => ({ ID: i.ID, VALUE: i.VALUE })) }]));
  const stages = [['C18:NEW', 'Solicitação'], ['C18:UC_L', 'Levantamento Documento'], ['C18:UC_V', 'Verfiicação Documentação'], ['C18:UC_E', 'Envio de Documentos'], ['C18:WON', 'Finalizada'], ['C18:LOSE', 'Cancelado']];
  const itemsDe = lst => (lst || []).map((i, k) => ({ ID: i.ID || String(1000 + st.uf.size * 100 + k), VALUE: i.VALUE, SORT: i.SORT }));
  st.bitrix = { enabled: true, base: 'https://p.bitrix24.com.br/rest/1/x', async call(m, p) {
    st.calls.push([m, p]);
    switch (m) {
      case 'crm.deal.fields': return { result: fields() };
      case 'crm.deal.userfield.list': return { result: [...st.uf.values()].filter(f => !p.filter || f.FIELD_NAME === p.filter.FIELD_NAME) };
      case 'crm.deal.userfield.add': { const f = p.fields; add('UF_CRM_' + f.FIELD_NAME, { MULTIPLE: f.MULTIPLE, USER_TYPE_ID: f.USER_TYPE_ID, LIST: itemsDe(f.LIST) }); return { result: 1 }; }
      case 'crm.deal.userfield.update': { const f = [...st.uf.values()].find(x => x.ID === String(p.id)); f.LIST = itemsDe(p.fields.LIST); return { result: true }; }
      case 'crm.deal.userfield.delete': for (const [k, v] of st.uf) if (v.ID === String(p.id)) st.uf.delete(k); return { result: true };
      case 'crm.item.details.configuration.get': return { result: JSON.parse(JSON.stringify(st.cfg)) };
      case 'crm.item.details.configuration.set': st.cfgSet = p.data; st.cfg = p.data; return { result: true };
      case 'crm.status.list': return { result: stages.map(([STATUS_ID, NAME]) => ({ STATUS_ID, NAME })) };
      case 'crm.deal.list': return { result: st.deals.filter(x => String(x.CATEGORY_ID) === String(p.filter.CATEGORY_ID)) };
      case 'crm.deal.get': return { result: st.deals.find(x => x.ID === String(p.id)) };
      case 'crm.deal.update': { const x = st.deals.find(y => y.ID === String(p.id)); for (const [k, v] of Object.entries(p.fields)) { if (Array.isArray(v) && v.some(i => i && i.fileData)) x[k] = v.map(i => (i.fileData ? { id: ++st.file, nome: i.fileData[0], showUrl: '/f/' + st.file } : { id: i.id })); else x[k] = v; } return { result: true }; }
      case 'crm.company.fields': return { result: { UF_C: { formLabel: 'CNPJ' } } }; case 'crm.company.userfield.list': return { result: [] };
      case 'crm.company.list': return { result: [{ ID: '5', TITLE: 'BK Anhaia', UF_C: '13.574.594/0654-84' }] };
      case 'crm.company.add': return { result: '6' };
      case 'crm.contact.list': return { result: p.filter && p.filter.COMPANY_ID ? [{ ID: '31', NAME: 'Ana', LAST_NAME: 'Gerente', EMAIL: [{ VALUE: 'ana@bk.com' }] }, { ID: '32', NAME: 'Sem Email' }] : [{ ID: '31', NAME: 'Ana', LAST_NAME: 'Gerente', EMAIL: [{ VALUE: 'ana@bk.com' }] }] };
      case 'crm.contact.get': return { result: { ID: p.id, NAME: 'Ana', LAST_NAME: 'Gerente', EMAIL: [{ VALUE: 'ana@bk.com' }] } };
      case 'crm.timeline.comment.add': st.comentarios.push(p.fields.COMMENT); return { result: 1 };
      case 'crm.requisite.list': return { result: [] };
      default: return { result: true };
    } } };
  return st;
}
const apiFunil18 = (st, extra = {}) => {
  const { createBxEmpresas } = require('../lib/bxEmpresas'), { createBxFunil } = require('../lib/bxFunil'), { cnpjValido } = require('../lib/cnpj'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), fin = createFinStore(dir);
  const cnpjApi = { cnpjValido, consultar: async c => { if (!cnpjValido(c)) throw new Error('CNPJ inválido.'); return { cnpj: c, razao: 'LOJA OITO LTDA', fantasia: 'Loja Oito', cidade: 'Santos', uf: 'SP', cep: '11000000', bairro: 'Centro' }; } };
  const api = createBkApi({ fin, bitrix: st.bitrix, bx: createBxEmpresas({ bitrix: st.bitrix }), funil: createBxFunil({ bitrix: st.bitrix }), cnpjApi, store: { log() {} }, dir, ...extra });
  const call = async (m, p, b, user) => { const u = new URL('http://x' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user || { nome: 'Mônica', perfil: 'admin' })).json; };
  return { api, call };
};

test('BK funil 18: preparar campos (Tipo de Serviço múltiplo, unidade, documentos), migração do tipo e formulário do negócio', async () => {
  const st = fakeFunil18(); st.deals.push({ ID: '101', TITLE: 'BKN 7 — Anhaia', CATEGORY_ID: '18', STAGE_ID: 'C18:NEW', COMPANY_ID: '5', UF_CRM_1795613816: '530' });
  const { call } = apiFunil18(st);
  let k = await call('GET', '/api/bk/kanban'); assert.equal(k.campos.prontos, false); assert.equal(k.campos.novoTipo, false); assert.deepEqual(k.cards[0].tiposNomes, ['Licença sanitária']);   // funciona com o campo antigo
  const sim = await call('POST', '/api/bk/kanban/preparar', {}); assert.equal(sim.simulacao, true); assert.ok(sim.criar.includes('Tipo de Serviço') && sim.criar.includes('Documentos Recebidos'));
  const r = await call('POST', '/api/bk/kanban/preparar', { simular: false }); assert.ok(r.criados.includes('Tipo de Serviço')); assert.equal(r.migrados, 1);
  assert.equal(st.uf.get('UF_CRM_BK_TIPO_SERV').MULTIPLE, 'Y'); assert.deepEqual(st.uf.get('UF_CRM_BK_TIPO_SERV').LIST.map(i => i.VALUE), ['Licença sanitária', 'ASO', 'Defesa']); assert.equal(st.uf.get('UF_CRM_BK_DOCS_RECEB').MULTIPLE, 'Y'); assert.equal(st.uf.get('UF_CRM_BK_LICENCA').LIST.length, 3);
  const main = st.cfgSet.find(s => s.name === 'main').elements.map(e => e.name); assert.ok(main.includes('UF_CRM_BK_TIPO_SERV') && !main.includes('UF_CRM_1795613816') && main.includes('UF_CRM_1795615183') && main.includes('CLIENT'));
  assert.ok(st.cfgSet.find(s => s.name === 'bk_unidade').elements.some(e => e.name === 'UF_CRM_BK_RT_NOME')); assert.ok(st.cfgSet.find(s => s.name === 'bk_docs'));
  k = await call('GET', '/api/bk/kanban'); assert.equal(k.campos.prontos, true); assert.equal(k.multiplo, true); assert.deepEqual(k.cards[0].tiposNomes, ['Licença sanitária']); assert.equal(k.cards[0].tipos.length, 1);
  assert.equal((await call('POST', '/api/bk/kanban/preparar', { simular: false })).criados.length, 0);   // idempotente
  await call('PUT', '/api/bk/kanban/101/tipos', { tipos: st.uf.get('UF_CRM_BK_TIPO_SERV').LIST.slice(0, 2).map(i => i.ID) }); assert.equal(st.deals[0].UF_CRM_BK_TIPO_SERV.length, 2);
});

test('BK funil 18: checklist por tipo de serviço (modelos, itens no Bitrix24, bloqueio ao avançar) e prazos por tipo', async () => {
  const st = fakeFunil18(), { call } = apiFunil18(st); st.deals.push({ ID: '101', TITLE: 'BKN 7 — Anhaia', CATEGORY_ID: '18', STAGE_ID: 'C18:UC_V', COMPANY_ID: '5' });
  await call('POST', '/api/bk/kanban/preparar', { simular: false }); const tipos = st.uf.get('UF_CRM_BK_TIPO_SERV').LIST, lic = tipos.find(t => t.VALUE === 'Licença sanitária').ID, aso = tipos.find(t => t.VALUE === 'ASO').ID; st.deals[0].UF_CRM_BK_TIPO_SERV = [lic, aso];
  await assert.rejects(call('PUT', '/api/bk/kanban/checklists', { checklists: { ASO: ['x'] } }, { nome: 'Op', perfil: 'financeiro' }), /administrador/);
  await call('PUT', '/api/bk/kanban/checklists', { checklists: { 'Licença sanitária': ['CNPJ conferido', 'Planta anexada'], ASO: 'Exame admissional\nExame periódico' } });
  assert.deepEqual(st.uf.get('UF_CRM_BK_CHECK').LIST.map(i => i.VALUE), ['Licença sanitária › CNPJ conferido', 'Licença sanitária › Planta anexada', 'ASO › Exame admissional', 'ASO › Exame periódico']); assert.equal(st.uf.get('UF_CRM_BK_CHECK').MULTIPLE, 'Y');
  assert.ok(st.cfgSet.find(s => s.name === 'bk_check'));
  await call('PUT', '/api/bk/kanban/checklists', { checklists: { 'Licença sanitária': ['CNPJ conferido', 'Planta anexada', 'Laudo da água'], ASO: ['Exame admissional', 'Exame periódico'] } });   // item novo entra, os antigos ficam
  assert.equal(st.uf.get('UF_CRM_BK_CHECK').LIST.length, 5);
  let c = (await call('GET', '/api/bk/kanban')).cards[0]; assert.equal(c.checklist.total, 5); assert.equal(c.checklist.pendentes, 5); assert.deepEqual(c.checklist.grupos.map(g => g.tipo), ['Licença sanitária', 'ASO']); assert.equal(c.checklistPendente, true);
  await assert.rejects(call('POST', '/api/bk/kanban/101/mover', { etapa: 'C18:UC_E' }), /Checklist de verificação incompleto: faltam 5/);
  await call('POST', '/api/bk/kanban/101/mover', { etapa: 'C18:LOSE' }); assert.equal(st.deals[0].STAGE_ID, 'C18:LOSE'); st.deals[0].STAGE_ID = 'C18:UC_V';   // cancelar nunca é bloqueado
  const chaves = c.checklist.grupos.flatMap(g => g.itens.map(i => i.chave)); await assert.rejects(call('PUT', '/api/bk/kanban/101/checklist', { feitos: ['ASO › inventado'] }), /inválido/);
  await call('PUT', '/api/bk/kanban/101/checklist', { feitos: chaves.slice(0, 3) }); c = (await call('GET', '/api/bk/kanban')).cards[0]; assert.equal(c.checklist.feitos, 3); assert.equal(c.checklist.grupos[0].itens.filter(i => i.feito).length, 3);
  await assert.rejects(call('POST', '/api/bk/kanban/101/mover', { etapa: 'C18:UC_E' }), /faltam 2.*ASO \(2\)/);
  await call('PUT', '/api/bk/kanban/101/checklist', { feitos: chaves }); await call('POST', '/api/bk/kanban/101/mover', { etapa: 'C18:UC_E' }); assert.equal(st.deals[0].STAGE_ID, 'C18:UC_E');
  st.deals[0].STAGE_ID = 'C18:UC_V'; st.deals[0].UF_CRM_BK_CHECK = []; st.deals[0].UF_CRM_BK_TIPO_SERV = [lic, aso, tipos.find(t => t.VALUE === 'Defesa').ID];   // tipo sem modelo não trava, mas é avisado
  c = (await call('GET', '/api/bk/kanban')).cards[0]; assert.deepEqual(c.checklist.semModelo, ['Defesa']);
  await call('PUT', '/api/bk/kanban/101/prazos', { prazos: { 'Licença sanitária': '2026-12-10', ASO: '2026-11-01' } }); assert.equal(st.deals[0].UF_CRM_BK_PRAZOS, 'Licença sanitária: 10/12/2026\nASO: 01/11/2026');
  c = (await call('GET', '/api/bk/kanban')).cards[0]; assert.equal(c.prazos['Licença sanitária'], '2026-12-10'); assert.equal(c.prazoVencido, true); await assert.rejects(call('PUT', '/api/bk/kanban/101/prazos', { prazos: { 'Outro': '2026-12-10' } }), /não está neste negócio/);
  st.deals[0].UF_CRM_BK_PRAZOS = 'ASO: 20/12/2026'; c = (await call('GET', '/api/bk/kanban')).cards[0]; assert.equal(c.prazoVencido, false);   // quem edita no Bitrix24 também vale
});

test('BK funil 18: dados da unidade nos dois sentidos (app ⇄ formulário do negócio) e unidade criada a partir do negócio', async () => {
  const st = fakeFunil18(), { api, call } = apiFunil18(st); st.deals.push({ ID: '101', TITLE: 'BKN 7 — Anhaia', CATEGORY_ID: '18', STAGE_ID: 'C18:NEW', COMPANY_ID: '5' }, { ID: '102', TITLE: 'BKN 88 — Loja Nova', CATEGORY_ID: '18', STAGE_ID: 'C18:NEW', COMPANY_ID: '5' });
  await call('POST', '/api/bk/importar', { csv: 'BKN;Unidade BK;CNPJ;Cidade;Estado\n7;Anhaia Mello;13574594065484;São Paulo;SP\n' }); await call('PUT', `/api/bk/unidades/${api.unidades()[0].id}`, { rt: { nome: 'Dra. Ana' } });
  await call('POST', '/api/bk/kanban/preparar', { simular: false }); const lic = st.uf.get('UF_CRM_BK_LICENCA').LIST;
  await call('GET', '/api/bk/kanban'); const x = st.deals.find(d => d.ID === '101');
  assert.equal(x.UF_CRM_BK_BKN, '7'); assert.equal(x.UF_CRM_BK_UNIDADE, 'Anhaia Mello'); assert.equal(x.UF_CRM_BK_CIDADE, 'São Paulo'); assert.equal(x.UF_CRM_BK_RT_NOME, 'Dra. Ana'); assert.equal(x.UF_CRM_BK_LICENCA, lic.find(i => i.VALUE === 'Pendente').ID);   // app → Bitrix24
  x.UF_CRM_BK_CIDADE = 'Campinas'; x.UF_CRM_BK_LICENCA = lic.find(i => i.VALUE === 'Sim').ID; x.UF_CRM_BK_LIC_VALIDADE = '2027-05-01T03:00:00+03:00'; await call('GET', '/api/bk/kanban');                                       // Bitrix24 → app
  const un = api.unidades().find(u => u.bkn === '7'); assert.equal(un.cidade, 'Campinas'); assert.equal(un.licenca, 'sim'); assert.equal(un.licencaValidade, '2027-05-01');
  const id = un.id; await call('PUT', `/api/bk/unidades/${id}`, { uf: 'MG' }); await call('GET', '/api/bk/kanban'); assert.equal(x.UF_CRM_BK_UF, 'MG'); assert.equal(x.UF_CRM_BK_CIDADE, 'Campinas');   // edição no app volta ao Bitrix24 sem desfazer o outro lado
  x.UF_CRM_BK_UF = 'RJ'; await call('PUT', `/api/bk/unidades/${id}`, { uf: 'ES' }); await call('GET', '/api/bk/kanban'); assert.equal(api.unidades().find(u => u.id === id).uf, 'RJ');   // mudaram os dois: vale o Bitrix24
  const y = st.deals.find(d => d.ID === '102'); y.UF_CRM_BK_UNIDADE = 'Loja Nova SP'; y.UF_CRM_BK_CNPJ = '11.222.333/0001-81'; y.UF_CRM_BK_RT_NOME = 'Dr. Beto'; y.UF_CRM_BK_LICENCA = lic.find(i => i.VALUE === 'Não').ID;
  const nu = await call('POST', '/api/bk/kanban/102/unidade', {}); assert.equal(nu.unidade.nome, 'Loja Nova SP'); const u2 = api.unidades().find(u => u.bkn === '88'); assert.equal(u2.cnpj, '11222333000181'); assert.equal(u2.rt.nome, 'Dr. Beto'); assert.equal(u2.licenca, 'nao'); assert.equal(u2.empresaBitrixId, '5');
});

test('BK funil 18: pedir documentos a contatos/empresas do CRM, anexar vários arquivos e vincular empresa/contato no card', async () => {
  const st = fakeFunil18(), { call } = apiFunil18(st); st.deals.push({ ID: '201', TITLE: 'BKN 55 — Loja', CATEGORY_ID: '18', STAGE_ID: 'C18:NEW', COMPANY_ID: '5' }, { ID: '202', TITLE: 'BKN 8 — Oito', CATEGORY_ID: '18', STAGE_ID: 'C18:NEW', COMPANY_ID: '0' });
  await assert.rejects(call('POST', '/api/bk/kanban/201/pedir', { refs: ['C_31'] }), /ainda não existem/); await call('POST', '/api/bk/kanban/preparar', { simular: false });
  const op = await call('GET', '/api/bk/kanban/201/pedir/opcoes'); assert.deepEqual(op.opcoes.map(o => o.ref), ['CO_5', 'C_31', 'C_32']);
  await assert.rejects(call('POST', '/api/bk/kanban/201/pedir', { refs: [] }), /a quem/); await assert.rejects(call('POST', '/api/bk/kanban/201/pedir', { refs: ['X_1'] }), /a quem/);
  const p = await call('POST', '/api/bk/kanban/201/pedir', { refs: ['C_31', 'CO_5'], mensagem: 'Olá, precisamos dos documentos.' });
  assert.deepEqual(st.deals[0].UF_CRM_1795615183, ['C_31', 'CO_5']); assert.equal(st.deals[0].STAGE_ID, 'C18:UC_L'); assert.equal(p.moveuPara, 'Levantamento Documento'); assert.deepEqual(p.emails, [{ nome: 'Ana Gerente', email: 'ana@bk.com' }]); assert.ok(st.comentarios.some(c => /Documentos solicitados/.test(c)));
  let c = (await call('GET', '/api/bk/kanban')).cards.find(x => x.id === '201'); assert.deepEqual(c.pedir.map(x => x.nome), ['Ana Gerente', 'BK Anhaia']);
  const b64 = Buffer.from('conteudo').toString('base64');
  await call('POST', '/api/bk/kanban/201/documentos/anexar', { campo: 'recebidos', arquivos: [{ nome: 'cnpj.pdf', dados: b64 }] }); await call('POST', '/api/bk/kanban/201/documentos/anexar', { campo: 'recebidos', arquivos: [{ nome: 'aso.pdf', dados: 'data:application/pdf;base64,' + b64 }, { nome: 'ru/im.pdf', dados: b64 }] });
  await call('POST', '/api/bk/kanban/201/documentos/anexar', { campo: 'nutrimix', arquivos: [{ nome: 'plano.docx', dados: b64 }] });
  assert.equal(st.deals[0].UF_CRM_BK_DOCS_RECEB.length, 3); assert.equal(st.deals[0].UF_CRM_BK_DOCS_NUTRI.length, 1); await assert.rejects(call('POST', '/api/bk/kanban/201/documentos/anexar', { campo: 'outro', arquivos: [{ nome: 'x', dados: b64 }] }), /Escolha onde/);
  c = (await call('GET', '/api/bk/kanban')).cards.find(x => x.id === '201'); assert.equal(c.docs.recebidos.length, 3); assert.equal(c.docs.nutrimix.length, 1); assert.equal(c.docs.nomes.length, 4);
  await assert.rejects(call('GET', '/api/bk/kanban/202/contatos'), /Vincule primeiro/); await assert.rejects(call('POST', '/api/bk/kanban/202/empresa/buscar', { cnpj: '123' }), /CNPJ inválido/);
  const ach = await call('POST', '/api/bk/kanban/202/empresa/buscar', { cnpj: '13.574.594/0654-84' }); assert.equal(ach.encontradas[0].id, '5'); assert.equal(st.deals[1].COMPANY_ID, '0');   // buscar não vincula sozinho
  await call('POST', '/api/bk/kanban/202/empresa/vincular', { empresaId: '5' }); assert.equal(st.deals[1].COMPANY_ID, '5');
  const ct = await call('GET', '/api/bk/kanban/202/contatos'); assert.equal(ct.contatos.length, 2); await call('POST', '/api/bk/kanban/202/contato', { contatoId: '31' }); assert.equal(st.deals[1].CONTACT_ID, '31'); await assert.rejects(call('POST', '/api/bk/kanban/202/contato', { contatoId: '99' }), /não pertence/);
});

test('modelos de documentos: ZIP, marcadores partidos em vários trechos, parágrafo vazio some, planilha e certificado em PDF', () => {
  const { lerZip, criarZip } = require('../lib/zip'), G = require('../lib/docGen'), PDF = require('../lib/pdfCert');
  const doc = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Olá {{no</w:t></w:r><w:r><w:t xml:space="preserve">me}}, </w:t></w:r><w:r><w:t>do {{ cnpj }} &amp; cia.</w:t></w:r></w:p><w:p><w:r><w:t>{{opcional}}</w:t></w:r></w:p><w:p><w:r><w:t>Linhas: {{texto}}</w:t></w:r></w:p></w:body></w:document>`;
  const docx = criarZip([{ nome: '[Content_Types].xml', dados: Buffer.from('<Types/>') }, { nome: 'word/document.xml', dados: Buffer.from(doc) }]);
  assert.deepEqual(lerZip(docx).map(e => e.nome), ['[Content_Types].xml', 'word/document.xml']); assert.deepEqual(G.campos(docx, 'docx').sort(), ['cnpj', 'nome', 'opcional', 'texto']);
  const r = G.gerarDocx(docx, { nome: 'Ana <Souza>', cnpj: '11.222.333/0001-81', opcional: '', texto: 'a\nb' }), x = lerZip(r.buf).find(e => e.nome === 'word/document.xml').dados.toString('utf8');
  assert.match(x.replace(/<[^>]+>/g, ''), /^Olá Ana &lt;Souza&gt;, do 11\.222\.333\/0001-81 &amp; cia\.Linhas: ab$/); assert.doesNotMatch(x, /\{\{|opcional/); assert.match(x, /<w:t[^>]*>Linhas: a<\/w:t><w:br\/><w:t xml:space="preserve">b<\/w:t>/); assert.equal((x.match(/<w:p>/g) || []).length, 2);   // o parágrafo só com campo vazio sumiu
  const plano = require('fs').readFileSync(path.join(__dirname, '..', 'modelos', 'bk', 'plano-acao.xlsx')), p = G.gerarPlanoXlsx(plano, { titulo: 'CRONOGRAMA BKN 7 & Cia', subtitulo: 'Gerente: A', linhas: [{ inadequacao: 'Ralo <sem> fecho', acao: 'Trocar', prazo: '2026-12-01', status: 'EM ANDAMENTO' }, { inadequacao: 'Outra' }] });
  const sh = lerZip(p.buf).find(e => e.nome === 'xl/worksheets/sheet1.xml').dados.toString('utf8'); assert.match(sh, /CRONOGRAMA BKN 7 &amp; Cia/); assert.match(sh, /Ralo &lt;sem&gt; fecho/); assert.match(sh, /<c r="H7" s="4"><v>46357<\/v><\/c>/); assert.match(sh, /<dimension ref="B1:K8"\/>/); assert.ok(!lerZip(p.buf).some(e => /media\/image(?!1\b)/.test(e.nome) && /jpeg/.test(e.nome)));
  const pdf = require('fs').readFileSync(path.join(__dirname, '..', 'modelos', 'bk', 'certificado-bpm.pdf')), c = PDF.gerarCertificado(pdf, { nome: 'Maria de Souza Lima', cpf: '987.654.321-00', data: '2026-11-25' });
  assert.ok(c.length > pdf.length); assert.equal(c.subarray(0, 8).toString(), '%PDF-1.4'); assert.ok(c.includes('(MARIA)') && c.includes('(LIMA)') && c.includes('(98765432100)')); assert.ok(!c.includes('AMANDA ALVES')); assert.ok(c.includes('/Prev ')); assert.ok(c.toString('latin1').endsWith('%%EOF\n'));
  assert.throws(() => PDF.gerarCertificado(pdf, { nome: 'Maria', cpf: '123' }), /CPF inválido/); assert.throws(() => PDF.gerarCertificado(pdf, { nome: '', cpf: '98765432100' }), /nome do participante/);
  assert.equal(PDF.dataExtenso('2026-11-25'), '25 de Novembro de 2026');
});

test('BK funil 18: gerar documentos dos modelos no card, anexar no Bitrix24 e enviar modelo próprio com {{campos}}', async () => {
  const st = fakeFunil18(), { call } = apiFunil18(st), { criarZip } = require('../lib/zip');
  st.deals.push({ ID: '301', TITLE: 'BKN 28209 — FS Cajamar', CATEGORY_ID: '18', STAGE_ID: 'C18:UC_E', COMPANY_ID: '5', CONTACT_ID: '31' });
  await call('POST', '/api/bk/importar', { csv: 'BKN;Unidade BK;CNPJ;Cidade;Estado;CEP;Endereço\n28209;FS Cajamar;13574594112318;Cajamar;SP;07792820;Av. Tenente Marques, 2.391\n' });
  await call('POST', '/api/bk/kanban/preparar', { simular: false }); st.deals[0].UF_CRM_BK_TIPO_SERV = [st.uf.get('UF_CRM_BK_TIPO_SERV').LIST.find(t => t.VALUE === 'Defesa').ID];
  const lista = await call('GET', '/api/bk/kanban/301/modelos'); assert.deepEqual(lista.modelos.map(m => m.id), ['carta-defesa', 'parecer-tecnico', 'plano-acao', 'certificado-bpm']); assert.deepEqual(lista.modelos.filter(m => m.recomendado).map(m => m.id), ['carta-defesa', 'plano-acao']);   // "Defesa" → carta e plano
  const v = await call('GET', '/api/bk/kanban/301/modelos/carta-defesa/valores'); assert.equal(v.valores.filial, 'BURGER KING FS CAJAMAR'); assert.equal(v.valores.cnpj, '13.574.594/1123-18'); assert.equal(v.valores.endereco, 'Av. Tenente Marques, 2.391, Cajamar – SP, 07792-820'); assert.equal(v.valores.destinatario, 'ANA GERENTE'); assert.match(v.valores.considerando, /^Considerando o fato atenuante/); assert.equal(v.valores.empresa, 'ZAMP S.A.');
  await assert.rejects(call('GET', '/api/bk/kanban/301/modelos/nao-existe/valores'), /Modelo não encontrado/);
  const g = await call('POST', '/api/bk/kanban/301/modelos/carta-defesa/gerar', { valores: { ...v.valores, numero_auto: '2710', numero_ficha: '03.001951/26', acao_3: '' } });
  assert.equal(g.anexados, 1); assert.equal(g.arquivos.length, 1); assert.match(g.arquivos[0].nome, /^Carta de defesa - FILIAL CAJAMAR-SP\.docx$/); assert.equal(st.deals[0].UF_CRM_BK_DOCS_NUTRI.length, 1); assert.equal(st.deals[0].UF_CRM_BK_DOCS_NUTRI[0].nome, g.arquivos[0].nome);
  const sem = await call('POST', '/api/bk/kanban/301/modelos/parecer-tecnico/gerar', { valores: { motivo: 'Teste' }, anexar: false }); assert.equal(sem.anexados, 0); assert.equal(st.deals[0].UF_CRM_BK_DOCS_NUTRI.length, 1);
  await assert.rejects(call('POST', '/api/bk/kanban/301/modelos/certificado-bpm/gerar', { valores: {} }), /Preencha: Participantes/); await assert.rejects(call('POST', '/api/bk/kanban/301/modelos/certificado-bpm/gerar', { valores: { participantes: 'Ana; 123' } }), /CPF inválido/);
  const cert = await call('POST', '/api/bk/kanban/301/modelos/certificado-bpm/gerar', { valores: { participantes: 'João Silva; 123.456.789-09\nMaria Souza; 98765432100', curso: 'Curso de Boas Práticas de Manipulação', cargaHoraria: '04:00', cidade: 'São Paulo', dataIso: '2026-11-25' } });
  assert.equal(cert.anexados, 2); assert.deepEqual(cert.arquivos.map(a => a.nome), ['Certificado BPM - João Silva.pdf', 'Certificado BPM - Maria Souza.pdf']); assert.equal(st.deals[0].UF_CRM_BK_DOCS_NUTRI.length, 3);
  const plano = await call('POST', '/api/bk/kanban/301/modelos/plano-acao/gerar', { valores: { titulo: 'CRONOGRAMA - PLANO DE AÇÃO BKN 28209', subtitulo: 'Gerente: Ana', linhas: [{ inadequacao: 'Ralo', acao: 'Trocar', prazo: '2026-12-01' }, {}] }, anexar: false }); assert.match(plano.arquivos[0].nome, /\.xlsx$/);
  // modelo enviado pelo administrador
  const doc = `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Unidade {{unidade}} (BKN {{bkn}}) — {{observacao_livre}}</w:t></w:r></w:p></w:body></w:document>`, arq = criarZip([{ nome: '[Content_Types].xml', dados: Buffer.from('<Types/>') }, { nome: 'word/document.xml', dados: Buffer.from(doc) }]).toString('base64');
  await assert.rejects(call('POST', '/api/bk/kanban/modelos', { nome: 'X', arquivo: arq, nomeArquivo: 'x.pdf' }), /\.docx ou \.xlsx/); await assert.rejects(call('POST', '/api/bk/kanban/modelos', { nome: 'X', arquivo: arq, nomeArquivo: 'x.docx' }, { nome: 'Op', perfil: 'financeiro' }), /administrador/);
  const up = await call('POST', '/api/bk/kanban/modelos', { nome: 'Declaração simples', tipos: ['Visita técnica'], arquivo: arq, nomeArquivo: 'declaracao.docx' }); assert.equal(up.modelo.embutido, false); assert.deepEqual(up.modelo.campos.map(c => c.k).sort(), ['bkn', 'observacao_livre', 'unidade']);
  const v2 = await call('GET', `/api/bk/kanban/301/modelos/${up.modelo.id}/valores`); assert.equal(v2.valores.unidade, 'FS Cajamar'); assert.equal(v2.valores.bkn, '28209');
  const g2 = await call('POST', `/api/bk/kanban/301/modelos/${up.modelo.id}/gerar`, { valores: { ...v2.valores, observacao_livre: 'ok' }, anexar: false }), x = require('../lib/zip').lerZip(Buffer.from(g2.arquivos[0].dados, 'base64')).find(e => e.nome === 'word/document.xml').dados.toString('utf8'); assert.match(x, /Unidade FS Cajamar \(BKN 28209\) — ok/);
  assert.equal((await call('GET', '/api/bk/kanban/modelos')).modelos.length, 5); await call('DELETE', `/api/bk/kanban/modelos/${up.modelo.id}`); await assert.rejects(call('DELETE', '/api/bk/kanban/modelos/carta-defesa'), /não encontrado/); assert.equal((await call('GET', '/api/bk/kanban/modelos')).modelos.length, 4);
});
