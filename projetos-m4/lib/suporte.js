'use strict';
// Chamado do portal -> card (negócio) no funil de suporte do Bitrix24.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const br = s => esc(s).replace(/\r?\n/g, '<br>');
const PRIO = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
const CAT = { duvida: 'Dúvida', problema: 'Problema / erro', mudanca: 'Solicitação de mudança', acesso: 'Acesso e usuários', financeiro: 'Financeiro', outro: 'Outro' };
const MAX_TENT = 8;

function montar(s, ctx) {
  const titulo = `[${s.protocolo}]${s.prioridade === 'alta' || s.prioridade === 'urgente' ? `[${PRIO[s.prioridade]}]` : ''} ${s.assunto} — ${s.cliente}${s.empresa ? ' (' + s.empresa + ')' : ''}`.slice(0, 250);
  const linhas = [['Protocolo', s.protocolo], ['Aberto em', new Date(s.criadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })], ['Categoria', CAT[s.categoria] || s.categoria], ['Prioridade', PRIO[s.prioridade] || s.prioridade],
    ['Cliente', s.cliente], ['Empresa', s.empresa], ['E-mail', s.email], ['Telefone', s.telefone], ['Projeto', ctx.projeto ? `${ctx.projeto.nome}${ctx.projeto.codigo ? ' (' + ctx.projeto.codigo + ')' : ''}` : 'Geral (sem projeto)'], ['Assunto', s.assunto]]
    .filter(x => x[1]).map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`);
  const html = `${linhas.join('<br>')}<br><br><b>Descrição do cliente:</b><br>${br(s.texto)}<br><br><i>Criado automaticamente pelo portal Projetos e Suporte${ctx.url ? ' — ' + esc(ctx.url) : ''}</i>`;
  return { titulo, html };
}

function createSuporte({ store, secrets, bitrix, publicUrl = '' }) {
  const db = store.db; db.config = db.config || {};
  const cfg = () => db.config.suporte || {};
  const webhook = () => secrets.get('bitrixWebhook') || process.env.BITRIX_WEBHOOK || '';
  const aplicar = () => bitrix.configure(webhook());
  const pronto = () => bitrix.enabled && cfg().categoriaId != null && !!cfg().estagioId;
  aplicar();

  async function contato(s) {
    if (!s.email) return null;
    const r = await bitrix.call('crm.contact.list', { filter: { EMAIL: s.email }, select: ['ID'] });
    if (r.result?.[0]) return +r.result[0].ID;
    const [nome, ...resto] = String(s.cliente).trim().split(/\s+/);
    const f = { NAME: nome, LAST_NAME: resto.join(' '), EMAIL: [{ VALUE: s.email, VALUE_TYPE: 'WORK' }], COMMENTS: 'Criado pelo portal Projetos e Suporte' };
    if (s.telefone) f.PHONE = [{ VALUE: s.telefone, VALUE_TYPE: 'WORK' }];
    if (s.empresa) f.COMPANY_TITLE = s.empresa;
    return +(await bitrix.call('crm.contact.add', { fields: f })).result;
  }

  // Envia (ou reenvia) o chamado. Idempotente: procura um card com o mesmo protocolo antes de criar.
  async function enviar(s) {
    const b = s.bitrix = { ...(s.bitrix || {}), tentativas: ((s.bitrix || {}).tentativas || 0) };
    if (!pronto()) { b.status = 'nao_configurado'; b.erro = 'Integração com o funil de suporte ainda não configurada.'; store.save(); return b; }
    try {
      const ex = await bitrix.call('crm.deal.list', { filter: { '%TITLE': `[${s.protocolo}]`, CATEGORY_ID: cfg().categoriaId }, select: ['ID'] });
      if (ex.result?.[0]) { Object.assign(b, { status: 'enviado', dealId: +ex.result[0].ID, erro: '', enviadoEm: b.enviadoEm || store.agora() }); store.save(); return b; }
      const projeto = s.projetoId ? db.projetos.find(p => p.id === s.projetoId) : null;
      const { titulo, html } = montar(s, { projeto, url: publicUrl });
      const contatoId = await contato(s).catch(() => null); // sem contato o card ainda é criado
      const f = { TITLE: titulo, CATEGORY_ID: cfg().categoriaId, STAGE_ID: cfg().estagioId, COMMENTS: html, SOURCE_DESCRIPTION: 'Portal Projetos e Suporte', OPENED: 'Y' };
      if (contatoId) f.CONTACT_ID = contatoId;
      const r = await bitrix.call('crm.deal.add', { fields: f, params: { REGISTER_SONET_EVENT: 'Y' } });
      Object.assign(b, { status: 'enviado', dealId: +r.result, erro: '', enviadoEm: store.agora() });
    } catch (e) { b.tentativas++; b.status = 'erro'; b.erro = String(e.message).slice(0, 300); b.ultimaTentativa = store.agora(); }
    store.save(); return b;
  }
  let rodando = false;
  async function processarPendentes() {
    if (rodando) return 0; rodando = true; let n = 0;
    try { for (const s of db.solicitacoes) { const st = s.bitrix && s.bitrix.status; if ((st === 'erro' && (s.bitrix.tentativas || 0) < MAX_TENT) || st === 'nao_configurado' && pronto()) { await enviar(s); n++; } } } finally { rodando = false; }
    return n;
  }
  async function funis(candidato) {
    const cats = (await bitrix.call('crm.category.list', { entityTypeId: 2 }, candidato)).result?.categories || [];
    if (!cats.some(c => +c.id === 0)) cats.unshift({ id: 0, name: 'Funil geral' });
    const out = [];
    for (const c of cats) {
      const eid = +c.id === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${c.id}`;
      const st = (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: eid }, order: { SORT: 'ASC' } }, candidato)).result || [];
      out.push({ id: +c.id, nome: c.name, etapas: st.map(x => ({ id: x.STATUS_ID, nome: x.NAME })) });
    }
    return out;
  }
  return { montar, enviar, processarPendentes, funis, pronto, cfg, webhook, aplicar };
}
module.exports = { createSuporte, montar, PRIO, CAT };
