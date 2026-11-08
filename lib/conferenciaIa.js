'use strict';
// Conferência de rótulo assistida por IA (a IA do próprio cliente, ex.: CoPilot do Bitrix24).
// O sistema monta o pedido com os dados que o cliente informou + a lista de conferência, e registra o resultado
// no histórico do negócio. A IA é uma checagem a mais: nunca substitui a dupla checagem humana.
const REGRAS = [
  'Enquadramento: o rótulo segue a norma específica do produto (RTIQ/MAPA/Anvisa), se houver; sem norma específica, as gerais RDC 429/2020, IN 75/2020 e RDC 727/2022',
  'Nome do produto (denominação de venda) igual ao informado e sem termos que induzam a erro (RDC 727/2022)',
  'Lista de ingredientes completa e na ordem correta (do maior para o menor), com os nomes corretos (RDC 727/2022)',
  'Alérgenos declarados conforme o informado (contém / pode conter), no formato, nas letras e na posição exigidos (RDC 727/2022)',
  'Declaração sobre glúten correta (contém / não contém) e coerente com a contaminação cruzada informada',
  'Tabela de informação nutricional presente, salvo alimento dispensado (lista do Anexo I da IN 75) (RDC 429, art. 4º)',
  'Tabela com todos os itens obrigatórios: valor energético, carboidratos, açúcares totais, açúcares adicionados, proteínas, gorduras totais, saturadas e trans, fibras e sódio, mais nutrientes/substâncias com alegação ou adicionados (RDC 429, art. 5º)',
  'Valores por 100 g ou 100 ml E por porção com a medida caseira correta; porção conforme o Anexo V da IN 75 (embalagem individual = conteúdo total) (RDC 429, arts. 8º, 9º e 11)',
  'Número de porções por embalagem declarado, com a regra de arredondamento do Anexo VI da IN 75 (dispensado em embalagem individual e peso variável) (RDC 429, art. 10)',
  'Valores arredondados conforme o Anexo III da IN 75 e quantidades não significativas expressas como no Anexo IV; valor energético e %VD em números inteiros (RDC 429, art. 7º)',
  '%VD calculado com os VDR do Anexo II da IN 75 e com a nota de rodapé "*Percentual de valores diários fornecidos pela porção"; produto que exige preparo: por 100 g/ml pronto e nota "**No alimento pronto para o consumo" (RDC 429, arts. 8º §5º e 12)',
  'Tabela em um dos modelos do Anexo IX da IN 75 (vertical, horizontal; linear só se o espaço não permitir, art. 17), caracteres e linhas 100% pretos em fundo branco (RDC 429, arts. 15 a 17)',
  'Tabela: nomes, ordem, indentação, unidades, tamanhos de fonte, espaçamentos, borda e linhas conforme os Anexos XI e XII da IN 75 (RDC 429, art. 16)',
  'Tabela em uma única superfície contínua, no mesmo painel da lista de ingredientes, fora de áreas de selagem, torção, arestas e costuras (RDC 429, art. 14)',
  'Rotulagem frontal: presente (lupa) quando açúcares adicionados, gorduras saturadas ou sódio atingem os limites do Anexo XV da IN 75; ausente nos alimentos do Anexo XVI; opcional em painel principal menor que 35 cm² (RDC 429, art. 18)',
  'Rotulagem frontal correta: metade superior do painel principal, uma superfície contínua, mesma orientação do texto, 100% preta em fundo branco, modelo do Anexo XVII e tamanho do Anexo XVIII da IN 75; nenhum outro modelo frontal visível (RDC 429, arts. 21 a 23)',
  'Alegações nutricionais: só termos autorizados (Anexo XIX da IN 75), critérios atendidos e em português; com frontal, alegações fora da metade superior do painel principal e sem letras maiores que as da frontal (RDC 429, arts. 24, 26 e 30)',
  'Conteúdo líquido / peso conforme o informado, com unidade e posição corretas (RDC 727/2022)',
  'Identificação do fabricante (razão social, endereço, CNPJ) conforme o informado (RDC 727/2022)',
  'Lote e prazo de validade previstos no rótulo (RDC 727/2022)',
  'Modo de conservação e instruções de uso conforme o informado',
  'SAC / contato do fabricante presente, se informado',
  'Vírgulas, grafia, acentos e números sem erros de digitação em todo o texto do rótulo',
];
// Resumo das regras da RDC 429/2020 (texto vigente, com as alterações das RDC 460/2020, 729/2022, 819/2023 e 976/2025) que o pedido envia à IA.
// Os anexos citados são da IN 75/2020: a IA deve usar o texto vigente deles; este resumo não os substitui.
const REFERENCIA = `REFERÊNCIA — RDC 429/2020 (rotulagem nutricional), resumo para a conferência:
- Art. 4: tabela de informação nutricional obrigatória em todo alimento embalado (inclusive ingredientes e aditivos); voluntária só para os alimentos do Anexo I da IN 75 sem enriquecimento, substâncias bioativas, alegações nutricionais ou de saúde.
- Art. 5: declarar valor energético, carboidratos, açúcares totais, açúcares adicionados, proteínas, gorduras totais, saturadas e trans, fibras e sódio; mais qualquer nutriente/substância com alegação, nutriente essencial adicionado (se ≥5% do VDR por porção) e substância bioativa adicionada. Suplementos: energia e todos os nutrientes, bioativos e enzimas adicionados.
- Art. 7: arredondamento (Anexo III) e quantidades não significativas (Anexo IV) da IN 75; valor energético e %VD em números inteiros.
- Art. 8: por 100 g (sólidos/semissólidos) ou 100 ml (líquidos) E por porção (Anexo V) com medida caseira; produto que requer preparo: por 100 g/ml do pronto e nota "**No alimento pronto para o consumo".
- Art. 9: embalagem individual (até 2 porções) = porção é o conteúdo total; produto drenado = quantidade drenada; embalagem múltipla distinta = porção por produto, ou soma se consumo conjunto.
- Art. 10: nº de porções por embalagem (Anexo VI), exceto embalagem individual e peso variável.
- Art. 11: medida caseira: utensílio dosador do produto ou do Anexo VII; embalagem individual = a própria embalagem; frações irredutíveis.
- Art. 12: %VD com VDR do Anexo II e nota "*Percentual de valores diários fornecidos pela porção"; sem VDR = campo vazio; quantidade não significativa = %VD zero.
- Art. 13: embalagem múltipla: tabela na embalagem e em cada unidade, com as exceções legais.
- Art. 14: tabela em uma superfície contínua, no mesmo painel da lista de ingredientes; fora de selagem, torção, arestas, ângulos, cantos e costuras.
- Arts. 15 a 17: modelos do Anexo IX; formatação: caracteres e linhas 100% pretos em fundo branco, Anexos XI e XII; compactação permitida (vitaminas/minerais simplificados, abreviações, fonte reduzida/condensada); só depois, modelo linear (Anexos XIII e XIV).
- Arts. 18 a 23: rotulagem frontal obrigatória quando açúcares adicionados, gorduras saturadas ou sódio atingem o Anexo XV; vedada nos alimentos do Anexo XVI; opcional em painel principal < 35 cm². Metade superior do painel principal, preta em fundo branco, mesma orientação, modelos/tamanhos dos Anexos XVII e XVIII; sem outro modelo frontal visível.
- Arts. 24 a 30: alegações nutricionais voluntárias, só com termos do Anexo XIX e critérios dos Anexos XX e XXI, mantidas até o fim da validade, em português; comparativas exigem alimento de referência; com frontal, alegações e expressões de adição de nutrientes fora da metade superior do painel principal e sem letras maiores que as da frontal.
- Arts. 31 a 33: valores determinados por análise laboratorial validada, cálculo a partir dos dados dos fornecedores ou de tabelas de composição; energia por cálculo indireto (Anexo XXII); tolerância de fiscalização de 20% (máximo para energia, carboidratos, açúcares, gorduras, sódio e colesterol; mínimo para proteínas, fibras, vitaminas, minerais e bioativos).
- Art. 34: a documentação que comprova o cumprimento deve ficar disponível para a autoridade sanitária. Arts. 50 e 50-A: os prazos de adequação já terminaram; o esgotamento de embalagens e rótulos antigos valeu até 09/10/2024.`;
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
