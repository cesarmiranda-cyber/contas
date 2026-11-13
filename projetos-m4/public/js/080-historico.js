// ---------- histórico / log de alterações ----------
const fv = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmt(v) : v;
const fmtDia = s => { const x = new Date(s).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }); return x.charAt(0).toUpperCase() + x.slice(1); };
async function desfazerLog(e) {
  if (!confirm('Desfazer esta alteração? Os valores voltam ao que eram antes dela.')) return;
  try { const r = await api('POST', `/api/logs/${e.id}/desfazer`, {}); avisaAjustes(r.ajustes); toast('Alteração desfeita. Ela fica registrada no histórico.'); render(); }
  catch (er) {
    if (er.dados && er.dados.codigo === 'ALTERADO_DEPOIS') { if (!confirm(`${er.dados.campos.join(', ')} foi alterado depois desta mudança. Desfazer mesmo assim? Os valores voltarão ao que eram antes dela.`)) return; try { const r = await api('POST', `/api/logs/${e.id}/desfazer`, { forcar: true }); avisaAjustes(r.ajustes); toast('Alteração desfeita.'); render(); } catch (e2) { toast(e2.message, 6000); } }
    else toast(er.message, 6000);
  }
}
function entradaLog(e, comProjeto) {
  return h('div', { class: 'log-item ' + e.categoria }, h('i', { class: 'log-ponto', title: e.categoria === 'acessos' ? 'Acesso' : e.categoria === 'comunicacao' ? 'Comunicação' : 'Alteração' }),
    h('div', { class: 'grow' }, h('div', {}, h('b', {}, e.quem), ' ', h('span', { class: 'chip-mini ' + e.tipo }, e.tipo === 'equipe' ? 'Equipe' : 'Cliente'), ` ${e.rotulo}`, e.detalhe && [' ', h('b', {}, `“${e.detalhe}”`)], comProjeto && e.projeto && h('span', { class: 'muted' }, ` · ${e.projeto}`)),
      e.motivo && h('div', { class: 'muted small' }, e.motivo),
      e.diff && e.diff.length > 0 && h('ul', { class: 'diff' }, e.diff.map(d => h('li', {}, h('span', { class: 'muted' }, d.campo + ': '), h('s', {}, fv(d.de)), ' → ', h('b', {}, fv(d.para)), d.interno && h('span', { class: 'muted small' }, ' (interno)'))))),
    h('div', { class: 'log-dir' }, h('div', { class: 'muted small log-hora' }, fmtTs(e.ts)), U.tipo === 'equipe' && e.podeDesfazer && h('button', { class: 'btn sm', title: 'Volta aos valores de antes desta alteração', onclick: () => desfazerLog(e) }, 'Desfazer'), e.desfeito && h('span', { class: 'chip-mini', title: 'Desfeita por ' + e.desfeitoPor }, 'Desfeita')));
}
function listaLog(itens, comProjeto) {
  if (!itens.length) return h('div', { class: 'vazio' }, 'Nada registrado neste filtro.'); const out = []; let dia = '';
  for (const e of itens) { const d = e.ts.slice(0, 10); if (d !== dia) { dia = d; out.push(h('h3', { class: 'log-dia' }, fmtDia(e.ts))); } out.push(entradaLog(e, comProjeto)); } return h('div', {}, out);
}
async function historicoProjeto(p) {
  const eq = U.tipo === 'equipe'; const caixa = h('div', { class: 'card' }); let cat = view.cat || '';
  const carrega = async () => { caixa.replaceChildren(h('div', { class: 'vazio' }, 'Carregando…')); try { const r = await api('GET', `/api/projetos/${p.id}/historico?limite=300${cat ? '&cat=' + cat : ''}`); caixa.replaceChildren(listaLog(r.itens, false)); } catch (e) { caixa.replaceChildren(h('div', { class: 'erro' }, e.message)); } };
  const sel = eq && h('select', { style: 'width:auto', onchange: e => { cat = view.cat = e.target.value; carrega(); } }, [['', 'Tudo'], ['alteracoes', 'Alterações'], ['acessos', 'Acessos do cliente'], ['comunicacao', 'Comunicação']].map(([k, t]) => h('option', { value: k, selected: k === cat }, t)));
  carrega();
  return h('div', {}, h('div', { class: 'row', style: 'margin:4px 0 12px' }, h('p', { class: 'muted grow', style: 'margin:0' }, eq ? 'Tudo o que foi alterado, aberto e enviado neste projeto: quem, quando e de qual valor para qual.' : 'O que mudou no seu projeto e o que foi enviado, para todo mundo estar na mesma página. Registramos acessos e alterações por segurança e transparência.'),
    sel, eq && h('button', { class: 'btn sm', onclick: () => go({ nome: 'acessos', projeto: p.id }) }, 'Ver no log completo')), caixa);
}

