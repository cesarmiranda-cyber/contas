'use strict';
const R = require('./rules');
const F = require('./fields');
const { ETYPE, A } = F;

const ABERTAS = ['NEW', 'PREPARATION', 'LATE'];
const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
const dia = v => (v ? String(v).slice(0, 10) : '');
const val = v => (Array.isArray(v) ? v[0] : v);
const txt = v => (v === undefined || v === null ? '' : String(v));

function createService({ bitrix: bx, store, now = () => new Date() }) {
  const hoje = () => R.todayBR(now());
  const cfg = () => store.config;
  // ---------- caches e travas ----------
  let modeloC = null, modeloAt = 0;
  async function modelo(force) {
    if (!force && modeloC && Date.now() - modeloAt < 300000) return modeloC;
    modeloC = await F.descobrir(bx); modeloAt = Date.now(); return modeloC;
  }
  const memo = new Map();
  async function cached(key, ttl, fn) {
    const c = memo.get(key);
    if (c && Date.now() - c.at < ttl) return c.v;
    if (c?.p) return c.p;
    const p = fn().then(v => { memo.set(key, { at: Date.now(), v }); return v; }, e => { memo.delete(key); throw e; });
    memo.set(key, { at: c?.at || 0, v: c?.v, p });
    return p;
  }
  const invalidar = (...ks) => { for (const k of ks.length ? ks : [...memo.keys()]) memo.delete(k); };
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
    if (Object.keys(fields).length) await bx.call('crm.company.update', { id: empresaId, fields });
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
  function paraCard(m, it) {
    const f = m.fila, ff = m.filaFields;
    const lista = k => { const v = it[f[k]]; const items = itensDe(ff, f[k]); const x = val(v); return items.length ? (items.find(i => String(i.ID) === String(x))?.VALUE || '') : txt(x); };
    return {
      id: +it.id, titulo: it.title, empresaId: +it.companyId || 0, etapa: etapaCod(m, it.stageId) || 'OUTRA', etapaNome: m.etapaNomes?.[it.stageId] || '', vendedorId: txt(it.assignedById),
      segmento: lista('segmento'), cargo: lista('cargo') || 'Vendedor', classe: R.classeLetra(lista('classe')), data: dia(it[f.data]),
      motivo: lista('motivo'), detalhe: txt(it[f.detalhe]), criado: it.createdTime || '',
    };
  }
  async function cardsTodos(m, extra = {}) {
    const f = m.fila;
    const sel = ['id', 'title', 'companyId', 'stageId', 'assignedById', 'createdTime', ...['segmento', 'cargo', 'classe', 'data', 'motivo', 'detalhe'].map(k => f[k]).filter(Boolean)];
    return (await bx.listAll('crm.item.list', { entityTypeId: ETYPE.fila, select: sel, filter: { categoryId: m.categoryId, ...extra }, order: { id: 'ASC' } })).map(i => paraCard(m, i));
  }
  const cardsC = m => cached('cards', 15000, () => cardsTodos(m));
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
      const porChave = new Map();
      for (const c of cards) { const k = R.chaveCard(c.empresaId, c.segmento, c.cargo); (porChave.get(k) || porChave.set(k, []).get(k)).push(c); }
      const r = { ok: true, previa, criados: 0, removidos: 0, atualizados: 0, naoRealizadas: 0, semClasse: 0, empresas: empresas.length };
      const primeiras = { A: [], B: [], C: [], E: [] }, acoes = [];
      for (const comp of empresas) {
        for (const segKey of Object.keys(m.empresa.segmentos)) {
          const seg = m.empresa.segmentos[segKey];
          for (const cargo of cfg().cargosFila) {
            if (!seg.cargos[cargo]) continue;
            const { vendedor, classe, proxima } = leituraEmpresa(m, comp, segKey, cargo);
            const k = R.chaveCard(comp.ID, seg.nome, cargo), ex = porChave.get(k) || [], abertos = ex.filter(c => ABERTAS.includes(c.etapa));
            if (!vendedor || !classe) {
              r.semClasse++;
              if (cfg().removerSemClasse) for (const c of abertos) { r.removidos++; acoes.push(() => mover(m, c.id, 'FAIL')); }
              continue;
            }
            if (!abertos.length) {
              const ult = ex.filter(c => c.etapa !== 'FAIL').sort((a, b) => b.id - a.id)[0];
              const base = { empresaId: +comp.ID, empresa: comp.TITLE, segmento: seg.nome, cargo, classe, vendedorId: vendedor };
              if (!ex.length) {
                if (proxima && proxima >= h) { r.criados++; acoes.push(() => criarCard(m, { ...base, data: proxima })); }
                else primeiras[classe].push(base);
              } else if (ult) { r.criados++; acoes.push(() => criarCard(m, { ...base, data: R.proximaVisita(classe, ult.etapa === 'NAOREAL' ? (ult.data > h ? ult.data : h) : (ult.data || h), cfg()) })); }
              continue;
            }
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
  async function varrer() {
    if (!store.ativo) return { ok: true, ativo: false };
    const m = await modelo(), h = hoje();
    const abertos = (await cardsTodos(m)).filter(c => ABERTAS.includes(c.etapa) && c.data);
    let n = 0;
    for (const c of abertos) {
      const alvo = R.etapaPorData(c.data, h);
      if (alvo === c.etapa) continue;
      n++;
      if (alvo === 'NAOREAL') await naoRealizadaAuto(m, c); else await mover(m, c.id, alvo);
    }
    return { ok: true, ajustados: n };
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
  function camposVisita(m, b, vendedorId) {
    const v = m.visita, vf = m.visitaFields, f = {};
    const set = (k, x) => { if (v[k] && x !== undefined) f[v[k]] = x; };
    const lista = (k, x) => { const items = itensDe(vf, v[k]); return items.length ? (x ? (items.find(i => R.norm(i.VALUE) === R.norm(x))?.ID ?? '') : '') : txt(x); };
    set('fatos', txt(b.fatos)); set('interesses', txt(b.interesses)); set('sentimentos', txt(b.sentimentos)); set('valores', txt(b.valores));
    set('populacao', txt(b.populacao)); set('resultado', txt(b.resultado));
    if (v.regime) f[v.regime] = lista('regime', b.regime);
    if (v.oportunidades) f[v.oportunidades] = lista('oportunidades', b.oportunidades);
    if (v.antecipada) f[v.antecipada] = lista('antecipada', b.antecipada);
    if (v.acompanhamento) f[v.acompanhamento] = lista('acompanhamento', b.acompanhamento);
    if (v.supervisor && b.supervisor) f[v.supervisor] = txt(b.supervisor);
    if (Array.isArray(b.anexos) && b.anexos.length && v.anexos) f[v.anexos] = b.anexos.slice(0, 10).map(a => [String(a.nome || 'anexo').slice(0, 120), String(a.base64 || '')]);
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
      const contatos = A(b.contatos).map(Number).filter(Boolean);
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
    motivo = txt(motivo).trim();
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
    motivo = txt(motivo).trim(); detalhe = txt(detalhe).trim();
    if (!motivo) throw fail(400, 'Informe o motivo da não realização.');
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
    store.addTroca(id, { at: new Date().toISOString(), usuario: user.nome || String(user.id), contatos: A(ids).map(Number) });
    const m = await modelo(); void m; void card;
    return { ok: true };
  }

  // ---------- registros (SPA 1032) ----------
  const camposSel = m => ['id', 'title', 'companyId', 'contactIds', 'createdBy', 'assignedById', 'createdTime', ...Object.keys(m.visita).filter(k => !k.endsWith('_todos') && !k.endsWith('Enum')).map(k => m.visita[k]).filter(Boolean)];
  function paraRegistro(m, it) {
    const v = m.visita, vf = m.visitaFields, lista = k => { const items = itensDe(vf, v[k]); const x = val(it[v[k]]); return items.length ? (items.find(i => String(i.ID) === String(x))?.VALUE || '') : txt(x); };
    return { id: +it.id, empresaId: +it.companyId, contatos: A(it.contactIds).map(Number), criadoPor: txt(it.createdBy), dataHora: it[v.data] || '', idFila: txt(it[v.idFila]), segmento: lista('segmento'),
      fatos: txt(it[v.fatos]), interesses: txt(it[v.interesses]), sentimentos: txt(it[v.sentimentos]), valores: txt(it[v.valores]), populacao: txt(it[v.populacao]),
      regime: lista('regime'), oportunidades: lista('oportunidades'), antecipada: lista('antecipada'), resultado: txt(it[v.resultado]), acompanhamento: lista('acompanhamento'),
      supervisor: txt(it[v.supervisor]), anexos: A(it[v.anexos]).map(a => (a && typeof a === 'object' ? { id: a.id, url: a.urlMachine || a.url || '' } : { url: a })) };
  }
  async function registroDoCard(id, user) {
    const { m } = await carregar(id, user);
    const r = await bx.call('crm.item.list', { entityTypeId: ETYPE.visita, select: camposSel(m), filter: { [m.visita.idFila]: String(id) }, order: { id: 'DESC' } });
    const it = (r.result?.items || [])[0];
    if (!it) throw fail(404, 'Este card ainda não tem registro de visita.');
    return paraRegistro(m, it);
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
    if (A(b.contatos).length) f.contactIds = A(b.contatos).map(Number).filter(Boolean);
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
      opcoes: { regime: opt('regime'), oportunidades: opt('oportunidades'), antecipada: opt('antecipada'), acompanhamento: opt('acompanhamento') }, motivos: cfg().motivosNaoRealizada,
      campos: { populacao: !!v.populacao, anexos: !!v.anexos, supervisor: !!v.supervisor, regime: !!v.regime } };
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
    if (de || ate) cards = cards.filter(c => c.etapa === 'NAOREAL' || !c.data || ((!de || c.data >= de) && (!ate || c.data <= ate)) || (ABERTAS.includes(c.etapa) && c.data < de && !q.de));
    if (q.segmento) cards = cards.filter(c => R.norm(c.segmento) === R.norm(q.segmento));
    if (q.vendedor) cards = cards.filter(c => c.vendedorId === String(q.vendedor));
    if (q.classe) cards = cards.filter(c => c.classe === q.classe);
    if (q.etapa) cards = cards.filter(c => c.etapa === q.etapa);
    if (q.supervisor) { const s = await escopoDe(q.supervisor); cards = cards.filter(c => s.has(c.vendedorId)); }
    const tit = await tituloEmpresas(cards.map(c => c.empresaId)), nm = await nomes(cards.map(c => c.vendedorId));
    return { hoje: h, de, ate, total: cards.length, itens: cards.map(c => ({ ...c, empresa: tit(c.empresaId), vendedor: nm(c.vendedorId), podeExcluir: podeExcluir(user), reprogramado: !!store.snap(c.id), atrasoDias: c.data && ABERTAS.includes(c.etapa) ? Math.max(0, R.dayDiff(c.data, h)) : 0 })) };
  }
  async function escopoDe(userId) { return escopo({ id: userId, papel: 'x' }); }
  async function registrosC(m) { return cached('regs', 60000, async () => (await bx.listAll('crm.item.list', { entityTypeId: ETYPE.visita, select: camposSel(m), order: { id: 'DESC' } })).map(i => paraRegistro(m, i))); }
  async function dashboard(user, q = {}) {
    const m = await modelo(), h = hoje();
    const cards = await visiveis(user, await cardsC(m));
    const ids = new Set(cards.map(c => String(c.id)));
    const regs = (await registrosC(m)).filter(r => ids.has(r.idFila));
    const nm = await nomes([...cards.map(c => c.vendedorId), ...regs.map(r => r.supervisor)]);
    const cnt = (arr, f) => { const o = {}; for (const x of arr) { const k = f(x) || '—'; o[k] = (o[k] || 0) + 1; } return o; };
    const ativos = cards.filter(c => c.etapa !== 'FAIL'), enc = cards.filter(c => c.etapa === 'ENC'), nao = cards.filter(c => c.etapa === 'NAOREAL');
    const hist = store.historico.filter(x => ids.has(String(x.card)));
    const mes = x => (x || '').slice(0, 7);
    return {
      hoje: h, carregando: false,
      fila: { porEtapa: cnt(ativos, c => c.etapa), atrasadas: ativos.filter(c => c.etapa === 'LATE').length, diaDaVisita: ativos.filter(c => c.etapa === 'PREPARATION').length,
        porVendedor: cnt(ativos.filter(c => ABERTAS.includes(c.etapa)), c => nm(c.vendedorId)), porClasse: cnt(ativos.filter(c => ABERTAS.includes(c.etapa)), c => c.classe), porSegmento: cnt(ativos.filter(c => ABERTAS.includes(c.etapa)), c => c.segmento) },
      encerradas: { total: enc.length, porMes: cnt(enc, c => mes(c.data)), porVendedor: cnt(enc, c => nm(c.vendedorId)), porClasse: cnt(enc, c => c.classe), porSegmento: cnt(enc, c => c.segmento) },
      registros: { total: regs.length, porMes: cnt(regs, r => mes(r.dataHora)), porSegmento: cnt(regs, r => r.segmento), porVendedor: cnt(regs, r => nm(cards.find(c => String(c.id) === r.idFila)?.vendedorId)) },
      reprogramacoes: { total: hist.length, porMotivo: cnt(hist, x => x.motivo), porVendedor: cnt(hist, x => nm(x.vendedorId)) },
      supervisor: { acompanhadas: regs.filter(r => r.supervisor).length, porSupervisor: cnt(regs.filter(r => r.supervisor), r => nm(r.supervisor)) },
      naoRealizadas: { total: nao.length, porMotivo: cnt(nao, c => c.motivo || 'Sem motivo informado'), porVendedor: cnt(nao, c => nm(c.vendedorId)), porMes: cnt(nao, c => mes(c.data)) },
    };
  }
  async function historico(user) {
    const m = await modelo(), ids = new Set((await visiveis(user, await cardsC(m))).map(c => String(c.id)));
    const nm = await nomes(store.historico.map(h => h.vendedorId));
    return store.historico.filter(h => ids.has(String(h.card))).slice(0, 500).map(h => ({ ...h, vendedor: nm(h.vendedorId) }));
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
    return { categoryId: m.categoryId, etapas: m.etapas, faltando: m.faltando, segmentos: Object.values(m.empresa.segmentos).map(s => ({ nome: s.nome, cargos: Object.keys(s.cargos), classe: s.classe.length, proxima: s.proxima.length, ultima: s.ultima.length, duplicados: [...Object.values(s.cargos), s.classe, s.proxima, s.ultima].some(l => l.length > 1) })),
      fila: Object.fromEntries(Object.keys(F.FILA_CAMPOS).map(k => [k, m.fila[k] || null])), visita: Object.fromEntries(Object.keys(F.VISITA_CAMPOS).map(k => [k, m.visita[k] || null])) };
  }

  return { modelo, sync, varrer, listar, dashboard, historico, formCard, registrar, editarRegistro, registroDoCard, reprogramar, reprogramarGrupo, reverter, naoRealizada, excluir, restaurar, proxima, participantes,
    preparar, camposInfo, supervisores, temAcesso, nomes, departamentos, podeExcluir, contatos, invalidar, hoje, _t: { gerarProximo, paraCard } };
}
module.exports = { createService, ABERTAS };
