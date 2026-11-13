'use strict';
// Prazo de primeira resposta por prioridade (em horas corridas). Configurável por administradores.
const PADRAO = { urgente: 2, alta: 4, media: 8, baixa: 24 };
const config = db => { const c = (db.config && db.config.sla) || {}; const out = {}; for (const k of Object.keys(PADRAO)) out[k] = Number.isFinite(+c[k]) && +c[k] > 0 ? +c[k] : PADRAO[k]; return out; };
// estado: 'cumprido' | 'cumprido_atrasado' | 'encerrado' | 'ok' | 'vencendo' (menos de 25% do prazo) | 'estourado'
function calcular(s, cfg, agora = Date.now()) {
  const horas = cfg[s.prioridade] || cfg.media, prazo = new Date(Date.parse(s.criadoEm) + horas * 3600e3).toISOString();
  const primeira = (s.mensagens || []).find(m => m.tipoAutor === 'equipe' && !m.interna);
  if (primeira) return { horas, prazo, primeiraRespostaEm: primeira.ts, estado: Date.parse(primeira.ts) <= Date.parse(prazo) ? 'cumprido' : 'cumprido_atrasado' };
  if (['concluida', 'recusada'].includes(s.status)) return { horas, prazo, estado: 'encerrado' };
  const resta = Date.parse(prazo) - agora; return { horas, prazo, restanteMin: Math.round(resta / 60000), estado: resta < 0 ? 'estourado' : resta < horas * 3600e3 * 0.25 ? 'vencendo' : 'ok' };
}
module.exports = { PADRAO, config, calcular };
