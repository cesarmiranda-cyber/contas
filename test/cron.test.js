'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const FER = require('../lib/feriados'), K = require('../lib/cron');
const { createCronApi } = require('../lib/cronApi');
const { createBxEmpresas, similar, chave } = require('../lib/bxEmpresas');
const { createBxFunil } = require('../lib/bxFunil');
const { createAuth, hashSenha } = require('../lib/auth');

test('feriados: Páscoa, Carnaval, Corpus Christi, estaduais e municipais', () => {
  assert.equal(FER.pascoa(2026), '2026-04-05'); assert.equal(FER.pascoa(2025), '2025-04-20');
  const sp = FER.feriados({ cidade: 'São Paulo', uf: 'SP', ano: 2026 });
  assert.ok(sp.has('2026-01-25') && sp.has('2026-07-09') && sp.has('2026-10-12') && sp.has('2026-11-20'));
  assert.equal(sp.get('2026-02-16')[0].facultativo, true); assert.equal(sp.get('2026-04-03')[0].facultativo, false);
  const rj = FER.feriados({ cidade: 'Rio de Janeiro', uf: 'RJ', ano: 2026 }); assert.ok(rj.has('2026-04-23') && !rj.has('2026-07-09'));
  const outra = FER.feriados({ cidade: 'Cidade X', uf: 'SP', ano: 2026, custom: [{ data: '08-15', cidade: 'Cidade X', nome: 'Padroeira' }, { data: '03-03', cidade: 'Outra', nome: 'Não vale' }] });
  assert.ok(outra.has('2026-08-15') && !outra.has('2026-03-03'));
  assert.equal(FER.proximoUtil('2026-10-09', sp), '2026-10-13');   // 10 e 11 fim de semana, 12 feriado
  assert.equal(FER.ehUtil('2026-02-16', sp), true);                 // facultativo não bloqueia
});

test('semana, validação e carga', () => {
  assert.equal(K.segunda('2026-10-22'), '2026-10-19'); assert.deepEqual(K.semana('2026-10-19').length, 5);
  const ok = { consultoraOk: () => true, clienteOk: () => true };
  assert.throws(() => K.validaVisita({ data: '2026-10-19', min: 5, consultora: 'a', clienteId: 'c' }, ok), /duração/);
  assert.throws(() => K.validaVisita({ data: '19/10', min: 60, consultora: 'a', clienteId: 'c' }, ok), /Data/);
  assert.equal(K.fmtMin(90), '1h30'); assert.equal(K.fmtMin(120), '2h');
  assert.deepEqual(K.cargaPorConsultora([{ consultora: 'a', min: 60, status: 'agendada' }, { consultora: 'a', min: 30, status: 'cancelada' }]), { a: 60 });
});

test('recorrência: semanal, quinzenal e geração com feriado do cliente', () => {
  const base = ['2026-10-05', '2026-10-12', '2026-10-19'], v = (c, d) => ({ clienteId: c, consultora: 'm', data: d, min: 120, status: 'agendada' });
  const modelos = K.derivaModelos([v('A', '2026-10-06'), v('A', '2026-10-13'), v('A', '2026-10-20'), v('B', '2026-10-07'), v('B', '2026-10-21'), v('C', '2026-10-08')], base);
  assert.equal(modelos.find(m => m.clienteId === 'A').freq, 'semanal'); assert.equal(modelos.find(m => m.clienteId === 'B').freq, 'quinzenal'); assert.ok(!modelos.some(m => m.clienteId === 'C'));
  const clientes = new Map([['A', { id: 'A', cidade: 'São Paulo', uf: 'SP' }], ['B', { id: 'B', cidade: 'São Paulo', uf: 'SP' }]]);
  const sem = K.gerarSemana({ modelos, seg: '2026-11-02', existentes: [], clientesPorId: clientes, custom: [] });   // 02/11 = Finados (segunda)... A cai na terça 03/11
  assert.equal(sem.filter(x => x.clienteId === 'A').length, 1);
  const quinz = K.gerarSemana({ modelos, seg: '2026-10-26', existentes: [], clientesPorId: clientes, custom: [] }); assert.ok(!quinz.some(x => x.clienteId === 'B'));   // semana de folga
  const fer = K.gerarSemana({ modelos: [{ id: 'x', clienteId: 'A', consultora: 'm', dow: 0, min: 60, freq: 'semanal', ancora: '2026-10-05', ativo: true }], seg: '2026-10-12', existentes: [], clientesPorId: clientes, custom: [] });
  assert.equal(fer[0].data, '2026-10-13'); assert.match(fer[0].obs, /Nossa Senhora Aparecida/);   // segunda 12/10 é feriado
  assert.equal(K.gerarSemana({ modelos: [{ id: 'x', clienteId: 'A', consultora: 'm', dow: 0, min: 60, freq: 'semanal', ancora: '2026-10-05', ativo: true }], seg: '2026-10-12', existentes: fer, clientesPorId: clientes, custom: [] }).length, 0);   // idempotente
});

