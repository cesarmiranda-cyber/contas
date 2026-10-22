'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createStore } = require('../lib/store');
const { createService } = require('../lib/service');
const { createWorld } = require('./world');

const NOW = new Date('2026-05-10T15:00:00Z'); // 10/05/2026 12h BRT
function setup(extra = {}) {
  const w = createWorld(); w.now = () => NOW;
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fv-')));
  const svc = createService({ bitrix: { call: w.call }, store, clock: () => NOW });
  w.empresa(1, 'Acme Marítima', { UF_CRM_MOT_CLASSE: '1', UF_CRM_MOT_VENDEDOR: '10', UF_CRM_MOT_SUPERVISOR: '10', UF_CRM_MOT_COORDENADOR: '10', UF_CRM_MOT_GERENTE: '20', UF_CRM_MOT_ULTIMA: '2026-04-20', ...extra });
  return { w, store, svc };
}
const cards = w => Object.values(w.items[1036]);

test('empresa gera os cards completos e não duplica ao reexecutar', async () => {
  const { w, svc } = setup();
  const r = await svc.sincronizarEmpresa(1);
  assert.equal(r.criados.length, 5);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  assert.equal(vend.ufCrm_data, '2026-05-20'); // 20/04 + 30 (classe A) ; sem campo custom -> closedate padrão
  assert.equal(vend.assignedById, 10);
  assert.equal(vend.stageId, w.stages.aguardando);
  const dir = cards(w).find(c => c.title.endsWith('| Diretor'));
  assert.equal(dir.assignedById, 30, 'diretor vem do chefe do departamento do gerente');
  const r2 = await svc.sincronizarEmpresa(1);
  assert.equal(r2.criados.length, 0);
  assert.equal(cards(w).length, 5);
});

test('sem classe ou responsável vira pendência, não card incompleto', async () => {
  const { w, svc } = setup({ UF_CRM_MOT_CLASSE: '', UF_CRM_MOT_VENDEDOR: '' });
  const r = await svc.sincronizarEmpresa(1);
  assert.equal(cards(w).length, 0);
  assert.ok(r.pendencias.length >= 1 && r.pendencias.some(p => /Vendedor: sem responsável e classe/.test(p)));
  assert.ok(!r.pendencias.some(p => /Diretor: sem responsável/.test(p)), 'cargo acima do vendedor sem responsável não é pendência');
});

test('mudar classe recalcula a data; mudar responsável troca o dono', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  w.companies[1].UF_CRM_MOT_CLASSE = '3'; // C: 90 dias
  w.companies[1].UF_CRM_MOT_VENDEDOR = '20';
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  assert.equal(vend.ufCrm_data, '2026-07-19');
  assert.equal(vend.assignedById, 20);
  assert.equal(cards(w).length, 5);
});

test('job diário: hoje -> Dia da Visita, vencidos -> Atrasada e avisa o responsável', async () => {
  const { w, svc } = setup({ UF_CRM_MOT_ULTIMA: '2026-04-10' }); // vendedor: 10/05 = hoje
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  vend.stageId = w.stages.aguardando; // como se tivesse nascido antes
  const atras = cards(w).find(c => c.title.endsWith('| Gerente'));
  atras.ufCrm_data = '2026-05-01'; atras.stageId = w.stages.aguardando;
  const r = await svc.jobDiario();
  assert.deepEqual(r, { dia: 1, atrasadas: 1, naoRealizadas: 0 });
  assert.equal(vend.stageId, w.stages.dia);
  assert.equal(atras.stageId, w.stages.atrasada);
  assert.ok(w.notifs.some(n => n.USER_ID === 10));
  assert.deepEqual(await svc.jobDiario(), { pulado: true }, 'idempotente no mesmo dia');
});

