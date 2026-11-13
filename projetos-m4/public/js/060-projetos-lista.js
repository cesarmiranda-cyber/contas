// ---------- projetos ----------
const primeiroNome = n => String(n || '').trim().split(/\s+/)[0] || '';
function espera(m) {
  const ico = document.createElementNS(NS_SVG, 'svg'); ico.setAttribute('viewBox', '0 0 24 24'); ico.setAttribute('aria-hidden', 'true');
  ico.innerHTML = '<path d="M6 2h12M6 22h12M7 2v4.5L12 12l5-5.5V2M7 22v-4.5L12 12l5 5.5V22" fill="none" stroke="#a37800" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  const passo = (cls, n, t, st) => h('li', { class: cls }, h('span', { class: 'n' }, cls === 'feito' ? '✓' : n), h('b', {}, t), h('span', { class: 's' }, st));
  juntar(m, h('div', { class: 'card espera', role: 'status' }, h('div', { class: 'ico' }, ico), h('span', { class: 'chip amarelo pulso' }, 'Aguardando ativação'),
    h('h2', {}, 'Sua conta foi criada. Estamos ativando o seu acesso.'),
    h('p', {}, `Olá, ${primeiroNome(U.nome)}! A equipe Manda4 vai vincular você ao seu projeto. Assim que for ativado, o cronograma e o status aparecem aqui. Você não precisa fazer nada.`),
    h('ol', { class: 'passos' }, passo('feito', 1, 'Conta criada', 'Concluído'), passo('agora', 2, 'Manda4 vincula seu projeto', 'Em andamento'), passo('', 3, 'Acompanhe e envie documentos', 'Em breve')),
    h('div', { class: 'acoes' }, h('button', { class: 'btn pri', onclick: novaSolic }, 'Abrir chamado de suporte'), h('button', { class: 'btn', onclick: render }, 'Atualizar'), h('a', { class: 'btn', href: 'https://manda4.com.br/', target: '_blank', rel: 'noopener noreferrer' }, 'Conhecer a Manda4')),
    h('p', { class: 'muted small', style: 'margin-top:18px' }, `Conta: ${U.email}`)));
}
const saudacao = () => { const hr = +new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(new Date()); return hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite'; };
const rel = ts => { const d = (Date.now() - Date.parse(ts)) / 1000; if (d < 60) return 'agora'; if (d < 3600) return `há ${Math.floor(d / 60)} min`; if (d < 86400) return `há ${Math.floor(d / 3600)} h`; if (d < 7 * 86400) return `há ${Math.floor(d / 86400)} dia(s)`; return fmtTs(ts).split(',')[0]; };
const ICONES = { projetos: '<rect x="3" y="5" width="9" height="3.2" rx="1.6"/><rect x="8" y="10.4" width="12" height="3.2" rx="1.6"/><rect x="5" y="15.8" width="8" height="3.2" rx="1.6"/>', suporte: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.9 5.9l3.7 3.7M14.4 14.4l3.7 3.7M18.1 5.9l-3.7 3.7M9.6 14.4l-3.7 3.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  doc: '<path d="M7 3h7l4 4v14H7z M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' };
const icone = n => { const s = document.createElementNS(NS_SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('fill', 'currentColor'); s.innerHTML = ICONES[n]; return s; };
const anel = pct => { const s = document.createElementNS(NS_SVG, 'svg'); s.setAttribute('viewBox', '0 0 80 80'); s.setAttribute('class', 'anel'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', `${pct}% concluído`); const c = 2 * Math.PI * 34;
  s.innerHTML = `<circle cx="40" cy="40" r="34" fill="none" stroke="var(--linha)" stroke-width="8"/><circle cx="40" cy="40" r="34" fill="none" stroke="var(--destaque)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="46" text-anchor="middle" font-size="19" font-weight="800" fill="currentColor">${pct}%</text>`; return s; };
const contaChips = r => [r.verde > 0 && chip('verde', `${r.verde} no prazo`), r.amarelo > 0 && chip('amarelo', `${r.amarelo} em alerta`), r.vermelho > 0 && chip('vermelho', `${r.vermelho} atrasado(s)`)];

