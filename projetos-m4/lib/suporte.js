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

function createSuporte({ store, secrets, bitrix, publicUrl = '', linkArquivo = () => '' }) {
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
      if (!s.etapa) { s.etapa = { id: cfg().estagioId, nome: cfg().etapaNome || 'Recebido', semantica: '', desde: store.agora() }; s.historico = [{ ts: store.agora(), etapa: s.etapa.nome }]; }
    } catch (e) { b.tentativas++; b.status = 'erro'; b.erro = String(e.message).slice(0, 300); b.ultimaTentativa = store.agora(); }
    store.save(); return b;
  }
  // Mensagens do portal (cliente e equipe) viram comentários na linha do tempo do card.
  const comentario = (dealId, texto) => bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: texto } });
  async function flushMensagens(s) {
    if (!pronto() || !s.bitrix || !s.bitrix.dealId) return 0; let n = 0;
    for (const m of s.mensagens || []) {
      if (m.bx) continue;
      const arq = m.arquivoId ? store.db.arquivos.find(a => a.id === m.arquivoId) : null; const l = arq ? linkArquivo(arq.id) : '';
      const txt = `${m.tipoAutor === 'cliente' ? 'Cliente' : 'Equipe'} (${m.autor}) no portal, ${s.protocolo}:\n${m.texto || ''}${arq ? `\nAnexo: ${arq.nome}${l ? ' — baixar (link válido por 30 dias): ' + l : ' (disponível no portal)'}` : ''}`.trim();
      try { await comentario(s.bitrix.dealId, txt); m.bx = true; n++; } catch (e) { break; } // tenta de novo no próximo ciclo
    }
    if (n) store.save(); return n;
  }
  async function avaliacaoBitrix(s) { if (!pronto() || !s.bitrix?.dealId || !s.avaliacao || s.avaliacao.bx) return; try { await comentario(s.bitrix.dealId, `Avaliação do cliente (${s.protocolo}): ${s.avaliacao.nota}/5${s.avaliacao.comentario ? ' — ' + s.avaliacao.comentario : ''}`); s.avaliacao.bx = true; store.save(); } catch { /* próximo ciclo */ } }
  // Traz a etapa do card no Bitrix24 para o portal (o cliente acompanha o andamento).
  async function sincronizar() {
    if (!pronto()) return 0;
    const abertos = db.solicitacoes.filter(s => s.bitrix && s.bitrix.dealId && !(s.etapa && s.etapa.semantica)); if (!abertos.length) return 0;
    const eid = +cfg().categoriaId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${cfg().categoriaId}`;
    const etapas = new Map(((await bitrix.call('crm.status.list', { filter: { ENTITY_ID: eid } })).result || []).map(x => [x.STATUS_ID, { nome: x.NAME, sem: x.SEMANTICS || '' }]));
    let n = 0;
    for (let i = 0; i < abertos.length; i += 50) {
      const lote = abertos.slice(i, i + 50); const r = await bitrix.call('crm.deal.list', { filter: { ID: lote.map(s => s.bitrix.dealId) }, select: ['ID', 'STAGE_ID'] });
      for (const d of r.result || []) {
        const s = lote.find(x => x.bitrix.dealId === +d.ID); const e = etapas.get(d.STAGE_ID); if (!s || !e || (s.etapa && s.etapa.id === d.STAGE_ID)) continue;
        s.etapa = { id: d.STAGE_ID, nome: e.nome, semantica: e.sem === 'S' || e.sem === 'F' ? e.sem : '', desde: store.agora() }; (s.historico = s.historico || []).push({ ts: s.etapa.desde, etapa: e.nome });
        if (e.sem === 'S') s.status = 'concluida'; else if (e.sem === 'F') s.status = 'recusada'; else if (s.status === 'nova') s.status = 'em_analise';
        store.log('Bitrix24', 'equipe', 'etapa_chamado', `${s.protocolo} → ${e.nome}`, s.projetoId, { cliente: s.clienteId }); n++;
      }
    }
    if (n) store.save(); return n;
  }
  async function ciclo() {
    let r = { reenviados: 0, mensagens: 0, etapas: 0 };
    try { r.reenviados = await processarPendentes(); for (const s of db.solicitacoes) { r.mensagens += await flushMensagens(s); await avaliacaoBitrix(s); } r.etapas = await sincronizar(); } catch { /* próximo ciclo */ }
    return r;
  }
  let ultimaSync = 0; const sincronizarSeVelho = (ms = 60e3) => { if (Date.now() - ultimaSync < ms) return Promise.resolve(0); ultimaSync = Date.now(); return sincronizar().catch(() => 0); };
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
  return { montar, enviar, processarPendentes, funis, pronto, cfg, webhook, aplicar, flushMensagens, avaliacaoBitrix, sincronizar, sincronizarSeVelho, ciclo };
}
module.exports = { createSuporte, montar, PRIO, CAT };
