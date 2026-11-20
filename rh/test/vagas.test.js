'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createServer } = require('../server');

const USERS = [{ id: '10', nome: 'Admin' }, { id: '20', nome: 'Maria RH' }, { id: '30', nome: 'João Consulta' }];
const fakeUsers = { buscar: async () => USERS, porId: async (_b, id) => USERS.find(u => u.id === id) || null };
const EXT = { 'x-vibe-caller-kind': 'external-api', 'x-vibe-caller-key-id': 'k1' };
const dia = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
async function boot() {
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-')), usuarios: fakeUsers, ia: { ativa: false }, applicationId: 'app-1' });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, { as, body, h } = {}) => {
    const r = await fetch(base + p, { method: m, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(as ? { 'x-vibe-user-id': as.id } : {}), ...h }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
  };
  await call('POST', '/api/acessos/admin', { as: { id: '10' }, h: { 'x-vibe-user-role': 'ADMIN' }, body: { userId: '10' } });
  await call('PUT', '/api/acessos/modulo/curriculos', { as: { id: '10' }, body: { userId: '20', nivel: 'gestor' } });
  await call('PUT', '/api/acessos/modulo/curriculos', { as: { id: '10' }, body: { userId: '30', nivel: 'consulta' } });
  return { srv, call, G: { id: '20' }, Q: { id: '30' } };
}
const ficha = (n, vaga, o = {}) => ({ nome: 'Pessoa ' + n, email: `p${n}@x.com`, telefone: '31999990000', cidade: 'BH', uf: 'MG', area: 'Administrativo', consentimento: true, linkedin: 'linkedin.com/in/pessoa-' + n, vaga, ...o });
const DESC = 'Atendimento e rotinas administrativas da filial.';
async function novaVaga(call, G, extra = {}, publicar = true) {
  const v = (await call('POST', '/api/curriculos/vagas', { as: G, body: { titulo: 'Assistente Administrativo', area: 'Administrativo', descricao: DESC, ...extra } })).j;
  if (!publicar) return v;
  const r = await call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: G, body: { acao: 'publicar', encerraEm: dia(15), ...extra.pub } });
  assert.equal(r.s, 200, JSON.stringify(r.j)); return r.j;
}

test('publicar exige prazo e descrição; só gestor mexe; site vê apenas vaga aberta', async () => {
  const { srv, call, G, Q } = await boot();
  const v = await novaVaga(call, G, { descricao: 'curta' }, false);
  const pub = body => call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: G, body: { acao: 'publicar', ...body } });
  assert.equal((await pub({})).s, 400, 'sem prazo');
  assert.equal((await pub({ encerraEm: dia(10) })).s, 400, 'descrição curta');
  assert.equal((await pub({ descricao: DESC, encerraEm: dia(-1) })).s, 400, 'prazo no passado');
  assert.equal((await pub({ descricao: DESC, encerraEm: dia(200) })).s, 400, 'prazo longo demais');
  assert.equal((await call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: Q, body: { acao: 'publicar', descricao: DESC, encerraEm: dia(10) } })).s, 403);
  assert.equal((await call('GET', '/public/vagas', { h: EXT })).j.vagas.length, 0, 'rascunho não aparece');
  const ok = await pub({ descricao: DESC, encerraEm: dia(10), tipoContrato: 'CLT', faixaSalarial: 'R$ 2.500', mostrarSalario: false });
  assert.equal(ok.j.status, 'aberta');
  const lista = (await call('GET', '/public/vagas', { h: EXT })).j.vagas;
  assert.equal(lista.length, 1); assert.equal(lista[0].faixaSalarial, '', 'salário só aparece se o RH quiser'); assert.equal(lista[0].tipoContrato, 'CLT');
  const det = (await call('GET', `/public/vagas/${ok.j.codigo}`, { h: EXT })).j.vaga; assert.equal(det.descricao, DESC);
  assert.equal((await call('GET', `/public/vagas/${ok.j.codigo}`, { as: G })).s, 403, 'detalhe público só no canal externo');
  assert.equal((await call('PATCH', `/api/curriculos/vagas/${v.id}`, { as: G, body: { status: 'aberta' } })).s, 400, 'status só por ação');
  srv.close();
});

