'use strict';
// Consulta de CNPJ na Receita Federal pela BrasilAPI (gratuita, sem chave). Só dados cadastrais públicos de empresas.
const digits = v => String(v || '').replace(/\D/g, '');
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
function cnpjValido(v) {
  const c = digits(v); if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += Number(c[i]) * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}
const cap = s => String(s || '').toLowerCase().replace(/(^|\s|\/|-)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E)\b/g, m => m.toLowerCase());
function createCnpj({ fetchFn = (...a) => fetch(...a), base = 'https://brasilapi.com.br/api/cnpj/v1' } = {}) {
  return {
    cnpjValido,
    async consultar(cnpj) {
      const c = digits(cnpj); if (!cnpjValido(c)) throw bad('CNPJ inválido.');
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
      try {
        const r = await fetchFn(`${base}/${c}`, { signal: ctl.signal, headers: { Accept: 'application/json', 'User-Agent': 'nutrimix-app' } });
        if (r.status === 404) throw bad('CNPJ não encontrado na Receita Federal.', 404); if (r.status === 429) throw bad('Muitas consultas seguidas ao serviço da Receita. Tente de novo em alguns minutos.', 429);
        if (!r.ok) throw bad(`Consulta de CNPJ indisponível (${r.status}).`, 502); const j = await r.json();
        return { cnpj: c, razao: String(j.razao_social || '').trim(), fantasia: String(j.nome_fantasia || '').trim(), cidade: cap(j.municipio), uf: String(j.uf || '').toUpperCase().slice(0, 2), cep: digits(j.cep), bairro: cap(j.bairro), logradouro: cap(`${j.descricao_tipo_de_logradouro || ''} ${j.logradouro || ''}`.trim()), numero: String(j.numero || '').trim(), situacao: String(j.descricao_situacao_cadastral || '').trim() };
      } catch (e) { if (e.name === 'AbortError') throw bad('A consulta de CNPJ demorou demais.', 504); if (e.status) throw e; throw bad(`Não consegui consultar o CNPJ (${e.code || e.message}).`, 502); } finally { clearTimeout(t); }
    },
  };
}
module.exports = { createCnpj, cnpjValido, digits };
