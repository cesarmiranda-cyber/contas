'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./bk');
const C = require('./finCad');
const IA = require('./conferenciaIa');
const CALC = require('./rotulagemCalc');
const R = require('./rules');
const { norm } = require('./feriados');

// Processos por funil do Bitrix24 (multas, rotulagem, manuais, solicitações, suplementos): quadro de etapas, prazo,
// checklist, dupla checagem com histórico de aprovações e entrada de solicitações por e-mail.
// Processos geridos no app ("local"): etapas, checklist, regras e dados ficam aqui; o Bitrix24 recebe só um resumo
// (um negócio por serviço no funil único "Serviços técnicos": Em andamento, Aguardando cliente, Concluído, Cancelado).
const et = l => l.map(([id, nome, resumo, x = {}]) => ({ id, nome, semantica: x.s || '', resumo, ...x }));
const FUNIS = {
  multas: { nome: 'Fiscalizações e defesas de multa', local: true, resumo: 'Multas', prazo: 'Prazo da defesa', avisos: [15, 7, 3, 0],
    etapas: et([['m1', 'Aviso recebido', 'andamento'], ['m2', 'Atendimento técnico', 'andamento'], ['m3', 'Auto/notificação registrado', 'andamento'], ['m4', 'Plano de ação', 'andamento'], ['m5', 'Em cumprimento de prazo', 'aguardando'], ['m6', 'Resolvido', 'concluido', { s: 'S' }], ['m7', 'Autuado', 'cancelado', { s: 'F' }]]),
    checklist: ['Auto de infração ou notificação recebido e registrado', 'Prazo da defesa conferido e anotado', 'Defesa elaborada', 'Defesa protocolada (comprovante guardado)', 'Resposta do órgão acompanhada'] },
  rotulagem: { nome: 'Rotulagem nutricional', local: true, resumo: 'Rotulagem', prazo: 'Prazo de entrega', avisos: [7, 3, 0], dupla: 'Aprovação final',
    // passo a passo da Nutri Mix: pagamento → conferência → análise da legislação → relatório → envio → conferência das correções (repetida) → aprovação final → arquivamento
    etapas: et([['r1', 'Pagamento e questionário', 'aguardando'], ['r2', 'Conferência das informações', 'andamento'], ['r3', 'Análise da legislação', 'andamento'], ['r4', 'Relatório de adequação', 'andamento', { exigeCampos: ['enquadramento'] }], ['r5', 'Enviado ao cliente (correções)', 'aguardando'], ['r6', 'Conferência das correções', 'andamento'],
      ['r7', 'Aprovação final', 'andamento', { entrega: true, exigeConferencia: true, exigeCampos: ['versaoAprovada'] }], ['r8', 'Concluído e arquivado', 'concluido', { s: 'S', exigeDocs: ['Arte final aprovada', 'E-mail de aprovação final'] }], ['r9', 'Cancelado', 'cancelado', { s: 'F' }]]),
    campos: [{ k: 'enquadramento', rotulo: 'Enquadramento regulatório', opcoes: ['Norma específica do produto (RTIQ/MAPA/Anvisa)', 'Legislação geral: RDC 429/2020, IN 75/2020 e RDC 727/2022'] }, { k: 'norma', rotulo: 'Norma específica aplicada (se houver)' }, { k: 'metodoNutricional', rotulo: 'Como os valores nutricionais foram determinados (RDC 429, art. 32)', opcoes: ['Análise laboratorial com método validado', 'Cálculo a partir dos dados dos fornecedores dos ingredientes', 'Cálculo a partir de tabela de composição de alimentos'] }, { k: 'modeloTabela', rotulo: 'Modelo da tabela nutricional (Anexo IX da IN 75)', opcoes: ['Vertical', 'Horizontal', 'Linear (sem espaço, art. 17)', 'Agregado (embalagem múltipla ou mais de um grupo populacional)'] }, { k: 'frontal', rotulo: 'Rotulagem nutricional frontal (art. 18)', opcoes: ['Obrigatória (declarar a lupa)', 'Não se aplica (abaixo dos limites)', 'Vedada (alimento do Anexo XVI)', 'Opcional (painel principal menor que 35 cm²)'] }, { k: 'versaoAprovada', rotulo: 'Versão da arte aprovada (nome e data do arquivo)' }],
    documentos: ['Questionário preenchido', 'Memória de cálculo da tabela nutricional', 'Relatório de adequação', 'Artes recebidas e corrigidas', 'E-mails de correção', 'Arte final aprovada', 'E-mail de aprovação final'],
    checklist: ['Pagamento de 50% confirmado (clientes pontuais) e questionário enviado', 'Questionário respondido por completo e documentos recebidos', 'Enquadramento definido: norma específica (RTIQ) ou RDC 429, IN 75 e RDC 727', 'Tabela nutricional conferida: método de determinação dos valores, porção, medida caseira, arredondamento, %VD e tolerância de 20%', 'Rotulagem frontal avaliada (obrigatória, não se aplica, vedada ou opcional)', 'Relatório de adequação preenchido no modelo Nutri Mix: o que está errado, o que corrigir e a norma de cada correção', 'Relatório enviado por e-mail, pedindo ao designer todas as correções', 'Nova arte recebida e comparada com o relatório', 'Aprovação final enviada por e-mail, com a versão aprovada identificada', 'Documentos arquivados na pasta do cliente'] },
  manuais: { nome: 'Manuais de boas práticas e documentação', cat: 4, prazo: 'Prazo de entrega', avisos: [7, 3, 0], checklist: ['Segmento e legislação aplicável definidos', 'Modelo base escolhido', 'Documento elaborado', 'Revisão técnica', 'Entregue ao cliente'] },
  solicitacoes: { nome: 'Solicitações (e-mail e formulários)', cat: 17, prazo: 'Prazo', avisos: [3, 0], checklist: ['Unidade (BKN) identificada', 'Pedido entendido e classificado', 'Dados e documentos completos'] },
  suplementos: { nome: 'Suplementos (notificação na Anvisa)', local: true, resumo: 'Suplementos', prazo: 'Prazo', avisos: [7, 3, 0], modelo: true,
    etapas: et([['s1', 'Solicitação dos documentos', 'aguardando'], ['s2', 'Adequação da ordem de produção', 'andamento'], ['s3', 'Teste de cápsula e estudo de estabilidade', 'aguardando'], ['s4', 'Memorial de cálculo', 'andamento'], ['s5', 'Documentação de estabilidade', 'andamento'], ['s6', 'Notificação na Anvisa (Solicita)', 'andamento', { exigeCampos: ['estabilidade'] }],
      ['s7', 'Finalização (comprovante e arquivo)', 'concluido', { s: 'S', entrega: true, exigeCampos: ['protocoloSolicita'], exigeDocs: ['Comprovante do protocolo'] }], ['s8', 'Cancelado', 'cancelado', { s: 'F' }]]),
    campos: [{ k: 'estabilidade', rotulo: 'Documentação de estabilidade', opcoes: ['Relatório de estabilidade do cliente', 'Protocolo de estabilidade + dossiê técnico (aguardando laboratório)'] }, { k: 'protocoloSolicita', rotulo: 'Nº do protocolo no Solicita (Anvisa)' }],
    documentos: ['Ordem de produção', 'Memorial de cálculo', 'Rótulo', 'Protocolo de estabilidade', 'Relatório / dossiê', 'Comprovante do protocolo'],
    checklist: ['Formulação e fichas técnicas das matérias-primas recebidas', 'Ordem de produção analisada e adequada (modelo Nutri Mix, legislação Anvisa)', 'Teste de cápsula feito pelo cliente', 'Amostras enviadas ao laboratório (estudo de estabilidade)', 'Memorial de cálculo elaborado (formulação final e estabilidade)', 'Estabilidade: relatório do cliente OU protocolo + dossiê técnico', 'Documentação e requisitos regulatórios conferidos', 'Notificação preenchida e protocolada no Solicita', 'Comprovante enviado ao cliente', 'Documentos do processo arquivados'] },
};
const COM_IA = new Set(['rotulagem', 'suplementos']);   // conferência assistida por IA (a IA do cliente)
const COBRA = new Set(['rotulagem', 'manuais', 'suplementos']);   // serviços pontuais: 50% antes de começar, 50% antes de entregar
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const urlOk = u => { try { const x = new URL(String(u)); return ['http:', 'https:'].includes(x.protocol) ? x.href : ''; } catch { return ''; } };