test('nomes: similaridade de clientes e abreviações', () => {
  assert.equal(similar('Sac. Cupecê', 'Sacolão Cupecê'), 1); assert.equal(similar('Bortoletto 4', 'Bortoletto 5'), 0); assert.ok(similar('Chur. Petroni', 'Churrascaria Petroni') >= 0.5);
  assert.equal(chave('ACAI NO COPAO LTDA'), chave('Açaí no Copão'));
});

const fakeBitrix = () => {
  const empresas = [{ ID: '1', TITLE: 'Domus Food Service', UF_CNPJ: '11', UF_CID: 'Santos', UF_UF: 'SP' }, { ID: '2', TITLE: 'Sacolão Cupecê', UF_CID: '', UF_UF: '' }];
  const calls = [], deals = [];
  return { enabled: true, deals, base: 'https://portal.bitrix24.com.br/rest/1/x', calls, empresas,
    async call(m, p) {
      calls.push([m, p]);
      if (m === 'crm.company.fields') return { result: { TITLE: { title: 'Nome' }, UF_CNPJ: { formLabel: 'CNPJ' }, UF_CID: { formLabel: 'Cidade' }, UF_UF: { formLabel: 'Estado' } } };
      if (m === 'crm.company.list') return { result: empresas };
      if (m === 'crm.contact.list') return { result: p.filter.COMPANY_ID === '1' ? [{ ID: '31', NAME: 'Ana', LAST_NAME: 'Lima', PHONE: [{ VALUE: '1199' }] }] : [{ ID: '41', NAME: 'A' }, { ID: '42', NAME: 'B' }] };
      if (m === 'crm.status.list') return { result: [{ STATUS_ID: 'C6:NEW', NAME: 'Onboarding' }, { STATUS_ID: 'C6:PREPARATION', NAME: 'Ativo' }, { STATUS_ID: 'C6:LOSE', NAME: 'Suspenso' }] };
      if (m === 'crm.deal.list') return { result: deals.filter(x => String(x.CATEGORY_ID) === String(p.filter.CATEGORY_ID)) };
      if (m === 'crm.deal.add') { const id = '900' + calls.length; deals.push({ ID: id, ...p.fields, CLOSED: 'N' }); return { result: id }; }
      if (m === 'crm.deal.update') { deals.find(x => x.ID === p.id).STAGE_ID = p.fields.STAGE_ID; return { result: true }; }
      if (m === 'user.get') return { result: [{ ID: '7', NAME: 'Mônica', LAST_NAME: 'Silva' }, { ID: '8', NAME: 'Iris', LAST_NAME: 'X' }] };
      return { result: true };
    } };
};
test('API do cronograma: cliente ← empresa do Bitrix24, consultora ← usuário, funil sem duplicar, feriado e permissões', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')), seed = path.join(dir, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify({ consultoras: ['Mônica', 'Iris'], clientes: [{ nome: 'Domus', empresaBitrixId: '' }, { nome: 'Sac. Cupecê', empresaBitrixId: '', sugestaoId: '2' }],
    visitas: ['2026-10-05', '2026-10-12', '2026-10-19'].flatMap(s => [{ data: FER.somaDias(s, 1), consultora: 'Mônica', cliente: 'Domus', min: 180 }, { data: FER.somaDias(s, 2), consultora: 'Iris', cliente: 'Sac. Cupecê', min: 120 }]) }));
  const bitrix = fakeBitrix(), bx = createBxEmpresas({ bitrix }), api = createCronApi({ bitrix, bx, funil: createBxFunil({ bitrix }), store: { log() {} }, dir, seedFile: seed });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/cron' + p); const r = await api.handle(m, u.pathname, u, async () => b || {}, user); return r.json; };
  assert.equal(api.dados().visitas.length, 6); assert.equal(api.dados().modelos.length, 2);
  assert.equal((await call('POST', '/vincular-auto', {})).vinculados, 1);            // "Sac. Cupecê" = "Sacolão Cupecê"; "Domus" fica para vínculo manual
  const [domus] = api.dados().clientes; assert.equal(domus.empresaBitrixId, '');
  assert.ok((await call('GET', `/clientes/${domus.id}/sugestoes`)).some(e => e.id === '1'));
  await assert.rejects(call('PUT', `/clientes/${domus.id}`, { empresaBitrixId: '999' }), /não encontrada/);
  const c1 = await call('PUT', `/clientes/${domus.id}`, { empresaBitrixId: '1' }); assert.equal(c1.cidade, 'Santos');
  await call('POST', '/consultoras/auto', {}); assert.ok(api.dados().consultoras.every(c => c.bitrixId));   // já ligadas pela reconciliação (primeiro nome)
  const simul = await call('POST', '/funil/sincronizar', {}); assert.equal(simul.simulacao, true); assert.equal(simul.criar, 2); assert.equal(bitrix.calls.filter(c => c[0] === 'crm.deal.add').length, 0);
  assert.equal((await call('GET', `/clientes/${domus.id}/contatos`))[0].nome, 'Ana Lima');
  await assert.rejects(call('PUT', `/clientes/${domus.id}`, { contatoBitrixId: '99' }), /não pertence/);
  const ct = await call('PUT', `/clientes/${domus.id}`, { contatoBitrixId: '31' }); assert.equal(ct.contatoNome, 'Ana Lima');
  const real = await call('POST', '/funil/sincronizar', { simular: false }); assert.equal(real.criados, 2);
  const add = bitrix.calls.filter(c => c[0] === 'crm.deal.add'); assert.equal(add[0][1].fields.CATEGORY_ID, 6); assert.equal(add[0][1].fields.COMPANY_ID, '1'); assert.equal(add[0][1].fields.ASSIGNED_BY_ID, '7'); assert.equal(add.find(a => a[1].fields.COMPANY_ID === '1')[1].fields.CONTACT_ID, '31');
  assert.equal((await call('POST', '/funil/sincronizar', { simular: false })).criados, 0);      // não duplica
  assert.equal(add[0][1].fields.STAGE_ID, 'C6:PREPARATION');                                     // cliente existente entra como "Ativo"
  bitrix.deals.find(x => x.COMPANY_ID === '1').STAGE_ID = 'C6:LOSE';                              // alguém suspende no Bitrix24
  const rec = await call('POST', '/reconciliar', { simular: false }); assert.equal(rec.desativados, 1); assert.equal(api.dados().clientes.find(c => c.empresaBitrixId === '1').ativo, false);
  bitrix.deals.find(x => x.COMPANY_ID === '1').STAGE_ID = 'C6:PREPARATION';
  assert.equal((await call('POST', '/reconciliar', { simular: false })).reativados, 1);
  const m = api.dados().consultoras[0], visita = await call('POST', '/visitas', { data: '2026-10-12', min: 60, consultora: m.id, clienteId: domus.id });
  const sem = await call('GET', '/semana?data=2026-10-12'); assert.equal(sem.comFeriado, 1);
  const per = await call('GET', '/periodo?de=2026-10-01&ate=2026-10-31'); assert.ok(per.total >= 7); assert.equal(per.comFeriado, 1); assert.ok(per.feriadosNacionais.some(f => f.data === '2026-10-12'));
  assert.equal((await call('GET', '/periodo?de=2026-10-01&ate=2026-10-31&feriado=1')).itens.length, 1); assert.equal((await call('GET', `/periodo?de=2026-10-01&ate=2026-10-31&consultora=${api.dados().consultoras[1].id}`)).itens.every(v => v.consultoraNome === 'Iris'), true);
  assert.equal((await call('GET', '/periodo?de=2026-10-12&ate=2026-10-12')).total, 1); await assert.rejects(call('GET', '/periodo?de=2026-01-01&ate=2026-12-31'), /Período inválido/);
  assert.equal(visita.feriado, 'Nossa Senhora Aparecida'); assert.equal(visita.sugestao, '2026-10-13');
  assert.equal((await call('POST', '/semana/remarcar-feriados', { data: '2026-10-12' })).remarcadas, 1);
  assert.equal((await call('GET', '/semana?data=2026-10-12')).comFeriado, 0);
  const rem = await call('POST', `/visitas/${visita.id}/remarcar`, { data: '2026-10-20' }); assert.equal(rem.status, 'agendada'); assert.equal(rem.data, '2026-10-20'); assert.equal(api.dados().visitas.find(x => x.id === visita.id).status, 'remarcada');
  await assert.rejects(call('POST', `/visitas/${rem.id}/remarcar`, { data: '2026-10-20' }), /diferente/);
  assert.equal((await call('POST', '/visitas/lote', { ids: [rem.id], status: 'realizada' })).atualizadas, 1); assert.equal((await call('POST', '/visitas/lote', { ids: [rem.id], status: 'realizada' })).atualizadas, 0);
  await assert.rejects(call('POST', '/visitas/lote', { ids: [rem.id], status: 'xx' }), /inválida/);
  const g = await call('POST', '/semana/gerar', { data: '2026-10-26', semanas: 1 }); assert.ok(g.criadas >= 1);
  const outra = { perfil: 'operacional', bitrixId: '8' };   // Iris
  await assert.rejects(call('PUT', `/visitas/${visita.id}`, { status: 'realizada' }, outra), /própria/);
  const dela = api.dados().visitas.find(v => v.consultora === api.dados().consultoras[1].id);
  assert.equal((await call('PUT', `/visitas/${dela.id}`, { status: 'realizada' }, outra)).status, 'realizada');
  assert.ok(bitrix.calls.some(c => c[0] === 'crm.timeline.comment.add'));
});

