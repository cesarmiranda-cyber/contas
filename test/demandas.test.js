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
  const est = { 0: [['C0:NEW', 'Novo contato', ''], ['C0:WON', 'Ganho', 'S']], 4: [['C4:A', 'Kickoff', ''], ['C4:W', 'Entregue', 'S']], 8: [['C8:NEW', 'Aviso recebido', ''], ['C8:A', 'Plano de ação', ''], ['C8:W', 'Resolvido', 'S']], 12: [['C12:A', 'Em andamento', ''], ['C12:B', 'Aguardando cliente', ''], ['C12:W', 'Concluído', 'S']], 17: [['C17:N', 'Solicitação recebida', ''], ['C17:D', 'Entregue / Concluído', 'S']] };
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


test('gestão: prioridade, cartão parado, painel por pessoa, sugestão de responsável, prazo da defesa e fechamento comercial', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-')), bitrix = fake(), fin = createFinStore(dir); fin.empresas.add({ id: 'e1', nome: 'Nutri Mix', ativa: true });
  const api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => [{ bkn: '23735', empresaBitrixId: '5' }] }, fin, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  await call('PUT', '/gestao/config', { paradoDias: 3, gestorIds: ['10'], equipe: { 11: ['multas', 'rotulagem'], 10: ['suplementos'] } });
  // multas: BKN liga a empresa; ciência + prazo legal calculam o prazo da defesa
  const m = await call('POST', '/multas/negocios', { titulo: 'Auto loja Uberlândia', bkn: '23735', prioridade: 'alta', responsavel: '11' }); assert.equal(m.empresaId, '5'); assert.equal(m.prioridade, 'alta'); assert.equal(m.bkn, '23735');
  await assert.rejects(call('PUT', `/multas/negocios/${m.id}/campos`, { dataCiencia: '31/12/2026' }), /Data inválida/);
  const hj = R.todayBR(), c = await call('PUT', `/multas/negocios/${m.id}/campos`, { orgao: 'CVS', numeroAuto: '123', dataCiencia: hj, prazoDias: '10' }); assert.equal(c.prazo, F.somaDias(hj, 10));
  await assert.rejects(call('PUT', `/multas/negocios/${m.id}`, { prioridade: 'urgentíssima' }), /Prioridade inválida/); await call('PUT', `/multas/negocios/${m.id}`, { prioridade: 'baixa' }); assert.equal((await call('GET', `/multas/negocios/${m.id}`)).prioridade, 'baixa'); await call('PUT', `/multas/negocios/${m.id}`, { prioridade: 'alta' });
  // parado: cartão antigo sem movimento aparece no painel e avisa responsável e gestor uma vez
  const rot = await call('POST', '/rotulagem/negocios', { titulo: 'Rótulo parado', empresaId: '5', responsavel: '11' }); api.dados().locais[rot.id].criado = F.somaDias(hj, -9) + 'T10:00:00.000Z'; api.dados().itens[rot.id].movidoEm = F.somaDias(hj, -9) + 'T10:00:00.000Z';
  const p = await call('GET', '/gestao'); assert.equal(p.parados.length, 1); assert.equal(p.parados[0].titulo, 'Rótulo parado'); assert.ok(p.parados[0].paradoDias >= 9); assert.equal(p.pessoas.find(x => x.id === '11').abertos, 2); assert.equal(p.pessoas.find(x => x.id === '11').altas, 1);
  assert.equal(p.processos.find(x => x.chave === 'rotulagem').parados, 1);
  const av = await call('POST', '/avisar', { simular: false }); const par = bitrix.notif.filter(n => /sem movimento/.test(n.MESSAGE)); assert.deepEqual(par.map(n => n.USER_ID).sort(), ['10', '11']); assert.ok(av.enviados.some(e => /sem movimento/.test(e.msg)));
  const antes = bitrix.notif.length; await call('POST', '/avisar', { simular: false }); assert.equal(bitrix.notif.filter(n => /sem movimento/.test(n.MESSAGE)).length, 2); assert.ok(bitrix.notif.length >= antes);   // não repete no mesmo marco
  await call('POST', `/rotulagem/negocios/${rot.id}/nota`, { texto: 'retomado' }); assert.equal((await call('GET', '/gestao')).parados.length, 0);   // qualquer atividade tira da lista de parados
  // sugestão: quem tem menos carga entre quem atua no processo
  const sg = await call('GET', '/gestao/sugestao?processo=multas'); assert.deepEqual(sg.map(x => x.id), ['11']); assert.equal((await call('GET', '/gestao/sugestao?processo=suplementos'))[0].id, '10');
  // novos processos: fichas técnicas e tabela avulsa
  const fi = await call('POST', '/fichas/negocios', { titulo: 'Ficha — molho', empresaId: '5' }); assert.equal(fi.etapa, 'f1'); assert.equal(fi.documentos.length, 4); const tb = await call('POST', '/tabelas/negocios', { titulo: 'Tabela — pão', empresaId: '5' }); assert.equal(tb.comCalculadora, true); assert.equal(tb.dupla, 'Entrega ao cliente');
  await assert.rejects(call('POST', `/tabelas/negocios/${tb.id}/mover`, { etapa: 't3' }), /Como os valores nutricionais/);
  assert.equal((await call('POST', '/tabelas/calculadora', { negocioId: tb.id, base: 'solido', porcao: '30', v100: { carbo: '10' } })).linhas.length, 1);
  // questionário por processo (link guardado em Gestão)
  await assert.rejects(call('PUT', '/gestao/config', { questionarios: { fichas: 'javascript:x' } }), /Link inválido/); await call('PUT', '/gestao/config', { questionarios: { fichas: 'https://forms.example/ficha' } }); assert.equal((await call('GET', `/fichas/negocios/${fi.id}`)).questionarioUrl, 'https://forms.example/ficha');
  // fechamento comercial: negócio ganho vira cartão + cobrança de 50%; simulação não cria nada; sem classificação fica de fora
  await call('PUT', '/config', { empresaFaturaId: 'e1' });
  bitrix.deals.push({ ID: '71', CATEGORY_ID: 0, TITLE: 'Rotulagem — Padaria Sol', STAGE_ID: 'C0:WON', COMPANY_ID: '5', ASSIGNED_BY_ID: '11', OPPORTUNITY: '1200' }, { ID: '72', CATEGORY_ID: 0, TITLE: 'Consultoria mensal', STAGE_ID: 'C0:WON', COMPANY_ID: '5' }, { ID: '73', CATEGORY_ID: 0, TITLE: 'Suplemento Whey', STAGE_ID: 'C0:NEW', COMPANY_ID: '5' });
  const sim = await call('POST', '/fechamento/processar', {}); assert.equal(sim.simulacao, true); assert.deepEqual(sim.criados.map(x => [x.negocioComercial, x.processo, x.valor]), [['71', 'rotulagem', 1200]]); assert.deepEqual(sim.semClassificar.map(x => x.id), ['72']); assert.equal(Object.keys(api.dados().fechados).length, 0);
  const real = await call('POST', '/fechamento/processar', { simular: false }); assert.equal(real.criados[0].cobrado, true); assert.equal(fin.receber.all().filter(x => x.demandaProcesso === 'rotulagem' && /BK Anhaia/.test(x.descricao)).length, 2);
  assert.equal((await call('POST', '/fechamento/processar', { simular: false })).criados.length, 0);   // não duplica
  const novo = await call('GET', `/rotulagem/negocios/${real.criados[0].id}`); assert.equal(novo.origem, 'comercial'); assert.equal(novo.empresaId, '5');
});

