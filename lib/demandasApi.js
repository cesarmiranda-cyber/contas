'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./bk');
const C = require('./finCad');
const IA = require('./conferenciaIa');
const CALC = require('./rotulagemCalc');
const POR = require('./porcoes');
const SUP = require('./suplementosCalc');
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
    campos: [{ k: 'orgao', rotulo: 'Órgão autuante (vigilância sanitária)' }, { k: 'numeroAuto', rotulo: 'Nº do auto ou da notificação' }, { k: 'dataCiencia', rotulo: 'Data de ciência', tipo: 'date' }, { k: 'prazoDias', rotulo: 'Prazo legal da defesa (dias corridos)', tipo: 'number' }, { k: 'procedimento', rotulo: 'Ficha de procedimento / orientação usada' }],
    documentos: ['Auto de infração / notificação', 'Defesa protocolada (comprovante)', 'Resposta do órgão'],
    checklist: ['Auto de infração ou notificação recebido e registrado', 'Prazo da defesa conferido e anotado', 'Defesa elaborada', 'Defesa protocolada (comprovante guardado)', 'Resposta do órgão acompanhada'] },
  rotulagem: { nome: 'Rotulagem nutricional', local: true, resumo: 'Rotulagem', prazo: 'Prazo de entrega', avisos: [7, 3, 0], dupla: 'Aprovação final',
    // passo a passo da Nutri Mix: pagamento → conferência → análise da legislação → relatório → envio → conferência das correções (repetida) → aprovação final → arquivamento
    etapas: et([['r1', 'Pagamento e questionário', 'aguardando'], ['r2', 'Conferência das informações', 'andamento'], ['r3', 'Análise da legislação', 'andamento'], ['r4', 'Relatório de adequação', 'andamento', { exigeCampos: ['enquadramento'] }], ['r5', 'Enviado ao cliente (correções)', 'aguardando'], ['r6', 'Conferência das correções', 'andamento'],
      ['r7', 'Aprovação final', 'andamento', { entrega: true, exigeConferencia: true, exigeCampos: ['versaoAprovada'] }], ['r8', 'Concluído e arquivado', 'concluido', { s: 'S', exigeDocs: ['Arte final aprovada', 'E-mail de aprovação final'] }], ['r9', 'Cancelado', 'cancelado', { s: 'F' }]]),
    campos: [{ k: 'enquadramento', rotulo: 'Enquadramento regulatório', opcoes: ['Norma específica do produto (RTIQ/MAPA/Anvisa)', 'Legislação geral: RDC 429/2020, IN 75/2020 e RDC 727/2022'] }, { k: 'norma', rotulo: 'Norma específica aplicada (se houver)' }, { k: 'metodoNutricional', rotulo: 'Como os valores nutricionais foram determinados (RDC 429, art. 32)', opcoes: ['Análise laboratorial com método validado', 'Cálculo a partir dos dados dos fornecedores dos ingredientes', 'Cálculo a partir de tabela de composição de alimentos'] }, { k: 'modeloTabela', rotulo: 'Modelo da tabela nutricional (Anexo IX da IN 75)', opcoes: ['Vertical', 'Horizontal', 'Linear (sem espaço, art. 17)', 'Agregado (embalagem múltipla ou mais de um grupo populacional)'] }, { k: 'frontal', rotulo: 'Rotulagem nutricional frontal (art. 18)', opcoes: ['Obrigatória (declarar a lupa)', 'Não se aplica (abaixo dos limites)', 'Vedada (alimento do Anexo XVI)', 'Opcional (painel principal menor que 35 cm²)'] }, { k: 'versaoAprovada', rotulo: 'Versão da arte aprovada (nome e data do arquivo)' }],
    documentos: ['Questionário preenchido', 'Memória de cálculo da tabela nutricional', 'Relatório de adequação', 'Artes recebidas e corrigidas', 'E-mails de correção', 'Arte final aprovada', 'E-mail de aprovação final'],
    checklist: ['Pagamento de 50% confirmado (clientes pontuais) e questionário enviado', 'Questionário respondido por completo e documentos recebidos', 'Enquadramento definido: norma específica (RTIQ) ou RDC 429, IN 75 e RDC 727', 'Tabela nutricional conferida: método de determinação dos valores, porção, medida caseira, arredondamento, %VD e tolerância de 20%', 'Rotulagem frontal avaliada (obrigatória, não se aplica, vedada ou opcional)', 'Relatório de adequação preenchido no modelo Nutri Mix: o que está errado, o que corrigir e a norma de cada correção', 'Relatório enviado por e-mail, pedindo ao designer todas as correções', 'Nova arte recebida e comparada com o relatório', 'Aprovação final enviada por e-mail, com a versão aprovada identificada', 'Documentos arquivados na pasta do cliente'] },
  fichas: { nome: 'Fichas técnicas (comercial e de preparo)', local: true, resumo: 'Fichas', prazo: 'Prazo de entrega', avisos: [7, 3, 0],
    etapas: et([['f1', 'Pagamento e questionário', 'aguardando'], ['f2', 'Conferência dos dados', 'andamento'], ['f3', 'Elaboração da ficha', 'andamento'], ['f4', 'Revisão interna', 'andamento'], ['f5', 'Validação do cliente', 'aguardando', { entrega: true }], ['f6', 'Concluído e arquivado', 'concluido', { s: 'S' }], ['f7', 'Cancelado', 'cancelado', { s: 'F' }]]),
    campos: [{ k: 'tipoFicha', rotulo: 'Tipo de ficha', opcoes: ['Ficha técnica comercial', 'Ficha técnica de preparo'] }],
    documentos: ['Questionário preenchido', 'Laudos microbiológicos', 'Ficha técnica elaborada', 'Aprovação do cliente (e-mail)'],
    checklist: ['Pagamento de 50% confirmado e questionário enviado', 'Questionário respondido (inclui altura de palete e demais dados logísticos) e laudos microbiológicos recebidos', 'Matérias-primas e dados do produto conferidos', 'Ficha técnica elaborada', 'Revisão interna concluída', 'Ficha enviada ao cliente e validada por e-mail', 'Documentos arquivados na pasta do cliente'] },
  tabelas: { nome: 'Tabela nutricional (avulsa)', local: true, resumo: 'Tabela nutricional', prazo: 'Prazo de entrega', avisos: [7, 3, 0], dupla: 'Entrega ao cliente',
    etapas: et([['t1', 'Pagamento e questionário', 'aguardando'], ['t2', 'Conferência das informações', 'andamento'], ['t3', 'Cálculo da tabela', 'andamento', { exigeCampos: ['metodoNutricional'] }], ['t4', 'Entrega ao cliente', 'aguardando', { entrega: true }], ['t5', 'Concluído e arquivado', 'concluido', { s: 'S' }], ['t6', 'Cancelado', 'cancelado', { s: 'F' }]]),
    campos: [{ k: 'metodoNutricional', rotulo: 'Como os valores nutricionais foram determinados (RDC 429, art. 32)', opcoes: ['Análise laboratorial com método validado', 'Cálculo a partir dos dados dos fornecedores dos ingredientes', 'Cálculo a partir de tabela de composição de alimentos'] }, { k: 'modeloTabela', rotulo: 'Modelo da tabela nutricional (Anexo IX da IN 75)', opcoes: ['Vertical', 'Horizontal', 'Linear (sem espaço, art. 17)', 'Agregado (embalagem múltipla ou mais de um grupo populacional)'] }],
    documentos: ['Questionário preenchido', 'Memória de cálculo da tabela nutricional', 'Tabela nutricional entregue'],
    checklist: ['Pagamento de 50% confirmado e questionário enviado', 'Questionário respondido e fichas das matérias-primas recebidas', 'Método de determinação definido e valores calculados na calculadora', 'Dupla checagem dos valores concluída', 'Tabela entregue com a memória de cálculo', 'Documentos arquivados na pasta do cliente'] },
  manuais: { nome: 'Manuais de boas práticas e documentação', cat: 4, prazo: 'Prazo de entrega', avisos: [7, 3, 0], checklist: ['Segmento e legislação aplicável definidos', 'Modelo base escolhido', 'Documento elaborado', 'Revisão técnica', 'Entregue ao cliente'] },
  solicitacoes: { nome: 'Solicitações (e-mail e formulários)', cat: 17, prazo: 'Prazo', avisos: [3, 0], checklist: ['Unidade (BKN) identificada', 'Pedido entendido e classificado', 'Dados e documentos completos'] },
  suplementos: { nome: 'Suplementos (notificação na Anvisa)', local: true, resumo: 'Suplementos', prazo: 'Prazo', avisos: [7, 3, 0], modelo: true,
    etapas: et([['s1', 'Solicitação dos documentos', 'aguardando'], ['s2', 'Adequação da ordem de produção', 'andamento'], ['s3', 'Teste de cápsula e estudo de estabilidade', 'aguardando'], ['s4', 'Memorial de cálculo', 'andamento'], ['s5', 'Documentação de estabilidade', 'andamento'], ['s6', 'Notificação na Anvisa (Solicita)', 'andamento', { exigeCampos: ['estabilidade'] }],
      ['s7', 'Finalização (comprovante e arquivo)', 'concluido', { s: 'S', entrega: true, exigeCampos: ['protocoloSolicita'], exigeDocs: ['Comprovante do protocolo'] }], ['s8', 'Cancelado', 'cancelado', { s: 'F' }]]),
    campos: [{ k: 'estabilidade', rotulo: 'Documentação de estabilidade', opcoes: ['Relatório de estabilidade do cliente', 'Protocolo de estabilidade + dossiê técnico (aguardando laboratório)'] }, { k: 'protocoloSolicita', rotulo: 'Nº do protocolo no Solicita (Anvisa)' }],
    documentos: ['Ordem de produção', 'Memorial de cálculo', 'Rótulo', 'Protocolo de estabilidade', 'Relatório / dossiê', 'Comprovante do protocolo'],
    checklist: ['Formulação e fichas técnicas das matérias-primas recebidas', 'Ordem de produção analisada e adequada (modelo Nutri Mix, legislação Anvisa)', 'Teste de cápsula feito pelo cliente', 'Amostras enviadas ao laboratório (estudo de estabilidade)', 'Memorial de cálculo elaborado (formulação final e estabilidade)', 'Estabilidade: relatório do cliente OU protocolo + dossiê técnico', 'Documentação e requisitos regulatórios conferidos', 'Notificação preenchida e protocolada no Solicita', 'Comprovante enviado ao cliente', 'Documentos do processo arquivados'] },
};
const COM_IA = new Set(['rotulagem', 'suplementos']);
const COM_CALC = new Set(['rotulagem', 'tabelas']);   // calculadora da tabela nutricional (RDC 429 + IN 75)   // conferência assistida por IA (a IA do cliente)
const COBRA = new Set(['rotulagem', 'manuais', 'suplementos', 'fichas', 'tabelas']);   // serviços pontuais: 50% antes de começar, 50% antes de entregar
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const urlOk = u => { try { const x = new URL(String(u)); return ['http:', 'https:'].includes(x.protocol) ? x.href : ''; } catch { return ''; } };

