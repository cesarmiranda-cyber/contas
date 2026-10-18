'use strict';
// Dados de demonstração para apresentar o app a um cliente: duas empresas fictícias com histórico de 6 meses e previsão,
// cobrindo todos os processos (receber, pagar, folha, notas e estoque, bancos, conciliação, recorrências, contratos).
// Tudo nasce com demo:true (e nas empresas demo) para poder ser removido sem tocar nos dados reais. Nada é enviado ao Bitrix/Asaas.
const R = require('./rules');
const F = require('./fin');
const C = require('./finCad');
const X = require('./finExtra');

const rnd = (seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(20261018);
const between = (a, b) => a + rnd() * (b - a), pick = l => l[Math.floor(rnd() * l.length)], money = (a, b) => Math.round(between(a, b) / 10) * 10;
function cnpj(base8) {   // CNPJ válido a partir de 8 dígitos (filial 0001)
  const d = (base8 + '0001').split('').map(Number), dv = n => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = d.reduce((a, x, i) => a + x * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  d.push(dv(12)); d.push(dv(13)); return d.join('');
}
function cpf(base9) { const d = base9.split('').map(Number); const dv = n => { const s = d.reduce((a, x, i) => a + x * (n + 1 - i), 0) % 11; return s < 2 ? 0 : 11 - s; }; d.push(dv(9)); d.push(dv(10)); return d.join(''); }
function chaveNfe(cnpjEmit, numero, hoje) {
  const b = `43${hoje.slice(2, 4)}${hoje.slice(5, 7)}${cnpjEmit}55001${String(numero).padStart(9, '0')}1${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`;
  let p = 2, s = 0; for (let i = 42; i >= 0; i--) { s += Number(b[i]) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return b + (r < 2 ? 0 : 11 - r);
}

function gerarDemo({ hoje = R.todayBR(), formas = [], condicoes = [] } = {}) {
  const U = F.uid, add = (d, n) => C.addDias(d, n), mes0 = hoje.slice(0, 7), mesRel = k => R.addMonths(`${mes0}-01`, k).slice(0, 7), dia = (k, d) => R.addMonths(`${mes0}-${String(Math.min(d, 28)).padStart(2, '0')}`, k);
  const ctx = { formas, condicoes, hoje };
  const out = { empresas: [], contas: [], centros: [], fornecedores: [], funcionarios: [], pagar: [], receber: [], recorrencias: [], transferencias: [], produtos: [], movimentos: [], notas: [], extratos: [], contratos: [] };
  const demo = o => ({ ...o, demo: true });

  // empresas e contas
  const alfa = { id: U('emp'), nome: 'Demo Alfa Consultoria Ltda', cnpj: cnpj('11222333'), ativa: true, bitrixCompanyId: '', demo: true };
  const beta = { id: U('emp'), nome: 'Demo Beta Comércio Ltda', cnpj: cnpj('44555666'), ativa: true, bitrixCompanyId: '', demo: true };
  out.empresas.push(alfa, beta);
  const ini = dia(-7, 1);
  const conta = (e, o) => { const c = demo({ id: U('con'), empresaId: e.id, tipo: 'corrente', banco: '', bancoNome: '', agencia: '', numero: '', saldoInicial: 0, dataSaldo: ini, padrao: false, ativa: true, obs: '', ...o }); out.contas.push(c); return c; };
  const itau = conta(alfa, { nome: 'Itaú PJ', banco: '341', bancoNome: 'Itaú', agencia: '1234', numero: '56789-0', saldoInicial: 85000, padrao: true });
  const asaasA = conta(alfa, { nome: 'Conta Asaas', tipo: 'asaas', banco: '461', bancoNome: 'Asaas', saldoInicial: 0 });
  const caixaA = conta(alfa, { nome: 'Caixa interno', tipo: 'caixa', saldoInicial: 2000 });
  const brad = conta(beta, { nome: 'Bradesco PJ', banco: '237', bancoNome: 'Bradesco', agencia: '0987', numero: '123456-7', saldoInicial: 40000, padrao: true });
  void asaasA;
  for (const n of ['Comercial', 'Operações', 'Administrativo']) out.centros.push(demo({ id: U('cen'), nome: n, ativa: true }));

  // fornecedores
  const forn = (nome, d, pix = '') => { const f = demo({ id: U('for'), nome, doc: d, email: '', telefone: '', chavePix: pix, obs: '', ativa: true }); out.fornecedores.push(f); return f; };
  const imob = forn('Imobiliária Sul', cnpj('77888999')), vivo = forn('Vivo Empresas', cnpj('55666777')), contab = forn('Contabilidade Prime', cnpj('33444555'), 'contato@contabprime.com.br'),
    google = forn('Google Workspace', cnpj('22333444')), agencia = forn('Agência Pixel', cnpj('66777888'), 'financeiro@agenciapixel.com'), distrib = forn('Distribuidora Sul & Cia Ltda', cnpj('88999000')), papel = forn('Papelaria Central', cnpj('99000111'));

  // lançamentos
  const mk = (tipo, emp, o) => { const [l] = C.criarLancamentos({ empresaId: emp.id, parcelas: 1, ...o }, tipo, ctx); out[tipo === 'pagar' ? 'pagar' : 'receber'].push(demo(l)); return out[tipo === 'pagar' ? 'pagar' : 'receber'][out[tipo === 'pagar' ? 'pagar' : 'receber'].length - 1]; };
  const baixa = (l, data, contaId, extra = {}) => { const { pago } = C.baixarLancamento(l, { data, contaId, ...extra }, hoje); Object.assign(l, pago, { demo: true }); return l; };
  const clientesA = ['Clínica Vida Saúde', 'Padaria Estrela', 'Mercado Bom Preço', 'Escola Aprender', 'Construtora Horizonte', 'Transportes Veloz'], clientesB = ['Restaurante Sabor Caseiro', 'Hotel Mirante', 'Condomínio Jardins', 'Academia Corpo & Mente', 'Hospital Santa Clara'];
  const quando = (k, d) => { const v = dia(k, d); return { venc: v, pago: v < hoje }; };
  for (let k = -6; k <= 3; k++) {
    // Alfa: serviços e contratos recorrentes
    for (const [cl, cat, v, d] of [[clientesA[k % 6 < 0 ? (k % 6) + 6 : k % 6], 'Contratos recorrentes', money(13000, 19000), 8], [pick(clientesA), 'Vendas e serviços', money(14000, 24000), 18], [pick(clientesA), 'Licenças e aplicativos', money(4000, 8000), 25]]) {
      const w = quando(k, d), l = mk('receber', alfa, { descricao: cat === 'Contratos recorrentes' ? `Contrato mensal — ${cl}` : cat === 'Licenças e aplicativos' ? `Licenças Bitrix24 — ${cl}` : `Projeto de consultoria — ${cl}`, cliente: cl, categoria: cat, valor: v, venc: w.venc, contaId: itau.id, formaId: pick(['fp_pix', 'fp_boleto', 'fp_boleto']), centro: 'Comercial' });
      if (w.pago && !(k === -1 && rnd() < 0.34)) baixa(l, add(w.venc, Math.floor(between(-1, 4))) > hoje ? hoje : add(w.venc, Math.floor(between(-1, 4))), itau.id);
    }
    // Beta: vendas
    for (let i = 0; i < 3; i++) {
      const cl = pick(clientesB), d = [5, 14, 23][i], w = quando(k, d), l = mk('receber', beta, { descricao: `Venda de materiais — ${cl}`, cliente: cl, categoria: 'Vendas e serviços', valor: money(12000, 19000), venc: w.venc, contaId: brad.id, formaId: pick(['fp_boleto', 'fp_cartao', 'fp_pix']) });
      if (w.pago && !(k === -1 && i === 1) && !(k === -2 && i === 2 && rnd() < 0.5)) baixa(l, add(w.venc, Math.floor(between(0, 5))) > hoje ? hoje : add(w.venc, Math.floor(between(0, 5))), brad.id);
    }
    // despesas variáveis
    for (const [emp, f, desc, cat, v, d, cc, ct] of [[alfa, google, 'Google Workspace', 'Software e licenças', money(900, 1500), 10, itau, 'Administrativo'], [alfa, contab, 'Honorários contábeis', 'Serviços de terceiros', 1800, 15, itau, 'Administrativo'], [alfa, agencia, k % 2 ? 'Campanha de mídia' : 'Criação de peças', 'Marketing', money(2400, 4600), 20, itau, 'Comercial'], [beta, papel, 'Material de escritório', 'Fornecedores', money(400, 1200), 12, brad, 'Administrativo'], [beta, vivo, 'Telefonia e internet', 'Serviços de terceiros', 689, 8, brad, 'Administrativo'], [beta, imob, 'Aluguel do galpão', 'Aluguel e condomínio', 7800, 5, brad, 'Operações']]) {
      const w = quando(k, d), l = mk('pagar', emp, { descricao: desc, fornecedor: f.nome, contatoId: f.id, categoria: cat, valor: v, venc: w.venc, contaId: cc.id, forma: pick(['BOLETO', 'BOLETO', 'PIX']), centro: ct });
      if (w.pago && !(k === -1 && f === agencia)) baixa(l, w.venc, cc.id);
    }
  }
  // recorrências (contas fixas) — o que já foi gerado entra marcado como demo
  const recs = [
    { tipo: 'pagar', emp: alfa, inicio: dia(-6, 5), modelo: { descricao: 'Aluguel da sala comercial', fornecedor: imob.nome, contatoId: imob.id, categoria: 'Aluguel e condomínio', valor: 4500, contaId: itau.id, forma: 'BOLETO', centro: 'Administrativo' } },
    { tipo: 'pagar', emp: alfa, inicio: dia(-6, 12), modelo: { descricao: 'Internet e telefonia', fornecedor: vivo.nome, contatoId: vivo.id, categoria: 'Serviços de terceiros', valor: 389.9, contaId: itau.id, forma: 'BOLETO' } },
    { tipo: 'receber', emp: alfa, inicio: dia(-6, 10), modelo: { descricao: 'Suporte mensal — Padaria Estrela', cliente: 'Padaria Estrela', categoria: 'Contratos recorrentes', valor: 5500, contaId: itau.id, forma: 'PIX' } },
  ];
  for (const r of recs) {
    const rec = demo({ id: U('rec'), ...X.validarRecorrencia({ tipo: r.tipo, empresaId: r.emp.id, inicio: r.inicio, modelo: r.modelo }, hoje) });
    out.recorrencias.push(rec);
    for (const l of X.gerarRecorrentes({ recorrencias: [rec], existentes: [], hoje, ctx })) { const x = demo(l); out[r.tipo === 'pagar' ? 'pagar' : 'receber'].push(x); if (x.venc < hoje) baixa(x, x.venc, r.modelo.contaId); }
  }

  // funcionários e folha
  const func = (e, nome, cargo, sal, ben, enc, desc, doc) => { const f = demo({ id: U('fn'), ...F.validarFuncionario({ empresaId: e.id, nome, cargo, salario: sal, beneficios: ben, encargos: enc, descontos: desc, diaPagamento: 5, forma: 'PIX', cpf: cpf(doc), admissao: dia(-30, 1) }) }); out.funcionarios.push(f); return f; };
  func(alfa, 'Ana Souza', 'Consultora sênior', 9200, 650, 2900, 1150, '123456789'); func(alfa, 'Bruno Lima', 'Analista de projetos', 5400, 650, 1700, 560, '234567890'); func(alfa, 'Camila Rocha', 'Comercial', 4800, 650, 1500, 490, '345678901'); func(alfa, 'Diego Martins', 'Suporte', 3600, 650, 1100, 330, '456789012');
  func(beta, 'Eduarda Alves', 'Gerente', 7800, 600, 2450, 900, '567890123'); func(beta, 'Fábio Nunes', 'Estoquista', 2900, 600, 920, 230, '678901234'); func(beta, 'Gabriela Pires', 'Vendedora', 3300, 600, 1030, 280, '789012345');
  for (const e of [alfa, beta]) for (let k = -6; k <= 0; k++) {
    for (const l of F.gerarFolha({ funcionarios: out.funcionarios, competencia: mesRel(k), empresaId: e.id }, hoje)) { const x = demo({ ...l, contaId: e === alfa ? itau.id : brad.id }); out.pagar.push(x); if (x.venc < hoje) baixa(x, x.venc, x.contaId); }
  }

  // estoque (empresa Beta) via notas de entrada
  const catalogo = [['SAB-1KG', 'Sabão em pó 1kg', 'CX', 28.4, 30, 40], ['DET-5L', 'Detergente neutro 5L', 'UN', 22.9, 45, 12], ['PAP-A4', 'Papel sulfite A4 (resma)', 'UN', 24.5, 40, 80], ['CAF-500', 'Café torrado 500g', 'UN', 14.2, 25, 60], ['COP-200', 'Copo descartável 200ml (cento)', 'PCT', 8.7, 30, 100], ['ALC-70', 'Álcool 70% 1L', 'UN', 6.9, 95, 50], ['LUV-M', 'Luvas de procedimento M (cx)', 'CX', 31.5, 10, 25], ['SAC-100', 'Saco de lixo 100L (pct)', 'PCT', 19.8, 20, 45]];
  const prods = catalogo.map(([codigo, nome, un, , min]) => { const p = demo({ id: U('pr'), ...S_valida(beta.id, nome, codigo, un, min), codigosFornecedor: [{ doc: distrib.doc, cProd: codigo }] }); out.produtos.push(p); return p; });
  function S_valida(empresaId, nome, codigo, un, min) { return { empresaId, codigo, nome, un, ncm: '34022000', ean: '', estoqueMin: min, ativo: true, obs: '' }; }
  let nNota = 4100, seq = 1;
  for (const [k, d, parc] of [[-5, 6, 2], [-3, 9, 2], [-1, 13, 3], [0, 3, 1]]) {
    const entrada = dia(k, d); if (entrada > hoje) continue;
    const itens = prods.map((p, i) => { const qtd = Math.round(catalogo[i][5] * between(0.6, 1.2)); return { n: i + 1, cProd: catalogo[i][0], ean: '', descricao: p.nome, ncm: '34022000', cfop: '5102', un: p.un, qtd, vUnit: catalogo[i][3], vProd: F.round2(qtd * catalogo[i][3]), custoUnit: catalogo[i][3], custo: F.round2(qtd * catalogo[i][3]), produtoId: p.id, estoque: true }; }).filter((_, i) => rnd() < 0.8 || i < 3);
    const total = F.round2(itens.reduce((a, i) => a + i.custo, 0)), id = U('nf'), numero = String(nNota++), valorParc = F.round2(total / parc);
    const titulos = [];
    for (let i = 0; i < parc; i++) {
      const valor = i === parc - 1 ? F.round2(total - valorParc * (parc - 1)) : valorParc;
      const l = mk('pagar', beta, { descricao: `NF-e ${numero}/1 — ${distrib.nome}`, fornecedor: distrib.nome, contatoId: distrib.id, categoria: 'Fornecedores', valor, venc: add(entrada, 28 * (i + 1)), contaId: brad.id, forma: 'BOLETO', parcelaTitulo: `Duplicata ${String(i + 1).padStart(3, '0')}`, obs: 'Importada do XML (demonstração)' });
      l.parcela = parc > 1 ? `${i + 1}/${parc}` : ''; l.parcelaTitulo = `Duplicata ${String(i + 1).padStart(3, '0')}`; l.notaId = id; titulos.push(l.id); if (l.venc < hoje) baixa(l, l.venc, brad.id);
    }
    out.notas.push(demo({ id, empresaId: beta.id, chave: chaveNfe(distrib.doc, numero, hoje), numero, serie: '1', emissao: add(entrada, -1), entradaEm: entrada, natOp: 'Venda de mercadoria', fornecedorId: distrib.id, fornecedorNome: distrib.nome, fornecedorDoc: distrib.doc,
      totais: { produtos: total, frete: 0, seguro: 0, desconto: 0, outras: 0, ipi: 0, st: 0, total }, itens, titulos, status: 'lancada', estoque: true, obs: '', avisos: [], criado: entrada, anexos: [] }));
    for (const it of itens) out.movimentos.push(demo({ id: U('mv'), empresaId: beta.id, produtoId: it.produtoId, data: entrada, tipo: 'entrada', qtd: it.qtd, custoUnit: it.custoUnit, obs: `NF-e ${numero} — ${distrib.nome}`, origem: 'nota', notaId: id, seq: seq++ }));
  }
  // consumo: saídas semanais (deixa alguns itens abaixo do mínimo)
  const entradas = {}; for (const m of out.movimentos) entradas[m.produtoId] = (entradas[m.produtoId] || 0) + m.qtd;
  for (let sem = 5; sem >= 0; sem--) for (const p of prods) { const tot = entradas[p.id] || 0; if (!tot) continue; const q = Math.max(1, Math.round(tot * between(0.04, 0.085))); const d = add(hoje, -sem * 7 - Math.floor(between(0, 5))); if (d < ini) continue; out.movimentos.push(demo({ id: U('mv'), empresaId: beta.id, produtoId: p.id, data: d, tipo: 'saida', qtd: -q, obs: 'Consumo / venda balcão', origem: 'manual', seq: seq++ })); }
  // ajusta: o saldo nunca fica negativo
  const saldo = {}; for (const m of out.movimentos.slice().sort((a, b) => a.data.localeCompare(b.data) || a.seq - b.seq)) { saldo[m.produtoId] = (saldo[m.produtoId] || 0) + m.qtd; if (saldo[m.produtoId] < 0) { m.qtd -= saldo[m.produtoId]; saldo[m.produtoId] = 0; } }
  out.movimentos = out.movimentos.filter(m => m.qtd !== 0);

  // transferência
  out.transferencias.push(demo({ id: U('tr'), de: itau.id, para: caixaA.id, valor: 1500, data: dia(-2, 4), obs: 'Reforço do caixa' }));

  // extrato bancário do Itaú (para a conciliação): casa com lançamentos em aberto, mais tarifas e rendimento
  const abertosR = out.receber.filter(l => l.empresaId === alfa.id && l.status === 'aberto' && l.venc <= add(hoje, 8)).slice(0, 2), abertosP = out.pagar.filter(l => l.empresaId === alfa.id && l.status === 'aberta' && l.venc <= add(hoje, 8)).slice(0, 2);
  let fit = 1;
  const linha = (data, valor, descricao) => out.extratos.push(demo({ id: U('ex'), contaId: itau.id, fitid: `DEMO${fit++}`, data: data > hoje ? hoje : data, valor, descricao, doc: '', status: 'pendente', ref: null, importado: hoje }));
  for (const r of abertosR) linha(add(r.venc, 0), r.valor, `PIX RECEBIDO ${String(r.cliente).toUpperCase()}`);
  for (const c of abertosP) linha(add(c.venc, 0), -c.valor, `PAG BOLETO ${String(c.fornecedor || c.descricao).toUpperCase()}`);
  linha(add(hoje, -3), -49.9, 'TARIFA PACOTE DE SERVICOS'); linha(add(hoje, -2), 112.37, 'RENDIMENTO APLICACAO AUTOMATICA'); linha(add(hoje, -1), -86.5, 'IOF E TARIFAS PIX');

  // contratos (ficam só no app; não existem no Bitrix). Alguns já têm cobranças geradas (com parcelas em A receber).
  const ctr = (n, titulo, cliente, valor, ini0, venc, etapa, resp, doc, emp, extra = {}) => { const c = demo({ id: 900000 + n, titulo, cliente, clienteDoc: doc, email: `financeiro@${cliente.toLowerCase().replace(/[^a-z]/g, '')}.com.br`, telefone: '(11) 3000-' + String(1000 + n * 37), endereco: 'Av. Paulista, 1000 · São Paulo', valor, inicio: ini0, venc, etapaNome: etapa, responsavelNome: resp, empresaId: emp.id, obs: '', dados: [{ nome: 'Tipo de serviço', valor: extra.tipo || 'Consultoria Bitrix24' }], contatos: [{ nome: 'Responsável financeiro', cargo: 'Financeiro', email: 'financeiro@cliente.com.br', telefone: '(11) 99999-0000' }], ...extra }); out.contratos.push(c); return c; };
  const parcelas = (c, emp, n, valorParc, conta) => { for (let i = 0; i < n; i++) { const venc = R.addMonths(c.inicio, i), l = mk('receber', emp, { descricao: `${c.titulo.split(' — ')[0]} — mensalidade`, cliente: c.cliente, categoria: 'Contratos recorrentes', valor: valorParc, venc, contaId: conta.id, forma: 'BOLETO' }); l.contratoId = String(c.id); l.parcela = `${i + 1}/${n}`; if (venc < hoje) baixa(l, add(venc, 1) > hoje ? hoje : add(venc, 1), conta.id); } };
  const c1 = ctr(1, 'Contrato anual de consultoria — Clínica Vida Saúde', 'Clínica Vida Saúde', 96000, dia(-11, 1), add(hoje, -4), 'Em vigor', 'Marina Lopes', cnpj('12121212'), alfa, { cobrancaGerada: true, obs: 'Renovação pendente de assinatura.' });
  const c2 = ctr(2, 'Implantação e suporte — Construtora Horizonte', 'Construtora Horizonte', 54000, dia(-8, 1), add(hoje, 12), 'Em vigor', 'Marina Lopes', cnpj('23232323'), alfa, { cobrancaGerada: true, tipo: 'Implantação' });
  ctr(3, 'Licenças e treinamento — Escola Aprender', 'Escola Aprender', 28800, dia(-5, 1), add(hoje, 28), 'Em vigor', 'Rafael Costa', cnpj('34343434'), alfa, { tipo: 'Licenças' });
  const c4 = ctr(4, 'Suporte mensal — Padaria Estrela', 'Padaria Estrela', 66000, dia(-3, 1), add(hoje, 75), 'Em vigor', 'Rafael Costa', cnpj('45454545'), alfa, { cobrancaGerada: true, tipo: 'Suporte' });
  ctr(5, 'Projeto de automação — Transportes Veloz', 'Transportes Veloz', 120000, dia(0, 1), add(hoje, 300), 'Assinado', 'Marina Lopes', cnpj('56565656'), alfa, { tipo: 'Automação de processos' });
  ctr(6, 'Fornecimento anual de materiais — Hotel Mirante', 'Hotel Mirante', 180000, dia(-9, 1), add(hoje, 41), 'Em vigor', 'Patrícia Gomes', cnpj('67676767'), beta, { cobrancaGerada: true, tipo: 'Fornecimento' });
  ctr(7, 'Contrato de reposição — Hospital Santa Clara', 'Hospital Santa Clara', 240000, dia(-6, 1), add(hoje, 118), 'Em vigor', 'Patrícia Gomes', cnpj('78787878'), beta, { cobrancaGerada: true, tipo: 'Fornecimento' });
  ctr(8, 'Contrato de limpeza — Condomínio Jardins', 'Condomínio Jardins', 72000, dia(-10, 1), add(hoje, -19), 'Em vigor', 'Patrícia Gomes', cnpj('89898989'), beta, { tipo: 'Serviços' });
  ctr(9, 'Pacote de licenças — Academia Corpo & Mente', 'Academia Corpo & Mente', 36000, dia(-2, 1), add(hoje, 205), 'Assinado', 'Rafael Costa', cnpj('90909090'), alfa, { tipo: 'Licenças' });
  ctr(10, 'Contrato em negociação — Mercado Bom Preço', 'Mercado Bom Preço', 0, dia(0, 1), '', 'Em negociação', 'Marina Lopes', cnpj('01010101'), alfa, { tipo: 'Consultoria' });
  parcelas(c1, alfa, 6, 8000, itau); parcelas(c2, alfa, 4, 4500, itau); parcelas(c4, alfa, 3, 5500, itau);
  return out;
}
module.exports = { gerarDemo, cnpj, cpf };