test('registrar visita: cria 1032, calcula antecipada, finaliza, atualiza última visita e cria o próximo card', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const r = await svc.registrarVisita(vend.id, { uid: 10, resultado: 'Orçamento enviado' });
  assert.equal(r.antecipada, true); // hoje 10/05 < 20/05
  const v = Object.values(w.items[1032])[0];
  assert.equal(v.title, 'Acme Marítima - 10/05/2026');
  assert.equal(v.ufCrm_ant, 'Y'); assert.equal(v.ufCrm_fila, String(vend.id)); assert.equal(v.ufCrm_setor, 'Motores');
  assert.equal(vend.stageId, w.stages.finalizado);
  assert.equal(w.companies[1].UF_CRM_MOT_ULTIMA, '2026-05-10');
  const abertos = cards(w).filter(c => c.stageId !== w.stages.finalizado && c.title.endsWith('| Vendedor'));
  assert.equal(abertos.length, 1);
  assert.equal(abertos[0].ufCrm_data, '2026-06-09'); // 10/05 + 30
  // os demais cargos não são empurrados pela visita do vendedor
  const sup = cards(w).find(c => c.title.endsWith('| Supervisor'));
  const antes = sup.ufCrm_data;
  await svc.sincronizarEmpresa(1);
  assert.equal(sup.ufCrm_data, antes);
  assert.equal(cards(w).length, 6);
  await assert.rejects(svc.registrarVisita(vend.id, { uid: 10, resultado: 'de novo' }), /já foi finalizada/);
});

test('reprogramar: exige motivo, recusa outro mês, grava histórico e comentário', async () => {
  const { w, svc, store } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor')); // 20/05
  await assert.rejects(svc.reprogramar(vend.id, { uid: 10, nova: '2026-05-28', motivo: '' }), /motivo/i);
  await assert.rejects(svc.reprogramar(vend.id, { uid: 10, nova: '2026-06-02', motivo: 'Cliente pediu' }), /outro mês/);
  await svc.reprogramar(vend.id, { uid: 10, nova: '2026-05-28', motivo: 'Cliente pediu' });
  assert.equal(vend.ufCrm_data, '2026-05-28');
  assert.equal(store.historico.length, 1);
  assert.equal(store.historico[0].anterior, '2026-05-20');
  assert.match(w.comments[0].COMMENT, /Motivo: Cliente pediu/);
  assert.equal(w.comments[0].ENTITY_TYPE, 'dynamic_1036');
});

test('edição direta da data da visita e da data programada é revertida, sem loop', async () => {
  const { w, svc, store } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const r = await svc.registrarVisita(vend.id, { uid: 10, resultado: 'Visita feita' });
  const v = w.items[1032][r.visita], orig = v.ufCrm_dh;
  v.ufCrm_dh = '2020-01-01T10:00:00.000Z';
  assert.equal(await svc.guardarVisitas(), 1);
  assert.equal(v.ufCrm_dh, orig);
  assert.equal(await svc.guardarVisitas(), 0, 'a própria reversão não dispara novo bloqueio');
  assert.equal(store.bloqueios[0].tipo, 'visita-data');
  assert.ok(w.notifs.some(n => /não pode ser alterada/.test(n.MESSAGE)));
  const sup = cards(w).find(c => c.title.endsWith('| Supervisor'));
  const dOrig = sup.ufCrm_data;
  await svc.guardarCards(Object.values(w.items[1036]).filter(c => c.stageId !== w.stages.finalizado)); // snapshot já existe
  sup.ufCrm_data = '2026-12-31';
  assert.equal(await svc.guardarCards(Object.values(w.items[1036]).filter(c => c.stageId !== w.stages.finalizado)), 1);
  assert.equal(sup.ufCrm_data, dOrig);
});

test('correção de visita só por administrador e fica no histórico', async () => {
  const { w, svc, store } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const r = await svc.registrarVisita(vend.id, { uid: 10, resultado: 'Visita feita' });
  await assert.rejects(svc.corrigirVisita(r.visita, { uid: 10, dataHora: '2026-05-09T12:00:00Z', motivo: 'erro' }), /administradores/);
  store.setConfig({ admins: [30] });
  await svc.corrigirVisita(r.visita, { uid: 30, dataHora: '2026-05-09T12:00:00Z', motivo: 'Data errada' });
  assert.equal(w.items[1032][r.visita].ufCrm_dh, '2026-05-09T12:00:00.000Z');
  assert.equal(await svc.guardarVisitas(), 0);
  assert.equal(store.historico[0].tipo, 'correcao-visita');
});

