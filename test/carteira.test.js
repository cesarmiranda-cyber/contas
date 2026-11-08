'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const C = require('../lib/carteira');
const { createCarteiraApi } = require('../lib/carteiraApi');
const { createBxEmpresas } = require('../lib/bxEmpresas');
const { createBxFunil } = require('../lib/bxFunil');
const R = require('../lib/rules');

test('regras: contrato vencendo, valor efetivo (manual vence automático) e validação', () => {
  const h = '2026-11-02';
  assert.deepEqual(C.contratoSituacao({ contrato: { fim: '2026-11-20' } }, h), { estado: 'vencendo', dias: 18, fim: '2026-11-20' });
  assert.equal(C.contratoSituacao({ contrato: { fim: '2026-10-30' } }, h).estado, 'vencido'); assert.equal(C.contratoSituacao({ contrato: { fim: '2027-03-01' } }, h).estado, 'ok'); assert.equal(C.contratoSituacao({ contrato: {} }, h).estado, 'sem');
  assert.equal(C.ativo({ ativoAuto: true, ativoManual: false }), false); assert.equal(C.ativo({ ativoAuto: true, ativoManual: null }), true);
  assert.equal(C.item({ auto: { mbpPop: 'sim' }, manual: { mbpPop: 'andamento' } }, 'mbpPop'), 'andamento'); assert.equal(C.item({ auto: {}, manual: {} }, 'alvara'), 'nao');
  assert.throws(() => C.validaEdicao({ tipo: 'xx' }), /Tipo/); assert.throws(() => C.validaEdicao({ esporadicos: ['Churrasco'] }), /esporádico/);
  assert.throws(() => C.validaEdicao({ contrato: { inicio: '2026-05-01', fim: '2026-04-01' } }), /anterior/); assert.throws(() => C.validaEdicao({ manual: { mbpPop: 'talvez' } }), /inválido/);
});