test('perfis: consultora só vê o cronograma; funil e vínculos são do administrador', async () => {
  const auth = createAuth({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'au-')), env: { ADMIN_USER: 'a', ADMIN_HASH: await hashSenha('Inicial12345') } });
  assert.equal(auth.permite('operacional', 'POST', '/api/cron/visitas'), true);
  assert.equal(auth.permite('operacional', 'GET', '/api/fin/bootstrap'), false); assert.equal(auth.permite('operacional', 'GET', '/api/bk/unidades'), true); assert.equal(auth.permite('operacional', 'POST', '/api/bk/unidades'), false);
  assert.equal(auth.permite('operacional', 'POST', '/api/cron/funil/sincronizar'), false); assert.equal(auth.permite('operacional', 'GET', '/api/cron/clientes'), true);
  assert.equal(auth.permite('financeiro', 'POST', '/api/cron/funil/sincronizar'), false); assert.equal(auth.permite('financeiro', 'POST', '/api/cron/visitas'), true); assert.equal(auth.permite('admin', 'POST', '/api/cron/funil/sincronizar'), true);
  assert.equal(auth.permite('consulta', 'POST', '/api/cron/visitas'), false);
});

test('lista de conferência: carga mensal ligada aos clientes, edição e histórico', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-')), seed = path.join(dir, 'c.json'), bitrix = { enabled: false };
  const linha = (nome, c, sem) => ({ nome, consultoras: c, consultoraTxt: c[0] || '', horasTxt: '2h', min: 120, freqTxt: '1x por semana', freqTipo: 'semanal', freqN: 1, semanas: sem });
  fs.writeFileSync(seed, JSON.stringify({ meses: { '2026-09': { obsMes: ['obs set'], linhas: [linha('Askoll', ['Iris'], [true, false, false, false, false]), linha('Cliente Novo', ['Tais'], [false, false, false, false, false])] }, '2026-10': { obsMes: [], linhas: [linha('Askoll', ['Iris'], [false, true, false, false, true])] } },
    obsClientes: ['Askoll: só terça ou quinta;'], clientes: { 'Cliente Novo': { cidade: 'Santos', uf: 'SP' } } }));
  const api = createCronApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), store: { log() {} }, dir, confSeedFile: seed });
  const call = async (m, p, b) => { const u = new URL('http://x/api/cron' + p); return (await api.handle(m, u.pathname, u, async () => b || {})).json; };
  assert.equal(api.dados().conferencia.length, 3); assert.ok(api.dados().consultoras.some(c => c.nome === 'Tais'));
  const meses = await call('GET', '/conferencia/meses'); assert.equal(meses[0].mes, '2026-10');
  const lst = await call('GET', '/conferencia?mes=2026-10'); assert.equal(lst.total, 1); assert.equal(lst.itens[0].marcadas, 2); assert.match(lst.itens[0].restricao, /terça ou quinta/);
  const id = lst.itens[0].id, up = await call('PUT', '/conferencia/' + id, { semanas: [true, true, true, true, true], obs: 'ok' }); assert.equal(up.marcadas, 5);
  assert.equal((await call('GET', `/clientes/${lst.itens[0].clienteId}/conferencia`)).length, 2);   // set + out
  await assert.rejects(call('POST', '/conferencia', { mes: '2026-10', clienteId: lst.itens[0].clienteId }), /já está/);
  await assert.rejects(call('PUT', '/conferencia/' + id, { mes: '2026-13' }), /Mês inválido/);
  assert.equal(K.semanasDoMes('2026-10'), 5); assert.equal(K.semanasDoMes('2026-02'), 4);
  assert.equal(K.previstoDe({ mes: '2026-10', freqTipo: 'semanal', freqN: 2 }), 10); assert.equal(K.previstoDe({ mes: '2026-10', freqTipo: 'quinzenal' }), 3); assert.equal(K.previstoDe({ mes: '2026-10', freqTipo: 'mensal' }), 1); assert.equal(K.previstoDe({ mes: '2026-10', freqTipo: '' }), null);
  const rs = await call('GET', '/conferencia/resumo?mes=2026-10'); assert.equal(rs.previsto, 5); assert.equal(rs.realizado, 5); assert.equal(rs.pct, 100); assert.equal(rs.porConsultora[0].consultora, 'Iris');
  const r9 = await call('GET', '/conferencia/resumo?mes=2026-09'); assert.equal(r9.linhas, 2); assert.equal(r9.realizado, 1); assert.equal(r9.pct, 10);   // 1 de 10 (2 clientes × 5 semanas)
  await call('PUT', '/conferencia/mes/2026-10', { obs: ['a', 'b'] }); assert.deepEqual(api.dados().confMeses['2026-10'].obs, ['a', 'b']);
  assert.equal(api.dados().clientes.find(c => c.nome === 'Cliente Novo').cidade, 'Santos');
  const auth = createAuth({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'au-')), env: { ADMIN_USER: 'a', ADMIN_HASH: await hashSenha('Inicial12345') } });
  assert.equal(auth.permite('operacional', 'GET', '/api/cron/conferencia'), true); assert.equal(auth.permite('operacional', 'PUT', '/api/cron/conferencia/x'), false); assert.equal(auth.permite('financeiro', 'PUT', '/api/cron/conferencia/x'), true);
});