test('minhas visitas lista só as do usuário, ordenadas por data', async () => {
  const { svc } = setup();
  await svc.sincronizarEmpresa(1);
  const mine = await svc.listarVisitas({ uid: 10, escopo: 'minhas' });
  assert.equal(mine.visitas.length, 3); // vendedor, supervisor, coordenador
  assert.ok(mine.visitas[0].data <= mine.visitas[1].data);
  const all = await svc.listarVisitas({ uid: 30, escopo: 'todas' });
  assert.equal(all.visitas.length, 5);
});

test('formulário de registro lista os campos do 1032, pré-preenchidos e travados, e valida obrigatórios', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const f = await svc.camposVisita(vend.id);
  const por = k => f.campos.find(c => c.key === k);
  assert.equal(por('ufCrm_res').obrigatorio, true);
  assert.equal(f.campos[0].key, 'ufCrm_res', 'resultado vem primeiro');
  assert.equal(por('ufCrm_setor').valor, 'Motores'); assert.equal(por('ufCrm_setor').travado, true);
  assert.equal(por('ufCrm_fila').valor, String(vend.id));
  assert.equal(por('ufCrm_ant').valor, 'Y');
  assert.equal(por('ufCrm_nota').tipo, 'numero'); assert.equal(por('ufCrm_ret').tipo, 'sim_nao');
  await assert.rejects(svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_nota: 9 } }), /Preencha: Resultado ou observações/);
  const r = await svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok', ufCrm_nota: '9', ufCrm_ret: true, ufCrm_setor: 'HACK' } });
  const v = w.items[1032][r.visita];
  assert.equal(v.ufCrm_nota, 9); assert.equal(v.ufCrm_ret, 'Y'); assert.equal(v.ufCrm_setor, 'Motores', 'campo travado não é sobrescrito');
});

test('campos duplicados na empresa: usa o que tiver valor, a maior última visita e grava no principal', async () => {
  const { w, svc } = setup({ UF_CRM_MOT_CLASSE: '', UF_CRM_MOT_VENDEDOR: '', UF_CRM_MOT_ULTIMA: '2026-03-01' });
  w.companyFields.UF_CRM_OLD_CLASSE = { formLabel: 'Classe Motores', type: 'string' };
  w.companyFields.UF_CRM_OLD_VEND = { formLabel: '[Motores] Vendedor Responsável', type: 'string' };
  w.companyFields.UF_CRM_OLD_ULT = { formLabel: '[Motores] Última Visita', type: 'date' };
  Object.assign(w.companies[1], { UF_CRM_OLD_CLASSE: 'B', UF_CRM_OLD_VEND: '10', UF_CRM_OLD_ULT: '2026-04-20' });
  const r = await svc.sincronizarEmpresa(1);
  assert.equal(r.criados.length, 5);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  assert.equal(vend.ufCrm_data, '2026-06-19', 'classe B (60 dias) a partir da maior última visita (20/04)');
  assert.equal(vend.assignedById, 10);
});

test('hierarquia automática: preenche os cargos vazios pela cadeia de chefes do vendedor', async () => {
  const { w, svc, store } = setup({ UF_CRM_MOT_SUPERVISOR: '', UF_CRM_MOT_COORDENADOR: '', UF_CRM_MOT_GERENTE: '' });
  store.setConfig({ hierarquiaAuto: true });
  w.users[10].UF_DEPARTMENT = [5]; // vendedor no depto 5 (chefe 20), pai = diretoria (chefe 30)
  await svc.sincronizarEmpresa(1);
  assert.equal(w.companies[1].UF_CRM_MOT_DIRETOR, 30);
  assert.equal(w.companies[1].UF_CRM_MOT_GERENTE, 20);
  assert.ok(!w.companies[1].UF_CRM_MOT_COORDENADOR, 'sem chefe suficiente na cadeia, fica para preenchimento manual');
  const ger = cards(w).find(c => c.title.endsWith('| Gerente'));
  assert.equal(ger.assignedById, 20);
});

