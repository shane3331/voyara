// GET  /api/audit           -> the persisted chain, plus verification
// POST /api/audit           -> append one record
//
// The chain that survives a refresh. Verification recomputes every hash
// from genesis, so a row edited directly in the database is detected and
// located. That is the difference between a proof layer and a screenshot.
const crypto = require('crypto');
const GENESIS = '0'.repeat(64);

const { verifyCaller, dbConfigured } = require('./_auth');
const { guard } = require('./_guard');

module.exports = async (req, res) => {
  if (guard(req, res, { limit: { name: 'audit', max: 30, windowMs: 60000 } })) return;
  res.setHeader('content-type', 'application/json');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock', chain: [], verification: { ok: true, brokenAt: null },
      note: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY to persist the chain.'
    }));
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const type = String(body.type || '').trim();
    if (!type) return res.status(400).end(JSON.stringify({ error: 'type is required' }));
    if (type.length > 80) return res.status(400).end(JSON.stringify({ error: 'type is too long' }));
    try {
      const r = await fetch(url + '/rest/v1/rpc/append_audit', {
        method: 'POST',
        headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          p_type: type,
          p_actor: String(body.actor || 'system').slice(0, 40),
          p_payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
          p_subject_type: body.subjectType || null,
          p_subject_id: body.subjectId || null
        })
      });
      if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return res.status(201).end(JSON.stringify({ mode: 'live:supabase', record: await r.json() }));
    } catch (e) {
      return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 300) }));
    }
  }

  try {
    // The ledger names members, bookings and trips. Reading it is an
    // operations job, not something a passer by should be able to do.
    if (dbConfigured() && !(await verifyCaller(req))) {
      return res.status(401).end(JSON.stringify({
        error: 'unauthorized', detail: 'The audit ledger is not public.'
      }));
    }
    const r = await fetch(url + '/rest/v1/audit_events?select=*&order=seq.asc&limit=500', { headers: auth(key) });
    if (!r.ok) throw new Error('supabase ' + r.status);
    const rows = await r.json();
    res.status(200).end(JSON.stringify({
      mode: 'live:supabase',
      count: rows.length,
      chain: rows,
      verification: verify(rows)
    }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 300) }));
  }
};

// Recomputes every hash from genesis. Mirrors the SQL function exactly.
function verify(rows) {
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.previous_hash !== prev) return { ok: false, brokenAt: i, seq: r.seq, reason: 'previous hash does not match' };
    const at = new Date(r.occurred_at).toISOString().replace(/(\.\d{3})Z$/, '$1Z');
    const expect = crypto.createHash('sha256')
      .update(prev + '|' + r.type + '|' + at + '|' + JSON.stringify(r.payload)).digest('hex');
    if (expect !== r.event_hash) return { ok: false, brokenAt: i, seq: r.seq, reason: 'record contents do not hash to the stored value' };
    prev = r.event_hash;
  }
  return { ok: true, brokenAt: null, verifiedRecords: rows.length };
}

function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
