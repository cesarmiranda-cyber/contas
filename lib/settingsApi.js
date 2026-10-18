'use strict';
const { hint, checkKeyEnv, bitrixHost, checkWebhook, normalizaWebhook } = require('./secrets');
const R = require('./rules');

// Rotas da tela de Configurações: integração Asaas, conexão Bitrix24 e verificação do funil.
function createSettingsApi({ secrets, asaas, bitrix, store, svc }) {
  const envOf = () => process.env.ASAAS_ENV === 'production' ? 'production' : 'sandbox';
  const asaasSource = () => (secrets.get('asaasKey') ? 'painel' : process.env.ASAAS_API_KEY ? 'ambiente' : 'nenhuma');
  const bitrixSource = () => (secrets.get('bitrixWebhook') ? 'painel' : process.env.BITRIX_WEBHOOK ? 'ambiente' : 'nenhuma');

  // Aplica as credenciais efetivas (painel tem prioridade sobre variável de ambiente).
  function apply() {
    asaas.configure({ apiKey: secrets.get('asaasKey') || process.env.ASAAS_API_KEY || '', env: secrets.get('asaasEnv') || envOf() });
    bitrix.configure(secrets.get('bitrixWebhook') || process.env.BITRIX_WEBHOOK || '');
  }

  const fail = (code, msg) => { const e = new Error(msg); e.status = code; return e; };
  const friendly = (e, env) => (e.status === 401
    ? `O Asaas recusou a chave (401). Confira se ela é do ambiente ${env === 'production' ? 'de produção' : 'sandbox'} e se não foi desativada.`
    : e.message);

  async function testAsaas({ apiKey, env }) {
    const e = env === 'production' ? 'production' : 'sandbox';
    const key = String(apiKey || '').trim() || secrets.get('asaasKey') || process.env.ASAAS_API_KEY;
    const bad = checkKeyEnv(key, e);
    if (bad) throw fail(400, bad);
    try { return { ok: true, env: e, ...(await asaas.test({ apiKey: key, env: e })) }; }
    catch (err) { throw fail(400, friendly(err, e)); }
  }

  async function testBitrix(webhook) {
    const digitado = normalizaWebhook(webhook);
    const w = digitado || secrets.get('bitrixWebhook') || process.env.BITRIX_WEBHOOK || '';
    const bad = checkWebhook(w);
    if (bad) throw fail(400, bad);
    try {
      const r = await bitrix.call('profile', {}, w);
      const u = r.result || {};
      return { ok: true, host: bitrixHost(w), usuario: [u.NAME, u.LAST_NAME].filter(Boolean).join(' '), admin: !!u.ADMIN };
    } catch (err) { throw fail(400, `Não consegui falar com o Bitrix24: ${err.message}`); }
  }

  return {
    apply,
    routes: {
      'GET /api/settings': async () => ({
        asaas: { configured: asaas.enabled, source: asaasSource(), env: asaas.env, hint: hint(secrets.get('asaasKey') || process.env.ASAAS_API_KEY) },
        bitrix: { configured: bitrix.enabled, source: bitrixSource(), host: bitrixHost(bitrix.base), hint: hint(secrets.get('bitrixWebhook') || process.env.BITRIX_WEBHOOK) },
        config: store.config,
        funil: { categoria: R.CATEGORY_ID, etapas: R.STAGE_LABEL },
      }),

      'POST /api/settings/asaas/test': async (_, b) => testAsaas(b),

      'PUT /api/settings/asaas': async (_, b) => {
        const env = b.env === 'production' ? 'production' : 'sandbox';
        if (env === 'production' && b.confirmarProducao !== true) throw fail(400, 'Confirme que deseja operar em PRODUÇÃO (cobranças reais).');
        const t = await testAsaas({ apiKey: b.apiKey, env });           // só salva chave que funciona
        const patch = { asaasEnv: env };
        if (String(b.apiKey || '').trim()) patch.asaasKey = String(b.apiKey).trim();
        secrets.set(patch);
        apply();
        store.log('config', `Asaas configurado pelo painel (${env}, chave ${hint(secrets.get('asaasKey'))})`);
        return { ...t, saved: true };
      },

      'DELETE /api/settings/asaas': async () => {
        secrets.clear('asaasKey', 'asaasEnv');
        apply();
        store.log('config', 'Chave do Asaas removida do painel');
        return { ok: true, asaas: { configured: asaas.enabled, source: asaasSource() } };
      },

      'POST /api/settings/bitrix/test': async (_, b) => testBitrix(b.webhook),

      'PUT /api/settings/bitrix': async (_, b) => {
        const t = await testBitrix(b.webhook);
        secrets.set({ bitrixWebhook: normalizaWebhook(b.webhook) });
        apply();
        svc.invalidate();
        store.log('config', `Webhook do Bitrix24 atualizado pelo painel (${t.host})`);
        return { ...t, saved: true };
      },

      // Cria/valida campos e etapas do funil e confere se o Asaas está pronto.
      'POST /api/settings/verificar': async () => {
        const criados = await svc.ensureFields();
        const en = await svc.loadEnums(true);
        return {
          ok: true,
          camposCriados: criados,
          listas: { categorias: Object.keys(en.categoria).length, planos: Object.keys(en.plano).length, tipos: Object.keys(en.tipo).length, formas: Object.keys(en.forma).length },
          asaas: asaas.enabled ? 'configurado' : 'sem chave',
        };
      },
    },
  };
}
module.exports = { createSettingsApi };