test('alçadas configuradas por departamento preenchem os cargos vazios da empresa', async () => {
  const { w, svc, store } = setup({ UF_CRM_MOT_SUPERVISOR: '', UF_CRM_MOT_COORDENADOR: '', UF_CRM_MOT_GERENTE: '' });
  w.users[10].UF_DEPARTMENT = [5];
  store.setConfig({ alcadas: { 5: { supervisor: 20, coordenador: 20, gerente: 30 }, 1: { diretor: 30 } } });
  await svc.sincronizarEmpresa(1);
  assert.equal(w.companies[1].UF_CRM_MOT_SUPERVISOR, 20);
  assert.equal(w.companies[1].UF_CRM_MOT_GERENTE, 30);
  assert.equal(w.companies[1].UF_CRM_MOT_DIRETOR, 30, 'diretor vem do departamento pai');
  assert.equal(cards(w).length, 5);
});

test('lista de visitas traz responsável, equipe, última visita e ciclo', async () => {
  const { svc } = setup();
  await svc.sincronizarEmpresa(1);
  const v = (await svc.listarVisitas({ uid: 10, escopo: 'minhas' })).visitas.find(x => x.cargo === 'Vendedor');
  assert.equal(v.ultima, '2026-04-20'); assert.equal(v.ciclo, 30); assert.equal(v.diasDesdeUltima, 20);
  assert.equal(v.equipe.gerente, 'Gil Gerente');
});

test('visibilidade por alçada: vendedor só os seus, gerente a equipe, diretoria tudo, estranho nada', async () => {
  const { w, svc } = setup();
  w.users[99] = { ID: 99, NAME: 'Zé', LAST_NAME: 'Ninguém', UF_DEPARTMENT: [5] };
  w.empresa(2, 'Outra Ltda', { UF_CRM_MOT_CLASSE: '1', UF_CRM_MOT_VENDEDOR: '99', UF_CRM_MOT_SUPERVISOR: '99', UF_CRM_MOT_COORDENADOR: '99', UF_CRM_MOT_GERENTE: '99', UF_CRM_MOT_ULTIMA: '2026-04-20' });
  await svc.sincronizarEmpresa(1); await svc.sincronizarEmpresa(2);
  const ver = async uid => (await svc.listarVisitas({ uid })).visitas.map(v => v.empresa);
  const vend = await ver(99);
  assert.ok(vend.length && vend.every(e => e === 'Outra Ltda'), 'vendedor 99 só vê a empresa dele');
  const ger = await ver(20); // gerente de Acme (aparece nos cargos) e chefe do depto 5 (onde está o 99)
  assert.ok(ger.includes('Acme Marítima') && ger.includes('Outra Ltda'));
  const dir = await ver(30); // chefe do departamento raiz
  assert.equal(dir.length, 10);
  assert.deepEqual(await ver(777), []);
});

test('tipo da empresa (industrial/marítimo) vem do setor da empresa, conforme a tabela configurada', async () => {
  const { w, svc, store } = setup({ INDUSTRY: 'DT1036_1:LATE' }); // o mock devolve as etapas como lista de setores
  store.setConfig({ tipoPorRamo: { 'DT1036_1:LATE': 'Marítimo' } });
  await svc.sincronizarEmpresa(1);
  const v = (await svc.listarVisitas({ uid: 10 })).visitas;
  assert.ok(v.length && v.every(x => x.tipoEmpresa === 'Marítimo'));
  store.setConfig({ tipoPorRamo: { 'DT1036_1:LATE': '' } });
  assert.ok((await svc.listarVisitas({ uid: 10 })).visitas.every(x => x.tipoEmpresa === ''));
});

test('histórico de reprogramações só aparece para quem pode ver a visita', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  await svc.reprogramar(vend.id, { uid: 10, nova: '2026-05-28', motivo: 'Cliente pediu' });
  assert.equal((await svc.historicoVisivel(10)).length, 1);
  assert.equal((await svc.historicoVisivel(30)).length, 1, 'diretoria vê tudo');
  assert.equal((await svc.historicoVisivel(777)).length, 0);
});

