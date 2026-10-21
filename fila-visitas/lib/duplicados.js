'use strict';
const R = require('./rules');
const { label } = require('./fields');

// Campos de usuário da Empresa com o mesmo nome (rótulo). Conta, em TODAS as empresas, quantas têm valor em cada um.
async function analisar(bitrix) {
  const campos = (await bitrix.call('crm.company.fields')).result || {};
  const ufs = (await bitrix.call('crm.company.userfield.list', { order: { ID: 'asc' } })).result || [];
  const idDe = Object.fromEntries(ufs.map(u => [u.FIELD_NAME, +u.ID]));
  const grupos = {};
  for (const [k, f] of Object.entries(campos)) {
    if (!k.startsWith('UF_CRM')) continue;
    (grupos[R.norm(label(f))] ||= []).push(k);
  }
  const dup = Object.entries(grupos).filter(([n, l]) => n && l.length > 1);
  const todos = dup.flatMap(([, l]) => l);
  const usados = Object.fromEntries(todos.map(k => [k, 0]));
  let empresas = 0;
  for (let i = 0; i < todos.length; i += 40) {
    const sel = ['ID', ...todos.slice(i, i + 40)];
    let start = 0;
    for (;;) {
      const r = await bitrix.call('crm.company.list', { select: sel, start });
      for (const c of r.result || []) {
        if (i === 0) empresas++;
        for (const k of sel.slice(1)) { const v = c[k]; if (!(v === null || v === undefined || v === '' || v === '0' || v === 0 || v === false || (Array.isArray(v) && !v.length))) usados[k]++; }
      }
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
  }
  return {
    empresas,
    grupos: dup.map(([nome, l]) => ({ nome, campos: l.map(k => ({ campo: k, id: idDe[k], rotulo: label(campos[k]), comValor: usados[k] })) })),
  };
}
// Só remove vazios, e nunca o último campo de cada nome (se todos estão vazios, fica o mais novo pelo código UF_CRM_).
function planejar(analise) {
  const apagar = [], manter = [], conflitos = [];
  for (const g of analise.grupos) {
    const vazios = g.campos.filter(c => c.comValor === 0), cheios = g.campos.filter(c => c.comValor > 0);
    if (cheios.length > 1) conflitos.push(g);
    if (cheios.length) { apagar.push(...vazios); manter.push(...cheios); }
    else { const [fica, ...resto] = [...vazios].sort((a, b) => parseInt(b.campo.replace(/\D/g, ''), 10) - parseInt(a.campo.replace(/\D/g, ''), 10)); manter.push(fica); apagar.push(...resto); }
  }
  return { apagar, manter, conflitos };
}
module.exports = { analisar, planejar };

// Apaga campos (por ID do userfield) depois de rechecar: continuam vazios em todas as empresas e o nome continua existindo em outro campo.
// Antes de apagar, grava a definição completa de cada campo em DATA_DIR/backup-campos-*.json.
async function apagar(bitrix, ids, dir) {
  const fs = require('fs'), path = require('path');
  const marca = path.join(dir, 'campos-apagados.json');
  if (fs.existsSync(marca)) return { pulado: 'já executado', ...JSON.parse(fs.readFileSync(marca, 'utf8')) };
  const a = await analisar(bitrix);
  const alvo = [], recusados = [];
  for (const id of ids) {
    const g = a.grupos.find(x => x.campos.some(c => c.id === id));
    const c = g?.campos.find(x => x.id === id);
    const sobra = g?.campos.some(x => x.id !== id && !ids.includes(x.id));
    if (c && c.comValor === 0 && sobra) alvo.push({ ...c, grupo: g.nome }); else recusados.push({ id, motivo: !c ? 'não é duplicado' : c.comValor ? `tem valor em ${c.comValor} empresa(s)` : 'seria o último com esse nome' });
  }
  const defs = [];
  for (const c of alvo) defs.push((await bitrix.call('crm.company.userfield.get', { id: c.id })).result);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `backup-campos-${Date.now()}.json`), JSON.stringify(defs, null, 1));
  const feitos = [], erros = [];
  for (const c of alvo) {
    try { await bitrix.call('crm.company.userfield.delete', { id: c.id }); feitos.push(`${c.id}:${c.campo}:${c.rotulo}`); }
    catch (e) { erros.push(`${c.id}:${c.campo}: ${e.message}`); }
  }
  const res = { feitos, erros, recusados };
  fs.writeFileSync(marca, JSON.stringify(res));
  return res;
}
module.exports.apagar = apagar;
