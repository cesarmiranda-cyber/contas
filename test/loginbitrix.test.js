'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createAuth, hashSenha } = require('../lib/auth');
const { createBitrixLogin } = require('../lib/bitrixLogin');
const { createSecrets } = require('../lib/secrets');

async function cenario(env = {}) {
  let t = 1e12; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-')), notif = [], logs = [];
  const auth = createAuth({ dir, env: { ADMIN_USER: 'adm', ADMIN_HASH: await hashSenha('Inicial12345'), ...env }, agora: () => t, log: (a, m) => logs.push(m) });
  const bitrix = { enabled: true, base: 'https://p.bitrix24.com.br/rest/1/x', notif, async call(m, p) {
    if (m === 'user.get') return { result: [{ ID: '10', NAME: 'Cesar', LAST_NAME: 'M', EMAIL: 'cesar@manda4.com.br' }, { ID: '12', NAME: 'Cris', LAST_NAME: 'B', EMAIL: 'cris@nutrimix.com.br' }].filter(u => u.EMAIL === p.FILTER.EMAIL) };
    if (m === 'im.notify.personal.add') { notif.push(p); return { result: 1 }; } return { result: true }; } };
  const bx = createBitrixLogin({ bitrix, secrets: createSecrets(dir), auth, agora: () => t, log: (a, m) => logs.push(m) });
  return { auth, bx, bitrix, notif, logs, avanca: ms => { t += ms; } };
}
const cod = n => /código de acesso ao Nutrimix: (\d{6})/.exec(n.MESSAGE)[1];

test('administradores iniciais pelo Bitrix24 (ADMIN_BITRIX_IDS) entram sem senha e herdam nome e e-mail', async () => {
  const { auth, bx, notif } = await cenario({ ADMIN_BITRIX_IDS: '10' });
  assert.equal(auth.acharPorBitrix('10').perfil, 'admin'); assert.equal(auth.acharPorBitrix('12'), null);
  await bx.pedirCodigo('cesar@manda4.com.br', '1.1.1.1'); const r = await bx.confirmarCodigo('cesar@manda4.com.br', cod(notif[0]), '1.1.1.1');
  assert.ok(auth.valida(r.token)); assert.equal(r.usuario.perfil, 'admin'); assert.equal(r.usuario.nome, 'Cesar M'); assert.equal(auth.acharPorBitrix('10').email, 'cesar@manda4.com.br'); assert.equal(auth.acharPorBitrix('10').porBitrix, true);
});

test('código no Bitrix24: só para liberados, uso único, 10 minutos, 5 tentativas e respostas que não revelam quem existe', async () => {
  const { auth, bx, notif, avanca } = await cenario({ ADMIN_BITRIX_IDS: '10' });
  const a = await bx.pedirCodigo('cris@nutrimix.com.br', '1.1.1.1'), b = await bx.pedirCodigo('ninguem@x.com', '1.1.1.1');   // 12 não foi liberada; o outro nem existe
  assert.deepEqual(a, b); assert.equal(notif.length, 0); await assert.rejects(bx.confirmarCodigo('cris@nutrimix.com.br', '123456', '1.1.1.1'), /inválido ou expirado/);
  auth.liberarBitrix({ bitrixId: '12', nome: 'Cris', perfil: 'operacional', areas: ['cronograma'] });
  await bx.pedirCodigo('cris@nutrimix.com.br', '2.2.2.2'); assert.equal(notif.length, 1); assert.equal(notif[0].USER_ID, '12'); const c = cod(notif[0]);
  await assert.rejects(bx.confirmarCodigo('cris@nutrimix.com.br', c === '000000' ? '111111' : '000000', '2.2.2.2'), /inválido/);
  const ok = await bx.confirmarCodigo('cris@nutrimix.com.br', c, '2.2.2.2'); assert.equal(ok.usuario.perfil, 'operacional'); await assert.rejects(bx.confirmarCodigo('cris@nutrimix.com.br', c, '2.2.2.2'), /inválido ou expirado/);   // uso único
  await bx.pedirCodigo('cris@nutrimix.com.br', '3.3.3.3'); const c2 = cod(notif[1]); avanca(11 * 60000); await assert.rejects(bx.confirmarCodigo('cris@nutrimix.com.br', c2, '3.3.3.3'), /inválido ou expirado/);   // venceu
  await bx.pedirCodigo('cris@nutrimix.com.br', '4.4.4.4'); const c3 = cod(notif[2]), errado = c3 === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await assert.rejects(bx.confirmarCodigo('cris@nutrimix.com.br', errado, '4.4.4.4'), /inválido/);
  await assert.rejects(bx.confirmarCodigo('cris@nutrimix.com.br', c3, '4.4.4.4'), /inválido ou expirado/);   // após 5 erros o código morre mesmo que o certo seja digitado
  await assert.rejects(bx.pedirCodigo('mal-formado', '5.5.5.5'), /e-mail/); auth.liberarBitrix; 
});

