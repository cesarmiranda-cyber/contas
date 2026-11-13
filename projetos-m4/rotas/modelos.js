'use strict';
// Modelos de projeto.
module.exports = ctx => {
  const { Modelos, S, aplicarModelo, bad, calDe, db, exigir, modeloPorId, modeloView, projetoDe, reg, rota, send, store, str, tarefasDe } = ctx;
rota('GET', '/api/modelos', async (req, res, _m, _b, u) => { exigir(u, 'equipe'); send(res, 200, { modelos: [...Modelos.EMBUTIDOS, ...(db.modelos || [])].map(modeloView) }); });
rota('POST', '/api/modelos', async (req, res, _m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(String(b.projetoId)); if (!p) throw bad(404, 'Projeto não encontrado.'); const nome = str(b.nome, 80, true, 'Nome do modelo'); const ts = tarefasDe(p.id); if (!ts.length) throw bad(400, 'O projeto não tem atividades para salvar como modelo.');
  if ([...Modelos.EMBUTIDOS, ...(db.modelos || [])].some(m => m.nome.toLowerCase() === nome.toLowerCase())) throw bad(409, 'Já existe um modelo com este nome.');
  const m = { id: store.id(), nome, tipo: p.tipo || '', descricao: p.descricao || '', diasUteis: !!p.diasUteis, tarefas: Modelos.modeloDoProjeto(ts, calDe(p)), criadoPor: u.nome, criadoEm: store.agora() }; (db.modelos = db.modelos || []).push(m);
  reg(u, 'salvou_modelo', `${nome} (${m.tarefas.length} atividades)`, p.id); store.save(); send(res, 201, { modelo: modeloView(m) });
});
rota('DELETE', '/api/modelos/([0-9a-f]+)', async (req, res, m, _b, u) => {
  exigir(u, 'equipe'); const mod = (db.modelos || []).find(x => x.id === m[1]); if (!mod) throw bad(404, 'Modelo não encontrado (os modelos padrão não podem ser excluídos).');
  db.modelos = db.modelos.filter(x => x.id !== mod.id); reg(u, 'excluiu_modelo', mod.nome); store.save(); send(res, 200, { ok: true });
});
rota('POST', '/api/projetos/([0-9a-f]+)/aplicar-modelo', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.'); const modelo = modeloPorId(String(b.modeloId)); if (!modelo) throw bad(404, 'Modelo não encontrado.');
  const inicio = b.inicio ? String(b.inicio) : S.hojeSP(); if (!S.isDate(inicio)) throw bad(400, 'Data de início inválida.'); const n = aplicarModelo(u, p, modelo, inicio); store.save(); send(res, 200, { ok: true, atividades: n });
});
};
