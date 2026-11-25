'use strict';
// Modelos de documentos do BK (etapa "Envio de Documentos"): definição dos campos, valores iniciais tirados do card e geração dos arquivos.
const fs = require('fs');
const path = require('path');
const G = require('./docGen');
const PDF = require('./pdfCert');
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const DIR = path.join(__dirname, '..', 'modelos', 'bk');
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const digitos = v => String(v || '').replace(/\D/g, '');
const fmtCnpj = v => digitos(v).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const fmtCep = v => digitos(v).replace(/^(\d{5})(\d{3})$/, '$1-$2');
const MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };

// Valores que o app já conhece do card (unidade, empresa, contato, datas). Os campos dos modelos "puxam" daqui pelo nome em `auto`.
function autoDe({ unidade: u, empresa, contato, tipos = [], hoje, usuario }) {
  const iso = hoje, [a, m, d] = iso.split('-'), nome = u ? u.nome : '', cidade = u ? u.cidade : '', uf = u ? u.uf : '';
  const filial = nome ? (/^(burger|bk\b)/i.test(nome) ? nome : `Burger King ${nome}`).toUpperCase() : '';
  const end = u ? [u.endereco, cidade && uf ? `${cidade} – ${uf}` : cidade || uf, fmtCep(u.cep)].filter(Boolean).join(', ') : '';
  return {
    unidade: nome, bkn: u ? u.bkn : '', cnpj: u ? fmtCnpj(u.cnpj) : '', endereco: u ? u.endereco : '', endereco_completo: end, cidade, uf, cep: u ? fmtCep(u.cep) : '', cidade_uf: [cidade, uf].filter(Boolean).join('/'),
    rt_nome: u && u.rt ? u.rt.nome : '', rt_crn: u && u.rt ? u.rt.crn : '', empresa: empresa ? empresa.nome : '', empresa_razao: empresa && empresa.razao ? empresa.razao : '', empresa_cnpj: empresa ? fmtCnpj(empresa.cnpj) : '',
    contato: contato || '', filial, filial_curta: cidade ? `FILIAL ${cidade.toUpperCase()}${uf ? '/' + uf : ''}` : '', data: `${d}/${m}/${a}`, data_iso: iso, data_extenso: `${+d} de ${MESES[+m - 1]} de ${a}`, tipos: tipos.join(', '), usuario: usuario || '',
  };
}
const L = (k, rotulo, extra = {}) => ({ k, rotulo, ...extra });
const MODELOS = [
  { id: 'carta-defesa', nome: 'Carta de defesa (manifestação de defesa)', descricao: 'Defesa ao auto de infração/penalidade sanitária. O texto do modelo vem preenchido: ajuste ao caso.', arquivo: 'carta-defesa.docx', formato: 'docx', tipos: ['Defesa'],
    saida: v => `Carta de defesa - ${v.filial_curta || v.filial || 'unidade'}.docx`, campos: [
      L('empresa', 'Empresa (razão social)', { auto: 'empresa_razao', padrao: 'ZAMP S.A.' }), L('filial', 'Filial', { auto: 'filial' }), L('filial_curta', 'Filial (cabeçalho das páginas)', { auto: 'filial_curta' }), L('cnpj', 'CNPJ da filial', { auto: 'cnpj' }),
      L('endereco', 'Endereço', { auto: 'endereco_completo' }), L('destinatario', 'A/C (destinatário)', { auto: 'contato', maiusculas: true }), L('numero_auto', 'Nº do auto de imposição de penalidade'), L('numero_ficha', 'Nº da ficha de procedimentos'), L('numero_auto_infracao', 'Nº do auto de infração (cabeçalho)'),
      L('considerando', 'Considerando (fato atenuante)', { tipo: 'longo', padrao: 'Considerando o fato atenuante, da empresa, compreendendo a importância sobre os pontos levantados, imediatamente ter tomado medidas para sana-los conforme descrito a seguir.' }),
      L('acao_1', 'Ação corretiva 1', { tipo: 'longo', padrao: 'Acionamento da empresa especializada em assessoria e consultoria nutricional para a orientação e suporte. Dos colaboradores utilizando adornos, foi feita aplicação de treinamento de reciclagem com orientação a respeito do asseio pessoal e acompanhamento contínuo por parte das lideranças devido à alta rotatividade.' }),
      L('acao_2', 'Ação corretiva 2', { tipo: 'longo', padrao: 'Da manipulação de perfurocortantes sem apoio e proteção adequada, da luva térmica e calçados desgastados e da ausência de mangote, foi feita a compra e já se encontram todos disponíveis na unidade.' }),
      L('acao_3', 'Ação corretiva 3', { tipo: 'longo', padrao: 'Do acúmulo pontual de água no piso da área de manipulação, foi feita orientação e advertência aos colaboradores a respeito dos procedimentos de segurança para reduzir risco de quedas, dentre eles a manutenção do piso limpo e seco. Do risco de queda nas escadas, foi feita instalação de fitas antiderrapante nos degraus.' }),
      L('acao_4', 'Ação corretiva 4 (opcional)', { tipo: 'longo' }), L('acao_5', 'Ação corretiva 5 (opcional)', { tipo: 'longo' }),
      L('prazo_acoes', 'Prazo e comprovação das ações', { tipo: 'longo', padrao: 'Todas as referidas ações corretivas foram concluídas antes de __/__/____, conforme datas constantes na compra de EPI’s e certificados de treinamento em anexo junto a essa defesa.' }),
      L('conclusao', 'Conclusão e pedido', { tipo: 'longo', padrao: 'Considerando a resolução de todas as não conformidades em tempo hábil, comprovado pelos documentos enviados em conjunto a essa defesa, e adicionado ao fato de que não houve inspeção de retorno na data de encerramento do prazo, para verificar o status dos pontos anteriormente indicados na ficha de procedimentos, solicita-se a conversão da multa em advertência e o arquivamento do auto de infração, uma vez que na data em questão já não havia mais qualquer risco laboral à integridade dos colaboradores, termos em que,' }),
      L('cidade_uf', 'Cidade/UF da assinatura', { auto: 'cidade_uf' }), L('data_extenso', 'Data por extenso', { auto: 'data_extenso' })] },
  { id: 'parecer-tecnico', nome: 'Parecer técnico', descricao: 'Parecer técnico com cabeçalho e assinaturas preenchidos. O corpo do modelo (parecer sobre o sanitizante) segue como está: edite no Word depois de gerar.', arquivo: 'parecer-tecnico.docx', formato: 'docx', tipos: ['Parecer técnico'],
    saida: v => `Parecer técnico - ${(v.motivo || 'parecer').slice(0, 40)}.docx`, campos: [
      L('motivo', 'Motivo', { padrao: 'Alteração do procedimento sanitizante' }), L('estabelecimento', 'Estabelecimento', { auto: 'empresa_razao', padrao: 'ZAMP S.A.' }), L('endereco', 'Endereço', { auto: 'endereco_completo' }),
      L('responsavel_1', 'Responsável 1 (nome – CRN)', { padrao: 'Cristiane Ferreira – CRN nº 24.305' }), L('responsavel_2', 'Responsável 2 (nome – CRN)', { padrao: 'Rafael Silva – CRN nº 79.995' }), L('data', 'Data das assinaturas', { auto: 'data' })] },
  { id: 'plano-acao', nome: 'Cronograma de plano de ação', descricao: 'Planilha com as inadequações, ações corretivas, responsáveis e prazos. Uma linha por inadequação; as fotos de evidência você anexa na planilha depois.', arquivo: 'plano-acao.xlsx', formato: 'xlsx', tipos: ['Acompanhamento em vigilância', 'Defesa'], tabela: true,
    saida: v => `Plano de ação - ${v.titulo ? v.titulo.replace(/^.*?BKN/i, 'BKN').slice(0, 50) : 'unidade'}.xlsx`, campos: [
      L('titulo', 'Título da planilha', { auto: 'titulo_plano' }), L('subtitulo', 'Gerente / consultor(a)', { auto: 'subtitulo_plano' })],
    colunas: [['inadequacao', 'Inadequação / situação'], ['consequencia', 'Consequência da inconformidade'], ['dataFicha', 'Data da ficha de procedimentos', 'date'], ['dataAuditoria', 'Data da auditoria Nutrimix', 'date'], ['acao', 'Ação corretiva'], ['responsavel', 'Responsável'], ['prazo', 'Data limite prevista', 'date'], ['status', 'Status da ação'], ['observacao', 'Observação']] },
  { id: 'certificado-bpm', nome: 'Certificado de treinamento (Boas Práticas)', descricao: 'Um certificado em PDF por participante, no modelo da Nutri Mix. Informe um participante por linha: nome; CPF.', arquivo: 'certificado-bpm.pdf', formato: 'pdf', tipos: ['Treinamento de boas práticas'], participantes: true,
    saida: v => `Certificado BPM - ${v.nome}.pdf`, campos: [
      L('participantes', 'Participantes (um por linha: nome; CPF)', { tipo: 'longo', obrigatorio: true }), L('curso', 'Curso', { padrao: 'Curso de Boas Práticas de Manipulação' }), L('cargaHoraria', 'Carga horária (hh:mm)', { padrao: '04:00' }), L('cidade', 'Cidade do certificado', { padrao: 'São Paulo' }), L('dataIso', 'Data do certificado', { tipo: 'data', auto: 'data_iso' })] },
];
const extras = { titulo_plano: a => `CRONOGRAMA - PLANO DE AÇÃO BKN ${a.bkn} ${String(a.unidade || '').toUpperCase()}`.trim(), subtitulo_plano: a => `Gerente: ${a.contato || ''} / Consultor(a): ${a.usuario || ''}` };

