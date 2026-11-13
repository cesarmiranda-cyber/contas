// ---------- shell ----------
let LEGAL = { versao: 0, precisaAceitar: false };
async function boot() { let me = {}; try { me = await api('GET', '/api/me'); U = me.usuario; } catch { U = null; } LEGAL = { versao: me.legalVersao || 0, precisaAceitar: !!me.precisaAceitar }; if (U && U.tipo === 'cliente' && view.nome === 'projetos') view = { nome: 'inicio' }; render(); iniciarSessao(); if (U && me.trocarSenha) modalTrocarSenha(true); else if (U && LEGAL.precisaAceitar) bloqueioAceite(); }