function createDemandasApi({ bitrix, bx, funil, bk, fin, store, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'demandas.json');
  let d = { itens: {}, locais: {}, seq: {}, config: { suplementosCat: '', empresaFaturaId: '', servicosCat: '12' }, entradaHash: '', vistos: [], avisos: {} };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')), config: { suplementosCat: '', empresaFaturaId: '', servicosCat: '12', ...(JSON.parse(fs.readFileSync(file, 'utf8')).config || {}) } }; } catch { /* primeiro uso */ }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(d), { mode: 0o600 }); fs.renameSync(t, file); };
  const hoje = () => R.todayBR();
  const need = (c, m, s = 400) => { if (!c) throw bad(m, s); };
  const cfg = k => { const f = FUNIS[k]; need(f, 'Processo não encontrado.', 404); return { ...f, cat: f.local ? (Number(d.config.servicosCat) || null) : f.cat }; };
  const loc = (k, id) => { const x = d.locais[String(id)]; need(x && x.processo === k, 'Negócio não encontrado neste processo.', 404); return x; };
  const rotuloCampo = (f, c) => ((f.campos || []).find(x => x.k === c) || {}).rotulo || c;
  const catOk = f => { need(f.cat, 'Este processo usa um funil do Bitrix24 que não está configurado.', 409); return f.cat; };
  const item = id => (d.itens[String(id)] ||= { checklist: null, aprovacoes: [], notas: [], links: [], bkn: '', origem: '' });
  const dias = (de, ate) => Math.round((Date.parse(ate + 'T00:00:00Z') - Date.parse(de + 'T00:00:00Z')) / 864e5);
  const prazoDe = dl => String(dl.CLOSEDATE || '').slice(0, 10);
  const situacao = (dl, est) => { const p = prazoDe(dl), fim = est && ['S', 'F'].includes(est.semantica); if (!p) return { estado: 'sem', dias: null }; const x = dias(hoje(), p); return { estado: fim ? 'ok' : x < 0 ? 'vencido' : x <= 7 ? 'vencendo' : 'ok', dias: x }; };
  let cacheUs = { at: 0, l: [] };
  async function usuarios() { if (Date.now() - cacheUs.at < 600000 && cacheUs.l.length) return cacheUs.l; const out = []; let start = 0; for (let i = 0; i < 20; i++) { const r = await bitrix.call('user.get', { FILTER: { ACTIVE: true }, start }); for (const x of r.result || []) out.push({ id: String(x.ID), nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') }); if (r.next === undefined) break; start = r.next; } cacheUs = { at: Date.now(), l: out }; return out; }
  const host = () => bx.host();
  const r2 = n => Math.round(n * 100) / 100;
  const pago = id => { const l = fin && fin.receber.get(id); return !!l && l.status === 'pago'; };
  function cobrancaDe(it) {
    const c = it && it.cobranca; if (!c) return null;
    const x = id => { const l = fin.receber.get(id); return l ? { id, valor: l.valor, venc: l.venc, pago: l.status === 'pago', pagoEm: l.pagoEm || '', cancelada: l.status === 'cancelado' } : { id, removida: true }; };
    return { valor: c.valor, entrada: x(c.entradaId), final: x(c.finalId), liberacoes: c.liberacoes || [] };
  }
  const liberado = (it, qual) => ((it.cobranca || {}).liberacoes || []).some(l => l.qual === qual);
  function conferePagamento(k, it, n, est, alvo) {   // 50% antes de sair da 1ª etapa; 50% antes de entregar
    const c = it && it.cobranca; if (!c || !fin) return;
    const sai = est.length && n.etapa === est[0].id && alvo.id !== est[0].id, entrega = ['S'].includes(alvo.semantica) || /entreg/i.test(alvo.nome) || !!alvo.entrega;
    if ((sai || entrega) && !pago(c.entradaId) && !liberado(it, 'inicio')) throw bad(`Cobrança: a entrada de 50% (R$ ${fin.receber.get(c.entradaId) ? fin.receber.get(c.entradaId).valor.toFixed(2).replace('.', ',') : '—'}) ainda não foi paga. O serviço só começa depois do pagamento (ou de uma liberação do administrador).`, 409);
    if (entrega && !pago(c.finalId) && !liberado(it, 'final')) throw bad(`Cobrança: os 50% finais ainda não foram pagos. Os documentos só são liberados depois do pagamento (ou de uma liberação do administrador).`, 409);
  }

  const urlDeal = id => (id && bitrix.enabled ? `https://${host()}/crm/deal/details/${id}/` : '');
  async function quadro(k) {
    const f = cfg(k); need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    let est, deals;
    if (f.local) { est = f.etapas; deals = Object.values(d.locais).filter(x => x.processo === k).map(x => ({ ID: x.id, TITLE: x.titulo, STAGE_ID: x.etapa, COMPANY_ID: x.empresaId, ASSIGNED_BY_ID: x.responsavel, CLOSEDATE: x.prazo })); }
    else { const cat = catOk(f); [est, deals] = await Promise.all([funil.estagios(cat), funil.negocios(cat)]); }
    const [emp, us] = await Promise.all([bx.listar().catch(() => []), usuarios().catch(() => [])]);
    const E = new Map(est.map(e => [e.id, e])), nomeEmp = new Map(emp.map(e => [e.id, e.nome])), nomeUs = new Map(us.map(u => [u.id, u.nome]));
    const negocios = deals.map(dl => { const it = d.itens[String(dl.ID)] || {}, st = E.get(dl.STAGE_ID), s = situacao(dl, st), ck = it.checklist || [];
      return { id: String(dl.ID), titulo: dl.TITLE, etapa: dl.STAGE_ID, empresaId: String(dl.COMPANY_ID || ''), empresaNome: nomeEmp.get(String(dl.COMPANY_ID)) || '', responsavel: String(dl.ASSIGNED_BY_ID || ''), responsavelNome: nomeUs.get(String(dl.ASSIGNED_BY_ID)) || '', prazo: prazoDe(dl), situacao: s,
        checklist: { feitos: ck.filter(c => c.ok).length, total: ck.length }, cobranca: it.cobranca ? { entradaPaga: pago(it.cobranca.entradaId), finalPaga: pago(it.cobranca.finalId) } : null, aprovacoes: (it.aprovacoes || []).filter(a => a.decisao === 'aprovado').length, bkn: it.bkn || '', origem: it.origem || '', url: f.local ? urlDeal(it.dealId) : `https://${host()}/crm/deal/details/${dl.ID}/`, rodadas: (it.rodadas || []).length }; });
    return { chave: k, nome: f.nome, local: !!f.local, prazoRotulo: f.prazo, dupla: f.dupla || '', etapas: est.map(e => ({ id: e.id, nome: e.nome, semantica: e.semantica })), negocios, hoje: hoje(), usuarios: us, host: host() };
  }
  function aprovacoesValidas(it) { const l = it.aprovacoes || []; let ini = 0; for (let i = l.length - 1; i >= 0; i--) if (l[i].decisao === 'reprovado') { ini = i + 1; break; } return new Set(l.slice(ini).filter(a => a.decisao === 'aprovado').map(a => a.por)); }
  async function negocio(k, id) {
    const f = cfg(k); let r, est;
    if (f.local) { const x = loc(k, id); r = { TITLE: x.titulo, STAGE_ID: x.etapa, COMPANY_ID: x.empresaId, ASSIGNED_BY_ID: x.responsavel, CLOSEDATE: x.prazo, COMMENTS: x.comentarios }; est = f.etapas; }
    else { const cat = catOk(f); r = (await bitrix.call('crm.deal.get', { id })).result; need(r && String(r.CATEGORY_ID) === String(cat), 'Negócio não encontrado neste processo.', 404); est = await funil.estagios(cat); }
    const it = item(id); if (!it.checklist) { it.checklist = f.checklist.map(t => ({ t, ok: false })); save(); }
    const docs = (f.documentos || []).map(nome => { const l = (it.links || []).find(x => norm(x.nome) === norm(nome)); return { nome, url: l ? l.url : '' }; });
    return { id: String(id), titulo: r.TITLE, etapa: r.STAGE_ID, etapaNome: (est.find(e => e.id === r.STAGE_ID) || {}).nome || '', empresaId: String(r.COMPANY_ID || ''), responsavel: String(r.ASSIGNED_BY_ID || ''), prazo: String(r.CLOSEDATE || '').slice(0, 10), comentarios: r.COMMENTS || '', ...it, aprovadoresValidos: aprovacoesValidas(it).size, dupla: f.dupla || '', cobravel: COBRA.has(k), cobranca: cobrancaDe(it), comIa: COM_IA.has(k), ia: (it.ia || []).slice(-5).reverse(), regrasIa: COM_IA.has(k) ? IA.REGRAS : [], empresaFaturaId: d.config.empresaFaturaId || '', url: f.local ? urlDeal(it.dealId) : `https://${host()}/crm/deal/details/${id}/`,
      local: !!f.local, campos: f.campos || [], valores: it.campos || {}, documentos: docs, camposIa: f.local && COM_IA.has(k) ? IA.CAMPOS : [], calculo: it.calculo || null, comCalculadora: k === 'rotulagem', dadosIa: it.dados || {}, rodadas: it.rodadas || [], comRodadas: !!(f.etapas || []).some(e => e.exigeConferencia) };
  }
  const quem = u => (u && (u.nome || u.usuario)) || 'sistema', agora = () => new Date().toISOString();
  async function criarDeal(k, b, origem) {
    const f = cfg(k), titulo = txt(b.titulo, 250); need(titulo.length >= 3, 'Informe um título (mínimo de 3 letras).');
    if (b.prazo) need(/^\d{4}-\d{2}-\d{2}$/.test(b.prazo), 'Prazo inválido.');
    if (f.local) {
      const n = (d.seq[k] = (d.seq[k] || 0) + 1), id = `${k[0].toUpperCase()}${n}`;
      d.locais[id] = { id, processo: k, titulo, etapa: b.etapa && f.etapas.find(e => e.id === b.etapa) ? b.etapa : f.etapas[0].id, empresaId: String(b.empresaId || '').replace(/\D/g, ''), responsavel: String(b.responsavel || '').replace(/\D/g, ''), prazo: b.prazo || '', comentarios: txt(b.comentarios, 6000), criado: agora() };
      const it = item(id); it.checklist = f.checklist.map(t => ({ t, ok: false })); it.origem = origem || 'manual'; save(); store.log('demandas', `${f.nome}: negócio ${id} criado (${titulo})`); await espelhar(k, id); return id;
    }
    const cat = catOk(f), est = await funil.estagios(cat), fields = { TITLE: titulo, CATEGORY_ID: cat, STAGE_ID: (b.etapa && est.find(e => e.id === b.etapa) ? b.etapa : est[0].id) };
    if (b.empresaId) fields.COMPANY_ID = String(b.empresaId).replace(/\D/g, ''); if (b.prazo) fields.CLOSEDATE = b.prazo; if (b.responsavel) fields.ASSIGNED_BY_ID = String(b.responsavel).replace(/\D/g, ''); if (b.comentarios) fields.COMMENTS = txt(b.comentarios, 6000);
    const id = await funil.criar(fields), it = item(id); it.checklist = f.checklist.map(t => ({ t, ok: false })); it.bkn = txt(b.bkn, 20); it.origem = origem || 'manual'; if (b.de) it.de = txt(b.de, 200); save(); store.log('demandas', `${f.nome}: negócio ${id} criado (${titulo})`); return String(id);
  }
  // Espelho no Bitrix24 (funil "Serviços técnicos"): um negócio por serviço, só com o resumo. Falha aqui nunca trava o processo.
  const RESUMO = { andamento: 'em andamento', aguardando: 'aguardando cliente', concluido: 'concluido', cancelado: 'cancelado' };
  async function espelhar(k, id) {
    const f = cfg(k), x = d.locais[String(id)], it = item(id); if (!f.local || !x || !bitrix.enabled) return;
    try {
      const cat = f.cat; if (!cat) { it.sincErro = 'Funil de serviços técnicos não configurado.'; save(); return; }
      const est = await funil.estagios(cat), e = f.etapas.find(y => y.id === x.etapa) || {}, alvo = est.find(y => norm(y.nome) === norm(RESUMO[e.resumo] || '~')) || est.find(y => norm(y.nome).includes(norm(RESUMO[e.resumo] || '~')));
      if (!alvo) { it.sincErro = 'O funil "Serviços técnicos" ainda não foi preparado (use Preparar funil em Configurações).'; save(); return; }
      const fields = { TITLE: `[${f.resumo}] ${x.titulo}`.slice(0, 250), STAGE_ID: alvo.id, COMMENTS: `Gerido no app Nutrimix (${f.nome}, cartão ${x.id}). Etapa no app: ${e.nome || ''}.` };
      if (x.empresaId) fields.COMPANY_ID = x.empresaId; if (x.responsavel) fields.ASSIGNED_BY_ID = x.responsavel; if (x.prazo) fields.CLOSEDATE = x.prazo;
      if (it.dealId) await bitrix.call('crm.deal.update', { id: it.dealId, fields }); else it.dealId = await funil.criar({ ...fields, CATEGORY_ID: cat });
      it.sincErro = ''; save();
    } catch (er) { it.sincErro = String(er.message || er).slice(0, 200); save(); }
  }
  // ---------- alertas de prazo ----------
  async function avisar({ simular = false } = {}) {
    const out = { enviados: [], erros: [] };
    for (const k of Object.keys(FUNIS)) {
      const f = cfg(k); if ((!f.cat && !f.local) || !bitrix.enabled) continue;
      let q; try { q = await quadro(k); } catch (e) { out.erros.push(`${k}: ${e.message}`); continue; }
      const E = new Map(q.etapas.map(e => [e.id, e]));
      for (const n of q.negocios) {
        const st = E.get(n.etapa); if (!n.prazo || (st && ['S', 'F'].includes(st.semantica)) || n.situacao.dias === null) continue;
        const key = `${k}|${n.id}|${n.prazo}`, m = B.avisoDevido(n.situacao.dias, f.avisos, d.avisos[key] || []); if (m === null) continue;
        const x = n.situacao.dias, msg = x < 0 ? `[${f.nome}] "${n.titulo}": prazo VENCIDO há ${-x} dia(s) (${n.prazo}).` : x === 0 ? `[${f.nome}] "${n.titulo}": o prazo é HOJE.` : `[${f.nome}] "${n.titulo}": prazo em ${x} dia(s) (${n.prazo}).`;
        if (simular) { out.enviados.push({ processo: k, id: n.id, msg }); continue; }
        if (!n.responsavel) { out.erros.push(`${n.titulo}: sem responsável`); continue; }
        try { await bitrix.call('im.notify.personal.add', { USER_ID: n.responsavel, MESSAGE: n.url ? `${msg} [URL=${n.url}]Abrir[/URL]` : msg, TAG: `dem-${k}-${n.id}-${m}` }); (d.avisos[key] ||= []).push(m); save(); out.enviados.push({ processo: k, id: n.id, msg }); } catch (e) { out.erros.push(`${n.titulo}: ${e.message}`); }
      }
    }
    return out;
  }

  // ---------- entrada de solicitações por e-mail (sem senha de e-mail: quem manda é um script/automação com token) ----------
  const hora = { h: 0, n: 0 };   // teto de e-mails por hora, caso o código vaze
  const hashTok = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  async function entradaEmail(b, token) {
    need(d.entradaHash, 'A entrada por e-mail ainda não foi ativada.', 403);
    const hr = Math.floor(Date.now() / 3600000); if (hora.h !== hr) { hora.h = hr; hora.n = 0; } need(++hora.n <= 300, 'Limite de 300 e-mails por hora atingido na entrada de solicitações.', 429);
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
  // Calculadora de conferência da tabela nutricional e da rotulagem frontal (RDC 429 e IN 75); com negocioId, guarda o resultado no card.
  on('POST', '/rotulagem/calculadora', async (_, __, b, user) => {
    const r = CALC.calcular(b || {}), texto = CALC.relatorioTexto(r);
    if (b && b.negocioId) { const k = 'rotulagem'; await negocio(k, b.negocioId); const it = item(b.negocioId); it.calculo = { em: agora(), por: quem(user), entrada: { base: b.base, porcao: b.porcao, embalagem: b.embalagem, painel: b.painel, energia: b.energia, v100: b.v100, lab: b.lab }, texto }; it.notas.push({ em: agora(), por: quem(user), t: `Calculadora da tabela nutricional executada (${r.alertas.length} alerta(s), frontal ${r.frontal.obrigatoria ? 'obrigatória' : 'não obrigatória'})` }); save(); }
    return { ...r, texto };
  });
  on('GET', '/funis', async () => Object.keys(FUNIS).map(k => ({ chave: k, nome: FUNIS[k].nome, cat: cfg(k).cat || (FUNIS[k].local ? 1 : null), local: !!FUNIS[k].local, modelo: !!FUNIS[k].modelo })));
  on('GET', '/(\\w+)/quadro', async ([k]) => quadro(k));
  on('GET', '/(\\w+)/negocios/([A-Za-z]?\\d+)', async ([k, id]) => negocio(k, id));
  on('POST', '/(\\w+)/negocios', async ([k], _, b) => { const id = await criarDeal(k, b, 'manual'); return negocio(k, id); });
  on('PUT', '/(\\w+)/negocios/([A-Za-z]?\\d+)', async ([k, id], _, b) => {
    const f0 = cfg(k); await negocio(k, id); const f = {}; if (b.titulo !== undefined) { const t = txt(b.titulo, 250); need(t.length >= 3, 'Título muito curto.'); f.TITLE = t; }
    if (b.prazo !== undefined) { need(b.prazo === '' || /^\d{4}-\d{2}-\d{2}$/.test(b.prazo), 'Prazo inválido.'); f.CLOSEDATE = b.prazo || ''; } if (b.responsavel !== undefined) f.ASSIGNED_BY_ID = String(b.responsavel).replace(/\D/g, '');
    if (f0.local) { const x = loc(k, id); if (f.TITLE !== undefined) x.titulo = f.TITLE; if (f.CLOSEDATE !== undefined) x.prazo = f.CLOSEDATE; if (f.ASSIGNED_BY_ID !== undefined) x.responsavel = f.ASSIGNED_BY_ID; if (b.empresaId !== undefined) x.empresaId = String(b.empresaId).replace(/\D/g, ''); save(); await espelhar(k, id); return negocio(k, id); }
    if (Object.keys(f).length) await bitrix.call('crm.deal.update', { id, fields: f }); return negocio(k, id);
  });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/mover', async ([k, id], _, b, user) => {
    const f = cfg(k), n = await negocio(k, id), est = f.local ? f.etapas : await funil.estagios(catOk(f)), alvo = est.find(e => e.id === b.etapa); need(alvo, 'Etapa inválida.');
    const muda = n.etapa !== alvo.id;
    conferePagamento(k, item(id), n, est, alvo);
    if (f.dupla && norm(alvo.nome).includes(norm(f.dupla)) && muda) { const q = aprovacoesValidas(item(id)).size; need(q >= 2, `Dupla checagem: faltam aprovações internas de duas pessoas diferentes antes de "${alvo.nome}" (há ${q}).`, 409); }
    if (f.local && muda) regrasMover(f, item(id), alvo);
    if (f.local) { loc(k, id).etapa = alvo.id; } else await bitrix.call('crm.deal.update', { id, fields: { STAGE_ID: alvo.id } });
    item(id).notas.push({ em: agora(), por: quem(user), t: `Etapa: ${n.etapaNome} → ${alvo.nome}` }); save(); if (f.local) await espelhar(k, id); return negocio(k, id);
  });
  // Regras do passo a passo (só nos processos geridos no app): campos, documentos e conferência obrigatórios antes de certas etapas.
  function regrasMover(f, it, alvo) {
    for (const c of alvo.exigeCampos || []) need(txt((it.campos || {})[c], 300), `Preencha “${rotuloCampo(f, c)}” antes de ir para “${alvo.nome}”.`, 409);
    for (const nome of alvo.exigeDocs || []) need((it.links || []).some(l => norm(l.nome) === norm(nome)), `Anexe o link de “${nome}” (em Links e pastas) antes de ir para “${alvo.nome}”.`, 409);
    if (alvo.exigeConferencia) { const u = (it.rodadas || []).slice(-1)[0]; need(u && u.resultado === 'ok', 'Nunca aprovar um rótulo com pendências: registre uma conferência das correções sem pendências antes da aprovação final.', 409); }
  }
  on('PUT', '/(\\w+)/negocios/([A-Za-z]?\\d+)/campos', async ([k, id], _, b) => {
    const f = cfg(k); need(f.local, 'Este processo não tem campos próprios.'); await negocio(k, id); const it = item(id); it.campos ||= {};
    for (const c of f.campos || []) if (b[c.k] !== undefined) { const v = txt(b[c.k], 300); need(!c.opcoes || v === '' || c.opcoes.includes(v), `Valor inválido em “${c.rotulo}”.`); it.campos[c.k] = v; }
    save(); return negocio(k, id);
  });
  on('PUT', '/(\\w+)/negocios/([A-Za-z]?\\d+)/dados', async ([k, id], _, b) => {   // respostas do questionário do cliente (alimentam o pedido da IA)
    const f = cfg(k); need(f.local && COM_IA.has(k), 'Este processo não usa os dados do questionário.'); await negocio(k, id); const it = item(id); it.dados ||= {};
    for (const c of IA.CAMPOS) if (b[c] !== undefined) it.dados[c] = txt(b[c], 1500);
    save(); return negocio(k, id);
  });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/rodada', async ([k, id], _, b, user) => {   // conferência das correções: repetida até não restar pendência
    const f = cfg(k); need(f.local && (f.etapas || []).some(e => e.exigeConferencia), 'Este processo não tem rodadas de conferência.'); await negocio(k, id);
    need(['ok', 'pendencias'].includes(b.resultado), 'Escolha: sem pendências ou com pendências.'); const t = txt(b.texto, 2000); need(b.resultado === 'ok' || t.length >= 5, 'Descreva as pendências que serão enviadas ao cliente por e-mail.');
    const it = item(id); (it.rodadas ||= []).push({ n: it.rodadas.length + 1, em: agora(), por: quem(user), resultado: b.resultado, texto: t }); it.notas.push({ em: agora(), por: quem(user), t: `Conferência das correções #${it.rodadas.length}: ${b.resultado === 'ok' ? 'sem pendências' : 'com pendências (reenviar ao cliente)'}` }); save(); return negocio(k, id);
  });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/checklist', async ([k, id], _, b) => { await negocio(k, id); const t = txt(b.texto, 200); need(t, 'Escreva o item.'); const it = item(id); it.checklist.push({ t, ok: false }); save(); return negocio(k, id); });
  on('PUT', '/(\\w+)/negocios/([A-Za-z]?\\d+)/checklist/(\\d+)', async ([k, id, i], _, b, user) => { await negocio(k, id); const it = item(id), c = it.checklist[Number(i)]; need(c, 'Item não encontrado.', 404); c.ok = !!b.ok; c.por = c.ok ? quem(user) : ''; c.em = c.ok ? agora() : ''; save(); return negocio(k, id); });
  on('DELETE', '/(\\w+)/negocios/([A-Za-z]?\\d+)/checklist/(\\d+)', async ([k, id, i]) => { await negocio(k, id); item(id).checklist.splice(Number(i), 1); save(); return negocio(k, id); });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/aprovacao', async ([k, id], _, b, user) => {
    await negocio(k, id); need(['aprovado', 'reprovado'].includes(b.decisao), 'Escolha aprovar ou reprovar.'); const por = (user && user.id) || 'sistema';
    const it = item(id); it.aprovacoes.push({ em: agora(), por, nome: quem(user), decisao: b.decisao, nota: txt(b.nota, 500) }); save(); return negocio(k, id);
  });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/nota', async ([k, id], _, b, user) => { await negocio(k, id); const t = txt(b.texto, 1000); need(t, 'Escreva a nota.'); item(id).notas.push({ em: agora(), por: quem(user), t }); save(); return negocio(k, id); });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/link', async ([k, id], _, b) => { await negocio(k, id); const u = urlOk(b.url); need(u, 'Link inválido (use http ou https).'); item(id).links.push({ nome: txt(b.nome, 80) || u, url: u }); save(); return negocio(k, id); });
  on('DELETE', '/(\\w+)/negocios/([A-Za-z]?\\d+)/link/(\\d+)', async ([k, id, i]) => { await negocio(k, id); item(id).links.splice(Number(i), 1); save(); return negocio(k, id); });
  // Conferência por IA (modo assistido): gera o pedido com os dados do cliente e registra o resultado da IA no histórico.
  async function dadosDoCliente(id, k) {
    if (k && FUNIS[k] && FUNIS[k].local) return IA.CAMPOS.filter(c => ((d.itens[String(id)] || {}).dados || {})[c]).map(c => ({ rotulo: c.replace(/^./, x => x.toUpperCase()), valor: d.itens[String(id)].dados[c] }));
    const cn = await funil.camposNegocio(), r = (await bitrix.call('crm.deal.get', { id })).result || {}, out = [];
    for (const rot of IA.CAMPOS) { const f = cn[rot]; if (!f) continue; let v = r[f.cod]; if (Array.isArray(v)) v = v.map(x => f.itens[String(x)] || x).join(', '); else if (v != null && f.itens[String(v)]) v = f.itens[String(v)]; if (v != null && String(v).trim() && String(v) !== '0') out.push({ rotulo: rot.replace(/^./, c => c.toUpperCase()), valor: String(v).slice(0, 1500) }); }
    return out;
  }
  on('GET', '/(\\w+)/negocios/([A-Za-z]?\\d+)/ia/pedido', async ([k, id]) => {
    need(COM_IA.has(k), 'Este processo não tem conferência por IA.'); const n = await negocio(k, id), emp = n.empresaId ? ((await bx.listar().catch(() => [])).find(e => e.id === n.empresaId) || {}).nome : '', dados = await dadosDoCliente(id, k);
    return { pedido: IA.montarPedido({ titulo: n.titulo, empresa: emp, dados }), dados, regras: IA.REGRAS };
  });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/ia/resultado', async ([k, id], _, b, user) => {
    need(COM_IA.has(k), 'Este processo não tem conferência por IA.'); await negocio(k, id);
    const lido = IA.interpretar(b.resposta), itens = Array.isArray(b.itens) && b.itens.length ? b.itens.map(x => ({ n: Number(x.n), status: ['ok', 'atencao', 'erro'].includes(x.status) ? x.status : 'atencao', nota: txt(x.nota, 400) })).filter(x => x.n >= 1 && x.n <= IA.REGRAS.length) : lido.itens;
    need(itens.length || txt(b.resposta, 20000), 'Cole a resposta da IA.'); const it = item(id), reg = { em: agora(), por: quem(user), fonte: txt(b.fonte, 60) || 'IA do cliente (CoPilot do Bitrix24)', resposta: txt(b.resposta, 20000), itens, resumo: txt(b.resumo, 600) || lido.resumo, situacao: IA.situacao(itens), revisado: !!b.revisado };
    (it.ia ||= []).push(reg); it.notas.push({ em: agora(), por: quem(user), t: `Conferência por IA registrada (${reg.situacao === 'ok' ? 'sem apontamentos' : reg.situacao === 'erros' ? 'com erros apontados' : reg.situacao === 'atencao' ? 'com pontos de atenção' : 'sem itens classificados'}) — não substitui a dupla checagem` }); save(); return negocio(k, id);
  });
  on('GET', '/empresas-fatura', async () => (fin ? fin.empresas.all().filter(e => e.ativa !== false && !e.demo).map(e => ({ id: e.id, nome: e.nome })) : []));
  on('GET', '/config', async () => d.config);
  // Prepara (renomeia e ajusta as etapas de) um funil vazio do Bitrix24 para ser o funil único "Serviços técnicos".
  on('POST', '/servicos/preparar', async (_, __, b) => {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409); const simular = b.simular !== false, cat = Number(b.cat || d.config.servicosCat); need(cat > 0, 'Informe o número do funil.');
    const cats = (await bitrix.call('crm.dealcategory.list', { select: ['ID', 'NAME'] })).result || [], c = cats.find(x => String(x.ID) === String(cat)); need(c, `O funil ${cat} não existe neste portal.`, 404);
    const deals = (await bitrix.call('crm.deal.list', { filter: { CATEGORY_ID: cat }, select: ['ID', 'COMMENTS'] })).result || []; need(deals.every(x => /Gerido no app Nutrimix/.test(x.COMMENTS || '')), `O funil "${c.NAME}" tem negócios que não são do app. Escolha um funil vazio.`, 409);
    const rows = (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: `DEAL_STAGE_${cat}` }, order: { SORT: 'ASC' } })).result || [], P = rows.filter(r => !r.SEMANTICS), S = rows.filter(r => r.SEMANTICS === 'S'), Fl = rows.filter(r => r.SEMANTICS === 'F');
    need(P.length && S.length && Fl.length, 'O funil não tem as etapas de início, ganho e perda esperadas.', 409);
    const plano = [{ acao: 'renomear funil', de: c.NAME, para: 'Serviços técnicos' }, { acao: 'renomear etapa', id: P[0].ID, de: P[0].NAME, para: 'Em andamento' }];
    if (P[1]) plano.push({ acao: 'renomear etapa', id: P[1].ID, de: P[1].NAME, para: 'Aguardando cliente' }); else plano.push({ acao: 'criar etapa', para: 'Aguardando cliente' });
    for (const r of P.slice(2)) plano.push({ acao: 'remover etapa', id: r.ID, de: r.NAME });
    plano.push({ acao: 'renomear etapa', id: S[0].ID, de: S[0].NAME, para: 'Concluído' }, { acao: 'renomear etapa', id: Fl[0].ID, de: Fl[0].NAME, para: 'Cancelado' });
    for (const r of [...S.slice(1), ...Fl.slice(1)]) plano.push({ acao: 'remover etapa', id: r.ID, de: r.NAME });
    if (simular) return { simulacao: true, cat, plano };
    for (const x of plano) {
      if (x.acao === 'renomear funil') await bitrix.call('crm.dealcategory.update', { id: cat, fields: { NAME: x.para } });
      else if (x.acao === 'renomear etapa') { if (x.de !== x.para) await bitrix.call('crm.status.update', { id: x.id, fields: { NAME: x.para } }); }
      else if (x.acao === 'criar etapa') await bitrix.call('crm.status.add', { fields: { ENTITY_ID: `DEAL_STAGE_${cat}`, STATUS_ID: `C${cat}:AGUARDA`, NAME: x.para, SORT: 20 } });
      else if (x.acao === 'remover etapa') await bitrix.call('crm.status.delete', { id: x.id });
    }
    d.config.servicosCat = String(cat); save(); await funil.estagios(cat, true); store.log('demandas', `Funil ${cat} preparado como "Serviços técnicos"`);
    return { cat, plano, etapas: (await funil.estagios(cat, true)).map(e => e.nome) };
  });
  // Reenvia ao Bitrix24 o resumo dos cartões que ainda não foram espelhados (por exemplo, criados antes de preparar o funil).
  on('POST', '/servicos/espelhar', async () => { let n = 0; for (const x of Object.values(d.locais)) { await espelhar(x.processo, x.id); n++; } return { cartoes: n, comErro: Object.values(d.locais).filter(x => (d.itens[x.id] || {}).sincErro).length }; });
  on('PUT', '/config', async (_, __, b) => { if (b.empresaFaturaId !== undefined) { need(!b.empresaFaturaId || (fin && fin.empresas.get(String(b.empresaFaturaId))), 'Empresa não encontrada em Contas.'); d.config.empresaFaturaId = String(b.empresaFaturaId || ''); } if (b.suplementosCat !== undefined) d.config.suplementosCat = String(b.suplementosCat).replace(/\D/g, ''); save(); return d.config; });
  // Serviço pontual: gera as duas cobranças (50% entrada + 50% final) em Contas a receber, ligadas ao negócio.
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/cobranca', async ([k, id], _, b, user) => {
    need(COBRA.has(k) && fin, 'Este processo não usa cobrança de serviço pontual.'); const n = await negocio(k, id), it = item(id); need(!it.cobranca, 'Este negócio já tem cobrança gerada.');
    const valor = r2(Number(b.valor)); need(Number.isFinite(valor) && valor >= 2 && valor < 1e8, 'Informe o valor total do serviço.'); const emp = String(b.empresaId || d.config.empresaFaturaId || ''); need(emp && fin.empresas.get(emp), 'Escolha a empresa que vai faturar (Contas).');
    const ok = x => !x || /^\d{4}-\d{2}-\d{2}$/.test(x), hj = hoje(); need(ok(b.vencEntrada) && ok(b.vencFinal), 'Data inválida.');
    const nomeEmp = (await bx.listar().catch(() => [])).find(e => e.id === n.empresaId); const entrada = r2(valor / 2), fim = r2(valor - entrada);
    const ctx = { formas: fin.formas.all(), condicoes: fin.condicoes.all(), hoje: hj }, mk = (desc, v, venc) => { const [l] = C.criarLancamentos({ empresaId: emp, descricao: `${n.titulo} — ${desc}`.slice(0, 200), cliente: (nomeEmp && nomeEmp.nome) || n.titulo, categoria: 'Serviços pontuais', valor: v, venc, forma: 'PIX', parcelas: 1, obs: `Negócio #${id} (${FUNIS[k].nome})` }, 'receber', ctx); return { ...l, demandaId: String(id), demandaProcesso: k }; };
    const l1 = mk('entrada (50%)', entrada, b.vencEntrada || hj), l2 = mk('final (50%)', fim, b.vencFinal || n.prazo || require('./feriados').somaDias(hj, 15));
    fin.receber.add([l1, l2]); it.cobranca = { valor, entradaId: l1.id, finalId: l2.id, liberacoes: [], por: quem(user), em: agora() }; it.notas.push({ em: agora(), por: quem(user), t: `Cobrança gerada: R$ ${valor.toFixed(2).replace('.', ',')} em duas parcelas (entrada e final)` }); save(); store.log('demandas', `Cobrança 50/50 gerada para o negócio ${id}`); return negocio(k, id);
  });
  on('DELETE', '/(\\w+)/negocios/([A-Za-z]?\\d+)/cobranca', async ([k, id]) => { await negocio(k, id); const it = item(id), c = it.cobranca; need(c, 'Não há cobrança neste negócio.'); need(!pago(c.entradaId) && !pago(c.finalId), 'Há parcela já paga: desfaça a baixa em Contas antes de cancelar.', 409); fin.receber.remove(c.entradaId); fin.receber.remove(c.finalId); delete it.cobranca; save(); return negocio(k, id); });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/liberar', async ([k, id], _, b, user) => { await negocio(k, id); const it = item(id), c = it.cobranca; need(c, 'Não há cobrança neste negócio.'); need(['inicio', 'final'].includes(b.qual), 'Escolha o que liberar.'); const motivo = txt(b.motivo, 300); need(motivo.length >= 5, 'Explique o motivo da liberação.'); (c.liberacoes ||= []).push({ qual: b.qual, por: quem(user), em: agora(), motivo }); it.notas.push({ em: agora(), por: quem(user), t: `Liberado sem pagamento (${b.qual === 'inicio' ? 'entrada' : 'final'}): ${motivo}` }); save(); return negocio(k, id); });
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