const limpa = n => String(n).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 140);
const lerArquivo = (def, dir) => { const p = def.embutido === false ? path.join(dir, def.arquivo) : path.join(DIR, def.arquivo); try { return fs.readFileSync(p); } catch { throw bad('O arquivo do modelo não foi encontrado no servidor.', 500); } };
const todos = enviados => [...MODELOS.map(m => ({ ...m, embutido: true })), ...enviados.map(e => ({ ...e, embutido: false }))];
const achar = (id, enviados) => todos(enviados).find(m => m.id === id) || (() => { throw bad('Modelo não encontrado.', 404); })();
const resumo = m => ({ id: m.id, nome: m.nome, descricao: m.descricao || '', formato: m.formato, tipos: m.tipos || [], embutido: m.embutido, tabela: !!m.tabela, participantes: !!m.participantes, colunas: m.colunas || [], campos: m.campos.map(c => ({ k: c.k, rotulo: c.rotulo, tipo: c.tipo || 'texto', obrigatorio: !!c.obrigatorio })) });
// Valores iniciais dos campos: o que o card já sabe (auto) ou o texto padrão do modelo.
function iniciais(m, a) {
  const auto = { ...a, ...Object.fromEntries(Object.entries(extras).map(([k, f]) => [k, f(a)])) };
  return Object.fromEntries(m.campos.map(c => { let v = c.auto && auto[c.auto] ? auto[c.auto] : (c.padrao || ''); if (c.maiusculas) v = String(v).toUpperCase(); return [c.k, v]; }));
}
function gerar(m, valores, { dir, usuario } = {}) {
  const v = {}; for (const c of m.campos) { const x = valores && valores[c.k]; v[c.k] = x == null ? '' : String(x).replace(/\u0000/g, '').slice(0, c.tipo === 'longo' ? 6000 : 400); if (c.obrigatorio && !v[c.k].trim()) throw bad(`Preencha: ${c.rotulo}.`); }
  const base = lerArquivo(m, dir), saida = vv => limpa(m.saida ? m.saida(vv) : `${m.nome} - ${vv.unidade || vv.bkn || 'documento'}.${m.formato}`);
  if (m.participantes) {
    const lista = v.participantes.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => { const [nome, cpf] = l.split(/[;\t]/).map(s => (s || '').trim()); return { nome, cpf }; }); if (!lista.length) throw bad('Informe ao menos um participante.'); if (lista.length > 6) throw bad('Gere no máximo 6 certificados por vez.');
    return lista.map(p => ({ nome: saida({ nome: p.nome }), mime: MIME.pdf, dados: PDF.gerarCertificado(base, { nome: p.nome, cpf: p.cpf, curso: v.curso, cargaHoraria: v.cargaHoraria, cidade: v.cidade, data: v.dataIso }) }));
  }
  if (m.formato === 'docx') { const r = G.gerarDocx(base, v); return [{ nome: saida(v), mime: MIME.docx, dados: r.buf }]; }
  if (m.formato === 'xlsx') {
    const linhas = (Array.isArray(valores && valores.linhas) ? valores.linhas : []).slice(0, 100).map(l => Object.fromEntries((m.colunas || []).map(([k]) => [k, String((l && l[k]) || '').slice(0, 800)]))).filter(l => Object.values(l).some(Boolean));
    if (m.tabela) { const r = G.gerarPlanoXlsx(base, { titulo: v.titulo, subtitulo: v.subtitulo, linhas }); return [{ nome: m.saida(v), mime: MIME.xlsx, dados: r.buf }]; }
    const r = G.gerarXlsxCampos ? G.gerarXlsxCampos(base, v) : null; if (!r) throw bad('Formato não suportado.'); return [{ nome: saida(v), mime: MIME.xlsx, dados: r.buf }];
  }
  throw bad('Formato de modelo não suportado.');
}
// Modelo enviado pelo administrador: .docx ou .xlsx com marcadores {{campo}}.
function novoModelo({ nome, tipos, arquivo, nomeArquivo }, dir) {
  const ext = String(nomeArquivo || '').toLowerCase().endsWith('.xlsx') ? 'xlsx' : String(nomeArquivo || '').toLowerCase().endsWith('.docx') ? 'docx' : ''; if (!ext) throw bad('Envie um arquivo .docx ou .xlsx.');
  const buf = Buffer.from(String(arquivo || '').replace(/^data:[^,]*,/, ''), 'base64'); if (buf.length < 100 || buf.length > 8 * 1048576) throw bad('O arquivo deve ter até 8 MB.');
  const campos = G.campos(buf, ext); if (!campos.length) throw bad('O arquivo não tem nenhum campo {{assim}}. Escreva os marcadores onde o dado deve entrar.');
  const id = 'mod_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), arq = `${id}.${ext}`; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, arq), buf);
  return { id, nome: String(nome || nomeArquivo).trim().slice(0, 120), descricao: 'Modelo enviado pelo administrador.', arquivo: arq, formato: ext, tipos: (tipos || []).map(String).slice(0, 25),
    campos: campos.map(k => ({ k, rotulo: k.replace(/_/g, ' '), auto: ({ unidade: 'unidade', bkn: 'bkn', cnpj: 'cnpj', endereco: 'endereco_completo', cidade: 'cidade', uf: 'uf', cep: 'cep', empresa: 'empresa', empresa_razao: 'empresa_razao', contato: 'contato', rt_nome: 'rt_nome', rt_crn: 'rt_crn', data: 'data', data_extenso: 'data_extenso', cidade_uf: 'cidade_uf', tipos: 'tipos', usuario: 'usuario' })[k], tipo: /^(texto|paragrafo|p_|descricao|obs)/.test(k) ? 'longo' : 'texto' })) };
}
const listar = enviados => todos(enviados).map(resumo);
module.exports = { MODELOS, listar, autoDe, resumo, iniciais, gerar, achar, novoModelo, MIME };
