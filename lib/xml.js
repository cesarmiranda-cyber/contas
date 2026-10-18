'use strict';
// Leitor de XML mínimo e seguro (sem dependências): não expande entidades declaradas, ignora DOCTYPE e recusa
// <!ENTITY> (proteção contra XXE / "billion laughs"), limita tamanho, profundidade e quantidade de nós.
const bad = msg => { const e = new Error(msg); e.status = 400; return e; };
const MAX_BYTES = 3e6, MAX_NODES = 200000, MAX_DEPTH = 60;

const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
  e = e.toLowerCase();
  if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
  const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isInteger(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
});
const local = n => n.replace(/^.*:/, '');   // tira o prefixo de namespace (nfe:infNFe -> infNFe)

function parseXml(src) {
  let s = String(src || '');
  if (s.length > MAX_BYTES) throw bad('Arquivo XML muito grande (máx. 3 MB).');
  s = s.replace(/^﻿/, '');
  if (/<!ENTITY/i.test(s)) throw bad('XML com declaração de entidade não é aceito.');
  s = s.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '');
  const root = { name: '#root', attrs: {}, children: [], text: '' }, stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m, nodes = 0, last = 0;
  while ((m = re.exec(s))) {
    if (m.index !== last) throw bad('XML malformado.');
    last = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[6] !== undefined) { top.text += decode(m[6]); continue; }
    const name = local(m[3]);
    if (m[2]) {   // fechamento
      if (stack.length < 2 || top.name !== name) throw bad('XML malformado (tag fechada fora de ordem).');
      stack.pop(); continue;
    }
    if (++nodes > MAX_NODES) throw bad('XML complexo demais.');
    const attrs = {};
    for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = decode(a[2] ?? a[3] ?? '');
    const node = { name, attrs, children: [], text: '' };
    top.children.push(node);
    if (!m[5]) { if (stack.length >= MAX_DEPTH) throw bad('XML com aninhamento excessivo.'); stack.push(node); }
  }
  if (last !== s.length) throw bad('XML malformado.');
  if (stack.length !== 1) throw bad('XML incompleto (tag sem fechamento).');
  if (!root.children.length) throw bad('XML vazio.');
  return root.children[0];
}
// primeiro descendente com o nome (busca em profundidade)
const find = (n, name) => { if (!n) return null; for (const c of n.children) { if (c.name === name) return c; const r = find(c, name); if (r) return r; } return null; };
const kid = (n, name) => (n ? n.children.find(c => c.name === name) || null : null);
const kids = (n, name) => (n ? n.children.filter(c => c.name === name) : []);
const text = (n, name) => { const c = name ? kid(n, name) : n; return c ? c.text.trim() : ''; };
module.exports = { parseXml, find, kid, kids, text };
