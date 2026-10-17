'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FORMA_ID, TIPO_ID, today, world, R } = require('../testkit/world');

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const card = (id, company, extra = {}) => ({ ID: String(id), TITLE: `Lançamento ${id}`, STAGE_ID: R.STAGES.open, OPPORTUNITY: '100', COMPANY_ID: String(company), CONTACT_ID: '0', ASSIGNED_BY_ID: '1',
  UF_CRM_CR_FORMA: FORMA_ID('PIX'), UF_CRM_CR_TIPO: TIPO_ID('UNICA'), UF_CRM_CR_VENC: addDays(today, 20) + 'T00:00:00+03:00', ...extra });

test('dentro da deal: só os lançamentos e totais do cliente daquela deal', async () => {
  const w = world([card(1, 5), card(2, 5, { OPPORTUNITY: '250' }), card(3, 6, { OPPORTUNITY: '9999' }), card(4, 0)]);
  const g = await w.svc.estado({});
  assert.equal(g.deals.length, 4); assert.equal(g.escopo, null);                // painel geral
  const r = await w.svc.estado({ deal: '1' });
  assert.deepEqual(r.deals.map(d => d.id).sort(), [1, 2]);                      // só empresa 5
  assert.equal(r.kpis.aberto.valor, 350);                                       // totais só do cliente
  assert.equal(r.escopo.companyId, '5'); assert.equal(r.escopo.dealId, '1'); assert.equal(r.escopo.qtd, 2);
  assert.ok(!JSON.stringify(r).includes('9999'));                               // nada de outro cliente
  const c6 = await w.svc.estado({ deal: '3' });
  assert.deepEqual(c6.deals.map(d => d.id), [3]);
  const byCompany = await w.svc.estado({ company: '5' });
  assert.equal(byCompany.deals.length, 2);
});

test('deal sem cliente mostra vazio; parâmetro malformado nunca vaza o painel geral', async () => {
  const w = world([card(1, 5), card(4, 0)]);
  const r = await w.svc.estado({ deal: '4' });
  assert.equal(r.deals.length, 0); assert.equal(r.escopo.tipo, 'nenhum');
  await assert.rejects(() => w.svc.estado({ deal: 'abc' }), /Escopo inválido/);
  await assert.rejects(() => w.svc.estado({ company: '5; drop' }), /Escopo inválido/);
  await assert.rejects(() => w.svc.estado({ deal: '../1' }), /Escopo inválido/);
});
