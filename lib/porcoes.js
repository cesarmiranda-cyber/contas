'use strict';
// IN 75/2020, Anexo V (porções de referência) e Anexo VII (utensílios). Cada linha: produto | porção | medida caseira sugerida.
// "QSP x" = quantidade suficiente para preparar x. Transcrito do texto da norma; em caso de dúvida vale a publicação oficial.
const GRUPOS = [
  ['I', 'Produtos de panificação, cereais, leguminosas, raízes, tubérculos e seus derivados (valor energético médio da porção: 150 kcal)', `Amidos e féculas|20 g|Colheres de sopa
Arroz cru|50 g|Xícaras
Aveia em flocos sem outros ingredientes|30 g|Colheres de sopa
Barra de cereais com até 10% de gordura|30 g|Unidades
Batata, mandioca e outros tubérculos, cozidos em água embalada à vácuo|150 g|Unidades ou xícara
Batata e mandioca pré-frita congelada|85 g|Unidades ou xícaras
Produtos à base de tubérculos e cereais pré-fritos ou congelados|85 g|Unidades
Biscoito salgados, integrais e grissines|30 g|Unidades
Bolos, todos os tipos sem recheio|60 g|Fatia ou fração
Canjica (grão cru)|50 g|Xícaras
Cereal matinal pesando até 45 g por xícara|30 g|Xícaras
Cereal matinal pesando mais do que 45 g por xícara|40 g|Xícaras
Cereais integrais crus|45 g|Xícaras
Farinhas de cereais e tubérculos, todos os tipos|50 g|Xícaras
Farelo de cereais e germe de trigo|10 g|Colheres de sopa
Farinha láctea|30 g|Colheres de sopa
Farofa pronta|35 g|Colheres de sopa
Massa alimentícia seca|80 g|Pratos ou xícaras
Massa desidratada com recheio|70 g|Pratos ou xícaras
Massas frescas com e sem recheios|100 g|Pratos ou xícaras
Pães embalados fatiados ou não, com ou sem recheio|50 g|Unidades ou fatias
Pães embalados de consumo individual, chipa paraguaia|50 g|Unidades
Pão doce sem frutas|40 g|Unidades
Pão croissant, outros produtos de panificação, salgados ou doces sem recheio|40 g|Unidades
Pão de batata, pão de queijo e outros resfriados e congelados com recheio e massas para pães|40 g|Unidades ou fatias
Pão de batata, pão de queijo e outros resfriados e congelados sem recheio, chipa paraguaia|50 g|Unidades ou fatias
Pipoca|25 g|Xícaras
Torradas|30 g|Unidades
Tofu|40 g|Fatias
Trigo para quibe e proteína texturizada de soja|50 g|Xícaras
Leguminosas secas, todas|60 g|Xícaras
Pós para preparar flans e sobremesas|QSP 120 g|Colheres de sopa
Sagu|30 g|Colheres de sopa
Massas para pasteis e panquecas|30 g|Unidades
Massa para tortas salgadas|30 g|Frações
Massa para pizza|40 g|Fatias
Farinha de rosca|30 g|Colheres de sopa
Preparações à base de soja tipo: milanesa, almôndegas e hambúrguer|80 g|Unidades
Mistura para sopa paraguaia y chipaguazú|QSP 150 g|Fatias
Pré-mistura para preparar bori-bori|QSP 80 g|Colheres de sopa
Pré-mistura para preparar chipa paraguaia e mbeyu e outros pães|QSP 50 g|Colheres de sopa
Preparado desidratados para purês de tubérculos|QSP 150 g|Colheres de sopa ou xícaras
Pós para preparar bolos e tortas|QSP 60 g|Colheres de sopa`],
  ['II', 'Verduras, hortaliças e conservas vegetais (30 kcal)', `Concentrado de vegetais triplo (extrato)|30 g|Colheres de sopa
Concentrado de vegetais|15 g|Colheres de sopa
Purê ou polpa de vegetais, incluindo tomate|60 g|Colheres de sopa
Molho de tomate ou à base de tomate e outros vegetais|60 g|Colheres de sopa
Picles e alcaparras|15 g|Colheres de sopa
Sucos de vegetais, frutas e sojas|200 ml|Copos
Vegetais desidratados em conserva (tomate seco)|40 g|Colheres de sopa
Vegetais desidratados para sopa|40 g|Colheres de sopa
Vegetais desidratados para purê|QSP 150 g|Colheres de sopa
Vegetais em conserva (alcachofra, aspargo, cogumelos, pimentão, pepino e palmito) em salmoura, vinagre e azeite|50 g|Unidades ou xícaras
Jardineira e outras conservas de vegetais e legumes (cenouras, ervilhas, milho, tomate pelado e outros)|130 g|Xícaras
Vegetais empanados|80 g|Unidades`],
  ['III', 'Frutas, sucos, néctares e refrescos de frutas (70 kcal)', `Polpa de frutas para refresco, sucos concentrados de frutas e desidratados|QSP 200 ml|Colheres de sopa
Polpa de frutas para sobremesas|50 g|Colheres de sopa
Suco, néctar e bebidas de frutas|200 ml|Copos
Frutas desidratadas (peras, pêssegos, abacaxi, ameixas, partes comestíveis)|50 g|Unidades ou colheres de sopa
Uva passa|30 g|Colheres de sopa
Fruta em conserva, incluindo salada de frutas|140 g|Unidades ou colheres de sopa`],
  ['IV', 'Leites e derivados (125 kcal)', `Bebida láctea|200 ml|Copos
Leites fermentados, iogurte, todos os tipos|200 g|Copos
Leite fluido, todos os tipos|200 ml|Copos
Leite evaporado|QSP 200 ml|Colheres de sopa
Queijo ralado|10 g|Colheres de sopa
Queijo cottage, ricota desnatado, queijo minas, requeijão desnatado e petit-suisse|50 g|Colheres de sopa
Outros queijos (ricota, semiduros, branco, requeijão, queijo cremoso, fundidos e em pasta)|30 g|Colheres de sopa ou fatias
Leite em pó|QSP 200 ml|Colheres de sopa
Sobremesas lácteas|120 g|Unidades ou xícaras
Pós para preparar sobremesas lácteas|QSP 120 g|Colheres de sopa
Pós para preparar sorvetes|QSP 50 g|Colheres de sopa`],
  ['V', 'Carnes e ovos (125 kcal)', `Almôndegas à base de carnes|80 g|Unidades
Anchovas em conserva|15 g|Colheres de sopa
Apresuntado e corned beef|30 g|Fatias
Atum, sardinha, pescado, mariscos, outros peixes em conserva com ou sem molhos|60 g|Unidades ou colheres de sopa
Caviar|10 g|Colheres de chá
Charque|30 g|Frações ou pratos
Hambúrguer à base de carnes|80 g|Unidades
Linguiça, salsicha, todos os tipos|50 g|Unidades ou frações
Kani-kama|20 g|Unidades ou colheres de sopa
Preparações de carnes temperados, defumadas, cozidas ou não|100 g|Unidades
Preparações de carnes com farinhas ou empanadas|130 g|Unidades
Embutidos, fiambre e presunto|40 g|Unidades ou fatias
Peito de peru, blanquet|60 g|Unidades ou fatias
Patês (presunto, fígado e bacon etc)|10 g|Colheres de chá
Ovo|1 unidade|Unidades`],
  ['VI', 'Óleos, gorduras e sementes oleaginosas (100 kcal)', `Óleos vegetais, todos os tipos|13 ml|Colheres de sopa
Azeitona|20 g|Unidades
Bacon em pedaços - defumado ou fresco|10 g|Fatias
Banha e gorduras animais|10 g|Colheres de sopa
Gordura vegetal|10 g|Colheres de sopa
Maionese e molhos à base de maionese|12 g|Colheres de sopa
Manteiga, margarina e similares|10 g|Colheres de sopa
Molhos para saladas à base de óleo (todos os tipos)|13 ml|Colheres de sopa
Chantilly|20 g|Colheres de sopa
Creme de leite|15 g|Colheres de sopa
Leite de coco|15 g|Colheres de sopa
Coco ralado|12 g|Colheres de chá
Sementes oleaginosas (misturados, cortados, picados, inteiros)|15 g|Colheres de sopa`],
  ['VII', 'Açúcares e produtos com energia proveniente de carboidratos e gorduras (100 kcal)', `Açúcar, todos os tipos|5 g|Colheres de chá
Achocolatado em pó, pós com base de cacau, chocolate em pó e cacau em pó|20 g|Colheres de sopa
Doces em corte (goiaba, marmelo, figo, batata etc)|40 g|Fatias
Doces em pasta (abóbora, goiaba, leite, banana, mocotó)|20 g|Colheres de sopa
Geleias diversas|20 g|Colheres de sopa
Glicose de milho, mel, melado, cobertura de frutas, leite condensado e outros xaropes (cassis, groselha, framboesa, amora, guaraná etc)|20 g|Colheres de sopa
Pó para gelatina|QSP 120 g|Colheres de sopa
Sobremesa de gelatina pronta|120 g|Unidades
Frutas inteiras em conserva para adornos (cereja maraschino, framboesa)|20 g|Unidades
Balas, pirulitos e pastilhas|20 g|Unidades
Goma de mascar|3 g|Unidades
Chocolates, bombons e similares|25 g|Unidades ou frações
Confeitos de chocolate e drageados em geral|25 g|Unidades ou colheres de sopa
Sorvetes de massa|60 g ou 130 ml|Bolas ou unidades
Sorvetes individuais|60 g ou 130 ml|Unidades
Barra de cereais com mais de 10% de gorduras, torrones, pé de moleque e paçoca|20 g|Unidades ou frações
Bebidas não alcoólicas, carbonatadas ou não (chás, bebidas à base de soja e refrigerantes)|200 ml|Xícaras ou copos
Pós para preparo de refresco|QSP 200 ml|Colheres de sopa
Biscoito doce, com ou sem recheio|30 g|Unidades
Brownies e alfajores|40 g|Unidades
Frutas cristalizadas|30 g|Unidades ou colheres de sopa
Panetone|80 g|Unidades ou fatias
Bolo com frutas|60 g|Unidades ou fatias
Bolos e similares com recheio ou cobertura|60 g|Unidades ou fatias
Pão croissant, produtos de panificação, salgados ou doces com recheio ou cobertura|40 g|Unidades
Snacks à base de cereais e farinhas para petisco|25 g|Xícaras
Mistura para preparo de docinho, cobertura para bolos, tortas e sorvetes etc|20 g|Colheres de sopa`],
  ['VIII', 'Molhos, temperos prontos, caldos, sopas, pratos semiprontos ou prontos e bebidas alcoólicas', `Caldo (carne, galinha, legumes etc) e pós para sopa incluindo (bori-bori, pirá caldo, shoyo)|QSP 250 ml|Unidades, colheres de sopa ou frações
Catchup e mostarda|12 g|Colheres de sopa
Molhos à base de soja ou vinagre|1 colher de sopa|Colheres de sopa
Molhos à base de produtos lácteos ou caldos|2 colheres de sopa|Colheres de sopa
Pós para preparar molhos|QSP 2 colheres de sopa|Colheres de sopa
Misso|20 g|Colheres de sopa
Missoshiro|QSP 200 ml|Colheres de sopa
Extrato de soja|30 g|Colheres de sopa
Pratos preparados prontos e semiprontos não incluídos em outros itens da tabela|100 g|Unidades ou frações
Tempero completos|5 g|Colheres de chá
Bebidas alcoólicas|10 g de etanol|Unidades ou copos`],
];
const UTENSILIOS = [['Xícara de chá', '200 cm³ ou ml'], ['Copo', '200 cm³ ou ml'], ['Colher de sopa', '10 cm³ ou ml'], ['Colher de chá', '5 cm³ ou ml'], ['Prato raso', '22 cm de diâmetro'], ['Prato fundo', '250 cm³ ou ml']];
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const LISTA = GRUPOS.flatMap(([g, gn, txt]) => txt.split('\n').map(l => { const [produto, porcao, medida] = l.split('|'), m = /^(\d+(?:,\d+)?) (g|ml)$/.exec(porcao); return { grupo: g, grupoNome: gn, produto, porcao, valor: m ? Number(m[1].replace(',', '.')) : null, un: m ? m[2] : '', medida, qsp: /^QSP/.test(porcao) }; }));
function buscar(q, lim = 12) {
  const t = norm(q).split(/\s+/).filter(x => x.length > 1); if (!t.length) return [];
  return LISTA.map(x => { const n = norm(x.produto); const hits = t.filter(w => n.includes(w)).length; return { x, s: hits === t.length ? 2 + hits : hits / t.length }; }).filter(r => r.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, lim).map(r => r.x);
}
module.exports = { GRUPOS, LISTA, UTENSILIOS, buscar };