test('campos duplicados no Registro de Visita: formulário mostra só o padrão e a migração copia os valores antigos', async () => {
  const D = require('../lib/duplicados');
  const { w, svc } = setup();
  w.extraFields = { 1032: { ufCrm_res_old: { title: 'Resultado ou observações ', type: 'string' }, ufCrm_nota_old: { title: 'Nota do cliente', type: 'integer' } } };
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const f = await svc.camposVisita(vend.id);
  assert.equal(f.campos.filter(c => /Resultado/.test(c.titulo)).length, 1);
  assert.ok(!f.campos.some(c => c.key.endsWith('_old')), 'duplicados antigos ficam fora do formulário');
  w.items[1032][500] = { id: 500, ufCrm_res_old: 'texto antigo', ufCrm_nota_old: 7 };
  const r = await D.migrarSpa({ call: w.call }, 1032, ['ufCrm_res']);
  assert.equal(r.copiados, 2);
  assert.equal(w.items[1032][500].ufCrm_res, 'texto antigo');
  assert.equal(w.items[1032][500].ufCrm_nota, 7);
  assert.equal(w.items[1032][500].ufCrm_res_old, 'texto antigo', 'migração não apaga o valor antigo');
});

test('alçada da visita vem do cargo do card, travada, e é gravada no registro', async () => {
  const { w, svc } = setup();
  w.extraFields = { 1032: { ufCrm_alc: { title: 'Alçada', type: 'enumeration', items: [{ ID: '7', VALUE: 'Vendedor' }, { ID: '8', VALUE: 'Gerente' }] } } };
  await svc.sincronizarEmpresa(1);
  const ger = cards(w).find(c => c.title.endsWith('| Gerente'));
  const f = await svc.camposVisita(ger.id);
  const alc = f.campos.find(c => c.key === 'ufCrm_alc');
  assert.equal(alc.valor, '8'); assert.equal(alc.travado, true);
  const r = await svc.registrarVisita(ger.id, { uid: 20, campos: { ufCrm_res: 'Ok' } });
  assert.equal(w.items[1032][r.visita].ufCrm_alc, '8');
});

test('mapeamento de oportunidades vem do cadastro da empresa, travado e gravado no registro', async () => {
  const { w, svc } = setup({ UF_CRM_PEC_CLASSE: '2', UF_CRM_PEC_VENDEDOR: '10' });
  const itens = [{ ID: '1', VALUE: 'Peças' }, { ID: '2', VALUE: 'Serviços' }, { ID: '3', VALUE: 'Motores' }];
  w.extraFields = { 1032: { ufCrm_opo: { title: 'Mapeamento de oportunidades futuras', type: 'enumeration', items: itens }, ufCrm_opm: { title: 'Mapeamento de oportunidades futuras', type: 'enumeration', isMultiple: true, items: itens } } };
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor') && /Motores/.test(c.title));
  const f = await svc.camposVisita(vend.id);
  const unico = f.campos.find(c => c.key === 'ufCrm_opo'), multi = f.campos.find(c => c.key === 'ufCrm_opm');
  assert.equal(unico?.valor, '3'); assert.equal(unico?.travado, true);
  if (multi) assert.deepEqual([...multi.valor].sort(), ['1', '3']);
});

test('acesso: aberto sem listas; com listas só entra quem está nelas (admin sempre)', async () => {
  const { svc, store } = setup();
  assert.equal(svc.podeConfigurar(99), true); assert.equal(svc.podeDashboard(99), true); assert.equal(svc.acessoRestrito(), false);
  store.setConfig({ acessoConfig: [30], acessoDashboard: [10, 20], admins: [20] });
  assert.equal(svc.acessoRestrito(), true);
  assert.equal(svc.podeConfigurar(30), true); assert.equal(svc.podeConfigurar(20), true, 'admin'); assert.equal(svc.podeConfigurar(10), false);
  assert.equal(svc.podeDashboard(10), true); assert.equal(svc.podeDashboard(99), false); assert.equal(svc.podeDashboard(30), true, 'quem configura também vê');
});

