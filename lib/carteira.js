'use strict';
// Carteira de clientes: ativo/inativo, tipo de serviço, contrato (alerta de vencimento), checklist de serviços e e-mail marketing.
const TIPOS = { consultoria_assessoria: 'Contrato de consultoria e assessoria', consultoria: 'Contrato de consultoria', assessoria: 'Contrato de assessoria', rt: 'Contrato de RT', pat: 'Contrato de PAT', esporadico: 'Cliente esporádico' };
const CONSULTORIA = ['consultoria_assessoria', 'consultoria', 'assessoria'];
const ESPORADICOS = ['Rotulagem nutricional', 'Manual de boas práticas e POP', 'Tabelas nutricionais', 'Fichas técnicas', 'Alvará sanitário', 'Licença de funcionamento'];
const ITENS = { treinamento: ['sim', 'nao'], mbpPop: ['sim', 'andamento', 'nao'], alvara: ['sim', 'nao'], licenca: ['sim', 'nao'] };
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const dataOk = v => { v = txt(v, 10); if (!v) return ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw bad(`Data inválida: ${v}.`); return v; };
const dias = (de, ate) => Math.round((Date.parse(ate + 'T00:00:00Z') - Date.parse(de + 'T00:00:00Z')) / 864e5);

// Valor efetivo: o que a equipe marcou à mão vale mais que o que veio do Bitrix24.
const ativo = c => (c.ativoManual === true || c.ativoManual === false ? c.ativoManual : c.ativoAuto);
const item = (c, k) => (c.manual && c.manual[k]) || (c.auto && c.auto[k]) || 'nao';
const origemItem = (c, k) => (c.manual && c.manual[k] ? 'manual' : c.auto && c.auto[k] ? 'bitrix' : 'sem registro');
function contratoSituacao(c, hoje) {
  const fim = c.contrato && c.contrato.fim; if (!fim) return { estado: 'sem', dias: null };
  const d = dias(hoje, fim); return { estado: d < 0 ? 'vencido' : d <= 30 ? 'vencendo' : 'ok', dias: d, fim };
}
function validaEdicao(p) {
  const out = {};
  if (p.tipo !== undefined) { if (p.tipo !== '' && !TIPOS[p.tipo]) throw bad('Tipo de serviço inválido.'); out.tipo = p.tipo; }
  if (p.esporadicos !== undefined) { const l = [].concat(p.esporadicos).map(x => txt(x, 60)).filter(Boolean); if (!l.every(x => ESPORADICOS.includes(x))) throw bad('Serviço esporádico inválido.'); out.esporadicos = [...new Set(l)]; }
  if (p.contrato !== undefined) { const c = p.contrato || {}, v = c.valor === '' || c.valor == null ? null : Number(c.valor); if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1e8)) throw bad('Valor do contrato inválido.'); const inicio = dataOk(c.inicio), fim = dataOk(c.fim); if (inicio && fim && fim < inicio) throw bad('O fim do contrato é anterior ao início.'); out.contrato = { inicio, fim, valor: v, dealId: txt(c.dealId, 12).replace(/\D/g, '') }; }
  if (p.ativoManual !== undefined) { if (p.ativoManual !== null && typeof p.ativoManual !== 'boolean') throw bad('Situação inválida.'); out.ativoManual = p.ativoManual; }
  if (p.manual !== undefined) { const m = {}; for (const [k, v] of Object.entries(p.manual || {})) { if (!ITENS[k]) continue; if (v === '' || v === null) continue; if (!ITENS[k].includes(v)) throw bad(`Valor inválido para ${k}.`); m[k] = v; } out.manual = m; }
  if (p.alvaraValidade !== undefined) out.alvaraValidade = dataOk(p.alvaraValidade);
  if (p.optOut !== undefined) out.optOut = !!p.optOut;
  if (p.obs !== undefined) out.obs = txt(p.obs, 500);
  return out;
}
// Tradução do que vem do Bitrix24 para o cadastro da carteira.
const TIPO_BITRIX = { 'assessoria / consultoria': 'consultoria_assessoria', 'cadastro pat': 'pat' };
function deriva({ empresa, contrato, docs, regs, cursos, hoje, tipoNome }) {
  const sit = String(empresa.situacao || '').toLowerCase();
  const ativoAuto = sit === 'cliente' ? true : sit === 'cancelado' ? false : null;
  const auto = {};
  if (docs.length) auto.mbpPop = docs.some(d => d.entregue) ? 'sim' : docs.some(d => !d.cancelado) ? 'andamento' : 'nao';
  if (empresa.validadeAlvara) { auto.alvara = empresa.validadeAlvara >= hoje ? 'sim' : 'nao'; }
  else if (empresa.alvara) auto.alvara = 'sim';
  else if (regs.some(r => r.emitida)) auto.alvara = 'sim';
  if (empresa.validadeTreino ? empresa.validadeTreino >= hoje : cursos.some(c => c.ganho)) auto.treinamento = 'sim';
  const k = contrato && TIPO_BITRIX[String(tipoNome || '').trim().toLowerCase()];
  return { ativoAuto, auto, tipoBitrix: k || '', contratoBitrix: contrato ? { inicio: contrato.inicio || '', fim: contrato.fim || '', valor: contrato.valor == null ? null : contrato.valor, dealId: String(contrato.id || '') } : null };
}
module.exports = { TIPOS, CONSULTORIA, ESPORADICOS, ITENS, ativo, item, origemItem, contratoSituacao, validaEdicao, deriva, dias };