test('código no Bitrix24: limites por e-mail e por IP, usuário desativado e Bitrix fora do ar', async () => {
  const { auth, bx, notif, bitrix } = await cenario({ ADMIN_BITRIX_IDS: '10' });
  for (let i = 0; i < 6; i++) await bx.pedirCodigo('cesar@manda4.com.br', '1.1.1.' + i); assert.equal(notif.length, 4);   // a partir do 5º pedido nada é enviado, sem revelar
  let n = 0; await assert.rejects(async () => { for (let i = 0; i < 12; i++) { n++; await bx.pedirCodigo(`x${i}@x.com`, '9.9.9.9'); } }, /Muitas tentativas/); assert.ok(n <= 11);
  const d = await cenario({ ADMIN_BITRIX_IDS: '10' }); const adm = d.auth.listar().find(u => u.perfil === 'admin');
  d.auth.liberarBitrix({ bitrixId: '12', nome: 'Cris', perfil: 'consulta', areas: [] }); const u12 = d.auth.listar().find(u => u.bitrixId === '12'); await d.auth.atualizar(u12.id, { ativo: false }, adm);
  await d.bx.pedirCodigo('cris@nutrimix.com.br', '7.7.7.7'); assert.equal(d.notif.length, 0);   // desativado não recebe código
  bitrix.enabled = false; await assert.rejects(bx.pedirCodigo('cesar@manda4.com.br', '8.8.8.8'), /não está conectado/);
});

test('entrada automática dentro do Bitrix24 (SDK): só do portal autorizado, token válido e com limite por IP', async () => {
  const { bx } = await cenario({ ADMIN_BITRIX_IDS: '10' });
  await assert.rejects(bx.porSdk({ AUTH_ID: 'a'.repeat(32), DOMAIN: 'outro.bitrix24.com' }, '1.1.1.1'), /não é o autorizado/);
  await assert.rejects(bx.porSdk({ AUTH_ID: 'curto', DOMAIN: 'p.bitrix24.com.br' }, '1.1.1.1'), /Token do Bitrix24 inválido/);
  await assert.rejects(bx.porSdk({ AUTH_ID: 'x y', DOMAIN: 'p.bitrix24.com.br' }, '1.1.1.1'), /inválido/);
  for (let i = 0; i < 40; i++) await bx.porSdk({ AUTH_ID: 'curto', DOMAIN: 'p.bitrix24.com.br' }, '9.9.9.9').catch(() => {});
  await assert.rejects(bx.porSdk({ AUTH_ID: 'curto', DOMAIN: 'p.bitrix24.com.br' }, '9.9.9.9'), /Muitas tentativas/);
});

test('Vibe+ (Gateway): usuário vem do cabeçalho do Gateway; só com confiança habilitada, id numérico e liberado', async () => {
  const { bx, auth } = await cenario({ ADMIN_BITRIX_IDS: '10' }); const ok = { id: '10', nome: 'Cesar M', requestId: 'req_0123456789abcdef' };
  await assert.rejects(bx.porGateway(ok, '1.1.1.1', false), /não está habilitada/);
  await assert.rejects(bx.porGateway({ ...ok, requestId: '' }, '1.1.1.1', true), /não passou pelo Gateway/);
  for (const id of ['net_5', 'share:abc', 'vibe:9', '10; drop', '']) await assert.rejects(bx.porGateway({ ...ok, id }, '1.1.1.1', true), /não identificou/);
  await assert.rejects(bx.porGateway({ ...ok, id: '99' }, '1.1.1.1', true), /ainda não tem acesso/);   // identificado, mas não liberado em Usuários e acessos
  const r = await bx.porGateway(ok, '1.1.1.1', true); assert.ok(auth.valida(r.token)); assert.equal(r.usuario.perfil, 'admin');
});
