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