test('fecha sozinha ao atingir o limite; novas candidaturas são recusadas; reenvio continua valendo', async () => {
  const { srv, call, G } = await boot();
  const v = await novaVaga(call, G, { limiteCandidatos: 2 });
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha(1, v.codigo) })).s, 201);
  assert.deepEqual((await call('GET', '/api/curriculos/vagas', { as: G })).j.vagas[0].alertas, [], '1 de 2 ainda não alerta');
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha(2, v.codigo) })).s, 201);
  const f = (await call('GET', '/api/curriculos/vagas', { as: G })).j.vagas[0];
  assert.equal(f.status, 'encerrada'); assert.equal(f.encerradaMotivo, 'limite');
  const r = await call('POST', '/public/candidaturas', { h: EXT, body: ficha(3, v.codigo) });
  assert.equal(r.s, 422); assert.match(r.j.erros.vaga, /encerrada/);
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha(1, v.codigo, { cidade: 'Contagem' }) })).s, 201, 'quem já se candidatou pode atualizar a ficha');
  assert.equal((await call('GET', '/public/vagas', { h: EXT })).j.vagas.length, 0);
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha(4, 'vaga-que-nao-existe') })).s, 422);
  // reabrir exige corrigir o limite
  const reab = body => call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: G, body: { acao: 'reabrir', ...body } });
  assert.equal((await reab({})).s, 409);
  assert.equal((await reab({ limiteCandidatos: 5 })).j.status, 'aberta');
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha(3, v.codigo) })).s, 201);
  srv.close();
});

test('fecha sozinha por prazo, por posições preenchidas e abre por agendamento', async () => {
  const { srv, call, G } = await boot();
  const a = await novaVaga(call, G);
  srv.store.vagas.find(x => x.id === a.id).encerraEm = dia(-1);                       // prazo venceu ontem
  const l1 = (await call('GET', '/public/vagas', { h: EXT })).j.vagas; assert.equal(l1.length, 0);
  const va = (await call('GET', '/api/curriculos/vagas', { as: G })).j.vagas.find(x => x.id === a.id);
  assert.equal(va.status, 'encerrada'); assert.equal(va.encerradaMotivo, 'prazo');
  assert.equal((await call('POST', `/api/curriculos/vagas/${a.id}/acao`, { as: G, body: { acao: 'reabrir' } })).s, 400, 'reabrir exige novo prazo');
  assert.equal((await call('POST', `/api/curriculos/vagas/${a.id}/acao`, { as: G, body: { acao: 'reabrir', encerraEm: dia(20) } })).j.status, 'aberta');
  // prorrogar
  const pr = (await call('POST', `/api/curriculos/vagas/${a.id}/acao`, { as: G, body: { acao: 'prorrogar', dias: 10 } })).j; assert.equal(pr.encerraEm, dia(30));
  // posições: contratar fecha
  const b = await novaVaga(call, G, { posicoes: 1 });
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha(7, b.codigo) });
  const id = (await call('GET', `/api/curriculos/candidatos?vaga=${b.codigo}`, { as: G })).j.itens[0].id;
  await call('PATCH', `/api/curriculos/candidatos/${id}`, { as: G, body: { status: 'contratado' } });
  const vb = (await call('GET', '/api/curriculos/vagas', { as: G })).j.vagas.find(x => x.id === b.id);
  assert.equal(vb.status, 'encerrada'); assert.equal(vb.encerradaMotivo, 'preenchida');
  // agendada: só abre na data
  const c = await novaVaga(call, G, { titulo: 'Agendada', pub: { abreEm: dia(2), encerraEm: dia(20) } });
  assert.equal(c.status, 'agendada'); assert.ok(!(await call('GET', '/public/vagas', { h: EXT })).j.vagas.some(x => x.codigo === c.codigo));
  srv.store.vagas.find(x => x.id === c.id).abreEm = dia(0);
  assert.ok((await call('GET', '/public/vagas', { h: EXT })).j.vagas.some(x => x.codigo === c.codigo), 'abriu pela data');
  srv.close();
});

test('alertas: vence em breve e limite quase cheio', async () => {
  const { srv, call, G } = await boot();
  const v = await novaVaga(call, G, { limiteCandidatos: 5, pub: { encerraEm: dia(2) } });
  for (let i = 1; i <= 4; i++) await call('POST', '/public/candidaturas', { h: EXT, body: ficha(i, v.codigo) });
  const al = (await call('GET', '/api/curriculos/vagas', { as: G })).j.vagas[0].alertas;
  assert.ok(al.some(a => /Fecha em 2 dias/.test(a)) && al.some(a => /Limite quase cheio \(4\/5\)/.test(a)), JSON.stringify(al));
  srv.close();
});

