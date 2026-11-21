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
    if (!cfg().exigirUltimaVisita) return { cards, ocultos: 0 };
    await carregaUltimas(m, cards.map(c => c.empresaId));
    const ok = cards.filter(c => ultDados.get(chaveUlt(c))?.ultima);
    return { cards: ok, ocultos: cards.length - ok.length };
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
  async function escopo(user) {
    const c = cfg();
    if (user.papel === 'admin' || c.verTudo.map(String).includes(String(user.id))) return null;
    return cached(`esc:${user.id}`, 300000, async () => {
      const set = new Set([String(user.id)]);
      const ds = await departamentos();
      const chefiados = ds.filter(d => d.chefe === String(user.id)).map(d => d.id);
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
    return {
      id: +it.id, titulo: it.title, empresaId: +it.companyId || 0, etapa: etapaCod(m, it.stageId) || 'OUTRA', etapaNome: m.etapaNomes?.[it.stageId] || '', vendedorId: vendedorDe(m, it),
      segmento: lista('segmento'), cargo: lista('cargo') || 'Vendedor', classe: R.classeLetra(lista('classe')), data: dia(it[f.data]),
      motivo: lista('motivo'), detalhe: txt(it[f.detalhe]), criado: it.createdTime || '',
    };
  }
  async function cardsTodos(m, extra = {}) {
    const f = m.fila;
    const sel = ['id', 'title', 'companyId', 'stageId', 'assignedById', 'createdTime', ...['segmento', 'cargo', 'classe', 'data', 'motivo', 'detalhe', 'vendedor'].map(k => f[k]).filter(Boolean)];
    return (await bx.listAll('crm.item.list', { entityTypeId: ETYPE.fila, select: sel, filter: { categoryId: m.categoryId, ...extra }, order: { id: 'ASC' } })).map(i => paraCard(m, i));
  }
  const cardsC = m => cached('cards', 45000, () => cardsTodos(m), 600000);
  async function umCard(m, id) {
    const r = await bx.call('crm.item.get', { entityTypeId: ETYPE.fila, id });
    const it = r.result?.item || r.result;
    if (!it || +it.categoryId !== m.categoryId && it.categoryId !== undefined) throw fail(404, 'Card não encontrado.');
    return paraCard(m, it);
  }
  async function criarCard(m, { empresaId, empresa, segmento, cargo = 'Vendedor', classe, vendedorId, data }) {
    const f = m.fila, ff = m.filaFields, fields = {
      title: `${empresa} · ${segmento}`, companyId: empresaId, categoryId: m.categoryId, stageId: m.etapas[R.etapaPorData(data, hoje())] || m.etapas.NEW, assignedById: vendedorId,
      [f.segmento]: escreverLista(itensDe(ff, f.segmento), segmento), [f.classe]: escreverLista(itensDe(ff, f.classe), R.classeNome(classe)), [f.data]: data,
    };
    if (f.cargo) fields[f.cargo] = escreverLista(itensDe(ff, f.cargo), cargo);
    const r = await bx.call('crm.item.add', { entityTypeId: ETYPE.fila, fields });
    invalidar('cards');
    return +(r.result?.item?.id || r.result?.id);
  }
  const atualizarCard = async (id, fields) => { await bx.call('crm.item.update', { entityTypeId: ETYPE.fila, id, fields }); invalidar('cards'); };
  const mover = (m, id, cod, extra = {}) => atualizarCard(id, { stageId: m.etapas[cod], ...extra });

  // Cria o próximo card (se a chave não tiver aberto) e atualiza a "Próxima visita" do cadastro.
  async function gerarProximo(m, card, baseData) {
    const todos = (await cardsTodos(m, { companyId: card.empresaId }));
    const k = R.chaveCard(card.empresaId, card.segmento, card.cargo);
    const aberto = todos.find(c => R.chaveCard(c.empresaId, c.segmento, c.cargo) === k && ABERTAS.includes(c.etapa));
    if (aberto) return aberto.id;
    if (!card.classe) return null;
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
            const semUlt = cfg().exigirUltimaVisita && !ultima;
            const k = R.chaveCard(comp.ID, seg.nome, cargo), ex = porChave.get(k) || [], abertos = ex.filter(c => ABERTAS.includes(c.etapa));
            if (!vendedor || !classe) {
              r.semClasse++;
              if (cfg().removerSemClasse) for (const c of abertos) { r.removidos++; acoes.push(() => mover(m, c.id, 'FAIL')); }
              continue;
            }
            if (!abertos.length) {
              const ult = ex.filter(c => c.etapa !== 'FAIL').sort((a, b) => b.id - a.id)[0];
              const base = { empresaId: +comp.ID, empresa: comp.TITLE, segmento: seg.nome, cargo, classe, vendedorId: vendedor };
              if (semUlt) { r.semUltima = (r.semUltima || 0) + 1; continue; }              // sem última visita no cadastro: não entra na fila
              if (!ex.length && cfg().exigirUltimaVisita && !(proxima && proxima >= h)) {   // 1º card nasce da última visita + intervalo da classe
                let data = R.proximaVisita(classe, ultima, cfg()); if (R.etapaPorData(data, h) === 'NAOREAL') data = R.nextBusinessDay(h);
                r.criados++; acoes.push(async () => { await criarCard(m, { ...base, data }); await atualizarEmpresa(m, base.empresaId, base.segmento, { proxima: data }); });
              } else if (!ex.length) {
                if (proxima && proxima >= h) { r.criados++; acoes.push(() => criarCard(m, { ...base, data: proxima })); }
                else primeiras[classe].push(base);
              } else if (ult) { r.criados++; acoes.push(() => criarCard(m, { ...base, data: R.proximaVisita(classe, ult.etapa === 'NAOREAL' ? (ult.data > h ? ult.data : h) : (ult.data || h), cfg()) })); }
              continue;
            }
            if (semUlt) continue;                                                       // card existente sem última visita: fica como está (oculto no app)
            abertos.slice(1).forEach(c => { r.removidos++; acoes.push(() => mover(m, c.id, 'FAIL')); });
            const c = abertos[0], upd = {};
            if (c.vendedorId !== vendedor) upd.assignedById = vendedor;
            if (c.classe !== classe) upd[m.fila.classe] = escreverLista(itensDe(m.filaFields, m.fila.classe), R.classeNome(classe));
            const alvo = c.data ? R.etapaPorData(c.data, h) : c.etapa;
            if (alvo === 'NAOREAL') { r.naoRealizadas++; acoes.push(() => naoRealizadaAuto(m, c)); continue; }
            if (alvo !== c.etapa) upd.stageId = m.etapas[alvo];
            if (Object.keys(upd).length) { r.atualizados++; acoes.push(() => atualizarCard(c.id, upd)); }
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
        if (alvo === c.etapa) continue;
        n++;
        if (alvo === 'NAOREAL') await naoRealizadaAuto(m, c); else await mover(m, c.id, alvo);
      }
      return { ok: true, ajustados: n };
    } finally { varrendo = false; }
  }
  async function naoRealizadaAuto(m, c) {
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
      const r = await bx.call('crm.item.add', { entityTypeId: ETYPE.visita, fields: f });
      const vid = +(r.result?.item?.id || r.result?.id);
      await mover(m, id, 'ENC');
      await atualizarEmpresa(m, card.empresaId, card.segmento, { ultima: dataHora.slice(0, 10) });
      const prox = await gerarProximo(m, { ...card, etapa: 'ENC' }, dataHora.slice(0, 10));
      const tk = store.tarefa(id);
      if (tk) { await bx.call('tasks.task.complete', { taskId: tk }).catch(() => {}); store.setTarefa(id, null); }
      store.log('visita', `Visita registrada (#${vid}) em ${card.titulo} por ${user.nome || user.id}`, { card: id });
      invalidar('cards', 'dash', 'regs');
      return { ok: true, registro: vid, proximoCard: prox };
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
      await mover(m, id, R.etapaPorData(data, hoje()), { [m.fila.data]: data });
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
    await mover(m, id, R.etapaPorData(s.data, hoje()) === 'NAOREAL' ? s.etapa : R.etapaPorData(s.data, hoje()), { [m.fila.data]: s.data });
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
      await mover(m, id, 'FAIL');
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
      supervisor: txt(it[v.supervisor]), anexos: A(it[v.anexos]).map(a => (a && typeof a === 'object' ? { id: a.id, url: a.urlMachine || a.url || '' } : { url: a })) };
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
    const pode = user.papel === 'admin' || reg.criadoPor === String(user.id) || esc === null || (esc && esc.has(reg.criadoPor));
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
    return { hoje: h, de, ate, ocultos: cu.ocultos, exigirUltima: cfg().exigirUltimaVisita, total: cards.length, totalGrupos: unidades.length, page, pageSize: size, pages, porEtapa, itens: fatia.map(c => ({ ...c, empresa: tit(c.empresaId), vendedor: c.vendedorId ? nm(c.vendedorId) : 'Sem vendedor', podeExcluir: podeExcluir(user), ultimaVisita: ultDados.get(chaveUlt(c))?.ultima || '', reprogramado: !!store.snap(c.id), atrasoDias: c.data && ABERTAS.includes(c.etapa) ? Math.max(0, R.dayDiff(c.data, h)) : 0 })) };
  }
  async function escopoDe(userId) { return escopo({ id: userId, papel: 'x' }); }
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
  const grupoDe = e => (e === 'ENC' || e === 'SUCCESS' ? 'realizadas' : e === 'LATE' ? 'atrasadas' : e === 'NAOREAL' ? 'nao' : 'abertas');
  async function dashboard(user, q = {}) {
    const { cards } = await filtrados(user, q), base = (await filtrados(user, q, ['segmento', 'vendedor', 'classe', 'supervisor', 'etapa', 'motivo'])).cards;
    const nm0 = await nomes(cards.map(c => c.vendedorId).concat(base.map(c => c.vendedorId))), nm = id => (id ? nm0(id) : 'Sem vendedor');
    const novo = () => ({ realizadas: 0, abertas: 0, atrasadas: 0, nao: 0, total: 0 });
    const soma = (mapa, k, extra, c) => { const o = (mapa[k] ||= { ...novo(), ...extra }); o[grupoDe(c.etapa)]++; o.total++; };
    const mes = {}, vend = {}, seg = {}, cls = {}, mot = {};
    for (const c of cards) {
      soma(mes, (c.data || '').slice(0, 7) || '—', {}, c);
      soma(vend, c.vendedorId || 'sem', { id: c.vendedorId || 'sem', nome: nm(c.vendedorId) }, c);
      soma(seg, c.segmento || '—', { nome: c.segmento || '—' }, c);
      soma(cls, c.classe || '—', { nome: c.classe || '—' }, c);
      if (c.etapa === 'NAOREAL') mot[c.motivo || 'Sem motivo informado'] = (mot[c.motivo || 'Sem motivo informado'] || 0) + 1;
    }
    const tot = cards.reduce((a, c) => { a[grupoDe(c.etapa)]++; return a; }, novo()), ids = new Set(cards.map(c => String(c.id)));
    const vencidas = tot.realizadas + tot.atrasadas + tot.nao, ord = o => Object.values(o).sort((a, b) => b.total - a.total);
    return {
      hoje: hoje(),
      kpis: { programadas: cards.length, realizadas: tot.realizadas, abertas: tot.abertas, atrasadas: tot.atrasadas, naoRealizadas: tot.nao,
        reprogramacoes: store.historico.filter(h => ids.has(String(h.card))).length, taxa: vencidas ? Math.round(tot.realizadas * 100 / vencidas) : null },
      serie: Object.entries(mes).filter(([k]) => k !== '—').sort().map(([k, v]) => ({ mes: k, ...v })),
      porVendedor: ord(vend).slice(0, 30), porSegmento: ord(seg), porClasse: ['A', 'B', 'C', 'E'].map(k => cls[k] || { nome: k, ...novo() }).concat(cls['—'] ? [cls['—']] : []),
      motivos: Object.entries(mot).sort((a, b) => b[1] - a[1]).map(([nome, n]) => ({ nome, n })),
      opcoes: { segmentos: [...new Set(base.map(c => c.segmento).filter(Boolean))].sort(), vendedores: [...new Map(base.map(c => [c.vendedorId || 'sem', nm(c.vendedorId)]))].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome)), classes: ['A', 'B', 'C', 'E'] },
    };
  }
  // Diagnóstico (somente leitura) de como as datas de visita estão no cadastro das empresas.
  async function diagnosticoDatas() {
    const m = await modelo(true), h = hoje(), [emps, cards] = await Promise.all([empresasSync(m), cardsTodos(m)]);
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
  // Registros de visita (SPA 1032) dos cards filtrados: busca, paginação e permissão de edição.
  async function registros(user, q = {}) {
    const { m, cards } = await filtrados(user, q), porId = new Map(cards.map(c => [String(c.id), c]));
    let regs = (await registrosC(m)).filter(r => porId.has(r.idFila));
    const esc = await escopo(user), busca = R.norm(q.q || '');
    const tit = await tituloEmpresas(regs.map(r => r.empresaId)), nm = await nomes(regs.map(r => porId.get(r.idFila).vendedorId).concat(regs.map(r => r.supervisor)));
    let lista = regs.map(r => { const c = porId.get(r.idFila); return { _r: r, id: r.id, idFila: +r.idFila, empresa: tit(r.empresaId), segmento: c.segmento, classe: c.classe, vendedor: nm(c.vendedorId), dataHora: r.dataHora, supervisor: r.supervisor ? nm(r.supervisor) : '', contatos: r.contatos.length, anexos: r.anexos.length, resumo: r.fatos.replace(/\s+/g, ' ').slice(0, 180), podeEditar: user.papel === 'admin' || esc === null || r.criadoPor === String(user.id) || !!esc?.has(r.criadoPor), _b: R.norm(`${tit(r.empresaId)} ${c.segmento} ${nm(c.vendedorId)} ${r.fatos}`) }; });
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
  async function camposInfo() {
    const m = await modelo(true);
    return { disponiveisVisita: m.disponiveis.visita, mapaVisita: cfg().mapa?.visita || {}, ajustaveisVisita: F.VISITA_AJUSTAVEIS, visitaDetectada: Object.fromEntries(F.VISITA_AJUSTAVEIS.map(k => [k, m.visita[k] || null])), categoryId: m.categoryId, etapas: m.etapas, faltando: m.faltando, disponiveis: m.disponiveis.fila, mapa: cfg().mapa?.fila || {}, ajustaveis: F.CAMPOS_AJUSTAVEIS, segmentos: Object.values(m.empresa.segmentos).map(s => ({ nome: s.nome, cargos: Object.keys(s.cargos), classe: s.classe.length, proxima: s.proxima.length, ultima: s.ultima.length, duplicados: [...Object.values(s.cargos), s.classe, s.proxima, s.ultima].some(l => l.length > 1) })),
      fila: Object.fromEntries(Object.keys(F.FILA_CAMPOS).map(k => [k, m.fila[k] || null])), visita: Object.fromEntries(Object.keys(F.VISITA_CAMPOS).map(k => [k, m.visita[k] || null])) };
  }

  return { modelo, sync, varrer, listar, dashboard, registros, historico, formCard, registrar, editarRegistro, registroDoCard, reprogramar, reprogramarGrupo, reverter, naoRealizada, excluir, restaurar, proxima, participantes,
    preparar, camposInfo, diagnosticoDatas, supervisores, temAcesso, resetModelo: () => { modeloC = null; ultDados.clear(); ultEmp.clear(); invalidar(); }, aquecer, nomes, departamentos, podeExcluir, contatos, invalidar, hoje, _t: { gerarProximo, paraCard } };
}
module.exports = { createService, ABERTAS };
