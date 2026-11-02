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
  const api = createBkApi({ fin, bitrix, bx: createBxEmpresas({ bitrix }), store: { log() {} }, dir });
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
