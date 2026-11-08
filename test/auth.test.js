'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createAuth, hashSenha, confere, validaSenha } = require('../lib/auth');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'au-'));
async function novo(opts = {}) {
  let t = 1e12; const logs = [];
  const hash = await hashSenha('Inicial12345');
  const auth = createAuth({ dir: tmp(), log: (a, m) => logs.push(m), agora: () => t, env: { ADMIN_USER: 'Admin', ADMIN_HASH: hash, ...opts.env } });
  return { auth, logs, avanca: ms => { t += ms; }, hash };
}
const req = (auth, token, method = 'GET', pathname = '/api/fin/bootstrap') => auth.porteiro({ method, pathname, headers: token ? { authorization: `Bearer ${token}` } : {} });

test('senhas: hash com sal, conferência e política', async () => {
  const h1 = await hashSenha('Senha-Forte-9'), h2 = await hashSenha('Senha-Forte-9');
  assert.notEqual(h1, h2); assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await confere('Senha-Forte-9', h1), true); assert.equal(await confere('senha-forte-9', h1), false); assert.equal(await confere('x', 'lixo'), false);
  assert.match(validaSenha('curta1'), /10 caracteres/); assert.match(validaSenha('somenteletras'), /letras e números/); assert.match(validaSenha('1234567890'), /letras e números/);
  assert.match(validaSenha('maria.silva2026', 'maria.silva'), /fácil/); assert.match(validaSenha('Nutrimix123'), /fácil/); assert.equal(validaSenha('Boa-Senha-2026'), null);
});

test('administrador inicial vem do ambiente (só o hash), exige troca de senha e sem ambiente ninguém entra', async () => {
  const { auth } = await novo();
  assert.equal(auth.listar().length, 1); assert.equal(auth.listar()[0].usuario, 'admin'); assert.equal(auth.listar()[0].trocarSenha, true);
  assert.ok(!JSON.stringify(auth.listar()).includes('scrypt'));                                   // o hash nunca sai
  const vazio = createAuth({ dir: tmp(), env: {} }); assert.equal(vazio.temUsuarios(), false);
  await assert.rejects(vazio.login({ usuario: 'admin', senha: 'qualquer12345' }), /inválidos/);
  assert.equal(createAuth({ dir: tmp(), env: { ADMIN_USER: 'a', ADMIN_HASH: 'texto-solto' } }).temUsuarios(), false);   // hash malformado é ignorado
});

test('login: mensagem genérica, sessão assinada, adulteração e expiração', async () => {
  const { auth, avanca } = await novo();
  await assert.rejects(auth.login({ usuario: 'admin', senha: 'errada12345' }), /Usuário ou senha inválidos/);
  await assert.rejects(auth.login({ usuario: 'naoexiste', senha: 'Inicial12345' }), /Usuário ou senha inválidos/);   // mesma mensagem: não revela se o usuário existe
  const { token, usuario } = await auth.login({ usuario: 'ADMIN ', senha: 'Inicial12345' });
  assert.equal(usuario.perfil, 'admin'); assert.equal(usuario.trocarSenha, true);
  assert.equal(req(auth, token, 'GET', '/api/auth/me').user.usuario, 'admin');
  assert.equal(req(auth, token + 'x').status, 401); assert.equal(req(auth, token.replace(/^./, c => (c === 'a' ? 'b' : 'a'))).status, 401); assert.equal(req(auth, '').status, 401);
  const [p, s] = token.split('.'), outro = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), u: 'u_outro' })).toString('base64url');
  assert.equal(req(auth, `${outro}.${s}`).status, 401);                                          // payload alterado com a assinatura antiga
  avanca(11 * 3600 * 1000); assert.equal(req(auth, token, 'GET', '/api/auth/me').status, 401);   // expirou (10 h)
});

test('troca de senha obrigatória no primeiro acesso e derruba as sessões antigas', async () => {
  const { auth } = await novo();
  const { token } = await auth.login({ usuario: 'admin', senha: 'Inicial12345' });
  const g = req(auth, token); assert.equal(g.status, 403); assert.equal(g.body.trocarSenha, true);   // nada além de trocar a senha
  await assert.rejects(auth.trocarSenha(auth.porteiro({ method: 'GET', pathname: '/api/auth/me', headers: { authorization: `Bearer ${token}` } }).user, { atual: 'errada', nova: 'Nova-Senha-2026' }), /não confere/);
  const u = req(auth, token, 'GET', '/api/auth/me').user;
  await assert.rejects(auth.trocarSenha(u, { atual: 'Inicial12345', nova: 'curta' }), /10 caracteres/);
  await assert.rejects(auth.trocarSenha(u, { atual: 'Inicial12345', nova: 'Inicial12345' }), /diferente/);
  const r = await auth.trocarSenha(u, { atual: 'Inicial12345', nova: 'Nova-Senha-2026' });
  assert.equal(r.usuario.trocarSenha, false);
  assert.equal(req(auth, token, 'GET', '/api/auth/me').status, 401);                               // sessão antiga morreu
  assert.equal(req(auth, r.token).user.usuario, 'admin');                                          // a nova libera
  await assert.rejects(auth.login({ usuario: 'admin', senha: 'Inicial12345' }), /inválidos/);
});

