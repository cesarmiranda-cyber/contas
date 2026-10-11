'use strict';
const fs = require('fs');
const path = require('path');

// Credenciais salvas pelo painel (Configurações). Ficam em arquivo 0600 no diretório de dados
// persistente e nunca voltam inteiras para o navegador — só uma dica (últimos 4 caracteres).
function createSecrets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'secrets.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* sem segredos salvos */ }
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    get: k => data[k],
    set(patch) { data = { ...data, ...patch }; save(); },
    clear(...keys) { for (const k of keys) delete data[k]; save(); },
  };
}

const hint = v => (v ? `••••${String(v).slice(-4)}` : '');

// Chaves do Asaas têm prefixo por ambiente; barra o erro clássico de colar a chave no ambiente errado.
function checkKeyEnv(apiKey, env) {
  const k = String(apiKey || '').trim();
  if (!k) return 'Informe a chave de API.';
  if (/\s/.test(k)) return 'A chave não pode ter espaços ou quebras de linha.';
  if (env === 'production' && /_hmlg_/.test(k)) return 'Esta é uma chave do SANDBOX. Para produção use a chave gerada em asaas.com.';
  if (env === 'sandbox' && /_prod_/.test(k)) return 'Esta é uma chave de PRODUÇÃO. Para o sandbox use a chave gerada em sandbox.asaas.com.';
  return null;
}

function bitrixHost(webhook) {
  try { return new URL(webhook).host; } catch { return ''; }
}
function checkWebhook(w) {
  try {
    const u = new URL(String(w).trim());
    if (u.protocol !== 'https:') return 'A URL do webhook deve começar com https://';
    if (!/\/rest\/\d+\/[^/]+\/?$/.test(u.pathname)) return 'Formato esperado: https://seu-portal.bitrix24.com.br/rest/1/CODIGO/';
    return null;
  } catch { return 'URL inválida.'; }
}
module.exports = { createSecrets, hint, checkKeyEnv, bitrixHost, checkWebhook };