test('pausar, finalizar fluxo e vaga antiga sem prazo (migração)', async () => {
  const { srv, call, G, Q } = await boot();
  const v = await novaVaga(call, G);
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha(1, v.codigo) });
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha(2, v.codigo) });
  assert.equal((await call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: G, body: { acao: 'pausar' } })).j.status, 'pausada');
  assert.equal((await call('POST', '/public/candidaturas', { h: EXT, body: ficha(3, v.codigo) })).s, 422);
  assert.equal((await call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: G, body: { acao: 'finalizar', destino: 'banco' } })).s, 409, 'só vaga encerrada');
  await call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: G, body: { acao: 'encerrar' } });
  assert.equal((await call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: Q, body: { acao: 'finalizar', destino: 'banco' } })).s, 403);
  const f = (await call('POST', `/api/curriculos/vagas/${v.id}/acao`, { as: G, body: { acao: 'finalizar', destino: 'banco' } })).j;
  assert.equal(f.movidos, 2);
  assert.equal((await call('GET', '/api/curriculos/candidatos?status=banco', { as: G })).j.itens.length, 2);
  // vaga "aberta" sem prazo (de versões anteriores) ganha prazo de 30 dias
  srv.store.setVagas([...srv.store.vagas, { id: 'old', codigo: 'antiga', titulo: 'Antiga', area: 'Administrativo', descricao: DESC, status: 'aberta', criadaEm: new Date().toISOString() }]);
  const antiga = (await call('GET', '/api/curriculos/vagas', { as: G })).j.vagas.find(x => x.id === 'old');
  assert.equal(antiga.encerraEm, dia(30)); assert.equal(antiga.status, 'aberta');
  srv.close();
});

test('candidatura de vaga do RH tem prioridade: marca, ordem e metade do prazo', async () => {
  const { srv, call, G } = await boot();
  const v = await novaVaga(call, G);
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha(1, undefined) });                  // espontânea (chegou antes)
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha(2, v.codigo) });                   // via vaga
  const l = (await call('GET', '/api/curriculos/candidatos', { as: G })).j;
  assert.deepEqual(l.itens.map(i => i.viaVaga), [true, false], 'vaga do RH vem primeiro');
  assert.equal(l.viaVaga, 1);
  assert.equal((await call('GET', '/api/curriculos/candidatos?origem=espontanea', { as: G })).j.itens.length, 1);
  assert.equal((await call('GET', '/api/curriculos/candidatos?origem=vaga', { as: G })).j.itens.length, 1);
  // 2 dias na etapa "novo": prazo padrão 2 → espontânea ainda no prazo; via vaga (prazo 1) está parada
  for (const c of srv.store.candidatos) c.etapaDesde = new Date(Date.now() - 2 * 864e5).toISOString();
  const p = (await call('GET', '/api/curriculos/candidatos?parada=1', { as: G })).j.itens;
  assert.deepEqual(p.map(i => i.viaVaga), [true]);
  srv.close();
});

test('dados de exemplo: criados uma vez, marcados e removíveis sem tocar nos reais', async () => {
  const { srv, call, G, Q } = await boot();
  assert.equal(await srv.cur.semearExemplos(), true);
  assert.equal(await srv.cur.semearExemplos(), false, 'não repete');
  await srv.cur.aguardarIa();
  const l = (await call('GET', '/api/curriculos/candidatos', { as: G })).j;
  assert.equal(l.total, 3); assert.equal(l.temExemplos, true); assert.equal(l.itens.filter(i => i.viaVaga).length, 2);
  const v = (await call('GET', '/public/vagas', { h: EXT })).j.vagas; assert.equal(v.length, 2); assert.ok(v.find(x => x.titulo === 'Mecânico de Manutenção').faixaSalarial);
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha(50, undefined) });                 // candidatura real
  assert.equal((await call('DELETE', '/api/curriculos/exemplos', { as: Q })).s, 403);
  const r = (await call('DELETE', '/api/curriculos/exemplos', { as: G })).j; assert.deepEqual(r, { candidatos: 3, vagas: 2 });
  const depois = (await call('GET', '/api/curriculos/candidatos', { as: G })).j; assert.equal(depois.total, 1); assert.equal(depois.temExemplos, false);
  assert.equal((await call('GET', '/public/vagas', { h: EXT })).j.vagas.length, 0);
  assert.equal(await srv.cur.semearExemplos(), false, 'não volta depois de removidos');
  srv.close();
});
