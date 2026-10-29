'use strict';
const R = require('./rules');
const F = require('./fields');
const Duplicados = require('./duplicados');

const CACHE_MS = 5 * 60 * 1000;
const DYN = id => `dynamic_${id}`;
const hex = n => n.toString(16);

function createService({ bitrix, store, acesso = null, clock = () => new Date() }) {
  let disc = null, discAt = 0;
  const hoje = () => R.todayBR(clock());
  const erro = (m, s = 400) => Object.assign(new Error(m), { status: s });

  async function campos(force) {
    if (!disc || force || Date.now() - discAt > CACHE_MS) { disc = await F.descobrir(bitrix, store.config); discAt = Date.now(); }
    return disc;
  }
  const notificar = async (userId, msg) => {
    if (!userId) return;
    try { await bitrix.call('im.notify.system.add', { USER_ID: userId, MESSAGE: msg }); } catch (e) { store.log('aviso', `Falha ao avisar usuário ${userId}: ${e.message}`); }
  };

  // ---------- leitura da empresa ----------
  async function lerEmpresa(id) {
    const { map, meta } = await campos();
    const r = (await bitrix.call('crm.company.get', { id })).result;
    if (!r) return null;
    const segs = {};
    const vazio = x => x === undefined || x === null || x === '' || x === '0' || x === 0 || (Array.isArray(x) && !x.length);
    for (const seg of R.SEGMENTOS) {
      const m = map.empresa[seg];
      // cada campo pode existir em duplicidade: lê o principal e os alternativos
      const chaves = k => (m[k] ? [m[k], ...((map.alt?.[seg] || {})[k] || [])] : []);
      const user = k => { for (const c of chaves(k)) { const x = r[c]; const n = Array.isArray(x) ? x[0] : x; if (!vazio(n) && +n) return +n; } return null; };
      const data = (k, pick) => { const ds = chaves(k).map(c => R.isoDate(r[c])).filter(Boolean).sort(); return ds.length ? (pick === 'max' ? ds[ds.length - 1] : ds[0]) : null; };
      let classe = '';
      for (const c of chaves('classe')) { const x = String(F.decode(meta, c, r[c])).trim().toUpperCase().slice(0, 1); if (R.CLASSES.includes(x)) { classe = x; break; } }
      segs[seg] = {
        diretor: user('diretor'), gerente: user('gerente'), coordenador: user('coordenador'),
        supervisor: user('supervisor'), vendedor: user('vendedor'),
        classe, ultima: data('ultima', 'max'), proxima: data('proxima', 'min'),
      };
    }
    return { id: +r.ID, nome: r.TITLE, ramo: r.INDUSTRY || '', tipo: map.tipoEmpresa ? F.decode(meta, map.tipoEmpresa, r[map.tipoEmpresa]) : '', segs };
  }

  // Diretor = chefe do departamento do Gerente (sobe um nível se o próprio Gerente é o chefe).
  const deptCache = new Map();
  async function dept(id) {
    if (!deptCache.has(id)) deptCache.set(id, ((await bitrix.call('department.get', { ID: id })).result || [])[0] || null);
    return deptCache.get(id);
  }
  async function diretorDe(gerenteId) {
    if (!gerenteId) return null;
    try {
      const u = ((await bitrix.call('user.get', { ID: gerenteId })).result || [])[0];
      let did = Array.isArray(u?.UF_DEPARTMENT) ? u.UF_DEPARTMENT[0] : null;
      for (let i = 0; did && i < 8; i++) {
        const d = await dept(did);
        if (!d) return null;
        const head = +d.UF_HEAD || null;
        if (head && head !== +gerenteId) return head;
        did = d.PARENT || null;
      }
    } catch (e) { store.log('aviso', `Diretor não resolvido para gerente ${gerenteId}: ${e.message}`); }
    return null;
  }

  // Chefes acima de um usuário, do mais próximo ao topo, sem repetir pessoas (um chefe de vários níveis conta uma vez).
  async function cadeiaAcima(userId) {
    const out = [];
    try {
      const u = ((await bitrix.call('user.get', { ID: userId })).result || [])[0];
      let did = Array.isArray(u?.UF_DEPARTMENT) ? u.UF_DEPARTMENT[0] : null;
      for (let i = 0; did && i < 10; i++) {
        const d = await dept(did);
        if (!d) break;
        const h = +d.UF_HEAD || null;
        if (h && h !== +userId && !out.includes(h)) out.push(h);
        did = d.PARENT || null;
      }
    } catch (e) { store.log('aviso', `Hierarquia de ${userId}: ${e.message}`); }
    return out;
  }
  // Preenche Supervisor/Coordenador/Gerente/Diretor vazios a partir do departamento do Vendedor:
  // o último chefe da cadeia é o Diretor, o anterior o Gerente, e assim por diante.
  // Alçadas configuradas no app por departamento: o primeiro departamento (do Vendedor para cima) que define o cargo vale.
  async function alcadaConfigurada(vendedorId, cargo) {
    const al = store.config.alcadas || {};
    if (!Object.keys(al).length) return null;
    const u = ((await bitrix.call('user.get', { ID: vendedorId })).result || [])[0];
    let did = Array.isArray(u?.UF_DEPARTMENT) ? u.UF_DEPARTMENT[0] : null;
    for (let i = 0; did && i < 10; i++) {
      const v = al[did]?.[cargo];
      if (v) return +v;
      const d = await dept(did);
      did = d?.PARENT || null;
    }
    return null;
  }
  async function preencherHierarquia(emp, map) {
    const ordem = ['diretor', 'gerente', 'coordenador', 'supervisor'];
    for (const seg of R.SEGMENTOS) {
      const s = emp.segs[seg];
      if (!s.vendedor || ordem.every(k => s[k])) continue;
      const cadeia = store.config.hierarquiaAuto ? await cadeiaAcima(s.vendedor) : [];
      const gravar = {};
      for (const [i, k] of ordem.entries()) {
        if (s[k]) continue;
        const id = (await alcadaConfigurada(s.vendedor, k)) || cadeia[cadeia.length - 1 - i];
        if (id) { s[k] = id; if (map.empresa[seg][k]) gravar[map.empresa[seg][k]] = id; }
      }
      if (Object.keys(gravar).length) {
        await bitrix.call('crm.company.update', { id: emp.id, fields: gravar });
        store.log('hierarquia', `Empresa ${emp.nome} · ${seg}: preenchido pela estrutura (${Object.keys(gravar).length} campo(s))`, { empresa: emp.id });
      }
    }
  }

  const equipeIds = sg => Object.fromEntries(['vendedor', 'supervisor', 'coordenador', 'gerente', 'diretor'].filter(k => sg && sg[k]).map(k => [k, sg[k]]));
  // Tipo de empresa (Industrial / Marítimo) a partir do "Setor" (INDUSTRY) da empresa; a tabela ramo -> tipo é editável no app.
  const sugestaoTipo = nome => {
    const n = R.norm(nome);
    if (/marit|maritm|offshore|estaleiro|fluvial|portu|naval|lazer/.test(n)) return 'Marítimo';
    if (/energia|compress|transport|onibus|pedreira|constru|minera|agric|florestal|coleta|onshore/.test(n)) return 'Industrial';
    return '';
  };
  let ramos = null, ramosAt = 0;
  async function listaRamos() {
    if (!ramos || Date.now() - ramosAt > CACHE_MS) { ramos = ((await bitrix.call('crm.status.list', { filter: { ENTITY_ID: 'INDUSTRY' } })).result || []).map(x => ({ id: x.STATUS_ID, nome: x.NAME })); ramosAt = Date.now(); }
    const cfg = store.config.tipoPorRamo || {};
    return ramos.map(r => ({ ...r, tipo: cfg[r.id] !== undefined ? cfg[r.id] : sugestaoTipo(r.nome) }));
  }
  const nomeRamo = async id => (id ? ((await listaRamos()).find(r => r.id === id) || {}).nome || '' : '');
  async function tipoDaEmpresa(emp) {
    if (!emp) return '';
    if (emp.tipo) return emp.tipo;
    if (!emp.ramo) return '';
    return ((await listaRamos()).find(r => r.id === emp.ramo) || {}).tipo || '';
  }
  // ---------- tarefas vinculadas ao card (CRM binding T40c_<id>) ----------
  const vinculoCard = id => `T${hex(F.ETYPE.fila)}_${id}`;
  const prazoTarefa = dataIso => `${dataIso}T18:00:00-03:00`;
  async function tarefasAbertas(cardId) {
    try {
      const r = await bitrix.call('tasks.task.list', { filter: { UF_CRM_TASK: vinculoCard(cardId) }, select: ['ID', 'TITLE', 'STATUS', 'DEADLINE'] });
      const l = r.result?.tasks || r.result || [];
      return (Array.isArray(l) ? l : []).filter(t => +(t.status ?? t.STATUS) !== 5).map(t => ({ id: +(t.id ?? t.ID), titulo: t.title ?? t.TITLE }));
    } catch (e) { store.log('aviso', `Tarefas do card ${cardId} não consultadas: ${e.message}`); return []; }
  }
  async function encerrarTarefas(cardId, motivo) {
    let n = 0;
    for (const t of await tarefasAbertas(cardId)) {
      try {
        if (motivo) await bitrix.call('task.commentitem.add', { TASKID: t.id, FIELDS: { POST_MESSAGE: motivo } }).catch(() => {});
        await bitrix.call('tasks.task.complete', { taskId: t.id });
        n++; store.log('tarefa', `Tarefa ${t.id} encerrada (card ${cardId})`, { card: cardId });
      } catch (e) { store.log('aviso', `Tarefa ${t.id} não encerrada: ${e.message}`); }
    }
    return n;
  }
  async function moverPrazoTarefas(cardId, dataIso) {
    let n = 0;
    for (const t of await tarefasAbertas(cardId)) {
      try { await bitrix.call('tasks.task.update', { taskId: t.id, fields: { DEADLINE: prazoTarefa(dataIso) } }); n++; store.log('tarefa', `Prazo da tarefa ${t.id} movido para ${R.fmtBR(dataIso)} (card ${cardId})`, { card: cardId }); }
      catch (e) { store.log('aviso', `Prazo da tarefa ${t.id} não alterado: ${e.message}`); }
    }
    return n;
  }
  async function criarTarefaCard(cardId, { empresa, seg, cargo, responsavel, data }) {
    try {
      await bitrix.call('tasks.task.add', { fields: { TITLE: `Realizar Visita - ${empresa} (${seg} · ${cargo})`, RESPONSIBLE_ID: responsavel, DEADLINE: prazoTarefa(data), UF_CRM_TASK: [vinculoCard(cardId)] } });
    } catch (e) { store.log('aviso', `Tarefa do card ${cardId} não criada: ${e.message}`); }
  }

  // ---------- cache curto (deixa as telas rápidas); qualquer escrita limpa ----------
  const memoria = new Map();
  const memo = async (chave, ttl, fn) => { const c = memoria.get(chave); if (c && Date.now() - c.em < ttl) return c.v; const v = await fn(); memoria.set(chave, { em: Date.now(), v }); return v; };
  // Mostra o último resultado na hora e atualiza em segundo plano quando passou do prazo (a tela não espera o Bitrix).
  const atualizando = new Set();
  const memoSWR = async (chave, ttl, fn) => {
    const c = memoria.get(chave);
    if (!c) return memo(chave, ttl, fn);
    if (Date.now() - c.em >= ttl && !atualizando.has(chave)) {
      atualizando.add(chave);
      fn().then(v => { if (memoria.has(chave)) memoria.set(chave, { em: Date.now(), v }); }).catch(() => {}).finally(() => atualizando.delete(chave));
    }
    return c.v;
  };
  // Só os cards mudam quando se escreve na fila: nomes, empresas e equipe continuam em cache (a tela não refaz tudo a cada alteração).
  // Alterações da varredura só deixam a lista "velha" (a tela segue mostrando e atualiza em segundo plano); ações do usuário descartam.
  const envelhece = () => { for (const [k, v] of memoria) if (k.startsWith('cards-')) memoria.set(k, { ...v, em: 0 }); };
  const invalida = () => { for (const k of [...memoria.keys()]) if (k.startsWith('cards-')) memoria.delete(k); };
  const empresaCurta = id => memo(`emp:${id}`, 120e3, () => lerEmpresa(id).catch(() => null));

  // ---------- cards da fila ----------
  const tituloCard = (empresa, seg, cargo) => `${empresa} | ${seg} | ${cargo}`;
  async function lerCard(id) {
    const { map } = await campos();
    const it = (await bitrix.call('crm.item.get', { entityTypeId: F.ETYPE.fila, id })).result?.item;
    if (!it) return null;
    return { ...(await dadosCard(it)), aberto: !map.etapas.fechadas.includes(it.stageId) };
  }
  // Lista todos os itens de um filtro: busca a primeira página, e as demais em paralelo (o Bitrix devolve 50 por vez).
  async function listarItens(params) {
    const r0 = await bitrix.call('crm.item.list', { ...params, start: 0 });
    const out = [...(r0.result?.items || [])];
    if (r0.next === undefined || r0.next === null) return out;
    const total = +r0.total || 0;
    if (total > out.length) {
      const inicios = []; for (let s = +r0.next; s < total; s += 50) inicios.push(s);
      const paginas = new Array(inicios.length);
      let i = 0;
      await Promise.all(Array.from({ length: 5 }, async () => { for (;;) { const k = i++; if (k >= inicios.length) return; paginas[k] = (await bitrix.call('crm.item.list', { ...params, start: inicios[k] })).result?.items || []; } }));
      for (const p of paginas) out.push(...p);
      return out;
    }
    let start = r0.next;                                   // sem total confiável: segue sequencial
    for (;;) {
      const r = await bitrix.call('crm.item.list', { ...params, start });
      out.push(...(r.result?.items || []));
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    return out;
  }
  async function cardsAbertos() {
    const { map } = await campos();
    return listarItens({ entityTypeId: F.ETYPE.fila, filter: { stageId: map.etapas.abertas }, select: ['*', 'uf*'] });
  }
  const dadosCard = async (it) => {
    const { map, meta } = await campos();
    const reg = store.card(it.id) || {};
    const parts = String(it.title || '').split(' | ');
    const g = k => (map.fila[k] ? F.decode(meta, map.fila[k], it[map.fila[k]]) : '');
    return {
      id: +it.id, titulo: it.title, empresaId: +it.companyId || reg.empresaId, empresa: reg.empresa || parts[0],
      segmento: g('segmento') || reg.seg || parts[1], cargo: g('cargo') || reg.cargo || parts[2],
      classe: g('classe') || reg.classe || '', responsavel: +it.assignedById || null,
      data: (R.isoDate(map.fila.data ? it[map.fila.data] : null) || R.isoDate(it.closedate)), stageId: it.stageId, criadoEm: it.createdTime || null,
    };
  };

  async function criarCard({ empresa, seg, cargo, classe, responsavel, data }) {
    const { map, meta } = await campos();
    const chave = R.chaveFila(empresa.id, seg, cargo);
    const stage = map.etapas[R.etapaPara(data, hoje())];
    const f = { title: tituloCard(empresa.nome, seg, cargo), companyId: empresa.id, assignedById: responsavel, stageId: stage };
    if (map.fila.segmento) f[map.fila.segmento] = F.encode(meta, map.fila.segmento, seg);
    if (map.fila.cargo) f[map.fila.cargo] = F.encode(meta, map.fila.cargo, cargo);
    if (map.fila.classe) f[map.fila.classe] = F.encode(meta, map.fila.classe, classe);
    f[map.fila.data || 'closedate'] = data;
    const r = (await bitrix.call('crm.item.add', { entityTypeId: F.ETYPE.fila, fields: f })).result?.item;
    store.setChave(chave, +r.id);
    store.setCard(+r.id, { empresaId: empresa.id, empresa: empresa.nome, seg, cargo, classe, chave, equipe: equipeIds(empresa.segs[seg]), ramo: empresa.ramo || '' });
    store.setSnapCard(+r.id, { data, resp: responsavel });
    if (store.config.tarefaAtiva) await criarTarefaCard(+r.id, { empresa: empresa.nome, seg, cargo, responsavel, data });
    store.log('card-criado', `Card ${r.id} criado: ${f.title} · ${R.fmtBR(data)} · resp ${responsavel}`, { card: +r.id });
    return +r.id;
  }

  async function atualizarCard(card, { data, responsavel, classe }, motivo) {
    const { map, meta } = await campos();
    const f = {};
    if (responsavel && responsavel !== card.responsavel) f.assignedById = responsavel;
    if (data && data !== card.data) {
      f[map.fila.data || 'closedate'] = data;
      const st = map.etapas[R.etapaPara(data, hoje())];
      if (st && !map.etapas.fechadas.includes(card.stageId)) f.stageId = st;
    }
    if (classe && classe !== card.classe && map.fila.classe) f[map.fila.classe] = F.encode(meta, map.fila.classe, classe);
    if (!Object.keys(f).length) return false;
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: f });
    store.setSnapCard(card.id, { data: data || card.data, resp: responsavel || card.responsavel });
    const reg = store.card(card.id) || {};
    store.setCard(card.id, { ...reg, classe: classe || reg.classe });
    store.log('card-atualizado', `Card ${card.id} atualizado (${motivo})`, { card: card.id });
    if (f.assignedById) await notificar(f.assignedById, `Visita ${card.titulo} passou para você.`);
    return true;
  }

  // ---------- sincronizar empresa (cria/atualiza os cards, sem duplicar) ----------
  // Operações na mesma empresa nunca rodam ao mesmo tempo (varredura x registro de visita), senão nascem cards em duplicidade.
  const travas = new Map();
  function comTrava(chave, fn) {
    const anterior = travas.get(chave) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(fn);
    travas.set(chave, atual);
    atual.catch(() => {}).finally(() => { if (travas.get(chave) === atual) travas.delete(chave); });
    return atual;
  }
  const sincronizarEmpresa = (id, op) => comTrava(`empresa:${id}`, async () => { const r = await sincronizarEmpresaSemTrava(id, op); if ((r.criados || []).length || (r.atualizados || []).length) envelhece(); return r; });
  async function sincronizarEmpresaSemTrava(id, { forcar = false } = {}) {
    const cfg = store.config;
    const emp = await lerEmpresa(id);
    if (!emp) return { empresa: id, erro: 'Empresa não encontrada' };
    if (cfg.hierarquiaAuto || Object.keys(cfg.alcadas || {}).length) await preencherHierarquia(emp, (await campos()).map).catch(e => store.log('aviso', `Hierarquia: ${e.message}`));
    const res = { empresa: id, criados: [], atualizados: [], pendencias: [] };
    const snapAnt = store.snapEmpresa(id) || {};
    const snapNovo = {};
    const abertos = new Map();
    const grupos = new Map();
    for (const it of await cardsAbertosDaEmpresa(id)) {
      const c = await dadosCard(it);
      const k = R.chaveFila(id, c.segmento, c.cargo);
      (grupos.get(k) || grupos.set(k, []).get(k)).push({ ...c, stageId: it.stageId });
    }
    for (const [k, lista] of grupos) {
      lista.sort((a, b) => (store.chave(k) === b.id) - (store.chave(k) === a.id) || a.id - b.id); // fica o indexado, senão o mais antigo
      abertos.set(k, lista[0]);
      for (const extra of lista.slice(1)) {
        if (!store.card(extra.id)) continue;      // só remove duplicatas criadas pelo próprio app
        try { await bitrix.call('crm.item.delete', { entityTypeId: F.ETYPE.fila, id: extra.id }); store.log('card-duplicado', `Card ${extra.id} removido: duplicava o card ${lista[0].id} (${extra.titulo})`, { card: extra.id }); res.removidos = (res.removidos || 0) + 1; }
        catch (e) { store.log('aviso', `Duplicata ${extra.id} não removida: ${e.message}`); }
      }
    }
    for (const seg of R.SEGMENTOS) {
      const s = emp.segs[seg];
      if (!s.vendedor && !s.supervisor && !s.coordenador && !s.gerente && !s.classe) continue; // segmento não usado
      if (!s.diretor) s.diretor = await diretorDe(s.gerente);
      for (const cargo of R.CARGOS) {
        const resp = s[cargo.toLowerCase()];
        const k = `${seg}|${cargo}`;
        snapNovo[k] = { classe: s.classe, resp, ultima: s.ultima };
        // A chave da fila é Vendedor + Classe. Cargos acima do vendedor só geram visita quando preenchidos, sem acusar pendência.
        if (!resp && cargo !== 'Vendedor') continue;
        const motivo = [];
        if (!resp) motivo.push('sem responsável');
        if (!R.CLASSES.includes(s.classe)) motivo.push('classe não selecionada');
        if (motivo.length) { res.pendencias.push(`${seg} · ${cargo}: ${motivo.join(' e ')}`); continue; }
        const chave = R.chaveFila(id, seg, cargo);
        // Empresa nunca visitada (sem Última Visita): a primeira visita do Vendedor já entra na fila para HOJE.
        // Com Última Visita: Última + intervalo da classe. Cargos acima do Vendedor sempre seguem o intervalo.
        const primeira = cargo === 'Vendedor' && !s.ultima;
        const calc = primeira ? hoje() : R.dataProgramada(cfg, { cargo, classe: s.classe, ultima: s.ultima, hoje: hoje() });
        // Empresa que já tem Última e Próxima Visita: o card do Vendedor NASCE na data da Próxima Visita (sem partir de uma visita nova).
        const dataNova = (cargo === 'Vendedor' && s.ultima && s.proxima) ? s.proxima : calc;
        const existente = abertos.get(chave);
        if (!existente) {
          const idx = store.chave(chave);
          if (idx) { // índice local aponta para card que já não está aberto: libera a chave
            store.setChave(chave, null);
          }
          res.criados.push(await criarCard({ empresa: emp, seg, cargo, classe: s.classe, responsavel: resp, data: dataNova }));
          continue;
        }
        store.setChave(chave, existente.id);
        { const reg = store.card(existente.id) || {}, eq = equipeIds(s); if (JSON.stringify(reg.equipe) !== JSON.stringify(eq) || reg.ramo !== (emp.ramo || '')) store.setCard(existente.id, { ...reg, empresaId: id, empresa: emp.nome, seg, cargo, equipe: eq, ramo: emp.ramo || '' }); }
        if (primeira && existente.data && existente.data > hoje() && existente.stageId !== undefined && !store.historico.some(x => x.card === existente.id && !x.tipo)) {
          if (await atualizarCard(existente, { data: hoje() }, 'primeira visita da empresa vai para hoje')) { res.atualizados.push(existente.id); continue; }
        }
        const ant = snapAnt[k] || {};
        const mudouData = forcar || ant.classe !== s.classe || ant.ultima !== s.ultima;
        const mudouResp = forcar || ant.resp !== resp || existente.responsavel !== resp;
        if (mudouData || mudouResp) {
          const ok = await atualizarCard(existente, { data: mudouData ? calc : null, responsavel: mudouResp ? resp : null, classe: s.classe },
            [mudouData && 'classe/última visita', mudouResp && 'responsável'].filter(Boolean).join(' e '));
          if (ok) res.atualizados.push(existente.id);
        }
      }
      if (cfg.atualizarProxima) await gravarProxima(emp, seg).catch(e => store.log('aviso', `Próxima visita ${emp.nome}/${seg}: ${e.message}`));
    }
    store.setSnapEmpresa(id, snapNovo);
    if (res.pendencias.length) store.log('pendencia', `Empresa ${emp.nome}: ${res.pendencias.join('; ')}`, { empresa: id });
    return res;
  }
  async function cardsAbertosDaEmpresa(id) {
    const { map } = await campos();
    const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.fila, filter: { companyId: id, stageId: map.etapas.abertas }, select: ['*', 'uf*'] });
    return r.result?.items || [];
  }
  async function gravarProxima(emp, seg) {
    const { map } = await campos();
    const campo = map.empresa[seg].proxima;
    if (!campo) return;
    const datas = [];
    for (const it of await cardsAbertosDaEmpresa(emp.id)) { const c = await dadosCard(it); if (c.segmento === seg && c.data) datas.push(c.data); }
    datas.sort();
    if (datas[0] && datas[0] !== emp.segs[seg].proxima) await bitrix.call('crm.company.update', { id: emp.id, fields: { [campo]: datas[0] } });
  }

  async function sincronizarTodas({ desde } = {}) {
    const filter = desde ? { '>DATE_MODIFY': R.brIso(desde) } : {};
    const out = [];
    let start = 0;
    for (;;) {
      const r = await bitrix.call('crm.company.list', { filter, select: ['ID'], start });
      for (const c of r.result || []) {
        try { out.push(await sincronizarEmpresa(+c.ID)); } catch (e) { store.log('erro', `Empresa ${c.ID}: ${e.message}`); out.push({ empresa: +c.ID, erro: e.message }); }
      }
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    return out;
  }

  // ---------- job diário (07h) ----------
  async function jobDiario({ forcar = false } = {}) {
    const h = hoje();
    if (!forcar && store.job('diario') === h) return { pulado: true };
    const { map } = await campos();
    const r = { dia: 0, atrasadas: 0, naoRealizadas: (await encerrarNaoRealizadas()).marcadas };
    const porUsuario = {};
    for (const it of await cardsAbertos()) {
      const c = await dadosCard(it);
      if (!c.data) continue;
      const alvo = map.etapas[R.etapaPara(c.data, h)];
      if (!alvo || alvo === it.stageId) continue;
      await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: c.id, fields: { stageId: alvo } });
      if (alvo === map.etapas.dia) { r.dia++; (porUsuario[c.responsavel] ||= []).push(c.titulo); store.log('job', `Card ${c.id} → Dia da Visita`, { card: c.id }); }
      else if (alvo === map.etapas.atrasada) { r.atrasadas++; store.log('job', `Card ${c.id} → Atrasada`, { card: c.id }); }
    }
    for (const [u, l] of Object.entries(porUsuario)) await notificar(+u, `Visitas de hoje (${l.length}): ${l.slice(0, 5).join(' · ')}${l.length > 5 ? '…' : ''}`);
    store.setJob('diario', h);
    store.log('job', `Job diário: ${r.dia} para Dia da Visita, ${r.atrasadas} para Atrasada`);
    return r;
  }

  // ---------- formulário de registro: todos os campos do SPA 1032 ----------
  const TIPOS = { file: 'arquivo', string: 'texto', char: 'texto', integer: 'numero', double: 'numero', money: 'numero', date: 'data', datetime: 'datahora', boolean: 'sim_nao', enumeration: 'lista', employee: 'usuario', url: 'texto', address: 'texto' };
  async function camposVisita(cardId) {
    const { map, meta } = await campos();
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    const defs = (await bitrix.call('crm.item.fields', { entityTypeId: F.ETYPE.visita })).result?.fields || {};
    const dia = hoje(), ant = R.antecipada(dia, card.data);
    const pre = {}, alcadaKeys = [];
    const v = map.visita;
    if (v.segmento) pre[v.segmento] = F.encode(meta, v.segmento, card.segmento);
    if (v.filaId) pre[v.filaId] = String(card.id);
    if (v.antecipada) pre[v.antecipada] = meta[v.antecipada]?.itens?.length ? F.encode(meta, v.antecipada, ant ? 'Sim' : 'Não') : (ant ? 'Y' : 'N');
    // Alçada da visita = cargo do card (Vendedor, Supervisor, Coordenador, Gerente, Diretor); vem preenchida e travada.
    for (const [k, d] of Object.entries(defs)) {
      if (!k.startsWith('ufCrm') || !/al[cç]ada/i.test(d.title || '')) continue;
      const it = (d.items || []).map(i => ({ id: String(i.ID ?? i.id), nome: String(i.VALUE ?? i.value ?? '') })).find(i => R.norm(i.nome) === R.norm(card.cargo));
      pre[k] = it ? it.id : card.cargo;
      alcadaKeys.push(k);
    }
    // Mapeamento de oportunidades: vem do cadastro da empresa (segmentos em que ela está cadastrada), não do vendedor.
    const emp = await lerEmpresa(card.empresaId).catch(() => null);
    const cadastrados = R.SEGMENTOS.filter(sg => { const x = emp?.segs?.[sg]; return x && (R.CLASSES.includes(x.classe) || x.vendedor || x.supervisor || x.coordenador || x.gerente); });
    for (const [k, d] of Object.entries(defs)) {
      if (!k.startsWith('ufCrm') || !/mapeament/i.test(R.norm(d.title || '')) || !/oportunid/i.test(R.norm(d.title || ''))) continue;
      const itens = (d.items || []).map(i => ({ id: String(i.ID ?? i.id), nome: String(i.VALUE ?? i.value ?? '') }));
      const ids = itens.filter(i => cadastrados.some(sg => R.norm(sg) === R.norm(i.nome))).map(i => i.id);
      const doCard = itens.find(i => R.norm(i.nome) === R.norm(card.segmento));
      pre[k] = d.isMultiple ? ids : (doCard ? doCard.id : (ids[0] || ''));
      alcadaKeys.push(k);
    }
    const travados = new Set([v.segmento, v.filaId, v.antecipada, ...alcadaKeys].filter(Boolean));
    const lista = [];
    const ocultos = new Set(Duplicados.agrupar(defs, Object.values(map.visita)).flatMap(g => g.outros)); // duplicados: mostra só o campo padrão
    const temArquivo = Object.values(defs).some(x => x.type === 'file');
    if (temArquivo) for (const [k, d] of Object.entries(defs)) if (d.type !== 'file' && /^(anexos?|arquivos?)$/.test(R.norm(d.title || ''))) ocultos.add(k); // campo de texto não guarda arquivo
    for (const [k, d] of Object.entries(defs)) {
      if (!k.startsWith('ufCrm') || ocultos.has(k)) continue;
      const tipo = TIPOS[d.type];
      if (!tipo) continue; // arquivo, vínculo com CRM etc. não cabem no formulário enxuto
      const itens = (d.items || []).map(i => ({ id: String(i.ID ?? i.id), nome: String(i.VALUE ?? i.value ?? '') }));
      lista.push({
        key: k, titulo: d.title || d.formLabel || k, tipo, obrigatorio: !!d.isRequired || k === v.resultado, multiplo: !!d.isMultiple, itens,
        valor: pre[k] ?? (k === v.dataHora ? new Date().toISOString() : ''), travado: travados.has(k),
        destaque: k === v.resultado,
      });
    }
    lista.sort((a, b) => (b.destaque - a.destaque) || (b.obrigatorio - a.obrigatorio));
    return { card: { id: card.id, empresa: card.empresa, segmento: card.segmento, cargo: card.cargo, data: card.data, antecipada: ant }, campos: lista, dataHoraKey: v.dataHora || null, resultadoKey: v.resultado || null };
  }

  // ---------- registrar visita ----------
  // Depois de uma visita (registrada pelo app ou direto no Bitrix): finaliza o card, cria o próximo e atualiza o cadastro
  // da empresa (Última e Próxima Visita do segmento) — desde que o segmento tenha Vendedor e Classe preenchidos.
  const posVisita = args => comTrava(`empresa:${args.card.empresaId}`, () => posVisitaSemTrava(args));
  async function posVisitaSemTrava({ card, emp, dia, uid, visita, agora }) {
    invalida();
    const { map } = await campos();
    const passos = [];
    if (!map.etapas.finalizado) throw erro('Não encontrei a etapa final (Finalizado/Encerrado) do kanban da Fila. Confira as etapas em Configurações.', 500);
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: { stageId: map.etapas.finalizado } });
    store.setChave(R.chaveFila(card.empresaId, card.segmento, card.cargo), null);
    passos.push('card finalizado');
    const s = emp?.segs?.[card.segmento] || {};
    const classe = s.classe || card.classe;
    let proximo = null;
    const novaData = R.dataProgramada(store.config, { cargo: card.cargo, classe, ultima: dia, hoje: hoje() });
    if (novaData && emp) {
      proximo = await criarCard({ empresa: emp, seg: card.segmento, cargo: card.cargo, classe, responsavel: s[card.cargo.toLowerCase()] || card.responsavel || uid, data: novaData });
      passos.push(`próximo card ${proximo} (${R.fmtBR(novaData)})`);
    }
    if (emp && s.vendedor && R.CLASSES.includes(s.classe)) {
      const c = map.empresa[card.segmento] || {}, fields = {};
      if (c.ultima) fields[c.ultima] = dia;
      if (c.proxima) {
        const datas = [];
        for (const it of await cardsAbertosDaEmpresa(emp.id)) { const x = await dadosCard(it); if (x.segmento === card.segmento && x.data) datas.push(x.data); }
        datas.sort();
        if (datas[0]) fields[c.proxima] = datas[0];
      }
      if (Object.keys(fields).length) {
        await bitrix.call('crm.company.update', { id: card.empresaId, fields });
        passos.push(`cadastro da empresa atualizado (${card.segmento}: última ${R.fmtBR(dia)}${fields[c.proxima] ? `, próxima ${R.fmtBR(fields[c.proxima])}` : ''})`);
      }
    } else store.log('aviso', `Cadastro da empresa ${card.empresa} (${card.segmento}) não atualizado: falta Vendedor ou Classe`, { empresa: card.empresaId });
    // o app gravou "última visita" na empresa: atualiza o snapshot para não recalcular os outros cargos
    const snap = store.snapEmpresa(card.empresaId) || {};
    for (const k of Object.keys(snap)) if (k.startsWith(card.segmento + '|')) snap[k].ultima = dia;
    store.setSnapEmpresa(card.empresaId, snap);
    const fechadas = await encerrarTarefas(card.id, 'Visita registrada.');
    if (fechadas) passos.push(`${fechadas} tarefa(s) encerrada(s)`);
    return { proximo, novaData, passos };
  }

  // Anexos vindos da tela: [{ nome, base64 }] -> formato de arquivo do Bitrix ({ fileData: [nome, base64] }). Limites: 10 MB por arquivo.
  const MAX_ANEXO = 10 * 1024 * 1024;
  function arquivosParaBitrix(val, titulo) {
    const lista = (Array.isArray(val) ? val : [val]).filter(a => a && a.base64);
    return lista.map(a => {
      const nome = String(a.nome || 'anexo').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'anexo';
      const b64 = String(a.base64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw erro(`O arquivo "${nome}" (${titulo}) não está num formato válido.`, 422);
      if (b64.length * 0.75 > MAX_ANEXO) throw erro(`O arquivo "${nome}" passa de 10 MB. Anexe um arquivo menor.`, 413);
      return { fileData: [nome, b64] };
    });
  }
  async function registrarVisita(cardId, { uid, resultado, acompanhamento, dataHora, campos: extra = {} }) {
    const { map, meta } = await campos();
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    if (!card.aberto) throw erro('Esta visita já foi finalizada.', 409);
    if (!uid) throw erro('Usuário não identificado.', 401);
    const form = await camposVisita(cardId);
    const dados = { ...extra };
    const dhKey = map.visita.dataHora;
    if (dhKey && dados[dhKey] && !dataHora) dataHora = dados[dhKey];
    if (resultado && map.visita.resultado && !dados[map.visita.resultado]) dados[map.visita.resultado] = resultado;
    if (acompanhamento && map.visita.acompanhamento && !dados[map.visita.acompanhamento]) dados[map.visita.acompanhamento] = acompanhamento;
    const vazio = x => x === undefined || x === null || (Array.isArray(x) ? !x.length : String(typeof x === 'object' ? (x.base64 || '') : x).trim() === '');
    const faltam = form.campos.filter(c => c.obrigatorio && !c.travado && c.key !== dhKey && vazio(dados[c.key])).map(c => c.titulo);
    if (!map.visita.resultado && String(resultado || '').trim().length < 3 && !form.campos.some(c => c.obrigatorio)) faltam.push('Resultado / observações');
    if (faltam.length) throw erro(`Preencha: ${faltam.join(', ')}.`, 422);
    const agora = clock();
    const quando = dataHora ? new Date(dataHora) : agora;
    if (isNaN(quando)) throw erro('Data/hora inválida.');
    const dia = R.todayBR(quando);
    const ant = R.antecipada(dia, card.data);
    const emp = await lerEmpresa(card.empresaId);
    const f = {
      title: `${card.empresa} - ${R.fmtBR(dia)}`, companyId: card.empresaId, assignedById: uid,
      [map.visita.dataHora || 'begindate']: quando.toISOString(),
    };
    const permitidos = new Map(form.campos.filter(c => !c.travado && c.key !== dhKey).map(c => [c.key, c]));
    for (const [k, val] of Object.entries(dados)) {
      const c = permitidos.get(k);
      if (!c || vazio(val)) continue;
      if (c.tipo === 'arquivo') { const arq = arquivosParaBitrix(val, c.titulo); if (arq.length) f[k] = c.multiplo ? arq : arq[0]; continue; }
      f[k] = c.tipo === 'sim_nao' ? (val === true || val === 'Y' || val === 'true' ? 'Y' : 'N') : c.tipo === 'numero' ? Number(val) : val;
    }
    for (const c of form.campos) if (c.travado && !vazio(c.valor)) f[c.key] = c.valor; // campos automáticos (ex.: Alçada)
    const set = (k, v) => { if (map.visita[k]) f[map.visita[k]] = v; };
    set('segmento', F.encode(meta, map.visita.segmento, card.segmento));
    set('filaId', String(card.id));
    set('antecipada', map.visita.antecipada && meta[map.visita.antecipada]?.itens?.length ? F.encode(meta, map.visita.antecipada, ant ? 'Sim' : 'Não') : (ant ? 'Y' : 'N'));
    const passos = [];
    const v = (await bitrix.call('crm.item.add', { entityTypeId: F.ETYPE.visita, fields: f })).result?.item;
    store.setSnapVisita(+v.id, { dt: quando.toISOString(), campo: map.visita.dataHora || 'begindate' });
    passos.push(`visita ${v.id} criada`);
    if (String(resultado || '').trim() && !map.visita.resultado) {
      await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: +v.id, ENTITY_TYPE: DYN(F.ETYPE.visita), COMMENT: `Resultado: ${String(resultado).trim()}${acompanhamento ? `\nAcompanhamento: ${acompanhamento}` : ''}` } }).catch(e => store.log('aviso', `Resultado não gravado como comentário: ${e.message}`));
    }
    const pos = await posVisita({ card, emp, dia, uid, visita: v, agora });
    passos.push(...pos.passos);
    const proximo = pos.proximo, novaData = pos.novaData;
    const nAnexos = Object.entries(f).filter(([k]) => permitidos.get(k)?.tipo === 'arquivo').reduce((a, [, x]) => a + (Array.isArray(x) ? x.length : 1), 0);
    if (nAnexos) passos.push(`${nAnexos} anexo(s) salvo(s) no registro`);
    store.log('visita', `Visita ${v.id} registrada por ${uid} no card ${card.id} (antecipada: ${ant ? 'sim' : 'não'}): ${passos.join(', ')}`, { card: card.id, visita: +v.id });
    return { visita: +v.id, antecipada: ant, proximoCard: proximo, proximaData: novaData, passos };
  }
  // ---------- reprogramar ----------
  async function reprogramar(cardId, { uid, nova, motivo }) {
    invalida();
    const { map } = await campos();
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    if (!card.aberto) throw erro('Visita já finalizada não pode ser alterada.', 409);
    if (!uid) throw erro('Usuário não identificado.', 401);
    if (!card.data) throw erro('O card não tem data programada.');
    const msg = R.validarReprogramacao({ atual: card.data, nova, motivo, hoje: hoje(), mes: R.mesLimite(card.data, card.criadoEm ? R.todayBR(new Date(card.criadoEm)) : null) });
    if (msg) throw erro(msg, 422);
    const stage = map.etapas[R.etapaPara(nova, hoje())];
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: { [map.fila.data || 'closedate']: nova, ...(stage ? { stageId: stage } : {}) } });
    store.setSnapCard(card.id, { data: nova, resp: card.responsavel });
    const tarefas = await moverPrazoTarefas(card.id, nova);
    const nome = await nomeUsuario(uid);
    const agora = clock().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    store.addHistorico({ card: card.id, empresaId: card.empresaId, empresa: card.empresa, segmento: card.segmento, cargo: card.cargo, anterior: card.data, nova, motivo: motivo.trim(), autor: uid, autorNome: nome, responsavel: card.responsavel });
    try {
      await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: card.id, ENTITY_TYPE: DYN(F.ETYPE.fila),
        COMMENT: `Visita alterada em ${agora} por ${nome}.\nData anterior: ${R.fmtBR(card.data)}\nNova data: ${R.fmtBR(nova)}\nMotivo: ${motivo.trim()}` } });
    } catch (e) { store.log('aviso', `Comentário na linha do tempo do card ${card.id} falhou: ${e.message}`); }
    store.log('reprogramacao', `Card ${card.id}: ${R.fmtBR(card.data)} → ${R.fmtBR(nova)} por ${uid}: ${motivo.trim()}`, { card: card.id });
    return { ok: true, data: nova, tarefasAtualizadas: tarefas };
  }

  const nomes = new Map();
  async function nomeUsuario(id) {
    if (!id) return '';
    if (!nomes.has(id)) {
      try { const u = ((await bitrix.call('user.get', { ID: id })).result || [])[0]; nomes.set(id, u ? `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || `#${id}` : `#${id}`); }
      catch { return `#${id}`; }
    }
    return nomes.get(id);
  }

  // ---------- guardas (edição direta é revertida) ----------
  // Visita que não aconteceu até o fim do mês dela: vira "Não realizada" (sem poder alterar a data) e a próxima do ciclo é gerada.
  async function encerrarNaoRealizadas() {
    const { map } = await campos();
    if (!map.etapas.naoRealizada) return { marcadas: 0, semEtapa: true };
    const h = hoje(), mesHoje = h.slice(0, 7);
    let marcadas = 0;
    for (const it of await cardsAbertos()) {
      const c = await dadosCard(it);
      const lim = R.mesLimite(c.data, it.createdTime ? R.todayBR(new Date(it.createdTime)) : null);
      if (!lim || lim >= mesHoje) continue;
      await comTrava(`empresa:${c.empresaId}`, async () => {
        await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: c.id, fields: { stageId: map.etapas.naoRealizada } });
        const reg = store.card(c.id);
        const chave = R.chaveFila(c.empresaId, c.segmento, c.cargo);
        if (store.chave(chave) === c.id) store.setChave(chave, null);
        store.log('nao-realizada', `Card ${c.id} marcado como não realizada (${c.titulo}, programada ${R.fmtBR(c.data)})`, { card: c.id });
        try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: c.id, ENTITY_TYPE: DYN(F.ETYPE.fila), COMMENT: `Visita não realizada no mês (${lim.split('-').reverse().join('/')}). A data não pode mais ser alterada.` } }); } catch { /* sem comentário */ }
        await encerrarTarefas(c.id, 'Visita não realizada no mês.');
        await notificar(c.responsavel, `A visita "${c.titulo}" não foi realizada no mês e foi marcada como não realizada.`);
        const aberto = (await cardsAbertosDaEmpresa(c.empresaId)).some(x => String(x.title).split(' | ').slice(1).join('|') === String(it.title).split(' | ').slice(1).join('|'));
        const emp = await lerEmpresa(c.empresaId);
        const sg = emp?.segs?.[c.segmento] || {};
        const classe = sg.classe || c.classe;
        const n = R.intervalo(store.config, c.cargo, classe);
        if (!aberto && emp && n) {
          const nova = [R.addDays(c.data, n), R.addDays(h, 1)].sort().pop();
          const novoId = await criarCard({ empresa: emp, seg: c.segmento, cargo: c.cargo, classe, responsavel: sg[c.cargo.toLowerCase()] || c.responsavel, data: nova });
          store.log('card-criado', `Próximo card ${novoId} gerado após não realizada: ${R.fmtBR(nova)}`, { card: novoId });
          if (store.config.atualizarProxima) await gravarProxima(emp, c.segmento).catch(() => {});
        }
      });
      marcadas++;
    }
    return { marcadas };
  }
  // Rede de segurança: acha empresas com Vendedor preenchido que ainda não têm card aberto no segmento (edição perdida, carga em massa)
  // e gera a fila delas. Não depende da data de alteração do cadastro. Reprocessa cada empresa no máximo a cada 6 h.
  async function reconciliarCadastros({ limite = 60 } = {}) {
    const { map } = await campos();
    const doSeg = {};                                  // segmento -> Set(id de empresa com Vendedor)
    for (const seg of R.SEGMENTOS) {
      const set = (doSeg[seg] = new Set());
      const m = map.empresa[seg] || {};
      for (const key of [m.vendedor, ...(((map.alt || {})[seg] || {}).vendedor || [])].filter(Boolean)) {
        let start = 0;
        for (;;) {
          const r = await bitrix.call('crm.company.list', { filter: { ['!' + key]: '' }, select: ['ID'], start });
          for (const c of r.result || []) set.add(+c.ID);
          if (r.next === undefined || r.next === null) break;
          start = r.next;
        }
      }
    }
    const comCard = new Set();                         // "empresa|segmento" com card aberto
    for (const it of await cardsAbertos()) { const c = await dadosCard(it); comCard.add(`${c.empresaId}|${R.norm(c.segmento)}`); }
    const agora = Date.now(), vistos = store.job('recheck') || {};
    const faltam = new Set();
    for (const seg of R.SEGMENTOS) for (const id of doSeg[seg]) if (!comCard.has(`${id}|${R.norm(seg)}`) && agora - Date.parse(vistos[id] || 0) > 6 * 3600e3) faltam.add(id);
    const res = { candidatas: faltam.size, processadas: 0, criados: 0 };
    for (const id of [...faltam].slice(0, limite)) {
      try { const r = await sincronizarEmpresa(id); res.criados += (r.criados || []).length; } catch (e) { store.log('erro', `Reconciliação da empresa ${id}: ${e.message}`); }
      vistos[id] = new Date().toISOString(); res.processadas++;
    }
    store.setJob('recheck', vistos);
    if (res.criados) store.log('reconciliacao', `Reconciliação de cadastros: ${res.criados} card(s) criado(s) em ${res.processadas} empresa(s)`);
    return res;
  }
  // Cards finalizados antes de a etapa final ser "Encerrado" ficaram na etapa de sucesso do Bitrix: move para a etapa final.
  async function migrarFinalizadas() {
    const { map } = await campos();
    const outros = (map.etapas.concluidas || []).filter(x => x !== map.etapas.finalizado);
    if (!map.etapas.finalizado || !outros.length) return { movidos: 0 };
    let n = 0;
    const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.fila, filter: { stageId: outros }, select: ['id'] });
    for (const it of r.result?.items || []) { await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: it.id, fields: { stageId: map.etapas.finalizado } }); store.log('card-finalizado', `Card ${it.id} movido para a etapa final`, { card: +it.id }); n++; }
    return { movidos: n };
  }
  // Qualquer card ainda aberto que tenha uma visita registrada (ID da Fila) deve estar finalizado.
  async function reconciliarVisitas() {
    const { map } = await campos();
    if (!map.visita.filaId || !map.etapas.finalizado) return { finalizados: 0 };
    const feitos = new Set();
    let start = 0;
    for (;;) {
      const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.visita, select: ['id', map.visita.filaId], start });
      for (const it of r.result?.items || []) { const k = +it[map.visita.filaId]; if (k) feitos.add(k); }
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    let n = 0;
    for (const it of await cardsAbertos()) {
      if (!feitos.has(+it.id)) continue;
      await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: it.id, fields: { stageId: map.etapas.finalizado } });
      const reg = store.card(it.id);
      if (reg && store.chave(reg.chave) === +it.id) store.setChave(reg.chave, null);
      store.log('card-finalizado', `Card ${it.id} finalizado: já tem visita registrada`, { card: +it.id });
      n++;
    }
    return { finalizados: n };
  }
  async function fecharVisitaExterna(it, campo) {
    const { map } = await campos();
    const card = await lerCard(+it[map.visita.filaId]);
    if (!card || !card.aberto) return;
    const dia = R.todayBR(new Date(it[campo] || it.createdTime));
    const emp = await lerEmpresa(card.empresaId);
    const pos = await posVisita({ card, emp, dia, uid: +it.assignedById, visita: { id: it.id }, agora: clock() });
    store.log('visita', `Visita ${it.id} criada direto no Bitrix (card ${card.id}): ${pos.passos.join(', ')}`, { card: card.id, visita: +it.id });
  }
  async function guardarVisitas() {
    const { map } = await campos();
    const campo = map.visita.dataHora || 'begindate';
    const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.visita, order: { id: 'desc' }, select: ['id', 'assignedById', 'title', 'createdTime', 'companyId', campo, ...(map.visita.filaId ? [map.visita.filaId] : [])], filter: store.lastSweep ? { '>updatedTime': R.brIso(store.lastSweep) } : {} });
    let revertidos = 0;
    if (!store.job('inicioVisitasExternas')) store.setJob('inicioVisitasExternas', new Date().toISOString());
    for (const it of r.result?.items || []) {
      const atual = it[campo], snap = store.snapVisita(it.id);
      if (!snap) {
        store.setSnapVisita(+it.id, { dt: atual, campo });
        // visita criada direto no Bitrix (depois da ativação deste recurso): fecha o card e atualiza o cadastro da empresa
        if (it.createdTime && it.createdTime >= store.job('inicioVisitasExternas') && map.visita.filaId && it[map.visita.filaId]) await fecharVisitaExterna(it, campo).catch(e => store.log('erro', `Visita ${it.id} criada no Bitrix: ${e.message}`));
        continue;
      }
      if (sameInstant(atual, snap.dt)) continue;
      await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.visita, id: it.id, fields: { [campo]: snap.dt } });
      store.addBloqueio({ tipo: 'visita-data', visita: +it.id, tentou: atual, original: snap.dt, responsavel: +it.assignedById });
      store.log('bloqueio', `Data da visita ${it.id} revertida (tentativa: ${atual}, original: ${snap.dt})`, { visita: +it.id });
      await notificar(+it.assignedById, `A data do registro de visita "${it.title}" não pode ser alterada e foi restaurada. Para corrigir, peça a um administrador.`);
      revertidos++;
    }
    return revertidos;
  }
  const sameInstant = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y; };

  async function guardarCards(abertos) {
    const { map } = await campos();
    let rev = 0;
    for (const it of abertos) {
      const snap = store.snapCard(it.id);
      const atual = (R.isoDate(map.fila.data ? it[map.fila.data] : null) || R.isoDate(it.closedate));
      if (!snap) { store.setSnapCard(+it.id, { data: atual, resp: +it.assignedById }); continue; }
      if (atual === snap.data) continue;
      await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: it.id, fields: { [map.fila.data || 'closedate']: snap.data } });
      store.addBloqueio({ tipo: 'card-data', card: +it.id, tentou: atual, original: snap.data, responsavel: +it.assignedById });
      store.log('bloqueio', `Data programada do card ${it.id} revertida (tentativa: ${atual}, original: ${snap.data}). Use "Reprogramar visita".`, { card: +it.id });
      await notificar(+it.assignedById, `A data programada de "${it.title}" só pode ser alterada pelo botão "Alterar visita". A data foi restaurada.`);
      rev++;
    }
    return rev;
  }

  async function corrigirVisita(id, { uid, dataHora, motivo }) {
    if (!isAdmin(uid)) throw erro('Apenas administradores podem corrigir registros de visita.', 403);
    if (String(motivo || '').trim().length < 3) throw erro('Informe o motivo da correção.');
    const novo = new Date(dataHora);
    if (isNaN(novo)) throw erro('Data/hora inválida.');
    const { map } = await campos();
    const campo = map.visita.dataHora || 'begindate';
    const snap = store.snapVisita(id);
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.visita, id, fields: { [campo]: novo.toISOString() } });
    store.setSnapVisita(+id, { dt: novo.toISOString(), campo });
    store.addHistorico({ tipo: 'correcao-visita', visita: +id, anterior: snap?.dt, nova: novo.toISOString(), motivo: motivo.trim(), autor: uid, autorNome: await nomeUsuario(uid) });
    store.log('correcao', `Visita ${id} corrigida por ${uid}: ${motivo.trim()}`, { visita: +id });
    return { ok: true };
  }
  const isAdmin = uid => { const a = store.config.admins || []; return a.map(Number).includes(+uid); };

  // ---------- varredura periódica (alternativa aos eventos; idempotente) ----------
  let rodando = false;
  // Deixa as listas prontas na memória (a primeira abertura da tela não espera o Bitrix). Roda a cada varredura e ao iniciar.
  async function aquecer() {
    if (!baseDash || Date.now() - baseEm > 300e3) baseDashboard().catch(() => {});
    try { const { map } = await campos(); await memo('cards-abertos', 0, () => cardsAbertos()); await memo('cards-fechados', 0, () => listarItens({ entityTypeId: F.ETYPE.fila, filter: { stageId: [...(map.etapas.concluidas || []), map.etapas.naoRealizada].filter(Boolean), '>updatedTime': R.brIso(new Date(Date.now() - 120 * 864e5)) }, select: ['*', 'uf*'] })); } catch { /* o próximo ciclo tenta de novo */ }
  }
  async function varrer() {
    if (!store.config.ativo) return { pausado: true };
    if (rodando) return { pulado: true };
    rodando = true;
    const inicio = new Date(Date.now() - 5 * 60e3).toISOString();
    try {
      await campos();
      const guardas = { visitas: await guardarVisitas(), cards: await guardarCards(await cardsAbertos()) };
      if (!store.job('cadastros') || Date.now() - Date.parse(store.job('cadastros')) > 3600e3) { guardas.cadastros = await reconciliarCadastros(); store.setJob('cadastros', new Date().toISOString()); }
      if (!store.job('migradoEncerrado')) { guardas.migradas = (await migrarFinalizadas()).movidos; store.setJob('migradoEncerrado', new Date().toISOString()); }
      if (!store.job('reconciliado') || Date.now() - Date.parse(store.job('reconciliado')) > 3600e3) { guardas.reconciliados = (await reconciliarVisitas()).finalizados; store.setJob('reconciliado', new Date().toISOString()); }
      // primeira varredura depois de ativar: não processa as 11 mil empresas de uma vez, só as alteradas daqui em diante
      const emp = store.lastSweep ? await sincronizarTodas({ desde: store.lastSweep }) : [];
      let job = null;
      if (R.hourBR(clock()) >= store.config.horaJob) job = await jobDiario();
      store.setLastSweep(inicio);
      await aquecer();
      const resumo = emp.filter(e => (e.criados && e.criados.length) || (e.atualizados && e.atualizados.length) || e.erro).map(e => ({ empresa: e.empresa, criados: (e.criados || []).length, atualizados: (e.atualizados || []).length, pendencias: (e.pendencias || []).slice(0, 4), erro: e.erro }));
      return { guardas, empresas: emp.length, job, resumo };
    } finally { rodando = false; }
  }

  // Permissões do Bitrix prevalecem: se o usuário não pode ver o registro no Bitrix, o app também não mostra.
  const respeitaBitrix = () => store.config.respeitarBitrix !== false;
  async function permitidosBitrix(bearer, etype) {
    if (!acesso || !bearer || !respeitaBitrix()) return null;
    return acesso.ids(bearer, etype);
  }
  async function podeVerCard(bearer, cardId) {
    const set = await permitidosBitrix(bearer, F.ETYPE.fila);
    return !set || set.has(+cardId);
  }

  // ---------- acesso: quem configura e quem vê o dashboard ----------
  // Sem nenhuma lista configurada o app fica aberto (primeiro uso). Depois, só quem está nas listas (administradores sempre entram).
  const ids = l => (l || []).map(Number).filter(Boolean);
  function podeConfigurar(uid) {
    const c = store.config, lista = [...ids(c.acessoConfig), ...ids(c.admins)];
    return !lista.length || lista.includes(+uid);
  }
  function podeDashboard(uid) {
    const c = store.config, lista = ids(c.acessoDashboard);
    return !lista.length || lista.includes(+uid) || ids(c.admins).includes(+uid) || ids(c.acessoConfig).includes(+uid);
  }
  const acessoRestrito = () => !!(ids(store.config.acessoConfig).length || ids(store.config.admins).length || ids(store.config.acessoDashboard).length);

  // ---------- consultas para a interface ----------
  // Quem enxerga tudo: administradores, quem está em "verTudo" e o chefe do departamento raiz (a diretoria).
  async function enxergaTudo(uid) {
    const c = store.config;
    if ((c.admins || []).map(Number).includes(+uid) || (c.verTudo || []).map(Number).includes(+uid)) return true;
    try { const deps = (await bitrix.call('department.get', {})).result || []; return deps.some(d => !+d.PARENT && +d.UF_HEAD === +uid); } catch { return false; }
  }
  // escopo 'auto': vendedor vê os seus; supervisor/coordenador/gerente veem a equipe (quem aparece acima do vendedor na empresa
  // ou chefia o departamento do responsável); diretoria/administração vê tudo.
  async function listarVisitas({ uid, escopo = 'auto', bearer = null, encerradas = false }) {
    const { map } = await campos();
    const permitidos = await permitidosBitrix(bearer, F.ETYPE.fila);
    const abertosL = (await cardsAbertos()).filter(it => !permitidos || permitidos.has(+it.id));
    let fechadosL = [];
    if (encerradas) {
      const desde = R.brIso(new Date(Date.now() - 120 * 864e5));
      const etapas = [...(map.etapas.concluidas || []), map.etapas.naoRealizada].filter(Boolean);
      let start = 0;
      for (;;) {
        const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.fila, filter: { stageId: etapas, '>updatedTime': desde }, select: ['*', 'uf*'], start });
        fechadosL.push(...(r.result?.items || []));
        if (r.next === undefined || r.next === null) break;
        start = r.next;
      }
      fechadosL = fechadosL.filter(it => !permitidos || permitidos.has(+it.id));
    }
    const itens = [...abertosL, ...fechadosL];
    const fechadoSet = new Set(fechadosL.map(i => i.id));
    const todos = escopo === 'todas' || (escopo === 'auto' && await enxergaTudo(uid));
    const time = escopo === 'auto' && !todos ? await equipeDe(uid) : new Set([+uid]);
    const out = [];
    const tipos = new Map(), empresas = new Map();
    let base = null; try { base = new URL(bitrix.base).origin; } catch { /* sem webhook */ }
    for (const it of itens) {
      const c = await dadosCard(it);
      const reg = store.card(it.id) || {};
      let emp = empresas.get(c.empresaId);
      const propria = +c.responsavel === +uid;
      if (!todos && !propria && escopo === 'minhas') continue;
      if (!todos && !propria && escopo === 'auto' && !time.has(+c.responsavel)) {
        // fora da equipe por departamento: só vê se aparece nos cargos da empresa (índice local; cai na empresa se ainda não houver)
        let eq = reg.equipe;
        if (!eq) { if (emp === undefined) { emp = await lerEmpresa(c.empresaId).catch(() => null); empresas.set(c.empresaId, emp); } eq = equipeIds(emp?.segs?.[c.segmento]); }
        if (!Object.values(eq || {}).map(Number).includes(+uid)) continue;
      }
      if (emp === undefined) { emp = await lerEmpresa(c.empresaId).catch(() => null); empresas.set(c.empresaId, emp); }
      const sg = emp?.segs?.[c.segmento] || {};
      if (tipos.get(c.empresaId) === undefined) tipos.set(c.empresaId, await tipoDaEmpresa(emp));
      const equipe = {};
      for (const k of ['vendedor', 'supervisor', 'coordenador', 'gerente', 'diretor']) if (sg[k]) equipe[k] = await nomeUsuario(sg[k]);
      const fechado = fechadoSet.has(it.id);
      const situacao = fechado ? (it.stageId === map.etapas.naoRealizada ? 'naorealizada' : 'finalizado') : R.etapaPara(c.data, hoje());
      out.push({ ...c, tipoEmpresa: tipos.get(c.empresaId) || '', responsavelNome: await nomeUsuario(c.responsavel), classe: c.classe || reg.classe || '',
        situacao, encerradoEm: fechado && it.updatedTime ? R.todayBR(new Date(it.updatedTime)) : null, dias: !fechado && c.data ? R.dayDiff(hoje(), c.data) : null,
        ultima: sg.ultima || null, diasDesdeUltima: sg.ultima ? R.dayDiff(sg.ultima, hoje()) : null, ciclo: R.intervalo(store.config, c.cargo, c.classe || reg.classe),
        altMin: R.addDays(hoje(), 1), altMax: R.ultimoDiaDoMes(R.mesLimite(c.data, it.createdTime ? R.todayBR(new Date(it.createdTime)) : null) || hoje().slice(0, 7)),
        equipe, reprogramacoes: store.historico.filter(h => h.card === c.id && !h.tipo).length, urlEmpresa: base && c.empresaId ? `${base}/crm/company/details/${c.empresaId}/` : null, urlCard: base ? `${base}/crm/type/${F.ETYPE.fila}/details/${c.id}/` : null });
    }
    out.sort((a, b) => (a.data || '9').localeCompare(b.data || '9'));
    return { hoje: hoje(), bitrix: !!permitidos, visao: todos ? 'tudo' : (time.size > 1 || out.some(v => +v.responsavel !== +uid) ? 'equipe' : 'minhas'), visitas: out };
  }
  // ---------- listagem paginada no servidor ----------
  // Filtra/ordena/pagina com os dados baratos do card e do índice local; só as linhas da página buscam empresa e nomes.
  const RANK = { atrasada: 0, dia: 1, aguardando: 2, finalizado: 3, naorealizada: 4 };
  async function listarVisitasPag(p) {
    const { uid, bearer = null, escopo = 'auto', q = '', status = 'abertas', per = '', de = '', ate = '', seg = '', tipo = '', classe = '', resp = '', vend = '', ramo = '', ord = 'data', dir = 1 } = p;
    const size = Math.max(1, Math.min(+p.size || 20, 5000));
    const { map } = await campos();
    const permitidos = await permitidosBitrix(bearer, F.ETYPE.fila);
    const todos = escopo === 'todas' || (escopo === 'auto' && await enxergaTudo(uid));
    const time = escopo === 'auto' && !todos ? await memo(`equipe:${uid}`, 60e3, () => equipeDe(uid)) : new Set([+uid]);
    const abertosL = await memoSWR('cards-abertos', 15e3, () => cardsAbertos());
    const fechadosL = await memoSWR('cards-fechados', 60e3, () => {
      const desde = R.brIso(new Date(Date.now() - 120 * 864e5));
      const etapas = [...(map.etapas.concluidas || []), map.etapas.naoRealizada].filter(Boolean);
      return listarItens({ entityTypeId: F.ETYPE.fila, filter: { stageId: etapas, '>updatedTime': desde }, select: ['*', 'uf*'] });
    });
    const h = hoje();
    // 1) linhas leves + visibilidade
    const leves = [];
    // índice de equipe (campos da empresa) por card: o que vale é quem está no cadastro da empresa, não o responsável do Bitrix
    const semEquipe = [...new Set([...abertosL, ...fechadosL].filter(it => !(store.card(it.id) || {}).equipe && it.companyId).map(it => +it.companyId))];
    if (semEquipe.length) await Promise.all(semEquipe.slice(0, 40).map(id => empresaCurta(id)));
    for (const [lista, fechado] of [[abertosL, false], [fechadosL, true]]) for (const it of lista) {
      if (permitidos && !permitidos.has(+it.id)) continue;
      const c = await dadosCard(it), reg = store.card(it.id) || {};
      let eq = reg.equipe;
      if (!eq) { const e = await empresaCurta(c.empresaId); eq = e ? equipeIds(e.segs?.[c.segmento]) : null; }
      const doCampo = eq && eq[String(c.cargo || '').toLowerCase()];
      if (doCampo) c.responsavel = +doCampo;
      const propria = +c.responsavel === +uid;
      if (!todos && !propria) {
        if (escopo === 'minhas') continue;
        if (escopo === 'auto' && !time.has(+c.responsavel) && !Object.values(eq || {}).map(Number).includes(+uid)) continue;
      }
      const situacao = fechado ? (it.stageId === map.etapas.naoRealizada ? 'naorealizada' : 'finalizado') : R.etapaPara(c.data, h);
      leves.push({ it, c, reg, fechado, situacao, vendId: (eq || {}).vendedor || null });
    }
    // 2) contadores e opções (sobre tudo o que o usuário pode ver)
    const counts = { abertas: 0, atrasada: 0, dia: 0, aguardando: 0, finalizado: 0, naorealizada: 0 };
    for (const l of leves) { counts[l.situacao]++; if (!l.fechado) counts.abertas++; }
    const nomeDe = id => memo(`nome:${id}`, 600e3, () => nomeUsuario(id));
    const vendIds = [...new Set(leves.map(l => l.vendId).filter(Boolean))], respIds = [...new Set(leves.map(l => +l.c.responsavel).filter(Boolean))];
    const opcoes = {
      segmentos: [...new Set(leves.map(l => l.c.segmento).filter(Boolean))].sort(),
      ramos: (await listaRamos()).map(r => ({ id: r.id, nome: r.nome })).sort((a, b) => a.nome.localeCompare(b.nome)),
      vendedores: (await Promise.all(vendIds.map(async id => ({ id, nome: await nomeDe(id) })))).sort((a, b) => a.nome.localeCompare(b.nome)),
      responsaveis: (await Promise.all(respIds.map(async id => ({ id, nome: await nomeDe(id) })))).sort((a, b) => a.nome.localeCompare(b.nome)),
    };
    // 3) filtros
    const faixa = (() => {
      if (per === 'hoje') return [h, h];
      if (per === 'semana') { const dow = (new Date(h + 'T12:00:00Z').getUTCDay() + 6) % 7; return [R.addDays(h, -dow), R.addDays(h, 6 - dow)]; }
      if (per === 'mes') return [`${h.slice(0, 7)}-01`, R.ultimoDiaDoMes(h.slice(0, 7))];
      if (per === 'custom') return [R.isoDate(de) || '0000-01-01', R.isoDate(ate) || '9999-12-31'];
      return null;
    })();
    const busca = R.norm(q);
    let sel = leves.filter(l => (status === 'todas' || (status === 'abertas' ? !l.fechado : l.situacao === status))
      && (!faixa || (l.c.data && l.c.data >= faixa[0] && l.c.data <= faixa[1]))
      && (!busca || R.norm(l.c.empresa).includes(busca)) && (!seg || l.c.segmento === seg) && (!classe || (l.c.classe || l.reg.classe) === classe)
      && (!resp || String(l.c.responsavel) === String(resp)));
    if (p.cardId) sel = sel.filter(l => String(l.c.id) === String(p.cardId));
    if (vend) {
      const out = [];
      for (const l of sel) { let vid = l.vendId; if (!vid) { const e = await empresaCurta(l.c.empresaId); vid = (e?.segs?.[l.c.segmento] || {}).vendedor; } if (String(vid) === String(vend)) out.push(l); }
      sel = out;
    }
    if (ramo) {
      const out = [];
      for (const l of sel) { let r = l.reg.ramo; if (r === undefined) { const e = await empresaCurta(l.c.empresaId); r = e?.ramo || ''; } if (String(r) === String(ramo)) out.push(l); }
      sel = out;
    }
    if (tipo) {
      const out = [];
      for (const l of sel) { const t = await memo(`tipo:${l.c.empresaId}`, 300e3, async () => tipoDaEmpresa(await empresaCurta(l.c.empresaId))); if (R.norm(t) === R.norm(tipo)) out.push(l); }
      sel = out;
    }
    if (p.soIds) return { ids: sel.map(l => l.c.id), total: sel.length };
    // 4) ordenação e página
    const nomesResp = new Map(); for (const id of respIds) nomesResp.set(id, await nomeDe(id));
    const chaves = {
      data: (a, b) => (RANK[a.situacao] - RANK[b.situacao]) || (a.c.data || '9').localeCompare(b.c.data || '9') || a.c.empresa.localeCompare(b.c.empresa) || a.c.segmento.localeCompare(b.c.segmento),
      prazo: (a, b) => (a.c.data || '9').localeCompare(b.c.data || '9'),
      empresa: (a, b) => a.c.empresa.localeCompare(b.c.empresa), segmento: (a, b) => a.c.segmento.localeCompare(b.c.segmento), cargo: (a, b) => a.c.cargo.localeCompare(b.c.cargo),
      classe: (a, b) => String(a.c.classe).localeCompare(String(b.c.classe)), responsavel: (a, b) => String(nomesResp.get(+a.c.responsavel)).localeCompare(String(nomesResp.get(+b.c.responsavel))),
    };
    sel.sort((a, b) => (chaves[ord] || chaves.data)(a, b) * (+dir || 1));
    const total = sel.length, paginas = Math.max(1, Math.ceil(total / size)), pagina = Math.min(Math.max(1, +p.page || 1), paginas);
    const fatia = sel.slice((pagina - 1) * size, pagina * size);
    // 5) só a página busca empresa/nomes
    let base = null; try { base = new URL(bitrix.base).origin; } catch { /* sem webhook */ }
    const visitas = [];
    for (const l of fatia) {
      const { it, c, reg } = l;
      const emp = await empresaCurta(c.empresaId);
      const sg = emp?.segs?.[c.segmento] || {};
      const equipe = {};
      for (const k of ['vendedor', 'supervisor', 'coordenador', 'gerente', 'diretor']) if (sg[k]) equipe[k] = await nomeDe(sg[k]);
      if (emp && (JSON.stringify(reg.equipe) !== JSON.stringify(equipeIds(sg)) || reg.ramo !== (emp.ramo || ''))) store.setCard(it.id, { ...reg, empresaId: c.empresaId, empresa: emp.nome, seg: c.segmento, cargo: c.cargo, equipe: equipeIds(sg), ramo: emp.ramo || '' });
      const tipoEmp = await memo(`tipo:${c.empresaId}`, 300e3, () => tipoDaEmpresa(emp));
      visitas.push({ ...c, segmentoEmpresa: await nomeRamo(emp?.ramo), tipoEmpresa: tipoEmp || '', responsavelNome: await nomeDe(c.responsavel), classe: c.classe || reg.classe || '', situacao: l.situacao,
        encerradoEm: l.fechado && it.updatedTime ? R.todayBR(new Date(it.updatedTime)) : null, dias: !l.fechado && c.data ? R.dayDiff(h, c.data) : null,
        ultima: sg.ultima || null, diasDesdeUltima: sg.ultima ? R.dayDiff(sg.ultima, h) : null, ciclo: R.intervalo(store.config, c.cargo, c.classe || reg.classe),
        altMin: R.addDays(h, 1), altMax: R.ultimoDiaDoMes(R.mesLimite(c.data, it.createdTime ? R.todayBR(new Date(it.createdTime)) : null) || h.slice(0, 7)),
        equipe, reprogramacoes: store.historico.filter(x => x.card === c.id && !x.tipo).length,
        urlEmpresa: base && c.empresaId ? `${base}/crm/company/details/${c.empresaId}/` : null, urlCard: base ? `${base}/crm/type/${F.ETYPE.fila}/details/${c.id}/` : null });
    }
    return { hoje: h, bitrix: !!permitidos, visao: todos ? 'tudo' : (time.size > 1 || leves.some(l => +l.c.responsavel !== +uid) ? 'equipe' : 'minhas'), total, pagina, paginas, tamanho: size, counts, opcoes, visitas };
  }
  // Dados em nível de linha para o dashboard (a tela agrega e filtra). Respeita a visibilidade de quem consulta.
  const cacheDash = new Map();
  // O dashboard é pesado: o cálculo (igual para todos) roda uma vez em segundo plano e fica em memória; cada pessoa só recebe
  // o recorte dela (equipe + permissões do Bitrix). A tela nunca espera o cálculo: se ainda não houver nada, responde "carregando".
  let baseDash = null, baseEm = 0, baseTrab = null;
  function baseDashboard() {
    if (baseTrab) return baseTrab;
    const t0 = Date.now();
    baseTrab = dashboardBase().then(d => { baseDash = d; baseEm = Date.now(); console.log(`dashboard-base ${Date.now() - t0}ms cards=${d.cards.length} visitas=${d.visitas.length}`); return d; })
      .catch(e => { console.error(`dashboard-base erro: ${e.message}`); store.log('erro', `Dashboard: ${e.message}`); throw e; }).finally(() => { baseTrab = null; });
    return baseTrab;
  }
  async function dashboardDados(p) {
    const chave = `${p.uid}|${p.bearer ? p.bearer.slice(-12) : ''}`;
    const c0 = cacheDash.get(chave);
    if (baseDash && Date.now() - baseEm > 120e3) baseDashboard().catch(() => {});
    if (c0 && c0.base === baseDash) return c0.dados;
    const trabalho = (async () => {
      const b = baseDash || await baseDashboard();
      const uid = p.uid, bearer = p.bearer || null;
      const todos = await enxergaTudo(uid);
      const time = todos ? null : await equipeDe(uid);
      const visivelPor = (resp, eq) => todos || +resp === +uid || (time && time.has(+resp)) || Object.values(eq || {}).map(Number).includes(+uid);
      const permCards = await permitidosBitrix(bearer, F.ETYPE.fila), permVis = await permitidosBitrix(bearer, F.ETYPE.visita);
      const cards = b.cards.filter(c => (!permCards || permCards.has(+c.id)) && visivelPor(c.resp, c._eq)).map(({ _eq, ...c }) => c);
      const visitas = b.visitas.filter(x => (!permVis || permVis.has(+x.id)) && (todos || visivelPor(x.resp, null)));
      const reprog = b.reprog.filter(x => todos || [x._a, x._r].some(r => r && (+r === +uid || (time && time.has(+r))))).map(({ _a, _r, ...x }) => x);
      const dados = { base: b.base, hoje: b.hoje, geradoEm: b.geradoEm, visao: todos ? 'tudo' : 'equipe', cards, visitas, reprog };
      cacheDash.set(chave, { base: b, dados });
      return dados;
    })();
    trabalho.catch(() => {});
    if (c0) return c0.dados;                                   // há uma versão anterior: serve já e atualiza em segundo plano
    const r = await Promise.race([trabalho, new Promise(ok => setTimeout(() => ok(null), p.espera ?? 2500))]);
    return r || { carregando: true };
  }
  async function dashboardBase(meses = 13) {
    const { map, meta } = await campos();
    const desde = new Date(Date.now() - meses * 30.5 * 864e5).toISOString();
    const h = hoje();
    // fila: abertos + finalizados no período
    const abertos = await memoSWR('cards-abertos', 15e3, () => cardsAbertos());
    const fin = await listarItens({ entityTypeId: F.ETYPE.fila, filter: { stageId: map.etapas.concluidas, '>updatedTime': R.brIso(desde) }, select: ['*', 'uf*'] });
    const naoReal = map.etapas.naoRealizada ? await listarItens({ entityTypeId: F.ETYPE.fila, filter: { stageId: [map.etapas.naoRealizada], '>updatedTime': R.brIso(desde) }, select: ['*', 'uf*'] }) : [];
    const nomes = new Map();
    const nome = async id => { if (!nomes.has(id)) nomes.set(id, await nomeUsuario(id)); return nomes.get(id); };
    const tipos = new Map(), emps = new Map();
    const empDe = async id => { if (!id) return null; let e = emps.get(id); if (e === undefined) { e = await lerEmpresa(id).catch(() => null); emps.set(id, e); } return e; };
    const tipoDe = async id => { if (!id) return ''; if (!tipos.has(id)) tipos.set(id, await tipoDaEmpresa(await empDe(id))); return tipos.get(id); };
    const pre = [...new Set([...abertos, ...fin, ...naoReal].map(it => +it.companyId).filter(Boolean))];
    { let i = 0; await Promise.all(Array.from({ length: 8 }, async () => { while (i < pre.length) await empDe(pre[i++]); })); }
    const cards = [];
    for (const [lista, finalizado, naoRealizada] of [[abertos, false, false], [fin, true, false], [naoReal, false, true]]) for (const it of lista) {
      const d = await dadosCard(it), reg = store.card(it.id) || {};
      const vendId = (reg.equipe || {}).vendedor || ((await empDe(d.empresaId))?.segs?.[d.segmento] || {}).vendedor;
      cards.push({ ramo: await nomeRamo((await empDe(d.empresaId))?.ramo), vendedor: vendId ? await nome(vendId) : '', id: d.id, empresaId: d.empresaId, empresa: d.empresa, segmento: d.segmento, cargo: d.cargo, classe: d.classe || reg.classe || '', tipo: await tipoDe(d.empresaId), resp: d.responsavel, respNome: await nome(d.responsavel), _eq: reg.equipe || null,
        data: d.data, situacao: naoRealizada ? 'naorealizada' : finalizado ? 'finalizado' : R.etapaPara(d.data, h), dias: d.data ? R.dayDiff(h, d.data) : null });
    }
    // registros de visita
    const v = map.visita, campoDH = v.dataHora || 'begindate';
    const sel = ['id', 'createdTime', 'assignedById', 'companyId', campoDH, ...[v.segmento, v.antecipada, v.filaId].filter(Boolean), ...Object.keys(meta).filter(k => /^ufCrm9_/.test(k) && /al[cç]ada/i.test(k))];
    const regs = await listarItens({ entityTypeId: F.ETYPE.visita, filter: { '>createdTime': R.brIso(desde) }, select: ['*', 'uf*'] });
    const porId = new Map(cards.map(c => [String(c.id), c]));
    const visitas = [];
    for (const it of regs) {
      const q = it[campoDH] || it.createdTime;
      const fila = v.filaId ? porId.get(String(it[v.filaId])) : null;
      const progr = fila?.data || null;
      const dia = q ? R.todayBR(new Date(q)) : null;
      const antTxt = v.antecipada ? String(F.decode(meta, v.antecipada, it[v.antecipada])).toLowerCase() : '';
      visitas.push({ ramo: await nomeRamo((await empDe(+it.companyId || 0))?.ramo), vendedor: await nome(+it.assignedById), id: +it.id, empresaId: +it.companyId || null, empresa: '', quando: q, dia, resp: +it.assignedById, respNome: await nome(+it.assignedById), segmento: v.segmento ? F.decode(meta, v.segmento, it[v.segmento]) : '',
        antecipada: antTxt ? /^(sim|y|true|1)/.test(antTxt) : null, programada: progr, desvio: progr && dia ? R.dayDiff(progr, dia) : null, cargo: fila?.cargo || '' });
    }
    const faltam = [...new Set(visitas.map(x => x.empresaId).filter(Boolean))];
    const nomeEmp = new Map(cards.map(c => [c.empresaId, c.empresa]));
    const buscar = faltam.filter(i => !nomeEmp.has(i));
    for (let i = 0; i < buscar.length; i += 40) {
      try { for (const c of (await bitrix.call('crm.company.list', { filter: { ID: buscar.slice(i, i + 40) }, select: ['ID', 'TITLE'] })).result || []) nomeEmp.set(+c.ID, c.TITLE); } catch { /* segue sem o nome */ }
    }
    visitas.forEach(x => { x.empresa = nomeEmp.get(x.empresaId) || ''; });
    let base = null; try { base = new URL(bitrix.base).origin; } catch { /* sem webhook */ }
    const reprog = store.historico.filter(x => !x.tipo).map(x => ({ _a: x.autor, _r: x.responsavel, ramo: '', vendedor: x.autorNome, card: x.card, empresaId: x.empresaId || null, empresa: x.empresa, at: x.at, segmento: x.segmento, cargo: x.cargo, quem: x.autorNome, dias: R.dayDiff(x.anterior, x.nova), motivo: x.motivo }));
    for (const x of reprog) if (x.empresaId) x.ramo = await nomeRamo((await empDe(x.empresaId))?.ramo);
    return { base, hoje: h, geradoEm: new Date().toISOString(), cards, visitas, reprog };
  }


  // Histórico de reprogramações respeita a mesma regra de visibilidade das visitas.
  async function historicoVisivel(uid, bearer = null) {
    const perm = await permitidosBitrix(bearer, F.ETYPE.fila);
    const todos = store.historico.filter(h => !perm || !h.card || perm.has(+h.card));
    if (await enxergaTudo(uid)) return todos;
    const time = await equipeDe(uid);
    return todos.filter(h => time.has(+h.autor) || time.has(+h.responsavel));
  }
  async function equipeDe(uid) {
    const ids = new Set([+uid]);
    try {
      const deps = (await bitrix.call('department.get', {})).result || [];
      const filhos = id => deps.filter(d => +d.PARENT === +id).map(d => +d.ID);
      const alvo = []; const pilha = deps.filter(d => +d.UF_HEAD === +uid).map(d => +d.ID);
      while (pilha.length) { const x = pilha.pop(); alvo.push(x); pilha.push(...filhos(x)); }
      if (alvo.length) {
        const us = (await bitrix.call('user.get', { filter: { UF_DEPARTMENT: alvo, ACTIVE: true } })).result || [];
        us.forEach(u => ids.add(+u.ID));
      }
    } catch (e) { store.log('aviso', `Equipe de ${uid}: ${e.message}`); }
    return ids;
  }
  async function departamentos() {
    const deps = (await bitrix.call('department.get', {})).result || [];
    return deps.map(d => ({ id: +d.ID, nome: String(d.NAME || '').trim(), pai: +d.PARENT || null, chefe: +d.UF_HEAD || null }));
  }
  async function usuarios() {
    const r = (await bitrix.call('user.get', { filter: { ACTIVE: true } })).result || [];
    return r.map(u => ({ id: +u.ID, nome: `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || `#${u.ID}` })).sort((a, b) => a.nome.localeCompare(b.nome));
  }
  async function visitasRegistradas(limit = 50) {
    const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.visita, order: { id: 'desc' }, select: ['*', 'uf*'] });
    return (r.result?.items || []).slice(0, limit).map(i => ({ id: +i.id, titulo: i.title, responsavel: +i.assignedById, em: i.createdTime }));
  }

  return { campos, camposVisita, sincronizarEmpresa, sincronizarTodas, jobDiario, registrarVisita, reprogramar, corrigirVisita, varrer, listarVisitas, usuarios, departamentos, reconciliarCadastros, listarVisitasPag, encerrarNaoRealizadas, tarefasAbertas, migrarFinalizadas, reconciliarVisitas, historicoVisivel, podeVerCard, podeConfigurar, podeDashboard, acessoRestrito, dashboardDados, aquecer, listaRamos, visitasRegistradas, isAdmin, nomeUsuario, lerCard, guardarVisitas, guardarCards, cardsAbertos };
}
module.exports = { createService };