test('dashboard: dados em nível de linha (fila + registros + reprogramações) respeitando a visibilidade', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const r = await svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok' } });
  const sup = cards(w).find(c => c.title.endsWith('| Supervisor'));
  await svc.reprogramar(sup.id, { uid: 10, nova: '2026-06-20', motivo: 'Cliente pediu' });
  const d = await svc.dashboardDados({ uid: 30 }); // diretoria
  assert.equal(d.visao, 'tudo');
  assert.ok(d.cards.some(c => c.situacao === 'finalizado'), 'card finalizado entra');
  assert.ok(d.cards.filter(c => c.situacao !== 'finalizado').length >= 5);
  assert.equal(d.visitas.length, 1);
  assert.equal(d.visitas[0].antecipada, true); assert.equal(d.visitas[0].segmento, 'Motores'); assert.equal(d.visitas[0].desvio, -10);
  assert.equal(d.reprog.length, 1);
  const nada = await svc.dashboardDados({ uid: 777 });
  assert.equal(nada.cards.length, 0); assert.equal(nada.visitas.length, 0);
});

test('permissões do Bitrix prevalecem: o que o Bitrix nega ao usuário some da lista, do dashboard e do histórico', async () => {
  const { w, store } = setup();
  const permitido = new Set();
  const acesso = { ids: async (bearer, et) => (bearer ? (et === 1036 ? permitido : new Set()) : null) };
  const svc = createService({ bitrix: { call: w.call }, store, acesso, clock: () => NOW });
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor')), sup = cards(w).find(c => c.title.endsWith('| Supervisor'));
  permitido.add(vend.id);
  const l = await svc.listarVisitas({ uid: 30, bearer: 'sessao' });                       // diretoria, mas o Bitrix só libera 1 card
  assert.deepEqual(l.visitas.map(v => v.id), [vend.id]);
  assert.equal((await svc.listarVisitas({ uid: 30 })).visitas.length, 5, 'sem sessão do usuário valem só as regras do app');
  assert.equal(await svc.podeVerCard('sessao', sup.id), false); assert.equal(await svc.podeVerCard('sessao', vend.id), true);
  const d = await svc.dashboardDados({ uid: 30, bearer: 'sessao' });
  assert.deepEqual(d.cards.filter(c => c.situacao !== 'finalizado').map(c => c.id), [vend.id]);
  store.setConfig({ respeitarBitrix: false });
  assert.equal((await svc.listarVisitas({ uid: 30, bearer: 'sessao' })).visitas.length, 5, 'desligando a opção, vale só o app');
});

test('dashboard: cada linha traz o vendedor (inclusive de cards antigos, sem índice local)', async () => {
  const { w, svc, store } = setup();
  await svc.sincronizarEmpresa(1);
  for (const c of cards(w)) store.setCard(c.id, { ...(store.card(c.id) || {}), equipe: undefined }); // simula card criado antes do índice
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const r = await svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok' } });
  const d = await svc.dashboardDados({ uid: 30 });
  assert.ok(d.cards.length && d.cards.every(c => c.vendedor === 'Vera Vendedora'));
  assert.equal(d.visitas[0].vendedor, 'Vera Vendedora');
});

test('após a visita o cadastro da empresa recebe Última e Próxima Visita do segmento', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  await svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok' } });
  assert.equal(w.companies[1].UF_CRM_MOT_ULTIMA, '2026-05-10');
  assert.equal(w.companies[1].UF_CRM_MOT_PROXIMA, '2026-06-09', 'próxima = menor data entre os cards abertos do segmento');
});

test('visita criada direto no Bitrix (com ID da Fila) também finaliza o card e atualiza a empresa', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  await svc.guardarVisitas();                                   // marca o início do recurso
  w.items[1032][900] = { id: 900, assignedById: 10, companyId: 1, createdTime: new Date(Date.now() + 5000).toISOString(), ufCrm_dh: '2026-05-10T15:00:00.000Z', ufCrm_fila: String(vend.id), ufCrm_setor: 'Motores' };
  w.items[1032][900].updatedTime = new Date(Date.now() + 6000).toISOString();
  await svc.guardarVisitas();
  assert.equal(vend.stageId, w.stages.finalizado);
  assert.equal(w.companies[1].UF_CRM_MOT_ULTIMA, '2026-05-10');
  assert.equal(cards(w).filter(c => c.stageId !== w.stages.finalizado && c.title.endsWith('| Vendedor')).length, 1);
  await svc.guardarVisitas();                                   // idempotente
  assert.equal(cards(w).filter(c => c.title.endsWith('| Vendedor')).length, 2);
});

