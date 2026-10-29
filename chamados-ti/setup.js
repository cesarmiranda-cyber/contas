// Cria (de forma idempotente) os campos do chamado no SPA "Portal TI".
// Uso: VIBE_API_KEY=... node setup.js
const API = 'https://vibecode.bitrix24.com/v1';
const KEY = process.env.VIBE_API_KEY;
const TYPE = Number(process.env.SPA_TYPE_ID || 1074);
if (!KEY) { console.error('Defina VIBE_API_KEY'); process.exit(1); }

const call = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j.error || j)}`);
  return j;
};

const CATEGORIAS = ['Hardware / equipamento', 'Software / sistema', 'Rede / internet', 'E-mail / acessos e senhas', 'Impressora', 'Telefonia', 'Outros'];
const PRIORIDADES = ['Baixa', 'Média', 'Alta', 'Urgente'];
const enumOf = (l) => l.map((value, i) => ({ value, sort: (i + 1) * 10 }));

(async () => {
  const type = (await call('GET', `/smart-processes/${TYPE}`)).data;
  const prefix = `UF_CRM_${type.id}_`;
  const existing = (await call('GET', `/items/${TYPE}/userfields`)).data || [];
  const have = new Set(existing.map((f) => f.fieldName));
  const wanted = [
    { suffix: 'TI_SOLIC', userTypeId: 'string', label: 'Solicitante', showFilter: 'E', showInList: 'Y' },
    { suffix: 'TI_EMAIL', userTypeId: 'string', label: 'E-mail do solicitante', showFilter: 'E', showInList: 'Y' },
    { suffix: 'TI_SETOR', userTypeId: 'string', label: 'Setor / unidade', showFilter: 'E', showInList: 'Y' },
    { suffix: 'TI_CATEG', userTypeId: 'enumeration', label: 'Categoria', showFilter: 'I', showInList: 'Y', enum: enumOf(CATEGORIAS) },
    { suffix: 'TI_PRIOR', userTypeId: 'enumeration', label: 'Prioridade', showFilter: 'I', showInList: 'Y', enum: enumOf(PRIORIDADES) },
    { suffix: 'TI_DESC', userTypeId: 'string', label: 'Descrição do chamado', showInList: 'N', settings: { ROWS: 6 } },
  ];
  for (const f of wanted) {
    const fieldName = prefix + f.suffix;
    if (have.has(fieldName)) { console.log('já existe:', fieldName); continue; }
    const { suffix, ...body } = f;
    await call('POST', `/items/${TYPE}/userfields`, { ...body, fieldName, mandatory: 'N', sort: '200' });
    console.log('criado:', fieldName);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
