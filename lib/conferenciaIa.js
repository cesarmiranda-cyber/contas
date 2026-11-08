'use strict';
// Conferência de rótulo assistida por IA (a IA do próprio cliente, ex.: CoPilot do Bitrix24).
// O sistema monta o pedido com os dados que o cliente informou + a lista de conferência, e registra o resultado
// no histórico do negócio. A IA é uma checagem a mais: nunca substitui a dupla checagem humana.
const REGRAS = [
  'Enquadramento: o rótulo segue a norma específica do produto (RTIQ/MAPA/Anvisa), se houver; sem norma específica, as gerais RDC 429/2020, IN 75/2020 e RDC 727/2022',
  'Informações obrigatórias presentes: denominação de venda, ingredientes, alérgenos, lactose, aditivos, rotulagem nutricional, conteúdo líquido, origem, lote, validade e instruções de conservação/preparo/uso (RDC 727, art. 7º)',
  'Idioma e legibilidade: tudo em português, letras e números com no mínimo 1 mm quando a norma não fixar outro tamanho (RDC 727, art. 8º)',
  'Denominação de venda no painel principal, em contraste de cores, conforme a norma de identidade e qualidade; "tipo" com letras do mesmo tamanho quando for o caso; sem termos que induzam a erro (RDC 727, arts. 4º, 9º e 10)',
  'Sem alegações proibidas: propriedades medicinais ou terapêuticas, ausência de alérgenos, destaque de característica comum a todos os alimentos do tipo (RDC 727, art. 4º)',
  'Lista de ingredientes iniciada por "Ingredientes:" ou "Ingr.:", em ordem decrescente de proporção, com ingrediente composto detalhado quando exigido e nomes genéricos só os do Anexo II da RDC 727 (RDC 727, arts. 11)',
  'Aditivos depois dos demais ingredientes, com a função tecnológica seguida do nome completo ou do número INS; tartrazina (INS 102) sempre pelo nome (RDC 727, art. 12)',
  'Alérgenos: "ALÉRGICOS: CONTÉM ..." (ou "DERIVADOS DE", "E DERIVADOS") para os alimentos do Anexo III; crustáceos com o nome comum da espécie; "PODE CONTER" só com Programa de Controle de Alergênicos (RDC 727, arts. 13 e 14)',
  'Alérgenos: logo após ou abaixo da lista de ingredientes, em caixa alta, negrito, cor contrastante, altura mínima de 2 mm (1 mm se painel principal ≤ 100 cm²) e nunca menor que a letra dos ingredientes; uma só frase iniciada por "ALÉRGICOS:"; fora de selagem e torção (RDC 727, art. 15)',
  'Declaração sobre glúten correta (contém / não contém) e coerente com a contaminação cruzada informada (Lei 10.674/2003)',
  'Lactose: "CONTÉM LACTOSE" se houver mais de 100 mg por 100 g ou ml do produto como vendido, com as mesmas regras de formato dos alérgenos (RDC 727, arts. 18 e 19)',
  'Advertências de aditivos: "Contém fenilalanina" (aspartame) e "Este produto pode ter efeito laxativo" (polióis acima dos limites), em negrito; "NOVA FÓRMULA/COMPOSIÇÃO/RECEITA" por 90 dias no painel principal quando a composição mudou (RDC 727, arts. 20 a 26)',
  'Tabela de informação nutricional presente, salvo alimento dispensado (Anexo I da IN 75: embalagem ≤ 100 cm², bebidas alcoólicas, especiarias, café, frutas e carnes sem adição significativa etc.) (RDC 429, art. 4º)',
  'Tabela com todos os itens obrigatórios: valor energético, carboidratos, açúcares totais, açúcares adicionados, proteínas, gorduras totais, saturadas e trans, fibras e sódio, mais nutrientes/substâncias com alegação ou adicionados (RDC 429, art. 5º)',
  'Valores por 100 g ou 100 ml E por porção, com medida caseira (Anexo VII da IN 75) e porção do Anexo V; embalagem individual: porção = conteúdo total (RDC 429, arts. 8º, 9º e 11)',
  'Número de porções (Anexo VI da IN 75): inteiro quando há 3 ou mais porções inteiras; "Cerca de" quando não inteiro; não declara em embalagem individual (RDC 429, art. 10)',
  'Valores arredondados pelo Anexo III e não significativos pelo Anexo IV da IN 75 (declarados como 0); energia e %VD inteiros; valor energético calculado pelos fatores do Anexo XXII (RDC 429, arts. 7º e 32)',
  '%VD calculado com os VDR do Anexo II da IN 75 e com a nota "*Percentual de valores diários fornecidos pela porção"; produto com preparo: por 100 g/ml pronto e nota "**No alimento pronto para o consumo" (RDC 429, arts. 8º §5º e 12)',
  'Tabela em modelo do Anexo IX da IN 75 (vertical, horizontal, vertical ou horizontal quebrado, agregado; linear só se não houver espaço, art. 17), preta em fundo branco (RDC 429, arts. 15 a 17)',
  'Formatação da tabela (Anexo XII da IN 75): Arial ou Helvetica; título 10 pt negrito (8 pt na formatação reduzida); demais textos 8 pt (6 pt reduzida); nota de rodapé 6 pt; linhas de mesma altura; indentação de 1, 2 e 3 "n"; nomes e ordem do Anexo XI',
  'Tabela em uma única superfície contínua, no mesmo painel da lista de ingredientes, fora de selagem, torção, arestas e costuras (RDC 429, art. 14)',
  'Rotulagem frontal presente quando açúcares adicionados ≥ 15 g, gorduras saturadas ≥ 6 g ou sódio ≥ 600 mg por 100 g (líquidos: 7,5 g, 3 g, 300 mg por 100 ml); vedada nos alimentos do Anexo XVI; opcional em painel principal < 35 cm² (RDC 429, art. 18; IN 75, Anexos XV e XVI)',
  'Rotulagem frontal correta: modelo do Anexo XVII conforme os nutrientes, metade superior do painel principal, preta em fundo branco, fonte Arial Narrow negrito, tamanho 9 a 15 pt (até 9 pt entre 35 e 100 cm²) e ocupação mínima de 2%, 3% ou 4% do painel (3,5%, 5,25% ou 7% entre 35 e 100 cm²) para 2, 3 ou 4 blocos (Anexo XVIII)',
  'Alegações nutricionais: só termos do Anexo XIX, critérios do Anexo XX atendidos, frases obrigatórias (ex.: "Este não é um alimento baixo ou reduzido em valor energético") com 50% do tamanho; com frontal, fora da metade superior do painel e sem letras maiores que as da frontal (RDC 429, arts. 24 a 30)',
  'Conteúdo líquido conforme o informado e a Portaria Inmetro 249/2021, com unidade e posição corretas (RDC 727, art. 28)',
  'Identificação da origem: razão social, endereço completo, país e município, número de registro do estabelecimento, com "Fabricado em...", "Produto ..." ou "Indústria ..." (RDC 727, art. 29)',
  'Lote visível, legível e indelével: letra "L" + código ou data de fabricação/embalagem/validade com pelo menos dia e mês ou mês e ano (RDC 727, art. 30)',
  'Validade com expressão autorizada ("consumir antes de", "válido até", "validade", "val:", "vence", "vto:" etc.); dia e mês se prazo ≤ 3 meses, mês e ano se > 3 meses; algarismos não codificados (RDC 727, art. 31)',
  'Conservação e uso: temperaturas mínima e máxima, tempo de durabilidade após abrir, instruções claras e não ambíguas; carnes suína e de aves cruas com os dizeres do Anexo IV; ovos com as duas frases obrigatórias (RDC 727, arts. 32 a 35)',
  'SAC / contato do fabricante presente, se informado',
  'Vírgulas, grafia, acentos e números sem erros de digitação em todo o texto do rótulo',
];
// Resumo das regras (textos vigentes de RDC 429/2020, IN 75/2020 e RDC 727/2022) que o pedido envia à IA. Não substitui os textos oficiais.
const REFERENCIA = `REFERÊNCIA — resumo das normas aplicadas (use o texto vigente em caso de dúvida):
RDC 429/2020 (rotulagem nutricional)
- Art. 4: tabela obrigatória em todo alimento embalado; voluntária só para os alimentos do Anexo I da IN 75 sem enriquecimento, bioativos ou alegações.
- Art. 5: declarar energia, carboidratos, açúcares totais e adicionados, proteínas, gorduras totais, saturadas e trans, fibras e sódio, mais nutrientes com alegação, essenciais adicionados (≥5% do VDR) e bioativos adicionados. Suplementos: energia e todos os adicionados.
- Arts. 7 a 12: arredondamento (Anexo III) e não significativos (Anexo IV); por 100 g/ml e por porção (Anexo V) com medida caseira (Anexo VII); nº de porções (Anexo VI); %VD pelos VDR do Anexo II com a nota "*Percentual de valores diários fornecidos pela porção"; produto com preparo: por 100 g/ml pronto e nota "**No alimento pronto para o consumo".
- Art. 14: tabela em uma superfície contínua, no mesmo painel da lista de ingredientes, fora de selagem, torção, arestas e costuras. Arts. 15 a 17: modelos do Anexo IX, preta em fundo branco; compactação permitida antes do modelo linear.
- Arts. 18 a 23: frontal obrigatória quando açúcares adicionados, gorduras saturadas ou sódio atingem o Anexo XV; vedada no Anexo XVI; opcional em painel principal < 35 cm². Metade superior do painel principal, preta em fundo branco, mesma orientação, Anexos XVII e XVIII.
- Arts. 24 a 30: alegações voluntárias, só termos do Anexo XIX e critérios do Anexo XX, em português; com frontal, fora da metade superior do painel e sem letras maiores que as da frontal.
- Arts. 31 a 34: valores por análise validada, dados de fornecedores ou tabelas de composição; energia pelos fatores do Anexo XXII usando os nutrientes arredondados; tolerância de 20% (máximo para energia, carboidratos, açúcares, gorduras, sódio e colesterol; mínimo para proteínas, fibras, vitaminas, minerais e bioativos); documentação à disposição da autoridade. Prazos de adequação já encerrados (esgotamento de embalagens antigas até 09/10/2024).
IN 75/2020 (anexos)
- VDR (Anexo II): energia 2.000 kcal; carboidratos 300 g; açúcares adicionados 50 g; proteínas 50 g; gorduras totais 65 g; saturadas 20 g; trans 2 g; fibras 25 g; sódio 2.000 mg.
- Arredondamento (Anexo III): ≥10 inteiro; 1 a <10 uma casa (inteiro se a casa for 0); <1 g uma casa; <1 mg ou µg duas casas (uma se a segunda for 0).
- Não significativos (Anexo IV): energia ≤4 kcal; carboidratos, açúcares totais, proteínas, gorduras totais e fibras ≤0,5 g; saturadas e trans ≤0,1 g; colesterol ≤5 mg; sódio ≤5 mg — declarados como 0 (observadas as condições do anexo).
- Frontal (Anexo XV, por 100 g | por 100 ml): açúcares adicionados ≥15 g | ≥7,5 g; gorduras saturadas ≥6 g | ≥3 g; sódio ≥600 mg | ≥300 mg. Formato (Anexo XVIII): Arial Narrow negrito; fonte 9 a 15 pt (até 9 pt de 35 a 100 cm²); ocupação do painel 2%/3%/4% (3,5%/5,25%/7% entre 35 e 100 cm²) para 2/3/4 blocos.
- Formato da tabela (Anexo XII): Arial ou Helvetica; título 10 pt (8 reduzida); textos 8 pt (6 reduzida); rodapé 6 pt; linhas de mesma altura; indentação 1, 2 e 3 "n".
- Fatores de energia (Anexo XXII): carboidratos 4, proteínas 4, gorduras 9 kcal/g; álcool 7; fibras solúveis 2; polidextrose 1; polióis 0 a 3 conforme o composto.
RDC 727/2022 (rotulagem geral)
- Art. 7: obrigatórios denominação de venda, ingredientes, alérgenos, lactose, nova fórmula, aditivos, rotulagem nutricional, conteúdo líquido, origem, lote, validade e instruções. Art. 8: português, mínimo 1 mm.
- Art. 4: não pode induzir a erro, atribuir propriedades que o alimento não tem, indicar efeito medicinal ou terapêutico, nem fazer alegação de ausência de alérgenos.
- Arts. 11 e 12: "Ingredientes:" em ordem decrescente; aditivos por último com função + nome ou INS; tartrazina pelo nome.
- Arts. 13 a 15: "ALÉRGICOS: CONTÉM ..." / "PODE CONTER ..." (só com Programa de Controle de Alergênicos), após ou abaixo da lista de ingredientes, caixa alta, negrito, cor contrastante, 2 mm (1 mm se painel ≤100 cm²). Anexo III: trigo, centeio, cevada, aveia, crustáceos, ovos, peixes, amendoim, soja, leites, amêndoa, avelã, castanha-de-caju, castanha-do-brasil, macadâmia, nozes, pecã, pistache, pinoli, castanhas e látex natural.
- Arts. 18 e 19: "CONTÉM LACTOSE" acima de 100 mg por 100 g/ml. Arts. 20 a 24: "NOVA FÓRMULA/COMPOSIÇÃO/RECEITA" por 90 dias. Arts. 25 e 26: polióis ("Este produto pode ter efeito laxativo") e aspartame ("Contém fenilalanina").
- Art. 28: conteúdo líquido pela Portaria Inmetro 249/2021. Art. 29: origem com razão social, endereço, município, país e registro. Art. 30: lote ("L" + código ou data). Art. 31: validade com expressão autorizada; dia e mês se ≤3 meses, mês e ano se >3 meses. Arts. 32 a 35: conservação, preparo e uso; carnes suína/aves cruas (Anexo IV) e ovos.`;
const CAMPOS = ['nome do produto', 'razão social / fabricante / endereço', 'ingredientes e quantidades (g)', 'alergênicos presentes (rdc 727/22)', 'alergênicos - observações (pode conter / traços)', 'contaminação cruzada com glúten?', 'rendimento final da receita', 'peso líquido da embalagem', 'peso da unidade', 'forma de comercialização', 'unidades por pacote', 'modo de conservação', 'instrução de uso', 'sac', 'observações / detalhes adicionais'];
const norm = s => String(s || '').toLowerCase().trim();