test('bloqueio após 5 erros, limite por IP e liberação com o tempo', async () => {
  const { auth, avanca } = await novo();
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login({ usuario: 'admin', senha: 'x' + i }, '10.0.0.1'), /inválidos/);
  await assert.rejects(auth.login({ usuario: 'admin', senha: 'Inicial12345' }, '10.0.0.2'), /bloqueado.*minuto/);   // até a senha certa fica barrada
  avanca(16 * 60000);
  assert.ok((await auth.login({ usuario: 'admin', senha: 'Inicial12345' }, '10.0.0.2')).token);
  for (let i = 0; i < 12; i++) await assert.rejects(auth.login({ usuario: 'x' + i, senha: 'y' }, '9.9.9.9'), /inválidos/);
  await assert.rejects(auth.login({ usuario: 'admin', senha: 'Inicial12345' }, '9.9.9.9'), /Muitas tentativas/);   // IP em excesso
  avanca(6 * 60000); assert.ok((await auth.login({ usuario: 'admin', senha: 'Inicial12345' }, '9.9.9.9')).token);
});

test('perfis: o que cada um pode fazer', async () => {
  const { auth } = await novo(), p = auth.permite;
  for (const perfil of ['admin', 'financeiro', 'consulta']) { assert.equal(p(perfil, 'GET', '/api/fin/resumo'), true); assert.equal(p(perfil, 'GET', '/api/settings'), perfil !== 'consulta'); }
  assert.equal(p('consulta', 'POST', '/api/fin/pagar'), false); assert.equal(p('consulta', 'PUT', '/api/fin/pagar/x'), false); assert.equal(p('consulta', 'DELETE', '/api/fin/receber/x'), false);
  assert.equal(p('consulta', 'POST', '/api/fin/parcelas/preview'), true); assert.equal(p('consulta', 'POST', '/api/fin/nfe/previa'), true); assert.equal(p('consulta', 'POST', '/api/deals/7/detalhe'), true);
  assert.equal(p('consulta', 'POST', '/api/deals/7/cancel'), false); assert.equal(p('consulta', 'POST', '/api/sync'), false);
  assert.equal(p('financeiro', 'POST', '/api/fin/pagar'), true); assert.equal(p('financeiro', 'POST', '/api/deals/7/charge'), true); assert.equal(p('financeiro', 'POST', '/api/cobrar'), true);
  for (const [m, r] of [['PUT', '/api/settings/asaas'], ['PUT', '/api/settings/bitrix'], ['POST', '/api/carteiras'], ['PUT', '/api/config'], ['POST', '/api/fin/empresas'], ['PUT', '/api/fin/empresas/e1/asaas'], ['PUT', '/api/fin/config'], ['POST', '/api/fin/demo/carregar'], ['GET', '/api/fin/logs'], ['GET', '/api/auth/usuarios'], ['POST', '/api/auth/usuarios'], ['PUT', '/api/auth/usuarios/u1']]) {
    assert.equal(p('financeiro', m, r), false, `${m} ${r} (financeiro)`); assert.equal(p('consulta', m, r), false, `${m} ${r} (consulta)`); assert.equal(p('admin', m, r), true, `${m} ${r} (admin)`);
  }
});

