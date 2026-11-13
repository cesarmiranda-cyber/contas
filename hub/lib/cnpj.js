'use strict';
// Validação/formatação de CNPJ e CPF + consulta na Receita Federal (via APIs públicas).

const onlyDigits = (s) => String(s ?? '').replace(/\D+/g, '');

function cnpjDigit(base) {
  let sum = 0, weight = base.length - 7;
  for (const ch of base) { sum += Number(ch) * weight--; if (weight < 2) weight = 9; }
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}
function isValidCnpj(v) {
  const d = onlyDigits(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const d1 = cnpjDigit(d.slice(0, 12));
  const d2 = cnpjDigit(d.slice(0, 12) + d1);
  return d.endsWith(`${d1}${d2}`);
}
function cpfDigit(base) {
  let sum = 0;
  for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (base.length + 1 - i);
  const r = (sum * 10) % 11;
  return r === 10 ? 0 : r;
}
function isValidCpf(v) {
  const d = onlyDigits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const d1 = cpfDigit(d.slice(0, 9));
  const d2 = cpfDigit(d.slice(0, 9) + d1);
  return d.endsWith(`${d1}${d2}`);
}
function formatCnpj(v) {
  const d = onlyDigits(v).slice(0, 14);
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
}
function formatCpf(v) {
  const d = onlyDigits(v).slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
}
function formatCep(v) {
  const d = onlyDigits(v).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

// ---- normalização ---------------------------------------------------------
const titleCase = (s) => String(s ?? '').trim().toLowerCase()
  .replace(/(^|[\s\-/(])([a-zà-ú])/g, (_, p, c) => p + c.toUpperCase())
  .replace(/\b(Da|De|Do|Das|Dos|E|Em|Na|No|Para|Por)\b/g, (m) => m.toLowerCase())
  .replace(/\b(Ltda|Me|Epp|Eireli|Slu|Sa|S\/A)\b/gi, (m) => ({ ltda: 'Ltda', me: 'ME', epp: 'EPP', eireli: 'EIRELI', slu: 'SLU', sa: 'S.A.', 's/a': 'S/A' }[m.toLowerCase()]));
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const phoneFrom = (ddd, num) => {
  const n = onlyDigits(`${ddd ?? ''}${num ?? ''}`);
  if (n.length < 10) return null;
  return n.length === 11 ? `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}` : `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
};
function parsePhones(raw) {
  return [...new Set(String(raw ?? '').split(/[\/;,]| ou /i).map((p) => {
    const d = onlyDigits(p);
    return d.length >= 10 ? phoneFrom('', d) : null;
  }).filter(Boolean))];
}
const isoDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) || /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (!m) return str(s);
  return m[1].length === 4 ? `${m[3]}/${m[2]}/${m[1]}` : `${m[1]}/${m[2]}/${m[3]}`;
};

function fromBrasilApi(j) {
  const phones = [phoneFrom('', j.ddd_telefone_1), phoneFrom('', j.ddd_telefone_2)].filter(Boolean);
  const tipo = str(j.descricao_tipo_de_logradouro);
  const logr = str(j.logradouro);
  return {
    cnpj: onlyDigits(j.cnpj),
    razaoSocial: titleCase(j.razao_social),
    nomeFantasia: titleCase(j.nome_fantasia),
    situacao: titleCase(j.descricao_situacao_cadastral),
    situacaoData: isoDate(j.data_situacao_cadastral),
    motivoSituacao: titleCase(j.motivo_situacao_cadastral && j.descricao_motivo_situacao_cadastral),
    abertura: isoDate(j.data_inicio_atividade),
    naturezaJuridica: str(j.natureza_juridica),
    porte: titleCase(j.porte || j.descricao_porte),
    capitalSocial: Number(j.capital_social) || 0,
    matriz: j.descricao_identificador_matriz_filial ? /matriz/i.test(j.descricao_identificador_matriz_filial) : null,
    cnae: { codigo: str(j.cnae_fiscal), descricao: str(j.cnae_fiscal_descricao) },
    cnaesSecundarios: (j.cnaes_secundarios || []).filter((c) => c.codigo).map((c) => ({ codigo: str(c.codigo), descricao: str(c.descricao) })),
    endereco: {
      logradouro: titleCase(tipo && !new RegExp(`^${tipo}`, 'i').test(logr) ? `${tipo} ${logr}` : logr),
      numero: str(j.numero), complemento: titleCase(j.complemento), bairro: titleCase(j.bairro),
      cep: formatCep(j.cep), municipio: titleCase(j.municipio), uf: str(j.uf).toUpperCase(),
    },
    telefones: phones,
    email: str(j.email).toLowerCase(),
    socios: (j.qsa || []).map((q) => ({ nome: titleCase(q.nome_socio), qualificacao: titleCase(q.qualificacao_socio) })).filter((s) => s.nome),
    fonte: 'BrasilAPI',
  };
}
function fromReceitaWs(j) {
  const ativ = (j.atividade_principal || [])[0] || {};
  return {
    cnpj: onlyDigits(j.cnpj),
    razaoSocial: titleCase(j.nome),
    nomeFantasia: titleCase(j.fantasia),
    situacao: titleCase(j.situacao),
    situacaoData: isoDate(j.data_situacao),
    motivoSituacao: titleCase(j.motivo_situacao),
    abertura: isoDate(j.abertura),
    naturezaJuridica: str(j.natureza_juridica),
    porte: titleCase(j.porte),
    capitalSocial: Number(String(j.capital_social ?? '').replace(/[^\d.]/g, '')) || 0,
    matriz: j.tipo ? /matriz/i.test(j.tipo) : null,
    cnae: { codigo: onlyDigits(ativ.code), descricao: str(ativ.text) },
    cnaesSecundarios: (j.atividades_secundarias || []).filter((c) => onlyDigits(c.code)).map((c) => ({ codigo: onlyDigits(c.code), descricao: str(c.text) })),
    endereco: {
      logradouro: titleCase(j.logradouro), numero: str(j.numero), complemento: titleCase(j.complemento),
      bairro: titleCase(j.bairro), cep: formatCep(j.cep), municipio: titleCase(j.municipio), uf: str(j.uf).toUpperCase(),
    },
    telefones: parsePhones(j.telefone),
    email: str(j.email).toLowerCase(),
    socios: (j.qsa || []).map((q) => ({ nome: titleCase(q.nome), qualificacao: str(q.qual).replace(/^\d+-/, '') })).filter((s) => s.nome),
    fonte: 'ReceitaWS',
  };
}

class CnpjError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

// Tenta cada provedor em ordem. 404 = CNPJ inexistente (definitivo); demais falhas = tenta o próximo.
function createLookup({ fetchImpl = fetch, timeoutMs = 9000, providers } = {}) {
  const list = providers || [
    { name: 'BrasilAPI', url: (d) => `https://brasilapi.com.br/api/cnpj/v1/${d}`, map: fromBrasilApi },
    { name: 'ReceitaWS', url: (d) => `https://receitaws.com.br/v1/cnpj/${d}`, map: fromReceitaWs, isError: (j) => j.status === 'ERROR' },
  ];
  return async function lookup(input) {
    const d = onlyDigits(input);
    if (!isValidCnpj(d)) throw new CnpjError('CNPJ_INVALID', 'CNPJ inválido: confira os dígitos.', 400);
    let notFound = false;
    for (const p of list) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        const r = await fetchImpl(p.url(d), { signal: ctl.signal, headers: { Accept: 'application/json', 'User-Agent': 'hub-escritorio/1.0' } }).finally(() => clearTimeout(t));
        if (r.status === 404) { notFound = true; continue; }
        if (!r.ok) continue;
        const j = await r.json();
        if (p.isError?.(j)) { if (/n[aã]o encontrad|inv[aá]lid/i.test(j.message || '')) notFound = true; continue; }
        const out = p.map(j);
        out.cnpj = d;
        return out;
      } catch { /* próximo provedor */ }
    }
    if (notFound) throw new CnpjError('CNPJ_NOT_FOUND', 'CNPJ não encontrado na Receita Federal.', 404);
    throw new CnpjError('LOOKUP_UNAVAILABLE', 'A consulta à Receita Federal está indisponível agora. Tente novamente ou preencha manualmente.', 503);
  };
}

module.exports = { onlyDigits, isValidCnpj, isValidCpf, formatCnpj, formatCpf, formatCep, titleCase, fromBrasilApi, fromReceitaWs, createLookup, CnpjError };
