// ---------- LGPD: termos, privacidade, aceite e meus dados ----------
async function modalLegal(tipo) {
  const v = overlay(true); const l = await api('GET', '/api/legal'); const texto = tipo === 'termos' ? l.termos : l.privacidade;
  juntar(v, h('div', { class: 'modal' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, tipo === 'termos' ? 'Termos de uso' : 'Política de privacidade'), h('button', { class: 'btn sm', onclick: () => v.remove() }, 'Fechar')), l.publicadoEm && h('p', { class: 'muted small' }, `Versão ${l.versao} · publicada em ${fmtTs(l.publicadoEm)}`), h('div', { class: 'legal-texto' }, texto || 'Em elaboração.')));
}
const linksLegais = () => LEGAL.versao > 0 ? [h('a', { class: 'link-legal', onclick: () => modalLegal('termos') }, 'Termos de uso'), ' · ', h('a', { class: 'link-legal', onclick: () => modalLegal('privacidade') }, 'Política de privacidade')] : [];
function bloqueioAceite() {
  const v = h('div', { class: 'veu centro' }); document.body.append(v); const chk = h('input', { type: 'checkbox', style: 'width:auto' }), err = h('div');
  juntar(v, h('div', { class: 'modal', style: 'max-width:520px' }, h('h2', {}, 'Atualizamos nossos termos'), h('p', {}, 'Para continuar usando o portal, leia e aceite os Termos de uso e a Política de privacidade.'), h('p', {}, ...linksLegais()),
    h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:500;color:var(--tinta)' }, chk, 'Li e aceito os Termos de uso e a Política de privacidade'), err,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn pri', onclick: async ev => { if (!chk.checked) return err.replaceChildren(h('div', { class: 'erro' }, 'Marque a caixa para continuar.')); ev.target.disabled = true; try { await api('POST', '/api/eu/aceite', { versao: LEGAL.versao }); v.remove(); LEGAL.precisaAceitar = false; toast('Obrigado! Aceite registrado.'); } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); ev.target.disabled = false; } } }, 'Aceitar e continuar'),
      h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/auth/logout', {}); v.remove(); U = null; render(); } }, 'Sair'))));
}
function modalMeusDados() {
  const v = overlay(true);
  juntar(v, h('div', { class: 'modal', style: 'max-width:560px' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Meus dados'), h('button', { class: 'btn sm', onclick: () => v.remove() }, 'Fechar')),
    h('p', {}, 'Você pode ver e levar uma cópia dos seus dados, e pedir a exclusão deles, a qualquer momento.'),
    h('p', { class: 'muted small' }, 'Guardamos: seus dados de cadastro, os projetos a que você tem acesso, as mensagens, documentos e chamados que você enviou, as suas avaliações e o registro dos seus acessos e ações no portal.'),
    h('div', { class: 'opcoes' },
      h('button', { class: 'opcao', onclick: async ev => { const bt = ev.currentTarget; bt.disabled = true; try { const r = await fetch('/api/eu/dados', { credentials: 'same-origin' }); if (!r.ok) throw new Error('Não foi possível gerar o arquivo.'); const u = URL.createObjectURL(await r.blob()); const a = h('a', { href: u, download: 'meus-dados-manda4.json' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); toast('Arquivo com os seus dados baixado.'); } catch (e) { toast(e.message); } bt.disabled = false; } }, h('b', {}, 'Baixar meus dados'), h('span', { class: 'small' }, 'Um arquivo (JSON) com tudo o que guardamos sobre você.')),
      SUPORTE ? h('button', { class: 'opcao', onclick: () => { v.remove(); novaSolic({ categoria: 'privacidade', assunto: 'Solicitação de exclusão de dados (LGPD)', texto: 'Solicito a exclusão (anonimização) dos meus dados pessoais, conforme a LGPD. Entendo que registros do projeto necessários ao contrato podem ser mantidos sem me identificar.' }); } }, h('b', {}, 'Solicitar a exclusão dos meus dados'), h('span', { class: 'small' }, 'Abre um chamado para a equipe, que confirma e executa o pedido.')) : h('p', { class: 'muted small' }, 'Para pedir a exclusão dos seus dados, fale com a equipe Manda4 (o contato está no seu contrato ou no site manda4.com.br).'),
      LEGAL.versao > 0 && h('div', { class: 'small muted' }, ...linksLegais()))));
}
// ---------- Fim LGPD ----------
function render() {
  $app.replaceChildren(); $tip.hidden = true;
  if (!U) return $app.append(telaLogin());
  const eq = U.tipo === 'equipe';
  const nav = [...(eq ? [['fila', 'Minha fila']] : [['inicio', 'Início']]), ['projetos', 'Projetos'], ...(SUPORTE ? [['solicitacoes', 'Suporte'], ['ajuda', 'Ajuda']] : []), ...(eq ? [['clientes', 'Clientes'], ['acessos', 'Acessos e log'], ...(U.admin ? [['integracao', 'Integração']] : [])] : [])];
  const top = h('header', { class: 'top' }, h('div', { class: 'logo clicavel', role: 'link', tabindex: 0, 'aria-label': 'Manda4 · Projetos e Suporte (início)', onclick: () => go({ nome: eq ? 'projetos' : 'inicio' }) }, LOGO(), NOME, h('span', { class: 'logo-sub' }, SUPORTE ? 'Projetos e Suporte' : 'Projetos')),
    h('nav', {}, nav.map(([k, t]) => h('a', { 'data-k': k, class: view.nome === k || (k === 'projetos' && view.nome === 'projeto') ? 'on' : '', onclick: () => go({ nome: k }) }, t))),
    h('span', { class: 'muted small' }, `${U.nome}${eq ? ' · equipe' : ''}`),
    !eq && tagSessao(), !eq && sino(), !eq && h('button', { class: 'btn sm', onclick: async () => { await api('POST', '/api/auth/logout', {}); pararSessao(); U = null; render(); } }, 'Sair'));
  if (eq) api('GET', '/api/fila').then(f => { const a = top.querySelector('nav a[data-k=fila]'); if (a && f.total) a.append(h('span', { class: 'n' }, f.total)); }).catch(() => {});
  const main = h('main', { class: 'wrap' }); $app.append(top, main, h('footer', { class: 'rodape' }, `Projetos M4 · ${eq ? 'visão da equipe' : 'área do cliente'} · versão ${VERSAO || '—'}`, !eq && [' · ', ...linksLegais(), LEGAL.versao > 0 && ' · ', h('a', { class: 'link-legal', onclick: () => modalMeusDados() }, 'Meus dados'), ' · ', h('a', { class: 'link-legal', onclick: () => modalTrocarSenha(false) }, 'Alterar senha')]));
  ({ fila: telaFila, inicio: telaInicio, projetos: telaProjetos, projeto: telaProjeto, solicitacoes: telaSolic, ajuda: telaAjuda, clientes: telaClientes, acessos: telaLog, integracao: telaIntegracao }[view.nome])(main).catch(e => main.append(h('div', { class: 'erro' }, e.message)));
}

