'use strict';
const fs = require('fs');
const path = require('path');
const K = require('./cron');
const FER = require('./feriados');
const R = require('./rules');
const { chave, similar } = require('./bxEmpresas');

const FUNIL = 6;   // "Assessoria Recorrente / RT"
// API do processo Cronograma (/api/cron/*). Clientes vêm do cadastro de empresas do Bitrix24; consultoras são usuários do Bitrix24.
function createCronApi({ bitrix, bx, store, dir, seedFile, confSeedFile }) {
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
  on('POST', '/vincular-auto', async () => {
    const l = await bx.listar(true); let n = 0;
    for (const c of d.clientes.filter(x => !x.empresaBitrixId)) {
      const ex = l.filter(e => chave(e.nome) === chave(c.nome) || similar(c.nome, e.nome) >= 0.8);
      if (ex.length === 1) { c.empresaBitrixId = ex[0].id; c.cidade = c.cidade || ex[0].cidade; c.uf = c.uf || ex[0].uf; c.sugestaoId = ''; n++; }
    }
    let ct = 0;   // contato: só quando a empresa tem exatamente um
    for (const c of d.clientes.filter(x => x.empresaBitrixId && !x.contatoBitrixId)) { try { const l2 = await bx.contatos(c.empresaBitrixId); if (l2.length === 1) { c.contatoBitrixId = l2[0].id; c.contatoNome = l2[0].nome; ct++; } } catch { break; } }
    if (n || ct) save(); return { contatos: ct, vinculados: n, semEmpresa: d.clientes.filter(c => !c.empresaBitrixId).length };
  });
  // Cria, no funil Assessoria Recorrente / RT, um negócio por cliente já ligado a uma empresa (sem duplicar os que já existem).
  on('POST', '/funil/sincronizar', async (_, __, b) => {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const alvo = d.clientes.filter(c => c.empresaBitrixId && !c.dealId && c.ativo !== false);
    const existentes = []; let start = 0;
    for (let i = 0; i < 50; i++) { const r = await bitrix.call('crm.deal.list', { filter: { CATEGORY_ID: d.config.funilId }, select: ['ID', 'COMPANY_ID', 'CONTACT_ID', 'TITLE', 'CLOSED'], start }); existentes.push(...(r.result || [])); if (r.next === undefined) break; start = r.next; }
    const plano = alvo.map(c => { const ex = existentes.find(x => String(x.COMPANY_ID) === c.empresaBitrixId && x.CLOSED !== 'Y'); const resp = (d.visitas.filter(v => v.clienteId === c.id).map(v => cons(v.consultora)).find(x => x && x.bitrixId) || {}).bitrixId || '';
      return { clienteId: c.id, nome: c.nome, acao: ex ? 'vincular' : 'criar', dealId: ex ? String(ex.ID) : '', contato: ex && ex.CONTACT_ID && String(ex.CONTACT_ID) !== '0' ? String(ex.CONTACT_ID) : '', responsavel: resp }; });
    if (b.simular !== false) return { simulacao: true, criar: plano.filter(p => p.acao === 'criar').length, vincular: plano.filter(p => p.acao === 'vincular').length, semEmpresa: d.clientes.filter(c => !c.empresaBitrixId).length, itens: plano.slice(0, 200) };
    let criados = 0, vinculados = 0; const erros = [];
    for (const p of plano) {
      const c = d.clientes.find(x => x.id === p.clienteId);
      try {
        if (p.acao === 'vincular') { c.dealId = p.dealId; if (!c.contatoBitrixId && p.contato) c.contatoBitrixId = p.contato; vinculados++; continue; }
        const f = { TITLE: `Assessoria recorrente — ${c.nome}`.slice(0, 250), CATEGORY_ID: d.config.funilId, COMPANY_ID: c.empresaBitrixId };
        if (p.responsavel) f.ASSIGNED_BY_ID = p.responsavel; if (c.contatoBitrixId) f.CONTACT_ID = c.contatoBitrixId;
        const r = await bitrix.call('crm.deal.add', { fields: f }); c.dealId = String(r.result); criados++;
      } catch (e) { erros.push(`${c.nome}: ${e.message}`); }
    }
    save(); store.log('cron', `Funil Assessoria Recorrente/RT: ${criados} negócio(s) criado(s), ${vinculados} vinculado(s)`); return { criados, vinculados, erros: erros.slice(0, 20) };
  });

  // ---------- consultoras = usuários do Bitrix24 ----------
  const usuariosBitrix = async () => {
    need(bitrix.enabled, 'Conecte o webhook do Bitrix24 primeiro.', 409);
    const out = []; let start = 0;
    for (let i = 0; i < 20; i++) { const r = await bitrix.call('user.get', { FILTER: { ACTIVE: true }, start }); for (const x of r.result || []) out.push({ id: String(x.ID), nome: [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') }); if (r.next === undefined) break; start = r.next; }
    return out;
  };
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
  const confOut = r => { const c = cli().get(r.clienteId) || {}; return { ...r, clienteNome: c.nome || r.estabelecimento, empresaBitrixId: c.empresaBitrixId || '', dealId: c.dealId || '', restricao: c.restricao || '', consultoraNomes: r.consultoras.map(nomeCons).join(' / ') || r.consultoraTxt || '', marcadas: r.semanas.filter(Boolean).length }; };
  const confOk = id => d.conferencia.find(x => x.id === id) || (() => { throw Object.assign(new Error('Registro não encontrado.'), { status: 404 }); })();
  on('GET', '/conferencia/meses', async () => {
    const ms = [...new Set([...Object.keys(d.confMeses), ...d.conferencia.map(x => x.mes)])].sort().reverse();
    return ms.map(m => ({ mes: m, linhas: d.conferencia.filter(x => x.mes === m).length, obs: (d.confMeses[m] || {}).obs || [] }));
  });
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
    comFer, dados: () => d,
    async handle(method, pathname, u, readBody, user) {
      for (const [m, re, h] of routes) { const g = m === method && pathname.match(re); if (g) return { json: await h(g.slice(1), u, ['POST', 'PUT'].includes(method) ? await readBody() : {}, user) }; }
      return null;
    },
  };
}
module.exports = { createCronApi };
