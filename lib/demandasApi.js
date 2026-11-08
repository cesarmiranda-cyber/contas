'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./bk');
const R = require('./rules');
const { norm } = require('./feriados');

// Processos por funil do Bitrix24 (multas, rotulagem, manuais, solicitações, suplementos): quadro de etapas, prazo,
// checklist, dupla checagem com histórico de aprovações e entrada de solicitações por e-mail.
const FUNIS = {
  multas: { nome: 'Fiscalizações e defesas de multa', cat: 8, prazo: 'Prazo da defesa', avisos: [15, 7, 3, 0], checklist: ['Auto de infração ou notificação recebido e registrado', 'Prazo da defesa conferido e anotado', 'Defesa elaborada', 'Defesa protocolada (comprovante guardado)', 'Resposta do órgão acompanhada'] },
  rotulagem: { nome: 'Rotulagem nutricional', cat: 12, prazo: 'Prazo de entrega', avisos: [7, 3, 0], dupla: 'Aprovação do cliente', checklist: ['Dados do produto, ingredientes e alérgenos recebidos', 'Glúten e contaminação cruzada conferidos', 'Tabela nutricional calculada', 'Enquadramento na legislação (Anvisa/MAPA) conferido', 'Layout conferido: fontes, espaçamentos, modelo de tabela', 'Dupla checagem concluída'] },
  manuais: { nome: 'Manuais de boas práticas e documentação', cat: 4, prazo: 'Prazo de entrega', avisos: [7, 3, 0], checklist: ['Segmento e legislação aplicável definidos', 'Modelo base escolhido', 'Documento elaborado', 'Revisão técnica', 'Entregue ao cliente'] },
  solicitacoes: { nome: 'Solicitações (e-mail e formulários)', cat: 17, prazo: 'Prazo', avisos: [3, 0], checklist: ['Unidade (BKN) identificada', 'Pedido entendido e classificado', 'Dados e documentos completos'] },
  suplementos: { nome: 'Suplementos (notificação na Anvisa)', cat: null, prazo: 'Prazo', avisos: [7, 3, 0], dupla: '', modelo: true, checklist: ['Fórmula e rótulo recebidos', 'Memorial de cálculo', 'Dossiê / evidências científicas', 'Revisão técnica', 'Notificação protocolada na Anvisa'] },
};
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const urlOk = u => { try { const x = new URL(String(u)); return ['http:', 'https:'].includes(x.protocol) ? x.href : ''; } catch { return ''; } };

