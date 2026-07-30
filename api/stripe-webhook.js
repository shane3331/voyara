// POST /api/stripe-webhook
//
// Stripe tells us when a membership starts, renews, lapses, or is refunded.
// Without this route a subscription exists in Stripe and nowhere else, which
// means no record of who is actually a member.
//
// Authenticity: rather than verifying the signature header, which needs the
// raw request body and is fragile across runtimes, this re-fetches the event
// from Stripe by id using the secret key. If Stripe confirms the event, it is
// real. A forged payload dies at that lookup because the id will not exist.
//
// Idempotency: Stripe retries. Every event id is written to webhook_events,
// whose primary key rejects a duplicate at the database rather than in code.
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const sk = process.env.STRIPE_SECRET_KEY;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!sk) return res.status(200).end(JSON.stringify({ mode: 'mock', note: 'STRIPE_SECRET_KEY not set.' }));

  const body = await readJson(req);
  const eventId = String((body && body.id) || '');
  if (!/^evt_[A-Za-z0-9_]+$/.test(eventId)) {
    return res.status(400).end(JSON.stringify({ error: 'no valid stripe event id in payload' }));
  }

  // Authenticity check. Never trust the posted body.
  let event;
  try {
    const r = await fetch('https://api.stripe.com/v1/events/' + encodeURIComponent(eventId), {
      headers: { Authorization: 'Bearer ' + sk }
    });
    if (r.status === 404) return res.status(401).end(JSON.stringify({ error: 'event not found at Stripe, treating as forged' }));
    if (!r.ok) throw new Error('stripe ' + r.status);
    event = await r.json();
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'stripe_unreachable', detail: String(e.message).slice(0, 200) }));
  }

  if (!url || !key) {
    return res.status(200).end(JSON.stringify({ mode: 'stripe_only', type: event.type, note: 'Supabase not configured, nothing persisted.' }));
  }

  // Idempotency. A duplicate insert fails on the primary key and we stop.
  try {
    const ins = await fetch(url + '/rest/v1/webhook_events', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ id: event.id, type: event.type })
    });
    if (ins.status === 409) {
      return res.status(200).end(JSON.stringify({ ok: true, duplicate: true, note: 'Already processed. Nothing changed.' }));
    }
    if (!ins.ok && ins.status !== 201) throw new Error('supabase ' + ins.status + ' ' + (await ins.text()).slice(0, 200));
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 200) }));
  }

  const obj = (event.data && event.data.object) || {};
  let action = 'ignored';

  try {
    if (event.type === 'checkout.session.completed') {
      const email = pickEmail(obj);
      if (email) {
        await upsertMembership(url, key, {
          email,
          stripe_customer_id: obj.customer || null,
          stripe_subscription_id: obj.subscription || null,
          status: 'active',
          amount_minor: obj.amount_total || null,
          currency: obj.currency || 'usd'
        });
        await appendAudit(url, key, 'membership.activated', { tier: 'founding' }, 'membership', email);
        action = 'membership activated';
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : String(obj.status || 'active');
      await patchBySubscription(url, key, obj.id, {
        status,
        current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null
      });
      await appendAudit(url, key, 'membership.' + status, { subscription: obj.id }, 'membership', obj.id);
      action = 'membership ' + status;
    } else if (event.type === 'charge.refunded' || event.type === 'customer.subscription.paused') {
      const sub = obj.subscription || obj.id;
      if (sub) {
        await patchBySubscription(url, key, sub, { status: 'refunded' });
        await appendAudit(url, key, 'membership.refunded', { subscription: sub }, 'membership', sub);
        action = 'membership refunded';
      }
    }
  } catch (e) {
    // The event is already marked processed, so surface the failure loudly
    // rather than letting Stripe retry into a no-op.
    return res.status(500).end(JSON.stringify({
      error: 'processing_failed', event: event.id, type: event.type,
      detail: String(e.message).slice(0, 300),
      note: 'Event was recorded as received. Fix and replay manually from the Stripe dashboard.'
    }));
  }

  res.status(200).end(JSON.stringify({ ok: true, type: event.type, action }));
};

function pickEmail(o) {
  const e = (o.customer_details && o.customer_details.email) || o.customer_email || null;
  return e ? String(e).trim().toLowerCase() : null;
}
async function upsertMembership(url, key, row) {
  const r = await fetch(url + '/rest/v1/memberships?on_conflict=email', {
    method: 'POST',
    headers: Object.assign(auth(key), {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, row))
  });
  if (!r.ok && r.status !== 201 && r.status !== 204) throw new Error('upsert ' + r.status + ' ' + (await r.text()).slice(0, 200));
}
async function patchBySubscription(url, key, sub, patch) {
  const r = await fetch(url + '/rest/v1/memberships?stripe_subscription_id=eq.' + encodeURIComponent(sub), {
    method: 'PATCH',
    headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, patch))
  });
  if (!r.ok && r.status !== 204) throw new Error('patch ' + r.status);
}
async function appendAudit(url, key, type, payload, subjectType, subjectId) {
  try {
    await fetch(url + '/rest/v1/rpc/append_audit', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_type: type, p_actor: 'stripe', p_payload: payload, p_subject_type: subjectType, p_subject_id: String(subjectId) })
    });
  } catch (e) { /* audit failure must never lose the membership */ }
}
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 5e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
