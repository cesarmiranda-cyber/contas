'use strict';
// Registro de alterações: gera o "de → para" de cada mudança e decide o que o cliente pode ver.
const CAMPOS_TAREFA = { nome: 'Nome', inicio: 'Início', fim: 'Término', progresso: 'Andamento', responsavel: 'Responsável', descricao: 'Descrição', interna: 'Atividade interna', aguardaCliente: 'Aguardando o cliente', pedido: 'Pedido ao cliente', requerAprovacao: 'Requer aprovação do cliente', deps: 'Dependências' };
const CAMPOS_PROJETO = { nome: 'Nome', descricao: 'Objetivo e escopo', gerente: 'Gerente', codigo: 'Código', tipo: 'Tipo', prioridade: 'Prioridade', empresa: 'Empresa', contatoNome: 'Contato (nome)', contatoEmail: 'Contato (e-mail)', contatoTelefone: 'Contato (telefone)',
  inicioPrevisto: 'Início previsto', fimPrevisto: 'Término contratado', link: 'Pasta de documentos', situacao: 'Situação', valor: 'Valor do projeto', negocioBitrix: 'Negócio no Bitrix24', obsInternas: 'Observações internas', diasUteis: 'Contar só dias úteis', feriadosExtras: 'Feriados extras', clientes: 'Clientes com acesso' };
const INTERNOS_PROJETO = new Set(['valor', 'negocioBitrix', 'obsInternas', 'clientes']); // o cliente nunca vê
const TXT = { prioridade: { baixa: 'Baixa', media: 'Média', alta: 'Alta' }, situacao: { andamento: 'Em andamento', pausado: 'Pausado', concluido: 'Concluído' } };
const BOOL = new Set(['interna', 'aguardaCliente', 'diasUteis', 'requerAprovacao']);

