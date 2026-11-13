// ---------- login / cadastro ----------
function telaLogin(modo = 'login') {
  const err = h('div'), campos = {}; if (AVISO_LOGIN) { err.append(h('div', { class: 'aviso-login', role: 'status' }, AVISO_LOGIN)); AVISO_LOGIN = ''; }
  const f = (k, rot, tipo = 'text', ac) => { campos[k] = h('input', { type: tipo, autocomplete: ac, required: true }); return [h('label', {}, rot), campos[k]]; };
  const cad = modo === 'cadastro';
  const box = h('form', { class: 'cartao', onsubmit: async ev => {
    ev.preventDefault(); err.replaceChildren(); const bt = ev.submitter; bt.disabled = true;
    try { const corpo = Object.fromEntries(Object.entries(campos).filter(([k]) => k !== '__aceite').map(([k, v]) => [k, v.value])); if (cad && campos.__aceite) corpo.aceite = campos.__aceite.checked; await api('POST', cad ? '/api/auth/cadastro' : '/api/auth/login', corpo); await boot(); } catch (e) { err.append(h('div', { class: 'erro' }, e.message)); bt.disabled = false; }
  } }, h('h2', {}, cad ? 'Criar sua conta de cliente' : 'Entrar na área do cliente'), h('p', { class: 'muted small' }, cad ? 'Use o e-mail que a equipe Manda4 tem no seu cadastro. Leva menos de um minuto.' : 'Projetos, documentos e suporte em um só lugar.'),
    cad && f('nome', 'Nome completo', 'text', 'name'), cad && h('div', {}, h('label', {}, 'Empresa'), (campos.empresa = h('input', { autocomplete: 'organization' }))), cad && h('div', {}, h('label', {}, 'Telefone / WhatsApp (opcional)'), (campos.telefone = h('input', { type: 'tel', autocomplete: 'tel' }))),
    f('email', 'E-mail profissional', 'email', 'email'), f('senha', cad ? 'Crie uma senha' : 'Senha', 'password', cad ? 'new-password' : 'current-password'), cad && h('div', { class: 'campo-senha' }, verSenha(campos.senha)), cad && dicaSenha(campos.senha),
    cad && LEGAL.versao > 0 && h('label', { class: 'aceite' }, (campos.__aceite = h('input', { type: 'checkbox', style: 'width:auto' })), h('span', {}, 'Li e aceito os ', h('a', { class: 'link-legal', onclick: () => modalLegal('termos') }, 'Termos de uso'), ' e a ', h('a', { class: 'link-legal', onclick: () => modalLegal('privacidade') }, 'Política de privacidade'), '.')),
    err, h('button', { class: 'btn pri', type: 'submit' }, cad ? 'Criar conta' : 'Entrar'),
    h('p', { class: 'troca muted small' }, cad ? 'Já tem conta? ' : 'Ainda não tem conta? ', h('a', { tabindex: 0, onclick: () => $app.replaceChildren(telaLogin(cad ? 'login' : 'cadastro')) }, cad ? 'Entrar' : 'Criar conta')),
    h('p', { class: 'nota muted small' }, 'Equipe Manda4? Abra o app "Projetos M4" dentro do Bitrix24.'), LEGAL.versao > 0 && h('p', { class: 'nota small' }, ...linksLegais()), h('p', { class: 'nota small' }, h('a', { class: 'site', href: 'https://manda4.com.br/', target: '_blank', rel: 'noopener noreferrer' }, '← Voltar ao site manda4.com.br')));
  const selo = (cls, txt) => h('span', { class: 'selo ' + cls }, txt);
  return h('div', { class: 'login' },
    h('header', { class: 'lt' }, h('div', { class: 'logo', role: 'img', 'aria-label': 'Manda4' }, LOGO(), NOME), h('a', { class: 'btn sm', href: 'https://manda4.com.br/', target: '_blank', rel: 'noopener noreferrer' }, 'Ir para o site manda4.com.br')),
    h('main', { class: 'cena' },
      h('div', { class: 'esq' }, h('div', { class: 'selos' }, selo('or', 'Parceiro Gold Bitrix24'), selo('az', 'Centro de Treinamento Autorizado')),
        h('h1', { class: 'tit' }, h('em', {}, 'Projetos e Suporte'), ': acompanhe o seu Bitrix24 com quem implantou'),
        h('p', { class: 'sub' }, 'Veja o andamento do seu projeto, envie documentos e fale com a equipe Manda4. Implantamos no seu processo e seguimos ao lado, com suporte que responde.'),
        h('ul', { class: 'bene' }, ['Projetos: cronograma e status de cada atividade (no prazo, alerta ou atrasado)', 'Envie documentos e informações direto na atividade', 'Suporte: abra chamados e acompanhe as respostas'].map(t => h('li', {}, t)))),
      box));
}

