'use strict';

// Demonstrativo de pagamento (consolidado) e extrato do parceiro: HTML (e-mail), texto puro e CSV. Funções puras.
// Todo texto dinâmico é escapado (nomes de clientes/parceiros vêm do Bitrix e não são de confiança).
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = n => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
const num = n => Number(n || 0).toFixed(2).replace('.', ',');
const dbr = d => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
const csvq = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const ESTADO = { aguardando: 'Aguardando recebimento', aberto: 'A pagar', proximo: 'Vence em breve', atrasado: 'Atrasado', pago: 'Pago', cancelado: 'Cancelado', consolidado: 'Em consolidado' };
const valorDe = i => (i.estado === 'pago' ? (i.valorPago || i.valor) : i.valor);

// opts: { empresa, beneficiario, tipo: 'consolidado'|'extrato', ref, venc, forma, itens, mensagem, periodo, totais, emissao }
function renderDemonstrativo(o) {
  const ext = o.tipo === 'extrato';
  const itens = o.itens || [];
  const total = Math.round(itens.reduce((a, i) => a + (ext ? valorDe(i) : i.valor), 0) * 100) / 100;
  const titulo = ext ? 'Extrato de pagamentos' : 'Demonstrativo de pagamento';
  const assunto = `${titulo} · ${o.empresa} · ${o.beneficiario}${o.ref ? ` · #${o.ref}` : ''} · ${dbr(o.emissao)}`;
  const cols = ext
    ? ['Vencimento', 'Descrição', 'Cliente / cobrança de origem', 'Regra', 'Situação', 'Valor']
    : ['Descrição', 'Cliente / cobrança de origem', 'Regra (base)', 'Venc. original', 'Valor'];
  const orig = i => [i.cliente, i.cobranca ? `cobrança #${i.cobranca}` : ''].filter(Boolean).join(' · ') || '—';
  const regra = i => [i.regra, i.base ? `base ${brl(i.base)}` : ''].filter(Boolean).join(' · ') || '—';
  const linhas = itens.map(i => (ext
    ? [dbr(i.venc), i.titulo, orig(i), regra(i), (ESTADO[i.estado] || i.estado) + (i.estado === 'pago' && i.pagoEm ? ` em ${dbr(i.pagoEm)}` : ''), brl(valorDe(i))]
    : [i.titulo, orig(i), regra(i), dbr(i.venc), brl(i.valor)]));

  // ---- HTML (CSS inline: clientes de e-mail ignoram <style>) ----
  const th = 'padding:8px 10px;text-align:left;font-size:12px;color:#667085;border-bottom:2px solid #e4e7ec;white-space:nowrap';
  const td = 'padding:9px 10px;border-bottom:1px solid #eef0f3;font-size:13px;color:#1b2430;vertical-align:top';
  const resumo = ext
    ? [['Beneficiário', o.beneficiario], ['Período', o.periodo || 'todo o histórico'], ['Lançamentos', String(itens.length)], ['Total', brl(total)]]
    : [['Beneficiário', o.beneficiario], ['Referência', `#${o.ref}`], ['Vencimento do pagamento', dbr(o.venc)], ['Forma', o.forma || 'a definir'], ['Títulos incluídos', String(itens.length)], ['Total a pagar', brl(total)]];
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f9;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:760px;margin:0 auto;padding:24px 14px">
<div style="background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;padding:22px">
<div style="font-size:12px;color:#667085;letter-spacing:.05em;text-transform:uppercase">${esc(o.empresa)}</div>
<h1 style="margin:4px 0 14px;font-size:20px;color:#1b2430">${esc(titulo)}</h1>
<table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:16px">${resumo.map(([k, v], x) => (x % 2 === 0 ? '<tr>' : '') + `<td style="padding:6px 0;width:50%;vertical-align:top"><div style="font-size:11px;color:#667085">${esc(k)}</div><div style="font-size:${k.startsWith('Total') ? '18' : '14'}px;font-weight:700;color:#1b2430">${esc(v)}</div></td>` + (x % 2 === 1 || x === resumo.length - 1 ? '</tr>' : '')).join('')}</table>
${o.mensagem ? `<div style="background:#eef2ff;border-radius:8px;padding:11px 13px;margin-bottom:16px;font-size:13px;color:#1b2430;white-space:pre-wrap">${esc(o.mensagem)}</div>` : ''}
<table style="width:100%;border-collapse:collapse"><thead><tr>${cols.map((c, k) => `<th style="${th}${k === cols.length - 1 ? ';text-align:right' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${linhas.map(l => `<tr>${l.map((c, k) => `<td style="${td}${k === l.length - 1 ? ';text-align:right;white-space:nowrap;font-weight:700' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}
<tr><td colspan="${cols.length - 1}" style="padding:11px 10px;font-size:13px;font-weight:700;text-align:right">Total</td><td style="padding:11px 10px;font-size:15px;font-weight:700;text-align:right;white-space:nowrap">${esc(brl(total))}</td></tr></tbody></table>
<p style="margin:18px 0 0;font-size:11px;color:#98a2b3">Gerado em ${esc(dbr(o.emissao))}. O detalhe completo segue em anexo (CSV). Em caso de dúvida, responda este e-mail.</p>
</div></div></body></html>`;

  // ---- texto puro ----
  const texto = [titulo.toUpperCase(), o.empresa, '', ...resumo.map(([k, v]) => `${k}: ${v}`), '',
    ...(o.mensagem ? [o.mensagem, ''] : []), 'DETALHE', ...linhas.map((l, n) => `${n + 1}. ${l.join(' | ')}`), '', `TOTAL: ${brl(total)}`, '', `Gerado em ${dbr(o.emissao)}.`].join('\n');

  // ---- CSV (Excel pt-BR: ; e vírgula decimal, com BOM) ----
  const head = ext
    ? ['Vencimento', 'Descrição', 'Cliente', 'Cobrança de origem', 'Regra', 'Base de cálculo', 'Situação', 'Pago em', 'Valor']
    : ['Descrição', 'Cliente', 'Cobrança de origem', 'Regra', 'Base de cálculo', 'Vencimento original', 'Valor'];
  const rows = itens.map(i => (ext
    ? [dbr(i.venc), i.titulo, i.cliente, i.cobranca || '', i.regra, i.base ? num(i.base) : '', ESTADO[i.estado] || i.estado, dbr(i.pagoEm), num(valorDe(i))]
    : [i.titulo, i.cliente, i.cobranca || '', i.regra, i.base ? num(i.base) : '', dbr(i.venc), num(i.valor)]));
  rows.push(head.map((_, k) => (k === head.length - 2 ? 'TOTAL' : k === head.length - 1 ? num(total) : '')));
  const csv = '﻿' + [head, ...rows].map(r => r.map(csvq).join(';')).join('\r\n') + '\r\n';
  const nomeArq = `${ext ? 'extrato' : 'demonstrativo'}-${String(o.beneficiario).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40)}${o.ref ? '-' + o.ref : ''}.csv`;
  return { assunto, texto, html, csv, arquivo: nomeArq, total };
}
module.exports = { renderDemonstrativo, esc };
