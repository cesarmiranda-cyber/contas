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
// Aceita o webhook como vem do Bitrix24 ou colado com pequenos deslizes: espaços/quebras de linha, aspas, sem https://,
// ou com o nome do método no fim (.../rest/1/CODIGO/profile.json). Devolve a URL no formato https://portal/rest/ID/CODIGO/.
function normalizaWebhook(raw) {
  let w = String(raw || '').trim().replace(/^["'<(\[]+|["'>)\]]+$/g, '').replace(/\s+/g, '');
  if (!w) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) w = 'https://' + w;
  try {
    const u = new URL(w), seg = u.pathname.split('/').filter(Boolean), i = seg.indexOf('rest');
    if (i >= 0 && /^\d+$/.test(seg[i + 1] || '') && seg[i + 2]) return `${u.protocol}//${u.host}/rest/${seg[i + 1]}/${seg[i + 2]}/`;
    return w;
  } catch { return w; }
}
function checkWebhook(w) {
  if (!String(w || '').trim()) return 'Cole a URL do webhook de entrada no campo (formato: https://seu-portal.bitrix24.com.br/rest/1/CODIGO/).';
  try {
    const u = new URL(String(w).trim());
    if (u.protocol !== 'https:') return 'A URL do webhook deve começar com https://';
    if (!/\/rest\/\d+\/[^/]+\/?$/.test(u.pathname)) return 'Formato esperado: https://seu-portal.bitrix24.com.br/rest/1/CODIGO/';
    // o servidor chama essa URL: barra endereços internos (SSRF)
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(':') || /^\d+$/.test(h)) return 'Endereço não permitido: use o endereço do seu portal Bitrix24.';
    if (u.username || u.password || (u.port && u.port !== '443')) return 'A URL do webhook não pode ter usuário, senha ou porta.';
    return null;
  } catch { return 'Isso não parece um endereço. Cole a URL completa do webhook de entrada (https://seu-portal.bitrix24.com.br/rest/1/CODIGO/).'; }
}
module.exports = { createSecrets, hint, checkKeyEnv, bitrixHost, checkWebhook, normalizaWebhook };
