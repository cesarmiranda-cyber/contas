'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { createBancoInter, inspecionaCertificado, parseExtratoInter } = require('../lib/bancoInter');
const { createAutentique, statusDoc } = require('../lib/autentique');
const { createIntegracoesApi } = require('../lib/integracoesApi');
const { parseCamt053 } = require('../lib/camt');
const { parseExtratoArquivo } = require('../lib/ofx');
const { createSecrets } = require('../lib/secrets');

function parCert(dias = 365) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(d, 'k.key'), '-out', path.join(d, 'c.crt'), '-days', String(dias), '-subj', '/CN=Nutri Mix Teste'], { stdio: 'ignore' });
  return { cert: fs.readFileSync(path.join(d, 'c.crt'), 'utf8'), key: fs.readFileSync(path.join(d, 'k.key'), 'utf8') };
}
const secretsTmp = () => createSecrets(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')));

test('certificado do Inter: valida o par, mostra a validade e recusa chave de outro certificado', () => {
  const a = parCert(), b = parCert();
  const r = inspecionaCertificado(a.cert, a.key); assert.ok(r.diasParaVencer >= 360 && !r.vencido); assert.match(r.titular, /Nutri Mix Teste/);
  assert.throws(() => inspecionaCertificado(a.cert, b.key), /não corresponde/); assert.throws(() => inspecionaCertificado('lixo', a.key), /\.crt/); assert.throws(() => inspecionaCertificado(a.cert, 'lixo'), /\.key/);
});

test('Banco Inter: token com cache, extrato em janelas de 90 dias, débito negativo, saldo e erros claros', async () => {
  const sec = secretsTmp(), calls = []; sec.set({ inter: { clientId: 'cid-12345678', clientSecret: 'segredo-123', cert: 'c', key: 'k', contaCorrente: '123456' } });
  const http = async (m, url, o = {}) => { calls.push([m, url, o.headers, o.body]);
    if (url.endsWith('/oauth/v2/token')) return { status: 200, json: { access_token: 'T1', expires_in: 3600 } };
    if (url.includes('/banking/v2/extrato')) return { status: 200, json: { transacoes: [{ idTransacao: 'a' + calls.length, dataEntrada: '2026-10-05', tipoOperacao: 'C', valor: '100.50', titulo: 'Pix recebido', descricao: 'Cliente X' }, { idTransacao: 'b' + calls.length, dataEntrada: '2026-10-06', tipoOperacao: 'D', valor: 40, titulo: 'Boleto pago' }] } };
    if (url.includes('/banking/v2/saldo')) return { status: 200, json: { disponivel: 1234.56 } }; return { status: 404, json: null, text: 'x' }; };
  const inter = createBancoInter({ secrets: sec, http }); assert.equal(inter.pronto(), true);
  const e = await inter.extrato('2026-07-01', '2026-10-31');   // 123 dias: 2 janelas
  assert.equal(calls.filter(c => c[1].includes('/extrato')).length, 2); assert.equal(calls.filter(c => c[1].endsWith('/oauth/v2/token')).length, 1);   // token reaproveitado
  assert.ok(calls[0][3].includes('grant_type=client_credentials') && calls[0][3].includes('scope=extrato.read')); assert.equal(calls[1][2]['x-conta-corrente'], '123456'); assert.equal(calls[1][2].Authorization, 'Bearer T1');
  assert.equal(e.saldoFinal, 1234.56); assert.deepEqual(e.linhas.slice(0, 2).map(l => l.valor), [100.5, -40]); assert.match(e.linhas[0].descricao, /Pix recebido — Cliente X/);
  const ruim = createBancoInter({ secrets: sec, http: async () => ({ status: 401, json: { error_description: 'invalid_client' }, text: '' }) }); await assert.rejects(ruim.testar(), /recusou a autenticação \(401\): invalid_client/);
  await assert.rejects(createBancoInter({ secrets: secretsTmp() }).testar(), /ainda não foi configurado/); assert.equal(parseExtratoInter({ transacoes: [] }).linhas.length, 0);
});

test('Autentique: monta o envio multipart, valida PDF e e-mails, traduz o andamento e erros', async () => {
  const sec = secretsTmp(); sec.set({ autentique: { token: 'token-de-teste-123456' } }); let chamada;
  const fetchFn = async (url, o) => { chamada = { url, o }; const q = o.body instanceof FormData ? 'criar' : JSON.parse(o.body).query;
    const resp = d => ({ status: 200, text: async () => JSON.stringify(d) });
    if (o.body instanceof FormData) return resp({ data: { createDocument: { id: 'doc-1', signatures: [{ email: 'a@x.com', link: { short_link: 'https://aut.ink/abc' } }] } } });
    if (/me \{/.test(q)) return resp({ data: { me: { name: 'Nutri Mix' } } }); if (/document\(/.test(q)) return resp({ data: { document: { signatures: [{ signed: { created_at: 'x' } }, { signed: null, rejected: null }] } } });
    return resp({ errors: [{ message: 'Campo inexistente' }] }); };
  const a = createAutentique({ secrets: sec, fetchFn });
  assert.equal((await a.testar()).usuario, 'Nutri Mix'); assert.equal(chamada.o.headers.Authorization, 'Bearer token-de-teste-123456');
  await assert.rejects(a.enviar({ nome: 'x', pdf: Buffer.from('não é pdf'), signatarios: [{ email: 'a@x.com' }] }), /PDF/); await assert.rejects(a.enviar({ nome: 'x', pdf: Buffer.from('%PDF-1.4 x'), signatarios: [{ email: 'sem-arroba' }] }), /signatário/);
  const r = await a.enviar({ nome: 'Contrato Cliente', pdf: Buffer.from('%PDF-1.4 conteudo'), signatarios: [{ email: 'a@x.com' }], sandbox: true });
  assert.equal(r.id, 'doc-1'); assert.equal(r.links[0].link, 'https://aut.ink/abc'); const ops = JSON.parse(chamada.o.body.get('operations')); assert.equal(ops.variables.sandbox, true); assert.equal(ops.variables.signers[0].action, 'SIGN'); assert.deepEqual(JSON.parse(chamada.o.body.get('map')), { file: ['variables.file'] });
  assert.deepEqual(await a.consultar('doc-1'), { estado: 'pendente', assinados: 1, total: 2 });
  assert.equal(statusDoc({ signatures: [{ signed: { created_at: 'x' } }] }).estado, 'assinado'); assert.equal(statusDoc({ signatures: [{ rejected: { created_at: 'x' } }] }).estado, 'recusado');
  const ruim = createAutentique({ secrets: sec, fetchFn: async () => ({ status: 200, text: async () => JSON.stringify({ errors: [{ message: 'Campo inexistente' }] }) }) }); await assert.rejects(ruim.testar(), /Autentique: Campo inexistente/);
  await assert.rejects(createAutentique({ secrets: secretsTmp() }).testar(), /ainda não foi configurada/);
});

test('Configurações das integrações: valida, guarda sem devolver segredos e desconecta', async () => {
  const sec = secretsTmp(), inter = createBancoInter({ secrets: sec, http: async () => ({ status: 200, json: { access_token: 'T', expires_in: 3600, disponivel: 5 } }) }), aut = createAutentique({ secrets: sec });
  const api = createIntegracoesApi({ secrets: sec, inter, autentique: aut, store: { log() {} } }), call = (m, p, b) => api.handle(m, '/api/settings/integracoes' + p, async () => b || {}), par = parCert();
  assert.equal((await call('GET', '')).inter.configurado, false); assert.match((await call('GET', '')).itau.texto, /camt\.053/);
  await assert.rejects(call('PUT', '/inter', { clientId: 'x', clientSecret: 's', cert: par.cert, key: par.key }), /Client ID inválido/);
  const e = await call('PUT', '/inter', { clientId: 'cid-12345678', clientSecret: 'segredo-9999', cert: par.cert, key: par.key, contaCorrente: '777' });
  assert.equal(e.inter.configurado, true); assert.equal(e.inter.clientSecretDica, '••••9999'); assert.ok(e.inter.certificado.diasParaVencer > 300); assert.doesNotMatch(JSON.stringify(e), /BEGIN|segredo-9999/);
  assert.equal((await call('PUT', '/inter', { contaCorrente: '888' })).inter.contaCorrente, '888'); assert.equal(sec.get('inter').cert.includes('BEGIN CERTIFICATE'), true);   // campos em branco mantêm o que já existe
  assert.equal((await call('POST', '/inter/testar')).ok, true); assert.equal((await call('DELETE', '/inter')).inter.configurado, false);
  await assert.rejects(call('PUT', '/autentique', { token: 'curto' }), /Token inválido/); const a = await call('PUT', '/autentique', { token: 'abcdefghijklmnop1234', sandbox: true });
  assert.equal(a.autentique.configurado, true); assert.equal(a.autentique.sandbox, true); assert.doesNotMatch(JSON.stringify(a), /abcdefghijklmnop1234/); assert.equal((await call('DELETE', '/autentique')).autentique.configurado, false);
});

test('extrato do Itaú Empresas (camt.053) e OFX entram pelo mesmo importador', () => {
  const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><Othr><Id>12345-6</Id></Othr></Id></Acct>
  <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="BRL">1500.25</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-31</Dt></Dt></Bal>
  <Ntry><Amt Ccy="BRL">200.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-10-05</Dt></BookgDt><AcctSvcrRef>REF1</AcctSvcrRef><AddtlNtryInf>PIX RECEBIDO</AddtlNtryInf><NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Cliente &amp; Cia</Nm></Dbtr></RltdPties></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="BRL">75.10</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-06</Dt></BookgDt><NtryRef>REF2</NtryRef><AddtlNtryInf>PAGAMENTO BOLETO</AddtlNtryInf></Ntry></Stmt></BkToCstmrStmt></Document>`;
  const p = parseExtratoArquivo(xml); assert.equal(p.linhas.length, 2); assert.deepEqual(p.linhas.map(l => l.valor), [200, -75.1]); assert.equal(p.saldoFinal, 1500.25); assert.equal(p.saldoEm, '2026-10-31'); assert.equal(p.conta, '12345-6');
  assert.match(p.linhas[0].descricao, /PIX RECEBIDO — Cliente & Cia/); assert.equal(p.linhas[0].fitid, '2026-10-05|REF1'); assert.deepEqual([p.inicio, p.fim], ['2026-10-05', '2026-10-06']);
  assert.throws(() => parseCamt053('<x/>'), /camt\.053/); assert.throws(() => parseExtratoArquivo('texto qualquer'), /OFX/);
  assert.equal(parseExtratoArquivo('OFXHEADER:100\n<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20261005<TRNAMT>-10,00<FITID>1<MEMO>Tarifa</STMTTRN></BANKTRANLIST></OFX>').linhas[0].valor, -10);
});
