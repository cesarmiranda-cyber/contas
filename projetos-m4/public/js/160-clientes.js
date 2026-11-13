// ---------- equipe: clientes e ativação ----------
const iniciais = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
function situacaoCliente(c) { return !c.ativo ? 'bloqueado' : c.projetoIds.length ? 'ativo' : 'aguardando'; }
async function telaClientes(m) {
  const [{ clientes }, { projetos }] = await Promise.all([api('GET', '/api/clientes'), api('GET', '/api/projetos')]);
  const n = { aguardando: 0, ativo: 0, bloqueado: 0 }; clientes.forEach(c => n[situacaoCliente(c)]++);
  if (!view.filtro) view.filtro = n.aguardando ? 'aguardando' : 'todos'; if (view.busca == null) view.busca = '';
  const lista = h('div'); const pinta = () => {
    const q = view.busca.trim().toLowerCase();
    const l = clientes.filter(c => (view.filtro === 'todos' || situacaoCliente(c) === view.filtro) && (!q || [c.nome, c.email, c.empresa, c.telefone, ...c.projetos].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => ({ aguardando: 0, ativo: 1, bloqueado: 2 }[situacaoCliente(a)] - { aguardando: 0, ativo: 1, bloqueado: 2 }[situacaoCliente(b)]) || b.criadoEm.localeCompare(a.criadoEm));
    lista.replaceChildren(l.length ? h('div', { class: 'card tabela' }, h('table', {}, h('thead', {}, h('tr', {}, ['Cliente', 'Empresa', 'Situação', 'Projetos', 'Cadastro · último acesso', ''].map(x => h('th', {}, x)))), h('tbody', {}, l.map(c => {
      const sit = situacaoCliente(c);
      return h('tr', {}, h('td', {}, h('div', { class: 'quem-cli' }, h('span', { class: 'avatar' }, iniciais(c.nome)), h('div', {}, h('b', {}, c.nome), h('div', { class: 'muted small' }, c.email), c.telefone && h('div', { class: 'muted small' }, c.telefone)))),
        h('td', {}, c.empresa || h('span', { class: 'muted' }, '—')), h('td', {}, sit === 'bloqueado' ? chip('vermelho', 'Bloqueado') : sit === 'ativo' ? chip('verde', 'Ativo') : chip('amarelo', 'Aguardando ativação')),
        h('td', {}, c.projetos.length ? c.projetos.map(p => h('div', { class: 'small' }, p)) : h('span', { class: 'muted' }, 'sem projeto'), c.chamados > 0 && h('div', { class: 'muted small' }, `${c.chamados} chamado(s)`)),
        h('td', { class: 'small' }, h('div', {}, 'Cadastro: ' + fmtTs(c.criadoEm)), c.aceite && h('div', { class: 'muted' }, `Termos v${c.aceite.versao} aceitos em ${fmtTs(c.aceite.ts).split(',')[0]}`), h('div', { class: 'muted' }, 'Acesso: ' + (c.ultimoAcesso ? fmtTs(c.ultimoAcesso) : 'nunca'))),
        h('td', { class: 'acoes-cli' }, c.anonimizado ? chip('amarelo', 'Anonimizado') : sit === 'bloqueado' ? h('button', { class: 'btn sm', onclick: () => api('PATCH', '/api/clientes/' + c.id, { ativo: true }).then(() => { toast('Cliente reativado.'); render(); }) }, 'Reativar')
          : [h('button', { class: 'btn sm' + (sit === 'aguardando' ? ' pri' : ''), onclick: () => modalAcesso(c, projetos) }, sit === 'aguardando' ? 'Ativar acesso' : 'Gerenciar projetos'),
            h('button', { class: 'btn sm perigo', onclick: () => confirm(`Bloquear ${c.nome}? Ele perde o acesso ao portal.`) && api('PATCH', '/api/clientes/' + c.id, { ativo: false }).then(() => { toast('Cliente bloqueado.'); render(); }) }, 'Bloquear'), U.admin && h('button', { class: 'btn sm perigo', title: 'LGPD: apaga os dados pessoais deste cliente', onclick: async () => { if (!confirm(`Anonimizar ${c.nome}? Isso apaga nome, e-mail, telefone e empresa, remove o acesso e não pode ser desfeito. Dados no CRM do Bitrix24 e conteúdos de arquivos precisam ser tratados à parte.`)) return; try { await api('POST', `/api/clientes/${c.id}/anonimizar`, { confirmar: true }); toast('Cliente anonimizado.'); render(); } catch (e) { toast(e.message, 6000); } } }, 'Anonimizar')]));
    })))) : h('div', { class: 'card vazio' }, clientes.length ? 'Nenhum cliente neste filtro.' : 'Nenhum cliente cadastrado ainda. Quando alguém criar conta no portal, aparece aqui.'));
  };
  const aba = (k, t, q) => h('button', { class: 'filtro' + (view.filtro === k ? ' on' : ''), onclick: ev => { view.filtro = k; ev.target.parentNode.querySelectorAll('.filtro').forEach(b => b.classList.toggle('on', b === ev.target)); pinta(); } }, `${t} `, h('span', { class: 'n' }, q));
  juntar(m, h('h1', {}, 'Clientes do portal'), h('p', { class: 'muted' }, 'Quem criou conta no portal. Para liberar o acesso, ative o cliente em um ou mais projetos.'),
    n.aguardando > 0 && h('div', { class: 'aviso' }, h('b', {}, `${n.aguardando} cliente(s) aguardando ativação. `), 'Eles já criaram a conta e estão esperando você vincular um projeto.'),
    h('div', { class: 'toolbar' }, h('div', { class: 'filtros' }, aba('aguardando', 'Aguardando ativação', n.aguardando), aba('ativo', 'Ativos', n.ativo), aba('bloqueado', 'Bloqueados', n.bloqueado), aba('todos', 'Todos', clientes.length)),
      h('input', { class: 'busca', type: 'search', placeholder: 'Buscar por nome, e-mail, empresa ou projeto', value: view.busca, oninput: e => { view.busca = e.target.value; pinta(); } })), lista); pinta();
}
function modalAcesso(c, projetos) {
  const v = overlay(true), err = h('div'); const sel = new Set(c.projetoIds); const ativar = c.projetoIds.length === 0;
  const pre = { empresa: c.empresa, contatoNome: c.nome, contatoEmail: c.email, contatoTelefone: c.telefone, clientes: [{ id: c.id }] };
  const caixa = h('div', { class: 'lista-proj' }, projetos.length ? projetos.map(p => h('label', { class: 'item-proj' }, h('input', { type: 'checkbox', checked: sel.has(p.id), onchange: e => e.target.checked ? sel.add(p.id) : sel.delete(p.id) }),
    h('span', {}, h('b', {}, p.nome), h('span', { class: 'muted small' }, ` ${[p.codigo, p.empresa].filter(Boolean).join(' · ')}`)))) : h('p', { class: 'muted' }, 'Ainda não há projetos. Crie o primeiro para este cliente.'));
  juntar(v, h('div', { class: 'modal' }, h('h2', {}, ativar ? 'Ativar acesso' : 'Projetos do cliente'), h('div', { class: 'quem-cli', style: 'margin:8px 0 4px' }, h('span', { class: 'avatar' }, iniciais(c.nome)), h('div', {}, h('b', {}, c.nome), h('div', { class: 'muted small' }, [c.empresa, c.email].filter(Boolean).join(' · ')))),
    h('label', {}, ativar ? 'Em quais projetos este cliente pode entrar?' : 'Projetos que este cliente pode acompanhar'), caixa,
    h('button', { class: 'btn sm', style: 'margin-top:10px', onclick: () => { v.remove(); modalProjeto(null, pre); } }, '+ Criar novo projeto para este cliente'), err,
    h('div', { class: 'row', style: 'margin-top:18px' }, h('button', { class: 'btn pri', onclick: async ev => { ev.target.disabled = true; try {
      if (ativar && sel.size === 0) throw new Error('Marque ao menos um projeto para ativar o acesso.');
      const r = await api('POST', `/api/clientes/${c.id}/projetos`, { projetos: [...sel] }); v.remove(); toast(r.projetos ? `Acesso ativado: ${c.nome} vê ${r.projetos} projeto(s).` : `${c.nome} ficou sem projetos (aguardando ativação).`); render();
    } catch (e) { err.replaceChildren(h('div', { class: 'erro' }, e.message)); ev.target.disabled = false; } } }, ativar ? 'Ativar acesso' : 'Salvar'), h('button', { class: 'btn', onclick: () => v.remove() }, 'Cancelar'))));
}

