'use strict';
const { hint } = require('./secrets');
const { inspecionaCertificado } = require('./bancoInter');
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });

// Tela Configurações → Integrações bancárias e de assinatura: credenciais do Banco Inter (OAuth + certificado) e da Autentique.
// Segredos ficam em secrets.json (0600) e nunca voltam inteiros ao navegador.
function createIntegracoesApi({ secrets, inter, autentique, store }) {
  const certInfo = c => { try { return inspecionaCertificado(c.cert, c.key); } catch (e) { return { erro: e.message }; } };
  const estado = () => {
    const i = secrets.get('inter') || {}, a = secrets.get('autentique') || {};
    return { inter: { configurado: inter.pronto(), clientId: i.clientId || '', clientSecretDica: hint(i.clientSecret), contaCorrente: i.contaCorrente || '', certificado: i.cert && i.key ? certInfo(i) : null, escopos: i.escopos || 'extrato.read' },
      autentique: { configurado: autentique.pronto(), tokenDica: hint(a.token), sandbox: !!a.sandbox },
      itau: { modo: 'arquivo', texto: 'Importação do extrato por arquivo OFX ou camt.053 (Itaú Empresas) já funciona em Contas → Conciliação. A API do Itaú depende de credenciamento do seu CNPJ no banco.' } };
  };
  const routes = {
    'GET': { re: /^\/api\/settings\/integracoes$/, h: async () => estado() },
  };
  async function handle(method, pathname, readBody) {
    if (!/^\/api\/settings\/integracoes(\/|$)/.test(pathname)) return null;
    if (method === 'GET' && pathname === '/api/settings/integracoes') return estado();
    const m = /^\/api\/settings\/integracoes\/(inter|autentique)(\/testar)?$/.exec(pathname); if (!m) return { error: 'não encontrado', status: 404 };
    const [, quem, testar] = m;
    if (quem === 'inter') {
      if (testar && method === 'POST') { try { return await inter.testar(); } catch (e) { throw bad(e.message, e.status || 502); } }
      if (method === 'DELETE') { secrets.clear('inter'); store.log('config', 'Banco Inter desconectado'); return estado(); }
      if (method === 'PUT') {
        const b = await readBody(), atual = secrets.get('inter') || {}, novo = { ...atual };
        for (const k of ['clientId', 'clientSecret', 'contaCorrente', 'escopos']) if (b[k] !== undefined && String(b[k]).trim()) novo[k] = String(b[k]).trim().slice(0, 300);
        if (b.cert && String(b.cert).trim()) novo.cert = String(b.cert).trim(); if (b.key && String(b.key).trim()) novo.key = String(b.key).trim();
        if (novo.clientId && !/^[\w.-]{8,100}$/.test(novo.clientId)) throw bad('Client ID inválido (apenas letras, números, ponto, hífen e sublinhado).');
        if (novo.escopos && !/^[\w.\- ]{3,300}$/.test(novo.escopos)) throw bad('Escopos inválidos.');
        if (novo.cert || novo.key) { const r = inspecionaCertificado(novo.cert, novo.key); if (r.vencido) throw bad(`O certificado venceu em ${r.validade}. Gere uma nova integração no Inter.`); }
        secrets.set({ inter: novo }); store.log('config', 'Banco Inter configurado'); return estado();
      }
    }
    if (quem === 'autentique') {
      if (testar && method === 'POST') { try { return await autentique.testar(); } catch (e) { throw bad(e.message, e.status || 502); } }
      if (method === 'DELETE') { secrets.clear('autentique'); store.log('config', 'Autentique desconectada'); return estado(); }
      if (method === 'PUT') { const b = await readBody(), a = secrets.get('autentique') || {}, token = String(b.token || '').trim() || a.token;
        if (!token) throw bad('Informe o token da API.'); if (!/^[\w.\-=+/]{16,400}$/.test(token)) throw bad('Token inválido (sem espaços ou quebras de linha).');
        secrets.set({ autentique: { token, sandbox: !!b.sandbox } }); store.log('config', 'Autentique configurada'); return estado(); }
    }
    throw bad('Método não permitido.', 405);
  }
  return { estado, handle };
}
module.exports = { createIntegracoesApi };