test('formulário do site cria o cartão com as respostas; dossiê de aprovação tem selo de integridade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-')), bitrix = fake(), api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => [] }, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  await assert.rejects(api.entradaFormulario({ processo: 'rotulagem' }, 'x'), /não foi ativada/);
  const { token } = await call('POST', '/formulario/entrada/token'); await assert.rejects(api.entradaFormulario({ processo: 'rotulagem' }, 'errado'), /Token inválido/); await assert.rejects(api.entradaFormulario({ processo: 'bk' }, token), /Processo inválido/);
  const r = await api.entradaFormulario({ processo: 'rotulagem', messageId: 'a1', empresa: { nome: 'Padaria Sol', cnpj: '11.222.333/0001-81', email: 'a@b.com' }, respostas: { 'Nome do Produto': 'Pão de queijo', 'Ingredientes e quantidades (g)': 'Polvilho 500 g', 'Contaminação cruzada com glúten?': 'Não', 'Cor da embalagem': 'azul' } }, token);
  const c = await call('GET', `/rotulagem/negocios/${r.id}`); assert.equal(c.titulo, 'Pão de queijo — Padaria Sol'); assert.equal(c.dadosIa['nome do produto'], 'Pão de queijo'); assert.equal(c.dadosIa['contaminação cruzada com glúten?'], 'Não'); assert.match(c.comentarios, /cor da embalagem: azul/); assert.match(c.comentarios, /Empresa não encontrada/); assert.equal(c.origem, 'formulario');
  assert.equal((await api.entradaFormulario({ processo: 'rotulagem', messageId: 'a1' }, token)).duplicado, true);
  await call('POST', `/rotulagem/negocios/${r.id}/aprovacao`, { decisao: 'aprovado', nota: 'ok' }, { id: 'u1', nome: 'Ana' }); await call('POST', `/rotulagem/negocios/${r.id}/rodada`, { resultado: 'ok' }, { id: 'u1', nome: 'Ana' });
  const ds = await call('GET', `/rotulagem/negocios/${r.id}/dossie`); assert.match(ds.selo, /^[0-9a-f]{64}$/); assert.equal(ds.aprovacoes[0].nome, 'Ana'); assert.equal(ds.rodadas.length, 1); assert.ok(ds.historico.length >= 2);
  const ds2 = await call('GET', `/rotulagem/negocios/${r.id}/dossie`); assert.equal(ds2.selo, ds.selo);   // mesmo conteúdo, mesmo selo
  await call('POST', `/rotulagem/negocios/${r.id}/nota`, { texto: 'nova' }); assert.notEqual((await call('GET', `/rotulagem/negocios/${r.id}/dossie`)).selo, ds.selo);
});

