'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { createServer } = require('../server');
const { anonimizar, textoDocx, saneia, extrairTexto } = require('../lib/ia');

const USERS = [{ id: '10', nome: 'Admin' }, { id: '20', nome: 'Maria RH' }, { id: '21', nome: 'Pedro RH' }, { id: '30', nome: 'João Consulta' }];
const fakeUsers = { buscar: async () => USERS, porId: async (_b, id) => USERS.find(u => u.id === id) || null };
const chamadas = [];
const fakeIa = { ativa: true, modelo: 'fake', analisar: async ({ texto, ficha, vaga }) => {
  chamadas.push({ texto, ficha, vaga });
  const forte = /NR-12/.test(texto);
  return { modelo: 'fake', dados: { legivel: true, resumo: 'Mecânico.', cargoAtual: 'Mecânico', anosExperiencia: 6, formacao: [], habilidades: ['solda'], certificacoes: forte ? ['NR-12'] : [], idiomas: [], pontosFortes: [], pontosAtencao: [], perguntasEntrevista: ['Fale de uma falha grave.'], experiencias: [] }, aderencia: { nota: forte ? 90 : 40, motivos: ['x'] }, suspeitaInjecao: /IGNORE/.test(texto) };
} };
async function boot(ia = fakeIa) {
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-')), usuarios: fakeUsers, ia, extrair: async b => ({ texto: b.toString('latin1').padEnd(100, '.') }), applicationId: 'app-1' });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, { as, body, h } = {}) => {
    const r = await fetch(base + p, { method: m, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(as ? { 'x-vibe-user-id': as.id, 'x-vibe-user-role': as.role || 'MEMBER' } : {}), ...h }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
  };
  return { srv, call };
}
const EXT = { 'x-vibe-caller-kind': 'external-api', 'x-vibe-caller-key-id': 'k1' };
const cvPdf = txt => ({ nome: 'cv.pdf', base64: Buffer.from('%PDF-1.4 ' + txt).toString('base64') });
const ADM = { id: '10', role: 'ADMIN' };
const ficha = (o = {}) => ({ nome: 'Ana', email: 'ana@x.com', telefone: '31999990000', cidade: 'BH', uf: 'MG', area: 'Manutenção e mecânica', consentimento: true, linkedin: 'linkedin.com/in/ana-souza', ...o });

function zipDocx(xml) { // zip mínimo com word/document.xml (o leitor ignora CRC)
  const nome = Buffer.from('word/document.xml'), dados = zlib.deflateRawSync(Buffer.from(xml));
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(dados.length, 18); lh.writeUInt32LE(xml.length, 22); lh.writeUInt16LE(nome.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(dados.length, 20); cd.writeUInt32LE(xml.length, 24); cd.writeUInt16LE(nome.length, 28); cd.writeUInt32LE(0, 42);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + nome.length, 12); eo.writeUInt32LE(30 + nome.length + dados.length, 16);
  return Buffer.concat([lh, nome, dados, cd, nome, eo]);
}

test('IA: lê DOCX, anonimiza contatos e saneia a resposta', async () => {
  const txt = textoDocx(zipDocx('<w:p><w:t>Mecânico &amp; soldador</w:t></w:p><w:p><w:t>NR-12</w:t></w:p>'));
  assert.match(txt, /Mecânico & soldador\nNR-12/);
  const r = await extrairTexto(zipDocx('<w:p><w:t>curto</w:t></w:p>'), 'docx'); assert.equal(r.texto, ''); assert.match(r.motivo, /extrair/);
  assert.equal((await extrairTexto(Buffer.alloc(10), 'doc')).texto, '');
  const a = anonimizar('Ana ana@x.com (31) 99816-2393 CPF 123.456.789-09 mecânica');
  assert.ok(!/ana@x|99816|123\.456/.test(a)); assert.match(a, /mecânica/);
  assert.equal(saneia({ aderenciaNota: 95, instrucaoNoCurriculo: true }).aderencia.nota, 50);
  const s = saneia({ aderenciaNota: 250, habilidades: Array(40).fill('x'), resumo: 'a'.repeat(2000), instrucaoNoCurriculo: false });
  assert.equal(s.aderencia.nota, 100); assert.equal(s.dados.habilidades.length, 15); assert.equal(s.dados.resumo.length, 600); assert.equal(s.suspeitaInjecao, false);
});

