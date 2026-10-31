'use strict';
const R = require('./rules');

// Contas a pagar + parceiros, ligados ao contas a receber.
//  - Parceiros e fornecedores são EMPRESAS do Bitrix (tipo Parceiro/Fornecedor) com campos próprios (UF_CRM_PAR_*).
//  - Contas a pagar são negócios de um funil próprio ("Contas a Pagar"), campos UF_CRM_CP_*.
//  - Repasses: o campo "CR · Split" de uma cobrança gera um título a pagar por parceiro, preso ao recebimento.
// Todo o estado fica no Bitrix; o app só guarda o id do funil e o mapa de etapas.
const AP_NAME = 'Contas a Pagar';
const AP_FORMAS = ['Pix', 'Boleto', 'TED', 'Dinheiro', 'Split Asaas'];
const AP_CATEGORIAS = ['Repasse a parceiro', 'Comissão', 'Fornecedor', 'Imposto e taxas', 'Pessoas', 'Estrutura e software', 'Outros'];
const PIX_TIPOS = ['CPF/CNPJ', 'E-mail', 'Celular', 'Chave aleatória'];
const BASES = ['Bruto', 'Líquido'];

const DEAL_FIELDS = [
  { name: 'CP_ORIGEM', type: 'integer', label: 'CP · Cobrança de origem (ID da deal a receber)' },
  { name: 'CP_REGRA', type: 'string', label: 'CP · Regra do repasse' },
  { name: 'CP_BASE', type: 'double', label: 'CP · Base de cálculo (R$)' },
  { name: 'CP_VENC', type: 'date', label: 'CP · Vencimento' },
  { name: 'CP_PAGO_EM', type: 'date', label: 'CP · Pago em' },
  { name: 'CP_PAGO_VALOR', type: 'double', label: 'CP · Valor efetivamente pago (R$)' },
  { name: 'CP_FORMA', type: 'enumeration', label: 'CP · Forma de pagamento', list: AP_FORMAS },
  { name: 'CP_CATEGORIA', type: 'enumeration', label: 'CP · Categoria da despesa', list: AP_CATEGORIAS },
  { name: 'CP_PIX', type: 'string', label: 'CP · Chave Pix do beneficiário' },
  { name: 'CP_LINHA', type: 'string', label: 'CP · Linha digitável do boleto' },
  { name: 'CP_BENEF', type: 'string', label: 'CP · Beneficiário (quando não é parceiro cadastrado)' },
  { name: 'CP_COMPROVANTE', type: 'string', label: 'CP · Comprovante / referência do pagamento' },
  { name: 'CP_PARCELA', type: 'string', label: 'CP · Parcela (n/N)' },
  { name: 'CP_SPLIT_ST', type: 'string', label: 'CP · Situação do split no Asaas' },
];
const PARTNER_FIELDS = [
  { name: 'PAR_DOC', type: 'string', label: 'Parceiro · CPF/CNPJ' },
  { name: 'PAR_WALLET', type: 'string', label: 'Parceiro · walletId do Asaas (split automático)' },
  { name: 'PAR_PERC', type: 'double', label: 'Parceiro · % padrão do repasse' },
  { name: 'PAR_FIXO', type: 'double', label: 'Parceiro · valor fixo padrão do repasse (R$)' },
  { name: 'PAR_BASE', type: 'enumeration', label: 'Parceiro · base de cálculo', list: BASES },
  { name: 'PAR_PRAZO', type: 'integer', label: 'Parceiro · prazo de repasse (dias após receber)' },
  { name: 'PAR_PIX_TIPO', type: 'enumeration', label: 'Parceiro · tipo da chave Pix', list: PIX_TIPOS },
  { name: 'PAR_PIX', type: 'string', label: 'Parceiro · chave Pix' },
  { name: 'PAR_BANCO', type: 'string', label: 'Parceiro · dados bancários (banco, agência, conta, titular)' },
  { name: 'PAR_INATIVO', type: 'boolean', label: 'Parceiro · inativo' },
];
const UF = n => `UF_CRM_${n}`;
const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = v => (v === '' || v == null ? 0 : Number(v));
const r2 = n => Math.round(n * 100) / 100;
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const yes = v => v === 'Y' || v === '1' || v === 1 || v === true;

