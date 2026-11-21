'use strict';
// Tarefas longas em segundo plano (diagnóstico, sincronização, preparar): a tela inicia e acompanha por consulta,
// sem segurar uma requisição aberta (o gateway da plataforma derruba requisições demoradas).
function createJobs(handlers) {
  const jobs = new Map();
  const vista = j => (j ? { nome: j.nome, status: j.status, passo: j.passo, inicio: j.inicio, fim: j.fim || null, segundos: Math.round(((j.fim || Date.now()) - j.inicio) / 1000), resultado: j.resultado, erro: j.erro } : { status: 'nenhum' });
  return {
    estado: nome => vista(jobs.get(nome)),
    iniciar(nome, body = {}) {
      if (!handlers[nome]) throw Object.assign(new Error('Tarefa desconhecida.'), { status: 404 });
      const atual = jobs.get(nome);
      if (atual?.status === 'rodando') return vista(atual);            // já em andamento: não inicia outra
      const j = { nome, status: 'rodando', inicio: Date.now(), passo: 'Iniciando…' };
      jobs.set(nome, j);
      Promise.resolve().then(() => handlers[nome](body, p => { j.passo = p; }))
        .then(r => { j.status = 'concluido'; j.resultado = r; j.fim = Date.now(); j.passo = ''; },
          e => { j.status = 'erro'; j.erro = String(e.message || e).slice(0, 300); j.fim = Date.now(); j.passo = ''; });
      return vista(j);
    },
  };
}
module.exports = { createJobs };
