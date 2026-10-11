'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/rules');

test('valida CPF/CNPJ', () => {
  assert.ok(R.validCPF('529.982.247-25'));
  assert.ok(!R.validCPF('111.111.111-11'));
  assert.ok(R.validCNPJ('11.222.333/0001-81'));
  assert.ok(!R.validCNPJ('11.222.333/0001-82'));
});
test('status Asaas -> situação e etapa', () => {
  assert.equal(R.mapAsaasStatus('RECEIVED'), 'paid');
  assert.equal(R.mapAsaasStatus('CONFIRMED'), 'paid');
  assert.equal(R.mapAsaasStatus('OVERDUE'), 'overdue');
  assert.equal(R.mapAsaasStatus('DELETED'), 'cancelled');
  assert.equal(R.mapAsaasStatus('PENDING'), 'open');
  assert.equal(R.stageFor('open', '2026-10-20', '2026-10-11'), R.STAGES.open);
  assert.equal(R.stageFor('open', '2026-10-13', '2026-10-11'), R.STAGES.soon);
  assert.equal(R.stageFor('open', '2026-10-10', '2026-10-11'), R.STAGES.late);
  assert.equal(R.stageFor('paid', '2026-10-10', '2026-10-11'), R.STAGES.paid);
});
test('parcelas somam o total e respeitam fim de mês', () => {
  const s = R.buildSchedule({ total: 100, parcelas: 3, primeiroVenc: '2026-01-31' });
  assert.equal(s.reduce((a, p) => a + Math.round(p.value * 100), 0), 10000);
  assert.deepEqual(s.map(p => p.due), ['2026-01-31', '2026-02-28', '2026-03-31']);
  const r = R.buildSchedule({ total: 250, tipo: 'RECORRENTE', mensal: 12, primeiroVenc: '2026-11-05' });
  assert.equal(r.length, 12); assert.equal(r[11].due, '2027-10-05'); assert.equal(r[0].value, 250);
});
test('régua dispara uma vez e só no offset recente', () => {
  const off = [-3, 0, 1, 5, 15];
  assert.equal(R.reminderDue('2026-10-14', '2026-10-11', off, []), -3);
  assert.equal(R.reminderDue('2026-10-14', '2026-10-11', off, [-3]), null);
  assert.equal(R.reminderDue('2026-10-14', '2026-10-12', off, []), -3);     // D-2: recupera o D-3 perdido (tolerância 2 dias)
  assert.equal(R.reminderDue('2026-10-14', '2026-10-12', off, [-3]), null); // já enviado: nada novo
  assert.equal(R.reminderDue('2026-10-11', '2026-10-11', off, [-3]), 0);
  assert.equal(R.reminderDue('2026-09-01', '2026-10-11', off, []), null);   // muito antigo: sem rajada
  assert.equal(R.reminderDue('2026-10-06', '2026-10-11', off, [-3, 0, 1]), 5);
});
test('pendências apontam o que escapa da cobrança', () => {
  const c = { stageId: R.STAGES.open, cliente: '', valor: 0, venc: '', doc: '', email: '', telefone: '', asaasId: '' };
  const msgs = R.issuesFor(c, R.DEFAULT_CONFIG, '2026-10-11', true).map(i => i.msg).join('|');
  for (const w of ['Sem cliente', 'Valor zerado', 'vencimento', 'CPF/CNPJ', 'e-mail', 'Asaas']) assert.ok(msgs.includes(w), w);
  assert.deepEqual(R.issuesFor({ ...c, stageId: R.STAGES.paid }, R.DEFAULT_CONFIG, '2026-10-11', true), []);
});

test('classificação sugere plano só quando o título cita o plano', () => {
  assert.deepEqual(R.guessClass('Licença Bitrix24 Professional Vibe+ anual'), { categoria: 'Licença Bitrix24', plano: 'Professional Vibe+' });
  assert.deepEqual(R.guessClass('Renovação Enterprise'), { categoria: 'Licença Bitrix24', plano: 'Enterprise' });
  assert.deepEqual(R.guessClass('Plano STANDARD vibe+'), { categoria: 'Licença Bitrix24', plano: 'Standard Vibe+' });
  assert.deepEqual(R.guessClass('Basic Vibecode'), { categoria: 'Licença Bitrix24', plano: 'Basic Vibe+' });
  assert.deepEqual(R.guessClass('Implantação do CRM'), { categoria: '', plano: '' });
  assert.equal(R.PLANOS.length, 8);
});
