// ---------- segurança do cliente: senha forte, sessão de 40 min e troca de senha ----------
let AVISO_LOGIN = '';
const REGRAS_SENHA = [['8 ou mais caracteres', s => s.length >= 8], ['uma letra', s => /[A-Za-zÀ-ÿ]/.test(s)], ['um número', s => /\d/.test(s)], ['um caractere especial (ex.: ! @ # $ %)', s => /[^A-Za-zÀ-ÿ\d\s]/.test(s)]];
// Lista de requisitos que vai ficando verde enquanto a pessoa digita.
function dicaSenha(input) {
  const itens = REGRAS_SENHA.map(([t]) => h('li', {}, t)), ul = h('ul', { class: 'dica-senha', 'aria-live': 'polite' }, itens);
  const atualiza = () => REGRAS_SENHA.forEach(([, ok], i) => itens[i].classList.toggle('ok', ok(input.value)));
  input.addEventListener('input', atualiza); atualiza();
  return h('div', {}, h('p', { class: 'muted small', style: 'margin:6px 0 2px' }, 'Sua senha precisa ter:'), ul);
}
const verSenha = input => h('button', { type: 'button', class: 'ver-senha', 'aria-label': 'Mostrar ou ocultar a senha', onclick: ev => { const o = input.type === 'password'; input.type = o ? 'text' : 'password'; ev.currentTarget.textContent = o ? 'Ocultar' : 'Mostrar'; } }, 'Mostrar');

// Sessão do cliente: 40 minutos desde o login. Avisa 2 minutos antes e desconecta sozinho.
let _tAviso, _tFim, _tRelogio;
function pararSessao() { clearTimeout(_tAviso); clearTimeout(_tFim); clearInterval(_tRelogio); document.getElementById('aviso-sessao')?.remove(); }
function iniciarSessao() {
  pararSessao(); if (!U || U.tipo !== 'cliente' || !U.sessaoExpiraEm) return;
  const fim = U.sessaoExpiraEm, resta = () => fim - Date.now();
  _tFim = setTimeout(() => sessaoExpirada('Sua sessão terminou após 40 minutos por segurança. Entre novamente para continuar.'), Math.max(0, resta()));
  _tAviso = setTimeout(() => { const a = h('div', { id: 'aviso-sessao', class: 'aviso-sessao', role: 'alert' }, 'Sua sessão termina em 2 minutos por segurança. Salve o que estiver escrevendo.', h('button', { class: 'btn sm', onclick: () => a.remove() }, 'Entendi')); document.body.append(a); }, Math.max(0, resta() - 120e3));
  const tag = () => { const el = document.getElementById('sessao-restante'); if (el) el.textContent = `Sessão: ${Math.max(0, Math.ceil(resta() / 60e3))} min`; };
  _tRelogio = setInterval(tag, 20e3); tag();
}
function sessaoExpirada(msg) {
  if (!U) return; pararSessao(); U = null; AVISO_LOGIN = msg || 'Sua sessão terminou. Entre novamente.';
  document.querySelectorAll('.veu').forEach(v => v.remove()); fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' }).catch(() => {}); render();
}
const tagSessao = () => h('span', { id: 'sessao-restante', class: 'muted small', title: 'Por segurança a sessão dura 40 minutos' });

function modalTrocarSenha(obrigatoria) {
  const v = h('div', { class: 'veu centro' }); document.body.append(v); const atual = h('input', { type: 'password', autocomplete: 'current-password' }), nova = h('input', { type: 'password', autocomplete: 'new-password' }), err = h('div');
  juntar(v, h('form', { class: 'modal', style: 'max-width:460px', onsubmit: async ev => {
    ev.preventDefault(); err.replaceChildren(); const bt = ev.submitter; bt.disabled = true;
    try { await api('POST', '/api/eu/senha', { atual: atual.value, nova: nova.value }); v.remove(); toast('Senha alterada.'); await boot(); } catch (e) { err.append(h('div', { class: 'erro' }, e.message)); bt.disabled = false; }
  } }, h('h2', {}, obrigatoria ? 'Crie a sua nova senha' : 'Alterar senha'), obrigatoria && h('p', {}, 'Você entrou com uma senha provisória. Por segurança, escolha agora uma senha só sua.'),
    h('label', {}, obrigatoria ? 'Senha provisória (a que você recebeu)' : 'Senha atual'), atual, h('label', {}, 'Nova senha'), nova, h('div', { class: 'campo-senha' }, verSenha(nova)), dicaSenha(nova), err,
    h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn pri', type: 'submit' }, 'Salvar nova senha'), !obrigatoria && h('button', { class: 'btn', type: 'button', onclick: () => v.remove() }, 'Cancelar'), obrigatoria && h('button', { class: 'btn', type: 'button', onclick: async () => { await api('POST', '/api/auth/logout', {}); v.remove(); U = null; pararSessao(); render(); } }, 'Sair'))));
  atual.focus();
}
