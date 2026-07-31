// GET /api/recover  -> reconcile anything left stranded
//
// This is the piece that makes the system durable. Serverless functions die.
// A supplier call can succeed while the process that made it never learns
// the outcome, which leaves a real booking nobody knows about.
//
// Every money touching route writes an execution record before calling a
// supplier. This pass finds records that never reached a terminal state and
// asks the supplier what actually happened. Because every step is idempotent,
// asking again is always safe.
//
// It never books, cancels or charges anything. It only reads and records.
const STALE_MINUTES = num(process.env.RECOVER_STALE_MINUTES, 10);
const MAX_ATTEMPTS = num(process.env.RECOVER_MAX_ATTEMPTS, 8);

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
      String((req.query && req.query.key) || '');
    if (given !== secret) return res.status(401).end(JSON.stringify({ error: 'unauthorized' }));
  }

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return res.status(200).end(JSON.stringify({ mode: 'mock', reconciled: 0, note: 'No database, nothing to recover.' }));
  }

  const cutoff = new Date(Date.now() - STALE_MINUTES * 60000).toISOString();
  let stranded;
  try {
    const r = await fetch(
      url + '/rest/v1/executions?select=*' +
      '&state=in.(STARTED,SUPPLIER_CALLED,AMBIGUOUS)' +
      '&updated_at=lt.' + encodeURIComponent(cutoff) +
      '&order=started_at.asc&limit=50',
      { headers: auth(key) });
    if (!r.ok) throw new Error('supabase ' + r.status);
    stranded = await r.json();
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 200) }));
  }

  const out = [];
  for (const x of stranded) {
    try { out.push(await reconcile(url, key, x)); }
    catch (e) {
      await patch(url, key, x.id, {
        attempts: (x.attempts || 0) + 1,
        last_error: String(e.message).slice(0, 300),
        updated_at: new Date().toISOString()
      });
      out.push({ id: x.id, kind: x.kind, outcome: 'error', detail: String(e.message).slice(0, 160) });
    }
  }

  res.status(200).end(JSON.stringify({
    mode: process.env.LITEAPI_KEY ? 'live:liteapi' : 'mock',
    staleMinutes: STALE_MINUTES, found: stranded.length,
    reconciled: out.filter((o) => o.outcome === 'resolved').length,
    escalated: out.filter((o) => o.outcome === 'escalated').length,
    results: out
  }));
};

async function reconcile(url, key, x) {
  // Give up automatically after enough tries and hand it to a person. A loop
  // that retries forever is how a real problem stays invisible.
  if ((x.attempts || 0) >= MAX_ATTEMPTS) {
    await patch(url, key, x.id, { state: 'ESCALATED', updated_at: new Date().toISOString() });
    await audit(url, key, 'execution.escalated', { kind: x.kind, attempts: x.attempts }, x.id);
    return { id: x.id, kind: x.kind, outcome: 'escalated', reason: 'attempt limit reached' };
  }

  const apiKey = process.env.LITEAPI_KEY;
  if (!apiKey) return { id: x.id, kind: x.kind, outcome: 'skipped', reason: 'no supplier credentials' };

  const base = process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0';
  const headers = { 'X-API-Key': apiKey, Accept: 'application/json' };

  // Ask the supplier what actually happened. Read only.
  const ref = x.supplier_ref;
  if (!ref) {
    // Never got far enough to have a reference. Nothing was created.
    await patch(url, key, x.id, {
      state: 'FAILED', last_error: 'no supplier reference recorded',
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    await audit(url, key, 'execution.failed', { kind: x.kind, reason: 'never reached the supplier' }, x.id);
    return { id: x.id, kind: x.kind, outcome: 'resolved', state: 'FAILED', reason: 'nothing was created' };
  }

  const r = await fetch(base + '/bookings/' + encodeURIComponent(ref), { headers });
  if (r.status === 404) {
    await patch(url, key, x.id, {
      state: 'FAILED', last_error: 'supplier has no such booking',
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    await audit(url, key, 'execution.failed', { kind: x.kind, supplier_ref: ref }, x.id);
    return { id: x.id, kind: x.kind, outcome: 'resolved', state: 'FAILED', reason: 'no booking exists' };
  }
  if (!r.ok) throw new Error('supplier lookup ' + r.status);

  const booking = (await r.json()).data || {};
  const status = String(booking.status || '').toUpperCase();

  // What "done" means depends on what we were trying to do.
  const wantedCancelled = x.kind === 'HOTEL_CANCEL';
  const settled = wantedCancelled ? status === 'CANCELLED' : (status && status !== 'CANCELLED');

  await patch(url, key, x.id, {
    state: settled ? 'COMPLETE' : 'ESCALATED',
    result: { supplierStatus: status, reconciled: true },
    completed_at: settled ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
    attempts: (x.attempts || 0) + 1
  });

  await audit(url, key, settled ? 'execution.reconciled' : 'execution.escalated', {
    kind: x.kind, supplier_ref: ref, supplier_status: status
  }, x.id);

  return {
    id: x.id, kind: x.kind,
    outcome: settled ? 'resolved' : 'escalated',
    supplierStatus: status,
    reason: settled
      ? 'supplier confirms it landed, record closed'
      : 'supplier state does not match the intent, a human should look'
  };
}

async function patch(url, key, id, fields) {
  await fetch(url + '/rest/v1/executions?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(fields)
  });
}
async function audit(url, key, type, payload, subject) {
  try {
    await fetch(url + '/rest/v1/rpc/append_audit', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_type: type, p_actor: 'recovery', p_payload: payload, p_subject_type: 'execution', p_subject_id: String(subject) })
    });
  } catch (e) { /* the execution row is the record of truth */ }
}
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
