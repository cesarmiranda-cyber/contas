'use strict';
// Catálogo de módulos do RH. Para adicionar um módulo: incluir aqui (status 'ativo'), registrar as rotas em server.js
// e o controle de acesso já passa a valer (a tela de Acessos lista todo módulo ativo).
const MODULOS = [
  { id: 'curriculos', nome: 'Recepção de currículos', desc: 'Candidaturas recebidas pelo site de carreiras, triagem e banco de talentos.', icone: 'curriculos', cor: 'green', status: 'ativo' },
  { id: 'admissao', nome: 'Admissão digital', desc: 'Documentos e checklist de entrada do novo colaborador.', icone: 'admissao', cor: 'lime', status: 'em-breve' },
  { id: 'ferias', nome: 'Férias e ausências', desc: 'Solicitações, saldos e calendário do time.', icone: 'ferias', cor: 'slate', status: 'em-breve' },
  { id: 'desempenho', nome: 'Desempenho', desc: 'Ciclos de avaliação e feedbacks.', icone: 'desempenho', cor: 'forest', status: 'em-breve' },
];
const NIVEIS = ['consulta', 'gestor'];
const ativo = id => MODULOS.find(m => m.id === id && m.status === 'ativo') || null;
module.exports = { MODULOS, NIVEIS, ativo };
