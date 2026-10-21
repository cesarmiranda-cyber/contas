'use strict';
const R = require('./rules');
const F = require('./fields');
const Duplicados = require('./duplicados');

const CACHE_MS = 5 * 60 * 1000;
const DYN = id => `dynamic_${id}`;
const hex = n => n.toString(16);

function createService({ bitrix, store, clock = () => new Date() }) {
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
  async function tipoDaEmpresa(emp) {
    if (!emp) return '';
    if (emp.tipo) return emp.tipo;
    if (!emp.ramo) return '';
    return ((await listaRamos()).find(r => r.id === emp.ramo) || {}).tipo || '';
  }
  // ---------- cards da fila ----------
  const tituloCard = (empresa, seg, cargo) => `${empresa} | ${seg} | ${cargo}`;
  async function lerCard(id) {
    const { map } = await campos();
    const it = (await bitrix.call('crm.item.get', { entityTypeId: F.ETYPE.fila, id })).result?.item;
    if (!it) return null;
    return { ...(await dadosCard(it)), aberto: it.stageId !== map.etapas.finalizado };
  }
  async function cardsAbertos() {
    const { map } = await campos();
    const out = [];
    let start = 0;
    for (;;) {
      const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.fila, filter: { '!stageId': map.etapas.finalizado }, select: ['*', 'uf*'], start });
      out.push(...(r.result?.items || []));
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    return out;
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
      data: (R.isoDate(map.fila.data ? it[map.fila.data] : null) || R.isoDate(it.closedate)), stageId: it.stageId,
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
    store.setCard(+r.id, { empresaId: empresa.id, empresa: empresa.nome, seg, cargo, classe, chave, equipe: equipeIds(empresa.segs[seg]) });
    store.setSnapCard(+r.id, { data, resp: responsavel });
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
      if (st && card.stageId !== map.etapas.finalizado) f.stageId = st;
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
  async function sincronizarEmpresa(id, { forcar = false } = {}) {
    const cfg = store.config;
    const emp = await lerEmpresa(id);
    if (!emp) return { empresa: id, erro: 'Empresa não encontrada' };
    if (cfg.hierarquiaAuto || Object.keys(cfg.alcadas || {}).length) await preencherHierarquia(emp, (await campos()).map).catch(e => store.log('aviso', `Hierarquia: ${e.message}`));
    const res = { empresa: id, criados: [], atualizados: [], pendencias: [] };
    const snapAnt = store.snapEmpresa(id) || {};
    const snapNovo = {};
    const abertos = new Map();
    for (const it of await cardsAbertosDaEmpresa(id)) {
      const c = await dadosCard(it);
      abertos.set(R.chaveFila(id, c.segmento, c.cargo), { ...c, stageId: it.stageId });
    }
    for (const seg of R.SEGMENTOS) {
      const s = emp.segs[seg];
      if (!s.vendedor && !s.supervisor && !s.coordenador && !s.gerente && !s.classe) continue; // segmento não usado
      if (!s.diretor) s.diretor = await diretorDe(s.gerente);
      for (const cargo of R.CARGOS) {
        const resp = s[cargo.toLowerCase()];
        const k = `${seg}|${cargo}`;
        snapNovo[k] = { classe: s.classe, resp, ultima: s.ultima };
        const motivo = [];
        if (!resp) motivo.push('sem responsável');
        if (!R.CLASSES.includes(s.classe)) motivo.push('classe não selecionada');
        if (motivo.length) { res.pendencias.push(`${seg} · ${cargo}: ${motivo.join(' e ')}`); continue; }
        const chave = R.chaveFila(id, seg, cargo);
        const calc = R.dataProgramada(cfg, { cargo, classe: s.classe, ultima: s.ultima, hoje: hoje() });
        const existente = abertos.get(chave);
        if (!existente) {
          const idx = store.chave(chave);
          if (idx) { // índice local aponta para card que já não está aberto: libera a chave
            store.setChave(chave, null);
          }
          res.criados.push(await criarCard({ empresa: emp, seg, cargo, classe: s.classe, responsavel: resp, data: calc }));
          continue;
        }
        store.setChave(chave, existente.id);
        { const reg = store.card(existente.id) || {}, eq = equipeIds(s); if (JSON.stringify(reg.equipe) !== JSON.stringify(eq)) store.setCard(existente.id, { ...reg, empresaId: id, empresa: emp.nome, seg, cargo, equipe: eq }); }
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
    const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.fila, filter: { companyId: id, '!stageId': map.etapas.finalizado }, select: ['*', 'uf*'] });
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
    const filter = desde ? { '>DATE_MODIFY': desde } : {};
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
    const r = { dia: 0, atrasadas: 0 };
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
  const TIPOS = { string: 'texto', char: 'texto', integer: 'numero', double: 'numero', money: 'numero', date: 'data', datetime: 'datahora', boolean: 'sim_nao', enumeration: 'lista', employee: 'usuario', url: 'texto', address: 'texto' };
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
    const vazio = x => x === undefined || x === null || String(x).trim() === '' || (Array.isArray(x) && !x.length);
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
    // finaliza o card na hora (sem depender de tarefa/campo de conclusão)
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: { stageId: map.etapas.finalizado } });
    store.setChave(R.chaveFila(card.empresaId, card.segmento, card.cargo), null);
    passos.push('card finalizado');
    // Última Visita do segmento + próximo card com a data nova
    const campoUlt = map.empresa[card.segmento]?.ultima;
    if (campoUlt) {
      await bitrix.call('crm.company.update', { id: card.empresaId, fields: { [campoUlt]: dia } });
      passos.push('última visita atualizada');
    }
    const s = emp?.segs[card.segmento];
    const classe = s?.classe || card.classe;
    let proximo = null;
    const novaData = R.dataProgramada(store.config, { cargo: card.cargo, classe, ultima: dia, hoje: hoje() });
    if (novaData && emp) {
      proximo = await criarCard({ empresa: emp, seg: card.segmento, cargo: card.cargo, classe, responsavel: s[card.cargo.toLowerCase()] || card.responsavel || uid, data: novaData });
      passos.push(`próximo card ${proximo} (${R.fmtBR(novaData)})`);
    }
    // o app grava "última visita" na empresa: atualiza o snapshot para não recalcular os outros cargos
    const snap = store.snapEmpresa(card.empresaId) || {};
    for (const k of Object.keys(snap)) if (k.startsWith(card.segmento + '|')) snap[k].ultima = dia;
    store.setSnapEmpresa(card.empresaId, snap);
    if (store.config.tarefaAtiva) await criarTarefa(v, card, uid, agora).then(() => passos.push('tarefa criada'), e => store.log('aviso', `Tarefa não criada: ${e.message}`));
    store.log('visita', `Visita ${v.id} registrada por ${uid} no card ${card.id} (antecipada: ${ant ? 'sim' : 'não'}): ${passos.join(', ')}`, { card: card.id, visita: +v.id });
    return { visita: +v.id, antecipada: ant, proximoCard: proximo, proximaData: novaData, passos };
  }
  async function criarTarefa(visita, card, uid, agora) {
    await bitrix.call('tasks.task.add', { fields: {
      TITLE: `Realizar Visita - ${card.empresa}`, RESPONSIBLE_ID: uid, DEADLINE: R.prazoUtil(agora, store.config.tarefaHorasUteis),
      UF_CRM_TASK: [`T${hex(F.ETYPE.visita)}_${visita.id}`],
    } });
  }

  // ---------- reprogramar ----------
  async function reprogramar(cardId, { uid, nova, motivo }) {
    const { map } = await campos();
    const card = await lerCard(cardId);
    if (!card) throw erro('Card da fila não encontrado.', 404);
    if (!card.aberto) throw erro('Visita já finalizada não pode ser reprogramada.', 409);
    if (!uid) throw erro('Usuário não identificado.', 401);
    if (!card.data) throw erro('O card não tem data programada.');
    const msg = R.validarReprogramacao({ atual: card.data, nova, motivo });
    if (msg) throw erro(msg, 422);
    const stage = map.etapas[R.etapaPara(nova, hoje())];
    await bitrix.call('crm.item.update', { entityTypeId: F.ETYPE.fila, id: card.id, fields: { [map.fila.data || 'closedate']: nova, ...(stage ? { stageId: stage } : {}) } });
    store.setSnapCard(card.id, { data: nova, resp: card.responsavel });
    const nome = await nomeUsuario(uid);
    const agora = clock().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    store.addHistorico({ card: card.id, empresaId: card.empresaId, empresa: card.empresa, segmento: card.segmento, cargo: card.cargo, anterior: card.data, nova, motivo: motivo.trim(), autor: uid, autorNome: nome, responsavel: card.responsavel });
    try {
      await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: card.id, ENTITY_TYPE: DYN(F.ETYPE.fila),
        COMMENT: `Visita reprogramada em ${agora} por ${nome}.\nData anterior: ${R.fmtBR(card.data)}\nNova data: ${R.fmtBR(nova)}\nMotivo: ${motivo.trim()}` } });
    } catch (e) { store.log('aviso', `Comentário na linha do tempo do card ${card.id} falhou: ${e.message}`); }
    store.log('reprogramacao', `Card ${card.id}: ${R.fmtBR(card.data)} → ${R.fmtBR(nova)} por ${uid}: ${motivo.trim()}`, { card: card.id });
    return { ok: true, data: nova };
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
  async function guardarVisitas() {
    const { map } = await campos();
    const campo = map.visita.dataHora || 'begindate';
    const r = await bitrix.call('crm.item.list', { entityTypeId: F.ETYPE.visita, order: { id: 'desc' }, select: ['id', 'assignedById', 'title', campo], filter: store.lastSweep ? { '>updatedTime': store.lastSweep } : {} });
    let revertidos = 0;
    for (const it of r.result?.items || []) {
      const atual = it[campo], snap = store.snapVisita(it.id);
      if (!snap) { store.setSnapVisita(+it.id, { dt: atual, campo }); continue; }
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
      await notificar(+it.assignedById, `A data programada de "${it.title}" só pode ser alterada pelo botão "Reprogramar visita". A data foi restaurada.`);
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
  async function varrer() {
    if (!store.config.ativo) return { pausado: true };
    if (rodando) return { pulado: true };
    rodando = true;
    const inicio = new Date(Date.now() - 2 * 60e3).toISOString();
    try {
      await campos();
      const guardas = { visitas: await guardarVisitas(), cards: await guardarCards(await cardsAbertos()) };
      // primeira varredura depois de ativar: não processa as 11 mil empresas de uma vez, só as alteradas daqui em diante
      const emp = store.lastSweep ? await sincronizarTodas({ desde: store.lastSweep }) : [];
      let job = null;
      if (R.hourBR(clock()) >= store.config.horaJob) job = await jobDiario();
      store.setLastSweep(inicio);
      return { guardas, empresas: emp.length, job };
    } finally { rodando = false; }
  }

  // ---------- consultas para a interface ----------
  // Quem enxerga tudo: administradores, quem está em "verTudo" e o chefe do departamento raiz (a diretoria).
  async function enxergaTudo(uid) {
    const c = store.config;
    if ((c.admins || []).map(Number).includes(+uid) || (c.verTudo || []).map(Number).includes(+uid)) return true;
    try { const deps = (await bitrix.call('department.get', {})).result || []; return deps.some(d => !+d.PARENT && +d.UF_HEAD === +uid); } catch { return false; }
  }
  // escopo 'auto': vendedor vê os seus; supervisor/coordenador/gerente veem a equipe (quem aparece acima do vendedor na empresa
  // ou chefia o departamento do responsável); diretoria/administração vê tudo.
  async function listarVisitas({ uid, escopo = 'auto' }) {
    const { map } = await campos();
    const itens = (await cardsAbertos());
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
      out.push({ ...c, tipoEmpresa: tipos.get(c.empresaId) || '', responsavelNome: await nomeUsuario(c.responsavel), classe: c.classe || reg.classe || '',
        situacao: R.etapaPara(c.data, hoje()), dias: c.data ? R.dayDiff(hoje(), c.data) : null,
        ultima: sg.ultima || null, diasDesdeUltima: sg.ultima ? R.dayDiff(sg.ultima, hoje()) : null, ciclo: R.intervalo(store.config, c.cargo, c.classe || reg.classe),
        equipe, reprogramacoes: store.historico.filter(h => h.card === c.id && !h.tipo).length, urlEmpresa: base && c.empresaId ? `${base}/crm/company/details/${c.empresaId}/` : null, urlCard: base ? `${base}/crm/type/${F.ETYPE.fila}/details/${c.id}/` : null });
    }
    out.sort((a, b) => (a.data || '9').localeCompare(b.data || '9'));
    return { hoje: hoje(), visao: todos ? 'tudo' : (time.size > 1 || out.some(v => +v.responsavel !== +uid) ? 'equipe' : 'minhas'), visitas: out };
  }
  // Histórico de reprogramações respeita a mesma regra de visibilidade das visitas.
  async function historicoVisivel(uid) {
    const todos = store.historico;
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

  return { campos, camposVisita, sincronizarEmpresa, sincronizarTodas, jobDiario, registrarVisita, reprogramar, corrigirVisita, varrer, listarVisitas, usuarios, departamentos, historicoVisivel, listaRamos, visitasRegistradas, isAdmin, nomeUsuario, lerCard, guardarVisitas, guardarCards, cardsAbertos };
}
module.exports = { createService };