test('etapa final com outro nome (Encerrado) e card aberto com visita registrada é finalizado', async () => {
  const { w, svc } = setup();
  w.stageList.find(s => s.STATUS_ID === 'DT1036_1:DONE').NAME = 'Encerrado';
  await svc.sincronizarEmpresa(1);
  const d = await svc.campos(true);
  assert.equal(d.map.etapas.finalizado, w.stages.finalizado);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  await svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok' } });
  assert.equal(vend.stageId, w.stages.finalizado);
  vend.stageId = w.stages.aguardando;                                   // simula a falha antiga: visita existe, card ficou aberto
  const r = await svc.reconciliarVisitas();
  assert.equal(r.finalizados, 1); assert.equal(vend.stageId, w.stages.finalizado);
  assert.equal((await svc.reconciliarVisitas()).finalizados, 0, 'idempotente');
});

test('varredura e registro de visita ao mesmo tempo não criam o próximo card duas vezes', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  await Promise.all([svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok' } }), svc.sincronizarEmpresa(1), svc.sincronizarEmpresa(1, { forcar: true })]);
  const abertosVend = cards(w).filter(c => c.title.endsWith('| Vendedor') && c.stageId !== w.stages.finalizado);
  assert.equal(abertosVend.length, 1);
});

test('cards duplicados criados pelo app são removidos, mantendo um por empresa+segmento+cargo', async () => {
  const { w, svc, store } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const { id: _omit, ...campos } = vend;
  const dup = (await w.call('crm.item.add', { entityTypeId: 1036, fields: campos })).result.item;
  store.setCard(+dup.id, { ...store.card(vend.id) });             // duplicata criada pelo próprio app
  assert.equal(cards(w).filter(c => c.title.endsWith('| Vendedor')).length, 2);
  const r = await svc.sincronizarEmpresa(1);
  assert.equal(r.removidos, 1);
  assert.equal(cards(w).filter(c => c.title.endsWith('| Vendedor')).length, 1);
});

test('etapa final é "Encerrado"; cards em "Finalizado" (sucesso do Bitrix) não contam como abertos e migram para Encerrado', async () => {
  const { w, svc } = setup();
  const done = w.stageList.find(s => s.STATUS_ID === 'DT1036_1:DONE'); done.NAME = 'Finalizado'; done.SEMANTICS = 'S';
  w.stageList.push({ STATUS_ID: 'DT1036_1:UC_ENC', NAME: 'Encerrado' }, { STATUS_ID: 'DT1036_1:FAIL', NAME: 'Removido', SEMANTICS: 'F' });
  const d = await svc.campos(true);
  assert.equal(d.map.etapas.finalizado, 'DT1036_1:UC_ENC');
  assert.deepEqual(d.map.etapas.concluidas.sort(), ['DT1036_1:DONE', 'DT1036_1:UC_ENC']);
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const r = await svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok' } });
  assert.equal(vend.stageId, 'DT1036_1:UC_ENC', 'visita registrada move o card para Encerrado');
  const antigo = cards(w).find(c => c.title.endsWith('| Supervisor')); antigo.stageId = 'DT1036_1:DONE';  // finalizado antes, na etapa de sucesso
  assert.ok(!(await svc.listarVisitas({ uid: 30 })).visitas.some(v => v.id === antigo.id), 'não aparece como aberto');
  const m = await svc.migrarFinalizadas();
  assert.equal(m.movidos, 1); assert.equal(antigo.stageId, 'DT1036_1:UC_ENC');
});

test('tarefa vinculada ao card: é criada com o card, muda de prazo ao alterar a data e é encerrada ao registrar a visita', async () => {
  const { w, svc, store } = setup();
  store.setConfig({ tarefaAtiva: true });
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  const t = w.tasks.find(x => (x.ufCrmTask || []).includes(`T40c_${vend.id}`));
  assert.ok(t, 'tarefa criada e vinculada ao card'); assert.equal(t.deadline, '2026-05-20T18:00:00-03:00');
  const r = await svc.reprogramar(vend.id, { uid: 10, nova: '2026-05-28', motivo: 'Cliente pediu' });
  assert.equal(r.tarefasAtualizadas, 1); assert.equal(t.deadline, '2026-05-28T18:00:00-03:00');
  await svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok' } });
  assert.equal(t.status, 5, 'tarefa encerrada ao registrar a visita');
  assert.equal(w.tasks.filter(x => x.status !== 5 && (x.ufCrmTask || []).includes(`T40c_${vend.id}`)).length, 0);
});

test('alterar a data: só de amanhã em diante e nunca para outro mês', async () => {
  const { w, svc } = setup();                                           // hoje = 10/05/2026
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));      // programada 20/05
  await assert.rejects(svc.reprogramar(vend.id, { uid: 10, nova: '2026-06-01', motivo: 'viagem' }), /outro mês/);
  await assert.rejects(svc.reprogramar(vend.id, { uid: 10, nova: '2026-05-10', motivo: 'viagem' }), /a partir de amanhã/);
  await assert.rejects(svc.reprogramar(vend.id, { uid: 10, nova: '2026-05-09', motivo: 'viagem' }), /a partir de amanhã/);
  await svc.reprogramar(vend.id, { uid: 10, nova: '2026-05-31', motivo: 'viagem' });
  assert.equal(vend.ufCrm_data, '2026-05-31');
});