function createDemandasApi({ bitrix, bx, funil, bk, fin, store, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'demandas.json');
  let d = { itens: {}, locais: {}, seq: {}, fechados: {}, importados: {}, modelos: [], artigos: [], limites: {}, config: { suplementosCat: '', empresaFaturaId: '', servicosCat: '12', paradoDias: 7, gestorIds: [], equipe: {}, questionarios: {}, fechamentoAuto: false, importarFormularios: true, automacoes: {} }, entradaHash: '', formHash: '', vistos: [], avisos: {} };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')), config: { suplementosCat: '', empresaFaturaId: '', servicosCat: '12', paradoDias: 7, gestorIds: [], equipe: {}, questionarios: {}, fechamentoAuto: false, importarFormularios: true, automacoes: {}, ...(JSON.parse(fs.readFileSync(file, 'utf8')).config || {}) } }; } catch { /* primeiro uso */ }
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

  const ultimaAtividade = (it, base) => { const l = [base, it.movidoEm, ...(it.notas || []).map(x => x.em), ...(it.aprovacoes || []).map(x => x.em), ...(it.rodadas || []).map(x => x.em), ...(it.checklist || []).map(x => x.em)].filter(Boolean).map(x => String(x).slice(0, 10)).sort(); return l[l.length - 1] || ''; };
  const bknDe = t => { const m = /BKN\s*[:#\-]?\s*(\d{4,6})/i.exec(String(t || '')); return m ? m[1] : ''; };   // negócio criado por formulário: o BKN vem no título
  const urlDeal = id => (id && bitrix.enabled ? `https://${host()}/crm/deal/details/${id}/` : '');
  async function quadro(k) {
    const f = cfg(k); need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    if (f.local) await sincronizarSeNecessario().catch(() => {});
    let est, deals;
    if (f.local) { est = f.etapas; deals = Object.values(d.locais).filter(x => x.processo === k).map(x => ({ ID: x.id, TITLE: x.titulo, STAGE_ID: x.etapa, COMPANY_ID: x.empresaId, ASSIGNED_BY_ID: x.responsavel, CLOSEDATE: x.prazo })); }
    else { const cat = catOk(f); [est, deals] = await Promise.all([funil.estagios(cat), funil.negocios(cat)]); }
    const [emp, us] = await Promise.all([bx.listar().catch(() => []), usuarios().catch(() => [])]);
    const E = new Map(est.map(e => [e.id, e])), nomeEmp = new Map(emp.map(e => [e.id, e.nome])), nomeUs = new Map(us.map(u => [u.id, u.nome]));
    const negocios = deals.map(dl => { const it = d.itens[String(dl.ID)] || {}, st = E.get(dl.STAGE_ID), s = situacao(dl, st), ck = it.checklist || [];
      return { id: String(dl.ID), titulo: dl.TITLE, etapa: dl.STAGE_ID, empresaId: String(dl.COMPANY_ID || ''), empresaNome: nomeEmp.get(String(dl.COMPANY_ID)) || '', responsavel: String(dl.ASSIGNED_BY_ID || ''), responsavelNome: nomeUs.get(String(dl.ASSIGNED_BY_ID)) || '', prazo: prazoDe(dl), situacao: s,
        checklist: { feitos: ck.filter(c => c.ok).length, total: ck.length }, cobranca: it.cobranca ? { entradaPaga: pago(it.cobranca.entradaId), finalPaga: pago(it.cobranca.finalId) } : null, aprovacoes: (it.aprovacoes || []).filter(a => a.decisao === 'aprovado').length, bkn: it.bkn || (f.local ? '' : bknDe(dl.TITLE)), origem: it.origem || '', url: f.local ? urlDeal(it.dealId) : `https://${host()}/crm/deal/details/${dl.ID}/`, rodadas: (it.rodadas || []).length, prioridade: it.prioridade || 'normal', pronto: f.local ? ((proximoPasso(k, d.locais[String(dl.ID)], false) || {}).nome || '') : '', ultimaAtividade: ultimaAtividade(it, f.local ? (d.locais[String(dl.ID)] || {}).criado : dl.DATE_CREATE), paradoDias: (() => { const u = ultimaAtividade(it, f.local ? (d.locais[String(dl.ID)] || {}).criado : dl.DATE_CREATE); return u ? dias(u, hoje()) : null; })() }; });
    return { chave: k, nome: f.nome, local: !!f.local, paradoLimite: Number(d.config.paradoDias) || 7, prazoRotulo: f.prazo, dupla: f.dupla || '', etapas: est.map(e => ({ id: e.id, nome: e.nome, semantica: e.semantica })), negocios, hoje: hoje(), usuarios: us, host: host() };
  }
  function aprovacoesValidas(it) { const l = it.aprovacoes || []; let ini = 0; for (let i = l.length - 1; i >= 0; i--) if (l[i].decisao === 'reprovado') { ini = i + 1; break; } return new Set(l.slice(ini).filter(a => a.decisao === 'aprovado').map(a => a.por)); }
  async function negocio(k, id) {
    const f = cfg(k); let r, est;
    if (f.local) { const x = loc(k, id); r = { TITLE: x.titulo, STAGE_ID: x.etapa, COMPANY_ID: x.empresaId, ASSIGNED_BY_ID: x.responsavel, CLOSEDATE: x.prazo, COMMENTS: x.comentarios }; est = f.etapas; }
    else { const cat = catOk(f); r = (await bitrix.call('crm.deal.get', { id })).result; need(r && String(r.CATEGORY_ID) === String(cat), 'Negócio não encontrado neste processo.', 404); est = await funil.estagios(cat); }
    const it = item(id); if (!it.checklist) { it.checklist = f.checklist.map(t => ({ t, ok: false })); save(); }
    const docs = (f.documentos || []).map(nome => { const l = (it.links || []).find(x => norm(x.nome) === norm(nome)); return { nome, url: l ? l.url : '' }; });
    return { id: String(id), titulo: r.TITLE, etapa: r.STAGE_ID, etapaNome: (est.find(e => e.id === r.STAGE_ID) || {}).nome || '', empresaId: String(r.COMPANY_ID || ''), responsavel: String(r.ASSIGNED_BY_ID || ''), prazo: String(r.CLOSEDATE || '').slice(0, 10), comentarios: r.COMMENTS || '', ...it, aprovadoresValidos: aprovacoesValidas(it).size, dupla: f.dupla || '', cobravel: COBRA.has(k), cobranca: cobrancaDe(it), comIa: COM_IA.has(k), ia: (it.ia || []).slice(-5).reverse(), regrasIa: COM_IA.has(k) ? IA.REGRAS : [], empresaFaturaId: d.config.empresaFaturaId || '', url: f.local ? urlDeal(it.dealId) : `https://${host()}/crm/deal/details/${id}/`,
      sugestao: f.local ? proximoPasso(k, d.locais[String(id)], false) : null, local: !!f.local, campos: f.campos || [], valores: it.campos || {}, documentos: docs, camposIa: f.local && COM_IA.has(k) ? IA.CAMPOS : [], calculo: it.calculo || null, comCalculadora: COM_CALC.has(k), formulacao: k === 'suplementos' ? (it.formulacao || { grupo: '19a', capsulasPorDose: 1, dosesPorDia: 1, itens: [] }) : null, memorial: k === 'suplementos' ? it.memorial || null : null, artigosDossie: it.artigos || [], gruposSupl: k === 'suplementos' ? SUP.GRUPOS : [], prioridade: it.prioridade || 'normal', questionarioUrl: (d.config.questionarios || {})[k] || '', dadosIa: it.dados || {}, rodadas: it.rodadas || [], comRodadas: !!(f.etapas || []).some(e => e.exigeConferencia) };
  }
  const quem = u => (u && (u.nome || u.usuario)) || 'sistema', agora = () => new Date().toISOString();
  async function criarDeal(k, b, origem) {
    const f = cfg(k), titulo = txt(b.titulo, 250); need(titulo.length >= 3, 'Informe um título (mínimo de 3 letras).');
    if (b.prazo) need(/^\d{4}-\d{2}-\d{2}$/.test(b.prazo), 'Prazo inválido.');
    if (f.local) {
      const n = (d.seq[k] = (d.seq[k] || 0) + 1), id = `${k[0].toUpperCase()}${n}`;
      d.locais[id] = { id, processo: k, titulo, etapa: b.etapa && f.etapas.find(e => e.id === b.etapa) ? b.etapa : f.etapas[0].id, empresaId: String(b.empresaId || '').replace(/\D/g, ''), responsavel: String(b.responsavel || '').replace(/\D/g, ''), prazo: b.prazo || '', comentarios: txt(b.comentarios, 6000), criado: agora() };
      const it = item(id); it.checklist = f.checklist.map(t => ({ t, ok: false })); it.origem = origem || 'manual'; it.movidoEm = agora(); it.baseDocs = {}; if (['alta', 'normal', 'baixa'].includes(b.prioridade)) it.prioridade = b.prioridade;
      const un = b.bkn && bk ? bk.unidades().find(u => u.bkn === String(b.bkn).replace(/\D/g, '')) : null; if (b.dealId) { it.dealId = String(b.dealId).replace(/\D/g, ''); it.importado = true; } if (b.bkn) it.bkn = txt(b.bkn, 20); if (un && !d.locais[id].empresaId && un.empresaBitrixId) d.locais[id].empresaId = String(un.empresaBitrixId); save(); store.log('demandas', `${f.nome}: negócio ${id} criado (${titulo})`); await espelhar(k, id); return id;
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
      const fields = { TITLE: it.importado ? String(x.titulo).slice(0, 250) : `[${f.resumo}] ${x.titulo}`.slice(0, 250), STAGE_ID: alvo.id };
      if (x.empresaId) fields.COMPANY_ID = x.empresaId; if (x.responsavel) fields.ASSIGNED_BY_ID = x.responsavel; if (x.prazo) fields.CLOSEDATE = x.prazo;
      if (it.dealId) await bitrix.call('crm.deal.update', { id: it.dealId, fields }); else it.dealId = await funil.criar({ ...fields, COMMENTS: `Gerido no app Nutrimix (${f.nome}, cartão ${x.id}). Etapa no app: ${e.nome || ''}.`, CATEGORY_ID: cat });
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
      // cartões abertos sem movimento há muito tempo (o responsável anterior que "deixou de lado") e prazos vencidos: avisa também o gestor
      const limite = Number(d.config.paradoDias) || 7, gestores = (d.config.gestorIds || []).map(String).filter(Boolean);
      for (const n of q.negocios) {
        const st = E.get(n.etapa); if (st && ['S', 'F'].includes(st.semantica)) continue;
        const parado = n.paradoDias != null && n.paradoDias >= limite, venc = n.situacao.estado === 'vencido';
        for (const [tipo, ativo, bucket, msg] of [['parado', parado, parado ? Math.floor(n.paradoDias / limite) : 0, `[${f.nome}] "${n.titulo}": sem movimento há ${n.paradoDias} dia(s).`], ['vencido', venc, n.prazo, `[${f.nome}] "${n.titulo}": prazo vencido há ${-(n.situacao.dias || 0)} dia(s).`]]) {
          if (!ativo) continue; const key = `${k}|${n.id}|${tipo}|${bucket}`; if ((d.avisos[key] || []).length) continue;
          const alvos = [...new Set([n.responsavel, ...gestores].filter(Boolean))];
          if (simular) { out.enviados.push({ processo: k, id: n.id, msg: `${msg} → ${alvos.join(', ') || 'sem destinatário'}` }); continue; }
          if (!alvos.length) { out.erros.push(`${n.titulo}: sem responsável nem gestor`); continue; }
          try { for (const u of alvos) await bitrix.call('im.notify.personal.add', { USER_ID: u, MESSAGE: n.url ? `${msg} [URL=${n.url}]Abrir[/URL]` : msg, TAG: `dem-${tipo}-${k}-${n.id}-${bucket}-${u}` }); d.avisos[key] = ['x']; save(); out.enviados.push({ processo: k, id: n.id, msg }); } catch (e) { out.erros.push(`${n.titulo}: ${e.message}`); }
        }
      }
    }
    for (const m of d.modelos || []) {   // norma que entra em vigor: avisa os gestores para revisar os manuais baseados nela
      if (m.ativo === false || !m.entraEmVigor) continue; const x = dias(hoje(), m.entraEmVigor); const mk = x >= 0 ? [0, 7, 30].find(v => x <= v) : undefined; if (mk === undefined || (d.avisos[`modelo|${m.id}`] || []).includes(mk)) continue;
      const msg = x === 0 ? `Entra em vigor HOJE: ${m.legislacao || m.titulo}. Revise os manuais e POPs baseados no modelo “${m.titulo}”.` : `Entra em vigor em ${x} dia(s) (${m.entraEmVigor}): ${m.legislacao || m.titulo}. Revise os manuais e POPs baseados no modelo “${m.titulo}”.`;
      if (simular) { out.enviados.push({ processo: 'manuais', id: m.id, msg }); continue; }
      const alvos = (d.config.gestorIds || []).map(String).filter(Boolean); if (!alvos.length) { out.erros.push(`${m.titulo}: sem gestor configurado para avisar`); continue; }
      try { for (const u of alvos) await bitrix.call('im.notify.personal.add', { USER_ID: u, MESSAGE: `[Manuais] ${msg}`, TAG: `dem-modelo-${m.id}-${mk}-${u}` }); (d.avisos[`modelo|${m.id}`] ||= []).push(mk); save(); out.enviados.push({ processo: 'manuais', id: m.id, msg }); } catch (e) { out.erros.push(`${m.titulo}: ${e.message}`); }
    }
    return out;
  }

  // ---------- biblioteca de modelos de manuais (segmento, localidade e legislação) ----------
  const diaOk = v => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
  function modeloDe(b, atual = {}) {
    const m = { ...atual, titulo: txt(b.titulo !== undefined ? b.titulo : atual.titulo, 160), segmento: txt(b.segmento !== undefined ? b.segmento : atual.segmento, 80), atividade: txt(b.atividade !== undefined ? b.atividade : atual.atividade, 120), uf: txt(b.uf !== undefined ? b.uf : atual.uf, 2).toUpperCase(), municipio: txt(b.municipio !== undefined ? b.municipio : atual.municipio, 80), legislacao: txt(b.legislacao !== undefined ? b.legislacao : atual.legislacao, 240), versao: txt(b.versao !== undefined ? b.versao : atual.versao, 40), entraEmVigor: txt(b.entraEmVigor !== undefined ? b.entraEmVigor : atual.entraEmVigor, 10), obs: txt(b.obs !== undefined ? b.obs : atual.obs, 400), link: b.link !== undefined ? (b.link ? urlOk(b.link) : '') : (atual.link || '') };
    need(m.titulo.length >= 3, 'Informe o título do modelo.'); need(!b.link || m.link, 'Link inválido (use http ou https).'); need(!m.uf || /^[A-Z]{2}$/.test(m.uf), 'Estado: use a sigla (SP, RJ…).'); need(diaOk(m.entraEmVigor), 'Data de vigência inválida.'); return m;
  }
  const modeloPublico = m => ({ ...m, emVigorEm: m.entraEmVigor && m.entraEmVigor > hoje() ? dias(hoje(), m.entraEmVigor) : null });
  function csvLinhas(texto) {   // aceita ; , ou tabulação (colado da planilha); primeira linha com os nomes das colunas
    const L = String(texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean); if (L.length < 2) return [];
    const sep = [';', '\t', ','].sort((a, b) => L[0].split(b).length - L[0].split(a).length)[0], col = L[0].split(sep).map(c => norm(c).toLowerCase().trim());
    const idx = n => col.findIndex(c => c.includes(n)); const ix = { titulo: idx('titulo'), segmento: idx('segmento'), atividade: idx('atividade'), uf: idx('uf'), municipio: idx('municip'), legislacao: idx('legisla'), link: idx('link'), versao: idx('versao'), entraEmVigor: idx('vigor'), obs: idx('obs') };
    return L.slice(1).map(l => { const c = l.split(sep).map(x => x.trim().replace(/^"|"$/g, '')); return Object.fromEntries(Object.entries(ix).map(([k, i]) => [k, i >= 0 ? c[i] || '' : ''])); });
  }
  // ---------- movimentação automática dos cartões ----------
  // Só avança sozinho quando há prova objetiva (pagamento, formulário, documento ou campo). Decisão humana (aprovar, concluir, resolver) fica manual: vira só uma sugestão de um clique.
  const REGRAS = [
    { id: 'pagamento-questionario', auto: true, nome: 'Entrada de 50% paga + questionário recebido → sai da primeira etapa', rotulo: 'Rotulagem, tabela, fichas e suplementos', processos: { rotulagem: [['r1'], 'r2'], tabelas: [['t1'], 't2'], fichas: [['f1'], 'f2'], suplementos: [['s1'], 's2'] }, quando: c => c.entrada && c.questionario, motivo: 'entrada de 50% paga (ou liberada) e questionário recebido' },
    { id: 'arte-recebida', auto: true, nome: 'Arte corrigida anexada → Conferência das correções', rotulo: 'Rotulagem', processos: { rotulagem: [['r5'], 'r6'] }, quando: c => c.novoDoc('Artes recebidas e corrigidas'), motivo: 'arte corrigida anexada' },
    { id: 'estabilidade-pronta', auto: true, nome: 'Estabilidade definida + relatório/dossiê anexado → Notificação na Anvisa', rotulo: 'Suplementos', processos: { suplementos: [['s5'], 's6'] }, quando: c => c.campo('estabilidade') && c.doc('Relatório / dossiê'), motivo: 'tipo de estabilidade escolhido e relatório/dossiê anexado' },
    { id: 'multa-registrada', auto: true, nome: 'Dados do auto completos → Auto/notificação registrado', rotulo: 'Multas', processos: { multas: [['m1', 'm2'], 'm3'] }, quando: c => c.campo('orgao') && c.campo('numeroAuto') && c.campo('dataCiencia') && (c.doc('Auto de infração / notificação') || /^formulario/.test(c.it.origem || '')), motivo: 'órgão, número do auto, data de ciência e cópia do auto informados' },
    { id: 'defesa-protocolada', auto: true, nome: 'Defesa protocolada anexada → Em cumprimento de prazo', rotulo: 'Multas', processos: { multas: [['m1', 'm2', 'm3', 'm4'], 'm5'] }, quando: c => c.doc('Defesa protocolada (comprovante)'), motivo: 'comprovante da defesa protocolada anexado' },
    { id: 'manual-kickoff', auto: true, nome: 'Entrada paga + questionário do manual → Visita técnica / levantamento', rotulo: 'Manuais (funil Documentação)', bitrix: true },
    { id: 'sugere-aprovacao', auto: false, nome: 'Pronto para a aprovação final', rotulo: 'Rotulagem', processos: { rotulagem: [['r6'], 'r7'] }, quando: c => { const u = (c.it.rodadas || []).slice(-1)[0]; return u && u.resultado === 'ok' && c.aprovadores >= 2 && c.campo('versaoAprovada') && c.finalOk; }, motivo: 'última conferência sem pendências, dupla checagem feita e versão informada' },
    { id: 'sugere-concluir-rotulagem', auto: false, nome: 'Pronto para concluir e arquivar', rotulo: 'Rotulagem', processos: { rotulagem: [['r7'], 'r8'] }, quando: c => c.doc('Arte final aprovada') && c.doc('E-mail de aprovação final'), motivo: 'arte final aprovada e e-mail de aprovação arquivados' },
    { id: 'sugere-entrega-tabela', auto: false, nome: 'Pronto para entregar ao cliente', rotulo: 'Tabela nutricional', processos: { tabelas: [['t3'], 't4'] }, quando: c => c.campo('metodoNutricional') && c.aprovadores >= 2 && !!c.it.calculo, motivo: 'método definido, cálculo registrado e dupla checagem feita' },
    { id: 'sugere-concluir-suplementos', auto: false, nome: 'Pronto para finalizar a notificação', rotulo: 'Suplementos', processos: { suplementos: [['s6'], 's7'] }, quando: c => c.campo('protocoloSolicita') && c.doc('Comprovante do protocolo') && c.finalOk, motivo: 'protocolo informado, comprovante anexado e 50% finais em dia' },
  ];
  const regraLigada = id => (d.config.automacoes || {})[id] !== false;
  const contaDocs = it => { const m = {}; for (const l of it.links || []) { const k = norm(l.nome); m[k] = (m[k] || 0) + 1; } return m; };
  const marcaBase = it => { it.baseDocs = contaDocs(it); };
  function contextoRegra(k, x) {
    const it = item(x.id), docs = contaDocs(it), base = it.baseDocs || {}, co = it.cobranca;
    return { it, k, entrada: !!co && (pago(co.entradaId) || liberado(it, 'inicio')), finalOk: !co || pago(co.finalId) || liberado(it, 'final'), questionario: !!(Object.keys(it.dados || {}).length || it.formDealId), aprovadores: aprovacoesValidas(it).size,
      campo: c => !!txt((it.campos || {})[c], 300), doc: nome => (docs[norm(nome)] || 0) > 0, novoDoc: nome => (docs[norm(nome)] || 0) > (base[norm(nome)] || 0) };
  }
  function viavel(f, k, x, alvo) {   // as mesmas travas do movimento manual
    const it = item(x.id); try { conferePagamento(k, it, { etapa: x.etapa }, f.etapas, alvo); if (f.dupla && norm(alvo.nome).includes(norm(f.dupla)) && aprovacoesValidas(it).size < 2) return false; regrasMover(f, it, alvo); return true; } catch { return false; }
  }
  function proximoPasso(k, x, soAuto) {
    const f = FUNIS[k]; if (!f || !f.local) return null; const c = contextoRegra(k, x);
    for (const r of REGRAS) { const alvoDef = r.processos && r.processos[k]; if (!alvoDef || (soAuto === true && !r.auto) || (soAuto === false && r.auto) || !alvoDef[0].includes(x.etapa) || !regraLigada(r.id)) continue;
      const alvo = f.etapas.find(e => e.id === alvoDef[1]); if (alvo && r.quando(c) && viavel(f, k, x, alvo)) return { regra: r.id, auto: !!r.auto, etapa: alvo.id, nome: alvo.nome, motivo: r.motivo }; }
    return null;
  }
  async function moverAuto(k, x, p) {
    const f = cfg(k), it = item(x.id), de = (f.etapas.find(e => e.id === x.etapa) || {}).nome || x.etapa; x.etapa = p.etapa; it.movidoEm = agora(); marcaBase(it);
    it.notas.push({ em: agora(), por: 'automático', t: `Movido automaticamente: ${de} → ${p.nome} (${p.motivo})` }); save(); await espelhar(k, x.id);
    if (x.responsavel && bitrix.enabled) bitrix.call('im.notify.personal.add', { USER_ID: x.responsavel, MESSAGE: `[${f.nome}] "${x.titulo}" avançou sozinho para "${p.nome}": ${p.motivo}.`, TAG: `dem-auto-${x.id}-${p.etapa}` }).catch(() => {});
    return { processo: k, id: x.id, titulo: x.titulo, de, para: p.nome, motivo: p.motivo };
  }
  async function automatizarCartao(k, id) { const x = d.locais[String(id)]; if (!x || x.processo !== k) return null; const p = proximoPasso(k, x, true); return p ? moverAuto(k, x, p) : null; }
  async function automatizar({ simular = false } = {}) {
    const out = [];
    for (const x of Object.values(d.locais)) { const f = FUNIS[x.processo]; if (!f) continue; const e = f.etapas.find(y => y.id === x.etapa); if (e && ['S', 'F'].includes(e.semantica)) continue; const p = proximoPasso(x.processo, x, true); if (!p) continue;
      out.push(simular ? { processo: x.processo, id: x.id, titulo: x.titulo, de: e && e.nome, para: p.nome, motivo: p.motivo } : await moverAuto(x.processo, x, p)); }
    if (regraLigada('manuais-kickoff') && bitrix.enabled && FUNIS.manuais.cat) {   // manuais: negócio do funil Documentação lido direto do Bitrix24
      try { const cat = FUNIS.manuais.cat, est = await funil.estagios(cat), pri = est[0], seg = est[1], deals = pri && seg ? await funil.negocios(cat, ['UF_CRM_MBP_ESTAB']) : [];
        for (const dl of deals.filter(z => z.STAGE_ID === pri.id && String(z.UF_CRM_MBP_ESTAB || '').trim())) { const it = item(dl.ID), co = it.cobranca; if (!co || !(pago(co.entradaId) || liberado(it, 'inicio'))) continue;
          const motivo = 'entrada de 50% paga (ou liberada) e questionário do manual recebido'; if (simular) { out.push({ processo: 'manuais', id: String(dl.ID), titulo: dl.TITLE, de: pri.nome, para: seg.nome, motivo }); continue; }
          await bitrix.call('crm.deal.update', { id: dl.ID, fields: { STAGE_ID: seg.id } }); it.movidoEm = agora(); it.notas.push({ em: agora(), por: 'automático', t: `Movido automaticamente: ${pri.nome} → ${seg.nome} (${motivo})` }); save(); out.push({ processo: 'manuais', id: String(dl.ID), titulo: dl.TITLE, de: pri.nome, para: seg.nome, motivo }); } } catch { /* funil de manuais indisponível */ }
    }
    return out;
  }
  // ---------- painel do gestor ----------
  const abertoNeg = (q, n) => { const st = q.etapas.find(e => e.id === n.etapa); return !(st && ['S', 'F'].includes(st.semantica)); };
  async function painel() {
    const limite = Number(d.config.paradoDias) || 7, procs = [], pessoas = new Map(), parados = [], vencidos = [], erros = [];
    for (const k of Object.keys(FUNIS)) {
      const f = cfg(k); if (!f.cat && !f.local) continue; let q; try { q = await quadro(k); } catch (e) { erros.push(`${f.nome}: ${e.message}`); continue; }
      const ab = q.negocios.filter(n => abertoNeg(q, n)), P = { chave: k, nome: f.nome, abertos: ab.length, vencidos: 0, vencendo: 0, parados: 0, altas: 0 };
      for (const n of ab) {
        const pa = n.paradoDias != null && n.paradoDias >= limite, ve = n.situacao.estado === 'vencido', vd = n.situacao.estado === 'vencendo', al = n.prioridade === 'alta';
        if (ve) P.vencidos++; if (vd) P.vencendo++; if (pa) P.parados++; if (al) P.altas++;
        const id = n.responsavel || '0', pe = pessoas.get(id) || { id, nome: n.responsavelNome || 'Sem responsável', abertos: 0, altas: 0, vencidos: 0, parados: 0, porProcesso: {} };
        pe.abertos++; if (al) pe.altas++; if (ve) pe.vencidos++; if (pa) pe.parados++; pe.porProcesso[k] = (pe.porProcesso[k] || 0) + 1; pessoas.set(id, pe);
        const linha = { processo: k, processoNome: f.nome, id: n.id, titulo: n.titulo, empresa: n.empresaNome, responsavel: n.responsavelNome, prazo: n.prazo, dias: n.situacao.dias, paradoDias: n.paradoDias, prioridade: n.prioridade };
        if (ve) vencidos.push(linha); if (pa) parados.push(linha);
      }
      procs.push(P);
    }
    parados.sort((a, b) => b.paradoDias - a.paradoDias); vencidos.sort((a, b) => a.dias - b.dias);
    return { limite, processos: procs, pessoas: [...pessoas.values()].sort((a, b) => b.abertos - a.abertos), parados: parados.slice(0, 100), vencidos: vencidos.slice(0, 100), config: { paradoDias: limite, gestorIds: d.config.gestorIds || [], equipe: d.config.equipe || {}, questionarios: d.config.questionarios || {}, fechamentoAuto: !!d.config.fechamentoAuto, importarFormularios: d.config.importarFormularios !== false, automacoes: Object.fromEntries(REGRAS.map(r => [r.id, regraLigada(r.id)])) }, regras: REGRAS.map(r => ({ id: r.id, nome: r.nome, rotulo: r.rotulo, auto: !!r.auto })), usuarios: await usuarios().catch(() => []), erros };
  }
  async function sugerirResponsavel(k) {   // quem tem menos trabalho aberto (alta prioridade pesa 2) entre os que atuam no processo
    const us = await usuarios().catch(() => []), eq = d.config.equipe || {}, doProc = us.filter(u => (eq[u.id] || []).includes(k)), base = doProc.length ? doProc : us.filter(u => Object.keys(eq).length === 0);
    const carga = new Map(); for (const kk of Object.keys(FUNIS)) { const f = cfg(kk); if (!f.cat && !f.local) continue; try { const q = await quadro(kk); for (const n of q.negocios) if (abertoNeg(q, n) && n.responsavel) carga.set(n.responsavel, (carga.get(n.responsavel) || 0) + (n.prioridade === 'alta' ? 2 : 1)); } catch { /* processo sem funil */ } }
    return base.map(u => ({ id: u.id, nome: u.nome, carga: carga.get(u.id) || 0 })).sort((a, b) => a.carga - b.carga).slice(0, 8);
  }
  // ---------- fechamento comercial: negócio ganho no funil comercial vira o cartão do serviço (e a cobrança de 50% de entrada) ----------
  const SERVICO = [[/rotul/i, 'rotulagem'], [/suplement/i, 'suplementos'], [/manual|mbp|\bpops?\b|boas pr/i, 'manuais'], [/fichas? t[eé]cnic/i, 'fichas'], [/tabela nutri/i, 'tabelas'], [/multa|defesa sanit|fiscaliza|auto de infra/i, 'multas']];
  async function fechamento({ simular = true } = {}) {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const est = await funil.estagios(0), ganho = est.filter(e => e.semantica === 'S').map(e => e.id), cn = await funil.camposNegocio(), campo = Object.entries(cn).find(([r]) => /servico (contratado|vendido)|tipo de servico/.test(norm(r).toLowerCase()) || /SERVICO (CONTRATADO|VENDIDO)|TIPO DE SERVICO/.test(norm(r)))?.[1];
    const deals = (await funil.negocios(0, ['OPPORTUNITY', ...(campo ? [campo.cod] : [])])).filter(x => ganho.includes(x.STAGE_ID) && !d.fechados[String(x.ID)]);
    const out = { simulacao: simular, criados: [], semClassificar: [], erros: [] }, emp = new Map((await bx.listar().catch(() => [])).map(e => [e.id, e.nome]));
    for (const dl of deals) {
      let v = campo ? dl[campo.cod] : ''; if (Array.isArray(v)) v = v.map(i => campo.itens[String(i)] || i).join(' '); else if (v != null && campo && campo.itens[String(v)]) v = campo.itens[String(v)];
      const texto = `${v || ''} ${dl.TITLE || ''}`, m = SERVICO.find(([re]) => re.test(texto)); if (!m) { out.semClassificar.push({ id: dl.ID, titulo: dl.TITLE }); continue; }
      const k = m[1], titulo = `${FUNIS[k].resumo || FUNIS[k].nome} — ${emp.get(String(dl.COMPANY_ID)) || dl.TITLE}`.slice(0, 250), valor = Number(dl.OPPORTUNITY) || 0;
      if (simular) { out.criados.push({ negocioComercial: dl.ID, processo: k, titulo, valor }); continue; }
      try {
        const id = await criarDeal(k, { titulo, empresaId: dl.COMPANY_ID, responsavel: dl.ASSIGNED_BY_ID, comentarios: `Origem: negócio comercial #${dl.ID} (${dl.TITLE}).` }, 'comercial'); const it = item(id); it.comercialId = String(dl.ID); it.notas.push({ em: agora(), por: 'sistema', t: `Criado pelo fechamento do negócio comercial #${dl.ID}` });
        let cobrado = false; if (COBRA.has(k) && valor >= 2 && fin && d.config.empresaFaturaId) { try { await gerarCobranca(k, id, { valor }, { nome: 'sistema' }); cobrado = true; } catch (e) { out.erros.push(`${titulo}: cobrança — ${e.message}`); } }
        d.fechados[String(dl.ID)] = { k, id, em: agora() }; save(); out.criados.push({ negocioComercial: dl.ID, processo: k, id, titulo, valor, cobrado });
      } catch (e) { out.erros.push(`${titulo}: ${e.message}`); }
    }
    return out;
  }

  // ---------- formulários do Bitrix24: o cliente preenche o formulário (CRM) que cria o negócio no funil "Serviços técnicos"; o app traz esse pedido para o processo ----------
  const valorUf = (dl, f) => { if (!f) return ''; let v = dl[f.cod]; if (Array.isArray(v)) v = v.map(i => f.itens[String(i)] || i).join(', '); else if (v != null && f.itens[String(v)]) v = f.itens[String(v)]; return v == null || String(v).trim() === '' || String(v) === '0' ? '' : String(v).slice(0, 1500); };
  async function importarFormularios({ simular = true, classificar = {} } = {}) {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409); const cat = Number(d.config.servicosCat); need(cat > 0, 'O funil Serviços técnicos não está configurado.', 409);
    const cn = await funil.camposNegocio(), campos = IA.CAMPOS.map(c => [c, cn[c]]).filter(([, f]) => f), codServico = Object.entries(cn).find(([r]) => /SERVICO (CONTRATADO|VENDIDO)|TIPO DE SERVICO/.test(norm(r)))?.[1];
    const deals = await funil.negocios(cat, ['COMMENTS', ...campos.map(([, f]) => f.cod), ...(codServico ? [codServico.cod] : [])]);
    const espelhados = new Set(Object.values(d.itens).map(i => i.dealId).filter(Boolean).map(String)), out = { simulacao: simular, criados: [], semClassificar: [], erros: [] };
    const emp = new Map((await bx.listar().catch(() => [])).map(e => [e.id, e.nome]));
    for (const dl of deals.filter(x => !espelhados.has(String(x.ID)) && !d.importados[String(x.ID)] && !/Gerido no app Nutrimix/.test(x.COMMENTS || ''))) {
      const dados = Object.fromEntries(campos.map(([c, f]) => [c, valorUf(dl, f)]).filter(([, v]) => v)), texto = `${valorUf(dl, codServico)} ${dl.TITLE || ''}`, m = SERVICO.find(([re]) => re.test(texto)), k = classificar[String(dl.ID)] || (m ? m[1] : (dados['nome do produto'] || dados['ingredientes e quantidades (g)'] ? 'rotulagem' : null));
      if (!k || !FUNIS[k] || !FUNIS[k].local) { out.semClassificar.push({ id: dl.ID, titulo: dl.TITLE }); continue; }
      const titulo = String(dl.TITLE || dados['nome do produto'] || 'Pedido do formulário').slice(0, 250);
      // o cliente já tem cartão aberto deste serviço (criado no fechamento comercial, aguardando o questionário)? Então as respostas vão para ele, sem duplicar.
      const aberto = x => { const e = (FUNIS[k].etapas || []).find(y => y.id === x.etapa); return !(e && ['S', 'F'].includes(e.semantica)); };
      const ja = dl.COMPANY_ID && Object.values(d.locais).filter(x => x.processo === k && x.empresaId === String(dl.COMPANY_ID) && aberto(x) && !Object.keys(item(x.id).dados || {}).length).pop();
      if (ja) {
        if (simular) { out.criados.push({ negocioBitrix: dl.ID, processo: k, titulo, respostas: Object.keys(dados).length, anexadoAo: ja.id }); continue; }
        const it = item(ja.id); it.dados = dados; it.formDealId = String(dl.ID); it.notas.push({ em: agora(), por: 'formulário do Bitrix24', t: `Questionário recebido pelo formulário (negócio #${dl.ID} do Bitrix24): ${Object.keys(dados).length} resposta(s) anexada(s) a este cartão` }); d.importados[String(dl.ID)] = { k, id: ja.id, anexado: true, em: agora() }; save();
        try { await bitrix.call('crm.deal.update', { id: dl.ID, fields: { COMMENTS: `${dl.COMMENTS || ''}\n[Respostas incorporadas ao cartão ${ja.id} do app Nutrimix. Este negócio pode ser arquivado.]`.trim() } }); } catch { /* o aviso no Bitrix24 é só uma ajuda */ }
        out.criados.push({ negocioBitrix: dl.ID, processo: k, id: ja.id, titulo, respostas: Object.keys(dados).length, anexadoAo: ja.id }); continue;
      }
      if (simular) { out.criados.push({ negocioBitrix: dl.ID, processo: k, titulo, respostas: Object.keys(dados).length }); continue; }
      try { const id = await criarDeal(k, { titulo, empresaId: dl.COMPANY_ID, responsavel: dl.ASSIGNED_BY_ID, comentarios: dl.COMMENTS || '', dealId: dl.ID }, 'formulario-bitrix'), it = item(id); if (Object.keys(dados).length) it.dados = dados;
        it.notas.push({ em: agora(), por: 'formulário do Bitrix24', t: `Pedido trazido do negócio #${dl.ID} do Bitrix24 (${Object.keys(dados).length} resposta(s) do questionário)` }); d.importados[String(dl.ID)] = { k, id, em: agora() }; save(); out.criados.push({ negocioBitrix: dl.ID, processo: k, id, titulo, respostas: Object.keys(dados).length }); }
      catch (e) { out.erros.push(`${titulo}: ${e.message}`); }
    }
    return out;
  }
  // Garantia nos dois sentidos: (1) pedidos dos formulários viram cartão no app; (2) todo cartão do app tem o seu negócio no Bitrix24 (refaz se falhou ou se foi apagado).
  async function reconciliarEspelho({ simular = false } = {}) {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409); const cat = Number(d.config.servicosCat), out = { semNegocio: [], refeitos: 0, erros: [] }; if (!cat) return out;
    const ids = new Set((await funil.negocios(cat)).map(x => String(x.ID)));
    for (const x of Object.values(d.locais)) {
      const it = item(x.id), perdeu = !!it.dealId && !ids.has(String(it.dealId)); if (it.dealId && !perdeu && !it.sincErro) continue;
      out.semNegocio.push({ id: x.id, processo: x.processo, titulo: x.titulo, motivo: !it.dealId ? 'ainda não criado no Bitrix24' : perdeu ? 'negócio apagado no Bitrix24' : `falha anterior: ${it.sincErro}` });
      if (simular) continue; if (perdeu) { it.dealId = ''; it.notas.push({ em: agora(), por: 'sistema', t: 'O negócio deste cartão não existe mais no Bitrix24; criado de novo' }); }
      await espelhar(x.processo, x.id); if (it.sincErro) out.erros.push(`${x.titulo}: ${it.sincErro}`); else out.refeitos++;
    }
    return out;
  }
  async function sincronizarServicos({ simular = false, classificar = {} } = {}) { const importar = await importarFormularios({ simular, classificar }), espelho = await reconciliarEspelho({ simular }); return { importar, espelho, automatico: await automatizar({ simular }) }; }
  const sinc = { em: 0, rodando: false };   // ao abrir um processo, sincroniza (no máximo a cada 2 minutos) para a pessoa ver os pedidos dos formulários na hora
  async function sincronizarSeNecessario() {
    if (!bitrix.enabled || d.config.importarFormularios === false || sinc.rodando || Date.now() - sinc.em < 120000) return; sinc.rodando = true;
    try { await sincronizarServicos({ simular: false }); } finally { sinc.rodando = false; sinc.em = Date.now(); }
  }
  // respostas do formulário gravadas no negócio do Bitrix24 (somente leitura): questionários de rotulagem e de manuais
  async function respostasDoBitrix(dealId) {
    const cn = await funil.camposNegocio(), r = (await bitrix.call('crm.deal.get', { id: dealId })).result || {};
    return Object.entries(cn).filter(([, f]) => /^UF_CRM_(SOL|MBP)_/.test(f.cod)).map(([rot, f]) => ({ pergunta: rot.replace(/^./, c => c.toUpperCase()), resposta: valorUf(r, f) })).filter(x => x.resposta);
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

  const baseExterna = () => (process.env.VIBE_APP_ID ? `https://vibecode.bitrix24.com/v1/applications/${process.env.VIBE_APP_ID}/api` : '');
  // ---------- entrada pelo formulário do site (mesmo modelo do e-mail: token, sem senha de ninguém no sistema) ----------
  const LOCAIS_FORM = ['rotulagem', 'suplementos', 'fichas', 'tabelas', 'multas'];
  async function entradaFormulario(b, token) {
    need(d.formHash, 'A entrada pelo formulário ainda não foi ativada.', 403);
    const hr = Math.floor(Date.now() / 3600000); if (hora.h !== hr) { hora.h = hr; hora.n = 0; } need(++hora.n <= 300, 'Limite de 300 envios por hora atingido na entrada pelo formulário.', 429);
    const a = Buffer.from(hashTok(token)), c = Buffer.from(d.formHash); need(a.length === c.length && crypto.timingSafeEqual(a, c), 'Token inválido.', 403);
    const k = String(b.processo || 'rotulagem'); need(LOCAIS_FORM.includes(k), `Processo inválido. Use: ${LOCAIS_FORM.join(', ')}.`);
    const mid = txt(b.messageId, 200); if (mid && d.vistos.includes('f:' + mid)) return { duplicado: true };
    const resp = {}; for (const [kk, v] of Object.entries(b.respostas && typeof b.respostas === 'object' ? b.respostas : {})) resp[norm(kk).toLowerCase()] = txt(v, 1500);
    const emp = b.empresa && typeof b.empresa === 'object' ? b.empresa : {}, cnpj = String(emp.cnpj || '').replace(/\D/g, '');
    let achada = null; if (cnpj.length === 14) achada = (await bx.listar().catch(() => [])).find(e => e.cnpj === cnpj) || null;
    const nomeProd = resp['nome do produto'] || '', nomeEmp = achada ? achada.nome : txt(emp.nome, 120), titulo = txt(b.titulo, 250) || `${nomeProd || FUNIS[k].resumo || FUNIS[k].nome}${nomeEmp ? ' — ' + nomeEmp : ''}`;
    const dados = {}, resto = []; for (const c of (COM_IA.has(k) ? IA.CAMPOS : [])) { const nk = norm(c).toLowerCase(); if (resp[nk] != null) { dados[c] = resp[nk]; delete resp[nk]; } }
    for (const [kk, v] of Object.entries(resp)) if (v) resto.push(`${kk}: ${v}`);
    const corpo = [`Recebido pelo formulário do site${emp.email ? ` (${txt(emp.email, 120)})` : ''}.`, !achada && (cnpj || emp.nome) ? `Empresa não encontrada no Bitrix24: ${txt(emp.nome, 120)} ${cnpj}`.trim() : '', resto.length ? '\nRespostas adicionais:\n' + resto.join('\n') : ''].filter(Boolean).join('\n');
    const id = await criarDeal(k, { titulo, empresaId: achada && achada.id, comentarios: corpo, prioridade: ['alta', 'normal', 'baixa'].includes(b.prioridade) ? b.prioridade : 'normal' }, 'formulario');
    if (Object.keys(dados).length) { item(id).dados = dados; } item(id).notas.push({ em: agora(), por: 'formulário do site', t: `Cartão criado pelo formulário (${Object.keys(dados).length} resposta(s) do questionário preenchida(s))` });
    if (mid) { d.vistos.push('f:' + mid); if (d.vistos.length > 5000) d.vistos.splice(0, d.vistos.length - 5000); } save();
    return { id, processo: k, empresaIdentificada: !!achada };
  }
  const routes = [], on = (m, re, h) => routes.push([m, new RegExp(`^/api/dem${re}$`), h]);
  on('GET', '/empresas', async (_, u) => bx.buscar(u.searchParams.get('q') || ''));
  on('GET', '/manuais/modelos', async (_, u) => {
    const q = norm(u.searchParams.get('q') || '').toLowerCase(), seg = norm(u.searchParams.get('segmento') || '').toLowerCase(), uf = String(u.searchParams.get('uf') || '').toUpperCase();
    const l = (d.modelos || []).filter(m => m.ativo !== false && (!seg || norm(m.segmento).toLowerCase() === seg) && (!uf || m.uf === uf || !m.uf) && (!q || norm(`${m.titulo} ${m.segmento} ${m.atividade} ${m.municipio} ${m.legislacao}`).toLowerCase().includes(q)));
    return { modelos: l.map(modeloPublico), segmentos: [...new Set((d.modelos || []).map(m => m.segmento).filter(Boolean))].sort(), ufs: [...new Set((d.modelos || []).map(m => m.uf).filter(Boolean))].sort(), total: (d.modelos || []).length };
  });
  on('POST', '/manuais/modelos', async (_, __, b) => { const m = { id: 'm' + crypto.randomBytes(5).toString('hex'), ...modeloDe(b), ativo: true, criado: agora() }; d.modelos.push(m); save(); return modeloPublico(m); });
  on('POST', '/manuais/modelos/importar', async (_, __, b) => {
    const linhas = csvLinhas(b.texto); need(linhas.length, 'Cole a planilha com a primeira linha de títulos (título, segmento, atividade, UF, município, legislação, link, versão, vigência).'); need(linhas.length <= 500, 'Importe até 500 linhas por vez.');
    let novos = 0, atualizados = 0; const erros = [];
    for (const [i, l] of linhas.entries()) { try { const m = modeloDe(l), ex = d.modelos.find(x => norm(x.titulo) === norm(m.titulo) && x.uf === m.uf && norm(x.segmento) === norm(m.segmento)); if (ex) { Object.assign(ex, modeloDe(l, ex)); atualizados++; } else { d.modelos.push({ id: 'm' + crypto.randomBytes(5).toString('hex'), ...m, ativo: true, criado: agora() }); novos++; } } catch (e) { erros.push(`Linha ${i + 2}: ${e.message}`); } }
    save(); return { novos, atualizados, erros: erros.slice(0, 20) };
  });
  on('PUT', '/manuais/modelos/(\\w+)', async ([id], _, b) => { const m = d.modelos.find(x => x.id === id); need(m, 'Modelo não encontrado.', 404); Object.assign(m, modeloDe(b, m)); if (b.ativo !== undefined) m.ativo = !!b.ativo; save(); return modeloPublico(m); });
  on('DELETE', '/manuais/modelos/(\\w+)', async ([id]) => { const i = d.modelos.findIndex(x => x.id === id); need(i >= 0, 'Modelo não encontrado.', 404); d.modelos.splice(i, 1); save(); return { ok: true }; });
  on('POST', '/manuais/negocios/([A-Za-z]?\\d+)/modelo', async ([id], _, b, user) => {   // aplica o modelo ao cartão: guarda o link e a legislação de referência no histórico
    const m = d.modelos.find(x => x.id === b.modeloId); need(m, 'Modelo não encontrado.', 404); await negocio('manuais', id); const it = item(id);
    if (m.link) { (it.links ||= []).push({ nome: `Modelo base: ${m.titulo}`.slice(0, 80), url: m.link }); } it.modeloBase = { id: m.id, titulo: m.titulo, legislacao: m.legislacao, versao: m.versao };
    it.notas.push({ em: agora(), por: quem(user), t: `Modelo base escolhido: ${m.titulo}${m.legislacao ? ` — legislação: ${m.legislacao}` : ''}${m.versao ? ` (versão ${m.versao})` : ''}` }); save(); return negocio('manuais', id);
  });
  // ---------- suplementos: formulação, memorial de cálculo, limites da norma e artigos para o dossiê ----------
  const limpaItem = x => ({ materiaPrima: txt(x.materiaPrima, 120), ativo: txt(x.ativo, 80), un: ['mg', 'g', 'µg', 'kcal'].includes(x.un) ? x.un : 'mg', qtd: x.qtd === '' || x.qtd == null ? '' : txt(x.qtd, 20), teor: x.teor === '' || x.teor == null ? '' : txt(x.teor, 10), massaMg: x.massaMg === '' || x.massaMg == null ? '' : txt(x.massaMg, 20), fornecedor: txt(x.fornecedor, 100) });
  on('PUT', '/suplementos/negocios/([A-Za-z]?\\d+)/formulacao', async ([id], _, b) => {
    await negocio('suplementos', id); const f = b || {}; need(SUP.GRUPOS.some(g => g[0] === f.grupo), 'Escolha o grupo populacional.'); need(Array.isArray(f.itens) && f.itens.length <= 80, 'Informe os itens da formulação (até 80).');
    const it = item(id); it.formulacao = { grupo: f.grupo, capsulasPorDose: txt(f.capsulasPorDose, 6) || '1', dosesPorDia: txt(f.dosesPorDia, 6) || '1', capacidadeCapsulaMg: txt(f.capacidadeCapsulaMg, 10), lote: txt(f.lote, 10), itens: f.itens.filter(x => x && typeof x === 'object').map(limpaItem).filter(x => x.materiaPrima || x.ativo) }; save(); return negocio('suplementos', id);
  });
  on('POST', '/suplementos/negocios/([A-Za-z]?\\d+)/memorial', async ([id], _, __, user) => {
    await negocio('suplementos', id); const it = item(id); need(it.formulacao && it.formulacao.itens.length, 'Preencha e salve a formulação antes.'); const r = SUP.memorial(it.formulacao, d.limites);
    it.memorial = { em: agora(), por: quem(user), texto: r.texto, alertas: r.alertas, linhas: r.linhas, ordem: r.ordem, grupo: r.grupo }; it.notas.push({ em: agora(), por: quem(user), t: `Memorial de cálculo gerado (${r.alertas.length} alerta(s))` }); save(); return negocio('suplementos', id);
  });
  on('GET', '/suplementos/limites', async () => ({ limites: d.limites || {} }));
  on('PUT', '/suplementos/limites', async (_, __, b) => {   // limites cadastrados pela equipe a partir da norma de suplementos (o sistema não traz esses números)
    const a = txt(b.ativo, 80); need(a, 'Informe o ativo.'); if (b.remover) { delete d.limites[a]; save(); return { limites: d.limites }; }
    const min = b.min === '' || b.min == null ? null : Number(String(b.min).replace(',', '.')), max = b.max === '' || b.max == null ? null : Number(String(b.max).replace(',', '.')); need((min == null || Number.isFinite(min)) && (max == null || Number.isFinite(max)) && (min != null || max != null), 'Informe o mínimo e/ou o máximo por dia.');
    need(['mg', 'g', 'µg'].includes(b.un), 'Unidade: mg, g ou µg.'); d.limites[a] = { min, max, un: b.un, ref: txt(b.ref, 160) }; save(); return { limites: d.limites };
  });
  on('GET', '/suplementos/artigos', async (_, u) => { const q = norm(u.searchParams.get('q') || '').toLowerCase(); return { artigos: (d.artigos || []).filter(a => !q || norm(`${a.ingrediente} ${a.titulo} ${a.nota}`).toLowerCase().includes(q)) }; });
  on('POST', '/suplementos/artigos', async (_, __, b) => { const a = { id: 'a' + crypto.randomBytes(5).toString('hex'), ingrediente: txt(b.ingrediente, 100), titulo: txt(b.titulo, 240), link: urlOk(b.link), ano: txt(b.ano, 4), nota: txt(b.nota, 400), criado: agora() }; need(a.ingrediente && a.titulo, 'Informe o ingrediente e o título do artigo.'); need(!b.link || a.link, 'Link inválido (use http ou https).'); d.artigos.push(a); save(); return a; });
  on('DELETE', '/suplementos/artigos/(\\w+)', async ([id]) => { const i = d.artigos.findIndex(a => a.id === id); need(i >= 0, 'Artigo não encontrado.', 404); d.artigos.splice(i, 1); save(); return { ok: true }; });
  on('POST', '/suplementos/negocios/([A-Za-z]?\\d+)/artigo', async ([id], _, b, user) => {
    const a = d.artigos.find(x => x.id === b.artigoId); need(a, 'Artigo não encontrado.', 404); await negocio('suplementos', id); const it = item(id); (it.artigos ||= []);
    if (!it.artigos.some(x => x.id === a.id)) { it.artigos.push({ id: a.id, ingrediente: a.ingrediente, titulo: a.titulo, link: a.link, ano: a.ano }); it.notas.push({ em: agora(), por: quem(user), t: `Artigo anexado ao dossiê: ${a.ingrediente} — ${a.titulo}` }); save(); } return negocio('suplementos', id);
  });
  on('POST', '/formulario/importar', async (_, __, b) => importarFormularios({ simular: b.simular !== false, classificar: b.classificar && typeof b.classificar === 'object' ? b.classificar : {} }));
  on('GET', '/gestao/sincronia', async () => sincronizarServicos({ simular: true }));
  on('POST', '/gestao/sincronia', async (_, __, b) => { const r = await sincronizarServicos({ simular: false, classificar: b.classificar && typeof b.classificar === 'object' ? b.classificar : {} }); sinc.em = Date.now(); return r; });
  on('GET', '/(\\w+)/negocios/([A-Za-z]?\\d+)/respostas', async ([k, id]) => { const n = await negocio(k, id), dealId = cfg(k).local ? item(id).dealId : id; return { respostas: dealId && bitrix.enabled ? await respostasDoBitrix(dealId).catch(() => []) : [] }; });
  on('GET', '/gestao', async () => painel());
  on('GET', '/gestao/sugestao', async (_, u) => sugerirResponsavel(String(u.searchParams.get('processo') || '')));
  on('PUT', '/gestao/config', async (_, __, b) => {
    if (b.paradoDias !== undefined) { const n = Number(b.paradoDias); need(Number.isInteger(n) && n >= 1 && n <= 90, 'Dias parado: de 1 a 90.'); d.config.paradoDias = n; }
    if (b.gestorIds !== undefined) d.config.gestorIds = [].concat(b.gestorIds).map(x => String(x).replace(/\D/g, '')).filter(Boolean).slice(0, 20);
    if (b.equipe !== undefined) { const eq = {}; for (const [u, l] of Object.entries(b.equipe || {})) if (/^\d{1,10}$/.test(u)) eq[u] = [].concat(l).filter(x => FUNIS[x]); d.config.equipe = eq; }
    if (b.questionarios !== undefined) { const q = {}; for (const [k, u] of Object.entries(b.questionarios || {})) if (FUNIS[k] && u) { need(urlOk(u), `Link inválido do questionário de ${FUNIS[k].nome}.`); q[k] = urlOk(u); } d.config.questionarios = q; }
    if (b.fechamentoAuto !== undefined) d.config.fechamentoAuto = !!b.fechamentoAuto;
    if (b.importarFormularios !== undefined) d.config.importarFormularios = !!b.importarFormularios;
    if (b.automacoes && typeof b.automacoes === 'object') { const a = {}; for (const r of REGRAS) if (b.automacoes[r.id] !== undefined) a[r.id] = !!b.automacoes[r.id]; d.config.automacoes = { ...(d.config.automacoes || {}), ...a }; }
    save(); return d.config;
  });
  on('POST', '/fechamento/processar', async (_, __, b) => fechamento({ simular: b.simular !== false }));
  on('GET', '/(rotulagem|tabelas)/porcoes', async (_, u) => ({ resultados: POR.buscar(u.searchParams.get('q') || '', 15), utensilios: POR.UTENSILIOS, total: POR.LISTA.length }));   // IN 75, Anexos V e VII
  // Calculadora de conferência da tabela nutricional e da rotulagem frontal (RDC 429 e IN 75); com negocioId, guarda o resultado no card.
  on('POST', '/(rotulagem|tabelas)/calculadora', async ([k], __, b, user) => {
    const r = CALC.calcular(b || {}), texto = CALC.relatorioTexto(r);
    if (b && b.negocioId) { await negocio(k, b.negocioId); const it = item(b.negocioId); it.calculo = { em: agora(), por: quem(user), entrada: { base: b.base, porcao: b.porcao, embalagem: b.embalagem, painel: b.painel, energia: b.energia, v100: b.v100, lab: b.lab }, texto }; it.notas.push({ em: agora(), por: quem(user), t: `Calculadora da tabela nutricional executada (${r.alertas.length} alerta(s), frontal ${r.frontal.obrigatoria ? 'obrigatória' : 'não obrigatória'})` }); save(); }
    return { ...r, texto };
  });
  on('GET', '/funis', async () => Object.keys(FUNIS).map(k => ({ chave: k, nome: FUNIS[k].nome, cat: cfg(k).cat || (FUNIS[k].local ? 1 : null), local: !!FUNIS[k].local, modelo: !!FUNIS[k].modelo })));
  on('GET', '/(\\w+)/quadro', async ([k]) => quadro(k));
  on('GET', '/(\\w+)/negocios/([A-Za-z]?\\d+)', async ([k, id]) => negocio(k, id));
  on('POST', '/(\\w+)/negocios', async ([k], _, b) => { const id = await criarDeal(k, b, 'manual'); return negocio(k, id); });
  on('PUT', '/(\\w+)/negocios/([A-Za-z]?\\d+)', async ([k, id], _, b) => {
    const f0 = cfg(k); await negocio(k, id); const f = {}; if (b.titulo !== undefined) { const t = txt(b.titulo, 250); need(t.length >= 3, 'Título muito curto.'); f.TITLE = t; }
    if (b.prazo !== undefined) { need(b.prazo === '' || /^\d{4}-\d{2}-\d{2}$/.test(b.prazo), 'Prazo inválido.'); f.CLOSEDATE = b.prazo || ''; } if (b.responsavel !== undefined) f.ASSIGNED_BY_ID = String(b.responsavel).replace(/\D/g, '');
    if (b.prioridade !== undefined) { need(['alta', 'normal', 'baixa'].includes(b.prioridade), 'Prioridade inválida.'); item(id).prioridade = b.prioridade; save(); }
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
    item(id).movidoEm = agora(); marcaBase(item(id)); item(id).notas.push({ em: agora(), por: quem(user), t: `Etapa: ${n.etapaNome} → ${alvo.nome}` }); save(); if (f.local) await espelhar(k, id); return negocio(k, id);
  });
  // Regras do passo a passo (só nos processos geridos no app): campos, documentos e conferência obrigatórios antes de certas etapas.
  function regrasMover(f, it, alvo) {
    for (const c of alvo.exigeCampos || []) need(txt((it.campos || {})[c], 300), `Preencha “${rotuloCampo(f, c)}” antes de ir para “${alvo.nome}”.`, 409);
    for (const nome of alvo.exigeDocs || []) need((it.links || []).some(l => norm(l.nome) === norm(nome)), `Anexe o link de “${nome}” (em Links e pastas) antes de ir para “${alvo.nome}”.`, 409);
    if (alvo.exigeConferencia) { const u = (it.rodadas || []).slice(-1)[0]; need(u && u.resultado === 'ok', 'Nunca aprovar um rótulo com pendências: registre uma conferência das correções sem pendências antes da aprovação final.', 409); }
  }
  on('PUT', '/(\\w+)/negocios/([A-Za-z]?\\d+)/campos', async ([k, id], _, b) => {
    const f = cfg(k); need(f.local, 'Este processo não tem campos próprios.'); await negocio(k, id); const it = item(id); it.campos ||= {};
    for (const c of f.campos || []) if (b[c.k] !== undefined) { const v = txt(b[c.k], 300); need(!c.opcoes || v === '' || c.opcoes.includes(v), `Valor inválido em “${c.rotulo}”.`); need(c.tipo !== 'date' || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), `Data inválida em “${c.rotulo}”.`); need(c.tipo !== 'number' || v === '' || (Number(v) >= 0 && Number(v) < 1000), `Número inválido em “${c.rotulo}”.`); it.campos[c.k] = v; }
    const x = d.locais[String(id)]; if (x && it.campos.dataCiencia && it.campos.prazoDias && !x.prazo) { x.prazo = require('./feriados').somaDias(it.campos.dataCiencia, Number(it.campos.prazoDias)); item(id).notas.push({ em: agora(), por: 'sistema', t: `Prazo da defesa calculado: ${x.prazo} (ciência + ${it.campos.prazoDias} dias)` }); await espelhar(k, id); }
    save(); await automatizarCartao(k, id); return negocio(k, id);
  });
  on('PUT', '/(\\w+)/negocios/([A-Za-z]?\\d+)/dados', async ([k, id], _, b) => {   // respostas do questionário do cliente (alimentam o pedido da IA)
    const f = cfg(k); need(f.local && COM_IA.has(k), 'Este processo não usa os dados do questionário.'); await negocio(k, id); const it = item(id); it.dados ||= {};
    for (const c of IA.CAMPOS) if (b[c] !== undefined) it.dados[c] = txt(b[c], 1500);
    save(); await automatizarCartao(k, id); return negocio(k, id);
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
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/link', async ([k, id], _, b) => { await negocio(k, id); const u = urlOk(b.url); need(u, 'Link inválido (use http ou https).'); item(id).links.push({ nome: txt(b.nome, 80) || u, url: u }); save(); await automatizarCartao(k, id); return negocio(k, id); });
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
    const lido = IA.interpretar(b.resposta), itens = Array.isArray(b.itens) && b.itens.length ? b.itens.filter(x => x && typeof x === 'object').map(x => ({ n: Number(x.n), status: ['ok', 'atencao', 'erro'].includes(x.status) ? x.status : 'atencao', nota: txt(x.nota, 400) })).filter(x => x.n >= 1 && x.n <= IA.REGRAS.length) : lido.itens;
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
  async function gerarCobranca(k, id, b, user) {
    need(COBRA.has(k) && fin, 'Este processo não usa cobrança de serviço pontual.'); const n = await negocio(k, id), it = item(id); need(!it.cobranca, 'Este negócio já tem cobrança gerada.');
    const valor = r2(Number(b.valor)); need(Number.isFinite(valor) && valor >= 2 && valor < 1e8, 'Informe o valor total do serviço.'); const emp = String(b.empresaId || d.config.empresaFaturaId || ''); need(emp && fin.empresas.get(emp), 'Escolha a empresa que vai faturar (Contas).');
    const ok = x => !x || /^\d{4}-\d{2}-\d{2}$/.test(x), hj = hoje(); need(ok(b.vencEntrada) && ok(b.vencFinal), 'Data inválida.');
    const nomeEmp = (await bx.listar().catch(() => [])).find(e => e.id === n.empresaId); const entrada = r2(valor / 2), fim = r2(valor - entrada);
    const ctx = { formas: fin.formas.all(), condicoes: fin.condicoes.all(), hoje: hj }, mk = (desc, v, venc) => { const [l] = C.criarLancamentos({ empresaId: emp, descricao: `${n.titulo} — ${desc}`.slice(0, 200), cliente: (nomeEmp && nomeEmp.nome) || n.titulo, categoria: 'Serviços pontuais', valor: v, venc, forma: 'PIX', parcelas: 1, obs: `Negócio #${id} (${FUNIS[k].nome})` }, 'receber', ctx); return { ...l, demandaId: String(id), demandaProcesso: k }; };
    const l1 = mk('entrada (50%)', entrada, b.vencEntrada || hj), l2 = mk('final (50%)', fim, b.vencFinal || n.prazo || require('./feriados').somaDias(hj, 15));
    fin.receber.add([l1, l2]); it.cobranca = { valor, entradaId: l1.id, finalId: l2.id, liberacoes: [], por: quem(user), em: agora() }; it.notas.push({ em: agora(), por: quem(user), t: `Cobrança gerada: R$ ${valor.toFixed(2).replace('.', ',')} em duas parcelas (entrada e final)` }); save(); store.log('demandas', `Cobrança 50/50 gerada para o negócio ${id}`); return negocio(k, id);
  }
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/cobranca', async ([k, id], _, b, user) => gerarCobranca(k, id, b, user));
  on('DELETE', '/(\\w+)/negocios/([A-Za-z]?\\d+)/cobranca', async ([k, id]) => { await negocio(k, id); const it = item(id), c = it.cobranca; need(c, 'Não há cobrança neste negócio.'); need(!pago(c.entradaId) && !pago(c.finalId), 'Há parcela já paga: desfaça a baixa em Contas antes de cancelar.', 409); fin.receber.remove(c.entradaId); fin.receber.remove(c.finalId); delete it.cobranca; save(); return negocio(k, id); });
  on('POST', '/(\\w+)/negocios/([A-Za-z]?\\d+)/liberar', async ([k, id], _, b, user) => { await negocio(k, id); const it = item(id), c = it.cobranca; need(c, 'Não há cobrança neste negócio.'); need(['inicio', 'final'].includes(b.qual), 'Escolha o que liberar.'); const motivo = txt(b.motivo, 300); need(motivo.length >= 5, 'Explique o motivo da liberação.'); (c.liberacoes ||= []).push({ qual: b.qual, por: quem(user), em: agora(), motivo }); it.notas.push({ em: agora(), por: quem(user), t: `Liberado sem pagamento (${b.qual === 'inicio' ? 'entrada' : 'final'}): ${motivo}` }); save(); return negocio(k, id); });
  on('PUT', '/suplementos/config', async (_, __, b) => { const c = String(b.suplementosCat || '').replace(/\D/g, ''); d.config.suplementosCat = c; save(); return { suplementosCat: c }; });
  on('GET', '/suplementos/config', async () => d.config);
  on('POST', '/formulario/entrada/token', async () => { const t = crypto.randomBytes(24).toString('base64url'); d.formHash = hashTok(t); save(); store.log('demandas', 'Token da entrada pelo formulário gerado'); return { token: t }; });
  on('GET', '/formulario/entrada/estado', async () => ({ ativa: !!d.formHash, processos: LOCAIS_FORM, base: baseExterna() }));
  on('GET', '/(\\w+)/negocios/([A-Za-z]?\\d+)/dossie', async ([k, id]) => {   // registro de aprovação: linha do tempo completa com selo de integridade (SHA-256 do conteúdo)
    const n = await negocio(k, id), f = cfg(k), it = item(id);
    const conteudo = { processo: f.nome, id: n.id, titulo: n.titulo, etapa: n.etapaNome, empresaId: n.empresaId, prazo: n.prazo, prioridade: n.prioridade, origem: it.origem || '', campos: (f.campos || []).map(c => ({ rotulo: c.rotulo, valor: (it.campos || {})[c.k] || '' })), documentos: n.documentos, links: n.links, aprovacoes: it.aprovacoes || [], rodadas: it.rodadas || [], conferenciaIa: (it.ia || []).map(x => ({ em: x.em, por: x.por, fonte: x.fonte, situacao: x.situacao, resumo: x.resumo, itens: x.itens.filter(i => i.status !== 'ok') })), calculo: it.calculo ? { em: it.calculo.em, por: it.calculo.por, texto: it.calculo.texto } : null, memorial: it.memorial ? { em: it.memorial.em, por: it.memorial.por, texto: it.memorial.texto } : null, artigos: it.artigos || [], cobranca: n.cobranca, checklist: n.checklist, historico: it.notas || [] };
    const emp = n.empresaId ? ((await bx.listar().catch(() => [])).find(e => e.id === n.empresaId) || {}).nome || '' : '';
    return { ...conteudo, empresa: emp, geradoEm: agora(), regrasIa: IA.REGRAS, selo: crypto.createHash('sha256').update(JSON.stringify(conteudo)).digest('hex') };
  });
  on('POST', '/solicitacoes/entrada/token', async () => { const t = crypto.randomBytes(24).toString('base64url'); d.entradaHash = hashTok(t); save(); store.log('demandas', 'Token da entrada por e-mail gerado'); return { token: t }; });
  on('GET', '/solicitacoes/entrada/estado', async () => ({ ativa: !!d.entradaHash, recebidos: d.vistos.length, base: baseExterna() }));
  on('POST', '/avisar', async (_, __, b) => avisar({ simular: !!b.simular }));
  return { avisar, entradaEmail, entradaFormulario, fechamento, importarFormularios, sincronizarServicos, reconciliarEspelho, automatizar, automatizarCartao, proximoPasso, dados: () => d,
    async handle(method, pathname, u, readBody, user) {
      for (const [m, re, h] of routes) { const g = m === method && pathname.match(re); if (g) return { json: await h(g.slice(1), u, ['POST', 'PUT'].includes(method) ? await readBody() : {}, user) }; }
      return null;
    } };
}
module.exports = { createDemandasApi, FUNIS };
