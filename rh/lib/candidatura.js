'use strict';
// Ficha de cadastro do candidato. Desenhada como as dos grandes players (Gupy, Vagas.com, LinkedIn "Candidatura simplificada"):
// o obrigatório cabe em ~1 minuto (contato + área + currículo OU LinkedIn + aceite LGPD); o resto é opcional.
// Não coletamos dados que facilitam discriminação (idade, sexo, raça, estado civil, foto).
const AREAS = ['Operações e logística', 'Manutenção e mecânica', 'Comercial e vendas', 'Atendimento ao cliente', 'Administrativo', 'Financeiro e contábil', 'Recursos humanos', 'Tecnologia', 'Segurança do trabalho', 'Motorista e transporte', 'Outra'];
const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
const ESCOLARIDADE = ['Fundamental', 'Médio', 'Técnico', 'Superior incompleto', 'Superior completo', 'Pós-graduação'];
const EXPERIENCIA = ['Sem experiência', 'Até 1 ano', '1 a 3 anos', '3 a 5 anos', '5 a 10 anos', 'Mais de 10 anos'];
const DISPONIBILIDADE = ['Imediata', 'Em até 15 dias', 'Em até 30 dias', 'Mais de 30 dias'];
const MODELOS = ['Presencial', 'Híbrido', 'Remoto'];
const ORIGENS = ['Site da Original', 'LinkedIn', 'Indicação', 'Instagram', 'Outro'];
const CV_MAX = 3 * 1024 * 1024; // o canal externo limita o corpo a 4 MiB e base64 incha ~33%
const CONSENTIMENTO_VERSAO = '2026-11';

// Documento dos campos (alimenta a aba Integração e docs/ficha-de-cadastro.md)
const CAMPOS = [
  { campo: 'nome', rotulo: 'Nome completo', obrigatorio: true, tipo: 'texto', regra: '3 a 120 caracteres' },
  { campo: 'email', rotulo: 'E-mail', obrigatorio: true, tipo: 'e-mail', regra: 'Identifica o candidato (reenvio atualiza a ficha)' },
  { campo: 'telefone', rotulo: 'Celular / WhatsApp', obrigatorio: true, tipo: 'texto', regra: 'DDD + número (10 ou 11 dígitos)' },
  { campo: 'cidade', rotulo: 'Cidade', obrigatorio: true, tipo: 'texto', regra: 'até 80 caracteres' },
  { campo: 'uf', rotulo: 'Estado', obrigatorio: true, tipo: 'lista', opcoes: UFS },
  { campo: 'area', rotulo: 'Área de interesse', obrigatorio: true, tipo: 'lista', opcoes: AREAS },
  { campo: 'curriculo', rotulo: 'Currículo (PDF, DOC ou DOCX, até 3 MB)', obrigatorio: 'curriculo OU linkedin', tipo: 'objeto', regra: '{ "nome": "cv.pdf", "base64": "..." } — o tipo é conferido pelo conteúdo' },
  { campo: 'linkedin', rotulo: 'Perfil do LinkedIn', obrigatorio: 'curriculo OU linkedin', tipo: 'url', regra: 'linkedin.com/in/seu-perfil' },
  { campo: 'consentimento', rotulo: 'Aceite da Política de Privacidade (LGPD)', obrigatorio: true, tipo: 'booleano', regra: 'deve ser true' },
  { campo: 'cargo', rotulo: 'Cargo / vaga de interesse', obrigatorio: false, tipo: 'texto', regra: 'até 80 caracteres' },
  { campo: 'escolaridade', rotulo: 'Escolaridade', obrigatorio: false, tipo: 'lista', opcoes: ESCOLARIDADE },
  { campo: 'experiencia', rotulo: 'Tempo de experiência', obrigatorio: false, tipo: 'lista', opcoes: EXPERIENCIA },
  { campo: 'disponibilidade', rotulo: 'Disponibilidade para início', obrigatorio: false, tipo: 'lista', opcoes: DISPONIBILIDADE },
  { campo: 'modelo', rotulo: 'Modelo de trabalho', obrigatorio: false, tipo: 'lista (várias)', opcoes: MODELOS },
  { campo: 'pretensao', rotulo: 'Pretensão salarial (R$)', obrigatorio: false, tipo: 'número', regra: '0 a 1.000.000' },
  { campo: 'sobre', rotulo: 'Fale um pouco sobre você', obrigatorio: false, tipo: 'texto longo', regra: 'até 600 caracteres' },
  { campo: 'portfolio', rotulo: 'Portfólio / site', obrigatorio: false, tipo: 'url', regra: 'http(s)' },
  { campo: 'pcd', rotulo: 'Pessoa com deficiência (para vagas afirmativas)', obrigatorio: false, tipo: 'booleano', regra: 'opcional e voluntário' },
  { campo: 'origem', rotulo: 'Como conheceu a Original', obrigatorio: false, tipo: 'lista', opcoes: ORIGENS },
  { campo: 'vaga', rotulo: 'Código da vaga (oculto)', obrigatorio: false, tipo: 'texto', regra: 'vem da URL (?vaga=...) da página; até 80 caracteres' },
  { campo: 'utm', rotulo: 'Campanha (oculto)', obrigatorio: false, tipo: 'objeto', regra: '{ "source","medium","campaign" } — texto curto' },
  { campo: 'website', rotulo: 'Campo isca anti-robô (oculto, deve ir vazio)', obrigatorio: false, tipo: 'texto', regra: 'se vier preenchido a ficha é descartada' },
];