test('biblioteca de modelos de manuais: filtros, importação da planilha, aplicar ao cartão e aviso de norma que entra em vigor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-')), bitrix = fake(), api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => [] }, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  await assert.rejects(call('POST', '/manuais/modelos', { titulo: 'x' }), /título/); await assert.rejects(call('POST', '/manuais/modelos', { titulo: 'Manual padaria', uf: 'São Paulo' }), /sigla/); await assert.rejects(call('POST', '/manuais/modelos', { titulo: 'Manual padaria', link: 'javascript:1' }), /Link inválido/);
  const em = F.somaDias(R.todayBR(), 5);
  const imp = await call('POST', '/manuais/modelos/importar', { texto: `Título;Segmento;Atividade;UF;Município;Legislação;Link;Versão;Entra em vigor\nManual de boas práticas — padaria;Padaria;Panificação;SP;São Paulo;Portaria SMS 2619/2011;https://drive.google.com/a;v3;\nManual — restaurante de sushi;Restaurante;Comida japonesa;SP;;Nova CVS (em vigor);https://drive.google.com/b;v1;${em}\nManual indústria;Indústria;Alimentos industrializados;;;RDC 275/2002;https://drive.google.com/c;v2;\nRuim;Teste;;;;;javascript:x;;` });
  assert.equal(imp.novos, 3); assert.equal(imp.erros.length, 1); assert.match(imp.erros[0], /Linha 5/);
  assert.equal((await call('POST', '/manuais/modelos/importar', { texto: `Título;Segmento;UF;Versão\nManual indústria;Indústria;;v9` })).atualizados, 1);   // mesmo título/segmento/UF atualiza em vez de duplicar
  const todos = await call('GET', '/manuais/modelos'); assert.equal(todos.total, 3); assert.deepEqual(todos.segmentos, ['Indústria', 'Padaria', 'Restaurante']);
  assert.equal((await call('GET', '/manuais/modelos?segmento=padaria')).modelos.length, 1); assert.equal((await call('GET', '/manuais/modelos?q=sushi')).modelos[0].emVigorEm, 5); assert.equal((await call('GET', '/manuais/modelos?uf=RJ')).modelos.length, 1);   // sem UF vale para todo o país
  const m = todos.modelos.find(x => /padaria/.test(x.titulo)), n = await call('POST', '/manuais/negocios', { titulo: 'Manual — Padaria Sol', empresaId: '5' });
  const a = await call('POST', `/manuais/negocios/${n.id}/modelo`, { modeloId: m.id }); assert.ok(a.links.some(l => /Modelo base: Manual de boas práticas — padaria/.test(l.nome))); assert.equal(a.modeloBase.legislacao, 'Portaria SMS 2619/2011');
  await call('PUT', '/gestao/config', { gestorIds: ['10'] }); const av = await call('POST', '/avisar', { simular: false }); assert.ok(av.enviados.some(e => /Entra em vigor em 5 dia/.test(e.msg))); assert.ok(bitrix.notif.some(x => x.USER_ID === '10' && /Nova CVS/.test(x.MESSAGE)));
  assert.equal((await call('POST', '/avisar', { simular: false })).enviados.filter(e => /Entra em vigor/.test(e.msg)).length, 0);   // não repete o mesmo marco
});