const bitrixFake = () => {
  const empresas = [
    { ID: '1', TITLE: 'Restaurante A', EMAIL: [{ VALUE: 'a@x.com' }], ASSIGNED_BY_ID: '10', UF_SIT: 'Cliente', UF_ALV: '12345' },
    { ID: '2', TITLE: 'Padaria B', EMAIL: [{ VALUE: 'b@x.com' }], ASSIGNED_BY_ID: '10', UF_SIT: 'Cancelado' },
    { ID: '3', TITLE: 'Mercado C', EMAIL: [], UF_SIT: 'Cliente', UF_TREINO: '2099-01-01' },
    { ID: '4', TITLE: 'NUTRI MIX ASSESSORIA E CONSULTORIA EM NUTRICAO LTDA', UF_SIT: 'Cliente' }];
  const est = { 15: [['C15:A', 'Contrato assinado (ativo)'], ['C15:X', 'Encerrado / Rescindido']], 4: [['C4:A', 'Elaboração'], ['C4:E', 'Entregue']], 14: [['C14:A', 'Diagnóstico'], ['C14:L', 'Licença emitida']], 2: [['C2:A', 'Interesse'], ['C2:W', 'Ganho']] };
  const deals = [
    { ID: '50', CATEGORY_ID: 15, COMPANY_ID: '1', STAGE_ID: 'C15:A', UF_TIPO: '333', UF_INI: '2026-01-10T00:00:00+03:00', UF_FIM: '2026-11-25T00:00:00+03:00', UF_VAL: '900' },
    { ID: '51', CATEGORY_ID: 4, COMPANY_ID: '1', STAGE_ID: 'C4:A' }, { ID: '52', CATEGORY_ID: 4, COMPANY_ID: '3', STAGE_ID: 'C4:E' }, { ID: '53', CATEGORY_ID: 2, COMPANY_ID: '3', STAGE_ID: 'C2:W' }];
  const notif = [];
  return { enabled: true, base: 'https://p.bitrix24.com.br/rest/1/x', notif, async call(m, p) {
    if (m === 'crm.company.fields') return { result: { UF_CNPJ: { formLabel: 'CNPJ' }, UF_SIT: { formLabel: 'Situação' }, UF_ALV: { formLabel: 'Alvará/Licença Sanitária' }, UF_TREINO: { formLabel: 'Validade dos certificados de treinamento' } } };
    if (m === 'crm.company.list') return { result: empresas };
    if (m === 'crm.deal.fields') return { result: { UF_TIPO: { formLabel: 'Tipo de contrato', items: [{ ID: '333', VALUE: 'Assessoria / Consultoria' }, { ID: '335', VALUE: 'Cadastro PAT' }] }, UF_INI: { formLabel: 'Data de inicio da vigencia' }, UF_FIM: { formLabel: 'Data de termino da vigencia' }, UF_VAL: { formLabel: 'Valor mensal (R$)' } } };
    if (m === 'crm.status.list') return { result: (est[Number(p.filter.ENTITY_ID.split('_')[2])] || []).map(([STATUS_ID, NAME]) => ({ STATUS_ID, NAME })) };
    if (m === 'crm.deal.list') return { result: deals.filter(x => x.CATEGORY_ID === Number(p.filter.CATEGORY_ID)) };
    if (m === 'im.notify.personal.add') { notif.push(p); return { result: 1 }; } return { result: true }; } };
};
test('carteira: lê o Bitrix24 (situação, contrato, MBP/POP, alvará, treinamento), ativos antes dos inativos, resumo e alertas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-')), bitrix = bitrixFake(), api = createCarteiraApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), store: { log() {} }, dir, areasDe: u => u.areas || ['contratos'] });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/car' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  const r = await api.sincronizar(); assert.equal(r.empresas, 4); assert.equal(api.dados().clientes.length, 3);   // a própria Nutri Mix fica de fora
  const bo = await call('GET', '/bootstrap'); assert.equal(bo.ativos, 2); assert.equal(bo.inativos, 1);
  const todos = (await call('GET', '/clientes?aba=todos')).itens; assert.deepEqual(todos.map(c => c.ativo), [true, true, false]);   // inativos no fim
  const a = todos.find(c => c.empresaId === '1'); assert.equal(a.tipo, 'consultoria_assessoria'); assert.equal(a.contrato.fim, '2026-11-25'); assert.equal(a.contrato.valor, 900); assert.equal(a.itens.mbpPop.valor, 'andamento'); assert.equal(a.itens.alvara.valor, 'sim');
  const c3 = todos.find(c => c.empresaId === '3'); assert.equal(c3.itens.mbpPop.valor, 'sim'); assert.equal(c3.itens.treinamento.valor, 'sim');
  assert.equal((await call('GET', '/clientes?aba=inativos')).itens[0].nome, 'Padaria B');
  await call('PUT', '/clientes/3', { tipo: 'consultoria', manual: { licenca: 'sim', mbpPop: 'andamento' } });
  const res = await call('GET', '/resumo'); assert.equal(res.total, 2); assert.equal(res.itens.find(x => x.empresaId === '3').itens.mbpPop.valor, 'andamento'); assert.equal(res.itens.find(x => x.empresaId === '3').itens.licenca.valor, 'sim');
  assert.equal((await call('GET', '/resumo?pendencia=1')).total, 2);
  assert.equal((await call('POST', '/clientes/lote', { ids: ['1', '3'], tipo: 'rt' })).atualizados, 2);
  await assert.rejects(call('POST', '/clientes/lote', { ids: [], tipo: 'rt' }), /Selecione/);
  await call('PUT', '/clientes/1', { contrato: { inicio: '2026-01-10', fim: R.todayBR().slice(0, 8) + '28' } });
  const sim = await call('POST', '/avisar', { simular: true }); assert.ok(sim.enviados.length <= 1);
  await call('PUT', '/clientes/1', { contrato: { inicio: '2025-01-01', fim: require('../lib/feriados').somaDias(R.todayBR(), 6) } });   // vence em 6 dias
  const env = await call('POST', '/avisar', { simular: false }); assert.equal(env.enviados.length, 1); assert.equal(bitrix.notif[0].USER_ID, '10'); assert.equal((await call('POST', '/avisar', { simular: false })).enviados.length, 0);   // uma vez por marco
  assert.equal((await call('GET', '/vencimentos?dias=30'))[0].nome, 'Restaurante A');
  const semAcesso = { areas: ['clientes'] };   // sem a área "contratos": vê o estado, nunca valor, datas nem proposta
  const rest = (await call('GET', '/clientes?aba=ativos', null, semAcesso)).itens.find(c => c.empresaId === '1'); assert.equal(rest.contrato.valor, null); assert.equal(rest.contrato.fim, ''); assert.equal(rest.contratoRestrito, true); assert.equal(rest.contratoSituacao.fim, undefined); assert.equal(rest.contratoSituacao.estado, 'vencendo');
  assert.equal((await call('GET', '/clientes/1', null, semAcesso)).contrato.valor, null); assert.equal((await call('GET', '/clientes/1', null, { areas: ['contratos'] })).contrato.fim.length, 10);
  await assert.rejects(call('GET', '/vencimentos?dias=30', null, semAcesso), /contratos/); await assert.rejects(call('PUT', '/clientes/1', { contrato: { fim: '2030-01-01' } }, semAcesso), /contratos/);
  assert.ok(Array.isArray((await call('GET', '/resumo', null, semAcesso)).itens));
  const pub = await call('GET', '/email/publicos'); assert.equal(pub[0].destinatarios, 1); assert.equal(pub[0].semEmail, 1); assert.equal(pub[1].destinatarios, 1);   // Mercado C sem e-mail; Padaria B inativa
  await call('PUT', '/clientes/1', { optOut: true }); assert.equal((await call('GET', '/email/publicos'))[0].destinatarios, 0);
  const csv = await call('GET', '/email/exportar?publico=inativos'); assert.match(csv.__csv, /b@x\.com/);
  const camp = await call('POST', '/email/campanhas', { nome: 'Reconquista', publico: 'inativos', assunto: 'Sentimos sua falta', corpo: 'Olá, volte!' }); assert.equal(camp.total, 1);
  await assert.rejects(call('POST', '/email/campanhas', { nome: 'x', publico: 'todos', assunto: 'a', corpo: 'texto aqui' }), /público|nome/i);
  assert.equal((await call('POST', `/email/campanhas/${camp.id}/enviada`, {})).status, 'enviada'); await assert.rejects(call('PUT', `/email/campanhas/${camp.id}`, { assunto: 'outro' }), /já enviada/i);
});