function montarPedido({ titulo, empresa, dados = [], regras = REGRAS }) {
  const d = dados.filter(x => x.valor).map(x => `- ${x.rotulo}: ${x.valor}`).join('\n') || '- (o cliente não informou dados no formulário)';
  return `Você é um conferente técnico de rotulagem de alimentos no Brasil. Vou anexar o arquivo do rótulo (e, se houver, a tabela nutricional calculada). Confira o rótulo contra os dados informados pelo cliente e contra a legislação brasileira aplicável (Anvisa e MAPA).

Produto: ${titulo || '—'}
Cliente: ${empresa || '—'}

DADOS INFORMADOS PELO CLIENTE
${d}

${REFERENCIA}

CONFIRA CADA ITEM ABAIXO
${regras.map((r, i) => `${i + 1}. ${r}`).join('\n')}

REGRAS DA RESPOSTA
- Responda uma linha por item, exatamente neste formato: NÚMERO | OK ou ATENÇÃO ou ERRO | explicação curta com o trecho do rótulo.
- Use ATENÇÃO quando não for possível ter certeza ou faltar informação. Nunca invente dados.
- Cite a norma quando apontar erro. Depois das linhas, escreva "RESUMO:" com 2 frases.
- Esta conferência não substitui a revisão humana.`;
}
// Lê a resposta no formato pedido; o que não casar fica só no texto bruto para a equipe classificar.
function interpretar(texto, total = REGRAS.length) {
  const itens = new Map();
  for (const l of String(texto || '').split(/\r?\n/)) {
    const m = /^\s*(?:item\s*)?(\d{1,2})\s*[).|:\-–]?\s*\|?\s*(OK|ATEN[CÇ][AÃ]O|ERRO)\b\s*[|:\-–]?\s*(.*)$/i.exec(l); if (!m) continue;
    const n = Number(m[1]); if (n < 1 || n > total || itens.has(n)) continue;
    const st = /^OK$/i.test(m[2]) ? 'ok' : /^ERRO$/i.test(m[2]) ? 'erro' : 'atencao'; itens.set(n, { n, status: st, nota: m[3].trim().slice(0, 400) });
  }
  const r = /RESUMO\s*:\s*([\s\S]*)$/i.exec(String(texto || ''));
  return { itens: [...itens.values()].sort((a, b) => a.n - b.n), resumo: r ? r[1].trim().slice(0, 600) : '' };
}
const situacao = itens => (itens.some(i => i.status === 'erro') ? 'erros' : itens.some(i => i.status === 'atencao') ? 'atencao' : itens.length ? 'ok' : 'sem');
module.exports = { REGRAS, REFERENCIA, CAMPOS, montarPedido, interpretar, situacao, norm };
