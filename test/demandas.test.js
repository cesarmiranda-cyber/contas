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
  const est = { 8: [['C8:NEW', 'Aviso recebido', ''], ['C8:A', 'Plano de ação', ''], ['C8:W', 'Resolvido', 'S']], 12: [['C12:A', 'Em andamento', ''], ['C12:B', 'Aguardando cliente', ''], ['C12:W', 'Concluído', 'S']], 17: [['C17:N', 'Solicitação recebida', ''], ['C17:D', 'Entregue / Concluído', 'S']] };
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
  // multas (geridas no app): o prazo gera alertas uma vez por marco; o Bitrix24 recebe só o resumo no funil "Serviços técnicos"
  const n = await call('POST', '/multas/negocios', { titulo: 'Defesa loja BKN 23735', empresaId: '5', prazo: F.somaDias(R.todayBR(), 6), responsavel: '11' });
  assert.equal(n.checklist.length, 5); assert.equal(n.id, 'M1'); assert.equal(bitrix.deals[0].CATEGORY_ID, 12); assert.equal(bitrix.deals[0].STAGE_ID, 'C12:A'); assert.match(bitrix.deals[0].TITLE, /^\[Multas\] Defesa/); assert.equal(bitrix.deals[0].CLOSEDATE, F.somaDias(R.todayBR(), 6));
  const q = await call('GET', '/multas/quadro'); assert.equal(q.negocios[0].empresaNome, 'BK Anhaia'); assert.equal(q.negocios[0].responsavelNome, 'Ana Y'); assert.equal(q.negocios[0].situacao.estado, 'vencendo'); assert.equal(q.etapas.length, 7);
  const av = await call('POST', '/avisar', { simular: false }); assert.equal(av.enviados.length, 1); assert.equal(bitrix.notif[0].USER_ID, '11'); assert.equal((await call('POST', '/avisar', { simular: false })).enviados.length, 1 - 1 + 0);
  await call('PUT', '/multas/negocios/M1', { prazo: F.somaDias(R.todayBR(), 2) }); assert.equal((await call('POST', '/avisar', { simular: false })).enviados.length, 1);   // outro marco
  assert.equal(bitrix.deals[0].CLOSEDATE, F.somaDias(R.todayBR(), 2));
  await call('POST', '/multas/negocios/M1/mover', { etapa: 'm6' }); assert.equal(bitrix.deals[0].STAGE_ID, 'C12:W'); assert.equal((await call('POST', '/avisar', { simular: false })).enviados.length, 0);   // resolvida não alerta
  // rotulagem: passo a passo com regras
  const r = await call('POST', '/rotulagem/negocios', { titulo: 'Rótulo Granola', empresaId: '5' }); assert.equal(r.checklist.length, 10); assert.equal(r.etapa, 'r1'); assert.equal(r.documentos.length, 7);
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r4' }), /Enquadramento regulatório/);   // precisa definir o enquadramento antes do relatório
  await assert.rejects(call('PUT', `/rotulagem/negocios/${r.id}/campos`, { enquadramento: 'qualquer coisa' }), /Valor inválido/);
  const camp = (await call('GET', `/rotulagem/negocios/${r.id}`)).campos.find(c => c.k === 'enquadramento'); await call('PUT', `/rotulagem/negocios/${r.id}/campos`, { enquadramento: camp.opcoes[1] });
  assert.equal((await call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r4' })).etapa, 'r4');
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r7' }), /Dupla checagem/);
  await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'aprovado' }, ana); await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'aprovado' }, ana);
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r7' }), /há 1/);   // a mesma pessoa duas vezes não vale
  await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'aprovado', nota: 'ok' }, bia);
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r7' }), /Versão da arte aprovada/);
  await call('PUT', `/rotulagem/negocios/${r.id}/campos`, { versaoAprovada: 'arte_v3_2026-11-09.pdf' });
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r7' }), /Nunca aprovar um rótulo com pendências/);   // sem conferência das correções
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/rodada`, { resultado: 'pendencias', texto: '' }), /Descreva as pendências/);
  await call('POST', `/rotulagem/negocios/${r.id}/rodada`, { resultado: 'pendencias', texto: 'Falta a lupa frontal de sódio' }, ana);
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r7' }), /Nunca aprovar/);   // a última rodada ainda tem pendência
  const r2 = await call('POST', `/rotulagem/negocios/${r.id}/rodada`, { resultado: 'ok' }, ana); assert.deepEqual(r2.rodadas.map(x => x.resultado), ['pendencias', 'ok']);
  assert.equal((await call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r7' })).etapa, 'r7');
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r8' }), /Arte final aprovada/);   // arquivamento exige a aprovação e o e-mail guardados
  await call('POST', `/rotulagem/negocios/${r.id}/link`, { nome: 'Arte final aprovada', url: 'https://drive.google.com/a' }); await call('POST', `/rotulagem/negocios/${r.id}/link`, { nome: 'E-mail de aprovação final', url: 'https://drive.google.com/b' });
  assert.equal((await call('POST', `/rotulagem/negocios/${r.id}/mover`, { etapa: 'r8' })).etapaNome, 'Concluído e arquivado'); assert.equal((await call('GET', `/rotulagem/negocios/${r.id}`)).documentos.filter(x => x.url).length, 2);
  await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'reprovado', nota: 'vírgula errada' }, bia);   // reprovou: zera as aprovações
  assert.equal((await call('GET', `/rotulagem/negocios/${r.id}`)).aprovadoresValidos, 0);
  const ck = await call('PUT', `/rotulagem/negocios/${r.id}/checklist/0`, { ok: true }, ana); assert.equal(ck.checklist[0].ok, true); assert.equal(ck.checklist[0].por, 'Ana');
  await assert.rejects(call('POST', `/rotulagem/negocios/${r.id}/link`, { url: 'javascript:alert(1)' }), /Link inválido/); assert.equal((await call('POST', `/rotulagem/negocios/${r.id}/link`, { url: 'https://drive.google.com/x', nome: 'Pasta' })).links.length, 3);
  // suplementos: 7 etapas reais, estabilidade e protocolo obrigatórios, 5 documentos + comprovante
  const sp = await call('POST', '/suplementos/negocios', { titulo: 'Suplemento Whey', empresaId: '5' }); assert.equal(sp.checklist.length, 10); assert.equal((await call('GET', '/suplementos/quadro')).etapas.length, 8);
  await assert.rejects(call('POST', `/suplementos/negocios/${sp.id}/mover`, { etapa: 's6' }), /Documentação de estabilidade/);
  await call('PUT', `/suplementos/negocios/${sp.id}/campos`, { estabilidade: sp.campos[0].opcoes[1] }); assert.equal((await call('POST', `/suplementos/negocios/${sp.id}/mover`, { etapa: 's6' })).etapa, 's6');
  await assert.rejects(call('POST', `/suplementos/negocios/${sp.id}/mover`, { etapa: 's7' }), /Nº do protocolo/);
  await call('PUT', `/suplementos/negocios/${sp.id}/campos`, { protocoloSolicita: '25351.123456/2026-11' }); await assert.rejects(call('POST', `/suplementos/negocios/${sp.id}/mover`, { etapa: 's7' }), /Comprovante do protocolo/);
  await call('POST', `/suplementos/negocios/${sp.id}/link`, { nome: 'Comprovante do protocolo', url: 'https://drive.google.com/c' }); assert.equal((await call('POST', `/suplementos/negocios/${sp.id}/mover`, { etapa: 's7' })).etapa, 's7');
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
  const n = await call('POST', '/suplementos/negocios', { titulo: 'Suplemento Whey', empresaId: '5' }), P = `/suplementos/negocios/${n.id}`;
  await assert.rejects(call('POST', '/solicitacoes/negocios/1/cobranca', { valor: 100 }), /não usa cobrança/); await assert.rejects(call('POST', `${P}/cobranca`, { valor: 1000 }), /empresa que vai faturar/);
  await call('PUT', '/config', { empresaFaturaId: 'e1' }); await assert.rejects(call('POST', `${P}/cobranca`, { valor: 1 }), /valor total/);
  const c = await call('POST', `${P}/cobranca`, { valor: 1001, vencEntrada: '2026-11-10' });
  assert.equal(c.cobranca.entrada.valor, 500.5); assert.equal(c.cobranca.final.valor, 500.5); assert.equal(fin.receber.all().length, 2); assert.equal(fin.receber.all()[0].demandaId, n.id); assert.equal(fin.receber.all()[0].venc, '2026-11-10');
  await assert.rejects(call('POST', `${P}/cobranca`, { valor: 5 }), /já tem cobrança/);
  await assert.rejects(call('POST', `${P}/mover`, { etapa: 's2' }), /entrada de 50%/);                 // não sai da 1ª etapa sem a entrada
  const ent = fin.receber.get(c.cobranca.entrada.id); fin.receber.put({ ...ent, status: 'pago', pagoEm: '2026-11-10' });
  assert.equal((await call('POST', `${P}/mover`, { etapa: 's2' })).etapa, 's2');
  await assert.rejects(call('POST', `${P}/mover`, { etapa: 's7' }), /50% finais/);                       // não finaliza sem o final
  await call('POST', `${P}/liberar`, { qual: 'final', motivo: 'Cliente antigo, combinado por escrito' }); assert.equal((await call('GET', P)).cobranca.liberacoes.length, 1);
  await assert.rejects(call('POST', `${P}/liberar`, { qual: 'final', motivo: 'x' }), /motivo/);
  await call('PUT', `${P}/campos`, { protocoloSolicita: '123' }); await call('POST', `${P}/link`, { nome: 'Comprovante do protocolo', url: 'https://drive.google.com/c' }); assert.equal((await call('POST', `${P}/mover`, { etapa: 's7' })).etapa, 's7');
  await assert.rejects(call('DELETE', `${P}/cobranca`), /já paga/);
  const q = await call('GET', '/suplementos/quadro'); assert.equal(q.negocios[0].cobranca.entradaPaga, true); assert.equal(q.negocios[0].cobranca.finalPaga, false);
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
  const n = await call('POST', '/rotulagem/negocios', { titulo: 'Rótulo Molho', empresaId: '5' }); await call('PUT', `/rotulagem/negocios/${n.id}/dados`, { 'nome do produto': 'Molho da casa', 'ingredientes e quantidades (g)': 'Tomate 800 g, sal 10 g', 'contaminação cruzada com glúten?': 'Não', sac: '0800 123' });
  const pe = await call('GET', `/rotulagem/negocios/${n.id}/ia/pedido`); assert.equal(pe.dados.length, 4); assert.match(pe.pedido, /Contaminação cruzada com glúten\?: Não/); assert.match(pe.pedido, /Cliente: BK Anhaia/);
  await assert.rejects(call('GET', '/multas/negocios/M1/ia/pedido'), /não tem conferência por IA/); await assert.rejects(call('POST', `/rotulagem/negocios/${n.id}/ia/resultado`, { resposta: '' }), /Cole a resposta/);
  const r = await call('POST', `/rotulagem/negocios/${n.id}/ia/resultado`, { resposta: '2 | ERRO | ordem', itens: [{ n: 2, status: 'erro', nota: 'ordem' }, { n: 1, status: 'ok' }, { n: 77, status: 'erro' }, { n: 3, status: 'qualquer' }] }, { nome: 'Ana', id: 'u1' });
  assert.equal(r.ia.length, 1); assert.equal(r.ia[0].situacao, 'erros'); assert.equal(r.ia[0].itens.length, 3); assert.equal(r.ia[0].itens.find(i => i.n === 3).status, 'atencao'); assert.equal(r.regrasIa.length, IA.REGRAS.length); assert.match(r.notas[0].t, /não substitui a dupla checagem/);
  assert.equal(r.aprovadoresValidos, 0);   // a IA nunca conta como aprovação
  const sol = await call('POST', '/solicitacoes/negocios', { titulo: 'x pedido' }); assert.equal(sol.comIa, false);
});

test('funil único "Serviços técnicos": prepara um funil vazio (simulação antes) e recusa funil com negócios de outros', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-')), chamadas = [], deals = [];
  let rows = [['NEW', 'Coleta', ''], ['A', 'Cálculo', ''], ['B', 'Enquadramento', ''], ['C', 'Layout', ''], ['W', 'Entregue', 'S'], ['L', 'Cancelado', 'F']].map(([i, n, sm], k) => ({ ID: String(100 + k), STATUS_ID: `C12:${i}`, NAME: n, SEMANTICS: sm }));
  const bitrix = { enabled: true, base: 'https://p.bitrix24.com.br/rest/1/x', async call(m, p) { chamadas.push(m);
    if (m === 'crm.dealcategory.list') return { result: [{ ID: '12', NAME: 'Rotulagem Nutricional' }] };
    if (m === 'crm.deal.list') return { result: deals };
    if (m === 'crm.status.list') return { result: rows };
    if (m === 'crm.status.update') { rows.find(r => r.ID === String(p.id)).NAME = p.fields.NAME; return { result: true }; }
    if (m === 'crm.status.delete') { rows = rows.filter(r => r.ID !== String(p.id)); return { result: true }; }
    return { result: true }; } };
  const api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix, ttl: 0 }), bk: { unidades: () => [] }, store: { log() {} }, dir });
  const call = async (m, p, b) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {})).json; };
  const sim = await call('POST', '/servicos/preparar', {}); assert.equal(sim.simulacao, true); assert.equal(sim.plano.filter(x => x.acao === 'remover etapa').length, 2); assert.ok(!chamadas.some(c => /update|delete/.test(c)));   // simulação não altera nada
  deals.push({ ID: '5', COMMENTS: 'negócio de outra pessoa' }); await assert.rejects(call('POST', '/servicos/preparar', { simular: false }), /não são do app/); deals.length = 0;
  const r = await call('POST', '/servicos/preparar', { simular: false }); assert.deepEqual(r.etapas, ['Em andamento', 'Aguardando cliente', 'Concluído', 'Cancelado']);
  assert.ok(chamadas.includes('crm.dealcategory.update'));
});

test('calculadora da tabela nutricional: arredondamento, não significativos, %VD, energia, frontal, porções e tolerância (IN 75 / RDC 429)', async () => {
  const C = require('../lib/rotulagemCalc');
  assert.deepEqual([C.arredondar(12.5, 'g'), C.arredondar(12.4, 'g'), C.arredondar(9.96, 'g'), C.arredondar(1.25, 'g'), C.arredondar(0.449, 'g'), C.arredondar(0.456, 'mg'), C.arredondar(0.0449, 'mg')], [13, 12, 10, 1.3, 0.4, 0.46, 0.04]);
  const r = C.calcular({ base: 'solido', porcao: 30, embalagem: 300, painel: 120, energia: '466', v100: { carbo: 70, acucTot: 30, acucAdic: 20, prot: 6, gordTot: 18, gordSat: 7, gordTrans: 0, fibras: 3, sodio: 650 }, lab: { sodio: 800, prot: 4, gordTot: 20 } });
  const l = k => r.linhas.find(x => x.k === k);
  assert.equal(l('carbo').vPorcao, 21); assert.equal(l('carbo').vd, 7); assert.equal(l('acucAdic').vd, 12); assert.equal(l('gordSat').vd, 11); assert.equal(l('gordTrans').ns100, true); assert.equal(l('sodio').vPorcao, 195); assert.equal(l('acucTot').vd, null);   // sem VDR: campo vazio
  assert.equal(r.energia.calculada100, 466); assert.equal(r.energia.ok, true); assert.equal(r.energia.calculadaPorcao, 140); assert.equal(r.porcoes.texto, 'Porções por embalagem: 10');
  assert.equal(r.frontal.obrigatoria, true); assert.equal(r.frontal.modeloAnexoXVII, 1); assert.equal(r.frontal.blocos, 4); assert.equal(r.frontal.ocupacaoPct, 4); assert.equal(r.frontal.areaMinCm2, 4.8); assert.deepEqual(r.frontal.fonte, { min: 9, max: 15 });
  assert.deepEqual(r.tolerancia.map(t => [t.nome, t.ok]), [['Proteínas', false], ['Gorduras totais', true], ['Sódio', false]]);
  const peq = C.calcular({ base: 'solido', porcao: 30, embalagem: 60, painel: 80, v100: { acucAdic: 20, carbo: 70, acucTot: 30, prot: 1, gordTot: 1, gordSat: 0, gordTrans: 0, fibras: 0, sodio: 10 } });
  assert.equal(peq.frontal.modeloAnexoXVII, 5); assert.equal(peq.frontal.blocos, 2); assert.equal(peq.frontal.ocupacaoPct, 3.5); assert.deepEqual(peq.frontal.fonte, { min: null, max: 9 })
  assert.equal(peq.porcoes.declarar, false);   // 60 g / 30 g = 2 porções: embalagem individual
  const liq = C.calcular({ base: 'liquido', porcao: 200, embalagem: 1000, painel: 20, v100: { acucAdic: 7.5, carbo: 10, acucTot: 9, prot: 0, gordTot: 0, gordSat: 0, gordTrans: 0, fibras: 0, sodio: 20 } });
  assert.equal(liq.frontal.obrigatoria, true); assert.equal(liq.frontal.opcional, true);   // 7,5 g/100 ml atinge o limite; painel < 35 cm² torna opcional
  assert.equal(C.calcular({ base: 'solido', v100: { acucAdic: 14.6, gordSat: 5, sodio: 590 } }).frontal.perto.length, 2);   // perto do limite: pede o valor exato
  assert.equal(C.porcoesPorEmbalagem(250, 100).texto, 'Porções por embalagem: Cerca de 3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')), bitrix = fake(), api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => [] }, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  const n = await call('POST', '/rotulagem/negocios', { titulo: 'Granola', empresaId: '5' });
  const x = await call('POST', '/rotulagem/calculadora', { negocioId: n.id, base: 'solido', porcao: '30', v100: { carbo: '70', sodio: '650' } }, { nome: 'Ana' });
  assert.ok(x.alertas.some(a => /sem valor informado/.test(a))); const d = await call('GET', `/rotulagem/negocios/${n.id}`); assert.match(d.calculo.texto, /CONFERÊNCIA NUMÉRICA/); assert.equal(d.comCalculadora, true);
});

test('porções de referência (IN 75, Anexo V): busca por produto e utensílios', () => {
  const P = require('../lib/porcoes');
  assert.equal(P.LISTA.length, 138); assert.ok(P.GRUPOS.length === 8);
  const m = P.buscar('molho de tomate')[0]; assert.deepEqual([m.produto.slice(0, 15), m.valor, m.un, m.medida], ['Molho de tomate', 60, 'g', 'Colheres de sopa']);
  assert.equal(P.buscar('iogurte')[0].valor, 200); assert.equal(P.buscar('IOGURTE')[0].un, 'g'); assert.equal(P.buscar('refrigerante')[0].un, 'ml'); assert.equal(P.buscar('pó para gelatina')[0].qsp, true);
  assert.deepEqual(P.buscar('xyzqq'), []); assert.equal(P.UTENSILIOS.length, 6);
});