const norm = (k, v) => BOOL.has(k) ? !!v : (v == null ? '' : v);
function fmtVal(k, v) {
  if (v === '' || v == null) return '—'; if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (k === 'progresso') return `${v}%`; if (k === 'valor') return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  if (TXT[k] && TXT[k][v]) return TXT[k][v]; const s = String(v); return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
const depsTexto = (deps, nomeDe) => (deps || []).map(d => `${nomeDe(d.de)} (${d.tipo === 'SS' ? 'começam juntas' : 'termina→começa'}${d.lag ? `, ${d.lag > 0 ? '+' : ''}${d.lag}d` : ''})`).join('; ');
function diff(antes, depois, campos, nomeDe = x => x, internos = new Set()) {
  const out = [];
  for (const [k, rot] of Object.entries(campos)) {
    let a = antes[k], b = depois[k];
    if (k === 'feriadosExtras') { a = (a || []).join(', '); b = (b || []).join(', '); }
    if (k === 'deps') { a = depsTexto(a, nomeDe); b = depsTexto(b, nomeDe); } else if (k === 'clientes') { a = (a || []).map(nomeDe).join(', '); b = (b || []).map(nomeDe).join(', '); }
    a = norm(k, a); b = norm(k, b); if (a === b) continue;
    out.push({ campo: rot, de: fmtVal(k, a), para: fmtVal(k, b), ...(internos.has(k) ? { interno: true } : {}) });
  }
  return out;
}

const ROTULO = { login: 'entrou no portal', login_falhou: 'errou a senha ao tentar entrar', cadastro: 'criou a conta', saiu: 'saiu do portal', abriu_projeto: 'abriu o projeto', abriu_atividade: 'abriu a atividade', abriu_suporte: 'abriu a aba Suporte', baixou_arquivo: 'baixou o arquivo',
  comentou: 'comentou na atividade', enviou_arquivo: 'enviou um documento na atividade', criou_projeto: 'criou o projeto', aplicou_modelo: 'aplicou o modelo', salvou_modelo: 'salvou um modelo de projeto', excluiu_modelo: 'excluiu um modelo de projeto', editou_projeto: 'alterou os dados do projeto', excluiu_projeto: 'excluiu o projeto', criou_tarefa: 'criou a atividade', editou_tarefa: 'alterou a atividade', excluiu_tarefa: 'removeu a atividade',
  reagendada_dependencia: 'teve as datas ajustadas por dependência', pediu_cliente: 'pediu uma informação ao cliente na atividade', ativou_cliente: 'ativou o acesso do cliente', alterou_acesso_cliente: 'alterou o acesso do cliente', bloqueou_cliente: 'bloqueou o cliente', reativou_cliente: 'reativou o cliente',
  solicitou: 'abriu o chamado', complementou_chamado: 'complementou o chamado', respondeu_chamado: 'respondeu o chamado', atualizou_solicitacao: 'atualizou o chamado', etapa_chamado: 'mudou a etapa do chamado', avaliou_atendimento: 'avaliou o atendimento', reenviou_chamado: 'reenviou o chamado ao Bitrix24', configurou_suporte: 'configurou a integração de suporte' };
const ACESSOS = new Set(['login', 'login_falhou', 'cadastro', 'saiu', 'abriu_projeto', 'abriu_atividade', 'abriu_suporte', 'baixou_arquivo']);
const COMUNICACAO = new Set(['comentou', 'enviou_arquivo', 'solicitou', 'complementou_chamado', 'respondeu_chamado', 'avaliou_atendimento', 'etapa_chamado', 'atualizou_solicitacao']);
const categoria = acao => ACESSOS.has(acao) ? 'acessos' : COMUNICACAO.has(acao) ? 'comunicacao' : 'alteracoes';
const VISIVEL_CLIENTE = new Set(['criou_projeto', 'editou_projeto', 'criou_tarefa', 'editou_tarefa', 'excluiu_tarefa', 'reagendada_dependencia', 'pediu_cliente', 'comentou', 'enviou_arquivo']);

const base = l => ({ id: l.id, ts: l.ts, quem: l.quem, tipo: l.tipo, acao: l.acao, rotulo: ROTULO[l.acao] || l.acao.replace(/_/g, ' '), categoria: categoria(l.acao), detalhe: l.detalhe, projetoId: l.projetoId, motivo: l.motivo || '', diff: l.diff || [] });
const paraEquipe = l => ({ ...base(l), uid: l.uid || null });
// O que o cliente pode ver: alterações de cronograma e dados públicos do projeto, sem atividades internas, valores ou observações internas.
function paraCliente(l) {
  if (!VISIVEL_CLIENTE.has(l.acao) || l.interna) return null; const e = base(l);
  e.diff = e.diff.filter(d => !d.interno && d.campo !== 'Atividade interna'); delete e.motivo;
  const virouVisivel = l.acao === 'editou_tarefa' && (l.diff || []).some(d => d.campo === 'Atividade interna' && d.para === 'Não');
  if (virouVisivel) return { ...e, acao: 'criou_tarefa', rotulo: ROTULO.criou_tarefa, diff: [{ campo: 'Início', de: '—', para: (l.snap || {}).inicio || '—' }, { campo: 'Término', de: '—', para: (l.snap || {}).fim || '—' }] };
  if (['editou_projeto', 'editou_tarefa', 'reagendada_dependencia'].includes(l.acao) && !e.diff.length) return null;
  return e;
}
const csvCel = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmula ao abrir no Excel
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function csv(entradas, nomeProjeto = () => '') {
  const linhas = [['Data/hora', 'Quem', 'Perfil', 'Ação', 'Projeto', 'Detalhe', 'Alterações'].join(';')];
  for (const e of entradas) linhas.push([new Date(e.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), e.quem, e.tipo, e.rotulo, nomeProjeto(e.projetoId), e.detalhe, e.diff.map(d => `${d.campo}: ${d.de} → ${d.para}`).join(' | ')].map(csvCel).join(';'));
  return '﻿' + linhas.join('\r\n') + '\r\n';
}
module.exports = { CAMPOS_TAREFA, CAMPOS_PROJETO, INTERNOS_PROJETO, diff, ROTULO, categoria, paraEquipe, paraCliente, csv };
