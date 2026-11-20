'use strict';
const crypto = require('crypto');
const { validar, AREAS, CONSENTIMENTO_VERSAO } = require('./candidatura');
const { extrairTexto } = require('./ia');
const fail = (code, msg, extra) => Object.assign(new Error(msg), { status: code, ...extra });
const STATUS = [
  { id: 'novo', nome: 'Novos' }, { id: 'triagem', nome: 'Em triagem' }, { id: 'entrevista', nome: 'Entrevista' },
  { id: 'proposta', nome: 'Proposta' }, { id: 'contratado', nome: 'Contratados' }, { id: 'banco', nome: 'Banco de talentos' }, { id: 'reprovado', nome: 'Não seguiram' },
];
const SLA_PADRAO = { novo: 2, triagem: 5, entrevista: 7, proposta: 3 };   // dias; etapas finais não têm prazo
const DIA = 864e5;
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const lim = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'vaga';

const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });   // AAAA-MM-DD em Brasília
const somaDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const difDias = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / DIA);
const dataOk = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
const TIPOS = ['CLT', 'Temporário', 'Estágio', 'Aprendiz', 'PJ'];
const MODELOS = ['Presencial', 'Híbrido', 'Remoto'];
const PRAZO_MAX = 120, MOTIVOS = { prazo: 'o prazo terminou', limite: 'o limite de candidaturas foi atingido', preenchida: 'as posições foram preenchidas', manual: 'foi encerrada pelo RH' };
const SISTEMA = { id: 'sistema', nome: 'Automático' };

