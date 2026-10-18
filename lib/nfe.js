'use strict';
// Leitura de NF-e (XML do emitente, modelo 55): cabeçalho, fornecedor, destinatário, itens com custo de aquisição,
// duplicatas (vencimentos) e forma de pagamento. Cobertas por test/nfe.test.js.
const { parseXml, find, kid, kids, text } = require('./xml');
const R = require('./rules');

const bad = msg => { const e = new Error(msg); e.status = 400; return e; };
const num = v => { const n = Number(String(v || '0').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100, r4 = v => Math.round(v * 10000) / 10000;
const dia = v => { const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; };
const FORMA_POR_TPAG = { '01': 'DINHEIRO', '03': 'CARTAO', '04': 'CARTAO', '15': 'BOLETO', '17': 'PIX', '18': 'TRANSFERENCIA', '16': 'TRANSFERENCIA' };

// Dígito verificador da chave de acesso (módulo 11)
function chaveValida(c) {
  if (!/^\d{44}$/.test(c)) return false;
  let p = 2, soma = 0;
  for (let i = 42; i >= 0; i--) { soma += Number(c[i]) * p; p = p === 9 ? 2 : p + 1; }
  const r = soma % 11, dv = r < 2 ? 0 : 11 - r;
  return dv === Number(c[43]);
}

function parseNfe(xml) {
  const raiz = parseXml(xml);
  const tem = nome => (raiz.name === nome ? raiz : find(raiz, nome));
  const inf = tem('infNFe');
  if (!inf) {
    if (tem('resNFe')) throw bad('Este é o resumo da NF-e (sem itens). Baixe o XML completo da nota no portal da SEFAZ ou peça ao fornecedor.');
    if (tem('infEvento')) throw bad('Este XML é um evento (cancelamento, carta de correção…), não a nota fiscal.');
    throw bad('Este XML não é uma NF-e (não encontrei os dados da nota). Confira se enviou o XML da nota, e não o PDF (DANFE).');
  }
  const avisos = [];
  const ide = kid(inf, 'ide'), emit = kid(inf, 'emit'), dest = kid(inf, 'dest'), tot = kid(kid(inf, 'total'), 'ICMSTot');
  const chave = String(inf.attrs.Id || '').replace(/^NFe/, '') || text(find(raiz, 'protNFe') && find(find(raiz, 'protNFe'), 'infProt'), 'chNFe');
  if (chave && !chaveValida(chave)) avisos.push('A chave de acesso não passou na validação do dígito verificador. Confira o arquivo.');
  if (!chave) avisos.push('O XML não traz a chave de acesso: não será possível barrar nota duplicada.');
  if (text(ide, 'mod') && text(ide, 'mod') !== '55') avisos.push(`Modelo ${text(ide, 'mod')}: o app foi pensado para NF-e (modelo 55).`);
  const protocolo = find(raiz, 'protNFe') ? text(find(find(raiz, 'protNFe'), 'infProt'), 'cStat') : '';
  if (protocolo && !['100', '150'].includes(protocolo)) avisos.push(`A nota consta com status ${protocolo} na SEFAZ (não autorizada).`);
  else if (!protocolo) avisos.push('O XML não traz o protocolo de autorização (veio sem o protNFe). Confirme a nota na SEFAZ.');

  const end = kid(emit, 'enderEmit');
  const fornecedor = { doc: R.digits(text(emit, 'CNPJ') || text(emit, 'CPF')), nome: text(emit, 'xNome'), fantasia: text(emit, 'xFant'), ie: text(emit, 'IE'), telefone: text(end, 'fone'), email: text(emit, 'email') || '',
    cidade: text(end, 'xMun'), uf: text(end, 'UF'), endereco: [text(end, 'xLgr'), text(end, 'nro'), text(end, 'xBairro')].filter(Boolean).join(', ') };
  if (!fornecedor.doc) throw bad('A nota não informa o CNPJ/CPF do emitente.');
  const destinatario = { doc: R.digits(text(dest, 'CNPJ') || text(dest, 'CPF')), nome: text(dest, 'xNome') };

  // itens
  const dets = kids(inf, 'det');
  if (!dets.length) throw bad('A nota não tem itens.');
  const itens = dets.map((d, i) => {
    const p = kid(d, 'prod'), imp = kid(d, 'imposto');
    const q = num(text(p, 'qCom')), vProd = num(text(p, 'vProd'));
    return { n: Number(d.attrs.nItem) || i + 1, cProd: text(p, 'cProd'), ean: /^\d{8,14}$/.test(text(p, 'cEAN')) ? text(p, 'cEAN') : '', descricao: text(p, 'xProd'), ncm: text(p, 'NCM'), cfop: text(p, 'CFOP'), un: (text(p, 'uCom') || 'UN').toUpperCase(),
      qtd: q, vUnit: num(text(p, 'vUnCom')), vProd, vFrete: num(text(p, 'vFrete')), vSeg: num(text(p, 'vSeg')), vDesc: num(text(p, 'vDesc')), vOutro: num(text(p, 'vOutro')),
      vIPI: num(text(find(imp, 'IPITrib'), 'vIPI')), vST: num(text(find(imp, 'ICMSST') ? find(imp, 'ICMSST') : find(imp, 'ICMS'), 'vICMSST')) };
  });
  if (itens.some(i => !(i.qtd > 0))) avisos.push('Há item com quantidade zero.');

  // custo de aquisição: produto − desconto + frete + seguro + outras + IPI + ICMS-ST; o que está só no cabeçalho é rateado pelo valor dos produtos
  const soma = k => itens.reduce((a, i) => a + i[k], 0), base = soma('vProd') || 1;
  const T = { vProd: num(text(tot, 'vProd')), vNF: num(text(tot, 'vNF')), vFrete: num(text(tot, 'vFrete')), vSeg: num(text(tot, 'vSeg')), vDesc: num(text(tot, 'vDesc')), vOutro: num(text(tot, 'vOutro')), vIPI: num(text(tot, 'vIPI')), vST: num(text(tot, 'vST')) };
  const resto = { vFrete: Math.max(0, T.vFrete - soma('vFrete')), vSeg: Math.max(0, T.vSeg - soma('vSeg')), vOutro: Math.max(0, T.vOutro - soma('vOutro')), vIPI: Math.max(0, T.vIPI - soma('vIPI')), vST: Math.max(0, T.vST - soma('vST')), vDesc: Math.max(0, T.vDesc - soma('vDesc')) };
  for (const i of itens) {
    const peso = i.vProd / base;
    const custo = i.vProd - i.vDesc - resto.vDesc * peso + i.vFrete + resto.vFrete * peso + i.vSeg + resto.vSeg * peso + i.vOutro + resto.vOutro * peso + i.vIPI + resto.vIPI * peso + i.vST + resto.vST * peso;
    i.custo = r2(custo); i.custoUnit = i.qtd > 0 ? r4(custo / i.qtd) : 0;
  }
  const totalNota = T.vNF || r2(soma('vProd'));
  const somaCustos = r2(itens.reduce((a, i) => a + i.custo, 0));
  if (Math.abs(somaCustos - totalNota) > 1) avisos.push(`A soma dos custos dos itens (R$ ${somaCustos.toFixed(2)}) difere do total da nota (R$ ${totalNota.toFixed(2)}). Confira impostos e descontos.`);

  // duplicatas e pagamento
  const duplicatas = kids(kid(inf, 'cobr'), 'dup').map((d, i) => ({ n: i + 1, numero: text(d, 'nDup') || String(i + 1).padStart(3, '0'), venc: dia(text(d, 'dVenc')), valor: num(text(d, 'vDup')) })).filter(d => d.valor > 0);
  if (duplicatas.some(d => !d.venc)) avisos.push('Há duplicata sem data de vencimento.');
  const pg = kids(kid(inf, 'pag'), 'detPag');
  const tPag = pg.length ? text(pg[0], 'tPag') : '';
  const formaSugerida = FORMA_POR_TPAG[tPag] || 'BOLETO';
  const semPagamento = tPag === '90' && !duplicatas.length;

  const emissao = dia(text(ide, 'dhEmi') || text(ide, 'dEmi'));
  return {
    chave, numero: text(ide, 'nNF'), serie: text(ide, 'serie'), emissao, natOp: text(ide, 'natOp'), tipoOperacao: text(ide, 'tpNF') === '0' ? 'entrada' : 'saida',
    fornecedor, destinatario, itens, duplicatas, formaSugerida, semPagamento,
    totais: { produtos: r2(T.vProd || soma('vProd')), frete: T.vFrete, seguro: T.vSeg, desconto: T.vDesc, outras: T.vOutro, ipi: T.vIPI, st: T.vST, total: totalNota },
    infoAdicional: text(kid(inf, 'infAdic'), 'infCpl').slice(0, 500), avisos,
  };
}
module.exports = { parseNfe, chaveValida };
