'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderDemonstrativo } = require('../lib/demonstrativo');

const itens = [
  { titulo: 'Repasse Connect Think — Licença <b>Pro</b>', cliente: 'Cliente "A" & Cia', cobranca: 9338, regra: '10% do bruto', base: 1000, venc: '2026-11-20', valor: 100, estado: 'aberto' },
  { titulo: 'Repasse Connect Think — Plano Standard', cliente: 'Studio; Pixel', cobranca: 9301, regra: '10% do líquido', base: 980, venc: '2026-10-17', valor: 98, estado: 'pago', pagoEm: '2026-10-18', valorPago: 97.5 },
];
const base = { empresa: 'Manda4', beneficiario: 'Connect Think', ref: 10501, venc: '2026-11-25', forma: 'Pix', emissao: '2026-10-31', mensagem: 'Segue o detalhe dos repasses de outubro.' };

test('consolidado: assunto, total, resumo e itens corretos nas três versões', () => {
  const r = renderDemonstrativo({ ...base, tipo: 'consolidado', itens: itens.map(i => ({ ...i, estado: 'aberto' })) });
  assert.equal(r.assunto, 'Demonstrativo de pagamento · Manda4 · Connect Think · #10501 · 31/10/2026');
  assert.equal(r.total, 198);
  for (const t of ['Connect Think', '#10501', '25/11/2026', 'Pix', 'R$ 198,00', '20/11/2026', 'cobrança #9338', '10% do bruto', 'Segue o detalhe']) assert.ok(r.html.includes(t.replace(/&/g, '&amp;')) || r.texto.includes(t), t);
  assert.match(r.texto, /1\. Repasse Connect Think — Licença <b>Pro<\/b> \| Cliente "A" & Cia · cobrança #9338/);   // texto puro não escapa
  assert.match(r.texto, /TOTAL: R\$ 198,00/);
  assert.equal(r.arquivo, 'demonstrativo-connect-think-10501.csv');
});

test('HTML escapa tudo o que vem do Bitrix (sem injeção) e não usa <script>', () => {
  const r = renderDemonstrativo({ ...base, beneficiario: '<img src=x onerror=alert(1)>', mensagem: '<script>alert(1)</script>', tipo: 'consolidado', itens });
  assert.ok(!/<script/i.test(r.html) && !/<img src=x/i.test(r.html));
  assert.ok(r.html.includes('&lt;b&gt;Pro&lt;/b&gt;') && r.html.includes('Cliente &quot;A&quot; &amp; Cia'));
  assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('CSV: BOM, ; como separador, vírgula decimal, aspas escapadas e linha de total', () => {
  const r = renderDemonstrativo({ ...base, tipo: 'consolidado', itens });
  assert.ok(r.csv.startsWith('﻿"Descrição";"Cliente";"Cobrança de origem";"Regra";"Base de cálculo";"Vencimento original";"Valor"'));
  const linhas = r.csv.trim().split('\r\n');
  assert.equal(linhas.length, 4);                                                      // cabeçalho + 2 itens + total
  assert.equal(linhas[1], '"Repasse Connect Think — Licença <b>Pro</b>";"Cliente ""A"" & Cia";"9338";"10% do bruto";"1000,00";"20/11/2026";"100,00"');
  assert.ok(linhas[2].includes('"Studio; Pixel"'));                                    // ponto e vírgula dentro do texto fica protegido pelas aspas
  assert.equal(linhas[3], '"";"";"";"";"";"TOTAL";"198,00"');
});

test('extrato: usa o valor efetivamente pago, mostra situação e período', () => {
  const r = renderDemonstrativo({ empresa: 'Manda4', beneficiario: 'Connect Think', tipo: 'extrato', periodo: '01/10/2026 a 31/10/2026', emissao: '2026-10-31', itens });
  assert.match(r.assunto, /^Extrato de pagamentos · Manda4 · Connect Think · 31\/10\/2026$/);
  assert.equal(r.total, 197.5);                                                        // 100 (a pagar) + 97,50 (pago de fato)
  assert.ok(r.html.includes('01/10/2026 a 31/10/2026') && r.html.includes('Pago em 18/10/2026') && r.html.includes('A pagar'));
  assert.ok(r.csv.includes('"Pago";"18/10/2026";"97,50"'));
  assert.equal(renderDemonstrativo({ empresa: 'M', beneficiario: 'X', tipo: 'extrato', emissao: '2026-10-31', itens: [] }).total, 0);
});
