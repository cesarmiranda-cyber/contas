'use strict';
// Modelos de projeto: lista de atividades com duração (em dias úteis ou corridos, conforme o calendário), dependências e flags.
// Cada atividade: { ref, nome, dur, deps: [{ ref, tipo: 'FS'|'SS', lag }], offset?, interna?, aguardaCliente?, pedido?, requerAprovacao?, descricao? }
const EMBUTIDOS = [
  { id: 'implantacao-bitrix24', nome: 'Implantação Bitrix24', tipo: 'Implantação Bitrix24', diasUteis: true,
    descricao: 'Implantação completa do Bitrix24: processos, CRM, integrações, automações, treinamento e go-live com acompanhamento.',
    tarefas: [
      { ref: 'abertura', nome: 'Reunião de abertura', dur: 1, descricao: 'Alinhar escopo, prazos, responsáveis e canais de comunicação.' },
      { ref: 'lev', nome: 'Levantamento de processos', dur: 3, deps: [{ ref: 'abertura' }], descricao: 'Mapear o processo comercial, as etapas dos funis e os campos necessários.' },
      { ref: 'acessos', nome: 'Cadastro de usuários e acessos', dur: 2, deps: [{ ref: 'abertura' }], aguardaCliente: true, pedido: 'Envie a lista de usuários com nome, e-mail, departamento e perfil de acesso.' },
      { ref: 'conf', nome: 'Configuração do CRM (funis, etapas e campos)', dur: 5, deps: [{ ref: 'lev' }] },
      { ref: 'integr', nome: 'Integrações (WhatsApp, e-mail e telefonia)', dur: 4, deps: [{ ref: 'conf', tipo: 'SS', lag: 2 }] },
      { ref: 'auto', nome: 'Automações e robôs', dur: 4, deps: [{ ref: 'conf' }] },
      { ref: 'dados', nome: 'Importação de dados', dur: 2, deps: [{ ref: 'conf' }], aguardaCliente: true, pedido: 'Envie a planilha com a base de clientes e contatos a importar.' },
      { ref: 'testes', nome: 'Testes e ajustes', dur: 2, deps: [{ ref: 'integr' }, { ref: 'auto' }, { ref: 'dados' }, { ref: 'acessos' }] },
      { ref: 'trein', nome: 'Treinamento da equipe', dur: 2, deps: [{ ref: 'testes' }] },
      { ref: 'homolog', nome: 'Homologação e aceite do cliente', dur: 2, deps: [{ ref: 'trein' }], requerAprovacao: true, descricao: 'O cliente valida a configuração e aprova a entrega.' },
      { ref: 'golive', nome: 'Go-live', dur: 1, deps: [{ ref: 'homolog' }] },
      { ref: 'pos', nome: 'Acompanhamento pós go-live', dur: 5, deps: [{ ref: 'golive' }] }] },
  { id: 'treinamento', nome: 'Treinamento Bitrix24', tipo: 'Treinamento', diasUteis: true, descricao: 'Treinamento da equipe do cliente, com preparação do material e avaliação.',
    tarefas: [
      { ref: 'publico', nome: 'Levantamento do público e das necessidades', dur: 1, aguardaCliente: true, pedido: 'Envie a lista de participantes (nome, e-mail e função) e os temas prioritários.' },
      { ref: 'material', nome: 'Preparação do material', dur: 2, deps: [{ ref: 'publico' }] },
      { ref: 't1', nome: 'Treinamento — turma 1', dur: 1, deps: [{ ref: 'material' }] },
      { ref: 't2', nome: 'Treinamento — turma 2', dur: 1, deps: [{ ref: 't1' }] },
      { ref: 'aval', nome: 'Avaliação e certificados', dur: 1, deps: [{ ref: 't2' }], requerAprovacao: true }] },
  { id: 'integracao-automacao', nome: 'Integração e automação', tipo: 'Integração / Automação', diasUteis: true, descricao: 'Integração do Bitrix24 com outros sistemas e automação de processos.',
    tarefas: [
      { ref: 'escopo', nome: 'Reunião de escopo', dur: 1 },
      { ref: 'mapa', nome: 'Mapeamento do fluxo', dur: 2, deps: [{ ref: 'escopo' }] },
      { ref: 'dev', nome: 'Desenvolvimento e configuração', dur: 5, deps: [{ ref: 'mapa' }] },
      { ref: 'teste', nome: 'Testes', dur: 2, deps: [{ ref: 'dev' }] },
      { ref: 'homolog', nome: 'Homologação e aceite', dur: 2, deps: [{ ref: 'teste' }], requerAprovacao: true },
      { ref: 'prod', nome: 'Entrada em produção', dur: 1, deps: [{ ref: 'homolog' }] }] },
].map(m => ({ ...m, embutido: true }));

// Converte o modelo em atividades prontas (sem dependência de ids do banco): refs viram ids novos.
function gerarTarefas(modelo, inicio, cal, S, novoId) {
  const ids = new Map(modelo.tarefas.map(t => [t.ref, novoId()])); const base = cal.proximoUtil(inicio);
  const tarefas = modelo.tarefas.map((t, i) => {
    const ini = cal.somaUteis(base, t.offset || 0), dur = Math.max(1, t.dur || 1);
    return { id: ids.get(t.ref), nome: t.nome, inicio: ini, fim: cal.somaUteis(ini, dur - 1), progresso: 0, responsavel: '', descricao: t.descricao || '', interna: !!t.interna, aguardaCliente: !!t.aguardaCliente, pedido: t.pedido || '', requerAprovacao: !!t.requerAprovacao,
      deps: (t.deps || []).filter(d => ids.has(d.ref)).map(d => ({ de: ids.get(d.ref), tipo: d.tipo === 'SS' ? 'SS' : 'FS', lag: +d.lag || 0 })), ordem: i };
  });
  S.reagendar(tarefas, cal); return tarefas;
}
// Transforma as atividades de um projeto em um modelo reutilizável.
function modeloDoProjeto(tarefas, cal) {
  const ord = [...tarefas].sort((a, b) => a.inicio.localeCompare(b.inicio) || (a.ordem || 0) - (b.ordem || 0)); const ref = new Map(ord.map((t, i) => [t.id, 't' + (i + 1)])); const ini0 = ord.length ? ord[0].inicio : null;
  return ord.map(t => ({ ref: ref.get(t.id), nome: t.nome, dur: Math.max(1, cal.diffUteis(t.inicio, t.fim) + 1), deps: (t.deps || []).filter(d => ref.has(d.de)).map(d => ({ ref: ref.get(d.de), tipo: d.tipo, lag: +d.lag || 0 })),
    ...((t.deps || []).length ? {} : { offset: Math.max(0, cal.diffUteis(ini0, t.inicio)) }), interna: !!t.interna, aguardaCliente: !!t.aguardaCliente, pedido: t.pedido || '', requerAprovacao: !!t.requerAprovacao, descricao: t.descricao || '' }));
}
module.exports = { EMBUTIDOS, gerarTarefas, modeloDoProjeto };
