'use strict';
// Controle de acesso por usuário do Bitrix24 — nega por padrão. A identidade vem do gateway da Vibecode
// (X-Vibe-User-Id), que o navegador não forja. Papéis:
//   admin   → configura acessos e acessa todos os módulos
//   usuário → só os módulos em que foi liberado, com nível 'consulta' (ver) ou 'gestor' (ver e alterar)
// Enquanto não houver administrador definido, os administradores do portal Bitrix24 agem como admin (configuração inicial).
const { MODULOS, NIVEIS, ativo } = require('./modules');
const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };

function createAcl({ store, usuarios }) {
  function ident(h) {
    if (process.env.AUTH_DISABLED === '1') return { id: '0', nome: 'Desenvolvimento', portalAdmin: true };
    const id = String(h['x-vibe-user-id'] || '');
    if (!/^\d{1,12}$/.test(id)) return null;
    let nome = ''; try { nome = decodeURIComponent(String(h['x-vibe-user-name-encoded'] || '')); } catch { /* sem nome */ }
    return { id, nome: nome.slice(0, 120), portalAdmin: String(h['x-vibe-user-role'] || '').toUpperCase() === 'ADMIN' };
  }
  function resolve(h) {
    const i = ident(h); if (!i) return null;
    const bootstrap = store.admins.length === 0 && i.portalAdmin;
    const admin = bootstrap || store.admins.some(a => a.id === i.id);
    const niveis = {};
    for (const m of MODULOS.filter(x => x.status === 'ativo')) {
      if (admin) niveis[m.id] = 'gestor';
      else { const g = (store.modulos[m.id] || []).find(x => x.userId === i.id); if (g) niveis[m.id] = g.nivel; }
    }
    return { ...i, papel: admin ? 'admin' : 'usuario', bootstrap, niveis };
  }
  function exige(user, modulo, min = 'consulta') {
    const n = user.niveis[modulo];
    if (!n || (min === 'gestor' && n !== 'gestor')) throw fail(403, 'Você não tem permissão para esta ação neste módulo.');
  }
  const exigeAdmin = user => { if (user.papel !== 'admin') throw fail(403, 'Somente administradores.'); };
  const validId = v => { const s = String(v ?? '').trim(); if (!/^\d{1,12}$/.test(s)) throw fail(400, 'ID de usuário inválido.'); return s; };

  const listar = () => ({
    admins: store.admins,
    modulos: MODULOS.filter(m => m.status === 'ativo').map(m => ({ id: m.id, nome: m.nome, usuarios: store.modulos[m.id] || [] })),
  });
  async function addAdmin(user, bearer, userId) {
    const id = validId(userId);
    if (store.admins.some(a => a.id === id)) throw fail(400, 'Este usuário já é administrador.');
    const u = await usuarios.porId(bearer, id); if (!u) throw fail(404, 'Usuário não encontrado no Bitrix24.');
    store.setAdmins([...store.admins, { id, nome: u.nome, desde: new Date().toISOString(), por: user.id }]);
    store.audit(user, 'acesso.admin+', `${u.nome} (#${id})`);
    return listar();
  }
  function removeAdmin(user, userId) {
    const id = validId(userId);
    if (!store.admins.some(a => a.id === id)) throw fail(404, 'Este usuário não é administrador.');
    store.setAdmins(store.admins.filter(a => a.id !== id));
    store.audit(user, 'acesso.admin-', `#${id}`);
    return listar();
  }
  async function setAcesso(user, bearer, modulo, userId, nivel) {
    if (!ativo(modulo)) throw fail(404, 'Módulo inexistente ou ainda indisponível.');
    if (!NIVEIS.includes(nivel)) throw fail(400, 'Nível inválido (consulta ou gestor).');
    const id = validId(userId);
    const u = await usuarios.porId(bearer, id); if (!u) throw fail(404, 'Usuário não encontrado no Bitrix24.');
    const atual = store.modulos[modulo] || [];
    store.setModulo(modulo, [...atual.filter(x => x.userId !== id), { userId: id, nome: u.nome, nivel, desde: new Date().toISOString(), por: user.id }]);
    store.audit(user, 'acesso.modulo+', `${modulo}: ${u.nome} (#${id}) como ${nivel}`);
    return listar();
  }
  function removeAcesso(user, modulo, userId) {
    if (!ativo(modulo)) throw fail(404, 'Módulo inexistente.');
    const id = validId(userId), atual = store.modulos[modulo] || [];
    if (!atual.some(x => x.userId === id)) throw fail(404, 'Este usuário não tem acesso ao módulo.');
    store.setModulo(modulo, atual.filter(x => x.userId !== id));
    store.audit(user, 'acesso.modulo-', `${modulo}: #${id}`);
    return listar();
  }
  return { ident, resolve, exige, exigeAdmin, listar, addAdmin, removeAdmin, setAcesso, removeAcesso };
}
module.exports = { createAcl };
