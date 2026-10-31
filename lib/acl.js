'use strict';
// Controle de acesso por usuário do Bitrix24. A identidade vem dos cabeçalhos que o gateway da Vibecode injeta em cada requisição
// (X-Vibe-User-Id / X-Vibe-User-Role) — o navegador não consegue forjá-los. Papéis:
//   admin       → vê e faz tudo (até MAX_ADMINS usuários)
//   parceiro    → vê só o que tem a receber (fornecedor/parceiro vinculado)
//   colaborador → vê só o próprio holerite/recebimentos
// Enquanto ninguém foi definido como admin, os administradores do portal Bitrix24 agem como admin (para a configuração inicial).
const MAX_ADMINS = 3;
const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };

function createAcl({ store, bitrix, parceiros }) {
  const cfg = () => store.acl;
  const nomes = new Map();      // userId -> nome (cache curto)

  function ident(headers) {
    if (process.env.AUTH_DISABLED === '1') return { id: '0', nome: 'Desenvolvimento', portalAdmin: true };
    const id = String(headers['x-vibe-user-id'] || '');
    if (!/^\d{1,12}$/.test(id)) return null;
    let nome = ''; try { nome = decodeURIComponent(String(headers['x-vibe-user-name-encoded'] || '')); } catch { /* sem nome */ }
    return { id, nome: nome.slice(0, 120), portalAdmin: String(headers['x-vibe-user-role'] || '').toUpperCase() === 'ADMIN' };
  }

  // { papel, id, nome, portalAdmin, parceiroId? }
  function resolve(headers) {
    const i = ident(headers);
    if (!i) return null;
    const c = cfg();
    const listado = c.admins.some(a => String(a) === i.id);
    const bootstrap = c.admins.length === 0 && i.portalAdmin;
    if (listado || bootstrap) return { ...i, papel: 'admin', bootstrap };
    const link = c.links.find(l => String(l.userId) === i.id);
    if (link) return { ...i, papel: link.tipo === 'colaborador' ? 'colaborador' : 'parceiro', parceiroId: link.parceiroId };
    return { ...i, papel: 'sem' };
  }

  const me = u => ({ id: u.id, nome: u.nome, papel: u.papel, parceiroId: u.parceiroId || 0, portalAdmin: u.portalAdmin, bootstrap: !!u.bootstrap, maxAdmins: MAX_ADMINS });

  async function nomeDe(id) {
    id = String(id);
    if (nomes.has(id)) return nomes.get(id);
    let n = '';
    try { const r = (await bitrix.call('user.get', { ID: id })).result?.[0]; if (r) n = [r.NAME, r.LAST_NAME].filter(Boolean).join(' ') || r.EMAIL || ''; } catch { /* sem escopo de usuários */ }
    nomes.set(id, n || `Usuário #${id}`);
    return nomes.get(id);
  }
  async function existe(id) {
    try { const r = (await bitrix.call('user.get', { ID: String(id) })).result?.[0]; if (r) { nomes.set(String(id), [r.NAME, r.LAST_NAME].filter(Boolean).join(' ') || r.EMAIL || `Usuário #${id}`); return true; } return false; }
    catch { return true; }       // sem permissão de leitura de usuários no webhook: confia no ID informado
  }
  const validId = v => { const s = String(v ?? '').trim(); if (!/^\d{1,12}$/.test(s)) throw fail(400, 'Informe o ID numérico do usuário do Bitrix24.'); return s; };

  async function listar() {
    const c = cfg();
    return {
      maxAdmins: MAX_ADMINS,
      admins: await Promise.all(c.admins.map(async id => ({ id: String(id), nome: await nomeDe(id) }))),
      vinculos: await Promise.all(c.links.map(async l => ({ ...l, userId: String(l.userId), nome: await nomeDe(l.userId) }))),
    };
  }
  async function buscarUsuarios(q) {
    q = String(q || '').trim().slice(0, 60);
    if (q.length < 2) return [];
    const r = await bitrix.call('user.get', { FILTER: { ACTIVE: true, NAME_SEARCH: q } }).catch(e => { throw fail(502, `Não consegui buscar usuários no Bitrix24 (${e.message}). Informe o ID do usuário manualmente.`); });
    return (r.result || []).slice(0, 15).map(u => ({ id: String(u.ID), nome: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || u.EMAIL || `#${u.ID}`, email: u.EMAIL || '' }));
  }

  async function addAdmin(userId) {
    const id = validId(userId), c = cfg();
    if (c.admins.some(a => String(a) === id)) throw fail(400, 'Este usuário já é administrador.');
    if (c.admins.length >= MAX_ADMINS) throw fail(400, `O limite é de ${MAX_ADMINS} administradores. Remova um antes de adicionar outro.`);
    if (c.links.some(l => String(l.userId) === id)) throw fail(400, 'Este usuário está vinculado como parceiro/colaborador: remova o vínculo antes de torná-lo administrador.');
    if (!(await existe(id))) throw fail(404, 'Usuário não encontrado no Bitrix24.');
    store.setAcl({ ...c, admins: [...c.admins, id] });
    store.log('acesso', `Administrador adicionado: ${await nomeDe(id)} (#${id})`);
    return listar();
  }
  async function removeAdmin(userId) {
    const id = validId(userId), c = cfg();
    if (!c.admins.some(a => String(a) === id)) throw fail(404, 'Este usuário não é administrador.');
    store.setAcl({ ...c, admins: c.admins.filter(a => String(a) !== id) });
    store.log('acesso', `Administrador removido: #${id}`);
    return listar();
  }
  async function addVinculo({ userId, parceiroId }) {
    const id = validId(userId), c = cfg();
    if (c.admins.some(a => String(a) === id)) throw fail(400, 'Este usuário é administrador: remova-o de administradores antes de vinculá-lo.');
    const p = (await parceiros()).find(x => x.id === +parceiroId);
    if (!p) throw fail(404, 'Parceiro/fornecedor/colaborador não encontrado.');
    if (!(await existe(id))) throw fail(404, 'Usuário não encontrado no Bitrix24.');
    const novo = { userId: id, parceiroId: p.id, parceiro: p.nome, tipo: p.tipo === 'EMPLOYEE' ? 'colaborador' : 'parceiro', desde: new Date().toISOString() };
    store.setAcl({ ...c, links: [...c.links.filter(l => String(l.userId) !== id), novo] });
    store.log('acesso', `Usuário #${id} vinculado a ${p.nome} (${novo.tipo})`);
    return listar();
  }
  async function removeVinculo(userId) {
    const id = validId(userId), c = cfg();
    if (!c.links.some(l => String(l.userId) === id)) throw fail(404, 'Vínculo não encontrado.');
    store.setAcl({ ...c, links: c.links.filter(l => String(l.userId) !== id) });
    store.log('acesso', `Vínculo do usuário #${id} removido`);
    return listar();
  }

  return { ident, resolve, me, listar, buscarUsuarios, addAdmin, removeAdmin, addVinculo, removeVinculo, MAX_ADMINS };
}
module.exports = { createAcl, MAX_ADMINS };
