'use strict';
// Controle de acesso: usuários e senhas do próprio app, perfis, sessões assinadas e proteção contra tentativas em massa.
// Nada do app (dados ou API) responde sem login; a tela só entrega o código da página, sem dado algum.
// Coberto por test/auth.test.js e test/server.test.js.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PERFIS = { admin: 'Administrador', financeiro: 'Financeiro', consulta: 'Somente consulta' };
const SESSAO_MS = 10 * 3600 * 1000, RENOVA_MS = 30 * 60 * 1000;
const MAX_FALHAS = 5, BLOQUEIO_MS = 15 * 60 * 1000, JANELA_IP_MS = 5 * 60 * 1000, MAX_IP = 12;
const SENHAS_FRACAS = new Set(['1234567890', 'senha12345', 'password123', 'nutrimix123', 'nutrimix2026', 'admin12345', 'qwertyuiop', 'abcdefghij1']);
const erro = (status, msg, extra) => Object.assign(new Error(msg), { status, ...extra });
const b64u = b => Buffer.from(b).toString('base64url');

// ---------- senhas ----------
async function hashSenha(senha) {
  const salt = crypto.randomBytes(16), h = await scrypt(String(senha), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${h.toString('base64')}`;
}
async function confere(senha, hash) {
  const p = String(hash || '').split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return false;
  try {
    const [N, r, pp] = [Number(p[1]), Number(p[2]), Number(p[3])], esperado = Buffer.from(p[5], 'base64');
    const h = await scrypt(String(senha), Buffer.from(p[4], 'base64'), esperado.length, { N, r, p: pp });
    return crypto.timingSafeEqual(h, esperado);
  } catch { return false; }
}
function validaSenha(senha, usuario = '') {
  const s = String(senha || '');
  if (s.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (s.length > 128) return 'A senha pode ter no máximo 128 caracteres.';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'A senha precisa ter letras e números.';
  if (SENHAS_FRACAS.has(s.toLowerCase()) || (usuario && s.toLowerCase().includes(String(usuario).toLowerCase()))) return 'Essa senha é fácil de adivinhar. Escolha outra.';
  return null;
}

function createAuth({ dir, log = () => {}, env = process.env, agora = () => Date.now() }) {
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, 'usuarios.json'), arqSegredo = path.join(dir, 'auth-secret');
  let data = { users: [], resetToken: '' };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(arq, 'utf8')) }; } catch { /* primeiro uso */ }
  let segredo; try { segredo = Buffer.from(fs.readFileSync(arqSegredo, 'utf8'), 'hex'); } catch { /* cria */ }
  if (!segredo || segredo.length < 32) { segredo = crypto.randomBytes(48); fs.writeFileSync(arqSegredo, segredo.toString('hex'), { mode: 0o600 }); }
  const salva = () => { const t = arq + '.tmp'; fs.writeFileSync(t, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(t, arq); };
  const falhasIp = new Map();

  const publico = u => ({ id: u.id, nome: u.nome, usuario: u.usuario, email: u.email || '', perfil: u.perfil, perfilNome: PERFIS[u.perfil], ativo: u.ativo, criado: u.criado, ultimoAcesso: u.ultimoAcesso || '', trocarSenha: !!u.trocarSenha, bitrixId: u.bitrixId || '', porBitrix: !!u.bitrixId && !u.hash });
  const acha = usuario => data.users.find(u => u.usuario === String(usuario || '').trim().toLowerCase());
  const admins = () => data.users.filter(u => u.ativo && u.perfil === 'admin');

  // Administrador inicial: vem do ambiente do servidor (ADMIN_USER + ADMIN_HASH, o hash — nunca a senha). Sem isso, ninguém entra.
  const hashEnvOk = h => /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(String(h || ''));
  function inicia() {
    const usuario = String(env.ADMIN_USER || '').trim().toLowerCase(), h = env.ADMIN_HASH;
    if (!usuario || !hashEnvOk(h)) return;
    const u = acha(usuario);
    if (!u && !data.users.length) {
      data.users.push({ id: 'u_' + crypto.randomBytes(6).toString('hex'), nome: String(env.ADMIN_NOME || 'Administrador'), usuario, email: '', perfil: 'admin', ativo: true, hash: h, sv: 1, criado: new Date(agora()).toISOString(), trocarSenha: true, falhas: 0, bloqueadoAte: 0 });
      salva(); log('acesso', `Administrador inicial criado (${usuario})`);
    } else if (u && env.ADMIN_RESET && env.ADMIN_RESET !== data.resetToken) {   // recuperação: novo ADMIN_RESET + novo hash no deploy
      Object.assign(u, { hash: h, sv: (u.sv || 1) + 1, trocarSenha: true, ativo: true, perfil: 'admin', falhas: 0, bloqueadoAte: 0 }); data.resetToken = env.ADMIN_RESET; salva(); log('acesso', `Senha do administrador ${usuario} redefinida pelo servidor`);
    }
  }
  inicia();

  // ---------- sessão ----------
  const assina = p => crypto.createHmac('sha256', segredo).update(p).digest('base64url');
  const emiteToken = u => { const p = b64u(JSON.stringify({ u: u.id, sv: u.sv || 1, iat: agora(), exp: agora() + SESSAO_MS })); return `${p}.${assina(p)}`; };
  function valida(token) {
    const [p, s] = String(token || '').split('.');
    if (!p || !s) return null;
    const esperado = assina(p);
    if (s.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(esperado))) return null;
    let c; try { c = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
    if (!c.exp || c.exp < agora()) return null;
    const u = data.users.find(x => x.id === c.u);
    return u && u.ativo && (u.sv || 1) === c.sv ? { user: u, iat: c.iat } : null;   // senha trocada ou usuário desativado derruba a sessão
  }

  // ---------- login ----------
  const ipLimitado = ip => { const t = agora(), l = (falhasIp.get(ip) || []).filter(x => t - x < JANELA_IP_MS); falhasIp.set(ip, l); return l.length >= MAX_IP; };
  async function login({ usuario, senha }, ip = '?') {
    if (ipLimitado(ip)) throw erro(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const u = acha(usuario), cheio = u && u.hash ? u.hash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
    if (u && u.bloqueadoAte > agora()) throw erro(429, `Acesso bloqueado por tentativas erradas. Tente de novo em ${Math.ceil((u.bloqueadoAte - agora()) / 60000)} minuto(s).`);
    const ok = await confere(senha, cheio);   // roda mesmo para usuário inexistente (tempo igual)
    if (!u || !u.ativo || !u.hash || !ok) {
      falhasIp.get(ip).push(agora());
      if (u) { u.falhas = (u.falhas || 0) + 1; if (u.falhas >= MAX_FALHAS) { u.bloqueadoAte = agora() + BLOQUEIO_MS; u.falhas = 0; log('acesso', `Usuário ${u.usuario} bloqueado por ${MAX_FALHAS} tentativas erradas`); } salva(); }
      log('acesso', `Falha de login (${String(usuario || '').slice(0, 40)}) de ${ip}`);
      throw erro(401, 'Usuário ou senha inválidos.');
    }
    u.falhas = 0; u.bloqueadoAte = 0; u.ultimoAcesso = new Date(agora()).toISOString(); salva();
    log('acesso', `Login de ${u.usuario} (${u.perfil})`);
    return { token: emiteToken(u), usuario: publico(u) };
  }
  async function trocarSenha(u, { atual, nova }) {
    if (!(await confere(atual, u.hash))) throw erro(400, 'A senha atual não confere.');
    const msg = validaSenha(nova, u.usuario); if (msg) throw erro(400, msg);
    if (await confere(nova, u.hash)) throw erro(400, 'A nova senha precisa ser diferente da atual.');
    u.hash = await hashSenha(nova); u.sv = (u.sv || 1) + 1; u.trocarSenha = false; salva();
    log('acesso', `${u.usuario} trocou a senha`);
    return { token: emiteToken(u), usuario: publico(u) };
  }

  // ---------- permissões por perfil ----------
  const LEITURA_PERMITIDA = [/^\/api\/fin\/parcelas\/preview$/, /^\/api\/fin\/nfe\/previa$/, /^\/api\/deals\/\d+\/detalhe$/, /^\/api\/auth\/(logout|trocar-senha)$/];
  function permite(perfil, method, p) {
    if (/^\/api\/auth\/(usuarios|bitrix)/.test(p)) return perfil === 'admin';
    const escrita = method !== 'GET' && method !== 'HEAD';
    if (/^\/api\/fin\/(logs|demo)(\/|$)/.test(p)) return perfil === 'admin';
    if (escrita && /^\/api\/(settings|carteiras|config)(\/|$)/.test(p)) return perfil === 'admin';
    if (escrita && /^\/api\/fin\/(empresas|config)(\/|$)/.test(p)) return perfil === 'admin';
    if (perfil === 'consulta' && escrita) return LEITURA_PERMITIDA.some(r => r.test(p));
    return true;
  }
  // Porteiro: devolve { user } ou o erro a responder. `renova` traz um token novo quando o atual está velho.
  function porteiro({ method, pathname, headers }) {
    const m = /^Bearer\s+(\S+)$/i.exec(headers.authorization || ''), s = m && valida(m[1]);
    if (!s) return { status: 401, body: { error: 'Faça login para continuar.', auth: true } };
    const u = s.user;
    if (u.trocarSenha && !/^\/api\/auth\/(me|trocar-senha|logout)$/.test(pathname)) return { status: 403, body: { error: 'Defina uma nova senha antes de continuar.', trocarSenha: true } };
    if (!permite(u.perfil, method, pathname)) return { status: 403, body: { error: `O seu perfil (${PERFIS[u.perfil]}) não permite esta ação.`, perfil: u.perfil } };
    return { user: u, renova: agora() - s.iat > RENOVA_MS ? emiteToken(u) : '' };
  }

  // ---------- gestão de usuários (administrador) ----------
  const normUsuario = v => String(v || '').trim().toLowerCase();
  function validaDados(p, parcial = false) {
    const out = {};
    if (!parcial || p.nome !== undefined) { const n = String(p.nome || '').trim(); if (n.length < 2 || n.length > 80) throw erro(400, 'Informe o nome (2 a 80 caracteres).'); out.nome = n; }
    if (!parcial || p.perfil !== undefined) { if (!PERFIS[p.perfil]) throw erro(400, 'Escolha o perfil de acesso.'); out.perfil = p.perfil; }
    if (p.email !== undefined) { const e = String(p.email || '').trim(); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw erro(400, 'E-mail inválido.'); out.email = e.slice(0, 120); }
    return out;
  }
  const semUltimoAdmin = (alvo, novo) => { if (alvo.perfil === 'admin' && alvo.ativo && (novo.perfil !== 'admin' || novo.ativo === false) && admins().length <= 1) throw erro(400, 'Precisa existir pelo menos um administrador ativo.'); };
  return {
    PERFIS, publico, hashSenha, validaSenha, login, trocarSenha, porteiro, permite,
    emiteToken, valida,
    temUsuarios: () => data.users.length > 0,
    listar: () => data.users.map(publico),
    async criar(p) {
      const usuario = normUsuario(p.usuario); if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw erro(400, 'Usuário: 3 a 40 caracteres (letras minúsculas, números, ponto, hífen ou sublinhado).');
      if (acha(usuario)) throw erro(400, 'Já existe um usuário com esse login.');
      const d = validaDados(p), msg = validaSenha(p.senha, usuario); if (msg) throw erro(400, msg);
      const u = { id: 'u_' + crypto.randomBytes(6).toString('hex'), usuario, email: '', ...d, ativo: true, hash: await hashSenha(p.senha), sv: 1, criado: new Date(agora()).toISOString(), trocarSenha: true, falhas: 0, bloqueadoAte: 0 };
      data.users.push(u); salva(); log('acesso', `Usuário ${usuario} criado (${u.perfil})`); return publico(u);
    },
    async entrarBitrix(bx) {
      const u = data.users.find(x => x.bitrixId === String(bx.id));
      if (!u || !u.ativo) throw erro(403, 'Seu usuário do Bitrix24 ainda não tem acesso a este ambiente. Peça ao administrador para liberar.');
      u.ultimoAcesso = new Date(agora()).toISOString(); salva(); log('acesso', `Login Bitrix24 de ${u.usuario} (${u.perfil})`);
      return { token: emiteToken(u), usuario: publico(u) };
    },
    liberarBitrix(p) {
      const id = String(p.bitrixId || '').replace(/\D/g, ''); if (!id) throw erro(400, 'Escolha o usuário do Bitrix24.');
      if (data.users.some(x => x.bitrixId === id)) throw erro(400, 'Este usuário do Bitrix24 já foi liberado.');
      const d = validaDados({ nome: p.nome, perfil: p.perfil, email: p.email }), usuario = 'bx' + id;
      const u = { id: 'u_' + crypto.randomBytes(6).toString('hex'), usuario, email: '', ...d, bitrixId: id, ativo: true, hash: '', sv: 1, criado: new Date(agora()).toISOString(), trocarSenha: false, falhas: 0, bloqueadoAte: 0 };
      data.users.push(u); salva(); log('acesso', `Usuário do Bitrix24 ${id} liberado (${u.perfil})`); return publico(u);
    },
    async atualizar(id, p, quem) {
      const u = data.users.find(x => x.id === id); if (!u) throw erro(404, 'Usuário não encontrado.');
      const d = validaDados(p, true), novo = { ...d, ...(p.ativo !== undefined ? { ativo: !!p.ativo } : {}) };
      if (u.id === quem.id && (novo.ativo === false || (novo.perfil && novo.perfil !== 'admin'))) throw erro(400, 'Você não pode desativar nem rebaixar o seu próprio acesso.');
      semUltimoAdmin(u, { perfil: novo.perfil || u.perfil, ativo: novo.ativo === undefined ? u.ativo : novo.ativo });
      const perfilAntes = u.perfil;
      Object.assign(u, novo);
      if (p.novaSenha && !u.hash) throw erro(400, 'Este usuário entra pelo Bitrix24 e não usa senha.');
      if (p.novaSenha) { const msg = validaSenha(p.novaSenha, u.usuario); if (msg) throw erro(400, msg); u.hash = await hashSenha(p.novaSenha); u.trocarSenha = true; u.falhas = 0; u.bloqueadoAte = 0; }
      if (p.novaSenha || novo.ativo === false || (novo.perfil && novo.perfil !== perfilAntes)) u.sv = (u.sv || 1) + 1;   // derruba as sessões abertas
      if (p.desbloquear) { u.falhas = 0; u.bloqueadoAte = 0; }
      salva(); log('acesso', `Usuário ${u.usuario} alterado por ${quem.usuario}`); return publico(u);
    },
  };
}
module.exports = { createAuth, hashSenha, confere, validaSenha, PERFIS };