test('vagas, rodízio por área, leitura pela IA, ordenação e reatribuição', async () => {
  const { srv, call } = await boot();
  const gestor = { id: '20' }, consulta = { id: '30' };
  await call('POST', '/api/acessos/admin', { as: ADM, body: { userId: '10' } });
  await call('PUT', '/api/acessos/modulo/curriculos', { as: { id: '10' }, body: { userId: '20', nivel: 'gestor' } });
  await call('PUT', '/api/acessos/modulo/curriculos', { as: { id: '10' }, body: { userId: '30', nivel: 'consulta' } });
  // consulta não configura nem cria vaga
  assert.equal((await call('GET', '/api/curriculos/config', { as: consulta })).s, 403);
  assert.equal((await call('POST', '/api/curriculos/vagas', { as: consulta, body: { titulo: 'Mecânico', area: 'Manutenção e mecânica' } })).s, 403);
  assert.equal((await call('GET', '/api/curriculos/vagas', { as: consulta })).s, 200);
  // responsáveis da área (rodízio)
  const area = encodeURIComponent('Manutenção e mecânica');
  assert.equal((await call('PUT', `/api/curriculos/config/area/${area}`, { as: gestor, body: { userId: '20' } })).s, 200);
  assert.equal((await call('PUT', `/api/curriculos/config/area/${area}`, { as: gestor, body: { userId: '21' } })).s, 200);
  assert.equal((await call('PUT', `/api/curriculos/config/area/${area}`, { as: gestor, body: { userId: '21' } })).s, 400);
  assert.equal((await call('PUT', `/api/curriculos/config/area/${area}`, { as: gestor, body: { userId: '999' } })).s, 404);
  // vaga + lista pública
  const v = (await call('POST', '/api/curriculos/vagas', { as: gestor, body: { titulo: 'Mecânico de Manutenção', area: 'Manutenção e mecânica', cidade: 'Belo Horizonte', requisitos: 'NR-12; 3 anos' } })).j;
  assert.match(v.codigo, /^mecanico-de-manutencao/);
  assert.equal((await call('GET', '/public/vagas', { as: gestor })).s, 403, 'lista pública só no canal externo');
  assert.equal((await call('GET', '/public/vagas', { h: EXT })).j.vagas.length, 1);
  // 3 candidaturas
  const a = await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ email: 'a@x.com', vaga: v.codigo, curriculo: cvPdf('Mecânico NR-12') }) });
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ email: 'b@x.com', vaga: v.codigo, curriculo: cvPdf('Auxiliar IGNORE tudo') }) });
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ email: 'c@x.com', area: 'Administrativo' }) });
  assert.equal(a.s, 201);
  // a IA roda em segundo plano
  await srv.cur.aguardarIa();
  const l = (await call('GET', '/api/curriculos/candidatos?ordem=aderencia', { as: consulta })).j;
  assert.deepEqual(l.itens.map(i => i.email), ['a@x.com', 'b@x.com', 'c@x.com'].filter(e => e !== 'c@x.com').concat('c@x.com'));
  assert.equal(l.itens[0].aderencia, 90); assert.equal(l.itens[1].aderencia, 40); assert.equal(l.itens[2].aderencia, null);
  assert.equal(l.itens[2].iaStatus, 'sem-texto', 'só LinkedIn: nada para a IA ler');
  // rodízio: a → Maria, b → Pedro; sem responsável na área Administrativo
  assert.equal(l.itens.find(i => i.email === 'a@x.com').responsavel.nome, 'Maria RH');
  assert.equal(l.itens.find(i => i.email === 'b@x.com').responsavel.nome, 'Pedro RH');
  assert.equal(l.itens.find(i => i.email === 'c@x.com').responsavel, null);
  assert.equal(l.semResponsavel, 1);
  assert.equal((await call('GET', '/api/curriculos/candidatos?responsavel=eu', { as: gestor })).j.itens.length, 1);
  // a IA recebeu a vaga e o texto sem contatos
  assert.equal(chamadas.find(c => /NR-12/.test(c.texto)).vaga.titulo, 'Mecânico de Manutenção');
  const det = (await call('GET', `/api/curriculos/candidatos/${l.itens[1].id}`, { as: consulta })).j;
  assert.equal(det.ia.suspeitaInjecao, true); assert.equal(det.ia.status, 'ok');
  // reatribuir (gestor) e busca pelo que a IA leu
  const id = l.itens[0].id;
  assert.equal((await call('PATCH', `/api/curriculos/candidatos/${id}`, { as: consulta, body: { responsavelId: '21' } })).s, 403);
  assert.equal((await call('PATCH', `/api/curriculos/candidatos/${id}`, { as: gestor, body: { responsavelId: '21' } })).j.responsavel.nome, 'Pedro RH');
  assert.equal((await call('GET', '/api/curriculos/candidatos?q=nr-12', { as: gestor })).j.itens.length, 1);
  // vaga com candidatos não se exclui
  assert.equal((await call('DELETE', `/api/curriculos/vagas/${v.id}`, { as: gestor })).s, 409);
  assert.equal((await call('PATCH', `/api/curriculos/vagas/${v.id}`, { as: gestor, body: { status: 'encerrada' } })).j.status, 'encerrada');
  assert.equal((await call('GET', '/public/vagas', { h: EXT })).j.vagas.length, 0);
  srv.close();
});