const limpa = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const emLista = (v, lista) => lista.find(x => x.toLowerCase() === String(v ?? '').trim().toLowerCase());

function linkedin(v) {
  const m = String(v).trim().match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]{3,100})\/?(?:[?#].*)?$/i);
  return m ? `https://www.linkedin.com/in/${m[1]}` : null;
}
function urlHttp(v) { try { const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href.slice(0, 200) : null; } catch { return null; } }
function fone(v) {
  let d = String(v).replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
}
function lerCv(cv) {
  const b64 = String(cv.base64 || '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { erro: 'Arquivo do currículo inválido.' };
  if (b64.length > Math.ceil(CV_MAX / 3) * 4 + 8) return { erro: 'O currículo passa de 3 MB.' };
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > CV_MAX) return { erro: 'O currículo passa de 3 MB.' };
  const head = buf.subarray(0, 8);
  let ext = null;
  if (head.subarray(0, 4).toString('latin1') === '%PDF') ext = 'pdf';
  else if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) ext = 'docx';
  else if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) ext = 'doc';
  if (!ext) return { erro: 'Envie o currículo em PDF, DOC ou DOCX.' };
  const base = limpa(String(cv.nome || 'curriculo').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|]/g, '_'), 60) || 'curriculo';
  return { buf, ext, nome: `${base}.${ext}`, tamanho: buf.length };
}

function validar(inp) {
  const erros = {}, d = {};
  const obrig = (k, msg) => { erros[k] = msg; };
  d.nome = limpa(inp.nome, 120); if (d.nome.length < 3 || !/\s|./.test(d.nome)) obrig('nome', 'Informe seu nome completo.');
  d.email = limpa(inp.email, 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) obrig('email', 'Informe um e-mail válido.');
  d.telefone = fone(inp.telefone ?? ''); if (!d.telefone) obrig('telefone', 'Informe o celular com DDD.');
  d.cidade = limpa(inp.cidade, 80); if (!d.cidade) obrig('cidade', 'Informe a cidade.');
  d.uf = emLista(String(inp.uf || '').toUpperCase(), UFS); if (!d.uf) obrig('uf', 'Escolha o estado.');
  d.area = emLista(inp.area, AREAS); if (!d.area) obrig('area', 'Escolha a área de interesse.');
  if (inp.consentimento !== true) obrig('consentimento', 'É preciso aceitar a Política de Privacidade.');
  let cv = null;
  if (inp.linkedin) { d.linkedin = linkedin(inp.linkedin); if (!d.linkedin) obrig('linkedin', 'Use o endereço do perfil: linkedin.com/in/seu-perfil.'); }
  if (inp.curriculo && typeof inp.curriculo === 'object') { const r = lerCv(inp.curriculo); if (r.erro) obrig('curriculo', r.erro); else cv = r; }
  if (!cv && !d.linkedin && !erros.linkedin && !erros.curriculo) obrig('curriculo', 'Anexe o currículo ou informe o LinkedIn.');
  const opc = (k, lista) => { if (inp[k] !== undefined && inp[k] !== '') { const v = emLista(inp[k], lista); if (!v) obrig(k, 'Opção inválida.'); else d[k] = v; } };
  opc('escolaridade', ESCOLARIDADE); opc('experiencia', EXPERIENCIA); opc('disponibilidade', DISPONIBILIDADE); opc('origem', ORIGENS);
  if (inp.modelo !== undefined && inp.modelo !== '') {
    const arr = (Array.isArray(inp.modelo) ? inp.modelo : [inp.modelo]).map(x => emLista(x, MODELOS));
    if (arr.some(x => !x)) obrig('modelo', 'Opção inválida.'); else d.modelo = [...new Set(arr)];
  }
  if (inp.cargo) d.cargo = limpa(inp.cargo, 80);
  if (inp.sobre) d.sobre = limpa(inp.sobre, 600);
  if (inp.vaga) d.vaga = limpa(inp.vaga, 80);
  if (inp.pretensao !== undefined && inp.pretensao !== '' && inp.pretensao !== null) {
    const n = Number(String(inp.pretensao).replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) obrig('pretensao', 'Valor inválido.'); else d.pretensao = Math.round(n * 100) / 100;
  }
  if (inp.portfolio) { d.portfolio = urlHttp(limpa(inp.portfolio, 200)); if (!d.portfolio) obrig('portfolio', 'Endereço inválido.'); }
  if (inp.pcd !== undefined) d.pcd = inp.pcd === true;
  if (inp.utm && typeof inp.utm === 'object') d.utm = Object.fromEntries(['source', 'medium', 'campaign'].filter(k => inp.utm[k]).map(k => [k, limpa(inp.utm[k], 60)]));
  return { ok: Object.keys(erros).length === 0, erros, dados: d, cv };
}
module.exports = { AREAS, validar, CAMPOS, CV_MAX, CONSENTIMENTO_VERSAO, linkedin, fone };
