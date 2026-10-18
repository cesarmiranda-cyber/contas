'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { parseXml } = require('../lib/xml');
const { parseNfe, chaveValida } = require('../lib/nfe');
const S = require('../lib/finEstoque');
const R = require('../lib/rules');
const { createFinStore } = require('../lib/finStore');
const { createSecrets } = require('../lib/secrets');
const { createEmpresas } = require('../lib/empresas');
const { createFinApi } = require('../lib/finApi');

const D = R.todayBR(), add = n => new Date(Date.parse(D + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function chaveDe(base43) { let p = 2, s = 0; for (let i = 42; i >= 0; i--) { s += Number(base43[i]) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return base43 + (r < 2 ? 0 : 11 - r); }
const CHAVE = chaveDe('4326101122233300018155001000001234112345678');
function nfeXml({ chave = CHAVE, destino = '19340693000190', dup = true, protocolo = true, xProd2 = 'Detergente 5L' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00">
<ide><cUF>43</cUF><natOp>Venda de mercadoria</natOp><mod>55</mod><serie>1</serie><nNF>1234</nNF><dhEmi>${add(-2)}T10:30:00-03:00</dhEmi><tpNF>1</tpNF></ide>
<emit><CNPJ>11222333000181</CNPJ><xNome>Distribuidora Sul &amp; Cia Ltda</xNome><xFant>Sul Distribuidora</xFant><enderEmit><xLgr>Rua A</xLgr><nro>100</nro><xBairro>Centro</xBairro><xMun>Porto Alegre</xMun><UF>RS</UF><fone>5133334444</fone></enderEmit><IE>123456789</IE></emit>
<dest><CNPJ>${destino}</CNPJ><xNome>NUTRI MIX ASSESSORIA LTDA</xNome></dest>
<det nItem="1"><prod><cProd>DET-001</cProd><cEAN>7891234567895</cEAN><xProd>Sabão em pó 1kg</xProd><NCM>34022000</NCM><CFOP>5102</CFOP><uCom>cx</uCom><qCom>10.0000</qCom><vUnCom>25.0000000000</vUnCom><vProd>250.00</vProd></prod><imposto><ICMS><ICMS00><vICMS>45.00</vICMS></ICMS00></ICMS></imposto></det>
<det nItem="2"><prod><cProd>DET-002</cProd><cEAN>SEM GTIN</cEAN><xProd>${xProd2}</xProd><NCM>34022000</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>5.0000</qCom><vUnCom>40.0000000000</vUnCom><vProd>200.00</vProd></prod></det>
<total><ICMSTot><vProd>450.00</vProd><vFrete>45.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vIPI>0.00</vIPI><vNF>495.00</vNF></ICMSTot></total>
${dup ? `<cobr><fat><nFat>1234</nFat><vOrig>495.00</vOrig></fat><dup><nDup>001</nDup><dVenc>${add(28)}</dVenc><vDup>247.50</vDup></dup><dup><nDup>002</nDup><dVenc>${add(58)}</dVenc><vDup>247.50</vDup></dup></cobr>` : ''}
<pag><detPag><tPag>15</tPag><vPag>495.00</vPag></detPag></pag>
<infAdic><infCpl>Pedido 77</infCpl></infAdic></infNFe></NFe>${protocolo ? `<protNFe><infProt><chNFe>${chave}</chNFe><cStat>100</cStat></infProt></protNFe>` : ''}</nfeProc>`;
}

test('XML: entidades, CDATA, namespaces e proteções (XXE, tag aberta, tamanho)', () => {
  const n = parseXml('<?xml version="1.0"?><a:r xmlns:a="x"><a:v k="1 &amp; 2">A &amp; B &#233; &lt;</a:v><c><![CDATA[<tag>]]></c><v/></a:r>');
  assert.equal(n.name, 'r'); assert.equal(n.children[0].text, 'A & B é <'); assert.equal(n.children[0].attrs.k, '1 & 2'); assert.equal(n.children[1].text, '<tag>');
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'), /entidade/);
  assert.throws(() => parseXml('<a><b></a>'), /malformado/);
  assert.throws(() => parseXml('<a><b>'), /incompleto|malformado/);
  assert.throws(() => parseXml('texto solto'), /malformado|vazio/);
  assert.throws(() => parseXml('<a>' + 'x'.repeat(3.1e6) + '</a>'), /grande/);
  assert.equal(parseXml('<a>&desconhecida;</a>').text, '&desconhecida;');            // entidade não declarada nunca é expandida
});

test('NF-e: dados do fornecedor, itens com custo (frete rateado), duplicatas e forma', () => {
  assert.ok(chaveValida(CHAVE)); assert.ok(!chaveValida(CHAVE.slice(0, 43) + '0'.replace(CHAVE[43], '1')));
  const n = parseNfe(nfeXml());
  assert.equal(n.numero, '1234'); assert.equal(n.chave, CHAVE); assert.equal(n.emissao, add(-2)); assert.equal(n.tipoOperacao, 'saida');
  assert.equal(n.fornecedor.doc, '11222333000181'); assert.equal(n.fornecedor.nome, 'Distribuidora Sul & Cia Ltda'); assert.equal(n.destinatario.doc, '19340693000190');
  assert.equal(n.itens.length, 2);
  assert.deepEqual([n.itens[0].qtd, n.itens[0].un, n.itens[0].ean, n.itens[1].ean], [10, 'CX', '7891234567895', '']);       // "SEM GTIN" não vira EAN
  assert.deepEqual([n.itens[0].custo, n.itens[0].custoUnit, n.itens[1].custo, n.itens[1].custoUnit], [275, 27.5, 220, 44]);   // frete de 45 rateado 25/20
  assert.equal(n.totais.total, 495); assert.equal(n.itens.reduce((a, i) => a + i.custo, 0), 495);
  assert.deepEqual(n.duplicatas.map(d => [d.numero, d.valor]), [['001', 247.5], ['002', 247.5]]); assert.equal(n.duplicatas[0].venc, add(28));
  assert.equal(n.formaSugerida, 'BOLETO'); assert.deepEqual(n.avisos, []);
  assert.ok(parseNfe(nfeXml({ protocolo: false })).avisos.some(a => /protocolo/.test(a)));
  assert.ok(parseNfe(nfeXml({ chave: CHAVE.slice(0, 43) + (CHAVE[43] === '1' ? '2' : '1') })).avisos.some(a => /dígito verificador/.test(a)));
  assert.throws(() => parseNfe('<resNFe><chNFe>1</chNFe></resNFe>'), /resumo/);
  assert.throws(() => parseNfe('<procEventoNFe><evento><infEvento/></evento></procEventoNFe>'), /evento/);
  assert.throws(() => parseNfe('<html><body>DANFE</body></html>'), /não é uma NF-e/);
});

test('estoque: custo médio móvel, saída pelo custo médio e bloqueio de saldo negativo', () => {
  const prod = { id: 'pr1', empresaId: 'e1', nome: 'Sabão', un: 'CX', estoqueMin: 12, ativo: true };
  const mv = (seq, data, tipo, qtd, custoUnit) => ({ id: 'm' + seq, produtoId: 'pr1', empresaId: 'e1', data, tipo, qtd, custoUnit, seq });
  const movs = [mv(1, '2026-10-01', 'entrada', 10, 20), mv(2, '2026-10-05', 'entrada', 10, 30), mv(3, '2026-10-06', 'saida', -5)];
  const p = S.posicao([prod], movs).porProduto.get('pr1');
  assert.equal(p.saldo, 15); assert.equal(p.custoMedio, 25); assert.equal(p.valor, 375);
  assert.equal(p.movimentos[2].custoUnit, 25); assert.equal(p.movimentos[2].custoTotal, -125);   // saída pelo custo médio
  assert.equal(p.abaixoMinimo, false); assert.equal(S.comPosicao([{ ...prod, estoqueMin: 20 }], movs)[0].abaixoMinimo, true);
  const ok = S.validarMovimento({ produtoId: 'pr1', tipo: 'saida', qtd: 15, data: '2026-10-07' }, [prod], movs, '2026-10-18');
  assert.equal(ok.qtd, -15);
  assert.throws(() => S.validarMovimento({ produtoId: 'pr1', tipo: 'saida', qtd: 16 }, [prod], movs, '2026-10-18'), /Saldo insuficiente/);
  assert.throws(() => S.validarMovimento({ produtoId: 'pr1', tipo: 'saida', qtd: 12, data: '2026-10-02' }, [prod], movs, '2026-10-18'), /Saldo insuficiente/);   // antes da 2ª entrada só havia 10
  assert.throws(() => S.validarMovimento({ produtoId: 'pr1', tipo: 'entrada', qtd: 1 }, [prod], movs, '2026-10-18'), /custo unitário/);
  assert.equal(S.validarMovimento({ produtoId: 'pr1', tipo: 'ajuste', qtd: -2 }, [prod], movs, '2026-10-18').qtd, -2);
  assert.throws(() => S.validarMovimento({ produtoId: 'pr1', tipo: 'saida', qtd: 1, data: '2027-01-01' }, [prod], movs, '2026-10-18'), /futura/);
});

// ---------- API ----------
function api() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-')), fin = createFinStore(dir), secrets = createSecrets(dir);
  const bitrix = { enabled: false, base: '', call: async () => ({ result: [] }), listAll: async () => [] };
  const empresas = createEmpresas({ fin, secrets, bitrix, createAsaas: () => ({ configure() {}, enabled: false }) });
  const a = createFinApi({ fin, empresas, svc: { dealsCached: async () => [] }, bitrix, asaas: { as: (_, f) => f(), enabled: false }, store: { log() {} }, dataDir: dir });
  const call = async (method, p, body, q = '') => (await a.handle(method, `/api/fin${p}`, new URL('http://x/?' + q), async () => body || {}))?.json;
  return { call, fin, dir };
}

test('API NF-e: prévia sugere empresa, importa com duplicatas, cria fornecedor/produtos/estoque e barra nota repetida', async () => {
  const { call, fin, dir } = api();
  const emp = await call('POST', '/empresas', { nome: 'Nutri Mix', cnpj: '19.340.693/0001-90' }), outra = await call('POST', '/empresas', { nome: 'Outra', cnpj: '11.222.333/0001-81' });
  const conta = await call('POST', '/cad/contas', { empresaId: emp.id, nome: 'Itaú', saldoInicial: 0 });
  const xml = nfeXml();
  const pv = await call('POST', '/nfe/previa', { xml });
  assert.equal(pv.empresaSugerida, emp.id); assert.equal(pv.duplicada, null); assert.equal(pv.fornecedorId, ''); assert.deepEqual(pv.produtos.map(p => p.como), ['novo', 'novo']);
  await assert.rejects(call('POST', '/nfe/importar', { xml, empresaId: outra.id }), /destinatário/);
  const r = await call('POST', '/nfe/importar', { xml, empresaId: emp.id, entradaEm: D, contaId: conta.id, categoria: 'Fornecedores', obs: 'Conferido no recebimento' });
  assert.equal(r.titulos, 2); assert.equal(r.produtosNovos, 2); assert.equal(r.movimentos, 2); assert.equal(r.fornecedorCriado, true);
  const t = fin.pagar.all();
  assert.deepEqual(t.map(x => [x.valor, x.venc, x.parcela]), [[247.5, add(28), '1/2'], [247.5, add(58), '2/2']]);
  assert.ok(t.every(x => x.fornecedor === 'Distribuidora Sul & Cia Ltda' && x.notaId === r.nota.id && x.contaId === conta.id && x.categoria === 'Fornecedores' && /NF-e 1234\/1/.test(x.descricao) && x.obs.includes(CHAVE)));
  assert.deepEqual(t.map(x => x.parcelaTitulo), ['Duplicata 001', 'Duplicata 002']);
  const f = fin.fornecedores.all()[0]; assert.equal(f.doc, '11222333000181'); assert.equal(t[0].contatoId, f.id);
  const prods = await call('GET', '/produtos', null, `empresa=${emp.id}`);
  const a = prods.find(p => p.ean === '7891234567895'), b = prods.find(p => p.nome === 'Detergente 5L');
  assert.deepEqual([a.saldo, a.custoMedio, a.un, a.valor], [10, 27.5, 'CX', 275]); assert.deepEqual([b.saldo, b.custoMedio], [5, 44]);
  assert.deepEqual(a.codigosFornecedor, [{ doc: '11222333000181', cProd: 'DET-001' }]);
  assert.equal(r.nota.anexos.length, 1); assert.ok(fs.readFileSync(path.join(dir, 'anexos', r.nota.anexos[0].id), 'utf8').includes('<nfeProc'));   // XML guardado
  await assert.rejects(call('POST', '/nfe/importar', { xml, empresaId: emp.id }), /já foi importada/);
  assert.equal((await call('POST', '/nfe/previa', { xml })).duplicada.numero, '1234');
  // mesma nota num segundo fornecedor novo reaproveita vínculo: sugere os produtos já criados
  const pv2 = await call('POST', '/nfe/previa', { xml: nfeXml({ chave: chaveDe('4326101122233300018155001000001235112345678') }) });
  assert.deepEqual(pv2.produtos.map(p => p.como), ['vinculo', 'vinculo']); assert.equal(pv2.fornecedorId, f.id);
});

test('API NF-e: sem duplicatas usa condição, pode não dar entrada no estoque e item pode ficar fora', async () => {
  const { call, fin } = api();
  const emp = await call('POST', '/empresas', { nome: 'Nutri Mix', cnpj: '19.340.693/0001-90' });
  const xml = nfeXml({ dup: false });
  const r = await call('POST', '/nfe/importar', { xml, empresaId: emp.id, entradaEm: D, titulos: { modo: 'condicao', condicaoId: 'cp_30_60_90', base: D }, darEntradaEstoque: false });
  assert.equal(r.titulos, 3); assert.equal(r.movimentos, 0); assert.equal(fin.produtos.all().length, 0);
  assert.equal(F_sum(fin.pagar.all()), 495);
  const c2 = chaveDe('4326101122233300018155001000001236112345678');
  const r2 = await call('POST', '/nfe/importar', { xml: nfeXml({ dup: false, chave: c2 }), empresaId: emp.id, entradaEm: D, titulos: { modo: 'nenhum' }, itens: [{ n: 1, estoque: false }, { n: 2, produtoId: 'novo', nome: 'Detergente neutro 5L', un: 'GL' }] });
  assert.equal(r2.titulos, 0); assert.equal(r2.movimentos, 1);
  assert.equal((await call('GET', '/produtos'))[0].nome, 'Detergente neutro 5L');
  await assert.rejects(call('POST', '/nfe/importar', { xml: nfeXml({ dup: false, chave: chaveDe('4326101122233300018155001000001237112345678') }), empresaId: emp.id, entradaEm: add(5), titulos: { modo: 'nenhum' } }), /futura/);
});
const F_sum = l => Math.round(l.reduce((a, x) => a + x.valor, 0) * 100) / 100;

test('API NF-e: cancelar estorna títulos e estoque; bloqueia se pago ou se o estoque já foi consumido', async () => {
  const { call, fin } = api();
  const emp = await call('POST', '/empresas', { nome: 'Nutri Mix', cnpj: '19.340.693/0001-90' });
  const conta = await call('POST', '/cad/contas', { empresaId: emp.id, nome: 'Itaú', saldoInicial: 0, dataSaldo: add(-30) });
  const r = await call('POST', '/nfe/importar', { xml: nfeXml(), empresaId: emp.id, entradaEm: add(-1) });
  const prod = (await call('GET', '/produtos'))[0];
  await call('POST', '/estoque/movimento', { produtoId: prod.id, tipo: 'saida', qtd: 3, data: D, obs: 'Consumo' });
  await assert.rejects(call('POST', `/notas/${r.nota.id}/cancelar`), /já foi consumida/);
  await call('POST', '/estoque/movimento', { produtoId: prod.id, tipo: 'ajuste', qtd: 3, custoUnit: 0, obs: 'devolução' });
  await assert.rejects(call('POST', '/estoque/movimento', { produtoId: prod.id, tipo: 'saida', qtd: 999 }), /Saldo insuficiente/);
  const t1 = fin.pagar.all()[0];
  await call('POST', `/pagar/${t1.id}/baixar`, { data: D, contaId: conta.id });
  await assert.rejects(call('POST', `/notas/${r.nota.id}/cancelar`), /já pago/);
});

test('API NF-e: cancelamento limpa tudo quando nada foi usado', async () => {
  const { call, fin } = api();
  const emp = await call('POST', '/empresas', { nome: 'Nutri Mix', cnpj: '19.340.693/0001-90' });
  const r = await call('POST', '/nfe/importar', { xml: nfeXml(), empresaId: emp.id, entradaEm: D });
  const c = await call('POST', `/notas/${r.nota.id}/cancelar`);
  assert.equal(c.status, 'cancelada'); assert.ok(fin.pagar.all().every(t => t.status === 'cancelada')); assert.equal(fin.movimentos.all().length, 0);
  assert.ok((await call('GET', '/produtos')).every(p => p.saldo === 0));
  assert.equal((await call('POST', '/nfe/importar', { xml: nfeXml(), empresaId: emp.id, entradaEm: D })).titulos, 2);   // nota cancelada pode ser importada de novo
  await assert.rejects(call('POST', '/nfe/importar', { xml: 'isto não é xml', empresaId: emp.id }), /malformado|vazio/);
  await assert.rejects(call('POST', `/notas/${r.nota.id}/cancelar`), /já está cancelada/);
});