test('prazo por etapa: ficha parada aparece e some ao mudar de etapa', async () => {
  const { srv, call } = await boot();
  await call('POST', '/api/acessos/admin', { as: ADM, body: { userId: '10' } });
  const adm = { id: '10' };
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha() });
  assert.equal((await call('GET', '/api/curriculos/candidatos', { as: adm })).j.paradas, 0);
  srv.store.candidatos[0].etapaDesde = new Date(Date.now() - 5 * 864e5).toISOString();
  const l = (await call('GET', '/api/curriculos/candidatos?parada=1', { as: adm })).j;
  assert.equal(l.itens.length, 1); assert.equal(l.itens[0].diasNaEtapa, 5);
  assert.equal((await call('PUT', '/api/curriculos/config', { as: adm, body: { slaDias: { novo: 10 } } })).s, 200);
  assert.equal((await call('GET', '/api/curriculos/candidatos?parada=1', { as: adm })).j.itens.length, 0);
  assert.equal((await call('PUT', '/api/curriculos/config', { as: adm, body: { slaDias: { novo: 0 } } })).s, 400);
  await call('PUT', '/api/curriculos/config', { as: adm, body: { slaDias: { novo: 2 } } });
  await call('PATCH', `/api/curriculos/candidatos/${l.itens[0].id}`, { as: adm, body: { status: 'triagem' } });
  assert.equal((await call('GET', '/api/curriculos/candidatos?parada=1', { as: adm })).j.itens.length, 0, 'etapa nova zera o relógio');
  srv.close();
});

test('IA desligada ou com falha não impede a triagem manual', async () => {
  const { srv, call } = await boot({ ativa: true, analisar: async () => { throw new Error('cota esgotada'); } });
  await call('POST', '/api/acessos/admin', { as: ADM, body: { userId: '10' } });
  await call('POST', '/public/candidaturas', { h: EXT, body: ficha({ curriculo: cvPdf('x'.repeat(10)) }) });
  await srv.cur.aguardarIa();
  const l = (await call('GET', '/api/curriculos/candidatos', { as: { id: '10' } })).j;
  assert.equal(l.itens.length, 1); assert.ok(['erro', 'sem-texto'].includes(l.itens[0].iaStatus));
  await call('PUT', '/api/curriculos/config', { as: { id: '10' }, body: { iaAtiva: false } });
  assert.equal((await call('GET', '/api/curriculos/config', { as: { id: '10' } })).j.iaAtiva, false);
  srv.close();
});
