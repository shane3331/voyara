const { guard } = require('./_guard');

const { verifyCaller, dbConfigured, unauthorized } = require('./_auth');

// GET  /api/trips?email=x   -> a traveller's trips with their reservations
// POST /api/trips           -> create a trip, or attach a reservation to one
//
// This is the join between the two halves of the product. A booking that does
// not become a monitored trip is just a receipt, and the whole argument for
// Voyara is what happens after the receipt.
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (guard(req, res, { limit: { name: 'trips', max: 40, windowMs: 60000 } })) return;
  res.setHeader('content-type', 'application/json');

  // Identity comes from the verified token. A route that takes an email from
  // the query string is a route that hands one person's data to another.
  let caller = null;
  if (dbConfigured()) {
    caller = await verifyCaller(req);
    if (!caller) return unauthorized(res);
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (req.method === 'GET') {
    const email = (caller ? caller.email : '');
    if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'mock', trips: [] }));
    try {
      const q = url + '/rest/v1/trips?select=*' +
        (email ? '&email=eq.' + encodeURIComponent(email) : '') +
        '&order=starts_on.asc&limit=25';
      const r = await fetch(q, { headers: auth(key) });
      if (!r.ok) throw new Error('supabase ' + r.status);
      return res.status(200).end(JSON.stringify({ mode: 'live:supabase', trips: (await r.json()).map(shape) }));
    } catch (e) {
      return res.status(200).end(JSON.stringify({ mode: 'mock', trips: [], warning: String(e.message).slice(0, 160) }));
    }
  }

  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'GET or POST only' }));

  const b = await readJson(req);
  const email = (caller ? caller.email : '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).end(JSON.stringify({ error: 'a valid email is required' }));
  }
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).end(JSON.stringify({ error: 'title is required' }));
  for (const [d, l] of [[b.startsOn, 'startsOn'], [b.endsOn, 'endsOn']]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
      return res.status(400).end(JSON.stringify({ error: l + ' must be YYYY-MM-DD' }));
    }
  }
  if (b.startsOn && b.endsOn && new Date(b.endsOn) < new Date(b.startsOn)) {
    return res.status(400).end(JSON.stringify({ error: 'endsOn cannot be before startsOn' }));
  }
  if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'mock', created: false }));

  try {
    const created = await upsertTrip(url, key, {
      email, title,
      starts_on: b.startsOn || null,
      ends_on: b.endsOn || null,
      status: 'MONITORED',
      data: { reservations: b.reservation ? [b.reservation] : [], source: b.source || 'booking' }
    });
    await appendAudit(url, key, 'trip.created', {
      title, source: b.source || 'booking',
      reservations: b.reservation ? 1 : 0
    }, 'trip', created.id || title);
    return res.status(201).end(JSON.stringify({ mode: 'live:supabase', created: true, trip: shape(created) }));
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 250) }));
  }
};

// A second booking for the same person and dates joins the existing trip
// rather than creating a duplicate. Nobody thinks of a flight and a hotel in
// the same week as two separate trips.
async function upsertTrip(url, key, row) {
  if (row.starts_on) {
    const look = await fetch(
      url + '/rest/v1/trips?select=*&email=eq.' + encodeURIComponent(row.email) +
      '&starts_on=eq.' + encodeURIComponent(row.starts_on) + '&limit=1',
      { headers: auth(key) }
    );
    if (look.ok) {
      const found = (await look.json())[0];
      if (found) {
        const merged = Object.assign({}, found.data || {});
        const list = Array.isArray(merged.reservations) ? merged.reservations : [];
        (row.data.reservations || []).forEach((r) => {
          if (!list.some((x) => x && r && x.reference === r.reference)) list.push(r);
        });
        merged.reservations = list;
        const up = await fetch(url + '/rest/v1/trips?id=eq.' + encodeURIComponent(found.id), {
          method: 'PATCH',
          headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
          body: JSON.stringify({ data: merged, updated_at: new Date().toISOString() })
        });
        if (up.ok) return (await up.json())[0] || found;
        return found;
      }
    }
  }
  const r = await fetch(url + '/rest/v1/trips', {
    method: 'POST',
    headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 180));
  return (await r.json())[0] || {};
}

function shape(t) {
  const d = t.data || {};
  const rs = Array.isArray(d.reservations) ? d.reservations : [];
  return {
    id: t.id, title: t.title, startsOn: t.starts_on, endsOn: t.ends_on,
    status: t.status, reservations: rs, reservationCount: rs.length,
    createdAt: t.created_at
  };
}

async function appendAudit(url, key, type, payload, st, sid) {
  try {
    await fetch(url + '/rest/v1/rpc/append_audit', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_type: type, p_actor: 'system', p_payload: payload, p_subject_type: st, p_subject_id: String(sid) })
    });
  } catch (e) { /* a trip must never be lost over an audit failure */ }
}
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
