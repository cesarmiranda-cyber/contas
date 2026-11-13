'use strict';
// Relatório semanal do projeto.
module.exports = ctx => {
  const { Relat, S, bad, db, exigir, gerarRelatorio, guardarRelatorio, hoje, http, podeVer, projetoDe, reg, rota, semanaValida, send } = ctx;
rota('GET', '/api/projetos/([0-9a-f]+)/relatorios', async (req, res, m, _b, u) => {
  exigir(u); const p = projetoDe(m[1]); if (!p || !podeVer(u, p)) throw bad(404, 'Projeto não encontrado.'); const atual = Relat.segundaDe(hoje(), S); const semanas = [];
  for (let i = 0; i < 12; i++) { const seg = S.addDays(atual, -7 * i), r = (db.relatorios || []).find(x => x.projetoId === p.id && x.semana === seg); semanas.push({ semana: seg, de: seg, ate: S.addDays(seg, 6), atual: i === 0, guardado: !!r, geradoEm: r ? r.geradoEm : null }); }
  send(res, 200, { semanas });
});
rota('GET', '/api/projetos/([0-9a-f]+)/relatorio', async (req, res, m, _b, u) => {
  exigir(u); const p = projetoDe(m[1]); if (!p || !podeVer(u, p)) throw bad(404, 'Projeto não encontrado.'); const q = new URL(req.url, 'http://x').searchParams; const semana = semanaValida(q.get('semana'), hoje());
  const visao = u.tipo === 'equipe' && q.get('visao') !== 'cliente' ? 'equipe' : 'cliente'; const guardado = (db.relatorios || []).find(r => r.projetoId === p.id && r.semana === semana);
  send(res, 200, { relatorio: guardado ? guardado[visao] : gerarRelatorio(p, semana, visao), guardado: !!guardado, geradoEm: guardado ? guardado.geradoEm : null });
});
rota('POST', '/api/projetos/([0-9a-f]+)/relatorios/gerar', async (req, res, m, b, u) => {
  exigir(u, 'equipe'); const p = projetoDe(m[1]); if (!p) throw bad(404, 'Projeto não encontrado.'); const semana = semanaValida(b.semana, hoje()); const r = guardarRelatorio(p, semana); reg(u, 'gerou_relatorio', `semana de ${semana}`, p.id); send(res, 201, { relatorio: r.equipe, geradoEm: r.geradoEm });
});
};
