'use strict';
const crypto = require('crypto');
const { validar, CONSENTIMENTO_VERSAO } = require('./candidatura');
const fail = (code, msg, extra) => Object.assign(new Error(msg), { status: code, ...extra });
const STATUS = [
  { id: 'novo', nome: 'Novos' }, { id: 'triagem', nome: 'Em triagem' }, { id: 'entrevista', nome: 'Entrevista' },
  { id: 'proposta', nome: 'Proposta' }, { id: 'contratado', nome: 'Contratados' }, { id: 'banco', nome: 'Banco de talentos' }, { id: 'reprovado', nome: 'Não seguiram' },
];
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const lim = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

function createCurriculos({ store }) {
  const resumo = c => ({
    id: c.id, protocolo: c.id.slice(0, 8).toUpperCase(), nome: c.dados.nome, email: c.dados.email, telefone: c.dados.telefone, cidade: c.dados.cidade, uf: c.dados.uf,
    area: c.dados.area, cargo: c.dados.cargo || '', vaga: c.dados.vaga || '', linkedin: c.dados.linkedin || '', temCv: !!c.cv, status: c.status,
    avaliacao: c.avaliacao || 0, tags: c.tags || [], criadoEm: c.criadoEm, atualizadoEm: c.atualizadoEm,
  });
  const achar = id => { const c = store.candidatos.find(x => x.id === id); if (!c) throw fail(404, 'Candidato não encontrado.'); return c; };

  // Entrada pública (site → canal External API). Reenvio do mesmo e-mail para a mesma vaga atualiza a ficha.
  function receber(body, origem) {
    if (body.website) return { protocolo: 'OK00' + crypto.randomBytes(2).toString('hex').toUpperCase(), descartado: true };
    const v = validar(body);
    if (!v.ok) throw fail(422, 'Verifique os campos informados.', { erros: v.erros });
    const agora = new Date().toISOString();
    const vaga = v.dados.vaga || '';
    let c = store.candidatos.find(x => x.dados.email === v.dados.email && (x.dados.vaga || '') === vaga);
    const arquivo = v.cv ? store.saveCv(v.cv.buf, v.cv.ext) : null;
    const cvInfo = v.cv ? { nome: v.cv.nome, ext: v.cv.ext, tamanho: v.cv.tamanho, arquivo } : null;
    if (c) {
      const antigo = c.cv?.arquivo;
      c.dados = { ...c.dados, ...v.dados };
      if (cvInfo) c.cv = cvInfo;
      c.atualizadoEm = agora;
      c.historico.unshift({ em: agora, tipo: 'reenvio', texto: 'Candidato reenviou a ficha' });
      if (antigo && cvInfo) { try { store.removeCv(antigo); } catch { /* ignora */ } }
      store.touch();
    } else {
      c = store.addCandidato({
        id: crypto.randomBytes(12).toString('hex'), criadoEm: agora, atualizadoEm: agora, status: 'novo', avaliacao: 0, tags: [],
        dados: v.dados, cv: cvInfo, notas: [], historico: [{ em: agora, tipo: 'entrada', texto: 'Ficha recebida pelo site' }],
        consentimento: { em: agora, versao: CONSENTIMENTO_VERSAO }, origemApi: { chave: origem || '' },
      });
    }
    return { protocolo: c.id.slice(0, 8).toUpperCase() };
  }

  function listar({ status, q, vaga, area, limite = 200, offset = 0 } = {}) {
    const t = norm(q).trim();
    let l = store.candidatos;
    if (status) l = l.filter(c => c.status === status);
    if (vaga) l = l.filter(c => (c.dados.vaga || '') === vaga);
    if (area) l = l.filter(c => c.dados.area === area);
    if (t) l = l.filter(c => norm(`${c.dados.nome} ${c.dados.email} ${c.dados.cargo || ''} ${c.dados.area} ${c.dados.cidade} ${(c.tags || []).join(' ')}`).includes(t));
    const porStatus = Object.fromEntries(STATUS.map(s => [s.id, 0])); for (const c of store.candidatos) porStatus[c.status] = (porStatus[c.status] || 0) + 1;
    return { total: l.length, porStatus, status: STATUS, itens: l.slice(offset, offset + Math.min(limite, 500)).map(resumo) };
  }
  const detalhe = id => { const c = achar(id); return { ...resumo(c), dados: c.dados, cv: c.cv ? { nome: c.cv.nome, tamanho: c.cv.tamanho, ext: c.cv.ext } : null, notas: c.notas, historico: c.historico, consentimento: c.consentimento }; };

  function atualizar(user, id, p) {
    const c = achar(id), agora = new Date().toISOString();
    if (p.status !== undefined) {
      if (!STATUS.some(s => s.id === p.status)) throw fail(400, 'Etapa inválida.');
      if (p.status !== c.status) { c.historico.unshift({ em: agora, tipo: 'etapa', por: user.id, porNome: user.nome, de: c.status, para: p.status, texto: `Etapa: ${c.status} → ${p.status}` }); c.status = p.status; }
    }
    if (p.avaliacao !== undefined) { const n = Number(p.avaliacao); if (!Number.isInteger(n) || n < 0 || n > 5) throw fail(400, 'Avaliação de 0 a 5.'); c.avaliacao = n; }
    if (p.tags !== undefined) { if (!Array.isArray(p.tags) || p.tags.length > 12) throw fail(400, 'Até 12 etiquetas.'); c.tags = [...new Set(p.tags.map(t => lim(t, 24)).filter(Boolean))]; }
    if (p.nota !== undefined) { const t = lim(p.nota, 1000); if (!t) throw fail(400, 'Escreva a anotação.'); c.notas.unshift({ em: agora, por: user.id, porNome: user.nome, texto: t }); }
    c.atualizadoEm = agora; store.touch();
    store.audit(user, 'candidato.alterar', `${c.id.slice(0, 8)} ${Object.keys(p).join(',')}`);
    return detalhe(id);
  }
  function excluir(user, id) {
    const c = achar(id); store.removeCandidato(id);
    store.audit(user, 'candidato.excluir', `${c.id.slice(0, 8)} ${c.dados.nome}`);
    return { ok: true };
  }
  function baixarCv(id) { const c = achar(id); if (!c.cv) throw fail(404, 'Este candidato não enviou arquivo.'); return { ...c.cv, buf: store.readCv(c.cv.arquivo) }; }
  return { receber, listar, detalhe, atualizar, excluir, baixarCv, STATUS };
}
module.exports = { createCurriculos, STATUS };