test('gestão de usuários: criar, validar, desativar derruba sessão, último administrador protegido', async () => {
  const { auth } = await novo();
  const admin = auth.listar()[0];
  await assert.rejects(auth.criar({ nome: 'A', usuario: 'maria', perfil: 'financeiro', senha: 'Boa-Senha-2026' }), /nome/);
  await assert.rejects(auth.criar({ nome: 'Maria', usuario: 'Maria Silva', perfil: 'financeiro', senha: 'Boa-Senha-2026' }), /Usuário:/);
  await assert.rejects(auth.criar({ nome: 'Maria', usuario: 'maria', perfil: 'dono', senha: 'Boa-Senha-2026' }), /perfil/);
  await assert.rejects(auth.criar({ nome: 'Maria', usuario: 'maria', perfil: 'financeiro', senha: 'fraca' }), /10 caracteres/);
  const m = await auth.criar({ nome: 'Maria Souza', usuario: 'maria', email: 'maria@x.com', perfil: 'financeiro', senha: 'Boa-Senha-2026' });
  assert.equal(m.trocarSenha, true); assert.equal(m.ativo, true);
  await assert.rejects(auth.criar({ nome: 'Outra', usuario: 'MARIA', perfil: 'consulta', senha: 'Boa-Senha-2026' }), /Já existe/);
  const s = await auth.login({ usuario: 'maria', senha: 'Boa-Senha-2026' });
  const quem = { id: admin.id, usuario: 'admin' };
  await auth.atualizar(m.id, { ativo: false }, quem);
  assert.equal(req(auth, s.token, 'GET', '/api/auth/me').status, 401);                              // desativado: sessão cai na hora
  await assert.rejects(auth.login({ usuario: 'maria', senha: 'Boa-Senha-2026' }), /inválidos/);
  const m2 = await auth.atualizar(m.id, { ativo: true, perfil: 'consulta', novaSenha: 'Outra-Senha-2027' }, quem);
  assert.equal(m2.perfil, 'consulta'); assert.equal(m2.trocarSenha, true);
  await assert.rejects(auth.atualizar(admin.id, { ativo: false }, quem), /seu próprio acesso/);
  await assert.rejects(auth.atualizar(admin.id, { perfil: 'financeiro' }, quem), /seu próprio acesso/);
  const m3 = await auth.criar({ nome: 'Outro Admin', usuario: 'chefe', perfil: 'admin', senha: 'Segura-Senha-2026' });
  await auth.atualizar(m3.id, { ativo: false }, quem);
  await assert.rejects(auth.atualizar(admin.id, { perfil: 'admin', ativo: false }, { id: 'u_x', usuario: 'x' }), /pelo menos um administrador/);   // o único admin ativo não sai
});

test('recuperação: novo ADMIN_RESET com novo hash redefine a senha do administrador', async () => {
  const dir = tmp(), h1 = await hashSenha('Inicial12345'), h2 = await hashSenha('Recuperada-2026');
  let a = createAuth({ dir, env: { ADMIN_USER: 'admin', ADMIN_HASH: h1 } });
  await a.trocarSenha(a.porteiro({ method: 'GET', pathname: '/api/auth/me', headers: { authorization: `Bearer ${(await a.login({ usuario: 'admin', senha: 'Inicial12345' })).token}` } }).user, { atual: 'Inicial12345', nova: 'Minha-Senha-2026' });
  a = createAuth({ dir, env: { ADMIN_USER: 'admin', ADMIN_HASH: h2 } });                           // reinício sem ADMIN_RESET: não mexe
  await assert.rejects(a.login({ usuario: 'admin', senha: 'Recuperada-2026' }), /inválidos/); assert.ok((await a.login({ usuario: 'admin', senha: 'Minha-Senha-2026' })).token);
  a = createAuth({ dir, env: { ADMIN_USER: 'admin', ADMIN_HASH: h2, ADMIN_RESET: 'r1' } });
  assert.equal((await a.login({ usuario: 'admin', senha: 'Recuperada-2026' })).usuario.trocarSenha, true);
  a = createAuth({ dir, env: { ADMIN_USER: 'admin', ADMIN_HASH: h2, ADMIN_RESET: 'r1' } });         // mesmo token: não repete
  assert.ok(a.listar()[0].ativo);
});

test('login pelo Bitrix24: só entra quem foi liberado; sem senha local; perfil e desativação valem', async () => {
  const { auth } = await novo();
  await assert.rejects(auth.entrarBitrix({ id: '7' }), /não tem acesso/);
  const u = auth.liberarBitrix({ bitrixId: '7', nome: 'Ana Souza', perfil: 'consulta', email: 'ana@x.com' });
  assert.equal(u.porBitrix, true); assert.equal(u.perfil, 'consulta');
  assert.throws(() => auth.liberarBitrix({ bitrixId: '7', nome: 'Ana', perfil: 'consulta' }), /já foi liberado/);
  const r = await auth.entrarBitrix({ id: '7' }); assert.ok(auth.valida(r.token));
  assert.equal(req(auth, r.token, 'POST', '/api/fin/pagar').status, 403);           // consulta não escreve
  await assert.rejects(auth.login({ usuario: 'bx7', senha: '' }, '1.1.1.1'), /inválidos/);   // não há senha local
  await assert.rejects(auth.login({ usuario: 'bx7', senha: 'qualquer-Senha-1' }, '1.1.1.2'), /inválidos/);
  const adm = auth.listar().find(x => x.perfil === 'admin');
  await assert.rejects(auth.atualizar(u.id, { novaSenha: 'Nova-Senha-2026x' }, adm), /não usa senha/);
  await auth.atualizar(u.id, { ativo: false }, adm);
  assert.equal(auth.valida(r.token), null); await assert.rejects(auth.entrarBitrix({ id: '7' }), /não tem acesso/);
});
