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

// ---- campos duplicados de um SPA (ex.: Registro de Visita 1032): mesmo título em mais de um campo ----
const numDe = k => parseInt(k.replace(/\D/g, '').slice(-13), 10);
const vazio = v => v === null || v === undefined || v === '' || v === 0 || v === false || (Array.isArray(v) && !v.length);
// Campo padrão de cada grupo: o que o app usa (protegido) ou, na falta, o mais novo.
function agrupar(defs, protegidos) {
  const g = {};
  for (const [k, f] of Object.entries(defs)) if (k.startsWith('ufCrm')) (g[R.norm(f.title || f.formLabel || '')] ||= []).push(k);
  return Object.entries(g).filter(([n, l]) => n && l.length > 1).map(([nome, l]) => {
    const padrao = l.find(k => protegidos.includes(k)) || [...l].sort((a, b) => numDe(b) - numDe(a))[0];
    return { nome, titulo: (defs[padrao].title || nome).trim(), padrao, outros: l.filter(k => k !== padrao) };
  });
}
async function itensComCampos(bitrix, entityTypeId, campos) {
  const out = [];
  for (let i = 0; i < campos.length; i += 40) {
    let start = 0;
    for (;;) {
      const r = await bitrix.call('crm.item.list', { entityTypeId, select: ['id', ...campos.slice(i, i + 40)], start });
      for (const it of r.result?.items || []) { const x = out.find(o => o.id === it.id); if (x) Object.assign(x, it); else out.push({ ...it }); }
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
  }
  return out;
}
async function analisarSpa(bitrix, entityTypeId, protegidos = []) {
  const defs = (await bitrix.call('crm.item.fields', { entityTypeId })).result?.fields || {};
  const grupos = agrupar(defs, protegidos);
  const todos = grupos.flatMap(g => [g.padrao, ...g.outros]);
  const itens = await itensComCampos(bitrix, entityTypeId, todos);
  const uso = k => itens.filter(it => !vazio(it[k])).length;
  return { itens: itens.length, defs, grupos: grupos.map(g => ({ ...g, usoPadrao: uso(g.padrao), usoOutros: g.outros.map(k => [k, uso(k)]) })), dados: itens };
}
// Copia para o campo padrão os valores que só existem nos duplicados (listas: converte pelo nome da opção). Não apaga nada.
async function migrarSpa(bitrix, entityTypeId, protegidos = []) {
  const a = await analisarSpa(bitrix, entityTypeId, protegidos);
  const nomeOpt = (k, id) => ((a.defs[k].items || []).find(i => String(i.ID ?? i.id) === String(id)) || {}).VALUE;
  const idOpt = (k, nome) => String(((a.defs[k].items || []).find(i => R.norm(i.VALUE ?? i.value) === R.norm(nome)) || {}).ID ?? '');
  let copiados = 0; const falhas = [];
  for (const it of a.dados) {
    const set = {};
    for (const g of a.grupos) {
      if (!vazio(it[g.padrao])) continue;
      for (const o of g.outros) {
        if (vazio(it[o])) continue;
        let v = it[o];
        if ((a.defs[o].items || []).length) { const conv = x => idOpt(g.padrao, nomeOpt(o, x)); v = Array.isArray(v) ? v.map(conv).filter(Boolean) : conv(v); if (vazio(v)) { falhas.push(`item ${it.id} · ${g.titulo}: opção sem equivalente`); continue; } }
        set[g.padrao] = v; break;
      }
    }
    if (Object.keys(set).length) { await bitrix.call('crm.item.update', { entityTypeId, id: it.id, fields: set }); copiados += Object.keys(set).length; }
  }
  return { copiados, falhas };
}
async function apagarSpa(bitrix, entityTypeId, dir, protegidos) {
  const fs = require('fs'), path = require('path');
  const marca = path.join(dir, `campos-spa-${entityTypeId}-apagados.json`);
  if (fs.existsSync(marca)) return { pulado: 'já executado', ...JSON.parse(fs.readFileSync(marca, 'utf8')) };
  const mig = await migrarSpa(bitrix, entityTypeId, protegidos);
  const a = await analisarSpa(bitrix, entityTypeId, protegidos);
  // só apaga um campo duplicado se nenhum item perde dado (todo valor dele existe no padrão)
  const seguros = [], bloqueados = [];
  for (const g of a.grupos) for (const o of g.outros) {
    const perde = a.dados.some(it => !vazio(it[o]) && vazio(it[g.padrao]));
    (perde ? bloqueados : seguros).push({ campo: o, titulo: g.titulo });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `backup-spa-${entityTypeId}-${Date.now()}.json`), JSON.stringify({ grupos: a.grupos, dados: a.dados, defs: a.defs }, null, 1));
  const entityId = `CRM_${(seguros[0]?.campo.match(/^ufCrm(\d+)_/) || [])[1] || ''}`;
  const feitos = [], erros = [];
  if (seguros.length) {
    let lista = [];
    try { lista = (await bitrix.call('userfieldconfig.list', { moduleId: 'crm', filter: { entityId } })).result?.fields || []; } catch (e) { erros.push(`listar campos: ${e.message}`); }
    for (const c of seguros) {
      const sufixo = c.campo.replace(/^ufCrm\d+_/, '').toUpperCase();
      const def = lista.find(x => String(x.fieldName || '').toUpperCase().endsWith('_' + sufixo));
      if (!def) { if (!erros.length) erros.push(`${c.campo}: campo não encontrado na lista`); continue; }
      try { await bitrix.call('userfieldconfig.delete', { moduleId: 'crm', id: def.id }); feitos.push(`${def.id}:${c.campo}:${c.titulo}`); } catch (e) { erros.push(`${c.campo}: ${e.message}`); }
    }
  }
  const res = { migracao: mig, feitos, erros, bloqueados: bloqueados.map(b => `${b.campo}:${b.titulo}`), itens: a.itens };
  if (feitos.length) fs.writeFileSync(marca, JSON.stringify(res));
  return res;
}
module.exports.analisarSpa = analisarSpa; module.exports.migrarSpa = migrarSpa; module.exports.apagarSpa = apagarSpa; module.exports.agrupar = agrupar;
