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
  'Tabela de informação nutricional presente e em modelo permitido (vertical, horizontal ou linear) para o tamanho da embalagem (RDC 429/2020 e IN 75/2020)',
  'Tabela nutricional: valores, porção, medida caseira, unidades e %VD coerentes com o cálculo enviado (IN 75/2020)',
  'Tabela nutricional: fontes, tamanhos, espaçamentos, negritos e linhas conforme o modelo escolhido (IN 75/2020)',
  'Rotulagem nutricional frontal (lupa de alto teor de açúcar adicionado, gordura saturada e sódio), quando aplicável ao produto (RDC 429/2020 e IN 75/2020)',
  'Conteúdo líquido / peso conforme o informado, com unidade e posição corretas (RDC 727/2022)',
  'Identificação do fabricante (razão social, endereço, CNPJ) conforme o informado (RDC 727/2022)',
  'Lote e prazo de validade previstos no rótulo (RDC 727/2022)',
  'Modo de conservação e instruções de uso conforme o informado',
  'SAC / contato do fabricante presente, se informado',
  'Vírgulas, grafia, acentos e números sem erros de digitação em todo o texto do rótulo',
];
const CAMPOS = ['nome do produto', 'razão social / fabricante / endereço', 'ingredientes e quantidades (g)', 'alergênicos presentes (rdc 727/22)', 'alergênicos - observações (pode conter / traços)', 'contaminação cruzada com glúten?', 'rendimento final da receita', 'peso líquido da embalagem', 'peso da unidade', 'forma de comercialização', 'unidades por pacote', 'modo de conservação', 'instrução de uso', 'sac', 'observações / detalhes adicionais'];
const norm = s => String(s || '').toLowerCase().trim();

function montarPedido({ titulo, empresa, dados = [], regras = REGRAS }) {
  const d = dados.filter(x => x.valor).map(x => `- ${x.rotulo}: ${x.valor}`).join('\n') || '- (o cliente não informou dados no formulário)';
  return `Você é um conferente técnico de rotulagem de alimentos no Brasil. Vou anexar o arquivo do rótulo (e, se houver, a tabela nutricional calculada). Confira o rótulo contra os dados informados pelo cliente e contra a legislação brasileira aplicável (Anvisa e MAPA).

Produto: ${titulo || '—'}
Cliente: ${empresa || '—'}

DADOS INFORMADOS PELO CLIENTE
${d}

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
module.exports = { REGRAS, CAMPOS, montarPedido, interpretar, situacao, norm };
