'use strict';
// Solicitações do BK = negócios do funil 18 do Bitrix24. Kanban espelho, tipos de serviço (campo múltiplo), prazos por tipo, documentos,
// checklist de verificação por tipo (bloqueia a mudança de etapa), vínculo com empresa/contato e campos da unidade no formulário do negócio.
const path = require('path');
const B = require('./bk');
const MOD = require('./bkModelos');

const CAT = 18, COD_TIPO_ANTIGO = 'UF_CRM_1795613816', COD_PEDIR = 'UF_CRM_1795615183';
const LICENCA = [['sim', 'Sim'], ['nao', 'Não'], ['pendente', 'Pendente']];
// Campos criados no Bitrix24 (negócios). Nome do campo → UF_CRM_<nome>.
const DEFS = [
  { k: 'tipo', nome: 'BK_TIPO_SERV', rotulo: 'Tipo de Serviço', tipo: 'enumeration', multiplo: true },
  { k: 'prazos', nome: 'BK_PRAZOS', rotulo: 'Prazos por tipo de serviço', tipo: 'string', settings: { ROWS: 5 } },
  { k: 'docData', nome: 'BK_DOCS_DATA', rotulo: 'Data da solicitação de documentos', tipo: 'date' },
  { k: 'receb', nome: 'BK_DOCS_RECEB', rotulo: 'Documentos Recebidos', tipo: 'file', multiplo: true },
  { k: 'nutri', nome: 'BK_DOCS_NUTRI', rotulo: 'Documentos elaborados pela Nutrimix', tipo: 'file', multiplo: true },
  { k: 'bkn', nome: 'BK_BKN', rotulo: 'BKN da unidade', tipo: 'string' },
  { k: 'unidade', nome: 'BK_UNIDADE', rotulo: 'Unidade', tipo: 'string' },
  { k: 'cnpj', nome: 'BK_CNPJ', rotulo: 'CNPJ da unidade', tipo: 'string' },
  { k: 'endereco', nome: 'BK_ENDERECO', rotulo: 'Endereço da unidade', tipo: 'string' },
  { k: 'cep', nome: 'BK_CEP', rotulo: 'CEP da unidade', tipo: 'string' },
  { k: 'cidade', nome: 'BK_CIDADE', rotulo: 'Cidade da unidade', tipo: 'string' },
  { k: 'uf', nome: 'BK_UF', rotulo: 'UF da unidade', tipo: 'string' },
  { k: 'licenca', nome: 'BK_LICENCA', rotulo: 'Licença sanitária', tipo: 'enumeration', lista: LICENCA.map(x => x[1]) },
  { k: 'licVal', nome: 'BK_LIC_VALIDADE', rotulo: 'Validade da licença sanitária', tipo: 'date' },
  { k: 'necRt', nome: 'BK_NECESSITA_RT', rotulo: 'Necessita de RT', tipo: 'enumeration', lista: LICENCA.map(x => x[1]) },
  { k: 'rtNome', nome: 'BK_RT_NOME', rotulo: 'Responsável técnico', tipo: 'string' },
  { k: 'rtCrn', nome: 'BK_RT_CRN', rotulo: 'CRN do RT', tipo: 'string' },
  { k: 'rtVal', nome: 'BK_RT_VALIDADE', rotulo: 'Validade do RT', tipo: 'date' },
  { k: 'rtAnt', nome: 'BK_RT_ANTERIOR', rotulo: 'RT anterior', tipo: 'string' },
  { k: 'virada', nome: 'BK_PREV_VIRADA', rotulo: 'Previsão de virada do RT', tipo: 'date' },
];
const CHECK = { k: 'check', nome: 'BK_CHECK', rotulo: 'Checklist de verificação', tipo: 'enumeration', multiplo: true };
const OBSOLETOS = ['BK_DOCS_SOLIC', 'BK_DOCS_SOLIC_A'];   // primeira versão dos documentos: substituída por Tipo de Serviço + "Pedir a"
const UF = k => 'UF_CRM_' + [...DEFS, CHECK].find(x => x.k === k).nome;
const SECOES = [
  { name: 'bk_unidade', title: 'Unidade BK', campos: ['bkn', 'unidade', 'cnpj', 'endereco', 'cep', 'cidade', 'uf', 'licenca', 'licVal', 'necRt', 'rtNome', 'rtCrn', 'rtVal', 'rtAnt', 'virada'] },
  { name: 'bk_docs', title: 'Documentos', campos: ['docData', 'receb', 'nutri'] },
  { name: 'bk_check', title: 'Checklist de verificação', campos: ['check'] },
];
// Dados da unidade que andam junto com o negócio (app ⇄ Bitrix24).
const SYNC = [
  { k: 'bkn', get: u => u.bkn, set: (u, v) => { u.bkn = String(v).replace(/\s+/g, ''); } }, { k: 'unidade', get: u => u.nome, set: (u, v) => { u.nome = v; } },
  { k: 'cnpj', get: u => u.cnpj, set: (u, v) => { u.cnpj = v.replace(/\D/g, '').slice(0, 14); }, norm: v => String(v || '').replace(/\D/g, '') },
  { k: 'endereco', get: u => u.endereco, set: (u, v) => { u.endereco = v; } }, { k: 'cep', get: u => u.cep, set: (u, v) => { u.cep = v.replace(/\D/g, '').slice(0, 8); }, norm: v => String(v || '').replace(/\D/g, '') },
  { k: 'cidade', get: u => u.cidade, set: (u, v) => { u.cidade = v; } }, { k: 'uf', get: u => u.uf, set: (u, v) => { u.uf = v.toUpperCase().slice(0, 2); }, norm: v => String(v || '').toUpperCase() },
  { k: 'licenca', get: u => u.licenca, set: (u, v) => { u.licenca = v; }, enumer: true }, { k: 'licVal', get: u => u.licencaValidade, set: (u, v) => { u.licencaValidade = v; }, data: true },
  { k: 'necRt', get: u => u.necessitaRt, set: (u, v) => { u.necessitaRt = v; }, enumer: true },
  { k: 'rtNome', get: u => u.rt.nome, set: (u, v) => { u.rt.nome = v; } }, { k: 'rtCrn', get: u => u.rt.crn, set: (u, v) => { u.rt.crn = v; } }, { k: 'rtVal', get: u => u.rt.validade, set: (u, v) => { u.rt.validade = v; }, data: true },
  { k: 'rtAnt', get: u => u.rt.anterior, set: (u, v) => { u.rt.anterior = v; } }, { k: 'virada', get: u => u.previsaoVirada, set: (u, v) => { u.previsaoVirada = v; }, data: true },
];
// Modelo de checklist de verificação (etapa Verificação de documentação), por tipo de serviço. O administrador pode alterar em Configurações.
const CHECKLIST_PADRAO = {
  'Licença sanitária': ['Está dentro da validade?', 'Razão social conforme CNPJ'],
  ASO: ['Foi feito em data não superior a um ano'],
  'Declaração sanitária': ['Foi feita em data não superior a um ano', 'Consta exame parasitológico', 'Consta exame coprocultura'],
  PGR: ['Está dentro da validade'], PCMSO: ['Está dentro da validade'], AVCB: ['Está dentro da validade'],
  'Reciclagem óleo': ['Consta data não superior a um mês'], 'Limpeza caixa de água': ['Consta data não superior a seis meses'], Dedetização: ['Está dentro da validade'], 'Limpeza exaustão': ['Consta data não superior a quatro meses'],
  'Treinamento de boas práticas': ['Já foi aplicado', 'Certificados já foram gerados'],
  'Registro de limpeza': ['Consta data não superior a um mês', 'Está correto e preenchido por completo'],
  'Registro de temperatura': ['Preenchido por completo', 'Temperatura dentro dos parâmetros da legislação sanitária'],
  'Calibração de termômetro': ['Consta data não superior a um ano'], 'Registro de manutenção': ['Consta equipamentos ou estruturas que foram alvo da manutenção'],
  Defesa: ['Contempla todos os pontos indicados em ficha de procedimentos', 'Está datada e assinada'],
  'Visita técnica': ['Foi feito relatório', 'Consta data e horas de duração da visita'],
  'Licenciamento ambiental': ['Atende aos requisitos de licenciamento da ZAMP', 'Está dentro dos parâmetros da legislação ambiental'],
  'Parecer técnico': ['Consta referências ou legislação a respeito do tema tratado'],
};
const nrm = x => String(x == null ? '' : x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digitos = v => String(v || '').replace(/\D/g, '');
const asArr = v => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(x => x && x !== '0');
const bknDe = t => (/BKN\s*[:#\-]?\s*(\d{1,6})/i.exec(String(t || '')) || [])[1] || '';
const dia = v => String(v || '').slice(0, 10);
const brData = iso => (iso ? iso.split('-').reverse().join('/') : '');
const isoData = t => { const s = String(t || '').trim(), a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s), b = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s); return a ? s : b ? `${b[3]}-${b[2]}-${b[1]}` : ''; };
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const need = (c, m, s) => { if (!c) throw bad(m, s); };

function createSolic({ bitrix, bx, funil, cnpjApi, store, getD, save, hoje, dupBkn, ator, dir }) {
  const dirModelos = path.join(dir || '.', 'modelos-bk');
  const d = () => getD();
  const ligado = () => { need(bx && bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.'); };
  let metaCache = { at: 0 };
  async function meta(force) {
    if (!force && Date.now() - metaCache.at < 5 * 60 * 1000) return metaCache.v;
    const f = (await bitrix.call('crm.deal.fields', {})).result || {}, itens = c => ((f[c] || {}).items || []).map(i => ({ id: String(i.ID), nome: String(i.VALUE) }));
    const tem = c => !!f[c], tipoCod = tem(UF('tipo')) ? UF('tipo') : COD_TIPO_ANTIGO;
    metaCache = { at: Date.now(), v: { tem, itens, tipoCod, tipoMultiplo: !!(f[tipoCod] || {}).isMultiple, tipos: itens(tipoCod), faltam: DEFS.filter(x => !tem('UF_CRM_' + x.nome)).map(x => x.rotulo), docsProntos: ['docData', 'receb', 'nutri'].every(k => tem(UF(k))), checkPronto: tem(UF('check')), unidadeProntos: SYNC.every(s => tem(UF(s.k))) } };
    return metaCache.v;
  }
  const arqs = (v, host) => (Array.isArray(v) ? v : v ? [v] : []).map(a => (a && typeof a === 'object' ? { id: String(a.id || a.ID || ''), url: a.showUrl ? (/^https?:/.test(a.showUrl) ? a.showUrl : `https://${host}${a.showUrl}`) : '' } : { id: String(a), url: '' })).filter(a => a.id);
  const indices = () => ({ porBkn: new Map(d().unidades.map(u => [digitos(u.bkn), u])), porEmp: d().unidades.reduce((m, u) => { if (u.empresaBitrixId) (m.get(u.empresaBitrixId) || m.set(u.empresaBitrixId, []).get(u.empresaBitrixId)).push(u); return m; }, new Map()) });
  const unidadeDe = (x, ix) => { const k = digitos(x[UF('bkn')]) || bknDe(x.TITLE); if (k && ix.porBkn.has(k)) return ix.porBkn.get(k); const l = ix.porEmp.get(String(x.COMPANY_ID || '')); return l && l.length === 1 ? l[0] : null; };

  // ---- prazos por tipo (texto "Tipo: dd/mm/aaaa", uma linha por tipo) e checklist (opções "Tipo › item" marcadas) ----
  const lerPrazos = txt => { const o = {}; for (const l of String(txt || '').split(/\r?\n/)) { const m = /^(.+?)\s*[:=]\s*(\S+)\s*$/.exec(l); if (m && isoData(m[2])) o[m[1].trim()] = isoData(m[2]); } return o; };
  const escreverPrazos = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}: ${brData(v)}`).join('\n');
  const chaveItem = (tipo, item) => `${tipo} › ${item}`;
  const modelos = () => d().checklists || CHECKLIST_PADRAO;
  function checklistDe(x, tiposNomes, m) {
    const marcados = new Set(asArr(x[UF('check')])), opcId = new Map(m.itens(UF('check')).map(o => [o.nome, o.id])), prazos = lerPrazos(x[UF('prazos')]), grupos = [];
    for (const t of tiposNomes) {
      const itens = (modelos()[t] || []).map(item => { const chave = chaveItem(t, item), id = opcId.get(chave); return { chave, nome: item, feito: !!(id && marcados.has(id)) }; });
      grupos.push({ tipo: t, prazo: prazos[t] || '', semModelo: !itens.length, itens });
    }
    const todos = grupos.flatMap(g => g.itens), pend = todos.filter(i => !i.feito);
    return { grupos, total: todos.length, feitos: todos.length - pend.length, pendentes: pend.length, semModelo: grupos.filter(g => g.semModelo).map(g => g.tipo) };
  }
  const prazoVencido = (g, h) => g.some(x => x.prazo && x.prazo < h);

  // ---- nomes dos vínculos "Pedir a" (C_<contato> / CO_<empresa>) ----
  async function nomesPedir(deals, emp) {
    const refs = new Set(deals.flatMap(x => asArr(x[COD_PEDIR]))), cIds = [...refs].filter(r => /^C_\d+$/.test(r)).map(r => r.slice(2)), nomes = new Map();
    if (cIds.length) { try { for (const c of (await bitrix.call('crm.contact.list', { filter: { ID: cIds }, select: ['ID', 'NAME', 'LAST_NAME'] })).result || []) nomes.set('C_' + c.ID, [c.NAME, c.LAST_NAME].filter(Boolean).join(' ') || `Contato ${c.ID}`); } catch { /* opcional */ } }
    for (const e of emp) nomes.set('CO_' + e.id, e.nome); return nomes;
  }
  // ---- unidade ⇄ campos do negócio: quem mudou desde a última sincronização vence; se os dois mudaram, vale o Bitrix24 ----
  const valorDeal = (s, x, m) => { const v = x[UF(s.k)]; if (s.enumer) { const o = m.itens(UF(s.k)).find(i => i.id === String(v || '')); const par = o && LICENCA.find(l => l[1] === o.nome); return par ? par[0] : ''; } if (s.data) return dia(v); return String(v == null ? '' : v).trim(); };
  const paraDeal = (s, v, m) => { if (s.enumer) { const nome = (LICENCA.find(l => l[0] === v) || [])[1], o = m.itens(UF(s.k)).find(i => i.nome === nome); return o ? o.id : ''; } return v || ''; };
  async function sincronizarUnidades(deals, m, ix) {
    if (!m.unidadeProntos) return { unidades: 0, negocios: 0 };
    const snaps = (d().solSnap ||= {}); let nu = 0, nn = 0;
    for (const x of deals) {
      const u = unidadeDe(x, ix); if (!u) continue; const sid = String(x.ID), snap = snaps[sid] || null, novoSnap = {}, push = {}; let mudouU = false;
      for (const s of SYNC) {
        const nm = s.norm || (v => String(v == null ? '' : v).trim()), dv = nm(valorDeal(s, x, m)), uv = nm(s.get(u)), sv = snap ? snap[s.k] : undefined; let fin = uv;
        if (sv === undefined) { if (dv && !uv) { s.set(u, valorDeal(s, x, m)); mudouU = true; fin = dv; } else if (uv && dv !== uv) { push[UF(s.k)] = paraDeal(s, s.get(u), m); } }   // 1ª vez: o app é a base; o Bitrix24 só completa o que falta
        else { const dMudou = dv !== sv, uMudou = uv !== sv; if (dMudou && dv !== uv) { s.set(u, valorDeal(s, x, m)); mudouU = true; fin = dv; } else if (uMudou && !dMudou && dv !== uv) push[UF(s.k)] = paraDeal(s, s.get(u), m); }
        novoSnap[s.k] = (s.norm || nm)(fin);
      }
      if (Object.keys(push).length) { try { await bitrix.call('crm.deal.update', { id: sid, fields: push }); nn++; } catch (e) { store.log('erro', `BK: não consegui atualizar o negócio ${sid}: ${e.message}`); continue; } }
      if (mudouU) nu++; snaps[sid] = novoSnap;
    }
    if (nu || nn || Object.keys(snaps).length) save(); return { unidades: nu, negocios: nn };
  }

  // ---- Kanban ----
  async function kanban() {
    ligado(); if (d().checklists === undefined) { try { await salvarChecklists(CHECKLIST_PADRAO); } catch (e) { store.log('erro', `BK: não consegui publicar o checklist padrão no Bitrix24: ${e.message}`); } }
    const m = await meta(), sel = [m.tipoCod, COD_PEDIR, ...DEFS.map(x => 'UF_CRM_' + x.nome), UF('check'), 'DATE_CREATE', 'CONTACT_ID'];
    const [est, deals0, emp] = await Promise.all([funil.estagios(CAT, true), funil.negocios(CAT, sel), bx.listar()]), ix = indices(), h = hoje();
    const sinc = await sincronizarUnidades(deals0, m, ix), deals = deals0, nomeTipo = new Map(m.tipos.map(t => [t.id, t.nome])), pe = new Map(emp.map(e => [e.id, e])), pedirNomes = await nomesPedir(deals, emp);
    const iVerif = est.findIndex(e => /verf?i+c/.test(nrm(e.nome))), idxEtapa = new Map(est.map((e, i) => [e.id, i]));
    const cards = deals.map(x => {
      const un = unidadeDe(x, ix), tipos = asArr(x[m.tipoCod]), tiposNomes = tipos.map(t => nomeTipo.get(t) || t), e = pe.get(String(x.COMPANY_ID || '')), ck = checklistDe(x, tiposNomes, m), prazos = lerPrazos(x[UF('prazos')]);
      const apos = iVerif >= 0 && (idxEtapa.get(x.STAGE_ID) || 0) >= iVerif && !/LOSE$/.test(x.STAGE_ID), docsPed = asArr(x[COD_PEDIR]);
      return { id: String(x.ID), titulo: x.TITLE || `Negócio ${x.ID}`, etapa: x.STAGE_ID, bkn: bknDe(x.TITLE) || digitos(x[UF('bkn')]) || (un ? digitos(un.bkn) : ''), criado: dia(x.DATE_CREATE), url: `https://${bx.host()}/crm/deal/details/${x.ID}/`,
        unidade: un ? { id: un.id, bkn: un.bkn, nome: un.nome, cidade: un.cidade, uf: un.uf, rt: un.rt.nome, cnpj: un.cnpj } : null, empresa: Number(x.COMPANY_ID) ? { id: String(x.COMPANY_ID), nome: e ? e.nome : `Empresa ${x.COMPANY_ID}`, cnpj: e ? e.cnpj : '' } : null, contatoId: Number(x.CONTACT_ID) ? String(x.CONTACT_ID) : '',
        tipos, tiposNomes, prazos, prazoVencido: tiposNomes.some(t => prazos[t] && prazos[t] < h && !/WON$|LOSE$/.test(x.STAGE_ID)), checklist: ck, checklistPendente: apos && ck.pendentes > 0,
        pedir: docsPed.map(r => ({ ref: r, nome: pedirNomes.get(r) || r })), docs: m.docsProntos ? { data: dia(x[UF('docData')]), recebidos: arqs(x[UF('receb')], bx.host()), nutrimix: arqs(x[UF('nutri')], bx.host()), nomes: (d().docsArquivos || {})[String(x.ID)] || [] } : null,
        semEmpresa: !Number(x.COMPANY_ID), semTipo: !tipos.length, semUnidade: !un };
    }).sort((a, b) => (Number(b.semEmpresa || b.semTipo) - Number(a.semEmpresa || a.semTipo)) || Number(b.id) - Number(a.id));
    return { etapas: est.map(e => ({ id: e.id, nome: e.nome, tom: /WON$/.test(e.id) ? 'ok' : /LOSE$/.test(e.id) ? 'n' : '', verificacao: /verf?i+c/.test(nrm(e.nome)), levantamento: nrm(e.nome).includes('levantamento'), envio: nrm(e.nome).includes('envio') })), tipos: m.tipos, multiplo: m.tipoMultiplo, campos: { prontos: !m.faltam.length, faltam: m.faltam, docs: m.docsProntos, check: m.checkPronto, novoTipo: m.tipoCod !== COD_TIPO_ANTIGO }, checklists: modelos(), cards,
      resumo: { total: cards.length, semEmpresa: cards.filter(c => c.semEmpresa).length, semTipo: cards.filter(c => c.semTipo).length, semUnidade: cards.filter(c => c.semUnidade).length, checklistPendente: cards.filter(c => c.checklistPendente).length, prazoVencido: cards.filter(c => c.prazoVencido).length }, sinc };
  }
  const negocio = async id => { const x = (await bitrix.call('crm.deal.get', { id })).result; need(x && String(x.CATEGORY_ID) === String(CAT), 'Negócio não encontrado no funil BK.', 404); return x; };
  const comentario = async (id, texto) => { try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: id, ENTITY_TYPE: 'deal', COMMENT: texto } }); } catch { /* opcional */ } };

  // ---- preparar o Bitrix24: campos, migração do tipo antigo, formulário do funil 18 ----
  async function preparar({ simular }) {
    ligado(); const lista = (await bitrix.call('crm.deal.userfield.list', {})).result || [], tem = new Map(lista.map(f => [f.FIELD_NAME, f])), antigo = tem.get(COD_TIPO_ANTIGO);
    const criar = DEFS.filter(x => !tem.has('UF_CRM_' + x.nome)), obsoletos = OBSOLETOS.filter(n => tem.has('UF_CRM_' + n));
    const cfg = (await bitrix.call('crm.item.details.configuration.get', { entityTypeId: 2, scope: 'C', extras: { dealCategoryId: CAT } })).result || [];
    if (simular) return { simulacao: true, criar: criar.map(x => x.rotulo), remover: obsoletos, formulario: 'Reorganiza o formulário do funil 18 (Tipo de Serviço, Prazos, Unidade BK, Documentos, Checklist)' };
    const criados = []; d().formBackup ||= cfg;
    for (const c of criar) {
      const lst = c.k === 'tipo' ? ((antigo && antigo.LIST) || []).map(i => i.VALUE) : c.lista;
      await bitrix.call('crm.deal.userfield.add', { fields: { FIELD_NAME: c.nome, USER_TYPE_ID: c.tipo, XML_ID: c.nome, EDIT_FORM_LABEL: { br: c.rotulo, en: c.rotulo }, LIST_COLUMN_LABEL: { br: c.rotulo, en: c.rotulo }, LIST_FILTER_LABEL: { br: c.rotulo, en: c.rotulo }, SHOW_IN_LIST: 'Y', EDIT_IN_LIST: 'Y', MULTIPLE: c.multiplo ? 'Y' : 'N',
        ...(lst ? { LIST: lst.map((v, i) => ({ VALUE: v, SORT: (i + 1) * 10, DEF: 'N' })) } : {}), ...(c.settings ? { SETTINGS: c.settings } : {}) } }); criados.push(c.rotulo);
    }
    const removidos = []; for (const n of obsoletos) { try { await bitrix.call('crm.deal.userfield.delete', { id: tem.get('UF_CRM_' + n).ID }); removidos.push(n); } catch { /* mantém */ } }
    metaCache = { at: 0 }; const m = await meta(true), migrados = await migrarTipos(m), formulario = await formularioFunil(cfg, m); save();
    store.log('bk', `Funil BK preparado: ${criados.length} campo(s) criado(s), ${migrados} negócio(s) migrado(s) para Tipo de Serviço`); return { criados, removidos, migrados, formulario };
  }
  async function migrarTipos(m) {   // copia o tipo do campo antigo (valor único) para o novo campo múltiplo
    if (m.tipoCod !== UF('tipo')) return 0; const antigo = ((await bitrix.call('crm.deal.fields', {})).result || {})[COD_TIPO_ANTIGO] || {}, nomeAntigo = new Map((antigo.items || []).map(i => [String(i.ID), String(i.VALUE)])), novo = new Map(m.tipos.map(t => [t.nome, t.id]));
    let n = 0; for (const x of await funil.negocios(CAT, [COD_TIPO_ANTIGO, UF('tipo')])) { const a = asArr(x[COD_TIPO_ANTIGO]); if (!a.length || asArr(x[UF('tipo')]).length) continue; const ids = a.map(i => novo.get(nomeAntigo.get(i))).filter(Boolean); if (ids.length) { await bitrix.call('crm.deal.update', { id: x.ID, fields: { [UF('tipo')]: ids } }); n++; } } return n;
  }
  async function formularioFunil(cfg, m) {
    const secs = JSON.parse(JSON.stringify(cfg)), main = secs.find(s => s.name === 'main') || secs[0]; if (!main) return 'formulário não encontrado';
    const el = n => ({ name: n, optionFlags: '0' }), tem = n => secs.some(s => (s.elements || []).some(e => e.name === n));
    main.elements = (main.elements || []).filter(e => e.name !== COD_TIPO_ANTIGO); if (!tem(UF('tipo'))) { const i = main.elements.findIndex(e => e.name === 'CLIENT'); main.elements.splice(i >= 0 ? i + 1 : main.elements.length, 0, { name: UF('tipo'), optionFlags: '1' }); }
    if (!tem(UF('prazos'))) main.elements.push(el(UF('prazos'))); if (!tem(COD_PEDIR)) main.elements.push({ name: COD_PEDIR, optionFlags: '1' });
    for (const s of SECOES) { const ks = s.campos.filter(k => m.tem(UF(k)) && !tem(UF(k))); if (!ks.length) continue; const ex = secs.find(x => x.name === s.name); if (ex) ex.elements.push(...ks.map(k => el(UF(k)))); else secs.push({ name: s.name, title: s.title, type: 'section', elements: ks.map(k => el(UF(k))) }); }
    await bitrix.call('crm.item.details.configuration.set', { entityTypeId: 2, scope: 'C', extras: { dealCategoryId: CAT }, data: secs }); return 'formulário do funil 18 atualizado';
  }
  // Modelos de checklist por tipo de serviço (um item por linha). As opções entram no campo do Bitrix24; o que está marcado vale como "feito".
  async function salvarChecklists(novos) {
    const limpo = {}; for (const [t, itens] of Object.entries(novos || {})) { const l = [...new Set((Array.isArray(itens) ? itens : String(itens).split(/\r?\n/)).map(x => String(x).replace(/[›\u0000-\u001f]/g, ' ').trim().slice(0, 140)).filter(Boolean))].slice(0, 60); if (l.length) limpo[String(t).slice(0, 80)] = l; }
    d().checklists = limpo; save(); if (!bitrix.enabled) return limpo;
    let m = await meta(true); const faltamTipos = Object.keys(limpo).filter(t => !m.tipos.some(x => x.nome === t));   // tipo novo (ex.: "Declaração sanitária") entra na lista do campo Tipo de Serviço
    if (faltamTipos.length && m.tipoCod === UF('tipo')) { const cp = ((await bitrix.call('crm.deal.userfield.list', { filter: { FIELD_NAME: m.tipoCod } })).result || [])[0]; if (cp) { await bitrix.call('crm.deal.userfield.update', { id: cp.ID, fields: { LIST: [...(cp.LIST || []).map(i => ({ ID: i.ID, VALUE: i.VALUE, SORT: i.SORT, DEF: 'N' })), ...faltamTipos.map((v, i) => ({ VALUE: v, SORT: 45 + i, DEF: 'N' }))] } }); metaCache = { at: 0 }; m = await meta(true); } }
    const todas = Object.entries(limpo).flatMap(([t, l]) => l.map(i => chaveItem(t, i)));
    if (!todas.length) return limpo;
    const lista = (await bitrix.call('crm.deal.userfield.list', { filter: { FIELD_NAME: UF('check') } })).result || [], campo = lista[0];
    if (!campo) { await bitrix.call('crm.deal.userfield.add', { fields: { FIELD_NAME: CHECK.nome, USER_TYPE_ID: 'enumeration', XML_ID: CHECK.nome, EDIT_FORM_LABEL: { br: CHECK.rotulo, en: CHECK.rotulo }, LIST_COLUMN_LABEL: { br: CHECK.rotulo, en: CHECK.rotulo }, SHOW_IN_LIST: 'Y', EDIT_IN_LIST: 'Y', MULTIPLE: 'Y', LIST: todas.map((v, i) => ({ VALUE: v, SORT: (i + 1) * 10, DEF: 'N' })) } }); }
    else { const tem = new Set((campo.LIST || []).map(i => i.VALUE)), novos = todas.filter(v => !tem.has(v)); if (novos.length) await bitrix.call('crm.deal.userfield.update', { id: campo.ID, fields: { LIST: [...(campo.LIST || []).map(i => ({ ID: i.ID, VALUE: i.VALUE, SORT: i.SORT, DEF: 'N' })), ...novos.map((v, i) => ({ VALUE: v, SORT: 1000 + (campo.LIST || []).length * 10 + i * 10, DEF: 'N' }))] } }); }
    metaCache = { at: 0 }; try { const m2 = await meta(true), cfg = (await bitrix.call('crm.item.details.configuration.get', { entityTypeId: 2, scope: 'C', extras: { dealCategoryId: CAT } })).result || []; if (m2.checkPronto && !cfg.some(s => (s.elements || []).some(e => e.name === UF('check')))) await formularioFunil(cfg, m2); } catch { /* opcional */ }
    return limpo;
  }

  // Anexa arquivos a um campo de arquivos do negócio (um por vez, sem apagar os que já estão lá).
  async function anexar(id, campo, lista, user) {
    const m = await meta(); need(m.docsProntos, 'Os campos de documentos ainda não existem. Use "Preparar campos" no Kanban.'); need(lista.length, 'Nenhum arquivo enviado.');
    let total = 0; for (const a of lista) { need(a.dados && /^[A-Za-z0-9+/=\s]+$/.test(a.dados), `O arquivo "${a.nome}" está vazio ou inválido.`); const bytes = Math.floor(a.dados.length * 3 / 4); need(bytes <= 8 * 1048576, `O arquivo "${a.nome}" passa de 8 MB.`); total += bytes; } need(total <= 12 * 1048576, 'O envio passa de 12 MB. Anexe em partes.');
    for (const a of lista) { const x = await negocio(id), atuais = arqs(x[UF(campo)], bx.host()); await bitrix.call('crm.deal.update', { id, fields: { [UF(campo)]: [...atuais.map(f => ({ id: f.id })), { fileData: [a.nome, a.dados.replace(/\s/g, '')] }] } }); }
    const nomes = (d().docsArquivos ||= {}); (nomes[id] ||= []).push(...lista.map(a => ({ campo: campo === 'nutri' ? 'nutrimix' : 'recebidos', nome: a.nome, em: new Date().toISOString(), por: ator(user) }))); if (nomes[id].length > 200) nomes[id].splice(0, nomes[id].length - 200); save();
    await comentario(id, `${campo === 'nutri' ? 'Documentos elaborados pela Nutrimix' : 'Documentos recebidos'} anexados: ${lista.map(a => a.nome).join('; ')}.`); store.log('bk', `Solicitação ${id}: ${lista.length} arquivo(s) anexado(s) em ${campo}`); return lista.length;
  }
  // Dados do card que alimentam os modelos de documentos.
  async function contextoCard(id, user) {
    const m = await meta(), x = await negocio(id), un = unidadeDe(x, indices()), emp = Number(x.COMPANY_ID) ? await bx.porId(x.COMPANY_ID) : null; let contato = '';
    if (Number(x.CONTACT_ID)) { try { const c = (await bitrix.call('crm.contact.get', { id: x.CONTACT_ID })).result || {}; contato = [c.NAME, c.LAST_NAME].filter(Boolean).join(' '); } catch { /* opcional */ } }
    const tipos = asArr(x[m.tipoCod]).map(t => (m.tipos.find(i => i.id === t) || { nome: t }).nome);
    return { x, m, tipos, auto: MOD.autoDe({ unidade: un, empresa: emp, contato, tipos, hoje: hoje(), usuario: ator(user) }) };
  }
  const enviados = () => d().modelosDocs || [];

  // ---- rotas ----
  function rotas(on) {
    on('GET', '/kanban', async () => kanban());
    on('POST', '/kanban/preparar', async (_, __, b) => preparar({ simular: b.simular !== false }));
    on('PUT', '/kanban/checklists', async (_, __, b, user) => { need(!user || user.perfil === 'admin', 'Só o administrador altera os modelos de checklist.', 403); return { checklists: await salvarChecklists(b.checklists) }; });
    on('POST', '/kanban/(\\d+)/mover', async ([id], _, b) => {
      ligado(); const x = await negocio(id), est = await funil.estagios(CAT, true), alvo = est.find(e => e.id === b.etapa); need(alvo, 'Etapa inválida.');
      if (x.STAGE_ID !== alvo.id) {
        const iv = est.findIndex(e => /verf?i+c/.test(nrm(e.nome))), ia = est.findIndex(e => e.id === alvo.id), ic = est.findIndex(e => e.id === x.STAGE_ID);
        if (iv >= 0 && ia > iv && ic <= ia && !/LOSE$/.test(alvo.id)) {   // saindo da verificação (ou pulando-a): o checklist precisa estar todo marcado
          const m = await meta(), nomes = asArr(x[m.tipoCod]).map(t => (m.tipos.find(i => i.id === t) || { nome: t }).nome), ck = checklistDe(x, nomes, m);
          need(!ck.pendentes, `Checklist de verificação incompleto: faltam ${ck.pendentes} item(ns) — ${ck.grupos.filter(g => g.itens.some(i => !i.feito)).map(g => `${g.tipo} (${g.itens.filter(i => !i.feito).length})`).join(', ')}. Marque todos antes de avançar.`, 409);
        }
        await funil.mover(id, alvo.id); store.log('bk', `Solicitação ${id}: ${(est.find(e => e.id === x.STAGE_ID) || {}).nome || x.STAGE_ID} → ${alvo.nome}`);
      }
      return { ok: true, etapa: alvo.id };
    });
    on('PUT', '/kanban/(\\d+)/tipos', async ([id], _, b) => {
      ligado(); await negocio(id); const m = await meta(), ids = [...new Set(asArr(b.tipos))]; need(ids.every(i => m.tipos.some(t => t.id === i)), 'Tipo de serviço inválido.'); need(m.tipoMultiplo || ids.length <= 1, 'O campo atual aceita só um valor. Use "Preparar campos" para criar o Tipo de Serviço múltiplo.');
      await bitrix.call('crm.deal.update', { id, fields: { [m.tipoCod]: m.tipoMultiplo ? ids : (ids[0] || '') } }); return { ok: true, tipos: ids };
    });
    on('PUT', '/kanban/(\\d+)/prazos', async ([id], _, b) => {
      ligado(); const m = await meta(); need(m.tem(UF('prazos')), 'Use "Preparar campos" para criar o campo de prazos.'); const x = await negocio(id), atual = lerPrazos(x[UF('prazos')]), nomes = new Set(asArr(x[m.tipoCod]).map(t => (m.tipos.find(i => i.id === t) || {}).nome));
      for (const [t, v] of Object.entries(b.prazos || {})) { need(nomes.has(t), `O tipo "${t}" não está neste negócio.`); if (!v) delete atual[t]; else { need(isoData(v), 'Data inválida.'); atual[t] = isoData(v); } }
      await bitrix.call('crm.deal.update', { id, fields: { [UF('prazos')]: escreverPrazos(atual) } }); return { ok: true, prazos: atual };
    });
    on('PUT', '/kanban/(\\d+)/checklist', async ([id], _, b) => {   // marca/desmarca itens: grava no campo do Bitrix24
      ligado(); const m = await meta(); need(m.checkPronto, 'O checklist ainda não foi cadastrado (aba Configurações → Checklists de verificação).'); const x = await negocio(id), nomes = asArr(x[m.tipoCod]).map(t => (m.tipos.find(i => i.id === t) || { nome: t }).nome);
      const validas = new Set(nomes.flatMap(t => (modelos()[t] || []).map(i => chaveItem(t, i)))), feitos = [...new Set((Array.isArray(b.feitos) ? b.feitos : []).map(String))]; need(feitos.every(c => validas.has(c)), 'Item de checklist inválido para este negócio.');
      const opc = new Map(m.itens(UF('check')).map(o => [o.nome, o.id])), outros = asArr(x[UF('check')]).filter(i => !m.itens(UF('check')).some(o => o.id === i && validas.has(o.nome))), ids = feitos.map(c => opc.get(c)).filter(Boolean); need(ids.length === feitos.length, 'Há item novo que ainda não está no Bitrix24: salve os modelos de checklist de novo.');
      await bitrix.call('crm.deal.update', { id, fields: { [UF('check')]: [...outros, ...ids] } }); return { ok: true, feitos: feitos.length };
    });
    // Vínculo da empresa e do contato no card (a confirmação é sempre manual).
    const buscarEmpresa = async (id, b) => {
      ligado(); await negocio(id); const dg = digitos(b.cnpj); need(dg.length === 14 && (!cnpjApi || cnpjApi.cnpjValido(dg)), 'CNPJ inválido.');
      const ach = new Map((await bx.listar(true)).filter(e => e.cnpj === dg).map(e => [e.id, e]));
      try { for (const r of (await bitrix.call('crm.requisite.list', { filter: { RQ_INN: dg, ENTITY_TYPE_ID: 4 }, select: ['ID', 'ENTITY_ID'] })).result || []) { const e = await bx.porId(r.ENTITY_ID); if (e) ach.set(e.id, e); } } catch { /* opcional */ }
      let receita = null; if (!ach.size && cnpjApi) { try { const r = await cnpjApi.consultar(dg); receita = { razao: r.razao, fantasia: r.fantasia, cidade: r.cidade, uf: r.uf }; } catch { /* opcional */ } }
      return { cnpj: dg, encontradas: [...ach.values()].map(e => ({ id: e.id, nome: e.nome, cnpj: e.cnpj, cidade: e.cidade, uf: e.uf })), receita };
    };
    on('POST', '/kanban/(\\d+)/empresa/buscar', async ([id], _, b) => buscarEmpresa(id, b));
    const vincular = async (id, empresaId) => {
      const e = await bx.porId(empresaId); need(e, 'Empresa não encontrada no Bitrix24.'); const x = await negocio(id); await bitrix.call('crm.deal.update', { id, fields: { COMPANY_ID: e.id } });
      const un = indices().porBkn.get(bknDe(x.TITLE)); if (un && !un.empresaBitrixId) { un.empresaBitrixId = e.id; if (!un.cnpj && e.cnpj) un.cnpj = e.cnpj; save(); }
      store.log('bk', `Solicitação ${id} vinculada à empresa ${e.nome} (${e.id})`); return { ok: true, empresa: { id: e.id, nome: e.nome, cnpj: e.cnpj } };
    };
    on('POST', '/kanban/(\\d+)/empresa/vincular', async ([id], _, b) => { ligado(); return vincular(id, String(b.empresaId || '')); });
    on('POST', '/kanban/(\\d+)/empresa/criar', async ([id], _, b) => {
      ligado(); await negocio(id); const dg = digitos(b.cnpj), nome = String(b.nome || '').trim().slice(0, 200); need(dg.length === 14 && (!cnpjApi || cnpjApi.cnpjValido(dg)), 'CNPJ inválido.'); need(nome.length >= 2, 'Informe o nome da empresa.');
      let extra = {}; if (cnpjApi) { try { const r = await cnpjApi.consultar(dg); extra = { razao: r.razao, cep: r.cep, bairro: r.bairro, cidade: r.cidade, uf: r.uf }; } catch { /* opcional */ } }
      let e; try { e = await bx.criar({ nome, cnpj: dg, ...extra }); } catch (er) { if (er.status === 409 && er.existente) e = er.existente; else throw er; } return vincular(id, e.id);
    });
    on('GET', '/kanban/(\\d+)/contatos', async ([id]) => { ligado(); const x = await negocio(id); need(Number(x.COMPANY_ID), 'Vincule primeiro a empresa.'); return { contatos: await bx.contatos(x.COMPANY_ID), atual: Number(x.CONTACT_ID) ? String(x.CONTACT_ID) : '' }; });
    on('POST', '/kanban/(\\d+)/contato', async ([id], _, b) => {   // contato principal do negócio (precisa ser da empresa vinculada)
      ligado(); const x = await negocio(id); need(Number(x.COMPANY_ID), 'Vincule primeiro a empresa.'); const c = (await bx.contatos(x.COMPANY_ID)).find(k => k.id === String(b.contatoId)); need(c, 'Esse contato não pertence à empresa do negócio.');
      await bitrix.call('crm.deal.update', { id, fields: { CONTACT_ID: c.id } }); return { ok: true, contato: { id: c.id, nome: c.nome } };
    });
    // "Pedir a": contatos e empresas do CRM (campo de vínculo do Bitrix24). Opções = empresa do negócio, seus contatos e busca livre.
    on('GET', '/kanban/(\\d+)/pedir/opcoes', async ([id], u) => {
      ligado(); const x = await negocio(id), q = String(u.searchParams.get('q') || '').trim(), out = [];
      if (Number(x.COMPANY_ID)) { const e = await bx.porId(x.COMPANY_ID); if (e) out.push({ ref: 'CO_' + e.id, nome: e.nome, tipo: 'Empresa' }); try { for (const c of await bx.contatos(x.COMPANY_ID)) out.push({ ref: 'C_' + c.id, nome: c.nome, tipo: 'Contato', email: c.email }); } catch { /* opcional */ } }
      if (q.length >= 2) {
        for (const e of await bx.buscar(q, 8)) if (!out.some(o => o.ref === 'CO_' + e.id)) out.push({ ref: 'CO_' + e.id, nome: e.nome, tipo: 'Empresa' });
        try { for (const c of (await bitrix.call('crm.contact.list', { filter: { '%NAME': q }, select: ['ID', 'NAME', 'LAST_NAME', 'EMAIL'] })).result || []) { const ref = 'C_' + c.ID; if (!out.some(o => o.ref === ref)) out.push({ ref, nome: [c.NAME, c.LAST_NAME].filter(Boolean).join(' '), tipo: 'Contato', email: ((c.EMAIL || [])[0] || {}).VALUE || '' }); } } catch { /* opcional */ }
      }
      return { opcoes: out, atuais: asArr(x[COD_PEDIR]) };
    });
    on('POST', '/kanban/(\\d+)/pedir', async ([id], _, b, user) => {   // registra o pedido de documentos: Pedir a (CRM), data, comentário e etapa Levantamento
      ligado(); const m = await meta(); need(m.docsProntos, 'Os campos de documentos ainda não existem. Use "Preparar campos" no Kanban.'); const x = await negocio(id), refs = [...new Set(asArr(b.refs))]; need(refs.length && refs.every(r => /^(C|CO)_\d+$/.test(r)), 'Escolha a quem pedir os documentos (contato ou empresa).');
      const nomesTipo = asArr(x[m.tipoCod]).map(t => (m.tipos.find(i => i.id === t) || { nome: t }).nome), msg = String(b.mensagem || '').replace(/\u0000/g, '').trim().slice(0, 4000), fields = { [COD_PEDIR]: refs, [UF('docData')]: hoje() };
      const est = await funil.estagios(CAT), lev = est.find(e => nrm(e.nome).includes('levantamento')); let moveu = ''; if (lev && x.STAGE_ID === (est[0] || {}).id) { fields.STAGE_ID = lev.id; moveu = lev.nome; }
      await bitrix.call('crm.deal.update', { id, fields });
      let emails = []; for (const r of refs) { try { if (r.startsWith('C_')) { const c = (await bitrix.call('crm.contact.get', { id: r.slice(2) })).result || {}, em = ((c.EMAIL || [])[0] || {}).VALUE; if (em) emails.push({ nome: [c.NAME, c.LAST_NAME].filter(Boolean).join(' '), email: em }); } else for (const c of await bx.contatos(r.slice(3))) if (c.email) emails.push({ nome: c.nome, email: c.email }); } catch { /* opcional */ } }
      emails = emails.filter((e, i) => emails.findIndex(y => y.email === e.email) === i);
      await comentario(id, `Documentos solicitados (${nomesTipo.join('; ') || 'sem tipo'}).${msg ? '\n' + msg : ''}`); store.log('bk', `Documentos solicitados na solicitação ${id} por ${ator(user)}`); return { ok: true, moveuPara: moveu, emails };
    });
    on('POST', '/kanban/(\\d+)/documentos/anexar', async ([id], _, b, user) => {
      ligado(); const campo = b.campo === 'nutrimix' ? 'nutri' : b.campo === 'recebidos' ? 'receb' : ''; need(campo, 'Escolha onde anexar: documentos recebidos ou elaborados pela Nutrimix.'); await negocio(id);
      const nomeArq = n => String(n || 'arquivo').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'arquivo', lista = (Array.isArray(b.arquivos) ? b.arquivos : []).slice(0, 10).map(a => ({ nome: nomeArq(a && a.nome), dados: String((a && a.dados) || '').replace(/^data:[^,]*,/, '') }));
      return { ok: true, anexados: await anexar(id, campo, lista, user) };
    });
    // ---- modelos de documentos (etapa Envio de Documentos) ----
    on('GET', '/kanban/modelos', async () => ({ modelos: MOD.listar(enviados()) }));
    on('POST', '/kanban/modelos', async (_, __, b, user) => { need(!user || user.perfil === 'admin', 'Só o administrador envia modelos.', 403); const m = MOD.novoModelo(b, dirModelos); (d().modelosDocs ||= []).push(m); save(); store.log('bk', `Modelo de documento enviado: ${m.nome}`); return { ok: true, modelo: MOD.resumo({ ...m, embutido: false }) }; });
    on('DELETE', '/kanban/modelos/([\\w-]+)', async ([mid], _, __, user) => { need(!user || user.perfil === 'admin', 'Só o administrador remove modelos.', 403); const m = enviados().find(x => x.id === mid); need(m, 'Modelo enviado não encontrado (os modelos do sistema não podem ser removidos).', 404); d().modelosDocs = enviados().filter(x => x.id !== mid); save(); try { require('fs').unlinkSync(path.join(dirModelos, m.arquivo)); } catch { /* já removido */ } return { ok: true }; });
    on('GET', '/kanban/(\\d+)/modelos', async ([id], _, __, user) => { ligado(); const { tipos } = await contextoCard(id, user); return { tipos, modelos: MOD.listar(enviados()).map(m => ({ ...m, recomendado: m.tipos.some(t => tipos.includes(t)) })) }; });
    on('GET', '/kanban/(\\d+)/modelos/([\\w-]+)/valores', async ([id, mid], _, __, user) => { ligado(); const def = MOD.achar(mid, enviados()), { auto } = await contextoCard(id, user); return { modelo: MOD.resumo(def), valores: MOD.iniciais(def, auto) }; });
    on('POST', '/kanban/(\\d+)/modelos/([\\w-]+)/gerar', async ([id, mid], _, b, user) => {
      ligado(); const def = MOD.achar(mid, enviados()); await negocio(id); const arquivos = MOD.gerar(def, b.valores || {}, { dir: dirModelos, usuario: ator(user) }); let anexados = 0;
      if (b.anexar !== false) anexados = await anexar(id, 'nutri', arquivos.map(a => ({ nome: a.nome, dados: a.dados.toString('base64') })), user);
      const total = arquivos.reduce((t, a) => t + a.dados.length, 0); store.log('bk', `Solicitação ${id}: ${arquivos.length} documento(s) gerado(s) do modelo "${def.nome}" por ${ator(user)}`);
      return { ok: true, anexados, semDownload: total > 9 * 1048576, arquivos: total > 9 * 1048576 ? arquivos.map(a => ({ nome: a.nome, mime: a.mime })) : arquivos.map(a => ({ nome: a.nome, mime: a.mime, dados: a.dados.toString('base64') })) };
    });
    on('POST', '/kanban/(\\d+)/unidade', async ([id], _, b) => {   // cria a unidade a partir do negócio (BKN do título ou dos campos da unidade)
      ligado(); const m = await meta(), x = await negocio(id), bkn = digitos(b.bkn || x[UF('bkn')] || bknDe(x.TITLE)); need(bkn, 'Informe o BKN da unidade (o título do card não traz).'); need(!dupBkn(bkn), `Já existe a unidade BKN ${bkn}.`);
      const nome = String(b.nome || x[UF('unidade')] || String(x.TITLE || '').replace(/^.*?BKN\s*[:#\-]?\s*\d+\s*[—–\-:]*\s*/i, '') || `Unidade ${bkn}`).trim().slice(0, 120), base = { bkn, nome, empresaBitrixId: Number(x.COMPANY_ID) ? String(x.COMPANY_ID) : '' };
      for (const s of SYNC) if (!['bkn', 'unidade'].includes(s.k) && m.tem(UF(s.k))) { const v = valorDeal(s, x, m); if (v) base[{ cnpj: 'cnpj', endereco: 'endereco', cep: 'cep', cidade: 'cidade', uf: 'uf', licenca: 'licenca', licVal: 'licencaValidade', necRt: 'necessitaRt', virada: 'previsaoVirada' }[s.k] || '_'] = v; }
      base.rt = { nome: String(x[UF('rtNome')] || ''), crn: String(x[UF('rtCrn')] || ''), validade: dia(x[UF('rtVal')]), anterior: String(x[UF('rtAnt')] || '') };
      const u = { id: B.uid('bk'), ...B.validaUnidade(base) }; d().unidades.push(u); save(); store.log('bk', `Unidade ${bkn} criada a partir da solicitação ${id}`); return { ok: true, unidade: { id: u.id, bkn: u.bkn, nome: u.nome } };
    });
  }
  return { rotas, kanban, sincronizar: async () => { if (!bitrix.enabled) return null; const m = await meta(true), deals = await funil.negocios(CAT, [m.tipoCod, ...DEFS.map(x => 'UF_CRM_' + x.nome)]); return sincronizarUnidades(deals, m, indices()); } };
}
module.exports = { createSolic, DEFS, CAT };