function createDemandasApi({ bitrix, bx, funil, bk, store, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'demandas.json');
  let d = { itens: {}, config: { suplementosCat: '' }, entradaHash: '', vistos: [], avisos: {} };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')), config: { suplementosCat: '', ...(JSON.parse(fs.readFileSync(file, 'utf8')).config || {}) } }; } catch { /* primeiro uso */ }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(d), { mode: 0o600 }); fs.renameSync(t, file); };
  const hoje = () => R.todayBR();
  const need = (c, m, s = 400) => { if (!c) throw bad(m, s); };
  const cfg = k => { const f = FUNIS[k]; need(f, 'Processo não encontrado.', 404); return { ...f, cat: k === 'suplementos' ? (Number(d.config.suplementosCat) || null) : f.cat }; };
  const catOk = f => { need(f.cat, 'O funil de Suplementos ainda não foi criado no Bitrix24. Informe o número dele em Configurações do processo.', 409); return f.cat; };
  const item = id => (d.itens[String(id)] ||= { checklist: null, aprovacoes: [], notas: [], links: [], bkn: '', origem: '' });
  const dias = (de, ate) => Math.round((Date.parse(ate + 'T00:00:00Z') - Date.parse(de + 'T00:00:00Z')) / 864e5);
  const prazoDe = dl => String(dl.CLOSEDATE || '').slice(0, 10);
  const situacao = (dl, est) => { const p = prazoDe(dl), fim = est && ['S', 'F'].includes(est.semantica); if (!p) return { estado: 'sem', dias: null }; const x = dias(hoje(), p); return { estado: fim ? 'ok' : x < 0 ? 'vencido' : x <= 7 ? 'vencendo' : 'ok', dias: x }; };
  let cacheUs = { at: 0, l: [] };
  async function usuarios() { if (Date.now() - cacheUs.at < 600000 && cacheUs.l.length) return cacheUs.l; const out = []; let start = 0; for (let i = 0; i < 20; i++) { const r = await bitrix.call('user.get', { FILTER: { ACTIVE: true }, start }); for (const x of r.result || []) out.push({ id: String(x.ID), nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') }); if (r.next === undefined) break; start = r.next; } cacheUs = { at: Date.now(), l: out }; return out; }
  const host = () => bx.host();

  async function quadro(k) {
    const f = cfg(k), cat = catOk(f); need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const [est, deals, emp, us] = await Promise.all([funil.estagios(cat), funil.negocios(cat), bx.listar().catch(() => []), usuarios().catch(() => [])]);
    const E = new Map(est.map(e => [e.id, e])), nomeEmp = new Map(emp.map(e => [e.id, e.nome])), nomeUs = new Map(us.map(u => [u.id, u.nome]));
    const negocios = deals.map(dl => { const it = d.itens[String(dl.ID)] || {}, st = E.get(dl.STAGE_ID), s = situacao(dl, st), ck = it.checklist || [];
      return { id: String(dl.ID), titulo: dl.TITLE, etapa: dl.STAGE_ID, empresaId: String(dl.COMPANY_ID || ''), empresaNome: nomeEmp.get(String(dl.COMPANY_ID)) || '', responsavel: String(dl.ASSIGNED_BY_ID || ''), responsavelNome: nomeUs.get(String(dl.ASSIGNED_BY_ID)) || '', prazo: prazoDe(dl), situacao: s,
        checklist: { feitos: ck.filter(c => c.ok).length, total: ck.length }, aprovacoes: (it.aprovacoes || []).filter(a => a.decisao === 'aprovado').length, bkn: it.bkn || '', origem: it.origem || '', url: `https://${host()}/crm/deal/details/${dl.ID}/` }; });
    return { chave: k, nome: f.nome, prazoRotulo: f.prazo, dupla: f.dupla || '', etapas: est, negocios, hoje: hoje(), usuarios: us, host: host() };
  }
  function aprovacoesValidas(it) { const l = it.aprovacoes || []; let ini = 0; for (let i = l.length - 1; i >= 0; i--) if (l[i].decisao === 'reprovado') { ini = i + 1; break; } return new Set(l.slice(ini).filter(a => a.decisao === 'aprovado').map(a => a.por)); }
  async function negocio(k, id) {
    const f = cfg(k), cat = catOk(f), r = (await bitrix.call('crm.deal.get', { id })).result; need(r && String(r.CATEGORY_ID) === String(cat), 'Negócio não encontrado neste processo.', 404);
    const it = item(id); if (!it.checklist) { it.checklist = f.checklist.map(t => ({ t, ok: false })); save(); }
    const est = await funil.estagios(cat);
    return { id: String(id), titulo: r.TITLE, etapa: r.STAGE_ID, etapaNome: (est.find(e => e.id === r.STAGE_ID) || {}).nome || '', empresaId: String(r.COMPANY_ID || ''), responsavel: String(r.ASSIGNED_BY_ID || ''), prazo: String(r.CLOSEDATE || '').slice(0, 10), comentarios: r.COMMENTS || '', ...it, aprovadoresValidos: aprovacoesValidas(it).size, dupla: f.dupla || '', url: `https://${host()}/crm/deal/details/${id}/` };
  }
  const quem = u => (u && (u.nome || u.usuario)) || 'sistema', agora = () => new Date().toISOString();
  async function criarDeal(k, b, origem) {
    const f = cfg(k), cat = catOk(f), titulo = txt(b.titulo, 250); need(titulo.length >= 3, 'Informe um título (mínimo de 3 letras).');
    const est = await funil.estagios(cat), fields = { TITLE: titulo, CATEGORY_ID: cat, STAGE_ID: (b.etapa && est.find(e => e.id === b.etapa) ? b.etapa : est[0].id) };
    if (b.empresaId) fields.COMPANY_ID = String(b.empresaId).replace(/\D/g, ''); if (b.prazo) { need(/^\d{4}-\d{2}-\d{2}$/.test(b.prazo), 'Prazo inválido.'); fields.CLOSEDATE = b.prazo; } if (b.responsavel) fields.ASSIGNED_BY_ID = String(b.responsavel).replace(/\D/g, ''); if (b.comentarios) fields.COMMENTS = txt(b.comentarios, 6000);
    const id = await funil.criar(fields), it = item(id); it.checklist = f.checklist.map(t => ({ t, ok: false })); it.bkn = txt(b.bkn, 20); it.origem = origem || 'manual'; if (b.de) it.de = txt(b.de, 200); save(); store.log('demandas', `${f.nome}: negócio ${id} criado (${titulo})`); return String(id);
  }

  // ---------- alertas de prazo ----------
  async function avisar({ simular = false } = {}) {
    const out = { enviados: [], erros: [] };
    for (const k of Object.keys(FUNIS)) {
      const f = cfg(k); if (!f.cat || !bitrix.enabled) continue;
      let q; try { q = await quadro(k); } catch (e) { out.erros.push(`${k}: ${e.message}`); continue; }
      const E = new Map(q.etapas.map(e => [e.id, e]));
      for (const n of q.negocios) {
        const st = E.get(n.etapa); if (!n.prazo || (st && ['S', 'F'].includes(st.semantica)) || n.situacao.dias === null) continue;
        const key = `${k}|${n.id}|${n.prazo}`, m = B.avisoDevido(n.situacao.dias, f.avisos, d.avisos[key] || []); if (m === null) continue;
        const x = n.situacao.dias, msg = x < 0 ? `[${f.nome}] "${n.titulo}": prazo VENCIDO há ${-x} dia(s) (${n.prazo}).` : x === 0 ? `[${f.nome}] "${n.titulo}": o prazo é HOJE.` : `[${f.nome}] "${n.titulo}": prazo em ${x} dia(s) (${n.prazo}).`;
        if (simular) { out.enviados.push({ processo: k, id: n.id, msg }); continue; }
        if (!n.responsavel) { out.erros.push(`${n.titulo}: sem responsável`); continue; }
        try { await bitrix.call('im.notify.personal.add', { USER_ID: n.responsavel, MESSAGE: `${msg} [URL=${n.url}]Abrir[/URL]`, TAG: `dem-${k}-${n.id}-${m}` }); (d.avisos[key] ||= []).push(m); save(); out.enviados.push({ processo: k, id: n.id, msg }); } catch (e) { out.erros.push(`${n.titulo}: ${e.message}`); }
      }
    }
    return out;
  }

  // ---------- entrada de solicitações por e-mail (sem senha de e-mail: quem manda é um script/automação com token) ----------
  const hashTok = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  async function entradaEmail(b, token) {
    need(d.entradaHash, 'A entrada por e-mail ainda não foi ativada.', 403);
    const a = Buffer.from(hashTok(token)), c = Buffer.from(d.entradaHash); need(a.length === c.length && crypto.timingSafeEqual(a, c), 'Token inválido.', 403);
    const assunto = txt(b.assunto, 250), corpo = txt(String(b.texto || '').slice(0, 20000), 6000), de = txt(b.de, 200), mid = txt(b.messageId, 200);
    need(assunto || corpo, 'E-mail vazio.');
    if (mid && d.vistos.includes(mid)) return { duplicado: true };
    const m = /BKN\s*[:#\-]?\s*(\d{4,6})/i.exec(`${assunto}\n${corpo}`) || null, unidades = bk ? bk.unidades() : [];
    const un = m ? unidades.find(u => u.bkn === m[1]) : unidades.find(u => new RegExp(`(^|\\D)${u.bkn.replace(/\D/g, '')}(\\D|$)`).test(assunto));
    const titulo = `${un ? `BKN ${un.bkn} — ` : m ? `BKN ${m[1]} (não cadastrada) — ` : ''}${assunto || 'Solicitação por e-mail'}`;
    const id = await criarDeal('solicitacoes', { titulo, empresaId: un && un.empresaBitrixId, bkn: un ? un.bkn : m ? m[1] : '', de, comentarios: `De: ${de}\n\n${corpo}` }, 'email');
    if (mid) { d.vistos.push(mid); if (d.vistos.length > 5000) d.vistos.splice(0, d.vistos.length - 5000); save(); }
    return { id, unidade: un ? un.bkn : '', identificada: !!un };
  }

  const routes = [], on = (m, re, h) => routes.push([m, new RegExp(`^/api/dem${re}$`), h]);
  on('GET', '/empresas', async (_, u) => bx.buscar(u.searchParams.get('q') || ''));
  on('GET', '/funis', async () => Object.keys(FUNIS).map(k => ({ chave: k, nome: FUNIS[k].nome, cat: cfg(k).cat, modelo: !!FUNIS[k].modelo })));
  on('GET', '/(\\w+)/quadro', async ([k]) => quadro(k));
  on('GET', '/(\\w+)/negocios/(\\d+)', async ([k, id]) => negocio(k, id));
  on('POST', '/(\\w+)/negocios', async ([k], _, b) => { const id = await criarDeal(k, b, 'manual'); return negocio(k, id); });
  on('PUT', '/(\\w+)/negocios/(\\d+)', async ([k, id], _, b) => {
    await negocio(k, id); const f = {}; if (b.titulo !== undefined) { const t = txt(b.titulo, 250); need(t.length >= 3, 'Título muito curto.'); f.TITLE = t; }
    if (b.prazo !== undefined) { need(b.prazo === '' || /^\d{4}-\d{2}-\d{2}$/.test(b.prazo), 'Prazo inválido.'); f.CLOSEDATE = b.prazo || ''; } if (b.responsavel !== undefined) f.ASSIGNED_BY_ID = String(b.responsavel).replace(/\D/g, '');
    if (Object.keys(f).length) await bitrix.call('crm.deal.update', { id, fields: f }); return negocio(k, id);
  });
  on('POST', '/(\\w+)/negocios/(\\d+)/mover', async ([k, id], _, b, user) => {
    const f = cfg(k), n = await negocio(k, id), est = await funil.estagios(catOk(f)), alvo = est.find(e => e.id === b.etapa); need(alvo, 'Etapa inválida.');
    if (f.dupla && norm(alvo.nome).includes(norm(f.dupla)) && n.etapa !== alvo.id) { const q = aprovacoesValidas(item(id)).size; need(q >= 2, `Dupla checagem: faltam aprovações internas de duas pessoas diferentes antes de "${alvo.nome}" (há ${q}).`, 409); }
    await bitrix.call('crm.deal.update', { id, fields: { STAGE_ID: alvo.id } }); item(id).notas.push({ em: agora(), por: quem(user), t: `Etapa: ${n.etapaNome} → ${alvo.nome}` }); save(); return negocio(k, id);
  });
  on('POST', '/(\\w+)/negocios/(\\d+)/checklist', async ([k, id], _, b) => { await negocio(k, id); const t = txt(b.texto, 200); need(t, 'Escreva o item.'); const it = item(id); it.checklist.push({ t, ok: false }); save(); return negocio(k, id); });
  on('PUT', '/(\\w+)/negocios/(\\d+)/checklist/(\\d+)', async ([k, id, i], _, b, user) => { await negocio(k, id); const it = item(id), c = it.checklist[Number(i)]; need(c, 'Item não encontrado.', 404); c.ok = !!b.ok; c.por = c.ok ? quem(user) : ''; c.em = c.ok ? agora() : ''; save(); return negocio(k, id); });
  on('DELETE', '/(\\w+)/negocios/(\\d+)/checklist/(\\d+)', async ([k, id, i]) => { await negocio(k, id); item(id).checklist.splice(Number(i), 1); save(); return negocio(k, id); });
  on('POST', '/(\\w+)/negocios/(\\d+)/aprovacao', async ([k, id], _, b, user) => {
    await negocio(k, id); need(['aprovado', 'reprovado'].includes(b.decisao), 'Escolha aprovar ou reprovar.'); const por = (user && user.id) || 'sistema';
    const it = item(id); it.aprovacoes.push({ em: agora(), por, nome: quem(user), decisao: b.decisao, nota: txt(b.nota, 500) }); save(); return negocio(k, id);
  });
  on('POST', '/(\\w+)/negocios/(\\d+)/nota', async ([k, id], _, b, user) => { await negocio(k, id); const t = txt(b.texto, 1000); need(t, 'Escreva a nota.'); item(id).notas.push({ em: agora(), por: quem(user), t }); save(); return negocio(k, id); });
  on('POST', '/(\\w+)/negocios/(\\d+)/link', async ([k, id], _, b) => { await negocio(k, id); const u = urlOk(b.url); need(u, 'Link inválido (use http ou https).'); item(id).links.push({ nome: txt(b.nome, 80) || u, url: u }); save(); return negocio(k, id); });
  on('DELETE', '/(\\w+)/negocios/(\\d+)/link/(\\d+)', async ([k, id, i]) => { await negocio(k, id); item(id).links.splice(Number(i), 1); save(); return negocio(k, id); });
  on('PUT', '/suplementos/config', async (_, __, b) => { const c = String(b.suplementosCat || '').replace(/\D/g, ''); d.config.suplementosCat = c; save(); return { suplementosCat: c }; });
  on('GET', '/suplementos/config', async () => d.config);
  on('POST', '/solicitacoes/entrada/token', async () => { const t = crypto.randomBytes(24).toString('base64url'); d.entradaHash = hashTok(t); save(); store.log('demandas', 'Token da entrada por e-mail gerado'); return { token: t }; });
  on('GET', '/solicitacoes/entrada/estado', async () => ({ ativa: !!d.entradaHash, recebidos: d.vistos.length }));
  on('POST', '/avisar', async (_, __, b) => avisar({ simular: !!b.simular }));
  return { avisar, entradaEmail, dados: () => d,
    async handle(method, pathname, u, readBody, user) {
      for (const [m, re, h] of routes) { const g = m === method && pathname.match(re); if (g) return { json: await h(g.slice(1), u, ['POST', 'PUT'].includes(method) ? await readBody() : {}, user) }; }
      return null;
    } };
}
module.exports = { createDemandasApi, FUNIS };