function createCurriculos({ store, ia, usuarios, extrair = extrairTexto }) {
  const cfg = () => {
    const c = store.curConfig || {};
    return { slaDias: { ...SLA_PADRAO, ...(c.slaDias || {}) }, iaAtiva: c.iaAtiva !== false, areas: c.areas || {}, rr: c.rr || {} };
  };
  const salvaCfg = c => store.setCurConfig(c);
  const achar = id => { const c = store.candidatos.find(x => x.id === id); if (!c) throw fail(404, 'Candidato não encontrado.'); return c; };
  const vagaPor = codigo => store.vagas.find(v => v.codigo === codigo) || null;
  const dias = c => Math.max(0, Math.floor((Date.now() - new Date(c.etapaDesde || c.criadoEm)) / DIA));
  // candidaturas vindas de vagas do RH têm prioridade: metade do prazo de cada etapa
  const parada = c => { let s = cfg().slaDias[c.status]; if (s && c.viaVaga) s = Math.max(1, Math.ceil(s / 2)); return !!s && dias(c) > s; };

  const resumo = c => ({
    id: c.id, protocolo: c.id.slice(0, 8).toUpperCase(), nome: c.dados.nome, email: c.dados.email, telefone: c.dados.telefone, cidade: c.dados.cidade, uf: c.dados.uf,
    area: c.dados.area, cargo: c.dados.cargo || '', vaga: c.dados.vaga || '', vagaTitulo: vagaPor(c.dados.vaga)?.titulo || '', linkedin: c.dados.linkedin || '', temCv: !!c.cv, status: c.status,
    avaliacao: c.avaliacao || 0, tags: c.tags || [], criadoEm: c.criadoEm, atualizadoEm: c.atualizadoEm,
    aderencia: c.ia?.status === 'ok' ? c.ia.aderencia?.nota ?? null : null, iaStatus: c.ia?.status || 'nenhuma',
    viaVaga: !!c.viaVaga, responsavel: c.responsavel || null, diasNaEtapa: dias(c), parada: parada(c),
  });

  // ---------- roteamento por área (rodízio entre os responsáveis) ----------
  function responsavelPara(area, vaga) {
    if (vaga?.responsavel) return vaga.responsavel;
    const c = cfg(), lista = c.areas[area] || [];
    if (!lista.length) return null;
    const i = (c.rr[area] || 0) % lista.length;
    salvaCfg({ ...store.curConfig, areas: c.areas, rr: { ...c.rr, [area]: i + 1 } });
    return { id: lista[i].userId, nome: lista[i].nome };
  }

  // ---------- fila de leitura pela IA (um currículo por vez) ----------
  const fila = []; let rodando = false; let ocioso = [];
  async function analisarUm(id) {
    const c = store.candidatos.find(x => x.id === id); if (!c) return;
    const agora = () => new Date().toISOString();
    if (!cfg().iaAtiva || !ia?.ativa) { c.ia = { status: 'desligada', em: agora() }; return store.touch(); }
    try {
      let texto = '', motivo = 'Sem arquivo de currículo (apenas LinkedIn): não há o que a IA leia.';
      if (c.cv) ({ texto = '', motivo = '' } = await extrair(store.readCv(c.cv.arquivo), c.cv.ext));
      if (!texto) { c.ia = { status: 'sem-texto', motivo, em: agora() }; return store.touch(); }
      const v = vagaPor(c.dados.vaga);
      const r = await ia.analisar({ texto, ficha: c.dados, vaga: v });
      c.ia = { status: 'ok', em: agora(), modelo: r.modelo, ...r.dados, aderencia: r.aderencia, suspeitaInjecao: r.suspeitaInjecao, vagaCodigo: v?.codigo || '' };
      c.historico.unshift({ em: agora(), tipo: 'ia', texto: `Currículo lido pela IA${r.aderencia.nota != null ? ` — aderência ${r.aderencia.nota}` : ''}` });
    } catch (e) { c.ia = { status: 'erro', erro: String(e.message).slice(0, 200), em: agora() }; }
    store.touch();
  }
  async function bombear() {
    if (rodando) return; rodando = true;
    while (fila.length) { const id = fila.shift(); try { await analisarUm(id); } catch (e) { console.error('ia', e.message); } }
    rodando = false; ocioso.splice(0).forEach(f => f());
  }
  function enfileirar(id) {
    const c = store.candidatos.find(x => x.id === id); if (!c) return;
    if (!fila.includes(id)) fila.push(id);
    c.ia = { status: 'pendente', em: new Date().toISOString() }; store.touch(); setImmediate(bombear);
  }
  const aguardarIa = () => (rodando || fila.length ? new Promise(r => ocioso.push(r)) : Promise.resolve());
  function retomar() { for (const c of store.candidatos) if (c.ia?.status === 'pendente') { fila.push(c.id); } if (fila.length) setImmediate(bombear); }

  // ---------- entrada pública ----------
  function receber(body, origem) {
    if (body.website) return { protocolo: 'OK00' + crypto.randomBytes(2).toString('hex').toUpperCase(), descartado: true };
    const v = validar(body);
    if (!v.ok) throw fail(422, 'Verifique os campos informados.', { erros: v.erros });
    const agora = new Date().toISOString(), vaga = v.dados.vaga || '';
    atualizarVagas();
    let c = store.candidatos.find(x => x.dados.email === v.dados.email && (x.dados.vaga || '') === vaga);
    const vg0 = vaga ? vagaPor(vaga) : null;
    if (!c && vaga) {   // candidatura nova a uma vaga: ela precisa existir e estar recebendo
      if (!vg0) throw fail(422, 'Vaga não encontrada.', { erros: { vaga: 'Esta vaga não existe mais. Veja as vagas atuais ou envie uma candidatura espontânea.' } });
      if (vg0.status !== 'aberta') throw fail(422, 'Vaga fechada.', { erros: { vaga: vg0.status === 'encerrada' ? `Esta vaga foi encerrada (${MOTIVOS[vg0.encerradaMotivo] || 'encerrada'}). Veja as outras vagas ou envie uma candidatura espontânea.` : 'Esta vaga não está recebendo candidaturas no momento.' } });
    }
    const arquivo = v.cv ? store.saveCv(v.cv.buf, v.cv.ext) : null;
    const cvInfo = v.cv ? { nome: v.cv.nome, ext: v.cv.ext, tamanho: v.cv.tamanho, arquivo } : null;
    if (c) {
      const antigo = c.cv?.arquivo;
      c.dados = { ...c.dados, ...v.dados }; if (cvInfo) c.cv = cvInfo;
      c.atualizadoEm = agora; c.historico.unshift({ em: agora, tipo: 'reenvio', texto: 'Candidato reenviou a ficha' });
      if (antigo && cvInfo) store.removeCv(antigo);
      store.touch(); if (cvInfo) enfileirar(c.id);
    } else {
      const vg = vagaPor(vaga), resp = responsavelPara(v.dados.area, vg);
      c = store.addCandidato({
        id: crypto.randomBytes(12).toString('hex'), criadoEm: agora, atualizadoEm: agora, etapaDesde: agora, status: 'novo', avaliacao: 0, tags: [],
        viaVaga: !!vg, dados: v.dados, cv: cvInfo, notas: [], responsavel: resp,
        historico: [{ em: agora, tipo: 'entrada', texto: 'Ficha recebida pelo site' }, ...(resp ? [{ em: agora, tipo: 'rota', texto: `Encaminhada para ${resp.nome} (${vg ? 'vaga ' + vg.titulo : v.dados.area})` }] : [])],
        consentimento: { em: agora, versao: CONSENTIMENTO_VERSAO }, origemApi: { chave: origem || '' },
      });
      enfileirar(c.id); atualizarVagas();   // a última vaga do limite fecha a vaga na hora
    }
    return { protocolo: c.id.slice(0, 8).toUpperCase() };
  }

  // ---------- consulta ----------
  function listar({ status, q, vaga, area, responsavel, origem, parada: so, ordem, limite = 200, offset = 0 } = {}) {
    const t = norm(q).trim();
    let l = store.candidatos;
    if (status) l = l.filter(c => c.status === status);
    if (vaga) l = l.filter(c => (c.dados.vaga || '') === vaga);
    if (area) l = l.filter(c => c.dados.area === area);
    if (responsavel) l = l.filter(c => responsavel === 'nenhum' ? !c.responsavel : c.responsavel?.id === responsavel);
    if (origem === 'vaga') l = l.filter(c => c.viaVaga); else if (origem === 'espontanea') l = l.filter(c => !c.viaVaga);
    if (so) l = l.filter(parada);
    if (t) l = l.filter(c => norm(`${c.dados.nome} ${c.dados.email} ${c.dados.cargo || ''} ${c.dados.area} ${c.dados.cidade} ${(c.tags || []).join(' ')} ${c.ia?.status === 'ok' ? `${c.ia.cargoAtual} ${c.ia.habilidades.join(' ')} ${c.ia.certificacoes.join(' ')}` : ''}`).includes(t));
    const itens = l.map(resumo);
    if (ordem === 'aderencia') itens.sort((a, b) => (b.aderencia ?? -1) - (a.aderencia ?? -1));
    else itens.sort((a, b) => (b.viaVaga - a.viaVaga) || (a.criadoEm < b.criadoEm ? 1 : -1));   // vagas do RH primeiro, depois as mais recentes
    const porStatus = Object.fromEntries(STATUS.map(s => [s.id, 0])); for (const c of store.candidatos) porStatus[c.status] = (porStatus[c.status] || 0) + 1;
    return { total: itens.length, porStatus, paradas: store.candidatos.filter(parada).length, semResponsavel: store.candidatos.filter(c => !c.responsavel && c.status === 'novo').length, viaVaga: store.candidatos.filter(c => c.viaVaga && c.status === 'novo').length, status: STATUS, slaDias: cfg().slaDias, itens: itens.slice(offset, offset + Math.min(limite, 500)) };
  }
  const detalhe = id => {
    const c = achar(id), v = vagaPor(c.dados.vaga);
    return { ...resumo(c), dados: c.dados, ia: c.ia || null, vagaInfo: v ? { codigo: v.codigo, titulo: v.titulo } : null, cv: c.cv ? { nome: c.cv.nome, tamanho: c.cv.tamanho, ext: c.cv.ext } : null, notas: c.notas, historico: c.historico, consentimento: c.consentimento };
  };

  async function atualizar(user, id, p, bearer) {
    const c = achar(id), agora = new Date().toISOString();
    if (p.status !== undefined) {
      if (!STATUS.some(s => s.id === p.status)) throw fail(400, 'Etapa inválida.');
      if (p.status !== c.status) { c.historico.unshift({ em: agora, tipo: 'etapa', por: user.id, porNome: user.nome, de: c.status, para: p.status, texto: `Etapa: ${c.status} → ${p.status}` }); c.status = p.status; c.etapaDesde = agora; }
    }
    if (p.avaliacao !== undefined) { const n = Number(p.avaliacao); if (!Number.isInteger(n) || n < 0 || n > 5) throw fail(400, 'Avaliação de 0 a 5.'); c.avaliacao = n; }
    if (p.tags !== undefined) { if (!Array.isArray(p.tags) || p.tags.length > 12) throw fail(400, 'Até 12 etiquetas.'); c.tags = [...new Set(p.tags.map(t => lim(t, 24)).filter(Boolean))]; }
    if (p.nota !== undefined) { const t = lim(p.nota, 1000); if (!t) throw fail(400, 'Escreva a anotação.'); c.notas.unshift({ em: agora, por: user.id, porNome: user.nome, texto: t }); }
    if (p.responsavelId !== undefined) {
      if (p.responsavelId === null || p.responsavelId === '') c.responsavel = null;
      else { const u = await usuarios.porId(bearer, String(p.responsavelId)); if (!u) throw fail(404, 'Usuário não encontrado no Bitrix24.'); c.responsavel = { id: u.id, nome: u.nome }; }
      c.historico.unshift({ em: agora, tipo: 'rota', por: user.id, porNome: user.nome, texto: c.responsavel ? `Responsável: ${c.responsavel.nome}` : 'Responsável removido' });
    }
    c.atualizadoEm = agora; store.touch(); atualizarVagas();
    store.audit(user, 'candidato.alterar', `${c.id.slice(0, 8)} ${Object.keys(p).join(',')}`);
    return detalhe(id);
  }
  function excluir(user, id) { const c = achar(id); store.removeCandidato(id); store.audit(user, 'candidato.excluir', `${c.id.slice(0, 8)} ${c.dados.nome}`); return { ok: true }; }
  function baixarCv(id) { const c = achar(id); if (!c.cv) throw fail(404, 'Este candidato não enviou arquivo.'); return { ...c.cv, buf: store.readCv(c.cv.arquivo) }; }
  function reanalisar(user, id) { achar(id); enfileirar(id); store.audit(user, 'candidato.reanalisar', id.slice(0, 8)); return { ok: true }; }

  // ---------- vagas (ciclo de vida automático) ----------
  // rascunho → (agendada) → aberta → encerrada [prazo | limite | preenchida | manual]; pausada é manual.
  // Regra de ouro: vaga PUBLICADA sempre tem prazo, então nunca fica "esquecida" no site.
  const contagem = v => { const l = store.candidatos.filter(c => (c.dados.vaga || '') === v.codigo); return { candidatos: l.length, contratados: l.filter(c => c.status === 'contratado').length }; };
  function motivoDeFechar(v, hoje = hojeBR()) {
    const k = contagem(v);
    if (v.encerraEm && v.encerraEm < hoje) return 'prazo';
    if (v.limiteCandidatos && k.candidatos >= v.limiteCandidatos) return 'limite';
    if (k.contratados >= (v.posicoes || 1)) return 'preenchida';
    return null;
  }
  function atualizarVagas() {
    const hoje = hojeBR(); let mudou = false;
    const nova = store.vagas.map(v => {
      let n = v;
      if (n.status === 'agendada' && n.abreEm && n.abreEm <= hoje) { n = { ...n, status: 'aberta' }; store.audit(SISTEMA, 'vaga.auto', `${n.codigo}: aberta pela data de publicação`); }
      if (n.status === 'aberta') {
        if (!n.encerraEm) { n = { ...n, encerraEm: somaDias(hoje, 30) }; store.audit(SISTEMA, 'vaga.auto', `${n.codigo}: sem prazo — definido em 30 dias`); }
        const m = motivoDeFechar(n, hoje);
        if (m) { n = { ...n, status: 'encerrada', encerradaMotivo: m, encerradaEm: new Date().toISOString() }; store.audit(SISTEMA, 'vaga.auto', `${n.codigo}: encerrada (${MOTIVOS[m]})`); }
      }
      if (n !== v) mudou = true;
      return n;
    });
    if (mudou) store.setVagas(nova);
  }
  const intervalo = setInterval(atualizarVagas, 10 * 60 * 1000); intervalo.unref?.();
  atualizarVagas();

  function vagaOut(v) {
    const k = contagem(v), hoje = hojeBR(), alertas = [];
    const dr = v.encerraEm ? difDias(v.encerraEm, hoje) : null;
    if (v.status === 'aberta') {
      if (dr != null && dr <= 3) alertas.push(dr <= 0 ? 'Fecha hoje' : `Fecha em ${dr} dia${dr > 1 ? 's' : ''}`);
      if (v.limiteCandidatos && k.candidatos >= v.limiteCandidatos * 0.8) alertas.push(`Limite quase cheio (${k.candidatos}/${v.limiteCandidatos})`);
      if (k.contratados > 0 && k.contratados < (v.posicoes || 1)) alertas.push(`${k.contratados} de ${v.posicoes || 1} posições preenchidas`);
    }
    return { ...v, ...k, diasRestantes: dr, alertas, motivoTexto: v.encerradaMotivo ? MOTIVOS[v.encerradaMotivo] : '' };
  }
  const intOu = (x, min, max, nome) => { const n = Number(x); if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${nome}: informe um número inteiro de ${min} a ${max}.`); return n; };
  const dataOuNull = (x, nome) => { if (x === null || x === '' || x === undefined) return null; if (!dataOk(x)) throw fail(400, `${nome}: data inválida.`); return x; };
  async function vagaDados(p, bearer, base = {}) {
    const v = { ...base };
    if (p.titulo !== undefined) { v.titulo = lim(p.titulo, 100); if (v.titulo.length < 3) throw fail(400, 'Informe o título da vaga.'); }
    if (p.area !== undefined) { if (!AREAS.includes(p.area)) throw fail(400, 'Área inválida.'); v.area = p.area; }
    if (p.cidade !== undefined) v.cidade = lim(p.cidade, 80);
    if (p.descricao !== undefined) v.descricao = lim(p.descricao, 2000);
    if (p.requisitos !== undefined) v.requisitos = lim(p.requisitos, 2000);
    if (p.tipoContrato !== undefined) { if (p.tipoContrato && !TIPOS.includes(p.tipoContrato)) throw fail(400, 'Tipo de contrato inválido.'); v.tipoContrato = p.tipoContrato || ''; }
    if (p.modelo !== undefined) { if (p.modelo && !MODELOS.includes(p.modelo)) throw fail(400, 'Modelo de trabalho inválido.'); v.modelo = p.modelo || ''; }
    if (p.faixaSalarial !== undefined) v.faixaSalarial = lim(p.faixaSalarial, 60);
    if (p.mostrarSalario !== undefined) v.mostrarSalario = p.mostrarSalario === true;
    if (p.posicoes !== undefined) v.posicoes = intOu(p.posicoes, 1, 99, 'Posições');
    if (p.limiteCandidatos !== undefined) v.limiteCandidatos = (p.limiteCandidatos === null || p.limiteCandidatos === '') ? null : intOu(p.limiteCandidatos, 1, 5000, 'Limite de candidatos');
    if (p.abreEm !== undefined) v.abreEm = dataOuNull(p.abreEm, 'Data de publicação');
    if (p.encerraEm !== undefined) v.encerraEm = dataOuNull(p.encerraEm, 'Prazo');
    if (p.responsavelId !== undefined) {
      if (!p.responsavelId) v.responsavel = null;
      else { const u = await usuarios.porId(bearer, String(p.responsavelId)); if (!u) throw fail(404, 'Usuário não encontrado no Bitrix24.'); v.responsavel = { id: u.id, nome: u.nome }; }
    }
    if (v.abreEm && v.encerraEm && v.encerraEm < v.abreEm) throw fail(400, 'O prazo não pode ser antes da data de publicação.');
    return v;
  }
  const vagaBase = () => ({ status: 'rascunho', cidade: '', descricao: '', requisitos: '', tipoContrato: '', modelo: '', faixaSalarial: '', mostrarSalario: false, posicoes: 1, limiteCandidatos: null, abreEm: null, encerraEm: null, responsavel: null });
  async function criarVaga(user, p, bearer) {
    const v = await vagaDados(p, bearer, vagaBase());
    if (!v.titulo || !v.area) throw fail(400, 'Título e área são obrigatórios.');
    let codigo = slug(v.titulo); while (vagaPor(codigo)) codigo = `${slug(v.titulo).slice(0, 34)}-${crypto.randomBytes(2).toString('hex')}`;
    const nova = { id: crypto.randomBytes(6).toString('hex'), codigo, criadaEm: new Date().toISOString(), ...v };
    store.setVagas([nova, ...store.vagas]); store.audit(user, 'vaga.criar', `${codigo}: ${nova.titulo}`); return vagaOut(nova);
  }
  const acharVaga = id => { const v = store.vagas.find(x => x.id === id); if (!v) throw fail(404, 'Vaga não encontrada.'); return v; };
  const gravaVaga = (nova) => store.setVagas(store.vagas.map(x => (x.id === nova.id ? nova : x)));
  async function editarVaga(user, id, p, bearer) {
    const atual = acharVaga(id); if (p.status !== undefined) throw fail(400, 'Use as ações (publicar, pausar, encerrar…) para mudar a situação.');
    const hoje = hojeBR(), nova = { ...(await vagaDados(p, bearer, atual)), id, codigo: atual.codigo, criadaEm: atual.criadaEm };
    if (['aberta', 'agendada'].includes(nova.status) && p.encerraEm !== undefined && (!nova.encerraEm || nova.encerraEm < hoje)) throw fail(400, 'Vaga publicada precisa de um prazo de hoje em diante.');
    gravaVaga(nova); store.audit(user, 'vaga.editar', `${nova.codigo} ${Object.keys(p).join(',')}`); atualizarVagas(); return vagaOut(acharVaga(id));
  }
  function validarPublicacao(v) {
    const hoje = hojeBR();
    if (!v.titulo || !v.area) throw fail(400, 'Título e área são obrigatórios.');
    if ((v.descricao || '').length < 20) throw fail(400, 'Escreva a descrição da vaga (o candidato a lê no site).');
    if (!v.encerraEm) throw fail(400, 'Defina o prazo: toda vaga publicada precisa de uma data para fechar sozinha.');
    if (v.encerraEm < hoje) throw fail(400, 'O prazo já passou. Defina uma data de hoje em diante.');
    if (difDias(v.encerraEm, hoje) > PRAZO_MAX) throw fail(400, `O prazo máximo é de ${PRAZO_MAX} dias; depois você pode prorrogar.`);
    if (v.abreEm && v.abreEm > v.encerraEm) throw fail(400, 'O prazo não pode ser antes da data de publicação.');
    const k = contagem(v);
    if (v.limiteCandidatos && k.candidatos >= v.limiteCandidatos) throw fail(409, `A vaga já tem ${k.candidatos} candidaturas; aumente o limite para reabrir.`);
    if (k.contratados >= (v.posicoes || 1)) throw fail(409, 'As posições já foram preenchidas; aumente o número de posições para reabrir.');
  }
  async function acaoVaga(user, id, { acao, dias: d, destino, ...campos }, bearer) {
    let v = acharVaga(id); const hoje = hojeBR();
    if (acao === 'finalizar') {
      if (v.status !== 'encerrada') throw fail(409, 'Só dá para finalizar o fluxo de uma vaga encerrada.');
      if (!['banco', 'reprovado'].includes(destino)) throw fail(400, 'Escolha o destino: banco de talentos ou não seguiram.');
      const agora = new Date().toISOString(); let n = 0;
      for (const c of store.candidatos) if ((c.dados.vaga || '') === v.codigo && ['novo', 'triagem', 'entrevista'].includes(c.status)) {
        c.historico.unshift({ em: agora, tipo: 'etapa', por: user.id, porNome: user.nome, de: c.status, para: destino, texto: `Vaga encerrada: ${c.status} → ${destino}` }); c.status = destino; c.etapaDesde = agora; c.atualizadoEm = agora; n++;
      }
      store.touch(); store.audit(user, 'vaga.finalizar', `${v.codigo}: ${n} candidato(s) → ${destino}`); return { ...vagaOut(v), movidos: n };
    }
    if (['publicar', 'reabrir'].includes(acao)) {
      if (acao === 'publicar' && !['rascunho', 'pausada'].includes(v.status)) throw fail(409, 'Esta vaga já está publicada ou encerrada (use Reabrir).');
      if (acao === 'reabrir' && v.status !== 'encerrada') throw fail(409, 'Só vagas encerradas podem ser reabertas.');
      v = await vagaDados(campos, bearer, v);                      // reabrir/publicar aceitam já corrigir prazo, limite e posições
      validarPublicacao(v);
      v = { ...v, status: v.abreEm && v.abreEm > hoje ? 'agendada' : 'aberta', encerradaMotivo: undefined, encerradaEm: undefined };
    } else if (acao === 'pausar') {
      if (v.status !== 'aberta') throw fail(409, 'Só vagas abertas podem ser pausadas.'); v = { ...v, status: 'pausada' };
    } else if (acao === 'encerrar') {
      if (!['aberta', 'agendada', 'pausada'].includes(v.status)) throw fail(409, 'A vaga não está publicada.'); v = { ...v, status: 'encerrada', encerradaMotivo: 'manual', encerradaEm: new Date().toISOString() };
    } else if (acao === 'prorrogar') {
      if (!['aberta', 'pausada', 'agendada'].includes(v.status)) throw fail(409, 'Para vaga encerrada use Reabrir.');
      const n = intOu(d, 1, 90, 'Dias'); const novo = somaDias(v.encerraEm && v.encerraEm >= hoje ? v.encerraEm : hoje, n);
      if (difDias(novo, hoje) > PRAZO_MAX) throw fail(400, `O prazo não pode passar de ${PRAZO_MAX} dias a partir de hoje.`);
      v = { ...v, encerraEm: novo };
    } else throw fail(400, 'Ação inválida.');
    gravaVaga(v); store.audit(user, `vaga.${acao}`, v.codigo); atualizarVagas(); return vagaOut(acharVaga(id));
  }
  function excluirVaga(user, id) {
    const v = acharVaga(id);
    if (store.candidatos.some(c => (c.dados.vaga || '') === v.codigo)) throw fail(409, 'A vaga já tem candidatos: encerre-a em vez de excluir.');
    store.setVagas(store.vagas.filter(x => x.id !== id)); store.audit(user, 'vaga.excluir', v.codigo); return { ok: true };
  }
  const vagas = () => { atualizarVagas(); return { vagas: store.vagas.map(vagaOut), areas: AREAS, tipos: TIPOS, modelos: MODELOS, prazoMax: PRAZO_MAX, hoje: hojeBR() }; };
  const publica = v => ({ codigo: v.codigo, titulo: v.titulo, area: v.area, cidade: v.cidade, tipoContrato: v.tipoContrato || '', modelo: v.modelo || '', faixaSalarial: v.mostrarSalario ? v.faixaSalarial || '' : '', encerraEm: v.encerraEm });
  const vagasPublicas = () => { atualizarVagas(); return { vagas: store.vagas.filter(v => v.status === 'aberta').map(v => ({ ...publica(v), descricao: v.descricao.slice(0, 400) })) }; };
  const vagaPublica = codigo => { atualizarVagas(); const v = vagaPor(codigo); if (!v || v.status !== 'aberta') throw fail(404, 'Vaga não encontrada ou já encerrada.'); return { vaga: { ...publica(v), descricao: v.descricao, requisitos: v.requisitos } }; };

  // ---------- configuração do módulo ----------
  const config = () => { const c = cfg(); return { slaDias: c.slaDias, iaAtiva: c.iaAtiva && !!ia?.ativa, iaDisponivel: !!ia?.ativa, areas: AREAS.map(a => ({ area: a, responsaveis: c.areas[a] || [] })), etapasComPrazo: Object.keys(SLA_PADRAO) }; };
  function salvarConfig(user, p) {
    const c = cfg(), novo = { ...store.curConfig, areas: c.areas, rr: c.rr, slaDias: { ...c.slaDias }, iaAtiva: c.iaAtiva };
    if (p.slaDias) for (const [k, v] of Object.entries(p.slaDias)) {
      if (!(k in SLA_PADRAO)) throw fail(400, 'Etapa sem prazo configurável.');
      const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 90) throw fail(400, 'O prazo deve ser de 1 a 90 dias.'); novo.slaDias[k] = n;
    }
    if (p.iaAtiva !== undefined) novo.iaAtiva = p.iaAtiva === true;
    salvaCfg(novo); store.audit(user, 'curriculos.config', JSON.stringify({ sla: p.slaDias, ia: p.iaAtiva })); return config();
  }
  async function addResponsavel(user, bearer, area, userId) {
    if (!AREAS.includes(area)) throw fail(400, 'Área inválida.');
    const u = await usuarios.porId(bearer, String(userId)); if (!u) throw fail(404, 'Usuário não encontrado no Bitrix24.');
    const c = cfg(), l = c.areas[area] || [];
    if (l.some(x => x.userId === u.id)) throw fail(400, 'Este usuário já é responsável pela área.');
    salvaCfg({ ...store.curConfig, areas: { ...c.areas, [area]: [...l, { userId: u.id, nome: u.nome }] }, rr: c.rr });
    store.audit(user, 'curriculos.responsavel+', `${area}: ${u.nome}`); return config();
  }
  function removeResponsavel(user, area, userId) {
    const c = cfg(), l = c.areas[area] || [];
    if (!l.some(x => x.userId === String(userId))) throw fail(404, 'Responsável não encontrado.');
    salvaCfg({ ...store.curConfig, areas: { ...c.areas, [area]: l.filter(x => x.userId !== String(userId)) }, rr: c.rr });
    store.audit(user, 'curriculos.responsavel-', `${area}: #${userId}`); return config();
  }
  return { receber, listar, detalhe, atualizar, excluir, baixarCv, reanalisar, vagas, vagasPublicas, vagaPublica, criarVaga, editarVaga, acaoVaga, excluirVaga, atualizarVagas, config, salvarConfig, addResponsavel, removeResponsavel, retomar, aguardarIa, STATUS };
}
module.exports = { createCurriculos, STATUS };
