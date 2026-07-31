// Execution records. Required by any route that spends a customer's money.
//
// The contract: begin() BEFORE the supplier call, advance() after each step,
// finish() at the end. If the function dies anywhere in between, the record
// survives in a non terminal state and /api/recover reconciles it.
//
// Underscore prefixed so Vercel does not route it as an endpoint.
async function begin(kind, idempotencyKey, intent) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { id: null, resumed: false, durable: false };
  try {
    const r = await fetch(url + '/rest/v1/executions', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({ kind, idempotency_key: idempotencyKey, state: 'STARTED', intent: intent || {}, attempts: 1 })
    });
    if (r.status === 409) {
      // Already exists. Either a retry of a request that died, or a genuine
      // duplicate. Hand back what we know so the caller can decide.
      const look = await fetch(
        url + '/rest/v1/executions?select=*&idempotency_key=eq.' + encodeURIComponent(idempotencyKey) + '&limit=1',
        { headers: auth(key) });
      const found = look.ok ? (await look.json())[0] : null;
      if (found) {
        await patch(url, key, found.id, { attempts: (found.attempts || 1) + 1 });
        return { id: found.id, resumed: true, durable: true, prior: found };
      }
      return { id: null, resumed: true, durable: false };
    }
    if (!r.ok) throw new Error('supabase ' + r.status);
    const row = (await r.json())[0] || {};
    return { id: row.id || null, resumed: false, durable: true };
  } catch (e) {
    // Durability is best effort. A logging outage must not stop a booking a
    // traveller is waiting on, but the caller is told it is not durable.
    return { id: null, resumed: false, durable: false, error: String(e.message).slice(0, 160) };
  }
}

async function advance(handle, state, fields) {
  if (!handle || !handle.id) return;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  await patch(url, key, handle.id, Object.assign({ state, updated_at: new Date().toISOString() }, fields || {}));
}

async function finish(handle, state, result) {
  if (!handle || !handle.id) return;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  await patch(url, key, handle.id, {
    state, result: result || null,
    updated_at: new Date().toISOString(),
    completed_at: ['COMPLETE', 'FAILED'].indexOf(state) >= 0 ? new Date().toISOString() : null
  });
}

async function patch(url, key, id, fields) {
  try {
    await fetch(url + '/rest/v1/executions?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(fields)
    });
  } catch (e) { /* best effort */ }
}

function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }

module.exports = { begin, advance, finish };
