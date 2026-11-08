'use strict';
// Autentique (API GraphQL v2): envio de documento para assinatura e consulta do andamento. Token em Authorization: Bearer.
const URL_API = 'https://api.autentique.com.br/v2/graphql';
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });

const CRIAR = `mutation CreateDocumentMutation($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!, $sandbox: Boolean) {
  createDocument(document: $document, signers: $signers, file: $file, sandbox: $sandbox) { id name signatures { public_id name email action { name } link { short_link } } } }`;
const CONSULTAR = `query($id: UUID!) { document(id: $id) { id name created_at signatures { public_id name email signed { created_at } rejected { created_at } } } }`;

function createAutentique({ secrets, fetchFn = (...a) => fetch(...a) }) {
  const cfg = () => secrets.get('autentique') || {};
  const pronto = () => !!cfg().token;
  async function chamar(corpo, headersExtra = {}) {
    if (!pronto()) throw bad('A Autentique ainda não foi configurada.', 409);
    const r = await fetchFn(cfg().url || URL_API, { method: 'POST', headers: { Authorization: `Bearer ${cfg().token}`, ...headersExtra }, body: corpo });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* não-JSON */ }
    if (r.status === 401 || r.status === 403) throw bad('A Autentique recusou o token (verifique se está ativo e copiado inteiro).', 502);
    if (!j) throw bad(`Resposta inesperada da Autentique (${r.status}).`, 502);
    if (j.errors && j.errors.length) throw bad(`Autentique: ${String(j.errors[0].message).slice(0, 220)}`, 502);
    return j.data;
  }
  return {
    pronto,
    async testar() { const d = await chamar(JSON.stringify({ query: '{ me { id name email } }' }), { 'Content-Type': 'application/json' }); return { ok: true, usuario: d.me && (d.me.name || d.me.email) || '' }; },
    // pdf: Buffer; signatarios: [{ email, acao: 'SIGN'|'APPROVE'|… }]
    async enviar({ nome, pdf, signatarios, sandbox = false }) {
      if (!Buffer.isBuffer(pdf) || pdf.slice(0, 4).toString() !== '%PDF') throw bad('O arquivo precisa ser um PDF.');
      if (pdf.length > 20e6) throw bad('PDF acima de 20 MB.');
      const sg = (signatarios || []).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s.email || ''))).map(s => ({ email: String(s.email).trim(), action: s.acao || 'SIGN' })); if (!sg.length) throw bad('Informe ao menos um signatário com e-mail válido.');
      const fd = new FormData();
      fd.append('operations', JSON.stringify({ query: CRIAR, variables: { document: { name: String(nome || 'Contrato').slice(0, 120) }, signers: sg, file: null, sandbox: !!sandbox } }));
      fd.append('map', JSON.stringify({ file: ['variables.file'] }));
      fd.append('file', new Blob([pdf], { type: 'application/pdf' }), `${String(nome || 'contrato').replace(/[^\w.-]+/g, '_').slice(0, 60)}.pdf`);
      const d = await chamar(fd); const doc = d.createDocument; if (!doc || !doc.id) throw bad('A Autentique não devolveu o documento criado.', 502);
      return { id: doc.id, links: (doc.signatures || []).map(s => ({ email: s.email, link: s.link && s.link.short_link || '' })) };
    },
    async consultar(id) { const d = await chamar(JSON.stringify({ query: CONSULTAR, variables: { id } }), { 'Content-Type': 'application/json' }); return statusDoc(d.document); },
  };
}
// → { estado: 'pendente'|'assinado'|'recusado', assinados, total }
function statusDoc(doc) {
  const s = (doc && doc.signatures) || [], rec = s.some(x => x.rejected && x.rejected.created_at), ass = s.filter(x => x.signed && x.signed.created_at).length;
  return { estado: rec ? 'recusado' : s.length && ass === s.length ? 'assinado' : 'pendente', assinados: ass, total: s.length };
}
module.exports = { createAutentique, statusDoc, URL_API };