test('visita não realizada no mês: card vira "Não realizada", a data não muda mais e a próxima é gerada', async () => {
  const { w, svc, store } = setup();
  w.stageList.push({ STATUS_ID: 'DT1036_1:NAOREAL', NAME: 'Não realizada' });
  await svc.campos(true);
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));     // programada 20/05/2026
  const jun = new Date('2026-06-01T11:00:00Z');                          // virou o mês sem registrar a visita
  const svc2 = createService({ bitrix: { call: w.call }, store, clock: () => jun });
  const r = await svc2.encerrarNaoRealizadas();
  assert.ok(r.marcadas >= 1);
  assert.equal(vend.stageId, 'DT1036_1:NAOREAL');
  await assert.rejects(svc2.reprogramar(vend.id, { uid: 10, nova: '2026-06-25', motivo: 'tentativa' }), /já finalizada/);
  const prox = cards(w).filter(c => c.title.endsWith('| Vendedor') && c.stageId !== 'DT1036_1:NAOREAL');
  assert.equal(prox.length, 1);
  assert.equal(prox[0].ufCrm_data, '2026-06-19', 'próxima = programada (20/05) + 30 dias (classe A), no futuro');
  assert.equal((await svc2.encerrarNaoRealizadas()).marcadas, 0, 'idempotente');
});

test('empresa que já tem Última e Próxima Visita: a fila do Vendedor nasce na data da Próxima Visita', async () => {
  const { w, svc } = setup({ UF_CRM_MOT_PROXIMA: '2026-06-15' });          // última = 20/04, próxima = 15/06
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  assert.equal(vend.ufCrm_data, '2026-06-15', 'usa a Próxima Visita do cadastro, não última + intervalo (20/05)');
  const sup = cards(w).find(c => c.title.endsWith('| Supervisor'));
  assert.equal(sup.ufCrm_data, '2026-06-19', 'outros cargos seguem a regra de intervalo');
  assert.equal(Object.keys(w.items[1032]).length, 0, 'nenhum registro de visita é criado');
});

test('lista de visitas pode incluir as encerradas (e não realizadas) com a data do encerramento', async () => {
  const { w, svc } = setup();
  await svc.sincronizarEmpresa(1);
  const vend = cards(w).find(c => c.title.endsWith('| Vendedor'));
  await svc.registrarVisita(vend.id, { uid: 10, campos: { ufCrm_res: 'Ok' } });
  const so = await svc.listarVisitas({ uid: 10 });
  assert.ok(!so.visitas.some(v => v.id === vend.id));
  const com = await svc.listarVisitas({ uid: 10, encerradas: true });
  const enc = com.visitas.find(v => v.id === vend.id);
  assert.equal(enc.situacao, 'finalizado'); assert.ok(enc.encerradoEm); assert.equal(enc.dias, null);
  assert.ok(com.visitas.some(v => v.situacao === 'aguardando'), 'as abertas continuam na lista');
});
