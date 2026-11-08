'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createDemandasApi } = require('../lib/demandasApi');
const { createBxEmpresas } = require('../lib/bxEmpresas');
const { createBxFunil } = require('../lib/bxFunil');
const { createAuth, hashSenha } = require('../lib/auth');
const { createFinStore } = require('../lib/finStore');
const IA = require('../lib/conferenciaIa');
const R = require('../lib/rules');
const F = require('../lib/feriados');

const fake = () => {
  const deals = [], notif = [];
  const est = { 8: [['C8:NEW', 'Aviso recebido', ''], ['C8:A', 'Plano de ação', ''], ['C8:W', 'Resolvido', 'S']], 12: [['C12:A', 'Cálculo nutricional', ''], ['C12:B', 'Layout do rótulo', ''], ['C12:C', 'Aprovação do cliente', ''], ['C12:W', 'Entregue', 'S']], 17: [['C17:N', 'Solicitação recebida', ''], ['C17:D', 'Entregue / Concluído', 'S']] };
  return { enabled: true, base: 'https://p.bitrix24.com.br/rest/1/x', deals, notif, async call(m, p) {
    if (m === 'crm.deal.fields') return { result: { UF_PROD: { formLabel: 'Nome do Produto' }, UF_ING: { formLabel: 'Ingredientes e quantidades (g)' }, UF_GLU: { formLabel: 'Contaminação cruzada com Glúten?', items: [{ ID: '1', VALUE: 'Sim' }, { ID: '2', VALUE: 'Não' }] }, UF_SAC: { formLabel: 'SAC' } } };
    if (m === 'crm.company.fields') return { result: { UF_C: { formLabel: 'CNPJ' } } };
    if (m === 'crm.company.list') return { result: [{ ID: '5', TITLE: 'BK Anhaia' }] };
    if (m === 'user.get') return { result: [{ ID: '10', NAME: 'Suporte', LAST_NAME: 'X' }, { ID: '11', NAME: 'Ana', LAST_NAME: 'Y' }] };
    if (m === 'crm.status.list') return { result: (est[Number(p.filter.ENTITY_ID.split('_')[2])] || []).map(([STATUS_ID, NAME, SEMANTICS]) => ({ STATUS_ID, NAME, SEMANTICS })) };
    if (m === 'crm.deal.list') return { result: deals.filter(x => String(x.CATEGORY_ID) === String(p.filter.CATEGORY_ID)) };
    if (m === 'crm.deal.get') return { result: deals.find(x => x.ID === String(p.id)) };
    if (m === 'crm.deal.add') { const id = String(900 + deals.length); deals.push({ ID: id, ...p.fields }); return { result: id }; }
    if (m === 'crm.deal.update') { Object.assign(deals.find(x => x.ID === String(p.id)), p.fields); return { result: true }; }
    if (m === 'im.notify.personal.add') { notif.push(p); return { result: 1 }; } return { result: true }; } };
};
test('processos por funil: quadro, prazo, checklist, dupla checagem, alertas e entrada de e-mail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-')), bitrix = fake(), unidades = [{ bkn: '23735', empresaBitrixId: '5' }];
  const api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => unidades }, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  const ana = { id: 'u1', nome: 'Ana' }, bia = { id: 'u2', nome: 'Bia' };
  // multas: prazo vira o CLOSEDATE do negócio e dispara alertas uma vez por marco
  const n = await call('POST', '/multas/negocios', { titulo: 'Defesa loja BKN 23735', empresaId: '5', prazo: F.somaDias(R.todayBR(), 6), responsavel: '11' });
  assert.equal(n.checklist.length, 5); assert.equal(bitrix.deals[0].CATEGORY_ID, 8); assert.equal(bitrix.deals[0].STAGE_ID, 'C8:NEW');
  const q = await call('GET', '/multas/quadro'); assert.equal(q.negocios[0].empresaNome, 'BK Anhaia'); assert.equal(q.negocios[0].responsavelNome, 'Ana Y'); assert.equal(q.negocios[0].situacao.estado, 'vencendo');
  const av = await call('POST', '/avisar', { simular: false }); assert.equal(av.enviados.length, 1); assert.equal(bitrix.notif[0].USER_ID, '11'); assert.equal((await call('POST', '/avisar', { simular: false })).enviados.length, 0);
  await call('PUT', `/multas/negocios/${n.id}`, { prazo: F.somaDias(R.todayBR(), 2) }); assert.equal((await call('POST', '/avisar', { simular: false })).enviados.length, 1);   // outro marco
  await call('POST', `/multas/negocios/${n.id}/mover`, { etapa: 'C8:W' }); assert.equal((await call('POST', '/avisar', { simular: false })).enviados.length, 0);   // resolvida não alerta
  // rotulagem: só passa para "Aprovação do cliente" com duas aprovações internas de pessoas diferentes
  const r = await call('POST', '/rotulagem/negocios', { titulo: 'Rótulo Granola', empresaId: '5' }); assert.equal(r.checklist.length, 6);
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'C12:C' }), /Dupla checagem/);
  await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'aprovado' }, ana); await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'aprovado' }, ana);
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'C12:C' }), /há 1/);   // a mesma pessoa duas vezes não vale
  await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'aprovado', nota: 'ok' }, bia);
  assert.equal((await call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'C12:C' })).etapa, 'C12:C');
  await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'reprovado', nota: 'vírgula errada' }, bia);   // reprovou: zera as aprovações
  assert.equal((await call('GET', `/rotulagem/negocios/${r.id}`)).aprovadoresValidos, 0);
  const ck = await call('PUT', `/rotulagem/negocios/${r.id}/checklist/0`, { ok: true }, ana); assert.equal(ck.checklist[0].ok, true); assert.equal(ck.checklist[0].por, 'Ana');
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/link`, { url: 'javascript:alert(1)' }), /Link inválido/); assert.equal((await call('POST', `/rotulagem/negocios/${r.id}/link`, { url: 'https://drive.google.com/x', nome: 'Pasta' })).links.length, 1);
  // suplementos só existe depois que o funil for informado
  await assert.rejects(call('GET', '/suplementos/quadro'), /ainda não foi criado/);
  // entrada de e-mail: token, identificação da unidade pelo BKN, sem duplicar
  await assert.rejects(api.entradaEmail({ assunto: 'x' }, 'qualquer'), /não foi ativada/);
  const { token } = await call('POST', '/solicitacoes/entrada/token'); await assert.rejects(api.entradaEmail({ assunto: 'x' }, 'errado'), /Token inválido/);
  const e = await api.entradaEmail({ assunto: 'Pedido de rótulo - BKN 23735', texto: 'Precisamos do rótulo do molho.', de: 'loja@bk.com', messageId: '<m1>' }, token); assert.equal(e.identificada, true);
  const dl = bitrix.deals.find(x => x.ID === e.id); assert.equal(dl.CATEGORY_ID, 17); assert.equal(dl.COMPANY_ID, '5'); assert.match(dl.TITLE, /BKN 23735/); assert.match(dl.COMMENTS, /loja@bk\.com/);
  assert.equal((await api.entradaEmail({ assunto: 'Pedido de rótulo - BKN 23735', messageId: '<m1>' }, token)).duplicado, true);
  assert.equal((await api.entradaEmail({ assunto: 'Dúvida geral', texto: 'sem unidade' }, token)).identificada, false);
});

test('áreas: cada pessoa só abre o que foi liberado; contratos ficam restritos', async () => {
  const auth = createAuth({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'au-')), env: { ADMIN_USER: 'a', ADMIN_HASH: await hashSenha('Inicial12345') } });
  const u = auth.liberarBitrix({ bitrixId: '7', nome: 'Ana', perfil: 'operacional', areas: ['cronograma', 'rotulagem'] }), t = (await auth.entrarBitrix({ id: '7' })).token;
  const g = (m, p) => auth.porteiro({ method: m, pathname: p, headers: { authorization: `Bearer ${t}` } });
  assert.equal(g('GET', '/api/cron/bootstrap').user.nome, 'Ana'); assert.equal(g('GET', '/api/dem/rotulagem/quadro').user.nome, 'Ana');
  assert.equal(g('GET', '/api/dem/multas/quadro').status, 403); assert.equal(g('GET', '/api/bk/unidades').status, 403); assert.equal(g('GET', '/api/car/clientes').status, 403); assert.equal(g('GET', '/api/fin/bootstrap').status, 403);
  assert.deepEqual(u.areas, ['cronograma', 'rotulagem']); await auth.atualizar(u.id, { areas: ['cronograma', 'clientes'] }, auth.listar().find(x => x.perfil === 'admin'));
  assert.equal(g('GET', '/api/car/clientes').user.nome, 'Ana'); assert.equal(g('GET', '/api/dem/rotulagem/quadro').status, 403);
  assert.throws(() => auth.liberarBitrix({ bitrixId: '8', nome: 'Bia', perfil: 'consulta', areas: ['inexistente'] }), /Área inválida/);
  assert.equal(auth.areasDe({ perfil: 'consulta' }).includes('contratos'), false); assert.equal(auth.areasDe({ perfil: 'financeiro' }).includes('contratos'), true);   // antigos: padrão por perfil
  assert.equal(auth.permite('operacional', 'POST', '/api/dem/rotulagem/negocios'), true); assert.equal(auth.permite('operacional', 'POST', '/api/dem/solicitacoes/entrada/token'), false); assert.equal(auth.permite('financeiro', 'POST', '/api/dem/avisar'), false);
});

test('serviço pontual: cobrança 50/50 em Contas a receber trava o início e a entrega até o pagamento', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-')), bitrix = fake(), fin = createFinStore(dir); fin.empresas.add({ id: 'e1', nome: 'Nutri Mix', ativa: true });
  const api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => [] }, fin, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  const n = await call('POST', '/rotulagem/negocios', { titulo: 'Rótulo Molho', empresaId: '5' });
  await assert.rejects(call('POST', '/solicitacoes/negocios/1/cobranca', { valor: 100 }), /não usa cobrança/); await assert.rejects(call('POST', `/rotulagem/negocios/${n.id}/cobranca`, { valor: 1000 }), /empresa que vai faturar/);
  await call('PUT', '/config', { empresaFaturaId: 'e1' }); await assert.rejects(call('POST', `/rotulagem/negocios/${n.id}/cobranca`, { valor: 1 }), /valor total/);
  const c = await call('POST', `/rotulagem/negocios/${n.id}/cobranca`, { valor: 1001, vencEntrada: '2026-11-10' });
  assert.equal(c.cobranca.entrada.valor, 500.5); assert.equal(c.cobranca.final.valor, 500.5); assert.equal(fin.receber.all().length, 2); assert.equal(fin.receber.all()[0].demandaId, n.id); assert.equal(fin.receber.all()[0].venc, '2026-11-10');
  await assert.rejects(call('POST', `/rotulagem/negocios/${n.id}/cobranca`, { valor: 5 }), /já tem cobrança/);
  await assert.rejects(call('POST', `/rotulagem/negocios/${n.id}/mover`, { etapa: 'C12:B' }), /entrada de 50%/);                 // não sai da 1ª etapa sem a entrada
  const ent = fin.receber.get(c.cobranca.entrada.id); fin.receber.put({ ...ent, status: 'pago', pagoEm: '2026-11-10' });
  assert.equal((await call('POST', `/rotulagem/negocios/${n.id}/mover`, { etapa: 'C12:A' })).etapa, 'C12:A');
  await assert.rejects(call('POST', `/rotulagem/negocios/${n.id}/mover`, { etapa: 'C12:W' }), /50% finais/);                       // não entrega sem o final
  await call('POST', `/rotulagem/negocios/${n.id}/liberar`, { qual: 'final', motivo: 'Cliente antigo, combinado por escrito' }); assert.equal((await call('GET', `/rotulagem/negocios/${n.id}`)).cobranca.liberacoes.length, 1);
  await assert.rejects(call('POST', `/rotulagem/negocios/${n.id}/liberar`, { qual: 'final', motivo: 'x' }), /motivo/); assert.equal((await call('POST', `/rotulagem/negocios/${n.id}/mover`, { etapa: 'C12:W' })).etapa, 'C12:W');
  await assert.rejects(call('DELETE', `/rotulagem/negocios/${n.id}/cobranca`), /já paga/);
  const q = await call('GET', '/rotulagem/quadro'); assert.equal(q.negocios[0].cobranca.entradaPaga, true); assert.equal(q.negocios[0].cobranca.finalPaga, false);
  const auth = createAuth({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'au-')), env: { ADMIN_USER: 'a', ADMIN_HASH: await hashSenha('Inicial12345') } });
  const u9 = auth.liberarBitrix({ bitrixId: '9', nome: 'Sem Contas', perfil: 'financeiro', areas: ['cronograma'] }), t9 = (await auth.entrarBitrix({ id: '9' })).token, g9 = (m, p) => auth.porteiro({ method: m, pathname: p, headers: { authorization: `Bearer ${t9}` } });
  for (const p of ['/api/state', '/api/clientes', '/api/dashboard', '/api/links', '/api/carteiras', '/api/assinaturas']) assert.equal(g9('GET', p).status, 403, p);   // motor antigo de cobrança é da área Contas
  assert.equal(g9('GET', '/api/settings').status, 403); assert.equal(g9('GET', '/api/cron/semana').user.nome, 'Sem Contas');
  const adm = auth.listar().find(x => x.perfil === 'admin'), tAdm = (await auth.entrarBitrix({ id: adm.bitrixId || '0' }).catch(() => ({}))).token;
  assert.equal(auth.permite('operacional', 'POST', '/api/dem/rotulagem/negocios/9/liberar'), false); assert.equal(auth.permite('financeiro', 'POST', '/api/dem/rotulagem/negocios/9/liberar'), false); assert.equal(auth.permite('admin', 'POST', '/api/dem/rotulagem/negocios/9/liberar'), true); assert.equal(auth.permite('financeiro', 'POST', '/api/dem/rotulagem/negocios/9/cobranca'), true);
});

test('conferência por IA (a IA do cliente): pedido com os dados do formulário, leitura da resposta e histórico', async () => {
  const resp = IA.interpretar('1 | OK | nome confere\n2) ERRO - ordem dos ingredientes invertida (RDC 727)\nitem 3: ATENÇÃO falta ver o rótulo\n99 | ERRO | fora da lista\nlinha solta sem formato\nRESUMO: Há um erro na lista de ingredientes. Revisar o restante.');
  assert.deepEqual(resp.itens.map(i => [i.n, i.status]), [[1, 'ok'], [2, 'erro'], [3, 'atencao']]); assert.match(resp.itens[1].nota, /ordem dos ingredientes/); assert.match(resp.resumo, /erro na lista/);
  assert.equal(IA.situacao(resp.itens), 'erros'); assert.equal(IA.situacao([{ status: 'ok' }]), 'ok'); assert.equal(IA.situacao([{ status: 'ok' }, { status: 'atencao' }]), 'atencao'); assert.equal(IA.situacao([]), 'sem');
  const ped = IA.montarPedido({ titulo: 'Rótulo Granola', empresa: 'Cliente X', dados: [{ rotulo: 'Ingredientes', valor: 'Aveia 40 g' }] }); assert.match(ped, /Rótulo Granola/); assert.match(ped, /- Ingredientes: Aveia 40 g/); assert.match(ped, new RegExp(`${IA.REGRAS.length}\\. `)); assert.match(ped, /não substitui a revisão humana/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-')), bitrix = fake(), api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => [] }, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  const n = await call('POST', '/rotulagem/negocios', { titulo: 'Rótulo Molho', empresaId: '5' }); Object.assign(bitrix.deals[0], { UF_PROD: 'Molho da casa', UF_ING: 'Tomate 800 g, sal 10 g', UF_GLU: '2', UF_SAC: '0800 123' });
  const pe = await call('GET', `/rotulagem/negocios/${n.id}/ia/pedido`); assert.equal(pe.dados.length, 4); assert.match(pe.pedido, /Contaminação cruzada com glúten\?: Não/); assert.match(pe.pedido, /Cliente: BK Anhaia/);
  await assert.rejects(call('GET', '/multas/negocios/1/ia/pedido'), /não tem conferência por IA/); await assert.rejects(call('POST', `/rotulagem/negocios/${n.id}/ia/resultado`, { resposta: '' }), /Cole a resposta/);
  const r = await call('POST', `/rotulagem/negocios/${n.id}/ia/resultado`, { resposta: '2 | ERRO | ordem', itens: [{ n: 2, status: 'erro', nota: 'ordem' }, { n: 1, status: 'ok' }, { n: 77, status: 'erro' }, { n: 3, status: 'qualquer' }] }, { nome: 'Ana', id: 'u1' });
  assert.equal(r.ia.length, 1); assert.equal(r.ia[0].situacao, 'erros'); assert.equal(r.ia[0].itens.length, 3); assert.equal(r.ia[0].itens.find(i => i.n === 3).status, 'atencao'); assert.equal(r.regrasIa.length, IA.REGRAS.length); assert.match(r.notas[0].t, /não substitui a dupla checagem/);
  assert.equal(r.aprovadoresValidos, 0);   // a IA nunca conta como aprovação
  const sol = await call('POST', '/solicitacoes/negocios', { titulo: 'x pedido' }); assert.equal(sol.comIa, false);
});
