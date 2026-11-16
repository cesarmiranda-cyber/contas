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
      for (const c of chaves('classe')) { const x = R.classeDe(F.decode(meta, c, r[c])); if (x) { classe = x; break; } }
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
  // map com limite de simultâneas, mantendo a ordem
  const mapaPar = async (lista, n, fn) => { const out = new Array(lista.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => { while (i < lista.length) { const k = i++; out[k] = await fn(lista[k], k); } })); return out; };
  const voando = new Map();
  const memoria = new Map();
  const memo = async (chave, ttl, fn) => {
    const c = memoria.get(chave); if (c && Date.now() - c.em < ttl) return c.v;
    if (voando.has(chave)) return voando.get(chave);                      // a mesma consulta em andamento é compartilhada
    const p = (async () => { const v = await fn(); memoria.set(chave, { em: Date.now(), v }); return v; })().finally(() => voando.delete(chave));
    voando.set(chave, p); return p;
  };
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
      classe: R.classeDe(g('classe')) || reg.classe || '', responsavel: +it.assignedById || null,
      data: (R.isoDate(map.fila.data ? it[map.fila.data] : null) || R.isoDate(it.closedate)), stageId: it.stageId, criadoEm: it.createdTime || null,
      motivoNR: (map.fila.motivoNR && it[map.fila.motivoNR]) || '', detalheNR: (map.fila.detalheNR && it[map.fila.detalheNR]) || '',
    };
  };

  async function criarCard({ empresa, seg, cargo, classe, responsavel, data }) {
    const { map, meta } = await campos();
    const chave = R.chaveFila(empresa.id, seg, cargo);
    const stage = map.etapas[R.etapaPara(data, hoje())];
    const f = { title: tituloCard(empresa.nome, seg, cargo), companyId: empresa.id, assignedById: responsavel, stageId: stage };
    if (map.fila.segmento) f[map.fila.segmento] = F.encode(meta, map.fila.segmento, seg);
    if (map.fila.cargo) f[map.fila.cargo] = F.encode(meta, map.fila.cargo, cargo);
    if (map.fila.classe) f[map.fila.classe] = F.encode(meta, map.fila.classe, R.CLASSE_NOME[classe] || classe);
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
    if (classe && classe !== card.classe && map.fila.classe) f[map.fila.classe] = F.encode(meta, map.fila.classe, R.CLASSE_NOME[classe] || classe);
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
  // Contador por vendedor+classe: espalha as primeiras visitas pelo período da classe.
  function proximoRodizio(vendedor) {
    const m = { ...(store.job('rodizio') || {}) }, n = m[vendedor] || 0;
    m[vendedor] = n + 1; store.setJob('rodizio', m);
    return n;
  }
  async function sincronizarEmpresaSemTrava(id, { forcar = false, semProxima = false } = {}) {
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
      // Classe em branco no cadastro: o cliente deixou de ter visitas nesta linha. O card aberto é removido sozinho (e volta a nascer se a classe for preenchida de novo).
      if (!R.CLASSES.includes(s.classe) && cfg.removerSemClasse !== false) {
        for (const cargo of R.CARGOS) {
          const card = abertos.get(R.chaveFila(id, seg, cargo));
          if (card && await removerCardAuto(card, 'Classe em branco no cadastro da empresa: o cliente não terá mais visitas nesta linha.')) (res.removidosAuto ||= []).push(card.id);
        }
      }
      if (!s.vendedor && !s.supervisor && !s.coordenador && !s.gerente && !s.classe) continue; // segmento não usado
      if (!s.diretor) s.diretor = await diretorDe(s.gerente);
      for (const cargo of R.CARGOS.filter(x => x === 'Vendedor' || (cfg.cargosFila || []).includes(x))) {
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
        const calc = primeira ? (s.classe === 'E' ? R.primeiraVisitaEstrategica(hoje(), proximoRodizio(`${resp}|E`)) : R.primeiraVisitaClasse(cfg, hoje(), s.classe, proximoRodizio(`${resp}|${s.classe}`))) : R.dataProgramada(cfg, { cargo, classe: s.classe, ultima: s.ultima, hoje: hoje() });
        // Empresa que já tem Última e Próxima Visita: o card do Vendedor NASCE na data da Próxima Visita (sem partir de uma visita nova).
        const dataNova = (cargo === 'Vendedor' && s.ultima && s.proxima) ? s.proxima : calc;
        const existente = abertos.get(chave);
        if (!existente && (store.job('excluidos') || {})[chave]) continue;     // visita excluída por um usuário: não recria até restaurar
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
        // Entrou ou saiu da classe Clientes Estratégicos (primeira visita muda de regra): recalcula, a menos que o vendedor já tenha escolhido a data.
        if (primeira && (existente.classe === 'E') !== (s.classe === 'E') && !store.historico.some(x => !x.tipo && +x.card === existente.id)) {
          if (await atualizarCard(existente, { data: calc, classe: s.classe }, 'mudança para/de Clientes Estratégicos')) { res.atualizados.push(existente.id); continue; }
        }
        const ant = snapAnt[k] || {};
        const mudouData = !primeira && (forcar || ant.classe !== s.classe || ant.ultima !== s.ultima);
        const mudouResp = forcar || ant.resp !== resp || existente.responsavel !== resp;
        if (mudouData || mudouResp) {
          const ok = await atualizarCard(existente, { data: mudouData ? calc : null, responsavel: mudouResp ? resp : null, classe: s.classe },
            [mudouData && 'classe/última visita', mudouResp && 'responsável'].filter(Boolean).join(' e '));
          if (ok) res.atualizados.push(existente.id);
        }
      }
      if (cfg.atualizarProxima && !semProxima) await gravarProxima(emp, seg).catch(e => store.log('aviso', `Próxima visita ${emp.nome}/${seg}: ${e.message}`));
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
  // ---------- gestão: supervisor que acompanhou a visita ----------
  // Supervisores = chefes de departamento da estrutura do Bitrix24 (com o nome do departamento).
  async function supervisoresDoBitrix() {
    const cfg = store.config, restr = (cfg.supervisoresDepts || []).map(Number).filter(Boolean), extras = (cfg.supervisoresExtras || []).map(Number).filter(Boolean);
    return memo(`supervisores:${restr.join(',')}:${extras.join(',')}`, 300e3, async () => {
      const deps = (await bitrix.call('department.get', {})).result || [];
      const por = new Map();
      for (const d of deps) { const h = +d.UF_HEAD; if (h && (!restr.length || restr.includes(+d.ID))) (por.get(h) || por.set(h, []).get(h)).push(String(d.NAME || '').trim()); }
      for (const id of extras) if (!por.has(id)) por.set(id, []);
      for (const reg of Object.values(store.cards || {})) { const sup = +((reg.equipe || {}).supervisor); if (sup && !por.has(sup)) por.set(sup, []); }   // supervisores já indicados no cadastro das empresas
      const lista = await Promise.all([...por.entries()].map(async ([id, nomes]) => ({ id, nome: await nomeUsuario(id), departamentos: nomes })));
      return lista.sort((a, b) => a.nome.localeCompare(b.nome));
    });
  }
  // Chefe do departamento de uma pessoa (se ela mesma for a chefe, o da hierarquia acima).
  async function chefeDe(uid) {
    try {
      const u = ((await bitrix.call('user.get', { ID: uid })).result || [])[0];
      const deps = (await bitrix.call('department.get', {})).result || [];
      let d = deps.find(x => String(x.ID) === String([].concat(u?.UF_DEPARTMENT || [])[0]));
      for (let i = 0; d && i < 10; i++) { const h = +d.UF_HEAD; if (h && h !== +uid) return h; d = deps.find(x => String(x.ID) === String(d.PARENT)); }
    } catch { /* sem departamento */ }
    return null;
  }
  const supervisorDoRegistro = (it, map) => (map.visita.supervisor && +it[map.visita.supervisor]) || null;
  // ---------- contatos da empresa: quem foi visitado ----------
  const fmtContato = c => ({ id: +c.ID, nome: [c.NAME, c.LAST_NAME].filter(Boolean).join(' ').trim() || `Contato ${c.ID}`, cargo: c.POST || '',
    telefones: (c.PHONE || []).map(p => p.VALUE).filter(Boolean), emails: (c.EMAIL || []).map(p => p.VALUE).filter(Boolean) });
  const SEL_CONTATO = ['ID', 'NAME', 'LAST_NAME', 'POST', 'PHONE', 'EMAIL'];
  async function contatosDaEmpresa(empresaId) {
    if (!empresaId) return [];
    return memo(`contatos:${empresaId}`, 60e3, async () => {
      const out = []; let start = 0;
      for (;;) {
        const r = await bitrix.call('crm.contact.list', { filter: { COMPANY_ID: empresaId }, select: SEL_CONTATO, order: { NAME: 'ASC' }, start });
        out.push(...(r.result || []).map(fmtContato));
        if (r.next === undefined || r.next === null) break;
        start = r.next;
      }
      return out.sort((a, b) => a.nome.localeCompare(b.nome));
    });
  }
  async function contatosPorId(ids) {
    const lista = [...new Set((ids || []).map(Number).filter(Boolean))];
    if (!lista.length) return [];
    const r = await bitrix.call('crm.contact.list', { filter: { ID: lista }, select: SEL_CONTATO });
    return (r.result || []).map(fmtContato);
  }
  // Histórico de contatos da empresa, a partir dos registros de visita (o log fica no Bitrix, em cada registro): do mais recente ao mais antigo.
  async function historicoContatos(empresaId) {
    const { map } = await campos();
    const dh = map.visita.dataHora || 'begindate';
    const regs = empresaId ? await listarItens({ entityTypeId: F.ETYPE.visita, filter: { companyId: empresaId }, select: ['id', 'createdTime', dh, 'contactIds', 'contactId'] }) : [];
    const porContato = new Map();
    let ultimosIds = null;                              // contatos da visita mais recente
    for (const it of regs.sort((a, b) => String(b[dh] || b.createdTime).localeCompare(String(a[dh] || a.createdTime)) || (+b.id - +a.id))) {
      const ids = (it.contactIds && it.contactIds.length ? it.contactIds : (it.contactId ? [it.contactId] : [])).map(Number).filter(Boolean);
      if (ultimosIds === null && ids.length) ultimosIds = ids;
      for (const id of ids) { const g = porContato.get(id) || { id, visitas: 0, ultima: it[dh] || it.createdTime }; g.visitas++; porContato.set(id, g); }
    }
    const conhecidos = new Map((await contatosDaEmpresa(empresaId)).map(c => [c.id, c]));
    const faltam = [...porContato.keys()].filter(id => !conhecidos.has(id));
    for (const c of await contatosPorId(faltam)) conhecidos.set(c.id, c);
    const lista = [...porContato.values()].map(g => ({ ...g, ...(conhecidos.get(g.id) || { nome: `Contato ${g.id}`, cargo: '', telefones: [], emails: [] }) }));
    return { lista, ultimoId: lista[0]?.id || null, ultimosIds: ultimosIds || [] };
  }
  async function camposVisita(cardId, { uid = null } = {}) {
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
    const travados = new Set([v.segmento, v.filaId, v.antecipada, v.supervisor, ...alcadaKeys].filter(Boolean));
    const lista = [];
    const ocultos = new Set(Duplicados.agrupar(defs, Object.values(map.visita)).flatMap(g => g.outros)); // duplicados: mostra só o campo padrão
    if (v.supervisor) ocultos.add(v.supervisor);                                  // o supervisor tem seção própria (Gestão)
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
    const contatos = await contatosDaEmpresa(card.empresaId).catch(() => []);
    const hist = await historicoContatos(card.empresaId).catch(() => ({ lista: [], ultimoId: null }));
    const padraoIds = (hist.ultimosIds || []).filter(id => contatos.some(c => c.id === id));      // os contatos da última visita já vêm marcados (dá para trocar)
    const padrao = padraoIds[0] || null;
    const supervisores = v.supervisor ? await supervisoresDoBitrix().catch(() => []) : [];
    let supPadrao = null;
    if (supervisores.length) {
      const doDept = uid ? await chefeDe(uid) : null, doCadastro = +((emp?.segs?.[card.segmento] || {}).supervisor) || null;
      supPadrao = [doDept, doCadastro].find(id => id && supervisores.some(x => x.id === +id)) || null;
    }
    return { card: { id: card.id, empresa: card.empresa, segmento: card.segmento, cargo: card.cargo, data: card.data, antecipada: ant }, campos: lista, dataHoraKey: v.dataHora || null, resultadoKey: v.resultado || null, contatos, contatoPadraoId: padrao, contatoPadraoIds: padraoIds, supervisores, supervisorPadraoId: supPadrao, gestaoDisponivel: !!v.supervisor, urlEmpresa: null };
  }

  // card -> supervisor que acompanhou (a partir dos registros de visita)
  async function supervisorPorCard() {
    const { map } = await campos();
    if (!map.visita.supervisor || !map.visita.filaId) return new Map();
    return memo('sup-por-card', 60e3, async () => {
      const regs = await listarItens({ entityTypeId: F.ETYPE.visita, select: ['id', map.visita.filaId, map.visita.supervisor] });
      const m = new Map();
      for (const r of regs) { const c = +r[map.visita.filaId], sup = +r[map.visita.supervisor]; if (c && sup) m.set(String(c), sup); }
      return m;
    });
  }
  // ---------- editar registro de visita ----------
  const podeEditarRegistro = (uid, rec, map, equipe = []) => !!uid && (equipe.map(Number).includes(+uid) || +rec.assignedById === +uid || supervisorDoRegistro(rec, map) === +uid || isAdmin(uid) || idsLista(store.config.verTudo).includes(+uid) || idsLista(store.config.acessoConfig).includes(+uid));
  async function lerRegistro(visitaId) {
    const it = (await bitrix.call('crm.item.get', { entityTypeId: F.ETYPE.visita, id: visitaId })).result?.item;
    if (!it) throw erro('Registro de visita não encontrado.', 404);
    return it;
  }
  async function formEdicao(cardId, visitaId, { uid, bearer = null }) {
    if (!uid) throw erro('Usuário não identificado.', 401);
    if (!await podeVerCard(bearer, cardId)) throw erro('Você não tem acesso a esta visita.', 403);
    const { map } = await campos();
    const rec = await lerRegistro(visitaId);
    if (map.visita.filaId && String(rec[map.visita.filaId]) !== String(cardId)) throw erro('Este registro não pertence a esta visita.', 409);
    if (!podeEditarRegistro(uid, rec, map, Object.values((store.card(cardId) || {}).equipe || {}))) throw erro('Você não tem permissão para editar este registro. Podem editar: quem registrou a visita, o supervisor que a acompanhou, as pessoas do cadastro da empresa (vendedor, supervisor, coordenador, gerente, diretor) e quem vê tudo ou administra o app.', 403);
    const form = await camposVisita(cardId, { uid });
    form.campos = form.campos.filter(c => c.tipo !== 'arquivo');                    // anexos não são editados aqui
    for (const c of form.campos) { if (c.travado) continue; const val = rec[c.key]; c.valor = val === undefined || val === null ? '' : val; }
    const dh = map.visita.dataHora;
    form.dataHoraKey = null;                                                         // data/hora da visita não muda por edição (ela define o ciclo)
    form.campos = form.campos.filter(c => c.key !== dh);
    const idsRec = (rec.contactIds && rec.contactIds.length ? rec.contactIds : (rec.contactId ? [rec.contactId] : [])).map(Number).filter(Boolean);
    form.contatoPadraoIds = idsRec; form.contatoPadraoId = idsRec[0] || null;
    form.supervisorPadraoId = supervisorDoRegistro(rec, map);
    form.visita = { id: +rec.id, quando: rec[dh || 'begindate'] || rec.createdTime };
    return form;
  }
  async function editarRegistro(cardId, visitaId, { uid, campos: dados = {}, contatoId, contatoIds, supervisorId, bearer = null }) {
    const { map } = await campos();
    const form = await formEdicao(cardId, visitaId, { uid, bearer });
    const rec = await lerRegistro(visitaId);
    const vazio = x => x === undefined || x === null || (Array.isArray(x) ? !x.length : String(x).trim() === '');
    const f = {}, mudancas = [];
    const legivel = (c, val) => { if (vazio(val)) return '(vazio)'; if (c.tipo === 'sim_nao') return val === 'Y' || val === true ? 'Sim' : 'Não'; if (c.tipo === 'lista') return [].concat(val).map(x => (c.itens.find(i => i.id === String(x)) || {}).nome || String(x)).join(', '); return String(val).slice(0, 300); };
    const faltam = [];
    for (const c of form.campos) {
      if (c.travado) continue;
      const tem = Object.prototype.hasOwnProperty.call(dados, c.key);
      const novoBruto = tem ? dados[c.key] : rec[c.key];
      if (c.obrigatorio && vazio(novoBruto)) faltam.push(c.titulo);
      if (!tem) continue;
      const novo = c.tipo === 'sim_nao' ? (novoBruto === true || novoBruto === 'Y' || novoBruto === 'true' ? 'Y' : 'N') : (c.tipo === 'numero' && !vazio(novoBruto) ? Number(novoBruto) : novoBruto);
      const velho = rec[c.key];
      const igual = JSON.stringify([].concat(vazio(novo) ? [] : novo).map(String)) === JSON.stringify([].concat(vazio(velho) ? [] : velho).map(String));
      if (igual) continue;
      f[c.key] = vazio(novo) ? (Array.isArray(velho) ? [] : '') : novo;
      mudancas.push({ campo: c.titulo, de: legivel(c, velho), para: legivel(c, novo) });
    }
    if (faltam.length) throw erro(`Preencha: ${faltam.join(', ')}.`, 422);
    const pedido = contatoIds !== undefined ? contatoIds : (contatoId !== undefined ? (contatoId ? [contatoId] : []) : undefined);
    if (pedido !== undefined) {
      const novos = [...new Set([].concat(pedido || []).map(Number).filter(Boolean))].sort((x, y) => x - y);
      const atuais = (rec.contactIds && rec.contactIds.length ? rec.contactIds : (rec.contactId ? [rec.contactId] : [])).map(Number).filter(Boolean).sort((x, y) => x - y);
      if (JSON.stringify(novos) !== JSON.stringify(atuais)) {
        const lista = await contatosDaEmpresa(rec.companyId);
        if (novos.some(id => !lista.some(c => c.id === id))) throw erro('Um dos contatos escolhidos não pertence a esta empresa.', 422);
        f.contactIds = novos; f.contactId = novos[0] || 0;
        const nomes = ids => ids.length ? ids.map(id => (lista.find(c => c.id === id) || {}).nome || `Contato ${id}`).join(', ') : '(nenhum)';
        mudancas.push({ campo: 'Contatos da visita', de: nomes(atuais), para: nomes(novos) });
      }
    }
    if (supervisorId !== undefined && map.visita.supervisor) {
      const novo = Number(supervisorId) || 0, atual = supervisorDoRegistro(rec, map) || 0;
      if (novo !== atual) {
        const sups = await supervisoresDoBitrix();
        if (novo && !sups.some(x => x.id === novo)) throw erro('O supervisor escolhido não está na estrutura de departamentos do Bitrix24.', 422);
        f[map.visita.supervisor] = novo || '';
        mudancas.push({ campo: 'Supervisor que acompanhou', de: atual ? await nomeUsuario(atual) : '(nenhum)', para: novo ? await nomeUsuario(novo) : '(nenhum)' });
      }
    }
    if (!mudancas.length) return { ok: true, alterado: false };
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.visita, id: visitaId, fields: f });
    const nome = await nomeUsuario(uid);
    store.addHistorico({ tipo: 'edicao-registro', visita: +visitaId, card: +cardId, empresaId: +rec.companyId || null, empresa: rec.title || '', autor: +uid, autorNome: nome, mudancas });
    try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: +visitaId, ENTITY_TYPE: DYN(F.ETYPE.visita), COMMENT: `Registro editado por ${nome} em ${clock().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.\n${mudancas.map(m => `${m.campo}: ${m.de} → ${m.para}`).join('\n')}` } }); } catch { /* opcional */ }
    const avisa = new Set([+rec.assignedById, supervisorDoRegistro(rec, map), Number(supervisorId) || null].filter(x => x && x !== +uid));
    for (const u of avisa) await notificar(u, `${nome} editou o registro de visita "${rec.title || visitaId}" (${mudancas.map(m => m.campo).join(', ')}).`).catch(() => {});
    store.log('registro-editado', `Registro ${visitaId} editado por ${nome}: ${mudancas.map(m => m.campo).join(', ')}`, { visita: +visitaId, card: +cardId });
    invalida();
    return { ok: true, alterado: true, mudancas };
  }
  // O que o consultor lançou: os registros de visita (SPA 1032) ligados ao card, com todos os campos preenchidos, quem registrou e os anexos.
  async function registroVisita(cardId, { bearer = null, uid = null } = {}) {
    if (!await podeVerCard(bearer, cardId)) throw erro('Você não tem acesso a esta visita.', 403);
    const { map, meta } = await campos();
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    const v = map.visita;
    const defs = (await bitrix.call('crm.item.fields', { entityTypeId: F.ETYPE.visita })).result?.fields || {};
    let itens = [];
    if (v.filaId) itens = (await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.visita, filter: { [v.filaId]: String(cardId) }, select: ['*', 'uf*'], order: { id: 'asc' } })).result?.items || [];
    if (!itens.length && card.empresaId) {          // visita lançada direto no Bitrix, sem o ID da fila: acha pela empresa e pela linha
      const todos = (await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.visita, filter: { companyId: card.empresaId }, select: ['*', 'uf*'], order: { id: 'desc' } })).result?.items || [];
      itens = todos.filter(it => !v.segmento || R.norm(F.decode(meta, v.segmento, it[v.segmento])) === R.norm(card.segmento)).slice(0, 3);
    }
    const permVis = await permitidosBitrix(bearer, F.ETYPE.visita);
    if (permVis) itens = itens.filter(it => permVis.has(+it.id));
    let base = ''; try { base = new URL(bitrix.base).origin; } catch { /* sem webhook */ }
    const arq = x => {
      const lista = (Array.isArray(x) ? x : [x]).filter(Boolean);
      return lista.map(a => {
        if (typeof a === 'object') { const u = a.urlMachine || a.url || ''; return { nome: a.name || a.fileName || a.title || `arquivo ${a.id || ''}`.trim(), url: u ? (/^https?:/.test(u) ? u : base + u) : '' }; }
        return { nome: `arquivo ${a}`, url: '' };
      });
    };
    const nomeUsuarioCache = new Map();
    const quem = async id => { if (!id) return ''; if (!nomeUsuarioCache.has(id)) nomeUsuarioCache.set(id, await nomeUsuario(+id)); return nomeUsuarioCache.get(id); };
    const idsContato = [...new Set(itens.flatMap(it => (it.contactIds && it.contactIds.length ? it.contactIds : (it.contactId ? [it.contactId] : [])).map(Number).filter(Boolean)))];
    const doCadastro = new Map((await contatosDaEmpresa(card.empresaId).catch(() => [])).map(c => [c.id, c]));
    for (const c of await contatosPorId(idsContato.filter(id => !doCadastro.has(id))).catch(() => [])) doCadastro.set(c.id, c);
    const contatosDe = it => (it.contactIds && it.contactIds.length ? it.contactIds : (it.contactId ? [it.contactId] : [])).map(Number).filter(Boolean).map(id => doCadastro.get(id) || { id, nome: `Contato ${id}`, cargo: '', telefones: [], emails: [] });
    const ocultos = new Set([v.filaId].filter(Boolean));
    const registros = [];
    for (const it of itens) {
      const campos_ = [];
      for (const [k, d] of Object.entries(defs)) {
        if (!k.startsWith('ufCrm') || ocultos.has(k)) continue;
        const val = it[k];
        if (val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length) || val === false) continue;
        const titulo = d.title || d.formLabel || k;
        if (d.type === 'file') { const a = arq(val); if (a.length) campos_.push({ key: k, titulo, tipo: 'arquivo', arquivos: a }); continue; }
        let texto;
        if ((d.items || []).length) {
          const nomes = new Map(d.items.map(i => [String(i.ID ?? i.id), String(i.VALUE ?? i.value ?? '')]));
          texto = [].concat(val).map(x => nomes.get(String(x)) || String(x)).join(', ');
        } else if (d.type === 'boolean') texto = (val === 'Y' || val === true || val === '1' || val === 1) ? 'Sim' : 'Não';
        else if (d.type === 'datetime') texto = R.fmtBR(R.todayBR(new Date(val))) + ' ' + new Date(val).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        else if (d.type === 'date') texto = R.fmtBR(R.isoDate(val));
        else texto = [].concat(val).map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
        if (texto === '') continue;
        campos_.push({ key: k, titulo, tipo: d.type, texto, destaque: k === v.resultado });
      }
      campos_.sort((a, b) => (!!b.destaque - !!a.destaque));
      registros.push({ id: +it.id, titulo: it.title || '', quando: it[v.dataHora || 'begindate'] || it.createdTime || null, criadoEm: it.createdTime || null,
        por: await quem(+it.assignedById || +it.createdBy), contatos: contatosDe(it), contato: contatosDe(it)[0] || null, supervisor: supervisorDoRegistro(it, map) ? { id: supervisorDoRegistro(it, map), nome: await quem(supervisorDoRegistro(it, map)) } : null,
        podeEditar: podeEditarRegistro(uid, it, map, Object.values((store.card(cardId) || {}).equipe || {})), edicoes: store.historico.filter(h => h.tipo === 'edicao-registro' && +h.visita === +it.id).slice(0, 5).map(h => ({ at: h.at, por: h.autorNome, mudancas: h.mudancas })), campos: campos_, urlRegistro: base ? `${base}/crm/type/${F.ETYPE.visita}/details/${it.id}/` : null });
    }
    const hc = await historicoContatos(card.empresaId).catch(() => ({ lista: [] }));
    return { card: { id: card.id, empresa: card.empresa, segmento: card.segmento, cargo: card.cargo, data: card.data }, registros, contatosHistorico: hc.lista };
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
  async function registrarVisita(cardId, { uid, resultado, acompanhamento, dataHora, contatoId = null, contatoIds = null, supervisorId = null, campos: extra = {} }) {
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
    const quando = dataHora ? R.parseBR(dataHora) : agora;
    if (isNaN(quando)) throw erro('Data/hora inválida.');
    const dia = R.todayBR(quando);
    const ant = R.antecipada(dia, card.data);
    const emp = await lerEmpresa(card.empresaId);
    const f = {
      title: `${card.empresa} - ${R.fmtBR(dia)}`, companyId: card.empresaId, assignedById: uid,
      [map.visita.dataHora || 'begindate']: quando.toISOString(),
    };
    const escolhidos = [...new Set([].concat(contatoIds || (contatoId ? [contatoId] : [])).map(Number).filter(Boolean))];
    if (escolhidos.length) {                           // contatos visitados: gravados no registro (o histórico de contatos nasce desses registros)
      const lista = await contatosDaEmpresa(card.empresaId);
      if (escolhidos.some(id => !lista.some(c => c.id === id))) throw erro('Um dos contatos escolhidos não pertence a esta empresa.', 422);
      f.contactId = escolhidos[0]; f.contactIds = escolhidos;
    }
    if (supervisorId) {                                 // Gestão: supervisor que acompanhou (da estrutura de departamentos do Bitrix)
      if (!map.visita.supervisor) throw erro('O campo "Supervisor que acompanhou" ainda não existe no Registro de Visita. Peça a um administrador para usar "Preparar o Bitrix" em Configurações.', 422);
      if (!(await supervisoresDoBitrix()).some(x => x.id === +supervisorId)) throw erro('O supervisor escolhido não está na estrutura de departamentos do Bitrix24.', 422);
      f[map.visita.supervisor] = +supervisorId;
    }
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
    const livre = card.classe === 'E';                 // Clientes Estratégicos: o vendedor altera a data livremente (sem motivo obrigatório nem limite de mês)
    const msg = R.validarReprogramacao({ atual: card.data, nova, motivo, hoje: hoje(), livre, mes: R.mesLimite(card.data, card.criadoEm ? R.todayBR(new Date(card.criadoEm)) : null) });
    if (msg) throw erro(msg, 422);
    const stage = map.etapas[R.etapaPara(nova, hoje())];
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: { [map.fila.data || 'closedate']: nova, ...(stage ? { stageId: stage } : {}) } });
    store.setSnapCard(card.id, { data: nova, resp: card.responsavel });
    const tarefas = await moverPrazoTarefas(card.id, nova);
    const nome = await nomeUsuario(uid);
    const agora = clock().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    store.addHistorico({ card: card.id, empresaId: card.empresaId, empresa: card.empresa, segmento: card.segmento, cargo: card.cargo, anterior: card.data, nova, motivo: String(motivo || '').trim() || '(sem motivo — cliente estratégico)', autor: uid, autorNome: nome, responsavel: card.responsavel });
    try {
      await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: card.id, ENTITY_TYPE: DYN(F.ETYPE.fila),
        COMMENT: `Visita alterada em ${agora} por ${nome}.\nData anterior: ${R.fmtBR(card.data)}\nNova data: ${R.fmtBR(nova)}\nMotivo: ${String(motivo || '').trim() || '—'}` } });
    } catch (e) { store.log('aviso', `Comentário na linha do tempo do card ${card.id} falhou: ${e.message}`); }
    store.log('reprogramacao', `Card ${card.id}: ${R.fmtBR(card.data)} → ${R.fmtBR(nova)} por ${uid}: ${String(motivo || '').trim()}`, { card: card.id });
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
  // Marca um card como "Não realizada": etapa, comentário, tarefas antigas encerradas, próxima visita do ciclo e uma tarefa para o
  // vendedor informar o motivo (com o link do registro). Usado no fim do mês (automático) e quando alguém marca à mão.
  async function naoRealizarCard(it, c, { texto, motivo = '', detalhe = '', porUid = null } = {}) {
    const { map } = await campos();
    const h = hoje();
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: c.id, fields: { stageId: map.etapas.naoRealizada, ...(motivo && map.fila.motivoNR ? { [map.fila.motivoNR]: motivo } : {}), ...(detalhe && map.fila.detalheNR ? { [map.fila.detalheNR]: detalhe } : {}) } });
    const chave = R.chaveFila(c.empresaId, c.segmento, c.cargo);
    if (store.chave(chave) === c.id) store.setChave(chave, null);
    store.log('nao-realizada', `Card ${c.id} marcado como não realizada (${c.titulo}, programada ${R.fmtBR(c.data)})${motivo ? ` — motivo: ${motivo}` : ''}`, { card: c.id });
    try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: c.id, ENTITY_TYPE: DYN(F.ETYPE.fila), COMMENT: `${texto || 'Visita não realizada.'}${motivo ? `\nMotivo: ${motivo}${detalhe ? ` — ${detalhe}` : ''}` : ''}` } }); } catch { /* sem comentário */ }
    await encerrarTarefas(c.id, 'Visita não realizada.');
    const reg = store.card(c.id) || {};
    const vendedor = +((reg.equipe || {}).vendedor) || c.responsavel;
    await notificar(c.responsavel, `A visita "${c.titulo}" foi marcada como não realizada.`);
    // tarefa para o vendedor informar o motivo (some quando o motivo for informado)
    if (!motivo || (porUid && +porUid !== +vendedor)) await criarTarefaMotivo(c, vendedor);
    const aberto = (await cardsAbertosDaEmpresa(c.empresaId)).some(x => String(x.title).split(' | ').slice(1).join('|') === String(it.title).split(' | ').slice(1).join('|'));
    const emp = await lerEmpresa(c.empresaId);
    const sg = emp?.segs?.[c.segmento] || {};
    const classe = sg.classe || c.classe;
    if (!aberto && emp && R.CLASSES.includes(classe)) {
      const nova = classe === 'E' ? R.addMonths([c.data, h].sort().pop(), 6) : [R.addDays(c.data, R.intervalo(store.config, c.cargo, classe) || 30), R.addDays(h, 1)].sort().pop();
      const novoId = await criarCard({ empresa: emp, seg: c.segmento, cargo: c.cargo, classe, responsavel: sg[c.cargo.toLowerCase()] || c.responsavel, data: nova });
      store.log('card-criado', `Próximo card ${novoId} gerado após não realizada: ${R.fmtBR(nova)}`, { card: novoId });
      if (store.config.atualizarProxima) await gravarProxima(emp, c.segmento).catch(() => {});
    }
  }
  async function criarTarefaMotivo(c, vendedor) {
    try {
      let base = ''; try { base = new URL(bitrix.base).origin; } catch { /* sem webhook */ }
      const link = base ? `${base}/crm/type/${F.ETYPE.fila}/details/${c.id}/` : '';
      const desc = `A visita de ${c.empresa} (${c.segmento} · ${c.cargo}), programada para ${R.fmtBR(c.data)}, ficou como NÃO REALIZADA.\n\n${link ? `[URL=${link}]Abrir o registro da visita[/URL]\n\n` : ''}No app Registro de Visitas, abra a visita (filtro "Não realizadas") e clique em "Informar motivo". Esta tarefa fecha sozinha quando o motivo for informado.`;
      const r = await bitrix.call('tasks.task.add', { fields: { TITLE: `Informar o motivo da visita não realizada - ${c.empresa} (${c.segmento})`, DESCRIPTION: desc, RESPONSIBLE_ID: vendedor, DEADLINE: R.prazoUtil(clock(), 16), UF_CRM_TASK: [vinculoCard(c.id)] } });
      store.log('tarefa', `Tarefa criada para ${vendedor}: informar o motivo da visita não realizada (card ${c.id})`, { card: c.id });
      return r.result?.task?.id || null;
    } catch (e) { store.log('aviso', `Tarefa do motivo (card ${c.id}) não criada: ${e.message}`); return null; }
  }
  async function encerrarNaoRealizadas() {
    const { map } = await campos();
    if (!map.etapas.naoRealizada) return { marcadas: 0, semEtapa: true };
    const h = hoje(), mesHoje = h.slice(0, 7);
    let marcadas = 0;
    for (const it of await cardsAbertos()) {
      const c = await dadosCard(it);
      if (c.classe === 'E') continue;                    // estratégicos não vencem no fim do mês
      const lim = R.mesLimite(c.data, it.createdTime ? R.todayBR(new Date(it.createdTime)) : null);
      if (!lim || lim >= mesHoje) continue;
      await comTrava(`empresa:${c.empresaId}`, () => naoRealizarCard(it, c, { texto: `Visita não realizada no mês (${lim.split('-').reverse().join('/')}). A data não pode mais ser alterada.` }));
      marcadas++;
    }
    return { marcadas };
  }
  // Marcar à mão como "Não realizada" (com o motivo) e informar/alterar o motivo depois.
  const motivosPermitidos = () => store.config.motivosNaoRealizada || [];
  function validaMotivo(motivo, detalhe) {
    if (!String(motivo || '').trim()) throw erro('Escolha o motivo.', 422);
    if (!motivosPermitidos().includes(motivo)) throw erro('Motivo inválido: escolha um da lista.', 422);
    if (/^outro/i.test(motivo) && String(detalhe || '').trim().length < 3) throw erro('Descreva o motivo no campo de texto.', 422);
  }
  async function marcarNaoRealizada(cardId, { uid, motivo, detalhe = '', bearer = null }) {
    if (!uid) throw erro('Usuário não identificado.', 401);
    if (!await podeVerCard(bearer, cardId)) throw erro('Você não tem acesso a esta visita.', 403);
    validaMotivo(motivo, detalhe);
    const { map } = await campos();
    const it = (await bitrix.call('crm.item.get', { entityTypeId: F.ETYPE.fila, id: cardId })).result?.item;
    if (!it) throw erro('Card da fila não encontrado.', 404);
    const c = await dadosCard(it);
    if (!(map.etapas.abertas || []).includes(it.stageId)) throw erro('Só uma visita em aberto pode ser marcada como não realizada.', 409);
    const nome = await nomeUsuario(uid);
    await comTrava(`empresa:${c.empresaId}`, () => naoRealizarCard(it, c, { texto: `Visita marcada como não realizada por ${nome}.`, motivo, detalhe: String(detalhe || '').trim(), porUid: uid }));
    invalida();
    return { ok: true };
  }
  async function informarMotivo(cardId, { uid, motivo, detalhe = '', bearer = null }) {
    if (!uid) throw erro('Usuário não identificado.', 401);
    if (!await podeVerCard(bearer, cardId)) throw erro('Você não tem acesso a esta visita.', 403);
    validaMotivo(motivo, detalhe);
    const { map } = await campos();
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    if (card.stageId !== map.etapas.naoRealizada) throw erro('O motivo só se aplica a visitas não realizadas.', 409);
    const f = {};
    if (map.fila.motivoNR) f[map.fila.motivoNR] = motivo;
    if (map.fila.detalheNR) f[map.fila.detalheNR] = String(detalhe || '').trim();
    if (!map.fila.motivoNR) throw erro('O campo "Motivo da não realização" ainda não existe na Fila. Peça a um administrador para usar "Preparar o Bitrix" em Configurações.', 422);
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: cardId, fields: f });
    const nome = await nomeUsuario(uid);
    try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: +cardId, ENTITY_TYPE: DYN(F.ETYPE.fila), COMMENT: `Motivo informado por ${nome}: ${motivo}${String(detalhe || '').trim() ? ` — ${String(detalhe).trim()}` : ''}` } }); } catch { /* opcional */ }
    await encerrarTarefas(cardId, `Motivo informado por ${nome}.`);
    store.log('motivo-nao-realizada', `Card ${cardId}: motivo informado por ${nome}: ${motivo}`, { card: +cardId });
    invalida();
    return { ok: true };
  }
  // Participantes extras de uma visita (além da equipe do cadastro da empresa): passam a enxergar e a poder registrar a visita.
  async function definirParticipantes(cardId, { uid, ids = [], bearer = null }) {
    if (!uid) throw erro('Usuário não identificado.', 401);
    if (!await podeVerCard(bearer, cardId)) throw erro('Você não tem acesso a esta visita.', 403);
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    const reg = store.card(cardId) || {};
    const novos = [...new Set((ids || []).map(Number).filter(Boolean))].slice(0, 20);
    const antes = new Set(reg.participantes || []);
    store.setCard(cardId, { ...reg, participantes: novos });
    invalida();
    for (const u of novos.filter(x => !antes.has(x))) await notificar(u, `Você foi adicionado à visita "${card.titulo}" (programada para ${R.fmtBR(card.data)}). Qualquer participante pode registrá-la.`).catch(() => {});
    store.log('participantes', `Participantes da visita ${cardId}: ${novos.join(', ') || 'nenhum'}`, { card: +cardId, autor: uid });
    return { participantes: novos };
  }
  // Novo ciclo: encerra (move para Removido, com comentário) todos os cards abertos no momento da execução, encerra as tarefas ligadas
  // e gera de novo a fila pelas regras. Não grava Última nem Próxima Visita no cadastro das empresas. Retomável: se o servidor
  // reiniciar no meio, continua de onde parou (a lista de cards antigos fica gravada) e não repete o que já foi feito.
  let cicloRodando = false;
  async function novoCiclo() {
    let job = store.job('novoCiclo');
    if (job && job.fase === 'concluido') return job;
    if (cicloRodando) return { emAndamento: true, ...job };
    if (!store.config.ativo) throw erro('O app está desativado (Configurações → ativar).', 409);
    const { map } = await campos();
    if (!map.etapas.removido) throw erro('Não encontrei a etapa "Removido" no kanban da Fila.', 500);
    cicloRodando = true;
    try {
      if (!job) {
        const abertos = await cardsAbertos();
        const empresas = [...new Set(abertos.map(it => +it.companyId).filter(Boolean))];
        job = { fase: 'removendo', inicio: new Date().toISOString(), ids: abertos.map(it => +it.id), removidos: [], empresas, criadas: [], criados: 0, erros: [] };
        store.setJob('novoCiclo', job);
        store.log('novo-ciclo', `Novo ciclo iniciado: ${job.ids.length} card(s) abertos de ${empresas.length} empresa(s)`);
      }
      const salva = () => store.setJob('novoCiclo', job);
      if (job.fase === 'removendo') {
        const feitos = new Set(job.removidos);
        const pendentes = (await cardsAbertos()).filter(it => job.ids.includes(+it.id) && !feitos.has(+it.id));
        await mapaPar(pendentes, 3, async it => {
          try {
            const c = await dadosCard(it);
            await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: c.id, fields: { stageId: map.etapas.removido } });
            if (store.chave(R.chaveFila(c.empresaId, c.segmento, c.cargo)) === c.id) store.setChave(R.chaveFila(c.empresaId, c.segmento, c.cargo), null);
            await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: c.id, ENTITY_TYPE: DYN(F.ETYPE.fila), COMMENT: 'Fila encerrada para início de um novo ciclo de visitas. Nenhuma visita foi realizada neste card; a visita foi recriada conforme as regras (visita única por empresa e linha, com a equipe acompanhando o mesmo registro).' } }).catch(() => {});
            await encerrarTarefas(c.id, 'Fila encerrada para início de novo ciclo.');
            job.removidos.push(c.id);
            if (job.removidos.length % 40 === 0) { salva(); console.log(`novo-ciclo removidos ${job.removidos.length}/${job.ids.length}`); }
          } catch (e) { job.erros.push(`remover ${it.id}: ${e.message}`.slice(0, 160)); }
        });
        job.fase = 'criando'; salva(); invalida();
        console.log(`novo-ciclo removidos ${job.removidos.length}/${job.ids.length}`);
      }
      if (job.fase === 'criando') {
        const feitas = new Set(job.criadas);
        for (const id of job.empresas.filter(e => !feitas.has(e))) {
          try { const r = await sincronizarEmpresa(id, { semProxima: true }); job.criados += (r.criados || []).length; job.criadas.push(id); }
          catch (e) { job.erros.push(`criar empresa ${id}: ${e.message}`.slice(0, 160)); job.criadas.push(id); }
          if (job.criadas.length % 10 === 0) { salva(); console.log(`novo-ciclo empresas ${job.criadas.length}/${job.empresas.length} cards-novos=${job.criados}`); }
        }
        job.fase = 'concluido'; job.fim = new Date().toISOString(); salva(); invalida();
        store.log('novo-ciclo', `Novo ciclo concluído: ${job.removidos.length} card(s) removidos, ${job.criados} criados, ${job.erros.length} erro(s)`);
        console.log('novo-ciclo concluido', JSON.stringify({ removidos: job.removidos.length, criados: job.criados, erros: job.erros.slice(0, 5) }));
      }
      return job;
    } finally { cicloRodando = false; }
  }
  // Primeiras visitas (empresa sem Última visita e sem nenhum registro): espalha pelo período da classe (A 30 dias, B 60, C 90), só em
  // dias úteis, a partir da segunda-feira seguinte, de forma uniforme por vendedor. Não mexe em quem já teve visita registrada,
  // em cards que o vendedor já alterou, nem em empresas sem Vendedor/Classe. `aplicar: false` só mostra o plano.
  async function ajustarDatasIniciais({ aplicar = false } = {}) {
    const h = hoje(), cfg = store.config, { map, meta } = await campos();
    const inicio = R.primeiraVisitaData(h, 0);                       // segunda-feira da semana seguinte
    // empresas+linhas que já têm registro de visita no SPA 1032
    const regs = await listarItens({ entityTypeId: F.ETYPE.visita, select: ['id', 'companyId', ...[map.visita.segmento].filter(Boolean)] });
    const comRegistro = new Set(regs.map(r => `${+r.companyId}|${R.norm(map.visita.segmento ? F.decode(meta, map.visita.segmento, r[map.visita.segmento]) : '')}`));
    const comRegistroEmpresa = new Set(regs.map(r => +r.companyId));
    const abertos = await cardsAbertos();
    const ids = [...new Set(abertos.map(it => +it.companyId).filter(Boolean))];
    const emps = new Map(); { let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < ids.length) { const id = ids[i++]; emps.set(id, await lerEmpresa(id).catch(() => null)); } })); }
    const alterados = new Set(store.historico.filter(x => !x.tipo || x.tipo === 'ajuste-inicial').map(x => +x.card));
    const grupos = {}; const fora = { comUltima: 0, comRegistro: 0, alteradoPeloVendedor: 0, semClasseOuVendedor: 0, outroCargo: 0, jaAjustado: 0 };
    for (const it of abertos) {
      const c = await dadosCard(it);
      if (c.cargo !== 'Vendedor') { fora.outroCargo++; continue; }
      const sg = emps.get(c.empresaId)?.segs?.[c.segmento] || {};
      if (sg.ultima) { fora.comUltima++; continue; }
      if (!sg.vendedor || !R.CLASSES.includes(sg.classe)) { fora.semClasseOuVendedor++; continue; }
      if (comRegistro.has(`${c.empresaId}|${R.norm(c.segmento)}`) || (!map.visita.segmento && comRegistroEmpresa.has(c.empresaId))) { fora.comRegistro++; continue; }
      if (store.historico.some(x => x.tipo === 'ajuste-inicial' && +x.card === c.id && (x.classe ? x.classe === sg.classe : sg.classe !== 'E'))) { fora.jaAjustado++; continue; }
      if (store.historico.some(x => !x.tipo && +x.card === c.id)) { fora.alteradoPeloVendedor++; continue; }
      ((grupos[sg.classe] ||= {})[sg.vendedor] ||= []).push({ c, it, classe: sg.classe });
    }
    const plano = { inicio, hoje: h, fora, classes: {}, aplicados: 0, erros: [] };
    const tarefas = [];
    for (const classe of Object.keys(grupos).sort()) {
      const n = classe === 'E' ? null : R.intervalo(cfg, 'Vendedor', classe), dias = classe === 'E' ? R.diasMarco(h) : R.diasUteis(inicio, n);
      const semanas = {}; let total = 0;
      for (const lista of Object.values(grupos[classe])) {
        lista.sort((a, b) => a.c.empresa.localeCompare(b.c.empresa) || a.c.segmento.localeCompare(b.c.segmento));
        lista.forEach((x, j) => { const data = R.espalhar(lista.length, dias, j); x.nova = data; total++; const sem = R.addDays(data, -((new Date(data + 'T12:00:00Z').getUTCDay() + 6) % 7)); semanas[sem] = (semanas[sem] || 0) + 1; tarefas.push(x); });
      }
      plano.classes[classe] = { periodoDias: n, cards: total, ate: dias[dias.length - 1], porSemana: Object.entries(semanas).sort() };
    }
    if (!aplicar) return plano;
    await mapaPar(tarefas, 3, async x => {
      try {
        await comTrava(`empresa:${x.c.empresaId}`, async () => {
          const card = { ...x.c, stageId: x.it.stageId };
          const ok = await atualizarCard(card, { data: x.nova, classe: x.classe }, 'ajuste das datas iniciais por classe');
          if (ok) {
            store.addHistorico({ tipo: 'ajuste-inicial', classe: x.classe, card: x.c.id, empresaId: x.c.empresaId, empresa: x.c.empresa, segmento: x.c.segmento, cargo: x.c.cargo, anterior: x.c.data, nova: x.nova, motivo: 'Ajuste das datas iniciais por classe (A 30, B 60, C 90 dias; estratégicos em março)', autorNome: 'App' });
            if (store.config.tarefaAtiva) await moverPrazoTarefas(x.c.id, x.nova).catch(() => {});
            plano.aplicados++;
          }
        });
      } catch (e) { plano.erros.push(`${x.c.id}: ${e.message}`.slice(0, 140)); }
    });
    invalida();
    store.log('ajuste-datas', `Datas iniciais ajustadas por classe: ${plano.aplicados} card(s), ${plano.erros.length} erro(s)`);
    return plano;
  }
  // ---------- excluir visitas (controle de acesso) ----------
  // "Excluir" move o card para a etapa Removido (não apaga do Bitrix: dá para restaurar), encerra as tarefas e impede que a
  // sincronização recrie o card dessa empresa/linha até alguém restaurar.
  const idsLista = l => (l || []).map(Number).filter(Boolean);
  function podeExcluir(uid) {
    const c = store.config;
    return !!uid && (idsLista(c.acessoExcluir).includes(+uid) || idsLista(c.admins).includes(+uid));
  }
  async function excluirCard(cardId, { uid, motivo = '', bearer = null, gerarProxima: querProxima = true }) {
    if (!podeExcluir(uid)) throw erro('Você não tem permissão para excluir visitas. Peça a um administrador em Configurações → Acesso.', 403);
    if (!await podeVerCard(bearer, cardId)) throw erro('Você não tem acesso a esta visita.', 403);
    const { map } = await campos();
    if (!map.etapas.removido) throw erro('Não encontrei a etapa "Removido" no kanban da Fila.', 500);
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    if (card.stageId === map.etapas.removido) throw erro('Esta visita já foi excluída.', 409);
    const chave = R.chaveFila(card.empresaId, card.segmento, card.cargo);
    await comTrava(`empresa:${card.empresaId}`, async () => {
      await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: { stageId: map.etapas.removido } });
      if (store.chave(chave) === card.id) store.setChave(chave, null);
      const ex = { ...(store.job('excluidos') || {}) };
      if (querProxima) delete ex[chave];                // vai nascer a próxima visita do ciclo: nada a bloquear
      else ex[chave] = { card: card.id, empresaId: card.empresaId, empresa: card.empresa, segmento: card.segmento, cargo: card.cargo, data: card.data, stageAntes: card.stageId, por: +uid, em: new Date().toISOString(), motivo: String(motivo || '').trim() };
      store.setJob('excluidos', ex);
      store.setSnapCard(card.id, { data: card.data, resp: card.responsavel });
    });
    const nome = await nomeUsuario(uid);
    try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: card.id, ENTITY_TYPE: DYN(F.ETYPE.fila), COMMENT: `Visita excluída por ${nome} em ${clock().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.${motivo ? `\nMotivo: ${String(motivo).trim()}` : ''}` } }); } catch { /* comentário é opcional */ }
    await encerrarTarefas(card.id, 'Visita excluída.');
    store.log('card-excluido', `Card ${card.id} (${card.titulo}) excluído por ${nome}${motivo ? `: ${String(motivo).trim()}` : ''}`, { card: card.id });
    const prox = querProxima ? await gerarProximaVisita(card) : null;
    invalida();
    return { ok: true, id: card.id, proxima: prox };
  }
  // Próxima visita do ciclo depois de pular/excluir uma: parte da data do card (ou de hoje, se ele já estava atrasado) + intervalo da classe.
  async function gerarProximaVisita(card) {
    const emp = await lerEmpresa(card.empresaId).catch(() => null);
    if (!emp) return { criada: false, motivo: 'empresa não encontrada' };
    const s = emp.segs?.[card.segmento] || {}, classe = s.classe, resp = s[String(card.cargo).toLowerCase()] || card.responsavel;      // vale o que está no cadastro da empresa
    if (!R.CLASSES.includes(classe)) return { criada: false, motivo: 'a empresa está sem classe no cadastro' };
    if (!resp) return { criada: false, motivo: 'sem responsável no cargo' };
    const chave = R.chaveFila(card.empresaId, card.segmento, card.cargo);
    const jaTem = (await cardsAbertosDaEmpresa(card.empresaId)).some(it => R.chaveFila(card.empresaId, ...String(it.title).split(' | ').slice(1, 3)) === chave);
    if (jaTem) return { criada: false, motivo: 'já existe uma visita aberta' };
    const h = hoje(), base = card.data && card.data > h ? card.data : h;
    const data = classe === 'E' ? R.addMonths(base, 6) : R.addDays(base, R.intervalo(store.config, card.cargo, classe) || 30);
    const id = await comTrava(`empresa:${card.empresaId}`, () => criarCard({ empresa: emp, seg: card.segmento, cargo: card.cargo, classe, responsavel: resp, data }));
    store.log('card-criado', `Próxima visita ${id} gerada após exclusão do card ${card.id}: ${R.fmtBR(data)}`, { card: id });
    if (store.config.atualizarProxima) await gravarProxima(emp, card.segmento).catch(() => {});
    return { criada: true, id, data };
  }
  // Para visitas já excluídas (lista de excluídas): libera a recriação e gera a próxima do ciclo.
  async function gerarProximaDeExcluida(cardId, { uid }) {
    if (!podeExcluir(uid)) throw erro('Você não tem permissão para isso.', 403);
    const { map } = await campos();
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    if (card.stageId !== map.etapas.removido) throw erro('Esta visita não está excluída.', 409);
    const chave = R.chaveFila(card.empresaId, card.segmento, card.cargo);
    const ex = { ...(store.job('excluidos') || {}) }; delete ex[chave]; store.setJob('excluidos', ex);
    const r = await gerarProximaVisita(card);
    invalida();
    return { ok: true, proxima: r };
  }
  async function restaurarCard(cardId, { uid }) {
    if (!podeExcluir(uid)) throw erro('Você não tem permissão para restaurar visitas.', 403);
    const { map } = await campos();
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    if (card.stageId !== map.etapas.removido) throw erro('Esta visita não está excluída.', 409);
    const chave = R.chaveFila(card.empresaId, card.segmento, card.cargo);
    const abertos = (await cardsAbertosDaEmpresa(card.empresaId)).filter(it => R.chaveFila(card.empresaId, ...String(it.title).split(' | ').slice(1, 3)) === chave);
    if (abertos.length) throw erro('Já existe uma visita aberta para esta empresa e linha.', 409);
    const stage = map.etapas[R.etapaPara(card.data, hoje())] || map.etapas.aguardando;
    await comTrava(`empresa:${card.empresaId}`, async () => {
      await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: { stageId: stage } });
      store.setChave(chave, card.id);
      const ex = { ...(store.job('excluidos') || {}) }; delete ex[chave]; store.setJob('excluidos', ex);
      store.setSnapCard(card.id, { data: card.data, resp: card.responsavel });
    });
    store.log('card-restaurado', `Card ${card.id} (${card.titulo}) restaurado por ${await nomeUsuario(uid)}`, { card: card.id });
    invalida();
    return { ok: true, id: card.id };
  }
  async function listarExcluidos() {
    const ex = store.job('excluidos') || {};
    return Promise.all(Object.values(ex).sort((a, b) => String(b.em).localeCompare(String(a.em))).map(async x => ({ ...x, porNome: await nomeUsuario(x.por) })));
  }
  // Remoção automática (regra do cadastro): move o card para Removido, encerra tarefas, comenta no card e registra no log.
  async function removerCardAuto(card, motivo) {
    const { map } = await campos();
    if (!map.etapas.removido || card.stageId === map.etapas.removido) return false;
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: { stageId: map.etapas.removido } });
    const chave = R.chaveFila(card.empresaId, card.segmento, card.cargo);
    if (store.chave(chave) === card.id) store.setChave(chave, null);
    try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: card.id, ENTITY_TYPE: DYN(F.ETYPE.fila), COMMENT: `Visita removida automaticamente. ${motivo}` } }); } catch { /* opcional */ }
    await encerrarTarefas(card.id, 'Visita removida automaticamente.');
    store.log('card-removido-auto', `Card ${card.id} (${card.titulo}) removido: ${motivo}`, { card: card.id, empresa: card.empresaId });
    envelhece();
    return true;
  }
  // Rede de segurança: confere de hora em hora as empresas que ainda têm card aberto e sincroniza as que ficaram sem classe.
  async function reconciliarSemClasse() {
    if (store.config.removerSemClasse === false) return { empresas: 0, removidos: 0 };
    const abertos = await cardsAbertos();
    const ids = [...new Set(abertos.map(it => +it.companyId).filter(Boolean))];
    const sem = []; let i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => { while (i < ids.length) { const id = ids[i++]; const e = await lerEmpresa(id).catch(() => null); if (e && R.SEGMENTOS.some(sg => !R.CLASSES.includes(e.segs?.[sg]?.classe))) sem.push(id); } }));
    let removidos = 0;
    for (const id of sem) { try { const r = await sincronizarEmpresa(id); removidos += (r.removidosAuto || []).length; } catch (e) { store.log('erro', `Classe em branco, empresa ${id}: ${e.message}`); } }
    if (removidos) store.log('reconciliacao', `Classe em branco: ${removidos} card(s) removido(s)`);
    return { empresas: sem.length, removidos };
  }
  // Prévia (só leitura) de "encerrar a fila atual e começar um novo ciclo": para cada card aberto calcula a data que o card teria
  // se fosse recriado hoje pelas regras (mesma conta da sincronização). Não escreve nada no Bitrix.
  async function previaNovoCiclo() {
    const h = hoje(), cfg = store.config;
    const abertos = await cardsAbertos();
    const cs = []; for (const it of abertos) cs.push(await dadosCard(it));
    const ids = [...new Set(cs.map(c => c.empresaId).filter(Boolean))];
    const emps = new Map(); { let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < ids.length) { const id = ids[i++]; emps.set(id, await lerEmpresa(id).catch(() => null)); } })); }
    const atual = { atrasada: 0, dia: 0, aguardando: 0 }, novo = { atrasada: 0, dia: 0, aguardando: 0 }, porCargo = {}, semRegra = {}, exemplos = [];
    const pend = []; let mesmaData = 0;
    for (const c of cs) {
      atual[R.etapaPara(c.data, h)]++;
      const emp = emps.get(c.empresaId), sg = emp?.segs?.[c.segmento] || {};
      const classe = sg.classe || c.classe, resp = sg[String(c.cargo).toLowerCase()];
      const n = R.intervalo(cfg, c.cargo, classe);
      const linha = { empresa: c.empresa, segmento: c.segmento, cargo: c.cargo, classe, ultima: sg.ultima || null, proxima: sg.proxima || null, atual: c.data };
      if (!emp || !resp || n === null) { const m = !emp ? 'empresa não encontrada' : !resp ? 'sem responsável no cargo' : 'classe inválida'; semRegra[m] = (semRegra[m] || 0) + 1; if (pend.length < 8) pend.push({ ...linha, motivo: m }); continue; }
      const primeira = c.cargo === 'Vendedor' && !sg.ultima;
      const calc = primeira ? h : R.dataProgramada(cfg, { cargo: c.cargo, classe, ultima: sg.ultima, hoje: h });
      const data = (c.cargo === 'Vendedor' && sg.ultima && sg.proxima) ? sg.proxima : calc;
      const sit = R.etapaPara(data, h); novo[sit]++;
      (porCargo[c.cargo] ||= { atrasada: 0, dia: 0, aguardando: 0 })[sit]++;
      if (data === c.data) mesmaData++;
      if (exemplos.length < 12 && sit === 'atrasada') exemplos.push({ ...linha, nova: data });
    }
    return { hoje: h, abertos: cs.length, empresas: ids.length, atual, novo, porCargo, semRegra, mesmaData, pendentes: pend, exemplosAtrasados: exemplos };
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
      if ((await dadosCard(it)).classe === 'E') { store.setSnapCard(+it.id, { data: atual, resp: +it.assignedById }); continue; }   // estratégicos: edição direta é aceita
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
    const novo = R.parseBR(dataHora);
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
    if (cicloRodando) return { pulado: true, ciclo: true };
    if (rodando) return { pulado: true };
    rodando = true;
    const inicio = new Date(Date.now() - 5 * 60e3).toISOString();
    try {
      await campos();
      const guardas = { visitas: await guardarVisitas(), cards: await guardarCards(await cardsAbertos()) };
      if (!store.job('semClasse') || Date.now() - Date.parse(store.job('semClasse')) > 3600e3) { guardas.semClasse = await reconciliarSemClasse(); store.setJob('semClasse', new Date().toISOString()); }
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
  // Modo 'bitrix': quem vê o quê vem dos papéis/departamentos do Bitrix (o app só soma o que o Bitrix liberou). Sem a sessão do usuário cai nas regras do app.
  const modoBitrix = permitidos => store.config.visibilidade === 'bitrix' && !!permitidos;
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
    const todos = escopo === 'todas' || (escopo === 'auto' && (modoBitrix(permitidos) || await enxergaTudo(uid)));
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
    const cargosAtivos = new Set(['Vendedor', ...(store.config.cargosFila || [])]);       // cards antigos de Supervisor/Coordenador/etc. (modelo anterior) não aparecem
    for (const [lista, fechado] of [[abertosL, false], [fechadosL, true]]) for (const it of lista) {
      if (permitidos && !permitidos.has(+it.id)) continue;
      const c = await dadosCard(it), reg = store.card(it.id) || {};
      if (!cargosAtivos.has(c.cargo)) continue;
      let eq = reg.equipe;
      if (!eq) { const e = await empresaCurta(c.empresaId); eq = e ? equipeIds(e.segs?.[c.segmento]) : null; }
      if ((reg.participantes || []).length) eq = { ...(eq || {}), ...Object.fromEntries(reg.participantes.map((u, i) => ['extra' + i, u])) };
      const doCampo = eq && eq[String(c.cargo || '').toLowerCase()];
      if (doCampo) c.responsavel = +doCampo;
      const propria = +c.responsavel === +uid;
      if (!todos && !propria) {
        if (escopo === 'minhas') continue;
        if (escopo === 'auto' && !time.has(+c.responsavel) && !Object.values(eq || {}).map(Number).includes(+uid)) continue;
      }
      const situacao = fechado ? (it.stageId === map.etapas.naoRealizada ? 'naorealizada' : 'finalizado') : R.etapaPara(c.data, h);
      leves.push({ it, c, reg, fechado, situacao, vendId: (eq || {}).vendedor || null, part: reg.participantes || [] });
    }
    const supIdx = await supervisorPorCard().catch(() => new Map());
    // 2) contadores e opções (sobre o que o usuário pode ver, dentro do período escolhido)
    const faixa = (() => {
      if (per === 'hoje') return [h, h];
      if (per === 'semana') { const dow = (new Date(h + 'T12:00:00Z').getUTCDay() + 6) % 7; return [R.addDays(h, -dow), R.addDays(h, 6 - dow)]; }
      if (per === 'mes') return [`${h.slice(0, 7)}-01`, R.ultimoDiaDoMes(h.slice(0, 7))];
      if (per === 'proximos') return [R.addDays(R.ultimoDiaDoMes(h.slice(0, 7)), 1), '9999-12-31'];        // meses seguintes (próximos ciclos)
      if (per === 'custom') return [R.isoDate(de) || '0000-01-01', R.isoDate(ate) || '9999-12-31'];
      return null;
    })();
    // Visitas não realizadas são, por definição, de meses anteriores: o filtro padrão "este mês" não as esconde.
    const dentro = l => !faixa || (per === 'mes' && l.situacao === 'naorealizada') || !!(l.c.data && l.c.data >= faixa[0] && l.c.data <= faixa[1]);
    const counts = { abertas: 0, atrasada: 0, dia: 0, aguardando: 0, finalizado: 0, naorealizada: 0 };
    for (const l of leves) { if (!dentro(l)) continue; counts[l.situacao]++; if (!l.fechado) counts.abertas++; }
    const nomeDe = id => memo(`nome:${id}`, 600e3, () => nomeUsuario(id));
    const vendIds = [...new Set(leves.map(l => l.vendId).filter(Boolean))], respIds = [...new Set(leves.map(l => +l.c.responsavel).filter(Boolean))];
    const opcoes = {
      segmentos: [...new Set(leves.map(l => l.c.segmento).filter(Boolean))].sort(),
      ramos: (await listaRamos()).map(r => ({ id: r.id, nome: r.nome })).sort((a, b) => a.nome.localeCompare(b.nome)),
      vendedores: (await Promise.all(vendIds.map(async id => ({ id, nome: await nomeDe(id) })))).sort((a, b) => a.nome.localeCompare(b.nome)),
      responsaveis: (await Promise.all(respIds.map(async id => ({ id, nome: await nomeDe(id) })))).sort((a, b) => a.nome.localeCompare(b.nome)),
      supervisores: (await Promise.all([...new Set(leves.map(l => supIdx.get(String(l.c.id))).filter(Boolean))].map(async id => ({ id, nome: await nomeDe(id) })))).sort((a, b) => a.nome.localeCompare(b.nome)),
    };
    // 3) filtros
    const busca = R.norm(q);
    let sel = leves.filter(l => (status === 'todas' || (status === 'abertas' ? !l.fechado : l.situacao === status))
      && dentro(l)
      && (!busca || R.norm(l.c.empresa).includes(busca)) && (!seg || l.c.segmento === seg) && (!classe || (l.c.classe || l.reg.classe) === classe)
      && (!resp || String(l.c.responsavel) === String(resp))
      && (!p.sup || (p.sup === 'todos' ? supIdx.has(String(l.c.id)) : String(supIdx.get(String(l.c.id))) === String(p.sup))));
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
    const total = sel.length;
    let paginas = Math.max(1, Math.ceil(total / size)), pagina = Math.min(Math.max(1, +p.page || 1), paginas), fatia, colunas = null;
    if (p.kanban) {                                    // Kanban: as primeiras `size` visitas de CADA coluna (senão as atrasadas ocupam a página toda)
      colunas = {}; fatia = [];
      for (const sit of ['atrasada', 'dia', 'aguardando', 'finalizado', 'naorealizada']) { const g = sel.filter(l => l.situacao === sit); colunas[sit] = g.length; fatia.push(...g.slice(0, size)); }
      paginas = 1; pagina = 1;
    } else fatia = sel.slice((pagina - 1) * size, pagina * size);
    // 5) só a página busca empresa/nomes
    let base = null; try { base = new URL(bitrix.base).origin; } catch { /* sem webhook */ }
    const visitas = await mapaPar(fatia, 6, async l => {
      const { it, c, reg } = l;
      const emp = await empresaCurta(c.empresaId);
      const sg = emp?.segs?.[c.segmento] || {};
      const equipe = {};
      for (const k of ['vendedor', 'supervisor', 'coordenador', 'gerente', 'diretor']) if (sg[k]) equipe[k] = await nomeDe(sg[k]);
      if (emp && (JSON.stringify(reg.equipe) !== JSON.stringify(equipeIds(sg)) || reg.ramo !== (emp.ramo || ''))) store.setCard(it.id, { ...reg, empresaId: c.empresaId, empresa: emp.nome, seg: c.segmento, cargo: c.cargo, equipe: equipeIds(sg), ramo: emp.ramo || '' });
      const tipoEmp = await memo(`tipo:${c.empresaId}`, 300e3, () => tipoDaEmpresa(emp));
      return ({ ...c, supervisorId: supIdx.get(String(c.id)) || null, supervisorNome: supIdx.get(String(c.id)) ? await nomeDe(supIdx.get(String(c.id))) : '', segmentoEmpresa: await nomeRamo(emp?.ramo), tipoEmpresa: tipoEmp || '', responsavelNome: await nomeDe(c.responsavel), classe: c.classe || reg.classe || '', situacao: l.situacao,
        encerradoEm: l.fechado && it.updatedTime ? R.todayBR(new Date(it.updatedTime)) : null, dias: !l.fechado && c.data ? R.dayDiff(h, c.data) : null,
        ultima: sg.ultima || null, diasDesdeUltima: sg.ultima ? R.dayDiff(sg.ultima, h) : null, ciclo: R.intervalo(store.config, c.cargo, c.classe || reg.classe),
        livre: c.classe === 'E', altMin: c.classe === 'E' ? h : R.addDays(h, 1), altMax: c.classe === 'E' ? R.addDays(h, 730) : R.ultimoDiaDoMes(R.mesLimite(c.data, it.createdTime ? R.todayBR(new Date(it.createdTime)) : null) || h.slice(0, 7)),
        equipe, participantes: await Promise.all((l.part || []).map(async id => ({ id, nome: await nomeDe(id) }))), reprogramacoes: store.historico.filter(x => x.card === c.id && !x.tipo).length,
        urlEmpresa: base && c.empresaId ? `${base}/crm/company/details/${c.empresaId}/` : null, urlCard: base ? `${base}/crm/type/${F.ETYPE.fila}/details/${c.id}/` : null });
    });
    return { hoje: h, bitrix: !!permitidos, visao: todos ? 'tudo' : (time.size > 1 || leves.some(l => +l.c.responsavel !== +uid) ? 'equipe' : 'minhas'), total, pagina, paginas, tamanho: size, colunas, counts, opcoes, visitas, motivosNR: store.config.motivosNaoRealizada || [] };
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
      const permCards = await permitidosBitrix(bearer, F.ETYPE.fila), permVis = await permitidosBitrix(bearer, F.ETYPE.visita);
      const todos = modoBitrix(permCards) || await enxergaTudo(uid);
      const time = todos ? null : await equipeDe(uid);
      const visivelPor = (resp, eq) => todos || +resp === +uid || (time && time.has(+resp)) || Object.values(eq || {}).map(Number).includes(+uid);
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
      if (!['Vendedor', ...(store.config.cargosFila || [])].includes(d.cargo)) continue;
      const vendId = (reg.equipe || {}).vendedor || ((await empDe(d.empresaId))?.segs?.[d.segmento] || {}).vendedor;
      cards.push({ ramo: await nomeRamo((await empDe(d.empresaId))?.ramo), vendedor: vendId ? await nome(vendId) : '', id: d.id, empresaId: d.empresaId, empresa: d.empresa, segmento: d.segmento, cargo: d.cargo, classe: d.classe || reg.classe || '', tipo: await tipoDe(d.empresaId), resp: d.responsavel, respNome: await nome(d.responsavel), _eq: { ...(reg.equipe || {}), ...Object.fromEntries((reg.participantes || []).map((u, i) => ['extra' + i, u])) },
        motivo: d.motivoNR, detalhe: d.detalheNR, supervisorId: +((reg.equipe || {}).supervisor) || null, supervisorNome: (reg.equipe || {}).supervisor ? await nome(+reg.equipe.supervisor) : '', vendedorId: +((reg.equipe || {}).vendedor) || null,
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
      const supId = supervisorDoRegistro(it, map);
      visitas.push({ card: v.filaId ? (+it[v.filaId] || null) : null, supervisor: supId, supervisorNome: supId ? await nome(supId) : '', ramo: await nomeRamo((await empDe(+it.companyId || 0))?.ramo), vendedor: await nome(+it.assignedById), id: +it.id, empresaId: +it.companyId || null, empresa: '', quando: q, dia, resp: +it.assignedById, respNome: await nome(+it.assignedById), segmento: v.segmento ? F.decode(meta, v.segmento, it[v.segmento]) : '',
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
    if (modoBitrix(perm) || await enxergaTudo(uid)) return todos;
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
        const us = await todosUsuarios({ UF_DEPARTMENT: alvo, ACTIVE: true });
        us.forEach(u => ids.add(+u.ID));
      }
    } catch (e) { store.log('aviso', `Equipe de ${uid}: ${e.message}`); }
    return ids;
  }
  async function departamentos() {
    const deps = (await bitrix.call('department.get', {})).result || [];
    const us = await todosUsuarios({ ACTIVE: true });
    const nome = u => `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || `#${u.ID}`;
    const porId = new Map(us.map(u => [+u.ID, nome(u)])), cont = new Map();
    for (const u of us) for (const d of [].concat(u.UF_DEPARTMENT || [])) cont.set(+d, (cont.get(+d) || 0) + 1);
    return deps.map(d => ({ id: +d.ID, nome: String(d.NAME || '').trim(), pai: +d.PARENT || null, chefe: +d.UF_HEAD || null, chefeNome: porId.get(+d.UF_HEAD) || '', pessoas: cont.get(+d.ID) || 0 }));
  }
  // "Ver como": o que um usuário enxerga pelas regras do app (sem a sessão dele não dá para aplicar o recorte do Bitrix).
  async function verComo(uid) {
    const r = await listarVisitasPag({ uid: +uid, bearer: null, escopo: 'auto', status: 'abertas', page: 1, size: 1000 });
    const nomes = new Map(); for (const v of r.visitas) nomes.set(v.empresa, (nomes.get(v.empresa) || 0) + 1);
    return { usuario: +uid, nome: await nomeUsuario(+uid), visao: r.visao, total: r.total, counts: r.counts, empresas: [...nomes.entries()].slice(0, 15).map(([nome, n]) => ({ nome, visitas: n })), modo: store.config.visibilidade || 'app' };
  }
  // user.get devolve 50 por chamada: percorre todas as páginas (senão a lista de usuários e as equipes ficam cortadas)
  async function todosUsuarios(filter) {
    const out = []; let start = 0;
    for (;;) {
      const r = await bitrix.call('user.get', { filter, start });
      out.push(...(r.result || []));
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    return out;
  }
  async function usuarios() {
    const r = await todosUsuarios({ ACTIVE: true });
    return r.map(u => ({ id: +u.ID, nome: `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || `#${u.ID}` })).sort((a, b) => a.nome.localeCompare(b.nome));
  }
  async function visitasRegistradas(limit = 50) {
    const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.visita, order: { id: 'desc' }, select: ['*', 'uf*'] });
    return (r.result?.items || []).slice(0, limit).map(i => ({ id: +i.id, titulo: i.title, responsavel: +i.assignedById, em: i.createdTime }));
  }

  return { campos, lerEmpresa, dadosCard, marcarNaoRealizada, informarMotivo, camposVisita, formEdicao, editarRegistro, supervisoresDoBitrix, sincronizarEmpresa, sincronizarTodas, jobDiario, registrarVisita, reprogramar, corrigirVisita, varrer, listarVisitas, usuarios, departamentos, reconciliarCadastros, listarVisitasPag, encerrarNaoRealizadas, tarefasAbertas, migrarFinalizadas, reconciliarVisitas, historicoVisivel, podeVerCard, podeConfigurar, podeDashboard, acessoRestrito, dashboardDados, registroVisita, verComo, aquecer, previaNovoCiclo, novoCiclo, reconciliarSemClasse, podeExcluir, excluirCard, restaurarCard, gerarProximaDeExcluida, listarExcluidos, ajustarDatasIniciais, definirParticipantes, listaRamos, visitasRegistradas, isAdmin, nomeUsuario, lerCard, guardarVisitas, guardarCards, cardsAbertos };
}
module.exports = { createService };
