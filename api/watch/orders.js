const { verifyCaller, dbConfigured, unauthorized } = require('../_auth');

// GET  /api/watch/orders?email=x   -> watched bookings, their scan history, savings
// POST /api/watch/orders           -> start watching a booking
module.exports = async (req, res) => {
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

  if (req.method === 'POST') {
    const b = await readJson(req);
    const need = ['orderId', 'email', 'origin', 'destination', 'departOn', 'paidMinor'];
    const missing = need.filter((f) => !b[f]);
    if (missing.length) return res.status(400).end(JSON.stringify({ error: 'missing: ' + missing.join(', ') }));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.departOn))) {
      return res.status(400).end(JSON.stringify({ error: 'departOn must be YYYY-MM-DD' }));
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email))) {
      return res.status(400).end(JSON.stringify({ error: 'a valid email is required' }));
    }
    const paid = Number(b.paidMinor);
    if (!Number.isFinite(paid) || paid <= 0) {
      return res.status(400).end(JSON.stringify({ error: 'paidMinor must be a positive integer of minor units' }));
    }
    if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'mock', watching: false }));

    try {
      const r = await fetch(url + '/rest/v1/watched_orders', {
        method: 'POST',
        headers: Object.assign(auth(key), {
          'Content-Type': 'application/json',
          Prefer: 'return=representation,resolution=merge-duplicates'
        }),
        body: JSON.stringify({
          order_id: String(b.orderId), email: String(b.email).toLowerCase(),
          origin: String(b.origin).toUpperCase().slice(0, 4),
          destination: String(b.destination).toUpperCase().slice(0, 4),
          depart_on: b.departOn, cabin: String(b.cabin || 'economy'),
          passengers: Math.max(1, Number(b.passengers) || 1),
          carrier: b.carrier ? String(b.carrier).slice(0, 4) : null,
          flight_numbers: Array.isArray(b.flightNumbers) ? b.flightNumbers.map(String) : null,
          stops: Number(b.stops) || 0,
          bag_included: Boolean(b.bagIncluded),
          paid_minor: Math.round(paid), currency: String(b.currency || 'USD').toUpperCase()
        })
      });
      if (r.status === 409) return res.status(200).end(JSON.stringify({ mode: 'live:supabase', watching: true, duplicate: true }));
      if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 180));
      return res.status(201).end(JSON.stringify({ mode: 'live:supabase', watching: true }));
    } catch (e) {
      return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 250) }));
    }
  }

  if (req.method !== 'GET') return res.status(405).end(JSON.stringify({ error: 'GET or POST only' }));

  if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'mock', watched: DEMO }));

  const email = (caller ? caller.email : '');
  try {
    const q = url + '/rest/v1/watched_orders?select=*,fare_checks(checked_at,best_minor,delta_minor,window_type,actionable,reason)' +
      (email ? '&email=eq.' + encodeURIComponent(email) : '') +
      '&order=depart_on.asc&limit=25';
    const r = await fetch(q, { headers: auth(key) });
    if (!r.ok) throw new Error('supabase ' + r.status);
    const rows = await r.json();
    if (!rows.length) return res.status(200).end(JSON.stringify({ mode: 'live:supabase', watched: [] }));
    return res.status(200).end(JSON.stringify({ mode: 'live:supabase', watched: rows.map(shape) }));
  } catch (e) {
    return res.status(200).end(JSON.stringify({ mode: 'mock', watched: DEMO, warning: String(e.message).slice(0, 160) }));
  }
};

function shape(r) {
  const checks = (r.fare_checks || []).sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at));
  return {
    orderId: r.order_id, origin: r.origin, destination: r.destination,
    departOn: r.depart_on, carrier: r.carrier, flightNumbers: r.flight_numbers || [],
    paidMinor: r.paid_minor, bestSeenMinor: r.best_seen_minor, currency: r.currency,
    savedMinor: r.saved_minor || 0, status: r.status,
    checksRun: r.checks_run || 0, lastCheckedAt: r.last_checked_at,
    recentChecks: checks.slice(0, 8)
  };
}

// Shown when no database is connected, so the surface is demonstrable.
const DEMO = [{
  orderId: 'ord_demo_az631', origin: 'JFK', destination: 'LIN', departOn: '2026-09-12',
  carrier: 'AZ', flightNumbers: ['AZ631', 'AZ1265'],
  paidMinor: 214800, bestSeenMinor: 189000, currency: 'EUR',
  savedMinor: 0, status: 'WATCHING', checksRun: 47,
  lastCheckedAt: new Date().toISOString(),
  recentChecks: [
    { checked_at: new Date(Date.now() - 36e5).toISOString(), best_minor: 189000, delta_minor: 25800, window_type: 'CREDIT', actionable: true, reason: 'drop is real but only recoverable as airline credit' },
    { checked_at: new Date(Date.now() - 72e5).toISOString(), best_minor: 214800, delta_minor: 0, window_type: 'CREDIT', actionable: false, reason: 'drop below the threshold' }
  ]
}];

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