test('qualidade do cadastro: lista o que falta e os duplicados por CNPJ e por nome', async () => {
  const { createCarteiraApi } = require('../lib/carteiraApi'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-'));
  const emp = [{ id: '1', nome: 'TR Fit', cnpj: '11222333000181', cidade: 'Santos', uf: 'SP', razao: 'TR Fit Ltda', responsavel: '10', email: 'a@a.com' }, { id: '2', nome: 'TR FIT', cnpj: '11222333000181', cidade: '', uf: '', razao: '', responsavel: '', email: '' }, { id: '3', nome: 'Sem Dados', cnpj: '', cidade: '', uf: '', razao: '', responsavel: '', email: '' }];
  const api = createCarteiraApi({ bitrix: { enabled: true, async call() { return { result: [] }; } }, bx: { listar: async () => emp, host: () => 'p.bitrix24.com.br', completar: async () => 0 }, funil: { negocios: async () => [], estagios: async () => [], camposNegocio: async () => ({}) }, store: { log() {} }, dir, cnpjApi: { cnpjValido: c => c === '11222333000181' } });
  const q = (await api.handle('GET', '/api/car/qualidade', new URL('http://x/api/car/qualidade'), async () => ({}), { perfil: 'admin' })).json;
  assert.equal(q.total, 3); assert.equal(q.resumo.semCnpj, 1); assert.equal(q.resumo.duplicados, 2); assert.deepEqual(q.duplicados.map(g => g.motivo).sort(), ['mesmo CNPJ', 'mesmo nome']); assert.deepEqual(q.itens.map(i => i.id), ['2', '3']); assert.ok(q.itens[1].problemas.includes('sem CNPJ'));
});

test('suplementos: formulação, memorial de cálculo com %VD do Anexo VIII, limites cadastrados, ordem de produção e artigos do dossiê', async () => {
  const S = require('../lib/suplementosCalc'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')), bitrix = fake(), api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => [] }, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  assert.equal(S.VDR.length, 42); assert.equal(S.achaVdr('Vitamina B12')[0], 'Vitamina B12'); assert.equal(S.achaVdr('vitamina b1')[0], 'Tiamina'); assert.equal(S.achaVdr('Cafeína'), null);
  const n = await call('POST', '/suplementos/negocios', { titulo: 'Suplemento Mix', empresaId: '5' });
  await assert.rejects(call('PUT', `/suplementos/negocios/${n.id}/formulacao`, { grupo: 'xx', itens: [] }), /grupo populacional/); await assert.rejects(call('POST', `/suplementos/negocios/${n.id}/memorial`), /Preencha e salve/);
  await call('PUT', `/suplementos/negocios/${n.id}/formulacao`, { grupo: '19a', capsulasPorDose: '2', dosesPorDia: '1', capacidadeCapsulaMg: '500', lote: '1000', itens: [{ materiaPrima: 'Ácido ascórbico 99%', ativo: 'Vitamina C', un: 'mg', qtd: '100', teor: '99' }, { materiaPrima: 'Zinco quelato', ativo: 'Zinco', un: 'mg', qtd: '5', teor: '20' }, { materiaPrima: 'Celulose', massaMg: '150' }, { materiaPrima: 'Cafeína', ativo: 'Cafeína', un: 'mg', qtd: '100' }] });
  await assert.rejects(call('PUT', '/suplementos/limites', { ativo: 'Zinco', un: 'mg' }), /mínimo e\/ou o máximo/); await call('PUT', '/suplementos/limites', { ativo: 'Zinco', max: '8', un: 'mg', ref: 'norma de suplementos' });
  const r = await call('POST', `/suplementos/negocios/${n.id}/memorial`, {}, { nome: 'Ana' }); const m = r.memorial;
  assert.match(m.texto, /Vitamina C .*100 mg\/cápsula → 200 mg\/dose → 200 mg\/dia · %VD da dose: 200% \(VDR 100 mg\)/); assert.match(m.texto, /Zinco .*%VD da dose: 90,9%.*limite NÃO atendido/); assert.match(m.texto, /ORDEM DE PRODUÇÃO — lote de 1000 cápsulas/); assert.match(m.texto, /Ácido ascórbico 99% : ?101,01 g|Ácido ascórbico 99%: 101,01 g/);
  assert.ok(m.alertas.some(a => /Zinco: 10 mg\/dia fora do limite/.test(a))); assert.ok(m.alertas.some(a => /Cafeína: sem VDR no Anexo VIII/.test(a))); assert.equal(m.linhas.find(l => l.ativo === 'Vitamina C').vd, 200);
  const peq = S.memorial({ grupo: '19a', capsulasPorDose: 1, dosesPorDia: 1, capacidadeCapsulaMg: 100, itens: [{ materiaPrima: 'X', massaMg: '150' }] }); assert.ok(peq.alertas.some(a => /maior que a capacidade/.test(a)));
  assert.equal(S.memorial({ grupo: '1-3a', itens: [{ ativo: 'Potássio', un: 'g', qtd: '0.35', materiaPrima: 'KCl' }] }).linhas[0].vd, 11.7);   // 350 mg / 3.000 mg; conversão g → mg
  const a = await call('POST', '/suplementos/artigos', { ingrediente: 'Zinco', titulo: 'Zinc and immunity', link: 'https://pubmed.example/1', ano: '2020' }); await assert.rejects(call('POST', '/suplementos/artigos', { ingrediente: 'X', titulo: 'y', link: 'javascript:1' }), /Link inválido/);
  assert.equal((await call('GET', '/suplementos/artigos?q=imunity')).artigos.length, 0); assert.equal((await call('GET', '/suplementos/artigos?q=zinc')).artigos.length, 1);
  await call('POST', `/suplementos/negocios/${n.id}/artigo`, { artigoId: a.id }); assert.equal((await call('GET', `/suplementos/negocios/${n.id}`)).artigosDossie.length, 1);
  const ds = await call('GET', `/suplementos/negocios/${n.id}/dossie`); assert.match(ds.memorial.texto, /MEMORIAL DE CÁLCULO/); assert.equal(ds.artigos[0].titulo, 'Zinc and immunity');
});

test('formulário do Bitrix24: o negócio criado pelo formulário no funil Serviços técnicos vira cartão com o questionário, sem duplicar o negócio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), bitrix = fake(), api = createDemandasApi({ bitrix, bx: createBxEmpresas({ bitrix }), funil: createBxFunil({ bitrix }), bk: { unidades: () => [] }, store: { log() {} }, dir });
  const call = async (m, p, b, user) => { const u = new URL('http://x/api/dem' + p); return (await api.handle(m, u.pathname, u, async () => b || {}, user)).json; };
  bitrix.deals.push({ ID: '201', CATEGORY_ID: 12, TITLE: 'Rotulagem — Padaria Sol', STAGE_ID: 'C12:A', COMPANY_ID: '5', ASSIGNED_BY_ID: '11', COMMENTS: 'veio do formulário', UF_PROD: 'Pão de queijo', UF_ING: 'Polvilho 500 g, queijo 200 g', UF_GLU: '2' },
    { ID: '202', CATEGORY_ID: 12, TITLE: 'Contato qualquer', STAGE_ID: 'C12:A', COMMENTS: '' }, { ID: '203', CATEGORY_ID: 12, TITLE: '[Rotulagem] criado pelo app', STAGE_ID: 'C12:A', COMMENTS: 'Gerido no app Nutrimix (Rotulagem nutricional, cartão R9).' });
  const sim = await call('POST', '/formulario/importar', {}); assert.equal(sim.simulacao, true); assert.deepEqual(sim.criados.map(x => [x.negocioBitrix, x.processo, x.respostas]), [['201', 'rotulagem', 3]]); assert.deepEqual(sim.semClassificar.map(x => x.id), ['202']); assert.equal(Object.keys(api.dados().importados).length, 0);
  const n0 = bitrix.deals.length, real = await call('POST', '/formulario/importar', { simular: false }); assert.equal(real.criados.length, 1); assert.equal(bitrix.deals.length, n0);   // não cria outro negócio no Bitrix24
  const c = await call('GET', `/rotulagem/negocios/${real.criados[0].id}`); assert.equal(c.titulo, 'Rotulagem — Padaria Sol'); assert.equal(c.empresaId, '5'); assert.equal(c.responsavel, '11'); assert.equal(c.dadosIa['nome do produto'], 'Pão de queijo'); assert.equal(c.dadosIa['contaminação cruzada com glúten?'], 'Não'); assert.equal(c.origem, 'formulario-bitrix'); assert.equal(c.comentarios, 'veio do formulário');
  const dl = bitrix.deals.find(x => x.ID === '201'); assert.equal(dl.STAGE_ID, 'C12:B'); assert.equal(dl.COMMENTS, 'veio do formulário'); assert.equal(dl.TITLE, 'Rotulagem — Padaria Sol');   // espelho atualiza a etapa; não apaga o texto do cliente
  await call('POST', `/rotulagem/negocios/${c.id}/mover`, { etapa: 'r2' }); assert.equal(bitrix.deals.find(x => x.ID === '201').STAGE_ID, 'C12:A');
  assert.equal((await call('POST', '/formulario/importar', { simular: false })).criados.length, 0);   // não importa duas vezes
  assert.ok(Array.isArray((await call('GET', `/rotulagem/negocios/${c.id}/respostas`)).respostas));
  assert.equal((await call('PUT', '/gestao/config', { importarFormularios: false })).importarFormularios, false);
});
