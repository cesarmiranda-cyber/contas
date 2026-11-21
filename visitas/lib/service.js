'use strict';
const R = require('./rules');
const F = require('./fields');
const { ETYPE, A } = F;

const ABERTAS = ['NEW', 'PREPARATION', 'LATE'];
const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
// Normaliza data do Bitrix para AAAA-MM-DD (aceita ISO com hora e DD/MM/AAAA); texto inválido vira vazio.
const dia = v => {
  const t = v ? String(v).trim() : '';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{2})[/.](\d{2})[/.](\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const val = v => (Array.isArray(v) ? v[0] : v);
const val0 = val;
const txt = v => (v === undefined || v === null ? '' : String(v));
const MAXTXT = 20000;
const limpa = (v, max = MAXTXT) => txt(v).slice(0, max);

function createService({ bitrix: bx, store, now = () => new Date() }) {
  const hoje = () => R.todayBR(now());
  const cfg = () => store.config;
  // ---------- caches e travas ----------
  let modeloC = null, modeloAt = 0;
  async function modelo(force) {
    if (!force && modeloC && Date.now() - modeloAt < 300000) return modeloC;
    modeloC = await F.descobrir(bx, cfg().mapa); modeloAt = Date.now(); return modeloC;
  }
  const memo = new Map();
  let epoca = 0;     // invalidar() muda a época: uma busca iniciada antes de uma gravação não pode repor dado velho no cache
  // Cache com "stale-while-revalidate": dentro de `ttl` é fresco; até `stale` devolve o antigo na hora e atualiza em segundo plano.
  async function cached(key, ttl, fn, stale = 0) {
    const c = memo.get(key), idade = c ? Date.now() - c.at : Infinity, temV = c && c.v !== undefined;
    if (temV && idade < ttl) return c.v;
    if (c?.p) return stale && temV && idade < stale ? c.v : c.p;
    const e0 = epoca;
    const p = fn().then(v => { if (e0 === epoca) memo.set(key, { at: Date.now(), v }); return v; }, err => { const cur = memo.get(key); if (cur?.p === p) { if (cur.v === undefined) memo.delete(key); else delete cur.p; } throw err; });
    memo.set(key, { at: c?.at || 0, v: c?.v, p });
    if (stale && temV && idade < stale) { p.catch(() => {}); return c.v; }
    return p;
  }
  const invalidar = (...ks) => { epoca++; for (const k of ks.length ? ks : [...memo.keys()]) memo.delete(k); };
  const travas = new Map();
  async function comTrava(k, fn) {
    const ant = travas.get(k) || Promise.resolve();
    const prox = ant.catch(() => {}).then(fn);
    travas.set(k, prox);
    try { return await prox; } finally { if (travas.get(k) === prox) travas.delete(k); }
  }

  // ---------- leitura de campos de lista ----------
  const enumTexto = (def, v) => { const x = val(v); if (x === undefined || x === null || x === '') return ''; return def?.[String(x)] ?? String(x); };
  const enumId = (def, texto) => { const k = Object.keys(def || {}).find(i => R.norm(def[i]) === R.norm(texto)); return k !== undefined ? k : undefined; };
  function escreverLista(items, texto) { // campo de lista ou texto livre
    const id = enumId(Object.fromEntries((items || []).map(i => [String(i.ID), i.VALUE])), texto);
    return items?.length ? (id ?? '') : texto;
  }
  const itensDe = (fields, key) => fields?.[key]?.items || [];

  // ---------- empresas ----------
  async function empresasSync(m) {
    const ufs = new Set();
    for (const s of Object.values(m.empresa.segmentos)) [...Object.values(s.cargos).flat(), ...s.classe, ...s.proxima, ...s.ultima].forEach(c => ufs.add(c));
    return bx.listAll('crm.company.list', { select: ['ID', 'TITLE', ...ufs], order: { ID: 'ASC' } });
  }
  const primeiro = (comp, campos) => { for (const c of campos || []) { const v = val(comp[c]); if (v !== undefined && v !== null && v !== '' && v !== '0' && v !== 0) return v; } return ''; };
  function leituraEmpresa(m, comp, segKey, cargo) {
    const s = m.empresa.segmentos[segKey];
    const classe = R.classeLetra(enumTexto(m.empresa.enums[s.classe.find(c => comp[c])] || m.empresa.enums[s.classe[0]], primeiro(comp, s.classe)));
    return { vendedor: txt(primeiro(comp, s.cargos[cargo])), classe, proxima: dia(primeiro(comp, s.proxima)), ultima: dia(primeiro(comp, s.ultima)) };
  }
  async function atualizarEmpresa(m, empresaId, segNome, { ultima, proxima }) {
    if (!cfg().atualizarProxima) return;
    const s = m.empresa.segmentos[R.norm(segNome)];
    if (!s) return;
    const fields = {};
    if (ultima && s.ultima[0]) fields[s.ultima[0]] = ultima;
    if (proxima && s.proxima[0]) fields[s.proxima[0]] = proxima;
    if (Object.keys(fields).length) {
      await bx.call('crm.company.update', { id: empresaId, fields });
      const k = `${empresaId}|${R.norm(segNome)}`, cur = ultDados.get(k) || {};   // mantém o cache de datas em dia sem reler a empresa
      ultDados.set(k, { ultima: ultima || cur.ultima || '', proxima: proxima || cur.proxima || '' });
    }
  }
  // Datas "Última/Próxima visita" do cadastro, por empresa+segmento. Só lê as empresas que têm card (poucas), em lotes de 50;
  // o que já foi lido responde na hora e é renovado em segundo plano (a 1ª leitura de uma empresa é a única que espera).
  const ultDados = new Map(), ultEmp = new Map();
  const chaveUlt = c => `${c.empresaId}|${R.norm(c.segmento)}`;
  const ufsEmpresa = m => [...new Set(Object.values(m.empresa.segmentos).flatMap(s => [...s.ultima, ...s.proxima]))];
  function guardaEmpresa(m, comp) {
    for (const [k, s] of Object.entries(m.empresa.segmentos)) {
      const ultima = dia(primeiro(comp, s.ultima)), proxima = dia(primeiro(comp, s.proxima)), chave = `${comp.ID}|${k}`;
      if (ultima || proxima) ultDados.set(chave, { ultima, proxima }); else ultDados.delete(chave);
    }
    ultEmp.set(String(comp.ID), Date.now());
  }
  async function lerEmpresas(m, ids) {
    const sel = ['ID', ...ufsEmpresa(m)], lotes = [];
    for (let i = 0; i < ids.length; i += 50) lotes.push(ids.slice(i, i + 50));
    await Promise.all(lotes.map(async l => { for (const c of (await bx.call('crm.company.list', { filter: { ID: l }, select: sel })).result || []) guardaEmpresa(m, c); }));
  }
  async function carregaUltimas(m, ids) {
    const unicos = [...new Set(ids.map(String))], agora = Date.now();
    const novos = unicos.filter(i => !ultEmp.has(i)), velhos = unicos.filter(i => ultEmp.has(i) && agora - ultEmp.get(i) > 600000);
    if (novos.length) await lerEmpresas(m, novos);
    if (velhos.length) { velhos.forEach(i => ultEmp.set(i, agora)); lerEmpresas(m, velhos).catch(() => {}); }
  }
  // Regra: sem "Última visita" no cadastro da empresa (naquele segmento), o card não aparece no app.
  async function comUltima(m, cards) {
    if (!cfg().exigirUltimaVisita) return { cards, ocultos: 0, agendados: 0 };
    await carregaUltimas(m, cards.map(c => c.empresaId));
    const ok = [], h = hoje(); let agendados = 0;
    for (const c of cards) {
      // A regra filtra a FILA PENDENTE. Card já finalizado/encerrado (visita que aconteceu) não some por falta de Última visita.
      if (ultDados.get(chaveUlt(c))?.ultima || store.admitido(c.id) || !ABERTAS.includes(c.etapa)) ok.push(c);
      else if (ABERTAS.includes(c.etapa) && c.data && c.data > h) agendados++;       // oculto, mas já agendado para o futuro: candidato a "incluir no app"
    }
    return { cards: ok, ocultos: cards.length - ok.length, agendados };
  }
  // Exceção pontual: inclui no app os cards abertos JÁ agendados para o futuro, mesmo sem Última visita no cadastro.
  // Ficam fixados como visíveis (inclusive no dia da visita); os próximos cards seguem o ciclo normal.
  async function admitirAgendados(user) {
    const m = await modelo(), h = hoje(), todos = (await cardsC(m)).filter(c => ABERTAS.includes(c.etapa) && c.data && c.data > h);
    await carregaUltimas(m, todos.map(c => c.empresaId));
    const alvo = todos.filter(c => !ultDados.get(chaveUlt(c))?.ultima && !store.admitido(c.id));
    const n = store.admitir(alvo.map(c => c.id));
    store.log('admitir', `${n} card(s) já agendados para o futuro incluídos no app por ${user.nome || user.id} (sem Última visita no cadastro)`);
    invalidar('cards', 'dash');
    return { ok: true, admitidos: n, totalAdmitidos: store.totalAdmitidos };
  }
  // Aquece os caches (modelo, cards e datas do cadastro) para a 1ª abertura da tela não esperar o Bitrix.
  async function aquecer() {
    if (!bx.enabled) return;
    const m = await modelo(), cards = await cardsC(m);
    await carregaUltimas(m, cards.filter(c => c.etapa !== 'FAIL').map(c => c.empresaId));
  }
  async function tituloEmpresas(ids) {
    const falta = [...new Set(ids)].filter(i => !memo.get(`emp:${i}`));
    for (let i = 0; i < falta.length; i += 50) {
      const r = await bx.call('crm.company.list', { filter: { ID: falta.slice(i, i + 50) }, select: ['ID', 'TITLE'] });
      for (const c of r.result || []) memo.set(`emp:${c.ID}`, { at: Date.now(), v: c.TITLE });
    }
    return id => memo.get(`emp:${id}`)?.v || `Empresa #${id}`;
  }

  // ---------- usuários e escopo ----------
  async function nomes(ids) {
    const falta = [...new Set(ids.map(String).filter(Boolean))].filter(i => !memo.get(`u:${i}`));
    for (let i = 0; i < falta.length; i += 50) {
      try {
        const r = await bx.call('user.get', { FILTER: { ID: falta.slice(i, i + 50) } });
        for (const u of r.result || []) memo.set(`u:${u.ID}`, { at: Date.now(), v: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || u.EMAIL || `#${u.ID}` });
      } catch { /* sem escopo user */ }
    }
    return id => memo.get(`u:${id}`)?.v || `Usuário #${id}`;
  }
  async function departamentos() {
    return cached('depts', 300000, async () => {
      const r = await bx.listAll('department.get', {}).catch(() => []);
      return r.map(d => ({ id: String(d.ID), nome: d.NAME, pai: String(d.PARENT || ''), chefe: String(d.UF_HEAD || '') }));
    });
  }
  async function usuariosDe(deptIds) {
    const out = new Set();
    for (const d of deptIds) { const us = await bx.listAll('user.get', { FILTER: { UF_DEPARTMENT: d, ACTIVE: true } }).catch(() => []); us.forEach(u => out.add(String(u.ID))); }
    return out;
  }
  // null = vê tudo; senão Set de vendedores visíveis (o próprio + equipe dos departamentos que chefia)
  // REGRA DE VISIBILIDADE: cada responsável vê somente os próprios registros. Só quem está em "Quem vê tudo" (Configurações) vê os de todos.
  // Enquanto "Quem vê tudo" estiver vazio (configuração inicial), os administradores do portal veem tudo para não ficarem trancados de fora.
  // null = vê tudo; senão, Set com o próprio ID (o vendedor do card).
  async function escopo(user) {
    const ver = cfg().verTudo.map(String);
    if (ver.includes(String(user.id))) return null;
    if (!ver.length && user.papel === 'admin') return null;
    return new Set([String(user.id)]);
  }
  const veTudo = async user => (await escopo(user)) === null;
  // Equipe de um supervisor (departamentos que ele chefia): usada SOMENTE no filtro "supervisor" do painel, nunca para dar acesso.
  async function equipeDe(userId) {
    return cached(`eq:${userId}`, 300000, async () => {
      const set = new Set([String(userId)]);
      const ds = await departamentos();
      const chefiados = ds.filter(d => d.chefe === String(userId)).map(d => d.id);
      if (chefiados.length) {
        const todos = new Set(chefiados);
        for (let ch = true; ch;) { ch = false; for (const d of ds) if (!todos.has(d.id) && todos.has(d.pai)) { todos.add(d.id); ch = true; } }
        (await usuariosDe([...todos])).forEach(u => set.add(u));
      }
      return set;
    });
  }
  // Acesso ao app por departamento (inclui subdepartamentos). Vazio = todos. Administradores sempre entram.
  async function temAcesso(user) {
    const allow = cfg().deptsAcesso.map(String);
    if (!allow.length || user.papel === 'admin' || !bx.enabled) return true;
    return cached(`acc:${user.id}:${allow.join(',')}`, 300000, async () => {
      const ds = await departamentos(), ok = new Set(allow);
      for (let ch = true; ch;) { ch = false; for (const d of ds) if (!ok.has(d.id) && ok.has(d.pai)) { ok.add(d.id); ch = true; } }
      const r = await bx.call('user.get', { FILTER: { ID: user.id } });
      return A(r.result?.[0]?.UF_DEPARTMENT).map(String).some(d => ok.has(d));
    });
  }
  async function supervisores() {
    const c = cfg(), ids = new Set(c.supervisoresExtras.map(String));
    const ds = await departamentos();
    for (const d of ds) if (c.supervisoresDepts.map(String).includes(d.id) && d.chefe) ids.add(d.chefe);
    if (c.supervisoresDepts.length) (await usuariosDe(c.supervisoresDepts.map(String))).forEach(u => ids.add(u));
    const n = await nomes([...ids]);
    return [...ids].map(id => ({ id, nome: n(id) }));
  }

  // ---------- cards ----------
  const etapaCod = (m, stageId) => Object.entries(m.etapas).find(([, v]) => v === stageId)?.[0] || '';
  // Responsável: campo "Vendedor" do SPA (se houver), senão o responsável do card; 0/vazio = sem vendedor.
  function vendedorDe(m, it) {
    const x = txt(val(m.fila.vendedor && it[m.fila.vendedor])) || txt(it.assignedById);
    return /^[1-9]\d*$/.test(x) ? x : '';
  }
  function paraCard(m, it) {
    const f = m.fila, ff = m.filaFields;
    const lista = k => { const v = it[f[k]]; const items = itensDe(ff, f[k]); const x = val(v); return items.length ? (items.find(i => String(i.ID) === String(x))?.VALUE || '') : txt(x); };
    let etapa = etapaCod(m, it.stageId) || 'OUTRA';
    const data = dia(it[f.data]);
    if (!m.etapaReal?.LATE && (etapa === 'NEW' || etapa === 'PREPARATION') && data && data < hoje()) etapa = 'LATE';     // sem etapa "Atrasada" no SPA: o atraso é calculado pela data
    return {
      id: +it.id, titulo: it.title, empresaId: +it.companyId || 0, etapa, etapaNome: m.etapaNomes?.[it.stageId] || '', vendedorId: vendedorDe(m, it),
      segmento: lista('segmento'), cargo: lista('cargo') || 'Vendedor', classe: R.classeLetra(lista('classe')), data,
      motivo: lista('motivo'), detalhe: txt(it[f.detalhe]), alcada: f.alcada ? lista('alcada') : '', criado: it.createdTime || '',
    };
  }
  async function cardsTodos(m, extra = {}) {
    const f = m.fila;
    const sel = ['id', 'title', 'companyId', 'stageId', 'assignedById', 'createdTime', ...['segmento', 'cargo', 'classe', 'data', 'motivo', 'detalhe', 'vendedor', 'alcada'].map(k => f[k]).filter(Boolean)];
    return (await bx.listAll('crm.item.list', { entityTypeId: ETYPE.fila, select: sel, filter: { categoryId: m.categoryId, ...extra }, order: { id: 'ASC' } })).map(i => paraCard(m, i));
  }
  const cardsC = m => cached('cards', 45000, () => cardsTodos(m), 600000);
  async function umCard(m, id) {
    const r = await bx.call('crm.item.get', { entityTypeId: ETYPE.fila, id });
    const it = r.result?.item || r.result;
    if (!it || +it.categoryId !== m.categoryId && it.categoryId !== undefined) throw fail(404, 'Card não encontrado.');
    return paraCard(m, it);
  }
  // Data no formato do campo do SPA: texto "dd/mm/aaaa hh:mm:ss" (padrão do seu SPA) ou ISO para campos de data.
  const dataParaBitrix = (m, iso) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso; const t = String(m.filaFields?.[m.fila.data]?.type || ''); return /^(date|datetime)$/.test(t) ? iso : `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} 00:00:00`; };
  async function criarCard(m, { empresaId, empresa, segmento, cargo = 'Vendedor', classe, vendedorId, data }) {
    const f = m.fila, ff = m.filaFields;
    const minimo = { title: empresa, companyId: empresaId, categoryId: m.categoryId, stageId: m.etapas[R.etapaPorData(data, hoje())] || m.etapas.NEW, assignedById: vendedorId };
    const extra = { [f.segmento]: escreverLista(itensDe(ff, f.segmento), segmento), [f.classe]: escreverLista(itensDe(ff, f.classe), R.classeNome(classe)), [f.data]: dataParaBitrix(m, data) };
    if (f.cargo) extra[f.cargo] = escreverLista(itensDe(ff, f.cargo), cargo);
    if (f.usuario) extra[f.usuario] = String(vendedorId);
    if (f.idEmpresa) extra[f.idEmpresa] = String(empresaId);
    let id;
    try { const r = await bx.call('crm.item.add', { entityTypeId: ETYPE.fila, fields: { ...minimo, ...extra } }); id = +(r.result?.item?.id || r.result?.id); }
    catch (e) {
      // O Bitrix recusou o cadastro completo: cria só o essencial e grava os demais campos um a um, para descobrir qual deles ele não aceita.
      store.log('erro', `criar card (${empresa} · ${segmento} · ${cargo}): cadastro completo recusado (${e.message}); tentando só o essencial`.slice(0, 300));
      const r = await bx.call('crm.item.add', { entityTypeId: ETYPE.fila, fields: minimo });
      id = +(r.result?.item?.id || r.result?.id);
      for (const [campo, valor] of Object.entries(extra)) {
        try { await bx.call('crm.item.update', { entityTypeId: ETYPE.fila, id, fields: { [campo]: valor } }); }
        catch (e2) { store.log('erro', `criar card ${id}: o Bitrix recusou o campo ${campo} = ${JSON.stringify(valor)} (${e2.message})`.slice(0, 300)); }
      }
    }
    invalidar('cards');
    return id;
  }
  const atualizarCard = async (id, fields) => { await bx.call('crm.item.update', { entityTypeId: ETYPE.fila, id, fields }); invalidar('cards'); };
  const NOME_ETAPA = { NAOREAL: 'Não realizada', LATE: 'Atrasada', ENC: 'Finalizado', NEW: 'Aguardando', PREPARATION: 'Dia da visita', FAIL: 'Removido' };
  const mover = (m, id, cod, extra = {}) => { if (!m.etapas[cod]) throw fail(409, `A etapa "${NOME_ETAPA[cod] || cod}" não existe no SPA da fila.${cod === 'NAOREAL' || cod === 'LATE' ? ' Rode "Preparar Bitrix" em Configurações para criá-la.' : ''}`); return atualizarCard(id, { stageId: m.etapas[cod], ...extra }); };
  const mesmaEtapa = (m, a, b2) => !!m.etapas[a] && m.etapas[a] === m.etapas[b2];

  // Cria o próximo card (se a chave não tiver aberto) e atualiza a "Próxima visita" do cadastro.
  async function gerarProximo(m, card, baseData) {
    const todos = (await cardsTodos(m, { companyId: card.empresaId }));
    const k = R.chaveCard(card.empresaId, card.segmento, card.cargo);
    const aberto = todos.find(c => R.chaveCard(c.empresaId, c.segmento, c.cargo) === k && ABERTAS.includes(c.etapa));
    if (aberto) return aberto.id;
    if (!card.classe || !card.vendedorId) return null;      // sem classe ou sem responsável não há próximo card a gerar
    const data = R.proximaVisita(card.classe, baseData, cfg());
    const emp = (await tituloEmpresas([card.empresaId]))(card.empresaId);
    const id = await criarCard(m, { empresaId: card.empresaId, empresa: emp, segmento: card.segmento, cargo: card.cargo, classe: card.classe, vendedorId: card.vendedorId, data });
    await atualizarEmpresa(m, card.empresaId, card.segmento, { proxima: data });
    return id;
  }

  // ---------- sincronização ----------
  let sincronizando = null;
  function sync({ forcar = false, previa: soPrevia = false } = {}) {
    if (sincronizando) return sincronizando;
    sincronizando = (async () => {
      const m = await modelo(true), h = hoje(), previa = soPrevia || (!cfg().ativo && !forcar);
      if (m.faltando.length && !Object.keys(m.empresa.segmentos).length) return { ok: false, faltando: m.faltando };
      const [empresas, cards] = await Promise.all([empresasSync(m), cardsTodos(m)]);
      for (const comp of empresas) guardaEmpresa(m, comp);
      const porChave = new Map();
      for (const c of cards) { const k = R.chaveCard(c.empresaId, c.segmento, c.cargo); (porChave.get(k) || porChave.set(k, []).get(k)).push(c); }
      const r = { ok: true, previa, criados: 0, removidos: 0, atualizados: 0, naoRealizadas: 0, semClasse: 0, empresas: empresas.length };
      const primeiras = { A: [], B: [], C: [], E: [] }, acoes = [];
      for (const comp of empresas) {
        for (const segKey of Object.keys(m.empresa.segmentos)) {
          const seg = m.empresa.segmentos[segKey];
          for (const cargo of cfg().cargosFila) {
            if (!seg.cargos[cargo]) continue;
            const { vendedor, classe, proxima, ultima } = leituraEmpresa(m, comp, segKey, cargo);
            const k = R.chaveCard(comp.ID, seg.nome, cargo), ex = porChave.get(k) || [], abertos = ex.filter(c => ABERTAS.includes(c.etapa));
            const semUlt = cfg().exigirUltimaVisita && !ultima && !abertos.some(c => store.admitido(c.id));   // card admitido à mão segue o fluxo normal
            if (!vendedor || !classe) { if (vendedor && !classe) r.semClasse++; continue; }       // sem responsável/classe no cadastro: o app não cria nada e NÃO remove cards (a auditoria apenas aponta)
            if (!abertos.length) {
              const ult = ex.filter(c => c.etapa !== 'FAIL').sort((a, b) => b.id - a.id)[0];
              const base = { empresaId: +comp.ID, empresa: comp.TITLE, segmento: seg.nome, cargo, classe, vendedorId: vendedor };
              if (semUlt) { r.semUltima = (r.semUltima || 0) + 1; continue; }              // sem última visita no cadastro: não entra na fila
              if (!ex.length && cfg().exigirUltimaVisita && !(proxima && proxima >= h)) {   // 1º card nasce da última visita + intervalo da classe
                let data = R.proximaVisita(classe, ultima, cfg()); if (R.etapaPorData(data, h) === 'NAOREAL') data = R.nextBusinessDay(h);
                r.criados++; (r.detalhes ||= []).push(`criar: ${comp.TITLE} · ${seg.nome} · ${cargo} · ${data}`); acoes.push(async () => { await criarCard(m, { ...base, data }); await atualizarEmpresa(m, base.empresaId, base.segmento, { proxima: data }); });
              } else if (!ex.length) {
                if (proxima && proxima >= h) { r.criados++; (r.detalhes ||= []).push(`criar: ${comp.TITLE} · ${seg.nome} · ${cargo} · ${proxima} (Próxima visita do cadastro)`); acoes.push(() => criarCard(m, { ...base, data: proxima })); }
                else primeiras[classe].push(base);
              } else if (ult) { r.criados++; acoes.push(() => criarCard(m, { ...base, data: R.proximaVisita(classe, ult.etapa === 'NAOREAL' ? (ult.data > h ? ult.data : h) : (ult.data || h), cfg()) })); }
              continue;
            }
            if (semUlt) continue;                                                       // card existente sem última visita: fica como está (oculto no app)
            // Mais de um card aberto para o mesmo cliente+segmento+cargo NÃO é removido pelo app: a auditoria aponta e você decide.
            const c = abertos[0], upd = {};
            if (!c.vendedorId) { upd.assignedById = vendedor; if (m.fila.usuario) upd[m.fila.usuario] = String(vendedor); }      // só preenche responsável vazio; se difere do cadastro, a auditoria aponta
            if (c.classe !== classe) upd[m.fila.classe] = escreverLista(itensDe(m.filaFields, m.fila.classe), R.classeNome(classe));
            const alvo = c.data ? R.etapaPorData(c.data, h) : c.etapa;
            if (alvo === 'NAOREAL') { if (m.etapas.NAOREAL) { r.naoRealizadas++; acoes.push(() => naoRealizadaAuto(m, c)); } else r.semEtapaNaoRealizada = (r.semEtapaNaoRealizada || 0) + 1; continue; }
            if (m.etapas[alvo] && !mesmaEtapa(m, alvo, c.etapa)) upd.stageId = m.etapas[alvo];
            if (Object.keys(upd).length) { r.atualizados++; (r.detalhes ||= []).push(`atualizar card ${c.id} (${comp.TITLE} · ${seg.nome} · ${cargo}): ${Object.keys(upd).map(k => ({ assignedById: 'responsável', stageId: 'etapa', [m.fila.classe]: `classe ${c.classe || '—'}→${classe}`, [m.fila.usuario]: 'usuário' }[k] || k)).join(', ')}`); acoes.push(() => atualizarCard(c.id, upd)); }
          }
        }
      }
      for (const [classe, lista] of Object.entries(primeiras)) {
        lista.forEach((b, i) => {
          const data = R.primeiraVisita(classe, i, lista.length, h, cfg());
          r.criados++; acoes.push(async () => { await criarCard(m, { ...b, data }); await atualizarEmpresa(m, b.empresaId, b.segmento, { proxima: data }); });
        });
      }
      if (!previa) {
        // Executa em pequenos lotes; a primeira data também grava a "Próxima visita" no cadastro.
        for (let i = 0; i < acoes.length; i += 8) await Promise.all(acoes.slice(i, i + 8).map(f => f().catch(e => store.log('erro', `sync: ${e.message}`.slice(0, 300)))));
        invalidar('cards', 'dash');
      }
      if (r.detalhes) r.detalhes = r.detalhes.slice(0, 30);
      store.log('sync', `${previa ? 'Prévia' : 'Sincronização'}: ${r.criados} a criar, ${r.removidos} removidos, ${r.atualizados} atualizados, ${r.naoRealizadas} não realizadas`);
      return r;
    })().finally(() => { sincronizando = null; });
    return sincronizando;
  }
  // Varredura leve (a cada ~30 s): só ajusta as etapas dos cards abertos conforme a data.
  let varrendo = false;
  async function varrer() {
    if (!store.ativo) return { ok: true, ativo: false };
    if (varrendo || sincronizando) return { ok: true, ocupado: true };
    varrendo = true;
    try {
      const m = await modelo(), h = hoje();
      const abertos = (await comUltima(m, (await cardsC(m)).filter(c => ABERTAS.includes(c.etapa) && c.data))).cards;     // usa o cache: não refaz a leitura inteira a cada 30 s
      let n = 0;
      for (const c of abertos) {
        const alvo = R.etapaPorData(c.data, h);
        if (alvo === c.etapa || !m.etapas[alvo] || mesmaEtapa(m, alvo, c.etapa)) continue;    // etapa igual ou inexistente no SPA: nada a fazer
        n++;
        if (alvo === 'NAOREAL') await naoRealizadaAuto(m, c); else await mover(m, c.id, alvo);
      }
      return { ok: true, ajustados: n };
    } finally { varrendo = false; }
  }
  async function naoRealizadaAuto(m, c) {
    if (!m.etapas.NAOREAL) return;
    await comTrava(`c:${c.empresaId}`, async () => {
      await mover(m, c.id, 'NAOREAL', m.fila.detalhe ? { [m.fila.detalhe]: 'Mês encerrado sem registro de visita.' } : {});
      await gerarProximo(m, c, hoje());
    });
  }

  // ---------- ações do vendedor ----------
  async function podeAgir(user, card) {
    const esc = await escopo(user);
    if (esc && !esc.has(String(card.vendedorId))) throw fail(403, 'Este card não é seu nem da sua equipe.');
  }
  async function carregar(id, user) {
    const m = await modelo(), card = await umCard(m, id);
    await podeAgir(user, card);
    return { m, card };
  }
  // Outros campos personalizados do SPA de registros (editáveis no formulário): os que o app ainda não conhece, de tipo simples e valor único.
  const TIPOS_EXTRA = /^(string|integer|double|boolean|date|datetime|enumeration)$/;
  function extrasDef(m) {
    const usados = new Set(Object.entries(m.visita).filter(([k]) => !k.endsWith('_todos') && !k.endsWith('Enum')).map(([, c]) => c).filter(Boolean));
    return Object.entries(m.visitaFields || {}).filter(([k, d]) => /^uf/i.test(k) && !usados.has(k) && TIPOS_EXTRA.test(String(d.type || '')) && !d.isMultiple && !d.isReadOnly)
      .map(([k, d]) => ({ key: k, label: F.label(d) || k, type: String(d.type), opcoes: (d.items || []).map(i => i.VALUE) }));
  }
  function valorExtra(d, x, itens) {
    if (x === undefined || x === null) return undefined;
    if (d.type === 'enumeration') return x ? (itens.find(i => R.norm(i.VALUE) === R.norm(x))?.ID ?? '') : '';
    if (d.type === 'boolean') return /^(y|1|true|sim)$/i.test(String(x)) ? 'Y' : /^(n|0|false|nao|não)$/i.test(String(x)) ? 'N' : '';
    if (d.type === 'integer') return /^-?\d{1,15}$/.test(String(x).trim()) ? String(x).trim() : '';
    if (d.type === 'double') return Number.isFinite(Number(String(x).replace(',', '.'))) && String(x).trim() !== '' ? String(Number(String(x).replace(',', '.'))) : '';
    if (d.type === 'date' || d.type === 'datetime') return /^\d{4}-\d{2}-\d{2}/.test(String(x)) ? String(x) : '';
    return limpa(x, 2000);
  }
  function camposVisita(m, b, vendedorId) {
    const v = m.visita, vf = m.visitaFields, f = {};
    const set = (k, x) => { if (v[k] && x !== undefined) f[v[k]] = x; };
    const lista = (k, x) => { const items = itensDe(vf, v[k]); return items.length ? (x ? (items.find(i => R.norm(i.VALUE) === R.norm(x))?.ID ?? '') : '') : txt(x); };
    set('fatos', limpa(b.fatos)); set('interesses', limpa(b.interesses)); set('sentimentos', limpa(b.sentimentos)); set('valores', limpa(b.valores));
    set('populacao', limpa(b.populacao)); set('resultado', limpa(b.resultado));
    if (v.regime) f[v.regime] = lista('regime', b.regime);
    if (v.oportunidades) f[v.oportunidades] = lista('oportunidades', b.oportunidades);
    if (v.antecipada) f[v.antecipada] = lista('antecipada', b.antecipada);
    if (v.alcada) f[v.alcada] = lista('alcada', b.alcada);
    if (b.extras && typeof b.extras === 'object') for (const d of extrasDef(m)) { const x = valorExtra(d, b.extras[d.key], itensDe(vf, d.key)); if (x !== undefined) f[d.key] = x; }
    if (v.acompanhamento) f[v.acompanhamento] = lista('acompanhamento', b.acompanhamento);
    if (v.supervisor && /^\d{1,12}$/.test(txt(b.supervisor))) f[v.supervisor] = txt(b.supervisor);
    if (Array.isArray(b.anexos) && b.anexos.length && v.anexos) {
      let total = 0;
      f[v.anexos] = b.anexos.slice(0, 10).map(a => {
        const b64 = String(a?.base64 || '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw fail(400, 'Anexo inválido.');
        total += b64.length; if (total > 27e6) throw fail(413, 'Anexos passam de 20 MB.');
        return [String(a.nome || 'anexo').replace(/[\\/\r\n\0]/g, '_').slice(0, 120), b64];
      });
    }
    return f;
  }
  async function registrar(id, b, user) {
    const { m, card } = await carregar(id, user);
    return comTrava(`c:${card.empresaId}`, async () => {
      const atual = await umCard(m, id);
      if (!ABERTAS.includes(atual.etapa)) throw fail(409, 'Este card não está aberto (já encerrado, não realizado ou removido).');
      const h = hoje();
      const dataHora = String(b.dataHora || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(dataHora)) throw fail(400, 'Informe a data/hora da visita.');
      if (dataHora.slice(0, 10) > h) throw fail(400, 'A visita não pode estar no futuro. Para mudar a data, use "Alterar visita".');
      if (!txt(b.fatos).trim()) throw fail(400, 'Preencha "Fatos e dados".');
      const f = camposVisita(m, b, card.vendedorId);
      const contatos = A(b.contatos).slice(0, 50).map(Number).filter(n => Number.isInteger(n) && n > 0);
      Object.assign(f, { title: `Visita · ${card.titulo}`.slice(0, 250), companyId: card.empresaId, assignedById: card.vendedorId, [m.visita.data]: dataHora.length > 10 ? dataHora : `${dataHora}T09:00:00`,
        [m.visita.idFila]: String(id), [m.visita.segmento]: escreverLista(itensDe(m.visitaFields, m.visita.segmento), card.segmento) });
      if (contatos.length) f.contactIds = contatos;
      if (m.visita.alcada && !txt(b.alcada).trim()) f[m.visita.alcada] = escreverLista(itensDe(m.visitaFields, m.visita.alcada), card.cargo);   // Alçada do registro = cargo do card
      // Idempotente: se já existe registro deste card (tentativa anterior que parou no meio), atualiza o mesmo em vez de criar outro.
      const ja = await bx.call('crm.item.list', { entityTypeId: ETYPE.visita, select: ['id'], filter: { [m.visita.idFila]: String(id) }, order: { id: 'ASC' } });
      let vid = +((ja.result?.items || [])[0]?.id || 0);
      if (vid) { await bx.call('crm.item.update', { entityTypeId: ETYPE.visita, id: vid, fields: f }); store.log('visita', `Registro #${vid} já existia para o card ${id}: atualizado, sem duplicar`, { card: id }); }
      else { const r = await bx.call('crm.item.add', { entityTypeId: ETYPE.visita, fields: f }); vid = +(r.result?.item?.id || r.result?.id); }
      await mover(m, id, 'ENC');                                  // etapa do card: a única que precisa dar certo para a visita contar como feita
      // Daqui em diante a visita já está registrada e o card encerrado: falhas viram aviso (a reconciliação/sincronização corrige depois).
      const avisos = [], tenta = async (rot, fn) => { try { return await fn(); } catch (e) { avisos.push(`${rot}: ${e.message}`.slice(0, 200)); store.log('erro', `registrar ${id}: ${rot}: ${e.message}`.slice(0, 300), { card: id }); return null; } };
      const dia0 = dataHora.slice(0, 10), cadastro = ultDados.get(chaveUlt(card))?.ultima || '';
      await tenta('atualizar a empresa', () => atualizarEmpresa(m, card.empresaId, card.segmento, { ultima: !cadastro || dia0 > cadastro ? dia0 : undefined, proxima: undefined }));
      const prox = await tenta('criar a próxima visita', () => gerarProximo(m, { ...card, etapa: 'ENC' }, dia0));
      const tk = store.tarefa(id);
      if (tk) { await bx.call('tasks.task.complete', { taskId: tk }).catch(() => {}); store.setTarefa(id, null); }
      store.log('visita', `Visita registrada (#${vid}) em ${card.titulo} por ${user.nome || user.id}`, { card: id });
      invalidar('cards', 'dash', 'regs');
      return { ok: true, registro: vid, proximoCard: prox, avisos };
    });
  }
  async function reprogramar(id, { data, motivo }, user) {
    const { m, card } = await carregar(id, user);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '')) throw fail(400, 'Informe a nova data.');
    if (data < hoje()) throw fail(400, 'A nova data não pode ser no passado.');
    motivo = limpa(motivo, 500).trim();
    if (!motivo && card.classe !== 'E') throw fail(400, 'Informe o motivo da alteração (obrigatório, exceto classe E).');
    return comTrava(`c:${card.empresaId}`, async () => {
      if (!ABERTAS.includes(card.etapa)) throw fail(409, 'Só é possível alterar a data de cards abertos.');
      store.setSnap(id, { data: card.data, etapa: card.etapa });
      await mover(m, id, R.etapaPorData(data, hoje()), { [m.fila.data]: dataParaBitrix(m, data) });
      await atualizarEmpresa(m, card.empresaId, card.segmento, { proxima: data });
      store.addHistorico({ at: new Date().toISOString(), card: id, titulo: card.titulo, vendedorId: card.vendedorId, segmento: card.segmento, classe: card.classe, de: card.data, para: data, motivo, usuario: user.nome || String(user.id) });
      invalidar('dash');
      return { ok: true };
    });
  }
  async function reprogramarGrupo(ids, data, motivo, user) {
    const res = [];
    for (const id of A(ids).slice(0, 100)) res.push({ id, ...(await reprogramar(id, { data, motivo }, user).catch(e => ({ ok: false, erro: e.message }))) });
    return { resultados: res };
  }
  async function reverter(id, user) {
    const { m, card } = await carregar(id, user), s = store.snap(id);
    if (!s) throw fail(404, 'Não há alteração para reverter.');
    await mover(m, id, R.etapaPorData(s.data, hoje()) === 'NAOREAL' ? s.etapa : R.etapaPorData(s.data, hoje()), { [m.fila.data]: dataParaBitrix(m, s.data) });
    await atualizarEmpresa(m, card.empresaId, card.segmento, { proxima: s.data });
    store.setSnap(id, null); return { ok: true };
  }
  async function naoRealizada(id, { motivo, detalhe }, user) {
    const { m, card } = await carregar(id, user);
    motivo = txt(motivo).trim(); detalhe = limpa(detalhe, 2000).trim();
    if (!motivo) throw fail(400, 'Informe o motivo da não realização.');
    if (!cfg().motivosNaoRealizada.includes(motivo)) throw fail(400, 'Motivo inválido: escolha um da lista.');
    return comTrava(`c:${card.empresaId}`, async () => {
      if (!ABERTAS.includes(card.etapa)) throw fail(409, 'Só é possível marcar cards abertos.');
      const extra = {};
      if (m.fila.motivo) extra[m.fila.motivo] = escreverLista(itensDe(m.filaFields, m.fila.motivo), motivo);
      if (m.fila.detalhe) extra[m.fila.detalhe] = detalhe;
      await mover(m, id, 'NAOREAL', extra);
      if (cfg().tarefaAtiva && card.vendedorId) {
        const t = await bx.call('tasks.task.add', { fields: { TITLE: `Visita não realizada: ${card.titulo}`, DESCRIPTION: `Motivo: ${motivo}\n${detalhe}`, RESPONSIBLE_ID: card.vendedorId, DEADLINE: `${R.addDays(hoje(), 7)}T18:00:00` } }).catch(() => null);
        const tid = t?.result?.task?.id; if (tid) store.setTarefa(id, tid);
      }
      const prox = await gerarProximo(m, card, hoje());
      store.log('naoreal', `Não realizada: ${card.titulo} (${motivo})`, { card: id });
      invalidar('dash');
      return { ok: true, proximoCard: prox };
    });
  }
  function podeExcluir(user) { return user.papel === 'admin' || cfg().podeExcluir.map(String).includes(String(user.id)); }
  async function excluir(id, { gerarProxima = true } = {}, user) {
    if (!podeExcluir(user)) throw fail(403, 'Você não está na lista de quem pode excluir.');
    const { m, card } = await carregar(id, user);
    return comTrava(`c:${card.empresaId}`, async () => {
      await mover(m, id, 'FAIL'); store.marcarRemovido(id);
      const prox = gerarProxima ? await gerarProximo(m, card, card.data && card.data > hoje() ? card.data : hoje()) : null;
      store.log('exclusao', `Card excluído: ${card.titulo} por ${user.nome || user.id}`, { card: id });
      invalidar('dash'); return { ok: true, proximoCard: prox };
    });
  }
  async function restaurar(id, user) {
    if (!podeExcluir(user)) throw fail(403, 'Você não está na lista de quem pode excluir.');
    const { m, card } = await carregar(id, user);
    if (card.etapa !== 'FAIL') throw fail(409, 'Este card não está excluído.');
    await mover(m, id, card.data ? R.etapaPorData(card.data, hoje()) === 'NAOREAL' ? 'LATE' : R.etapaPorData(card.data, hoje()) : 'NEW');
    store.log('restaura', `Card restaurado: ${card.titulo}`, { card: id }); return { ok: true };
  }
  async function proxima(id, user) {
    const { m, card } = await carregar(id, user);
    return { ok: true, proximoCard: await gerarProximo(m, card, card.data && card.data > hoje() ? card.data : hoje()) };
  }
  async function participantes(id, ids, user) {
    const { card } = await carregar(id, user);
    store.addTroca(id, { at: new Date().toISOString(), usuario: user.nome || String(user.id), contatos: A(ids).slice(0, 50).map(Number).filter(n => Number.isInteger(n) && n > 0) });
    const m = await modelo(); void m; void card;
    return { ok: true };
  }

  // ---------- registros (SPA 1032) ----------
  const camposSel = m => [...new Set(['id', 'title', 'companyId', 'contactIds', 'createdBy', 'assignedById', 'createdTime', ...Object.keys(m.visitaFields || {}).filter(k => /^uf/i.test(k)), ...Object.keys(m.visita).filter(k => !k.endsWith('_todos') && !k.endsWith('Enum')).map(k => m.visita[k]).filter(Boolean)])];
  function paraRegistro(m, it) {
    const v = m.visita, vf = m.visitaFields, lista = k => { const items = itensDe(vf, v[k]); const x = val(it[v[k]]); return items.length ? (items.find(i => String(i.ID) === String(x))?.VALUE || '') : txt(x); };
    return { raw: it, id: +it.id, empresaId: +it.companyId, contatos: A(it.contactIds).map(Number), criadoPor: txt(it.createdBy), dataHora: it[v.data] || '', idFila: txt(it[v.idFila]), segmento: lista('segmento'),
      fatos: txt(it[v.fatos]), interesses: txt(it[v.interesses]), sentimentos: txt(it[v.sentimentos]), valores: txt(it[v.valores]), populacao: txt(it[v.populacao]),
      regime: lista('regime'), oportunidades: lista('oportunidades'), antecipada: lista('antecipada'), resultado: txt(it[v.resultado]), acompanhamento: lista('acompanhamento'), alcada: lista('alcada'),
      responsavelId: txt(it.assignedById), supervisor: txt(it[v.supervisor]), anexos: A(it[v.anexos]).map(a => (a && typeof a === 'object' ? { id: a.id, url: a.urlMachine || a.url || '' } : { url: a })) };
  }
  // ---- todos os campos do registro (SPA 1032), com o rótulo de cada um ----
  const fmtData = x => { const t = String(x); const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] && !(m[4] === '00' && m[5] === '00') ? ` ${m[4]}:${m[5]}` : ''}` : t; };
  function fmtCampo(def, v, nome, extra = {}) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '';
    const t = String(def?.type || ''), f = x => {
      if (def?.items?.length) { const it = def.items.find(i => String(i.ID) === String(x)); if (it) return it.VALUE; }
      if (extra.contato) return extra.contato(String(x));
      if (/^(employee|user)$/.test(t) || extra.usuario) return nome(String(x));
      if (/^date/.test(t)) return fmtData(x);
      if (/^bool/.test(t)) return /^(y|1|true)$/i.test(String(x)) ? 'Sim' : 'Não';
      if (x && typeof x === 'object') return x.name || x.title || x.value || (x.urlMachine || x.url ? 'arquivo' : '');
      return String(x);
    };
    return (Array.isArray(v) ? v : [v]).map(f).filter(Boolean).join(', ').slice(0, 4000);
  }
  const colunasVisita = m => {
    const base = [['createdTime', 'Criado em', { type: 'datetime' }], ['createdBy', 'Criado por', { usuario: true }], ['contactIds', 'Contatos', { contato: true }]];
    const dup = new Set([m.visita.data, m.visita.segmento].filter(Boolean));
    const ufs = Object.entries(m.visitaFields || {}).filter(([k]) => /^uf/i.test(k) && !dup.has(k)).map(([k, f]) => [k, F.label(f) || k, f]);
    return [...base, ...ufs].map(([k, label, def]) => ({ k, label, def }));
  };
  async function valoresRegistros(m, regs) {
    const cols = colunasVisita(m), uids = new Set(), cids = new Set();
    for (const r of regs) for (const c of cols) { const v = r.raw[c.k]; const t = String(c.def?.type || ''); if (c.k === 'createdBy' || /^(employee|user)$/.test(t)) A(v).forEach(x => uids.add(String(x))); if (c.k === 'contactIds') A(v).forEach(x => cids.add(String(x))); }
    const nm = await nomes([...uids]), cn = new Map();
    const cl = [...cids];
    for (let i = 0; i < cl.length; i += 50) { const r = await bx.call('crm.contact.list', { filter: { ID: cl.slice(i, i + 50) }, select: ['ID', 'NAME', 'LAST_NAME'] }).catch(() => ({ result: [] })); for (const c of r.result || []) cn.set(String(c.ID), [c.NAME, c.LAST_NAME].filter(Boolean).join(' ') || `#${c.ID}`); }
    const contato = id => cn.get(id) || `#${id}`;
    return { colunas: cols.map(({ k, label }) => ({ k, label })), valores: r => Object.fromEntries(cols.map(c => [c.k, fmtCampo(c.def, r.raw[c.k], nm, c.k === 'contactIds' ? { contato } : c.k === 'createdBy' ? { usuario: true } : {})])) };
  }
  async function registroDoCard(id, user) {
    const { m } = await carregar(id, user);
    const r = await bx.call('crm.item.list', { entityTypeId: ETYPE.visita, select: camposSel(m), filter: { [m.visita.idFila]: String(id) }, order: { id: 'DESC' } });
    const it = (r.result?.items || [])[0];
    if (!it) throw fail(404, 'Este card ainda não tem registro de visita.');
    const reg = paraRegistro(m, it), vr = await valoresRegistros(m, [reg]), val = vr.valores(reg);
    const extras = Object.fromEntries(extrasDef(m).map(d => {
      const x = val0(reg.raw[d.key]); let t = '';
      if (x !== undefined && x !== null && x !== '') t = d.type === 'enumeration' ? (itensDe(m.visitaFields, d.key).find(i => String(i.ID) === String(x))?.VALUE || '') : d.type === 'boolean' ? (/^(y|1|true)$/i.test(String(x)) ? 'Y' : 'N') : d.type === 'datetime' ? String(x).slice(0, 16) : d.type === 'date' ? String(x).slice(0, 10) : String(x);
      return [d.key, t];
    }));
    return { ...reg, raw: undefined, extras, campos: vr.colunas.map(c => ({ label: c.label, valor: val[c.k] })).filter(c => c.valor) };
  }
  async function editarRegistro(vid, b, user) {
    const m = await modelo();
    const r = await bx.call('crm.item.get', { entityTypeId: ETYPE.visita, id: vid });
    const it = r.result?.item || r.result;
    if (!it) throw fail(404, 'Registro não encontrado.');
    const reg = paraRegistro(m, it), esc = await escopo(user);
    const card = reg.idFila ? await umCard(m, reg.idFila).catch(() => null) : null;
    const pode = esc === null || (card ? esc.has(String(card.vendedorId)) : false) || reg.criadoPor === String(user.id);
    if (!pode) throw fail(403, 'Você não pode editar este registro.');
    if (!txt(b.fatos).trim()) throw fail(400, 'Preencha "Fatos e dados".');
    const f = camposVisita(m, b);
    if (A(b.contatos).length) f.contactIds = A(b.contatos).slice(0, 50).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (b.dataHora && /^\d{4}-\d{2}-\d{2}/.test(b.dataHora)) f[m.visita.data] = b.dataHora;
    await bx.call('crm.item.update', { entityTypeId: ETYPE.visita, id: vid, fields: f });
    store.log('edicao', `Registro #${vid} editado por ${user.nome || user.id}`);
    invalidar('regs', 'dash'); return { ok: true };
  }
  async function contatos(empresaId) {
    const r = await bx.listAll('crm.contact.list', { filter: { COMPANY_ID: empresaId }, select: ['ID', 'NAME', 'LAST_NAME', 'POST', 'PHONE'] });
    return r.map(c => ({ id: +c.ID, nome: [c.NAME, c.LAST_NAME].filter(Boolean).join(' ') || `#${c.ID}`, cargo: c.POST || '', telefone: (c.PHONE || [])[0]?.VALUE || '' }));
  }
  async function formCard(id, user) {
    const { m, card } = await carregar(id, user);
    const v = m.visita, opt = k => itensDe(m.visitaFields, v[k]).map(i => i.VALUE);
    return { card, hoje: hoje(), contatos: await contatos(card.empresaId), supervisores: await supervisores(), trocas: store.trocas(id),
      opcoes: { regime: opt('regime'), oportunidades: opt('oportunidades'), antecipada: opt('antecipada'), acompanhamento: opt('acompanhamento'), alcada: opt('alcada') }, motivos: cfg().motivosNaoRealizada,
      campos: { populacao: !!v.populacao, anexos: !!v.anexos, supervisor: !!v.supervisor, regime: !!v.regime, alcada: !!v.alcada }, extras: extrasDef(m) };
  }

  // ---------- listas e dashboard ----------
  async function visiveis(user, cards) {
    const esc = await escopo(user);
    return esc ? cards.filter(c => esc.has(String(c.vendedorId))) : cards;
  }
  async function listar(user, q = {}) {
    const m = await modelo(), h = hoje();
    let cards = await visiveis(user, await cardsC(m));
    const de = q.de || '', ate = q.ate || '';   // sem período = tudo o que está no SPA (exceto removidos)
    const excl = q.excluidos === '1';
    cards = cards.filter(c => (excl ? c.etapa === 'FAIL' : c.etapa !== 'FAIL'));
    if (!excl && !q.etapa && q.finalizados !== '1') cards = cards.filter(c => c.etapa !== 'SUCCESS');   // Finalizado só aparece a pedido
    const cu = await comUltima(m, cards); cards = cu.cards; await carregaUltimas(m, cards.map(c => c.empresaId));
    // Opções dos filtros: todos os segmentos e vendedores do escopo do usuário (não encolhem quando um filtro é aplicado).
    const nmOp = await nomes(cards.map(c => c.vendedorId));
    const opcoes = { segmentos: [...new Set(cards.map(c => c.segmento).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      vendedores: [...new Map(cards.map(c => [c.vendedorId || 'sem', c.vendedorId ? nmOp(c.vendedorId) : 'Sem vendedor']))].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome)) };
    if (de || ate) cards = cards.filter(c => c.etapa === 'NAOREAL' || !c.data || ((!de || c.data >= de) && (!ate || c.data <= ate)) || (ABERTAS.includes(c.etapa) && c.data < de && !q.de));
    if (q.segmento) cards = cards.filter(c => R.norm(c.segmento) === R.norm(q.segmento));
    if (q.vendedor) cards = cards.filter(c => c.vendedorId === (q.vendedor === 'sem' ? '' : String(q.vendedor)));
    if (q.classe) cards = cards.filter(c => c.classe === q.classe);
    if (q.etapa) cards = cards.filter(c => c.etapa === q.etapa);
    if (q.supervisor) { const s = await escopoDe(q.supervisor); cards = cards.filter(c => s.has(c.vendedorId)); }
    if (q.q) { const t = await tituloEmpresas(cards.map(c => c.empresaId)), b = R.norm(q.q); cards = cards.filter(c => R.norm(`${t(c.empresaId)} ${c.segmento}`).includes(b)); }
    cards.sort((x, y) => (x.data || '9999').localeCompare(y.data || '9999') || x.id - y.id);
    const porEtapa = {}; for (const c of cards) porEtapa[c.etapa] = (porEtapa[c.etapa] || 0) + 1;
    const todos = q.all === '1', agrupar = q.agrupar === '1';
    let unidades = cards.map(c => [c]);                                    // unidade de paginação: o card ou, agrupando, o cliente com todos os seus segmentos
    if (agrupar || todos) { const g = new Map(); for (const c of cards) (g.get(c.empresaId) || g.set(c.empresaId, []).get(c.empresaId)).push(c); unidades = [...g.values()]; unidades.forEach(u => u.sort((x, y) => x.segmento.localeCompare(y.segmento) || x.id - y.id)); }
    const size = Math.min(todos ? 5000 : 200, Math.max(10, +q.pageSize || 50)), pages = todos ? 1 : Math.max(1, Math.ceil(unidades.length / size)), page = todos ? 1 : Math.min(pages, Math.max(1, +q.page || 1));
    const fatia = (todos ? unidades : unidades.slice((page - 1) * size, page * size)).flat();   // só a página corrente busca nomes no Bitrix
    const tit = await tituloEmpresas(fatia.map(c => c.empresaId)), nm = await nomes(fatia.map(c => c.vendedorId));
    return { hoje: h, de, ate, opcoes, etapasReais: { LATE: !!m.etapaReal?.LATE, NAOREAL: !!m.etapas.NAOREAL }, ocultos: cu.ocultos, agendados: cu.agendados, exigirUltima: cfg().exigirUltimaVisita, total: cards.length, totalGrupos: unidades.length, page, pageSize: size, pages, porEtapa, itens: fatia.map(c => ({ ...c, empresa: tit(c.empresaId), vendedor: c.vendedorId ? nm(c.vendedorId) : 'Sem vendedor', podeExcluir: podeExcluir(user), ultimaVisita: ultDados.get(chaveUlt(c))?.ultima || '', reprogramado: !!store.snap(c.id), atrasoDias: c.data && ABERTAS.includes(c.etapa) ? Math.max(0, R.dayDiff(c.data, h)) : 0 })) };
  }
  const escopoDe = equipeDe;
  async function registrosC(m) { return cached('regs', 60000, async () => (await bx.listAll('crm.item.list', { entityTypeId: ETYPE.visita, select: camposSel(m), order: { id: 'DESC' } })).map(i => paraRegistro(m, i)), 600000); }
  // Cards no escopo do usuário + filtros do painel (período na data programada). `sem` ignora um filtro (para as opções dos seletores).
  async function filtrados(user, q = {}, sem = []) {
    const m = await modelo();
    let cards = (await comUltima(m, (await visiveis(user, await cardsC(m))).filter(c => c.etapa !== 'FAIL'))).cards;
    if (!sem.includes('de') && q.de) cards = cards.filter(c => c.data && c.data >= q.de);
    if (!sem.includes('ate') && q.ate) cards = cards.filter(c => c.data && c.data <= q.ate);
    if (!sem.includes('segmento') && q.segmento) cards = cards.filter(c => R.norm(c.segmento) === R.norm(q.segmento));
    if (!sem.includes('vendedor') && q.vendedor) cards = cards.filter(c => c.vendedorId === (q.vendedor === 'sem' ? '' : String(q.vendedor)));
    if (!sem.includes('classe') && q.classe) cards = cards.filter(c => c.classe === q.classe);
    if (!sem.includes('etapa') && q.etapa) cards = cards.filter(c => c.etapa === q.etapa);
    if (!sem.includes('motivo') && q.motivo) cards = cards.filter(c => c.motivo === q.motivo);
    if (!sem.includes('supervisor') && q.supervisor) { const e = await escopoDe(q.supervisor); cards = cards.filter(c => e.has(c.vendedorId)); }
    return { m, cards };
  }
  // ================= PAINEL (dashboard) =================
  // Fila = situação ATUAL dos cards abertos; Registros = visitas preenchidas, pelo período (data da visita). Ambos respeitam a visibilidade do usuário.
  const CARGOS_ORDEM = ['Vendedor', 'Supervisor', 'Coordenador', 'Gerente', 'Diretor'];
  const cargoCanon = c => CARGOS_ORDEM.find(x => R.norm(x) === R.norm(c)) || (txt(c).trim() || 'Sem cargo');
  async function baseDados(user, q = {}) {
    const m = await modelo(), h = hoje(), esc = await escopo(user);
    const vis = await visiveis(user, await cardsC(m)), porId = new Map(vis.map(c => [String(c.id), c]));
    const respF = q.vendedor === 'sem' ? '' : String(q.vendedor || '');
    const passa = c => (!q.segmento || R.norm(c.segmento) === R.norm(q.segmento)) && (!q.cargo || R.norm(c.cargo) === R.norm(q.cargo)) && (!q.vendedor || c.vendedorId === respF) && (!q.classe || c.classe === q.classe);
    const naRegra = await comUltima(m, vis.filter(c => c.etapa !== 'FAIL'));
    const cards = naRegra.cards.filter(passa);
    const regsEsc = (await registrosC(m)).filter(r => esc === null || porId.has(r.idFila) || (r.responsavelId && esc.has(String(r.responsavelId))));
    const regs = regsEsc.map(r => { const c = porId.get(r.idFila); return { ...r, card: c || null, data: dia(r.dataHora), feito: r.fatos.trim().length > 0, cargo: c ? c.cargo : r.alcada, respId: c ? c.vendedorId : txt(r.responsavelId), seg: c ? c.segmento : r.segmento }; })
      .filter(r => r.card ? passa(r.card) : (!q.classe && (!q.segmento || R.norm(r.seg) === R.norm(q.segmento)) && (!q.cargo || R.norm(r.cargo) === R.norm(q.cargo)) && (!q.vendedor || r.respId === respF)));
    return { m, h, esc, cards, todosCards: naRegra.cards, ocultos: naRegra.ocultos, regs, de: q.de || '', ate: q.ate || '' };
  }
  async function dashboard(user, q = {}) {
    const { h, cards, todosCards, ocultos, regs, de, ate } = await baseDados(user, q);
    const abertas = cards.filter(c => ABERTAS.includes(c.etapa)), comData = abertas.filter(c => c.data);
    const atras = comData.filter(c => c.data < h), hojeL = comData.filter(c => c.data === h);
    const em7 = comData.filter(c => c.data > h && c.data <= R.addDays(h, 7)), em30 = comData.filter(c => c.data > h && c.data <= R.addDays(h, 30));
    const dist = l => new Set(l.map(c => c.empresaId)).size, dentro = d => d && (!de || d >= de) && (!ate || d <= ate);
    const faixas = [['1 a 7 dias', 1, 7], ['8 a 30 dias', 8, 30], ['31 a 90 dias', 31, 90], ['91 a 180 dias', 91, 180], ['Mais de 180 dias', 181, 1e9]].map(([nome, a, b]) => ({ nome, n: atras.filter(c => { const d = R.dayDiff(c.data, h); return d >= a && d <= b; }).length }));
    const agenda = Array.from({ length: 30 }, (_, i) => { const d = R.addDays(h, i); return { dia: d, n: comData.filter(c => c.data === d).length, util: R.isBusinessDay(d) }; });
    const mesFila = {}; for (const c of comData) { const o = (mesFila[c.data.slice(0, 7)] ||= { mes: c.data.slice(0, 7), atrasadas: 0, noPrazo: 0 }); c.data < h ? o.atrasadas++ : o.noPrazo++; }
    // registros
    const feitos = regs.filter(r => r.feito), noPeriodo = feitos.filter(r => dentro(r.data)), comVisita = new Set(feitos.map(r => String(r.idFila)));
    const ult30 = feitos.filter(r => r.data && r.data > R.addDays(h, -30) && r.data <= h).length, ant30 = feitos.filter(r => r.data && r.data > R.addDays(h, -60) && r.data <= R.addDays(h, -30)).length;
    const aguardando = regs.filter(r => !r.feito && r.card && ABERTAS.includes(r.card.etapa)).length;
    const venc = cards.filter(c => c.data && c.data <= h && dentro(c.data)), feitoCard = c => c.etapa === 'ENC' || c.etapa === 'SUCCESS' || comVisita.has(String(c.id));
    const cumpridas = venc.filter(feitoCard).length, pendentes = venc.filter(c => ABERTAS.includes(c.etapa) && !feitoCard(c)).length;
    const contar = (l, f) => { const o = {}; for (const x of l) { let k = f(x) || 'Não informado'; if (k === 'Sem cargo') k = 'Não informado'; o[k] = (o[k] || 0) + 1; } return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([nome, n]) => ({ nome, n })); };
    const porMes = {}; for (const r of noPeriodo) porMes[r.data.slice(0, 7)] = (porMes[r.data.slice(0, 7)] || 0) + 1;
    // cargos e responsáveis
    const nm0 = await nomes([...new Set([...abertas.map(c => c.vendedorId), ...noPeriodo.map(r => r.respId), ...todosCards.map(c => c.vendedorId)].filter(Boolean))]), nm = id => (id ? nm0(id) : 'Sem responsável');
    const linhaDe = (lista, regsL) => { const at = lista.filter(c => c.data && c.data < h); return { abertas: lista.length, hoje: lista.filter(c => c.data === h).length, em7: lista.filter(c => c.data && c.data > h && c.data <= R.addDays(h, 7)).length, atrasadas: at.length, registros: regsL.length, emDia: lista.length ? Math.round((lista.length - at.length) * 100 / lista.length) : null }; };
    const nomesCargo = [...new Set([...CARGOS_ORDEM, ...abertas.map(c => cargoCanon(c.cargo)), ...noPeriodo.map(r => cargoCanon(r.cargo))])];
    const porCargo = nomesCargo.map(cg => { const l = abertas.filter(c => cargoCanon(c.cargo) === cg); return { nome: cg, pessoas: new Set(l.map(c => c.vendedorId).filter(Boolean)).size, ...linhaDe(l, noPeriodo.filter(r => cargoCanon(r.cargo) === cg)) }; });
    const ids = [...new Set([...abertas.map(c => c.vendedorId || 'sem'), ...noPeriodo.map(r => r.respId || 'sem')])];
    const porResponsavel = ids.map(id => { const l = abertas.filter(c => (c.vendedorId || 'sem') === id), rr = noPeriodo.filter(r => (r.respId || 'sem') === id); return { id, nome: nm(id === 'sem' ? '' : id), cargos: [...new Set([...l.map(c => cargoCanon(c.cargo)), ...rr.map(r => cargoCanon(r.cargo))])].filter(c => c !== 'Sem cargo').sort((a, b) => nomesCargo.indexOf(a) - nomesCargo.indexOf(b)), ...linhaDe(l, rr) }; })
      .sort((a, b) => b.atrasadas - a.atrasadas || b.abertas - a.abertas || b.registros - a.registros).slice(0, 150);
    const porClasse = ['A', 'B', 'C', 'E'].map(k => { const l = abertas.filter(c => c.classe === k); return { nome: k, abertas: l.length, atrasadas: l.filter(c => c.data && c.data < h).length }; });
    const segs = [...new Set(abertas.map(c => c.segmento).filter(Boolean))].sort();
    const porSegmento = segs.map(sg => { const l = abertas.filter(c => c.segmento === sg); return { nome: sg, abertas: l.length, atrasadas: l.filter(c => c.data && c.data < h).length }; }).sort((a, b) => b.abertas - a.abertas);
    return {
      hoje: h, geradoEm: new Date().toISOString(), ocultosPelaRegra: ocultos,
      kpis: { programadas: cards.length,
        fila: { abertas: abertas.length, hoje: hojeL.length, atrasadas: atras.length, clientesAtrasados: dist(atras), em7: em7.length, em30: em30.length, semData: abertas.length - comData.length, clientes: dist(abertas) },
        reg: { registradas: noPeriodo.length, ult30, ant30, delta: ant30 ? Math.round((ult30 - ant30) * 100 / ant30) : null, aguardando, clientes: dist(noPeriodo), cumprimento: cumpridas + pendentes ? Math.round(cumpridas * 100 / (cumpridas + pendentes)) : null, cumpridas, pendentes } },
      faixas, agenda, filaPorMes: Object.values(mesFila).sort((a, b) => a.mes.localeCompare(b.mes)).slice(-24),
      porCargo, porResponsavel, porSegmento, porClasse,
      regPorMes: Object.entries(porMes).sort().slice(-24).map(([mes, n]) => ({ mes, n })), regPorSegmento: contar(noPeriodo, r => r.seg), regPorCargo: contar(noPeriodo, r => cargoCanon(r.cargo)), regPorResp: contar(noPeriodo, r => nm(r.respId)).slice(0, 10),
      opcoes: { segmentos: [...new Set(todosCards.map(c => c.segmento).filter(Boolean))].sort(), cargos: CARGOS_ORDEM, classes: ['A', 'B', 'C', 'E'],
        vendedores: [...new Map(todosCards.map(c => [c.vendedorId || 'sem', c.vendedorId ? nm(c.vendedorId) : 'Sem responsável']))].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome)) },
    };
  }
  // Diagnóstico (somente leitura) de como as datas de visita estão no cadastro das empresas.
  async function diagnosticoDatas(passo = () => {}) {
    passo('Lendo o mapeamento de campos…');
    const m = await modelo(true), h = hoje();
    passo('Lendo empresas e cards do Bitrix24 (pode levar alguns minutos em bases grandes)…');
    const [emps, cards] = await Promise.all([empresasSync(m), cardsTodos(m)]);
    passo(`Analisando ${emps.length} empresas…`);
    const porChave = new Map(); for (const c of cards) { const k = `${c.empresaId}|${R.norm(c.segmento)}`; (porChave.get(k) || porChave.set(k, []).get(k)).push(c); }
    const nome = id => m.empresa.rotulos?.[id] || id, ex = (l, t) => { if (l.length < 6) l.push(t); };
    const segmentos = Object.entries(m.empresa.segmentos).map(([k, s]) => {
      const st = { nome: s.nome, campos: { vendedor: (s.cargos.Vendedor || []).map(nome), classe: s.classe.map(nome), ultima: s.ultima.map(nome), proxima: s.proxima.map(nome) },
        comVendedor: 0, comClasse: 0, comUltima: 0, comProxima: 0, aptas: 0, semUltima: 0, ultimaFutura: 0, proximaAntesDaUltima: 0, proximaIgualEsperada: 0, proximaDiferente: 0,
        cardsAbertos: 0, cardsAbertosSemUltima: 0, cardsDataDiferenteDoCadastro: 0, exemplos: { semUltima: [], inconsistentes: [] } };
      const delta = {};
      for (const comp of emps) {
        const { vendedor, classe, proxima, ultima } = leituraEmpresa(m, comp, k, 'Vendedor');
        if (vendedor) st.comVendedor++; if (classe) st.comClasse++; if (ultima) st.comUltima++; if (proxima) st.comProxima++;
        const apta = vendedor && classe;
        if (apta && ultima) st.aptas++;
        if (apta && !ultima) { st.semUltima++; ex(st.exemplos.semUltima, comp.TITLE); }
        if (ultima && ultima > h) st.ultimaFutura++;
        if (ultima && proxima) {
          if (proxima < ultima) { st.proximaAntesDaUltima++; ex(st.exemplos.inconsistentes, `${comp.TITLE} (última ${ultima}, próxima ${proxima})`); }
          else { const d = R.dayDiff(ultima, proxima); (delta[classe || '—'] ||= {})[d] = (delta[classe || '—'][d] || 0) + 1; }
          if (classe && proxima === R.proximaVisita(classe, ultima, cfg())) st.proximaIgualEsperada++; else st.proximaDiferente++;
        }
        for (const c of (porChave.get(`${comp.ID}|${k}`) || []).filter(x => ABERTAS.includes(x.etapa))) {
          st.cardsAbertos++; if (!ultima) st.cardsAbertosSemUltima++; if (proxima && c.data && c.data !== proxima) st.cardsDataDiferenteDoCadastro++;
        }
      }
      st.intervalosObservados = Object.fromEntries(Object.entries(delta).map(([cl, o]) => [cl, Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([dias, n]) => ({ dias: +dias, empresas: n }))]));
      return st;
    });
    return { hoje: h, exigirUltimaVisita: cfg().exigirUltimaVisita, empresas: emps.length, intervalosDoApp: cfg().intervalos, segmentos };
  }
  // ---- Desfazer remoções feitas pelo próprio app (cards movidos para Removido pelo usuário do webhook) ----
  // Identifica pelo Bitrix: etapa Removido + "movido por" = usuário do webhook + data. Exclui o que foi apagado de propósito pelo botão Excluir do app.
  // Sem confirmar: só mostra a prévia. Confirmando: devolve cada card à etapa em que estava (previousStageId).
  async function restaurarRemovidos({ confirmar = false, desde } = {}, passo = () => {}) {
    const m = await modelo(true), f = m.fila;
    passo('Identificando o usuário do webhook…');
    const meu = String((await bx.call('profile')).result?.ID || '');
    if (!meu) throw fail(502, 'Não consegui identificar o usuário do webhook.');
    const limite = /^\d{4}-\d{2}-\d{2}$/.test(desde || '') ? desde : R.addDays(hoje(), -1);
    passo('Lendo os cards em Removido…');
    const cards = await bx.listAll('crm.item.list', { entityTypeId: ETYPE.fila, select: ['id', 'title', 'companyId', 'stageId', 'previousStageId', 'movedBy', 'movedTime', f.segmento, f.cargo, f.data].filter(Boolean), filter: { categoryId: m.categoryId, stageId: m.etapas.FAIL }, order: { id: 'ASC' } });
    const apagadosDeProposito = new Set(store.logs.filter(l => (l.type === 'exclusao' || l.type === 'auditoria') && l.card).map(l => String(l.card)));
    const alvo = cards.filter(c => String(c.movedBy) === meu && dia(c.movedTime) >= limite && !apagadosDeProposito.has(String(c.id)) && !store.removidoDeProposito(c.id));
    const destino = c => ([m.etapas.NEW, m.etapas.PREPARATION].includes(c.previousStageId) ? c.previousStageId : m.etapas.NEW);
    const nomeEtapa = id => (id === m.etapas.PREPARATION ? 'Dia da Visita' : 'Aguardando');
    const porEtapa = {}; for (const c of alvo) { const n = nomeEtapa(destino(c)); porEtapa[n] = (porEtapa[n] || 0) + 1; }
    const exemplos = alvo.slice(0, 8).map(c => `${c.title} · ${txt(c[f.segmento])} · ${txt(c[f.cargo])} (card ${c.id})`);
    if (!confirmar) return { confirmado: false, desde: limite, totalRemovidos: cards.length, aRestaurar: alvo.length, voltamPara: porEtapa, exemplos };
    let ok = 0, erros = 0;
    for (const c of alvo) {
      passo(`Restaurando ${ok + erros + 1} de ${alvo.length}…`);
      try { await atualizarCard(c.id, { stageId: destino(c) }); ok++; store.log('restaura', `Card ${c.id} (${c.title}) restaurado de Removido para ${nomeEtapa(destino(c))}`, { card: c.id }); }
      catch (e) { erros++; store.log('erro', `restaurar ${c.id}: ${e.message}`.slice(0, 300)); }
    }
    invalidar('cards', 'dash');
    return { confirmado: true, desde: limite, restaurados: ok, erros, voltamPara: porEtapa };
  }
  // ---- Reconciliação e auditoria do processo (card da fila x registro de visita x cadastro da empresa) ----
  // Registros do SPA 1032 ligados (campo "ID Fila") a estes cards, em lotes de 50.
  async function registrosPorCards(m, ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      out.push(...await bx.listAll('crm.item.list', { entityTypeId: ETYPE.visita, select: ['id', 'companyId', 'createdTime', m.visita.idFila, m.visita.data, m.visita.fatos].filter(Boolean), filter: { [m.visita.idFila]: ids.slice(i, i + 50).map(String) }, order: { id: 'ASC' } }));
    }
    return out.map(r => ({ id: +r.id, empresaId: +r.companyId, idFila: txt(r[m.visita.idFila]), data: dia(r[m.visita.data]) || dia(r.createdTime), preenchido: txt(r[m.visita.fatos]).trim().length > 0 }));
  }
  // Se existe registro de visita para um card ainda aberto (criado direto no Bitrix, ou uma tentativa que parou no meio),
  // move o card para Encerrado, atualiza a Última visita da empresa e gera a próxima visita. Idempotente.
  async function reconciliar() {
    const m = await modelo();
    if (!m.visita.idFila) return { ok: false, motivo: 'Campo "ID Fila" do registro não encontrado.' };
    const abertos = (await comUltima(m, (await cardsTodos(m)).filter(c => ABERTAS.includes(c.etapa) && c.vendedorId))).cards;   // sem "Pessoa responsável" o Bitrix não permite alterar o card
    if (!abertos.length) return { ok: true, verificados: 0, movidos: 0, erros: 0 };
    const regs = await registrosPorCards(m, abertos.map(c => c.id)), porCard = new Map();
    // O processo costuma criar o registro VAZIO quando a data da visita chega: só conta como visita feita o registro com "Fatos e dados" preenchido.
    for (const r of regs) if (r.preenchido) (porCard.get(r.idFila) || porCard.set(r.idFila, []).get(r.idFila)).push(r);
    let movidos = 0, erros = 0;
    for (const c of abertos) {
      const l = porCard.get(String(c.id)); if (!l) continue;
      await comTrava(`c:${c.empresaId}`, async () => {
        try {
          if (!ABERTAS.includes((await umCard(m, c.id)).etapa)) return;           // outro processo já tratou
          const data = l.map(r => r.data).filter(Boolean).sort().pop() || hoje(), cadastro = ultDados.get(chaveUlt(c))?.ultima || '';
          await mover(m, c.id, 'ENC');
          await atualizarEmpresa(m, c.empresaId, c.segmento, { ultima: !cadastro || data > cadastro ? data : undefined });
          await gerarProximo(m, { ...c, etapa: 'ENC' }, data);
          movidos++; store.log('reconcilia', `Card ${c.id} (${c.titulo}) finalizado: o registro de visita #${l[0].id} já estava preenchido`, { card: c.id });
        } catch (e) { erros++; store.log('erro', `reconciliar ${c.id}: ${e.message}`.slice(0, 300), { card: c.id }); }
      });
    }
    invalidar('cards', 'dash', 'regs');
    return { ok: true, verificados: abertos.length, movidos, erros };
  }
  // Auditoria (somente leitura): confere se o ciclo está íntegro. Devolve cada verificação com contagem e exemplos.
  async function calcAuditoria(passo = () => {}) {
    passo('Lendo o mapeamento de campos…');
    const m = await modelo(true), h = hoje(), exigir = cfg().exigirUltimaVisita;
    passo('Lendo cards, registros de visita e empresas (pode levar alguns minutos)…');
    const [cards, regsRaw, emps] = await Promise.all([cardsTodos(m), bx.listAll('crm.item.list', { entityTypeId: ETYPE.visita, select: ['id', 'companyId', 'createdTime', m.visita.idFila, m.visita.data, m.visita.fatos].filter(Boolean), order: { id: 'ASC' } }), empresasSync(m)]);
    passo(`Analisando ${cards.length} cards, ${regsRaw.length} registros e ${emps.length} empresas…`);
    const regs = regsRaw.map(r => ({ id: +r.id, empresaId: +r.companyId, idFila: txt(r[m.visita.idFila]), data: dia(r[m.visita.data]) || dia(r.createdTime), preenchido: txt(r[m.visita.fatos]).trim().length > 0 }));
    const nomeEmp = new Map(emps.map(e => [String(e.ID), e.TITLE])), emp = id => nomeEmp.get(String(id)) || `Empresa #${id}`;
    const cardPorId = new Map(cards.map(c => [String(c.id), c])), regsPorCard = new Map(), abertos = cards.filter(c => ABERTAS.includes(c.etapa));
    for (const r of regs) if (r.idFila) (regsPorCard.get(r.idFila) || regsPorCard.set(r.idFila, []).get(r.idFila)).push(r);
    const fmt = (c, x = '') => `${emp(c.empresaId)} · ${c.segmento} (card ${c.id}${x ? ', ' + x : ''})`;
    const porChave = new Map(); for (const c of cards) if (c.etapa !== 'FAIL') (porChave.get(R.chaveCard(c.empresaId, c.segmento, c.cargo)) || porChave.set(R.chaveCard(c.empresaId, c.segmento, c.cargo), []).get(R.chaveCard(c.empresaId, c.segmento, c.cargo))).push(c);
    const semResp = abertos.filter(c => !c.vendedorId), comResp = abertos.filter(c => c.vendedorId);
    const feito = id => (regsPorCard.get(String(id)) || []).some(r => r.preenchido);        // visita feita = registro com "Fatos e dados" preenchido (registro vazio é só o modelo criado na data)
    const raw = { feitos: new Set(comResp.filter(c => feito(c.id)).map(c => c.id)), registroCardAberto: comResp.filter(c => feito(c.id)), duplicados: [], semProximo: [] };
    const lista = { semCard: [], ultimaDesatualizada: [], proximaDiferente: [], virariamNaoRealizada: [], responsavelDiferente: [] };
    for (const [k, l] of porChave) { const ab = l.filter(c => ABERTAS.includes(c.etapa) && c.vendedorId); if (ab.length > 1) raw.duplicados.push(ab.sort((x, y) => x.id - y.id)); }
    for (const comp of emps) for (const [segKey, seg] of Object.entries(m.empresa.segmentos)) for (const cargo of cfg().cargosFila) {
      if (!seg.cargos[cargo]) continue;
      const l = leituraEmpresa(m, comp, segKey, cargo); if (!l.vendedor || !l.classe || (exigir && !l.ultima)) continue;      // fora da fila por regra
      const k = R.chaveCard(comp.ID, seg.nome, cargo), cs = (porChave.get(k) || []).sort((x, y) => x.id - y.id), ab = cs.filter(c => ABERTAS.includes(c.etapa));
      if (!cs.length) lista.semCard.push(`${comp.TITLE} · ${seg.nome}`);
      else if (!ab.length) { const ult = cs[cs.length - 1]; if (['ENC', 'SUCCESS', 'NAOREAL'].includes(ult.etapa)) raw.semProximo.push(ult); }
      for (const c of ab) if (c.vendedorId && l.vendedor && c.vendedorId !== String(l.vendedor)) lista.responsavelDiferente.push(fmt(c, `${cargo}: card ${c.vendedorId} × cadastro ${l.vendedor}`));
      for (const c of ab) if (c.data && l.proxima && c.data !== l.proxima) lista.proximaDiferente.push(`${fmt(c, `card ${dtBRs(c.data)} × cadastro ${dtBRs(l.proxima)}`)}`);
      const datas = cs.flatMap(c => (regsPorCard.get(String(c.id)) || []).filter(r => r.preenchido).map(r => r.data)).filter(Boolean).sort(), ultReg = datas[datas.length - 1];
      if (ultReg && (!l.ultima || ultReg > l.ultima)) lista.ultimaDesatualizada.push(`${comp.TITLE} · ${seg.nome} (registro ${dtBRs(ultReg)} × cadastro ${l.ultima ? dtBRs(l.ultima) : 'vazio'})`);
    }
    for (const c of abertos) if (c.data && R.etapaPorData(c.data, h) === 'NAOREAL') lista.virariamNaoRealizada.push(c);
    const hidden = exigir ? (await comUltima(m, lista.virariamNaoRealizada)) : { cards: lista.virariamNaoRealizada };
    const checks = [], add = (id, titulo, sev, itens, desc, corrigivel = false) => checks.push({ id, titulo, severidade: itens.length ? sev : 'ok', contagem: itens.length, descricao: desc, exemplos: itens.slice(0, 8).map(x => (typeof x === 'string' ? x : fmt(x))), corrigivel: corrigivel && itens.length > 0 });
    add('registro_card_aberto', 'Visita preenchida, mas o card continua aberto', 'erro', raw.registroCardAberto, 'Existe registro de visita PREENCHIDO (com "Fatos e dados") ligado ao card, mas o card não foi finalizado (preenchido direto no Bitrix ou tentativa que parou no meio). Registro vazio não conta: é só o modelo criado na data da visita. A correção finaliza o card, atualiza a Última visita da empresa e gera a próxima visita.', true);
    add('encerrado_sem_registro', 'Card finalizado sem registro de visita preenchido', 'aviso', cards.filter(c => (c.etapa === 'ENC' || c.etapa === 'SUCCESS') && !feito(c.id)), 'Cards finalizados fora do app (ou pela automação antiga) que não têm registro preenchido no SPA de registros. Não dá para criar o registro automaticamente: faltam os dados da visita.');
    add('registro_duplicado', 'Mais de um registro para o mesmo card', 'aviso', [...regsPorCard].filter(([, l]) => l.length > 1).map(([id, l]) => `${cardPorId.get(id) ? fmt(cardPorId.get(id)) : 'card ' + id}: registros ${l.map(r => '#' + r.id).join(', ')}`), 'Pode ser visita lançada em duplicidade. Confira no Bitrix e apague a repetida.');
    add('registro_orfao', 'Registro sem card correspondente na fila', 'aviso', regs.filter(r => !r.idFila || !cardPorId.has(r.idFila)).map(r => `registro #${r.id} · ${emp(r.empresaId)}${r.idFila ? ` (ID Fila ${r.idFila} não existe)` : ' (sem ID Fila)'}`), 'Registros criados à mão ou ligados a card que não existe mais. Não afetam a fila.');
    add('sem_responsavel', 'Cards-modelo sem "Pessoa responsável" (não editáveis no Bitrix)', 'aviso', semResp, 'Cards abertos de cargos que não têm pessoa no cadastro da empresa. O Bitrix recusa qualquer alteração nesses cards enquanto o campo "Pessoa responsável" estiver vazio, então o app não consegue mover, finalizar nem remover. Atribua uma pessoa ou exclua-os direto no Bitrix. O app os ignora e eles não aparecem para os vendedores.');
    add('abertos_duplicados', 'Mais de um card aberto para o mesmo cliente, segmento e cargo', 'erro', raw.duplicados.map(l => l[0]), 'Deveria haver só um card aberto por cliente, segmento e cargo. A correção mantém o mais recente (maior data) e move os outros para Removido, sem tocar nos que têm visita preenchida (dá para restaurar).', true);
    add('sem_proximo', 'Ciclo quebrado: último card encerrado e nenhum card aberto', 'erro', raw.semProximo, 'Cliente apto (vendedor, classe e Última visita) cuja visita foi encerrada ou não realizada e que ficou sem a próxima visita. A correção gera o próximo card.', true);
    add('sem_card', 'Clientes aptos sem nenhum card', 'aviso', lista.semCard, 'Têm vendedor, classe e (se a regra estiver ligada) Última visita, mas nenhum card. A sincronização (fila ligada) cria esses cards.');
    add('ultima_desatualizada', 'Última visita do cadastro mais antiga que o último registro', 'aviso', lista.ultimaDesatualizada, 'O cadastro da empresa não reflete a última visita registrada. Edite a empresa ou registre pelo app, que grava a data.');
    add('responsavel_diferente', 'Responsável do card diferente da pessoa do cargo no cadastro da empresa', 'aviso', lista.responsavelDiferente, 'O card está com um responsável e o cadastro da empresa indica outra pessoa para aquele cargo. O app não troca o responsável sozinho; ajuste o card ou o cadastro.');
    add('proxima_diferente', 'Data do card aberta diferente da Próxima visita do cadastro', 'aviso', lista.proximaDiferente, 'O card e o cadastro da empresa mostram datas diferentes. A data do card é a que vale no app; ao reprogramar pelo app as duas ficam iguais.');
    add('viram_nao_realizada', 'Cards abertos de meses passados (virarão Não realizada ao ligar a fila)', 'aviso', hidden.cards, 'Com a fila ligada, a varredura marca estes como Não realizada e cria o próximo card de cada um. Considere regularizar antes.');
    const porEtapa = {}; for (const c of cards) porEtapa[c.etapa] = (porEtapa[c.etapa] || 0) + 1;
    return { raw, resumo: { hoje: h, filaLigada: !!cfg().ativo, regraUltimaVisita: exigir, empresas: emps.length, cards: cards.length, registros: regs.length, cardsPorEtapa: porEtapa }, checks };
  }
  const dtBRs = d => (d ? d.split('-').reverse().join('/') : '—');
  async function auditoria(passo) { const { raw, ...r } = await calcAuditoria(passo); return r; }
  // Correções seguras e reversíveis: nunca apagam nada de vez.
  // Duplicados: dentro do grupo (mesmo cliente+segmento+cargo) fica o card MAIS RECENTE (maior data; sem data só vale se todos estiverem sem data;
  // empate: o de menor ID). Nunca sai um card que tenha visita preenchida (esses são finalizados pela reconciliação).
  function planoDuplicados(grupos, feitos) {
    return grupos.map(g => {
      const ord = [...g].sort((a, b) => (b.data || '').localeCompare(a.data || '') || a.id - b.id), manter = ord[0];
      return { manter, remover: ord.slice(1).filter(c => !feitos.has(c.id)), protegidos: ord.slice(1).filter(c => feitos.has(c.id)) };
    });
  }
  async function corrigirAuditoria(id, passo = () => {}, { simular = false } = {}) {
    if (id === 'registro_card_aberto') { passo('Encerrando os cards que já têm registro…'); return { id, ...(await reconciliar()) }; }
    const { raw } = await calcAuditoria(passo), m = await modelo(); let n = 0, erros = 0;
    if (id === 'abertos_duplicados') {
      passo('Removendo cards abertos duplicados (mantém o mais recente)…');
      const plano = planoDuplicados(raw.duplicados, raw.feitos);
      if (simular) return { id, simulado: true, grupos: plano.length, aRemover: plano.reduce((t, p) => t + p.remover.length, 0), plano: plano.map(p => `manter #${p.manter.id} (${p.manter.data || 'sem data'}) · remover ${p.remover.map(c => '#' + c.id).join(', ') || '—'}${p.protegidos.length ? ' · protegidos ' + p.protegidos.map(c => '#' + c.id).join(', ') : ''}`) };
      for (const p of plano) for (const c of p.remover) { try { await mover(m, c.id, 'FAIL'); store.marcarRemovido(c.id); n++; store.log('auditoria', `Card duplicado ${c.id} (${c.titulo}) movido para Removido; ficou o #${p.manter.id}`, { card: c.id }); } catch (e) { erros++; store.log('erro', `duplicado ${c.id}: ${e.message}`.slice(0, 300)); } }
    } else if (id === 'sem_proximo') {
      passo('Gerando as próximas visitas que faltam…');
      for (const c of raw.semProximo) { try { const base = c.etapa === 'NAOREAL' ? (c.data > hoje() ? c.data : hoje()) : (c.data || hoje()); if (await gerarProximo(m, c, base)) n++; } catch (e) { erros++; store.log('erro', `auditoria sem_proximo ${c.id}: ${e.message}`.slice(0, 300)); } }
    } else throw fail(400, 'Esta verificação não tem correção automática.');
    invalidar('cards', 'dash');
    return { id, ok: true, corrigidos: n, erros };
  }

  // ---- Cadastrar "Última visita" sem abrir a empresa ----
  // Lista os cards abertos ocultos (empresa+segmento sem Última visita no cadastro), agrupados, dentro do escopo do usuário.
  async function semUltima(user, q = {}) {
    const m = await modelo();
    let cards = (await visiveis(user, await cardsC(m))).filter(c => ABERTAS.includes(c.etapa));
    await carregaUltimas(m, cards.map(c => c.empresaId));
    cards = cards.filter(c => !ultDados.get(chaveUlt(c))?.ultima);
    const g = new Map();
    for (const c of cards) { const k = chaveUlt(c); const x = g.get(k) || g.set(k, { empresaId: c.empresaId, segmento: c.segmento, classe: c.classe, vendedorId: c.vendedorId, cards: 0, dataCard: '' }).get(k); x.cards++; if (c.data && (!x.dataCard || c.data < x.dataCard)) x.dataCard = c.data; }
    let lista = [...g.values()];
    const opcoes = { segmentos: [...new Set(lista.map(x => x.segmento).filter(Boolean))].sort(), vendedores: [] };
    const nmAll = await nomes(lista.map(x => x.vendedorId)); opcoes.vendedores = [...new Map(lista.map(x => [x.vendedorId || 'sem', x.vendedorId ? nmAll(x.vendedorId) : 'Sem vendedor']))].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome));
    if (q.segmento) lista = lista.filter(x => R.norm(x.segmento) === R.norm(q.segmento));
    if (q.vendedor) lista = lista.filter(x => x.vendedorId === (q.vendedor === 'sem' ? '' : String(q.vendedor)));
    const tit = await tituloEmpresas(lista.map(x => x.empresaId));
    lista = lista.map(x => ({ ...x, empresa: tit(x.empresaId), vendedor: x.vendedorId ? nmAll(x.vendedorId) : 'Sem vendedor', proximaCadastro: ultDados.get(`${x.empresaId}|${R.norm(x.segmento)}`)?.proxima || '' }));
    if (q.q) { const b = R.norm(q.q); lista = lista.filter(x => R.norm(`${x.empresa} ${x.segmento}`).includes(b)); }
    lista.sort((a, b) => a.empresa.localeCompare(b.empresa) || a.segmento.localeCompare(b.segmento));
    const size = 25, pages = Math.max(1, Math.ceil(lista.length / size)), page = Math.min(pages, Math.max(1, +q.page || 1));
    return { hoje: hoje(), total: lista.length, page, pages, opcoes, itens: lista.slice((page - 1) * size, page * size) };
  }
  // Grava a Última visita direto no cadastro da empresa (e a Próxima, se estiver vazia). Vendedor só altera as próprias; admin altera todas.
  async function salvarUltimas(user, itens) {
    const m = await modelo(), h = hoje(), esc = await escopo(user), lista = A(itens).slice(0, 100);
    if (!lista.length) throw fail(400, 'Nenhuma empresa informada.');
    const ids = [...new Set(lista.map(i => String(i?.empresaId)).filter(x => /^\d{1,12}$/.test(x)))];
    const sel = ['ID', 'TITLE', ...new Set(Object.values(m.empresa.segmentos).flatMap(s => [...(s.cargos.Vendedor || []), ...s.classe, ...s.ultima, ...s.proxima]))], comps = new Map();
    for (let i = 0; i < ids.length; i += 50) for (const c of (await bx.call('crm.company.list', { filter: { ID: ids.slice(i, i + 50) }, select: sel })).result || []) comps.set(String(c.ID), c);
    const existentes = (await cardsC(m)), res = [];
    for (const it of lista) {
      const r = { empresaId: it?.empresaId, segmento: it?.segmento, ok: false };
      try {
        const segKey = R.norm(it?.segmento), seg = m.empresa.segmentos[segKey], comp = comps.get(String(it?.empresaId)), data = String(it?.data || '');
        if (!seg || !seg.ultima[0]) throw fail(400, 'Segmento sem campo "Última visita" no cadastro.');
        if (!comp) throw fail(404, 'Empresa não encontrada.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(data))) throw fail(400, 'Data inválida.');
        if (data > h) throw fail(400, 'A última visita não pode estar no futuro.');
        if (data < '2000-01-01') throw fail(400, 'Data muito antiga.');
        const l = leituraEmpresa(m, comp, segKey, 'Vendedor');
        if (esc && !esc.has(String(l.vendedor))) throw fail(403, 'Esta empresa não é sua nem da sua equipe.');
        const fields = { [seg.ultima[0]]: data };
        const proxima = l.classe ? R.proximaVisita(l.classe, data, cfg()) : '';
        if (!l.proxima && proxima && seg.proxima[0]) fields[seg.proxima[0]] = proxima;
        await bx.call('crm.company.update', { id: comp.ID, fields });
        ultDados.set(`${comp.ID}|${segKey}`, { ultima: data, proxima: fields[seg.proxima[0]] || l.proxima || '' });
        // Fila ativa e ainda sem card nesse segmento: cria já (sem esperar a sincronização horária).
        const tem = existentes.some(c => c.empresaId === +comp.ID && R.norm(c.segmento) === segKey && c.etapa !== 'FAIL');
        if (store.ativo && !tem && l.vendedor && l.classe) {
          let d = fields[seg.proxima[0]] || l.proxima || proxima; if (d && R.etapaPorData(d, h) === 'NAOREAL') d = R.nextBusinessDay(h);
          if (d) await criarCard(m, { empresaId: +comp.ID, empresa: comp.TITLE, segmento: seg.nome, cargo: 'Vendedor', classe: l.classe, vendedorId: l.vendedor, data: d });
        }
        store.log('ultima', `Última visita ${data} gravada em ${comp.TITLE} (${seg.nome}) por ${user.nome || user.id}`);
        r.ok = true;
      } catch (e) { r.erro = e.message; }
      res.push(r);
    }
    invalidar('cards', 'dash', 'regs');
    return { resultados: res, gravados: res.filter(x => x.ok).length };
  }
  // Visitas registradas (registros PREENCHIDOS do SPA 1032), no período e filtros do painel: busca, paginação e permissão de edição.
  async function registros(user, q = {}) {
    const { m, esc, regs, de, ate } = await baseDados(user, q), busca = R.norm(q.q || '');
    const feitos = regs.filter(r => r.feito && r.data && (!de || r.data >= de) && (!ate || r.data <= ate));
    const tit = await tituloEmpresas(feitos.map(r => r.empresaId)), nm = await nomes(feitos.map(r => r.respId).concat(feitos.map(r => r.supervisor)).filter(Boolean));
    let lista = feitos.map(r => ({ _r: r, id: r.id, idFila: r.card ? +r.idFila : null, empresa: tit(r.empresaId), segmento: r.seg, classe: r.card?.classe || '', vendedor: r.respId ? nm(r.respId) : 'Sem responsável', cargo: cargoCanon(r.cargo), dataHora: r.dataHora, supervisor: r.supervisor ? nm(r.supervisor) : '', contatos: r.contatos.length, anexos: r.anexos.length, resumo: r.fatos.replace(/\s+/g, ' ').slice(0, 180), podeEditar: !!r.card && (esc === null || esc.has(String(r.respId)) || r.criadoPor === String(user.id)), _b: R.norm(`${tit(r.empresaId)} ${r.seg} ${r.respId ? nm(r.respId) : ''} ${r.fatos}`) }));
    if (busca) lista = lista.filter(x => x._b.includes(busca));
    lista.sort((a, b) => String(b.dataHora).localeCompare(String(a.dataHora)) || b.id - a.id);
    const size = 15, pages = Math.max(1, Math.ceil(lista.length / size)), page = Math.min(pages, Math.max(1, +q.page || 1));
    const fatia = lista.slice((page - 1) * size, page * size), vr = await valoresRegistros(m, fatia.map(x => x._r));
    return { total: lista.length, page, pages, colunas: vr.colunas, itens: fatia.map(({ _b, _r, ...x }) => ({ ...x, valores: vr.valores(_r) })) };
  }
  async function historico(user, q = {}) {
    const m = await modelo(), ids = new Set((await visiveis(user, await cardsC(m))).map(c => String(c.id)));
    const todos = store.historico.filter(h => ids.has(String(h.card))), size = 30, pages = Math.max(1, Math.ceil(todos.length / size)), page = Math.min(pages, Math.max(1, +q.page || 1));
    const fatia = todos.slice((page - 1) * size, page * size), nm = await nomes(fatia.map(h => h.vendedorId));
    return { total: todos.length, page, pages, itens: fatia.map(h => ({ ...h, vendedor: nm(h.vendedorId) })) };
  }

  // ---------- preparar (cria etapas e campos que faltam) ----------
  async function preparar() {
    const m = await modelo(true), rel = { etapas: [], campos: [], erros: [] };
    const ent = `DYNAMIC_${ETYPE.fila}_STAGE_${m.categoryId}`;
    for (const [cod, nome, cor, ordem] of [['LATE', 'Atrasada', '#FF5752', 25], ['NAOREAL', 'Não realizada', '#A8ADB4', 45]]) {
      if (m.etapas[cod]) continue;
      try { await bx.call('crm.status.add', { fields: { ENTITY_ID: ent, STATUS_ID: `DT${ETYPE.fila}_${m.categoryId}:${cod}`, NAME: nome, SORT: ordem, COLOR: cor } }); rel.etapas.push(nome); }
      catch (e) { rel.erros.push(`Etapa ${nome}: ${e.message}`); }
    }
    const criar = async (tipo, rot, spec) => {
      try { await bx.call('userfieldconfig.add', { moduleId: 'crm', field: { entityId: `CRM_${tipo}`, editFormLabel: { br: rot, en: rot }, listColumnLabel: { br: rot, en: rot }, ...spec } }); rel.campos.push(`${tipo}: ${rot}`); }
      catch (e) { rel.erros.push(`Campo ${rot}: ${e.message}`); }
    };
    const f = m.fila, v = m.visita;
    if (!f.cargo) await criar(ETYPE.fila, 'Cargo', { userTypeId: 'string' });
    if (!f.data) await criar(ETYPE.fila, 'Data programada', { userTypeId: 'date' });
    if (!f.motivo) await criar(ETYPE.fila, 'Motivo da não realização', { userTypeId: 'enumeration', enum: cfg().motivosNaoRealizada.map((x, i) => ({ value: x, sort: (i + 1) * 10 })) });
    if (!f.detalhe) await criar(ETYPE.fila, 'Detalhe do motivo', { userTypeId: 'string' });
    if (!v.resultado) await criar(ETYPE.visita, 'Resultado / observações', { userTypeId: 'string', settings: { ROWS: 4 } });
    if (!v.acompanhamento) await criar(ETYPE.visita, 'Acompanhamento', { userTypeId: 'string' });
    if (!v.anexos) await criar(ETYPE.visita, 'Anexos', { userTypeId: 'file', multiple: 'Y' });
    if (!v.supervisor) await criar(ETYPE.visita, 'Supervisor que acompanhou', { userTypeId: 'employee' });
    modeloC = null; invalidar();
    store.log('preparar', `Preparar: ${rel.etapas.length} etapas, ${rel.campos.length} campos, ${rel.erros.length} erros`);
    return { ...rel, faltando: (await modelo(true)).faltando };
  }
  // Cria UMA etapa que o SPA não tem ("Não realizada" ou "Atrasada"), a pedido do administrador. A SORT fica logo antes de Finalizado / logo depois de Dia da Visita.
  async function criarEtapa(codigo) {
    if (!['NAOREAL', 'LATE'].includes(codigo)) throw fail(400, 'Etapa inválida.');
    const m = await modelo(true);
    if (codigo === 'NAOREAL' ? m.etapas.NAOREAL : m.etapaReal.LATE) return { ok: true, jaExistia: true };
    const ent = `DYNAMIC_${ETYPE.fila}_STAGE_${m.categoryId}`, st = (await bx.call('crm.status.list', { filter: { ENTITY_ID: ent } })).result || [];
    const ordem = id => Number((st.find(x => x.STATUS_ID === id) || {}).SORT) || 0;
    const [nome, cor, sort] = codigo === 'NAOREAL' ? ['Não realizada', '#A8ADB4', Math.max(1, (ordem(m.etapas.SUCCESS) || 100) - 5)] : ['Atrasada', '#FF5752', ordem(m.etapas.PREPARATION) + 5];
    await bx.call('crm.status.add', { fields: { ENTITY_ID: ent, STATUS_ID: `DT${ETYPE.fila}_${m.categoryId}:${codigo}`, NAME: nome, SORT: sort, COLOR: cor } });
    modeloC = null; invalidar(); store.log('etapa', `Etapa "${nome}" criada no SPA da fila`);
    return { ok: true, criada: nome };
  }
  async function camposInfo() {
    const m = await modelo(true);
    return { disponiveisVisita: m.disponiveis.visita, mapaVisita: cfg().mapa?.visita || {}, ajustaveisVisita: F.VISITA_AJUSTAVEIS, visitaDetectada: Object.fromEntries(F.VISITA_AJUSTAVEIS.map(k => [k, m.visita[k] || null])), categoryId: m.categoryId, etapas: m.etapas, faltando: m.faltando, disponiveis: m.disponiveis.fila, mapa: cfg().mapa?.fila || {}, ajustaveis: F.CAMPOS_AJUSTAVEIS, segmentos: Object.values(m.empresa.segmentos).map(s => ({ nome: s.nome, cargos: Object.keys(s.cargos), classe: s.classe.length, proxima: s.proxima.length, ultima: s.ultima.length, duplicados: [...Object.values(s.cargos), s.classe, s.proxima, s.ultima].some(l => l.length > 1) })),
      fila: Object.fromEntries(Object.keys(F.FILA_CAMPOS).map(k => [k, m.fila[k] || null])), visita: Object.fromEntries(Object.keys(F.VISITA_CAMPOS).map(k => [k, m.visita[k] || null])) };
  }

  return { modelo, sync, varrer, listar, dashboard, registros, historico, formCard, registrar, editarRegistro, registroDoCard, reprogramar, reprogramarGrupo, reverter, naoRealizada, excluir, restaurar, proxima, participantes,
    veTudo, admitirAgendados, criarEtapa, restaurarRemovidos, preparar, camposInfo, diagnosticoDatas, reconciliar, auditoria, corrigirAuditoria, semUltima, salvarUltimas, supervisores, temAcesso, resetModelo: () => { modeloC = null; ultDados.clear(); ultEmp.clear(); invalidar(); }, aquecer, nomes, departamentos, podeExcluir, contatos, invalidar, hoje, _t: { gerarProximo, paraCard } };
}
module.exports = { createService, ABERTAS };