function createPagar(ctx) {
  const { bitrix, asaas, store, updateDeal, timeline } = ctx;
  let enums = { at: 0, deal: {}, company: {} };
  let pCache = { at: 0, list: [] };
  const lastMsg = new Map();   // dedupe de comentários/logs repetidos por chave

  // ---------- campos e listas ----------
  async function loadEnums(force) {
    if (!force && Date.now() - enums.at < 300000) return enums;
    const pick = (all, names) => Object.fromEntries(names.map(n => [n, Object.fromEntries(((all.find(f => f.FIELD_NAME === UF(n)) || {}).LIST || []).map(i => [String(i.ID), i.VALUE]))]));
    const d = (await bitrix.call('crm.deal.userfield.list', {})).result || [];
    const c = (await bitrix.call('crm.company.userfield.list', {})).result || [];
    enums = { at: Date.now(), deal: pick(d, ['CP_FORMA', 'CP_CATEGORIA']), company: pick(c, ['PAR_BASE', 'PAR_PIX_TIPO']) };
    return enums;
  }
  const idOf = (map, label) => Object.keys(map || {}).find(k => map[k] === label) || '';
  const labelOf = (map, id) => (map || {})[String(id)] || '';
  const encD = (field, label) => idOf(enums.deal[field], label);
  const encC = (field, label) => idOf(enums.company[field], label);

  async function ensureFields(entity, defs) {
    const method = entity === 'deal' ? 'crm.deal.userfield' : 'crm.company.userfield';
    const have = new Set(((await bitrix.call(method + '.list', {})).result || []).map(f => f.FIELD_NAME));
    const created = [];
    for (const f of defs) {
      if (have.has(UF(f.name))) continue;
      await bitrix.call(method + '.add', { fields: {
        FIELD_NAME: f.name, USER_TYPE_ID: f.type, XML_ID: f.name,
        EDIT_FORM_LABEL: { br: f.label, en: f.label }, LIST_COLUMN_LABEL: { br: f.label, en: f.label },
        SHOW_IN_LIST: 'Y', EDIT_IN_LIST: 'Y', MULTIPLE: 'N',
        ...(f.list ? { LIST: f.list.map((v, i) => ({ VALUE: v, SORT: (i + 1) * 10, DEF: 'N' })) } : {}),
        ...(f.type === 'double' ? { SETTINGS: { PRECISION: 2 } } : {}),
      } });
      created.push(f.name);
    }
    return created;
  }

  // ---------- funil "Contas a Pagar" ----------
  const STAGE_PLAN = [['NEW', 'open', 'A pagar', 10], ['PREPARATION', 'late', 'Atrasado', 20], ['PREPAYMENT_INVOIC', 'soon', 'Próximo do Vencimento', 30], ['WON', 'paid', 'Pago', 60], ['LOSE', 'cancelled', 'Cancelado', 70]];
  async function ensureFunnel() {
    const known = store.ap;
    const cats = (await bitrix.call('crm.dealcategory.list', {})).result || [];
    let cat = cats.find(c => known && String(c.ID) === String(known.categoryId)) || cats.find(c => c.NAME === AP_NAME);
    let criada = false;
    if (!cat) {
      const r = await bitrix.call('crm.dealcategory.add', { fields: { NAME: AP_NAME, SORT: 420 } });
      cat = { ID: String(r.result), NAME: AP_NAME }; criada = true;
      store.log('campos', `Funil criado no Bitrix: ${AP_NAME} (#${cat.ID})`);
    }
    const id = String(cat.ID), ent = `DEAL_STAGE_${id}`;
    const list = async () => (await bitrix.call('crm.status.list', { filter: { ENTITY_ID: ent } })).result || [];
    let st = await list();
    const suffix = s => String(s.STATUS_ID).split(':').pop();
    if (criada) {                                    // funil novo: deixa só as etapas do plano (renomeia as padrão, apaga as demais)
      const keep = new Set(STAGE_PLAN.map(p => p[0]));
      for (const s of st) {
        const plan = STAGE_PLAN.find(p => suffix(s).startsWith(p[0]));
        if (plan) { if (s.NAME !== plan[2] || String(s.SORT) !== String(plan[3])) await bitrix.call('crm.status.update', { id: s.ID, fields: { NAME: plan[2], SORT: plan[3] } }); }
        else if (!keep.has(suffix(s))) { try { await bitrix.call('crm.status.delete', { id: s.ID }); } catch { /* etapa de sistema não apaga */ } }
      }
      st = await list();
    }
    const find = pre => st.find(s => suffix(s).startsWith(pre));
    if (!find('AGUARDANDO')) {
      await bitrix.call('crm.status.add', { fields: { ENTITY_ID: ent, STATUS_ID: 'AGUARDANDO', NAME: 'Aguardando recebimento', SORT: 5, COLOR: '#94a3b8' } });
      st = await list();
    }
    for (const [pre, , nome, sort] of STAGE_PLAN) {                 // funil que já existia: só completa o que faltar
      if (!find(pre) && !criada && pre !== 'WON' && pre !== 'LOSE') { await bitrix.call('crm.status.add', { fields: { ENTITY_ID: ent, STATUS_ID: pre, NAME: nome, SORT: sort } }); st = await list(); }
    }
    const stages = {};
    for (const [pre, key] of [['AGUARDANDO', 'aguardando'], ...STAGE_PLAN.map(p => [p[0], p[1]])]) {
      const s = find(pre);
      if (!s) throw new Error(`Etapa "${pre}" não encontrada no funil ${AP_NAME}`);
      stages[key] = s.STATUS_ID;
    }
    store.setAP({ categoryId: Number(id), stages });
    return store.ap;
  }

  async function ensure() {
    const c1 = await ensureFields('deal', DEAL_FIELDS);
    const c2 = await ensureFields('company', PARTNER_FIELDS);
    const funil = await ensureFunnel();
    await loadEnums(true);
    if (c1.length || c2.length) store.log('campos', `Campos de contas a pagar/parceiros criados: ${[...c1, ...c2].join(', ')}`);
    return { funil, campos: [...c1, ...c2] };
  }
  const ap = () => { if (!store.ap) throw fail(503, 'Módulo de contas a pagar ainda não foi preparado (aguarde a próxima sincronização).'); return store.ap; };
  const stageKey = stageId => Object.keys(ap().stages).find(k => ap().stages[k] === stageId) || 'open';

  // ---------- parceiros ----------
  const PSEL = () => ['ID', 'TITLE', 'COMPANY_TYPE', 'EMAIL', 'PHONE', 'COMMENTS', ...PARTNER_FIELDS.map(f => UF(f.name))];
  function normPartner(c) {
    return {
      id: +c.ID, nome: c.TITLE || '', tipo: c.COMPANY_TYPE === 'SUPPLIER' ? 'SUPPLIER' : 'PARTNER',
      doc: c[UF('PAR_DOC')] || '', wallet: c[UF('PAR_WALLET')] || '', perc: num(c[UF('PAR_PERC')]), fixo: num(c[UF('PAR_FIXO')]),
      base: labelOf(enums.company.PAR_BASE, c[UF('PAR_BASE')]) === 'Líquido' ? 'LIQUIDO' : 'BRUTO', prazo: parseInt(c[UF('PAR_PRAZO')], 10) || 0,
      pixTipo: labelOf(enums.company.PAR_PIX_TIPO, c[UF('PAR_PIX_TIPO')]), pix: c[UF('PAR_PIX')] || '', banco: c[UF('PAR_BANCO')] || '',
      email: c.EMAIL?.[0]?.VALUE || '', telefone: c.PHONE?.[0]?.VALUE || '', obs: c.COMMENTS || '', inativo: yes(c[UF('PAR_INATIVO')]),
    };
  }
  async function parceiros(force) {
    if (!force && Date.now() - pCache.at < 120000) return pCache.list;
    await loadEnums();
    const rows = await bitrix.listAll('crm.company.list', { filter: { COMPANY_TYPE: ['PARTNER', 'SUPPLIER'] }, select: PSEL(), order: { TITLE: 'ASC' } });
    pCache = { at: Date.now(), list: rows.map(normPartner) };
    return pCache.list;
  }
  const walletsDeParceiros = async () => (await parceiros()).filter(p => !p.inativo && p.wallet).map(p => ({ nome: p.nome, walletId: p.wallet }));

  function checkParceiro(sp, criando) {
    const f = {};
    if (criando || sp.nome !== undefined) {
      const n = String(sp.nome || '').trim();
      if (n.length < 2 || n.length > 120) throw fail(400, 'Informe o nome do parceiro (2 a 120 caracteres).');
      if (/[=;%]/.test(n)) throw fail(400, 'O nome não pode ter os caracteres = ; % (são usados no campo de split).');
      f.nome = n;
    }
    if (sp.tipo !== undefined) { if (!['PARTNER', 'SUPPLIER'].includes(sp.tipo)) throw fail(400, 'Tipo inválido (Parceiro ou Fornecedor).'); f.tipo = sp.tipo; }
    if (sp.doc !== undefined && String(sp.doc).trim() !== '') { if (!R.validDoc(sp.doc)) throw fail(400, 'CPF/CNPJ inválido.'); f.doc = R.digits(sp.doc); } else if (sp.doc !== undefined) f.doc = '';
    if (sp.wallet !== undefined) { const w = String(sp.wallet).trim(); if (w && !UUID.test(w)) throw fail(400, 'walletId inválido: use o ID da carteira do Asaas (formato 00000000-0000-0000-0000-000000000000).'); f.wallet = w; }
    if (sp.perc !== undefined && sp.perc !== '') { const v = Number(sp.perc); if (!(v >= 0 && v <= 100)) throw fail(400, 'Percentual padrão deve ficar entre 0 e 100.'); f.perc = v; } else if (sp.perc !== undefined) f.perc = 0;
    if (sp.fixo !== undefined && sp.fixo !== '') { const v = Number(sp.fixo); if (!(v >= 0)) throw fail(400, 'Valor fixo padrão inválido.'); f.fixo = v; } else if (sp.fixo !== undefined) f.fixo = 0;
    if (f.perc > 0 && f.fixo > 0) throw fail(400, 'Informe percentual OU valor fixo padrão, não os dois.');
    if (sp.base !== undefined) { if (!['BRUTO', 'LIQUIDO'].includes(sp.base)) throw fail(400, 'Base de cálculo inválida.'); f.base = sp.base; }
    if (sp.prazo !== undefined && sp.prazo !== '') { const v = parseInt(sp.prazo, 10); if (!(v >= 0 && v <= 365)) throw fail(400, 'Prazo de repasse deve ficar entre 0 e 365 dias.'); f.prazo = v; } else if (sp.prazo !== undefined) f.prazo = 0;
    if (sp.pixTipo !== undefined && sp.pixTipo !== '') { if (!PIX_TIPOS.includes(sp.pixTipo)) throw fail(400, 'Tipo de chave Pix inválido.'); f.pixTipo = sp.pixTipo; } else if (sp.pixTipo !== undefined) f.pixTipo = '';
    if (sp.pix !== undefined) { const p = String(sp.pix).trim().slice(0, 140); if ((sp.pixTipo === 'E-mail') && p && !p.includes('@')) throw fail(400, 'A chave Pix do tipo e-mail precisa ter @.'); f.pix = p; }
    if (sp.banco !== undefined) f.banco = String(sp.banco).slice(0, 300);
    if (sp.email !== undefined) { const e = String(sp.email).trim(); if (e && !/^\S+@\S+\.\S+$/.test(e)) throw fail(400, 'E-mail inválido.'); f.email = e; }
    if (sp.telefone !== undefined) f.telefone = String(sp.telefone).trim().slice(0, 40);
    if (sp.obs !== undefined) f.obs = String(sp.obs).slice(0, 2000);
    if (sp.inativo !== undefined) f.inativo = !!sp.inativo;
    return f;
  }
  const partnerFields = f => ({
    ...(f.nome !== undefined ? { TITLE: f.nome } : {}), ...(f.tipo !== undefined ? { COMPANY_TYPE: f.tipo } : {}),
    ...(f.doc !== undefined ? { [UF('PAR_DOC')]: f.doc } : {}), ...(f.wallet !== undefined ? { [UF('PAR_WALLET')]: f.wallet } : {}),
    ...(f.perc !== undefined ? { [UF('PAR_PERC')]: f.perc } : {}), ...(f.fixo !== undefined ? { [UF('PAR_FIXO')]: f.fixo } : {}),
    ...(f.base !== undefined ? { [UF('PAR_BASE')]: encC('PAR_BASE', f.base === 'LIQUIDO' ? 'Líquido' : 'Bruto') } : {}),
    ...(f.prazo !== undefined ? { [UF('PAR_PRAZO')]: f.prazo } : {}),
    ...(f.pixTipo !== undefined ? { [UF('PAR_PIX_TIPO')]: f.pixTipo ? encC('PAR_PIX_TIPO', f.pixTipo) : '' } : {}),
    ...(f.pix !== undefined ? { [UF('PAR_PIX')]: f.pix } : {}), ...(f.banco !== undefined ? { [UF('PAR_BANCO')]: f.banco } : {}),
    ...(f.obs !== undefined ? { COMMENTS: f.obs } : {}), ...(f.inativo !== undefined ? { [UF('PAR_INATIVO')]: f.inativo ? 1 : 0 } : {}),
  });

  // empresaId: promove uma empresa que já existe no Bitrix a parceiro/fornecedor.
  async function salvarParceiro(sp, { id } = {}) {
    await loadEnums();
    const f = checkParceiro(sp, !id);
    const lista = await parceiros(true);
    if (f.nome && lista.some(p => p.id !== +(id || sp.empresaId || 0) && p.nome.toLowerCase() === f.nome.toLowerCase())) throw fail(400, `Já existe um parceiro/fornecedor chamado "${f.nome}".`);
    if (f.wallet && lista.some(p => p.id !== +(id || sp.empresaId || 0) && p.wallet === f.wallet)) throw fail(400, 'Este walletId já está em outro parceiro.');
    const alvo = id || sp.empresaId;
    if (alvo) {
      const fields = partnerFields({ tipo: 'PARTNER', ...f });
      if (f.email !== undefined || f.telefone !== undefined) {
        const cur = (await bitrix.call('crm.company.get', { id: alvo })).result || {};
        if (f.email !== undefined && f.email !== (cur.EMAIL?.[0]?.VALUE || '')) fields.EMAIL = cur.EMAIL?.[0] ? [{ ID: cur.EMAIL[0].ID, VALUE: f.email }] : [{ VALUE: f.email, VALUE_TYPE: 'WORK' }];
        if (f.telefone !== undefined && f.telefone !== (cur.PHONE?.[0]?.VALUE || '')) fields.PHONE = cur.PHONE?.[0] ? [{ ID: cur.PHONE[0].ID, VALUE: f.telefone }] : [{ VALUE: f.telefone, VALUE_TYPE: 'WORK' }];
      }
      await bitrix.call('crm.company.update', { id: alvo, fields });
      store.log('parceiro', `Parceiro atualizado: ${f.nome || '#' + alvo}`);
      pCache.at = 0;
      return { ok: true, id: +alvo };
    }
    const fields = partnerFields({ tipo: 'PARTNER', base: 'BRUTO', prazo: 0, ...f });
    if (f.email) fields.EMAIL = [{ VALUE: f.email, VALUE_TYPE: 'WORK' }];
    if (f.telefone) fields.PHONE = [{ VALUE: f.telefone, VALUE_TYPE: 'WORK' }];
    const r = await bitrix.call('crm.company.add', { fields });
    store.log('parceiro', `Parceiro cadastrado: ${f.nome}`);
    pCache.at = 0;
    return { ok: true, id: +r.result };
  }

  // ---------- contas a pagar ----------
  const DSEL = () => ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'COMPANY_ID', 'COMMENTS', 'DATE_CREATE', ...DEAL_FIELDS.map(f => UF(f.name))];
  const ESTADO = { aguardando: 'aguardando', open: 'aberto', soon: 'proximo', late: 'atrasado', paid: 'pago', cancelled: 'cancelado' };
  let cCache = { at: 0, list: [] };
  async function contasCached(maxAge = 30000) {
    if (Date.now() - cCache.at <= maxAge) return cCache.list;
    cCache = { at: Date.now(), list: await contas() };
    return cCache.list;
  }
  async function contas() {
    if (!store.ap) return [];
    await loadEnums();
    const ps = await parceiros();
    const nome = Object.fromEntries(ps.map(p => [p.id, p.nome]));
    const rows = await bitrix.listAll('crm.deal.list', { filter: { CATEGORY_ID: ap().categoryId }, select: DSEL(), order: { ID: 'DESC' } });
    return rows.map(d => {
      const key = stageKey(d.STAGE_ID), pid = d.COMPANY_ID && d.COMPANY_ID !== '0' ? +d.COMPANY_ID : 0;
      return {
        id: +d.ID, titulo: d.TITLE || '', valor: num(d.OPPORTUNITY), stageId: d.STAGE_ID, chave: key, estado: ESTADO[key],
        parceiroId: pid, beneficiario: (pid && nome[pid]) || d[UF('CP_BENEF')] || '', venc: R.toDay(d[UF('CP_VENC')]), pagoEm: R.toDay(d[UF('CP_PAGO_EM')]),
        forma: labelOf(enums.deal.CP_FORMA, d[UF('CP_FORMA')]), categoria: labelOf(enums.deal.CP_CATEGORIA, d[UF('CP_CATEGORIA')]),
        origem: parseInt(d[UF('CP_ORIGEM')], 10) || 0, regra: d[UF('CP_REGRA')] || '', base: num(d[UF('CP_BASE')]),
        pix: d[UF('CP_PIX')] || '', linha: d[UF('CP_LINHA')] || '', comprovante: d[UF('CP_COMPROVANTE')] || '', parcela: d[UF('CP_PARCELA')] || '',
        valorPago: num(d[UF('CP_PAGO_VALOR')]), splitSt: d[UF('CP_SPLIT_ST')] || '', obs: d.COMMENTS || '', criado: R.toDay(d.DATE_CREATE),
      };
    });
  }

  async function criarConta(sp) {
    await loadEnums();
    const titulo = String(sp.titulo || '').trim();
    if (!titulo) throw fail(400, 'Informe a descrição da conta.');
    const valor = Number(sp.valor);
    if (!(valor > 0)) throw fail(400, 'Valor inválido.');
    if (!isDay(sp.venc)) throw fail(400, 'Informe o vencimento.');
    const categoria = sp.categoria || 'Outros';
    if (!AP_CATEGORIAS.includes(categoria)) throw fail(400, 'Categoria inválida.');
    if (sp.forma && !AP_FORMAS.includes(sp.forma)) throw fail(400, 'Forma de pagamento inválida.');
    const n = sp.repetir ? parseInt(sp.repetir, 10) : 1;
    if (!(n >= 1 && n <= 60)) throw fail(400, 'Repetição deve ficar entre 1 e 60 meses.');
    let parceiro = null;
    if (sp.parceiroId) { parceiro = (await parceiros()).find(p => p.id === +sp.parceiroId); if (!parceiro) throw fail(400, 'Parceiro/fornecedor não encontrado.'); }
    if (!parceiro && !String(sp.beneficiario || '').trim()) throw fail(400, 'Informe o beneficiário (parceiro cadastrado ou nome livre).');
    const ids = [];
    const hoje = R.todayBR();
    for (let i = 0; i < n; i++) {
      const venc = R.addMonths(sp.venc, i);
      const key = R.apStageKey(venc, hoje, store.config.diasProximo);
      const fields = {
        TITLE: (n > 1 ? `${titulo} — ${i + 1}/${n}` : titulo).slice(0, 255), CATEGORY_ID: ap().categoryId, STAGE_ID: ap().stages[key],
        OPPORTUNITY: valor, CURRENCY_ID: 'BRL', IS_MANUAL_OPPORTUNITY: 'Y',
        ...(parceiro ? { COMPANY_ID: parceiro.id } : {}),
        [UF('CP_VENC')]: venc, [UF('CP_CATEGORIA')]: encD('CP_CATEGORIA', categoria),
        ...(sp.forma ? { [UF('CP_FORMA')]: encD('CP_FORMA', sp.forma) } : {}),
        ...(n > 1 ? { [UF('CP_PARCELA')]: `${i + 1}/${n}` } : {}),
        ...(parceiro ? {} : { [UF('CP_BENEF')]: String(sp.beneficiario).trim().slice(0, 200) }),
        ...((sp.pix || parceiro?.pix) ? { [UF('CP_PIX')]: String(sp.pix || parceiro.pix).slice(0, 140) } : {}),
        ...(sp.linha ? { [UF('CP_LINHA')]: String(sp.linha).replace(/\s+/g, ' ').slice(0, 120) } : {}),
        ...(sp.obs ? { COMMENTS: String(sp.obs).slice(0, 2000) } : {}),
      };
      const r = await bitrix.call('crm.deal.add', { fields, params: { REGISTER_SONET_EVENT: 'N' } });
      ids.push(+r.result);
    }
    cCache.at = 0;
    store.log('pagar', `${ids.length} conta(s) a pagar criada(s): ${titulo}`);
    return { ok: true, ids };
  }

  async function buscar(id) {
    const c = (await contas()).find(x => x.id === +id);
    if (!c) throw fail(404, 'Conta a pagar não encontrada.');
    return c;
  }
  async function pagarConta(id, { data, forma, valor, comprovante } = {}) {
    await loadEnums();
    const c = await buscar(id);
    if (c.estado === 'pago') throw fail(400, 'Esta conta já está paga.');
    if (c.estado === 'cancelado') throw fail(400, 'Esta conta está cancelada.');
    if (c.forma === 'Split Asaas' && c.estado === 'aguardando') throw fail(400, 'Este repasse é feito automaticamente pelo split do Asaas quando o cliente paga. Não pague manualmente.');
    const hoje = R.todayBR(), dia = data || hoje;
    if (!isDay(dia) || dia > hoje) throw fail(400, 'Data do pagamento inválida (não pode ser futura).');
    const f = forma || c.forma || 'Pix';
    if (!AP_FORMAS.includes(f) || f === 'Split Asaas') throw fail(400, 'Forma de pagamento inválida.');
    const v = valor === undefined || valor === '' ? c.valor : Number(valor);
    if (!(v > 0)) throw fail(400, 'Valor pago inválido.');
    const upd = { STAGE_ID: ap().stages.paid, [UF('CP_PAGO_EM')]: dia, [UF('CP_PAGO_VALOR')]: r2(v), [UF('CP_FORMA')]: encD('CP_FORMA', f), ...(comprovante ? { [UF('CP_COMPROVANTE')]: String(comprovante).slice(0, 200) } : {}) };   // o valor previsto não é alterado
    await updateDeal(c.id, upd);
    cCache.at = 0;
    await timeline(c.id, `Pago em ${dia.split('-').reverse().join('/')} via ${f}${r2(v) !== r2(c.valor) ? ` · valor pago R$ ${v.toFixed(2)} (previsto R$ ${c.valor.toFixed(2)})` : ''}${comprovante ? ` · ${comprovante}` : ''}.`);
    store.log('pagar', `Conta ${c.id} paga (${c.beneficiario || c.titulo})`, { deal: c.id });
    return { ok: true };
  }
  async function cancelarConta(id, { motivo } = {}) {
    const c = await buscar(id);
    if (c.estado === 'pago') throw fail(400, 'Conta já paga: use "Desfazer pagamento" antes de cancelar.');
    if (c.estado === 'cancelado') throw fail(400, 'Esta conta já está cancelada.');
    await updateDeal(c.id, { STAGE_ID: ap().stages.cancelled });
    cCache.at = 0;
    await timeline(c.id, `Conta cancelada${motivo ? `: ${String(motivo).slice(0, 200)}` : ''}.`);
    store.log('pagar', `Conta ${c.id} cancelada`, { deal: c.id });
    return { ok: true };
  }
  async function desfazerPagamento(id) {
    const c = await buscar(id);
    if (c.estado !== 'pago') throw fail(400, 'Só dá para desfazer o pagamento de uma conta paga.');
    const key = c.origem && c.forma === 'Split Asaas' ? 'aguardando' : R.apStageKey(c.venc, R.todayBR(), store.config.diasProximo);
    await updateDeal(c.id, { STAGE_ID: ap().stages[key], [UF('CP_PAGO_EM')]: '', [UF('CP_PAGO_VALOR')]: '', [UF('CP_COMPROVANTE')]: '' });
    cCache.at = 0;
    await timeline(c.id, 'Pagamento desfeito (lançado por engano).');
    store.log('pagar', `Pagamento da conta ${c.id} desfeito`, { deal: c.id });
    return { ok: true };
  }
  async function editarConta(id, sp) {
    await loadEnums();
    const c = await buscar(id);
    if (c.estado === 'pago' || c.estado === 'cancelado') throw fail(400, `Conta ${c.estado}: não pode mais ser editada.`);
    const f = {};
    if (sp.titulo !== undefined) { const t = String(sp.titulo).trim(); if (!t) throw fail(400, 'A descrição não pode ficar vazia.'); f.TITLE = t.slice(0, 255); }
    if (sp.valor !== undefined) { const v = Number(sp.valor); if (!(v > 0)) throw fail(400, 'Valor inválido.'); if (r2(v) !== r2(c.valor)) { f.OPPORTUNITY = v; f.IS_MANUAL_OPPORTUNITY = 'Y'; } }
    if (sp.venc !== undefined) { if (!isDay(sp.venc)) throw fail(400, 'Vencimento inválido.'); f[UF('CP_VENC')] = sp.venc; if (c.estado !== 'aguardando') f.STAGE_ID = ap().stages[R.apStageKey(sp.venc, R.todayBR(), store.config.diasProximo)]; }
    if (sp.categoria !== undefined) { if (!AP_CATEGORIAS.includes(sp.categoria)) throw fail(400, 'Categoria inválida.'); f[UF('CP_CATEGORIA')] = encD('CP_CATEGORIA', sp.categoria); }
    if (sp.forma !== undefined && sp.forma !== '') { if (!AP_FORMAS.includes(sp.forma)) throw fail(400, 'Forma de pagamento inválida.'); f[UF('CP_FORMA')] = encD('CP_FORMA', sp.forma); }
    if (sp.pix !== undefined) f[UF('CP_PIX')] = String(sp.pix).slice(0, 140);
    if (sp.linha !== undefined) f[UF('CP_LINHA')] = String(sp.linha).replace(/\s+/g, ' ').slice(0, 120);
    if (sp.obs !== undefined) f.COMMENTS = String(sp.obs).slice(0, 2000);
    if (!Object.keys(f).length) return { ok: true, alterado: false };
    await updateDeal(c.id, f);
    cCache.at = 0;
    store.log('pagar', `Conta ${c.id} editada`, { deal: c.id });
    return { ok: true, alterado: true };
  }

  // ---------- repasses: contas a receber -> contas a pagar ----------
  const nomeBase = (p, e) => (p.base === 'LIQUIDO' || e.walletId ? 'líquido' : 'bruto');
  const once = async (key, fn) => { if (lastMsg.get(key) !== 1) { lastMsg.set(key, 1); await fn(); } };

  async function splitStatus(r, p) {
    if (!p.wallet || !r.asaasId || !asaas.enabled) return null;
    try {
      const pay = await asaas.getPayment(r.asaasId);
      const s = (pay.split || []).find(x => x.walletId === p.wallet);
      return s ? { status: String(s.status || ''), total: s.totalValue != null ? Number(s.totalValue) : null } : null;
    } catch { return null; }
  }

  async function sincronizarRepasses(recebiveis) {
    const out = { criados: 0, liberados: 0, pagos: 0, cancelados: 0, atualizados: 0, erros: [] };
    if (!store.ap) return out;
    await loadEnums();
    const partners = await parceiros();
    const wallets = store.wallets;
    const todas = await contas();
    const hoje = R.todayBR();
    for (const r of recebiveis) {
      if (R.CONTRACT_STAGES.has(r.stageId)) continue;
      const mine = todas.filter(c => c.origem === r.id);
      if (!r.split && !mine.length) continue;
      let entries = [];
      try { entries = r.split ? R.parseRepasses(r.split, { partners, wallets }) : []; }
      catch (e) {
        out.erros.push(`deal ${r.id}: ${e.message}`);
        await once(`err:${r.id}:${e.message}`, async () => { await timeline(r.id, `Repasses não gerados: ${e.message}`); store.log('repasse', `Deal ${r.id}: ${e.message}`, { deal: r.id }); });
        continue;
      }
      const estado = r.stageId === R.STAGES.paid ? 'pago' : r.stageId === R.STAGES.cancelled ? 'cancelado' : 'aberto';
      const ids = [];
      const vistos = new Set();
      for (const e of entries) {
        const p = e.partner;
        if (!p) continue;                                    // carteira avulsa (sem cadastro): só split nativo, sem título
        vistos.add(p.id);
        const nb = nomeBase(p, e), base = nb === 'bruto' ? r.valor : (r.liquido || r.valor), valor = R.repasseValor(e, base), regra = R.repasseRegra(e, nb);
        const exist = mine.find(c => c.parceiroId === p.id);
        const nativo = !!(p.wallet && r.asaasId);
        // vencimento: estimado (venc da cobrança + prazo) enquanto não recebe; real (recebimento + prazo) depois
        const vencEst = addDays(r.venc || hoje, p.prazo);
        const vencReal = addDays(r.pagoEm || hoje, p.prazo);

        if (!exist) {
          if (estado === 'cancelado') continue;
          let sp = null, chave = 'aguardando', venc = vencEst, forma = nativo ? 'Split Asaas' : (p.pix ? 'Pix' : ''), pago = false, valorFinal = valor;
          if (estado === 'pago') {
            sp = nativo ? await splitStatus(r, p) : null;
            if (sp) { if (sp.status === 'DONE') { chave = 'paid'; pago = true; } }
            else { chave = R.apStageKey(vencReal, hoje, store.config.diasProximo); venc = vencReal; if (nativo) forma = p.pix ? 'Pix' : ''; }
          }
          const fields = {
            TITLE: `Repasse ${p.nome} — ${r.titulo}`.slice(0, 255), CATEGORY_ID: ap().categoryId, STAGE_ID: ap().stages[chave],
            OPPORTUNITY: valorFinal, CURRENCY_ID: 'BRL', IS_MANUAL_OPPORTUNITY: 'Y', COMPANY_ID: p.id,
            [UF('CP_ORIGEM')]: r.id, [UF('CP_REGRA')]: regra, [UF('CP_BASE')]: base, [UF('CP_VENC')]: venc,
            [UF('CP_CATEGORIA')]: encD('CP_CATEGORIA', p.tipo === 'SUPPLIER' ? 'Fornecedor' : 'Repasse a parceiro'),
            ...(forma ? { [UF('CP_FORMA')]: encD('CP_FORMA', forma) } : {}), ...(p.pix ? { [UF('CP_PIX')]: p.pix } : {}),
            ...(sp ? { [UF('CP_SPLIT_ST')]: sp.status } : {}), ...(pago ? { [UF('CP_PAGO_EM')]: hoje, [UF('CP_PAGO_VALOR')]: sp.total != null ? sp.total : valorFinal } : {}),
          };
          const res = await bitrix.call('crm.deal.add', { fields, params: { REGISTER_SONET_EVENT: 'N' } });
          ids.push(+res.result); out.criados++;
          await timeline(+res.result, `Repasse gerado a partir da cobrança #${r.id} (${r.cliente || 'cliente'}): ${regra} = R$ ${valorFinal.toFixed(2)}${chave === 'aguardando' ? '. Aguardando o recebimento do cliente.' : '.'}`);
          store.log('repasse', `Repasse de ${p.nome} (R$ ${valorFinal.toFixed(2)}) gerado para a cobrança ${r.id}`, { deal: r.id });
          continue;
        }

        ids.push(exist.id);
        if (exist.estado === 'pago') continue;
        if (exist.estado === 'cancelado') continue;
        if (estado === 'cancelado') {
          await updateDeal(exist.id, { STAGE_ID: ap().stages.cancelled });
          await timeline(exist.id, `Repasse cancelado: a cobrança #${r.id} foi cancelada/estornada.`);
          store.log('repasse', `Repasse ${exist.id} cancelado (cobrança ${r.id} cancelada)`, { deal: exist.id });
          out.cancelados++; continue;
        }
        const upd = {};
        if (r2(valor) !== r2(exist.valor)) { upd.OPPORTUNITY = valor; upd.IS_MANUAL_OPPORTUNITY = 'Y'; upd[UF('CP_BASE')] = base; upd[UF('CP_REGRA')] = regra; }
        if (estado === 'aberto') {
          if (exist.estado === 'aguardando' && exist.venc !== vencEst) upd[UF('CP_VENC')] = vencEst;
        } else if (estado === 'pago') {
          const sp = (nativo && exist.forma === 'Split Asaas') ? await splitStatus(r, p) : null;
          if (sp) {
            if (sp.status !== exist.splitSt) upd[UF('CP_SPLIT_ST')] = sp.status;
            if (sp.status === 'DONE') { upd.STAGE_ID = ap().stages.paid; upd[UF('CP_PAGO_EM')] = hoje; upd[UF('CP_PAGO_VALOR')] = sp.total != null ? sp.total : exist.valor; out.pagos++; }
          } else if (exist.estado === 'aguardando') {
            const key = R.apStageKey(vencReal, hoje, store.config.diasProximo);
            upd.STAGE_ID = ap().stages[key]; upd[UF('CP_VENC')] = vencReal; out.liberados++;
            if (nativo && exist.forma === 'Split Asaas') upd[UF('CP_FORMA')] = p.pix ? encD('CP_FORMA', 'Pix') : '';
          }
        }
        if (Object.keys(upd).length) {
          await updateDeal(exist.id, upd); out.atualizados++;
          if (upd.STAGE_ID && upd.STAGE_ID !== ap().stages.paid) await timeline(exist.id, `Cobrança #${r.id} recebida: repasse liberado para pagamento (vence ${(upd[UF('CP_VENC')] || exist.venc).split('-').reverse().join('/')}).`);
          if (upd.STAGE_ID === ap().stages.paid) await timeline(exist.id, 'Split do Asaas concluído: valor creditado ao parceiro.');
        }
      }
      // parceiro que saiu do split: título ainda não pago é cancelado
      for (const c of mine) {
        if (vistos.has(c.parceiroId) || c.estado === 'pago' || c.estado === 'cancelado') continue;
        await updateDeal(c.id, { STAGE_ID: ap().stages.cancelled });
        await timeline(c.id, `Repasse cancelado: o parceiro saiu do split da cobrança #${r.id}.`);
        out.cancelados++;
      }
      const rep = [...new Set([...mine.filter(c => !(c.estado === 'cancelado')).map(c => c.id), ...ids])].sort((a, b) => a - b).join(',');
      if ((r.repasses || '') !== rep && (rep || r.repasses)) { await updateDeal(r.id, { [UF('CR_REPASSES')]: rep }); r.repasses = rep; }
    }
    return out;
  }

  // ---------- manutenção por data (só contas ainda abertas) ----------
  async function tickDatas() {
    if (!store.ap) return { movidas: 0 };
    const hoje = R.todayBR();
    let movidas = 0;
    for (const c of await contas()) {
      if (!['aberto', 'proximo', 'atrasado'].includes(c.estado)) continue;
      const key = R.apStageKey(c.venc, hoje, store.config.diasProximo);
      if (ap().stages[key] !== c.stageId) { await updateDeal(c.id, { STAGE_ID: ap().stages[key] }); movidas++; }
    }
    // cartão movido para "Pago" direto no Bitrix sem data: registra hoje
    for (const c of (await contas()).filter(x => x.estado === 'pago' && !x.pagoEm)) { await updateDeal(c.id, { [UF('CP_PAGO_EM')]: hoje }); await timeline(c.id, `Marcada como paga no Bitrix: data de pagamento registrada como ${hoje.split('-').reverse().join('/')}.`); }
    return { movidas };
  }

  // Extrato: tudo que temos com um parceiro/fornecedor (a pagar, pago, cancelado), com totais.
  async function extrato(parceiroId) {
    const p = (await parceiros()).find(x => x.id === +parceiroId);
    if (!p) throw fail(404, 'Parceiro não encontrado.');
    const lista = (await contasCached(0)).filter(c => c.parceiroId === p.id).sort((a, b) => String(b.venc).localeCompare(String(a.venc)));
    const sum = f => r2(lista.filter(f).reduce((x, c) => x + (c.estado === 'pago' ? (c.valorPago || c.valor) : c.valor), 0));
    return { parceiro: p, itens: lista, totais: { aguardando: sum(c => c.estado === 'aguardando'), aPagar: sum(c => ['aberto', 'proximo', 'atrasado'].includes(c.estado)), pago: sum(c => c.estado === 'pago'), cancelado: sum(c => c.estado === 'cancelado') } };
  }

  // ---------- resumos para a tela ----------
  function resumoContas(list, hoje = R.todayBR()) {
    const sum = a => r2(a.reduce((x, c) => x + c.valor, 0));
    const sumPago = a => r2(a.reduce((x, c) => x + (c.valorPago || c.valor), 0));
    const ab = list.filter(c => ['aberto', 'proximo', 'atrasado'].includes(c.estado));
    const mes = hoje.slice(0, 7);
    return {
      aPagar: { valor: sum(ab), qtd: ab.length }, atrasado: { valor: sum(ab.filter(c => c.estado === 'atrasado')), qtd: ab.filter(c => c.estado === 'atrasado').length },
      venceEm7: sum(ab.filter(c => c.venc && R.dayDiff(c.venc, hoje) >= 0 && R.dayDiff(c.venc, hoje) <= 7)),
      aguardando: { valor: sum(list.filter(c => c.estado === 'aguardando')), qtd: list.filter(c => c.estado === 'aguardando').length },
      pagoMes: sumPago(list.filter(c => c.estado === 'pago' && (c.pagoEm || '').startsWith(mes))), pago: { valor: sumPago(list.filter(c => c.estado === 'pago')), qtd: list.filter(c => c.estado === 'pago').length },
      cancelado: { valor: sum(list.filter(c => c.estado === 'cancelado')), qtd: list.filter(c => c.estado === 'cancelado').length },
    };
  }
  function parceirosComResumo(ps, list) {
    return ps.map(p => {
      const mine = list.filter(c => c.parceiroId === p.id && c.estado !== 'cancelado');
      const sum = f => r2(mine.filter(f).reduce((x, c) => x + c.valor, 0));
      return { ...p, aguardando: sum(c => c.estado === 'aguardando'), aPagar: sum(c => ['aberto', 'proximo', 'atrasado'].includes(c.estado)), atrasado: sum(c => c.estado === 'atrasado'), pagoTotal: r2(mine.filter(c => c.estado === 'pago').reduce((x, c) => x + (c.valorPago || c.valor), 0)), qtd: mine.length };
    });
  }

  return {
    ensure, loadEnums, parceiros, walletsDeParceiros, salvarParceiro, contas, contasCached, extrato, criarConta, pagarConta, cancelarConta, desfazerPagamento, editarConta,
    sincronizarRepasses, tickDatas, resumoContas, parceirosComResumo, invalidate() { pCache.at = 0; },
    consts: { AP_FORMAS, AP_CATEGORIAS, PIX_TIPOS, BASES },
  };
}
module.exports = { createPagar, DEAL_FIELDS, PARTNER_FIELDS, AP_NAME };
