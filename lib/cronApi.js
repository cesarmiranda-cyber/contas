'use strict';
const fs = require('fs');
const path = require('path');
const K = require('./cron');
const FER = require('./feriados');
const R = require('./rules');
const { chave, similar, acharUnica } = require('./bxEmpresas');

const FUNIL = 6;   // "Assessoria Recorrente / RT"
// API do processo Cronograma (/api/cron/*). Clientes vêm do cadastro de empresas do Bitrix24; consultoras são usuários do Bitrix24.
function createCronApi({ bitrix, bx, funil, store, dir, seedFile, confSeedFile }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cron.json');
  let d = { consultoras: [], clientes: [], visitas: [], modelos: [], feriadosCustom: [], conferencia: [], confMeses: {}, confGeral: { obsClientes: [] }, config: { funilId: FUNIL } };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* primeiro uso */ }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, file); };
  const hoje = () => R.todayBR();
  const need = (c, m, s = 400) => { if (!c) throw Object.assign(new Error(m), { status: s }); };
  const PAD = { cidade: 'São Paulo', uf: 'SP' };   // cliente sem cidade no cadastro: assume São Paulo/SP (aviso na tela)
  const cli = () => new Map(d.clientes.map(c => [c.id, { ...c, cidade: c.cidade || PAD.cidade, uf: c.uf || PAD.uf, cidadeAssumida: !c.cidade }]));
  const cons = id => d.consultoras.find(c => c.id === id || c.nome === id);
  const nomeCons = id => (cons(id) || {}).nome || id;

  // Carga inicial (uma vez): cronograma de outubro importado do PDF, preparado fora do repositório.
  if (seedFile && !d.semeado && !d.visitas.length && fs.existsSync(seedFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(seedFile, 'utf8')), porNome = new Map();
      for (const n of s.consultoras) d.consultoras.push({ id: K.uid('co'), nome: n, bitrixId: '' });
      for (const c of s.clientes) { const x = { id: K.uid('cl'), ...K.validaCliente(c), sugestaoId: c.sugestaoId || '' }; d.clientes.push(x); porNome.set(c.nome, x.id); }
      for (const v of s.visitas) { const c = d.consultoras.find(x => x.nome === v.consultora); if (c && porNome.has(v.cliente)) d.visitas.push({ id: K.uid('vs'), data: v.data, min: v.min, consultora: c.id, clienteId: porNome.get(v.cliente), status: 'agendada', obs: '', origem: 'importacao' }); }
      const bases = [...new Set(d.visitas.map(v => K.segunda(v.data)))].sort();
      d.modelos = K.derivaModelos(d.visitas, bases); d.semeado = true; save();
      store.log('cron', `Carga inicial: ${d.consultoras.length} consultora(s), ${d.clientes.length} cliente(s), ${d.visitas.length} visita(s), ${d.modelos.length} modelo(s) de recorrência`);
    } catch (e) { store.log('erro', `Cronograma: carga inicial falhou: ${e.message}`); }
  }

  // Carga inicial da lista de conferência (maio a outubro): um registro por estabelecimento e mês; clientes ligados aos do cronograma.
  if (confSeedFile && !d.conferenciaSemeada && fs.existsSync(confSeedFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(confSeedFile, 'utf8')), porChave = new Map(d.clientes.map(c => [chave(c.nome), c]));
      const consId = nome => { let c = d.consultoras.find(x => x.nome === nome); if (!c) { c = { id: K.uid('co'), nome, bitrixId: '' }; d.consultoras.push(c); } return c.id; };
      const acha = nome => {
        let c = porChave.get(chave(nome)) || d.clientes.find(x => similar(x.nome, nome) >= 0.8);
        if (!c) { const v = s.clientes[nome] || {}; c = { id: K.uid('cl'), ...K.validaCliente({ nome, ...v }), sugestaoId: v.sugestaoId || '' }; d.clientes.push(c); }
        porChave.set(chave(nome), c); return c;
      };
      const meses = Object.keys(s.meses).sort(); let n = 0;
      for (const m of meses) {
        d.confMeses[m] = { obs: s.meses[m].obsMes || [] };
        for (const l of s.meses[m].linhas) { const c = acha(l.nome); d.conferencia.push({ id: K.uid('cf'), mes: m, clienteId: c.id, estabelecimento: l.nome, consultoras: l.consultoras.map(consId), consultoraTxt: l.consultoraTxt, horasTxt: l.horasTxt, min: l.min, freqTxt: l.freqTxt, freqTipo: l.freqTipo, freqN: l.freqN, semanas: l.semanas, obs: '' }); n++;
          if (m === meses[meses.length - 1]) { c.freqTxt = l.freqTxt; c.horasTxt = l.horasTxt; if (l.consultoras[0]) c.consultoraPadrao = consId(l.consultoras[0]); } }
      }
      d.confGeral = { obsClientes: s.obsClientes || [] };
      for (const linha of d.confGeral.obsClientes) { const nome = linha.split(':')[0]; const c = d.clientes.find(x => similar(x.nome, nome) >= 0.5); if (c && linha.includes(':')) c.restricao = linha.slice(linha.indexOf(':') + 1).trim().replace(/;$/, ''); }
      d.conferenciaSemeada = true; save(); store.log('cron', `Carga da lista de conferência: ${n} linha(s) em ${meses.length} mês(es)`);
    } catch (e) { store.log('erro', `Cronograma: carga da conferência falhou: ${e.message}`); }
  }

  const dealUrl = id => `https://${bx.host()}/crm/deal/details/${id}/`;
  async function comentarNoNegocio(c, msg) {
    if (!bitrix.enabled || !c || !c.dealId) return;
    try { await bitrix.call('crm.timeline.comment.add', { fields: { ENTITY_ID: c.dealId, ENTITY_TYPE: 'deal', COMMENT: msg } }); } catch { /* opcional */ }
  }
  const podeNaConsultora = (user, consultoraId) => {
    if (!user || user.perfil !== 'operacional') return true;
    const c = cons(consultoraId); return !!(c && c.bitrixId && c.bitrixId === user.bitrixId);
  };
  const vOpts = () => ({ consultoraOk: n => !!cons(n), clienteOk: id => d.clientes.some(c => c.id === id) });
  const visitaOk = id => d.visitas.find(v => v.id === id) || (() => { throw Object.assign(new Error('Visita não encontrada.'), { status: 404 }); })();
  const comFer = l => K.marcaFeriados(l, cli(), d.feriadosCustom).map(v => ({ ...v, clienteNome: (cli().get(v.clienteId) || {}).nome || '?', consultoraNome: nomeCons(v.consultora) }));

  const routes = [];
  const on = (m, re, h) => routes.push([m, new RegExp(`^/api/cron${re}$`), h]);

  on('GET', '/bootstrap', async (_, __, ___, user) => {
    const meu = user && user.bitrixId ? d.consultoras.find(c => c.bitrixId === user.bitrixId) : null;
    return { hoje: hoje(), host: bx.host(), funilId: d.config.funilId, status: K.STATUS, dias: K.DIAS, consultoras: d.consultoras, minhaConsultora: meu ? meu.id : '',
      semVinculo: d.consultoras.filter(c => !c.bitrixId).length, clientes: d.clientes.length, semEmpresa: d.clientes.filter(c => !c.empresaBitrixId).length, semNegocio: d.clientes.filter(c => c.empresaBitrixId && !c.dealId).length, semContato: d.clientes.filter(c => c.empresaBitrixId && !c.contatoBitrixId).length, modelos: d.modelos.length };
  });
  on('GET', '/semana', async (_, u) => {
    const ini = K.segunda(K.dataOk(u.searchParams.get('data') || hoje())), dias = K.semana(ini), q = (u.searchParams.get('q') || '').toLowerCase(), fc = u.searchParams.get('consultora') || '';
    let l = comFer(d.visitas.filter(v => v.data >= ini && v.data <= dias[4]));
    if (q) l = l.filter(v => `${v.clienteNome} ${v.obs}`.toLowerCase().includes(q));
    const linhas = d.consultoras.filter(c => !fc || c.id === fc).map(c => ({ consultora: c, dias: dias.map(dt => l.filter(v => v.consultora === c.id && v.data === dt).sort((a, b) => a.clienteNome.localeCompare(b.clienteNome))), minutos: l.filter(v => v.consultora === c.id && !['cancelada', 'remarcada', 'faltou'].includes(v.status)).reduce((s, v) => s + v.min, 0) }));
    const nac = FER.feriados({ ano: Number(ini.slice(0, 4)), custom: [] });
    return { inicio: ini, fim: dias[4], dias: dias.map(dt => ({ data: dt, nacional: (nac.get(dt) || []).map(x => ({ nome: x.nome, facultativo: x.facultativo })) })), linhas, total: l.length, comFeriado: l.filter(v => v.feriado).length, semConsultora: 0 };
  });
  // Visitas de um período (dia, semana, mês ou lista), com os mesmos filtros em todas as visões.
  on('GET', '/periodo', async (_, u) => {
    const q = u.searchParams, de = K.dataOk(q.get('de')), ate = K.dataOk(q.get('ate')); need(ate >= de && K.semanasEntre(de, ate) <= 16, 'Período inválido (máximo de 16 semanas).');
    const t = (q.get('q') || '').toLowerCase(), fc = q.get('consultora') || '', fs = q.get('status') || '', ff = q.get('feriado') === '1', fu = (q.get('uf') || '').toUpperCase(), fcl = q.get('cliente') || '';
    let l = comFer(d.visitas.filter(v => v.data >= de && v.data <= ate && (!fc || v.consultora === fc) && (!fs || v.status === fs) && (!fcl || v.clienteId === fcl)));
    const cm = cli(); l = l.filter(v => (!t || `${v.clienteNome} ${v.obs}`.toLowerCase().includes(t)) && (!ff || v.feriado) && (!fu || (cm.get(v.clienteId) || {}).uf === fu));
    l.sort((a, b) => a.data.localeCompare(b.data) || a.consultoraNome.localeCompare(b.consultoraNome) || a.clienteNome.localeCompare(b.clienteNome));
    const nac = []; for (let y = Number(de.slice(0, 4)); y <= Number(ate.slice(0, 4)); y++) for (const [data, ls] of FER.feriados({ ano: y, custom: [] })) if (data >= de && data <= ate) nac.push({ data, nome: ls.map(x => x.nome).join(' / '), facultativo: ls.every(x => x.facultativo) });
    const ativos = l.filter(v => !['cancelada', 'remarcada', 'faltou'].includes(v.status));
    return { de, ate, total: l.length, comFeriado: l.filter(v => v.feriado).length, minutos: ativos.reduce((s, v) => s + v.min, 0), realizadas: l.filter(v => v.status === 'realizada').length, itens: l, feriadosNacionais: nac };
  });
  on('POST', '/visitas', async (_, __, b, user) => {
    const v = K.validaVisita(b, vOpts()); need(podeNaConsultora(user, v.consultora), 'Você só altera a agenda da sua própria consultoria.', 403);
    const x = { id: K.uid('vs'), ...v, origem: 'manual' }; d.visitas.push(x); save(); return comFer([x])[0];
  });
  on('PUT', '/visitas/([\\w-]+)', async ([id], _, b, user) => {
    const v = visitaOk(id); need(podeNaConsultora(user, v.consultora), 'Você só altera a agenda da sua própria consultoria.', 403);
    const n = { ...K.validaVisita({ ...v, ...b }, vOpts()), id, origem: v.origem }; need(podeNaConsultora(user, n.consultora), 'Você só altera a agenda da sua própria consultoria.', 403);
    const statusMudou = n.status !== v.status; d.visitas[d.visitas.indexOf(v)] = n; save();
    if (statusMudou && (n.status === 'realizada' || n.status === 'faltou')) comentarNoNegocio(cli().get(n.clienteId), `Visita de ${n.data.split('-').reverse().join('/')} (${K.fmtMin(n.min)}) — ${K.STATUS[n.status]} · ${nomeCons(n.consultora)}.${n.obs ? ' ' + n.obs : ''}`);
    return comFer([n])[0];
  });
  on('DELETE', '/visitas/([\\w-]+)', async ([id], _, __, user) => { const v = visitaOk(id); need(podeNaConsultora(user, v.consultora), 'Você só altera a agenda da sua própria consultoria.', 403); d.visitas = d.visitas.filter(x => x.id !== id); save(); return { ok: true }; });
  on('POST', '/visitas/([\\w-]+)/mover', async ([id], _, b, user) => {
    const v = visitaOk(id); const n = K.validaVisita({ ...v, data: b.data || v.data, consultora: b.consultora || v.consultora }, vOpts());
    need(podeNaConsultora(user, v.consultora) && podeNaConsultora(user, n.consultora), 'Você só altera a agenda da sua própria consultoria.', 403);
    d.visitas[d.visitas.indexOf(v)] = { ...v, data: n.data, consultora: n.consultora, obs: n.data !== v.data ? [v.obs, `Movida de ${v.data.split('-').reverse().join('/')}`].filter(Boolean).join(' · ').slice(0, 500) : v.obs }; save(); return comFer([d.visitas.find(x => x.id === id)])[0];
  });
  // Muda a situação de várias visitas de uma vez (ex.: marcar como realizadas as visitas atrasadas já cumpridas).
  on('POST', '/visitas/lote', async (_, __, b, user) => {
    const ids = [].concat(b.ids || []).map(String).slice(0, 1000); need(ids.length, 'Nenhuma visita selecionada.'); need(K.STATUS[b.status], 'Situação inválida.');
    let n = 0; for (const id of ids) { const v = d.visitas.find(x => x.id === id); if (v && podeNaConsultora(user, v.consultora) && v.status !== b.status) { v.status = b.status; n++; } }
    if (n) { save(); store.log('cron', `${n} visita(s) marcadas como ${K.STATUS[b.status]} em lote`); } return { atualizadas: n };
  });
  // Nova oportunidade no funil Comercial B2B a partir de uma visita (ex.: rótulo fora do contrato de consultoria).
  on('POST', '/visitas/([\\w-]+)/oportunidade', async ([id], _, b, user) => {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const v = visitaOk(id); need(podeNaConsultora(user, v.consultora), 'Você só altera a agenda da sua própria consultoria.', 403);
    const c = cli().get(v.clienteId), titulo = String(b.titulo || '').trim().slice(0, 200); need(titulo.length >= 3, 'Descreva a oportunidade (mínimo de 3 letras).'); need(c && c.empresaBitrixId, 'Vincule primeiro a empresa do cliente no Bitrix24.');
    const br = x => x.split('-').reverse().join('/'), f = { TITLE: `${c.nome} — ${titulo}`, CATEGORY_ID: 0, COMPANY_ID: c.empresaBitrixId, SOURCE_DESCRIPTION: 'Visita técnica', COMMENTS: `Criada a partir da visita de ${br(v.data)} (${nomeCons(v.consultora)}).${b.detalhes ? '\n' + String(b.detalhes).slice(0, 3000) : ''}` };
    const resp = (cons(v.consultora) || {}).bitrixId; if (resp) f.ASSIGNED_BY_ID = resp; if (c.contatoBitrixId) f.CONTACT_ID = c.contatoBitrixId;
    const dealId = await funil.criar(f); v.oportunidadeId = dealId; v.obs = [v.obs, `Oportunidade criada: ${titulo}`].filter(Boolean).join(' · ').slice(0, 500); save();
    comentarNoNegocio(c, `Nova oportunidade comercial criada na visita de ${br(v.data)}: ${titulo}.`); store.log('cron', `Oportunidade comercial ${dealId} criada a partir da visita de ${c.nome}`);
    return { dealId, url: `https://${bx.host()}/crm/deal/details/${dealId}/` };
  });
  // Remarcar: a visita original fica "remarcada" e nasce uma nova, agendada, na data escolhida.
  on('POST', '/visitas/([\\w-]+)/remarcar', async ([id], _, b, user) => {
    const v = visitaOk(id); need(podeNaConsultora(user, v.consultora), 'Você só altera a agenda da sua própria consultoria.', 403);
    const data = K.dataOk(b.data); need(data !== v.data, 'Escolha uma data diferente da atual.');
    const br = x => x.split('-').reverse().join('/'), nova = { id: K.uid('vs'), data, min: v.min, consultora: v.consultora, clienteId: v.clienteId, status: 'agendada', obs: `Remarcada de ${br(v.data)}`, origem: 'manual' };
    v.status = 'remarcada'; v.obs = [v.obs, `Remarcada para ${br(data)}`].filter(Boolean).join(' · ').slice(0, 500); d.visitas.push(nova); save(); return comFer([nova])[0];
  });
  on('POST', '/semana/gerar', async (_, __, b) => {
    const n = Math.min(8, Math.max(1, Number(b.semanas) || 1)); let criadas = 0;
    for (let i = 0; i < n; i++) { const seg = FER.somaDias(K.segunda(K.dataOk(b.data || hoje())), 7 * i), nov = K.gerarSemana({ modelos: d.modelos, seg, existentes: d.visitas, clientesPorId: cli(), custom: d.feriadosCustom }); d.visitas.push(...nov); criadas += nov.length; }
    save(); store.log('cron', `${criadas} visita(s) geradas a partir das recorrências`); return { criadas };
  });
  on('POST', '/semana/remarcar-feriados', async (_, u, b, user) => {
    const ini = K.segunda(K.dataOk(b.data || hoje())), dias = K.semana(ini); let n = 0;
    for (const v of comFer(d.visitas.filter(x => x.data >= ini && x.data <= dias[4] && podeNaConsultora(user, x.consultora)))) {
      if (!v.feriado || !v.sugestao) continue; const o = d.visitas.find(x => x.id === v.id); o.obs = [o.obs, `Remarcada de ${o.data.split('-').reverse().join('/')}: feriado (${v.feriado})`].filter(Boolean).join(' · ').slice(0, 500); o.data = v.sugestao; n++;
    }
    if (n) save(); return { remarcadas: n };
  });

  // ---------- clientes (origem: empresas do Bitrix24) ----------
  on('GET', '/clientes', async (_, u) => {
    const q = (u.searchParams.get('q') || '').toLowerCase(), f = u.searchParams.get('filtro') || '', pp = 30, pg = Math.max(1, Number(u.searchParams.get('page')) || 1);
    let l = d.clientes.filter(c => (!q || c.nome.toLowerCase().includes(q)) && (!f || (f === 'semempresa' ? !c.empresaBitrixId : f === 'semnegocio' ? c.empresaBitrixId && !c.dealId : f === 'semcontato' ? c.empresaBitrixId && !c.contatoBitrixId : true)));
    const paginas = Math.max(1, Math.ceil(l.length / pp)), p = Math.min(pg, paginas);
    return { total: l.length, pagina: p, paginas, itens: l.slice((p - 1) * pp, p * pp).map(c => ({ ...c, cidadeAssumida: !c.cidade, contatoUrl: c.contatoBitrixId ? `https://${bx.host()}/crm/contact/details/${c.contatoBitrixId}/` : '', visitas: d.visitas.filter(v => v.clienteId === c.id).length, dealUrl: c.dealId ? dealUrl(c.dealId) : '' })) };
  });
  on('POST', '/clientes', async (_, __, b) => {
    const v = K.validaCliente(b); need(!d.clientes.some(c => chave(c.nome) === chave(v.nome)), 'Já existe um cliente com esse nome no cronograma.');
    if (v.empresaBitrixId) { const e = await bx.porId(v.empresaBitrixId); need(e, 'Empresa não encontrada no Bitrix24.'); v.cidade = v.cidade || e.cidade; v.uf = v.uf || e.uf; }
    const x = { id: K.uid('cl'), ...v, sugestaoId: '' }; d.clientes.push(x); save(); return x;
  });
  on('GET', '/clientes/([\\w-]+)/contatos', async ([id]) => { const c = d.clientes.find(x => x.id === id); need(c, 'Cliente não encontrado.', 404); need(c.empresaBitrixId, 'Vincule primeiro a empresa do Bitrix24.'); return bx.contatos(c.empresaBitrixId); });
  on('PUT', '/clientes/([\\w-]+)', async ([id], _, b) => {
    const c = d.clientes.find(x => x.id === id); need(c, 'Cliente não encontrado.', 404);
    const v = K.validaCliente({ ...c, ...b });
    if (v.empresaBitrixId && v.empresaBitrixId !== c.empresaBitrixId) { const e = await bx.porId(v.empresaBitrixId); need(e, 'Empresa não encontrada no Bitrix24.'); if (!b.cidade) v.cidade = v.cidade || e.cidade; if (!b.uf) v.uf = v.uf || e.uf; }
    if (v.empresaBitrixId !== c.empresaBitrixId) { v.contatoBitrixId = b.contatoBitrixId !== undefined ? v.contatoBitrixId : ''; v.contatoNome = b.contatoBitrixId !== undefined ? v.contatoNome : ''; }   // trocou a empresa: o contato antigo não vale mais
    if (v.contatoBitrixId && v.contatoBitrixId !== c.contatoBitrixId) { need(v.empresaBitrixId, 'Vincule primeiro a empresa.'); const ct = (await bx.contatos(v.empresaBitrixId)).find(x => x.id === v.contatoBitrixId); need(ct, 'Esse contato não pertence à empresa no Bitrix24.'); v.contatoNome = ct.nome; }
    if (!v.contatoBitrixId) v.contatoNome = '';
    Object.assign(c, v, { sugestaoId: v.empresaBitrixId ? '' : c.sugestaoId }); save(); return c;
  });
  on('GET', '/empresas', async (_, u) => bx.buscar(u.searchParams.get('q') || ''));
  on('GET', '/clientes/([\\w-]+)/sugestoes', async ([id]) => { const c = d.clientes.find(x => x.id === id); need(c, 'Cliente não encontrado.', 404); return bx.sugestoes(c.nome, 4); });
  // ---------- reconciliação com o Bitrix24: empresas, contatos, usuários, funil e etapas ----------
  const ESTAGIO_ATIVO = 'Ativo', INATIVOS = ['suspenso', 'cancelado'];
  async function reconciliar({ simular = true, funis = true } = {}) {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const rel = { empresas: 0, contatos: 0, consultoras: 0, criados: 0, vinculados: 0, etapas: 0, desativados: 0, reativados: 0, semEmpresa: 0, erros: [], itens: [] };
    const emp = await bx.listar(true);
    for (const c of d.clientes.filter(x => !x.empresaBitrixId)) {   // 1) empresa: nome igual ou muito parecido e único (sem chute)
      const ex = acharUnica(c.nome, emp);
      if (ex) { rel.empresas++; if (!simular) { c.empresaBitrixId = ex.id; c.cidade = c.cidade || ex.cidade; c.uf = c.uf || ex.uf; c.sugestaoId = ''; } }
    }
    if (!simular) for (const c of d.clientes.filter(x => x.empresaBitrixId && (!x.cidade || !x.uf))) { const e = emp.find(y => y.id === c.empresaBitrixId); if (e) { c.cidade = c.cidade || e.cidade; c.uf = c.uf || e.uf; } }
    if (!simular) for (const c of d.clientes.filter(x => x.empresaBitrixId && !x.contatoBitrixId)) {   // 2) contato: só quando a empresa tem exatamente um
      try { const l = await bx.contatos(c.empresaBitrixId); if (l.length === 1) { c.contatoBitrixId = l[0].id; c.contatoNome = l[0].nome; rel.contatos++; } } catch (e) { rel.erros.push(`contato de ${c.nome}: ${e.message}`); break; }
    }
    try { const us = await usuariosBitrix(), pn = x => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(' ')[0];   // 3) consultoras ↔ usuários do Bitrix24 pelo primeiro nome
      for (const c of d.consultoras.filter(x => !x.bitrixId)) { const m = us.filter(u => pn(u.nome) === pn(c.nome) && !d.consultoras.some(x => x.bitrixId === u.id)); if (m.length === 1) { rel.consultoras++; if (!simular) c.bitrixId = m[0].id; } }
    } catch (e) { rel.erros.push(`usuários: ${e.message}`); }
    if (funis) await sincronizaFunil(); else rel.semEmpresa = d.clientes.filter(c => !c.empresaBitrixId && c.ativo !== false).length;
    if (!simular) { save(); store.log('cron', `Reconciliação com o Bitrix24: ${rel.empresas} empresa(s), ${rel.contatos} contato(s), ${rel.consultoras} consultora(s), ${rel.criados} negócio(s) criado(s), ${rel.vinculados} vinculado(s), ${rel.desativados} desativado(s) pelo funil`); }
    return rel;
    // 4) funil: um negócio por cliente com empresa (reaproveita o que já existe; nunca duplica)
    async function sincronizaFunil() {
    const est = await funil.estagios(d.config.funilId), ativo = est.find(e => e.nome.toLowerCase().includes(ESTAGIO_ATIVO.toLowerCase())) || est[0], nomeDe = id => (est.find(e => e.id === id) || {}).nome || '';
    const deals = await funil.negocios(d.config.funilId);
    for (const c of d.clientes.filter(x => x.empresaBitrixId && x.ativo !== false && !x.dealId)) {
      const ex = deals.find(x => String(x.COMPANY_ID) === c.empresaBitrixId && x.CLOSED !== 'Y');
      if (ex) { rel.vinculados++; if (!simular) { c.dealId = String(ex.ID); if (!c.contatoBitrixId && ex.CONTACT_ID && String(ex.CONTACT_ID) !== '0') c.contatoBitrixId = String(ex.CONTACT_ID); } continue; }
      const resp = (d.visitas.filter(v => v.clienteId === c.id).map(v => cons(v.consultora)).find(x => x && x.bitrixId) || cons(c.consultoraPadrao) || {}).bitrixId || '';
      rel.criados++; rel.itens.push({ cliente: c.nome, acao: 'criar' });
      if (simular) continue;
      try {
        const f = { TITLE: `Assessoria recorrente — ${c.nome}`.slice(0, 250), CATEGORY_ID: d.config.funilId, COMPANY_ID: c.empresaBitrixId, STAGE_ID: ativo.id };
        if (resp) f.ASSIGNED_BY_ID = resp; if (c.contatoBitrixId) f.CONTACT_ID = c.contatoBitrixId;
        c.dealId = await funil.criar(f); deals.push({ ID: c.dealId, COMPANY_ID: c.empresaBitrixId, CLOSED: 'N', STAGE_ID: ativo.id });
      } catch (e) { rel.criados--; rel.erros.push(`${c.nome}: ${e.message}`); }
    }
    if (!simular) for (const c of d.clientes.filter(x => x.dealId)) {   // 5) etapa do funil manda no cliente: Suspenso/Cancelado tira da agenda; voltando a Ativo, volta
      const dl = deals.find(x => String(x.ID) === c.dealId); if (!dl) continue; const nome = nomeDe(dl.STAGE_ID); c.etapaFunil = nome;
      const inativo = INATIVOS.some(t => nome.toLowerCase().includes(t));
      if (inativo && c.ativo !== false) { c.ativo = false; rel.desativados++; } else if (!inativo && c.ativo === false && c.desativadoPeloFunil) { c.ativo = true; rel.reativados++; }
      c.desativadoPeloFunil = inativo;
    }
    rel.semEmpresa = d.clientes.filter(c => !c.empresaBitrixId && c.ativo !== false).length;
    }
  }
  on('POST', '/reconciliar', async (_, __, b) => reconciliar({ simular: b.simular !== false }));
  on('POST', '/vincular-auto', async () => { const r = await reconciliar({ simular: false, funis: false }); return { vinculados: r.empresas, contatos: r.contatos, semEmpresa: r.semEmpresa }; });
  on('POST', '/funil/sincronizar', async (_, __, b) => { const r = await reconciliar({ simular: b.simular !== false }); return b.simular !== false ? { simulacao: true, criar: r.criados, vincular: r.vinculados, semEmpresa: r.semEmpresa, itens: r.itens.slice(0, 200) } : { criados: r.criados, vinculados: r.vinculados, erros: r.erros.slice(0, 20) }; });

  // ---------- consultoras = usuários do Bitrix24 ----------
  async function usuariosBitrix() {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const out = []; let start = 0;
    for (let i = 0; i < 20; i++) { const r = await bitrix.call('user.get', { FILTER: { ACTIVE: true }, start }); for (const x of r.result || []) out.push({ id: String(x.ID), nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') }); if (r.next === undefined) break; start = r.next; }
    return out;
  }
  on('GET', '/usuarios-bitrix', usuariosBitrix);
  on('PUT', '/consultoras/([\\w-]+)', async ([id], _, b) => {
    const c = d.consultoras.find(x => x.id === id); need(c, 'Consultora não encontrada.', 404);
    const bid = String(b.bitrixId || '').replace(/\D/g, ''); need(!bid || !d.consultoras.some(x => x.bitrixId === bid && x.id !== id), 'Esse usuário do Bitrix24 já está ligado a outra consultora.');
    c.bitrixId = bid; save(); return c;
  });
  on('POST', '/consultoras', async (_, __, b) => { const nome = String(b.nome || '').trim().slice(0, 60); need(nome.length >= 2, 'Informe o nome.'); need(!d.consultoras.some(c => c.nome.toLowerCase() === nome.toLowerCase()), 'Já existe uma consultora com esse nome.'); const c = { id: K.uid('co'), nome, bitrixId: '' }; d.consultoras.push(c); save(); return c; });
  on('POST', '/consultoras/auto', async () => {
    const us = await usuariosBitrix(); let n = 0;
    const pn = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(' ')[0];
    for (const c of d.consultoras.filter(x => !x.bitrixId)) { const m = us.filter(u => pn(u.nome) === pn(c.nome) && !d.consultoras.some(x => x.bitrixId === u.id)); if (m.length === 1) { c.bitrixId = m[0].id; n++; } }
    if (n) save(); return { ligadas: n, pendentes: d.consultoras.filter(c => !c.bitrixId).length };
  });

  // ---------- feriados ----------
  on('GET', '/feriados', async (_, u) => {
    const ano = Number(u.searchParams.get('ano')) || Number(hoje().slice(0, 4)), m = FER.feriados({ cidade: u.searchParams.get('cidade') || '', uf: u.searchParams.get('uf') || '', ano, custom: d.feriadosCustom });
    return [...m].sort().flatMap(([data, l]) => l.map(x => ({ data, ...x })));
  });
  on('GET', '/feriados-custom', async () => d.feriadosCustom);
  on('POST', '/feriados-custom', async (_, __, b) => {
    const nome = String(b.nome || '').trim().slice(0, 80), data = String(b.data || ''); need(nome.length >= 2, 'Informe o nome do feriado.'); need(/^\d{4}-\d{2}-\d{2}$/.test(data) || /^\d{2}-\d{2}$/.test(data), 'Data inválida.');
    const x = { id: K.uid('fc'), data, cidade: String(b.cidade || '').trim().slice(0, 80), uf: String(b.uf || '').trim().toUpperCase().slice(0, 2), nome }; d.feriadosCustom.push(x); save(); return x;
  });
  on('DELETE', '/feriados-custom/([\\w-]+)', async ([id]) => { d.feriadosCustom = d.feriadosCustom.filter(x => x.id !== id); save(); return { ok: true }; });

  // ---------- lista de conferência mensal ----------
  const cOpts = () => ({ consultoraOk: id => !!cons(id), clienteOk: id => d.clientes.some(c => c.id === id) });
  const confOut = r => { const c = cli().get(r.clienteId) || {}; return { ...r, clienteNome: c.nome || r.estabelecimento, empresaBitrixId: c.empresaBitrixId || '', dealId: c.dealId || '', restricao: c.restricao || '', consultoraNomes: r.consultoras.map(nomeCons).join(' / ') || r.consultoraTxt || '', marcadas: r.semanas.filter(Boolean).length, realizado: r.semanas.filter(Boolean).length, previsto: K.previstoDe(r) }; };
  const resumoMes = mes => {
    const l = d.conferencia.filter(x => x.mes === mes).map(confOut), por = new Map();
    for (const r of l) { if (r.previsto == null) continue; const id = r.consultoras[0] || '', x = por.get(id) || { consultora: id ? nomeCons(id) : 'Sem consultora', linhas: 0, previsto: 0, realizado: 0 }; x.linhas++; x.previsto += r.previsto; x.realizado += Math.min(r.realizado, r.previsto); por.set(id, x); }
    const comFreq = l.filter(r => r.previsto != null), prev = comFreq.reduce((s, r) => s + r.previsto, 0), real = comFreq.reduce((s, r) => s + Math.min(r.realizado, r.previsto), 0);
    const col = Array.from({ length: 5 }, (_, i) => l.filter(r => r.semanas[i]).length), media = (col[0] + col[1] + col[2] + col[3]) / 4;
    return { mes, linhas: l.length, semFrequencia: l.length - comFreq.length, previsto: prev, realizado: real, pct: prev ? Math.round((real / prev) * 100) : null, completas: comFreq.filter(r => r.realizado >= r.previsto).length, porConsultora: [...por.values()].map(x => ({ ...x, pct: x.previsto ? Math.round((x.realizado / x.previsto) * 100) : null })).sort((a, b) => a.consultora.localeCompare(b.consultora)),
      avisoSemana5: l.length >= 20 && col[4] >= 0.8 * l.length && col[4] > 2 * media ? `A 5ª semana está marcada em ${Math.round((col[4] / l.length) * 100)}% das linhas, bem acima das outras semanas. Confira se são mesmo visitas concluídas.` : '' };
  };
  const confOk = id => d.conferencia.find(x => x.id === id) || (() => { throw Object.assign(new Error('Registro não encontrado.'), { status: 404 }); })();
  on('GET', '/conferencia/meses', async () => {
    const ms = [...new Set([...Object.keys(d.confMeses), ...d.conferencia.map(x => x.mes)])].sort().reverse();
    return ms.map(m => ({ mes: m, linhas: d.conferencia.filter(x => x.mes === m).length, obs: (d.confMeses[m] || {}).obs || [] }));
  });
  on('GET', '/conferencia/resumo', async (_, u) => { const m = u.searchParams.get('mes') || ''; need(K.MES_OK(m), 'Mês inválido.'); return resumoMes(m); });
  on('GET', '/conferencia/geral', async () => d.confGeral);
  on('PUT', '/conferencia/geral', async (_, __, b) => { d.confGeral = { obsClientes: [].concat(b.obsClientes || []).map(x => String(x).slice(0, 300)).filter(Boolean).slice(0, 100) }; save(); return d.confGeral; });
  on('PUT', '/conferencia/mes/(\\d{4}-\\d{2})', async ([m], _, b) => { need(K.MES_OK(m), 'Mês inválido.'); (d.confMeses[m] ||= { obs: [] }).obs = [].concat(b.obs || []).map(x => String(x).slice(0, 300)).filter(Boolean).slice(0, 50); save(); return d.confMeses[m]; });
  on('GET', '/conferencia', async (_, u) => {
    const q = u.searchParams, mes = q.get('mes') || '', t = (q.get('q') || '').toLowerCase(), fc = q.get('consultora') || '', ff = q.get('freq') || '', fv = q.get('vinculo') || '', pp = 40, pg = Math.max(1, Number(q.get('page')) || 1);
    let l = d.conferencia.filter(x => (!mes || x.mes === mes) && (!fc || x.consultoras.includes(fc)) && (!ff || x.freqTipo === ff)).map(confOut)
      .filter(x => (!t || `${x.clienteNome} ${x.estabelecimento} ${x.obs}`.toLowerCase().includes(t)) && (!fv || (fv === 'sem' ? !x.empresaBitrixId : !!x.empresaBitrixId)));
    const paginas = Math.max(1, Math.ceil(l.length / pp)), p = Math.min(pg, paginas);
    return { total: l.length, pagina: p, paginas, itens: l.slice((p - 1) * pp, p * pp), marcadas: l.reduce((s, x) => s + x.marcadas, 0) };
  });
  on('GET', '/clientes/([\\w-]+)/conferencia', async ([id]) => d.conferencia.filter(x => x.clienteId === id).sort((a, b) => b.mes.localeCompare(a.mes)).map(confOut));
  on('POST', '/conferencia', async (_, __, b) => { const v = K.validaConferencia(b, cOpts()), c = d.clientes.find(x => x.id === v.clienteId); need(!d.conferencia.some(x => x.mes === v.mes && x.clienteId === v.clienteId), 'Esse cliente já está na lista deste mês.'); const x = { id: K.uid('cf'), ...v, estabelecimento: c.nome }; d.conferencia.push(x); save(); return confOut(x); });
  on('PUT', '/conferencia/([\\w-]+)', async ([id], _, b) => { const r = confOk(id), v = K.validaConferencia({ ...r, ...b }, cOpts()); const n = { ...r, ...v, id }; d.conferencia[d.conferencia.indexOf(r)] = n; save(); return confOut(n); });
  on('DELETE', '/conferencia/([\\w-]+)', async ([id]) => { confOk(id); d.conferencia = d.conferencia.filter(x => x.id !== id); save(); return { ok: true }; });

  // ---------- modelos de recorrência ----------
  on('GET', '/modelos', async () => d.modelos.map(m => ({ ...m, clienteNome: (cli().get(m.clienteId) || {}).nome || '?', consultoraNome: nomeCons(m.consultora), diaNome: K.DIAS[m.dow] })));
  on('PUT', '/modelos/([\\w-]+)', async ([id], _, b) => { const m = d.modelos.find(x => x.id === id); need(m, 'Modelo não encontrado.', 404); if (b.ativo !== undefined) m.ativo = !!b.ativo; if (['semanal', 'quinzenal'].includes(b.freq)) m.freq = b.freq; save(); return m; });

  return {
    reconciliar, comFer, dados: () => d,
    async handle(method, pathname, u, readBody, user) {
      for (const [m, re, h] of routes) { const g = m === method && pathname.match(re); if (g) return { json: await h(g.slice(1), u, ['POST', 'PUT'].includes(method) ? await readBody() : {}, user) }; }
      return null;
    },
  };
}
module.exports = { createCronApi };
