// GET /api/watch/run     -> scan every watched booking
//
// Triggered by Vercel cron. See vercel.json.
//
// THE RULE THIS WHOLE FILE EXISTS TO ENFORCE:
// a cheaper number is not the same thing as a better outcome. A fare is only
// acted on automatically when it is the SAME flight, same cabin, same or
// better baggage, and inside the window where a full refund is guaranteed.
// Everything else becomes a proposal a human approves.
const crypto = require('crypto');

const MIN_BENEFIT_MINOR = num(process.env.WATCH_MIN_BENEFIT_MINOR, 2000); // $20
const VOID_HOURS = 24;      // US DOT full refund window
const VOID_MIN_LEAD_DAYS = 7; // the rule only applies 7+ days before departure

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  // Cron endpoints are public URLs. Require a secret so nobody else can
  // trigger a scan that could rebook real tickets.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
      String((req.query && req.query.key) || '');
    if (given !== secret) return res.status(401).end(JSON.stringify({ error: 'unauthorized' }));
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock', scanned: 0,
      note: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY so bookings can be watched.'
    }));
  }

  let watched;
  try {
    const r = await fetch(
      url + '/rest/v1/watched_orders?select=*&status=eq.WATCHING&order=depart_on.asc&limit=100',
      { headers: auth(key) }
    );
    if (!r.ok) throw new Error('supabase ' + r.status);
    watched = await r.json();
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 200) }));
  }

  const results = [];
  for (const w of watched) {
    try {
      results.push(await scanOne(url, key, w));
    } catch (e) {
      results.push({ order: w.order_id, error: String(e.message).slice(0, 180) });
    }
  }

  res.status(200).end(JSON.stringify({
    mode: process.env.DUFFEL_TOKEN ? 'live:duffel' : 'mock',
    scanned: watched.length,
    actionable: results.filter((r) => r.actionable).length,
    results
  }));
};

async function scanOne(url, key, w) {
  const now = new Date();
  const departure = new Date(w.depart_on + 'T00:00:00Z');
  const hoursSinceBooking = (now - new Date(w.booked_at)) / 36e5;
  const daysToDeparture = (departure - now) / 864e5;

  // Stop watching once the window closes. A ticket cannot be improved on the
  // day, and scanning it forever burns supplier quota for nothing.
  if (daysToDeparture < 1) {
    await patch(url, key, w.id, { status: 'CLOSED' });
    return { order: w.order_id, actionable: false, reason: 'departed or departing' };
  }

  // Status first. A delayed flight matters more than a cheaper one, and a
  // schedule change opens rebooking rights the fare rules would not.
  const status = await checkStatus(url, key, w);

  const quote = await bestComparable(w);
  const delta = quote.found ? w.paid_minor - quote.minor : 0;

  const windowType =
    (hoursSinceBooking <= VOID_HOURS && daysToDeparture >= VOID_MIN_LEAD_DAYS) ? 'VOID_WINDOW'
      : (status.disrupted || quote.scheduleChanged) ? 'SCHEDULE' : 'CREDIT';

  // Auto action is allowed only in the void window, and only on the exact
  // same flights. Anything else is a proposal.
  const strictlyBetter = quote.found &&
    quote.matchQuality === 'SAME_FLIGHT' &&
    delta >= MIN_BENEFIT_MINOR;
  const canAutoAct = strictlyBetter && windowType === 'VOID_WINDOW' &&
    process.env.WATCH_AUTO_REBOOK === 'true';

  const reason = !quote.found ? 'no comparable fare returned'
    : delta < MIN_BENEFIT_MINOR ? 'drop below the threshold'
      : quote.matchQuality !== 'SAME_FLIGHT' ? 'cheaper itinerary is not the same flights'
        : windowType === 'VOID_WINDOW' ? 'refundable drop on the same flight'
          : 'drop is real but only recoverable as airline credit';

  await log(url, key, {
    watched_id: w.id, best_minor: quote.found ? quote.minor : null, currency: w.currency,
    delta_minor: delta, window_type: windowType,
    match_quality: quote.matchQuality || null,
    actionable: Boolean(strictlyBetter), reason
  });

  await patch(url, key, w.id, {
    checks_run: (w.checks_run || 0) + 1,
    last_checked_at: now.toISOString(),
    best_seen_minor: quote.found
      ? Math.min(quote.minor, w.best_seen_minor || quote.minor)
      : w.best_seen_minor
  });

  if (!strictlyBetter) {
    return { order: w.order_id, actionable: false, reason, status: status.summary };
  }

  const action = await propose(url, key, w, quote, delta, windowType, canAutoAct);
  return {
    order: w.order_id, actionable: true, windowType, benefit_minor: delta,
    action: action.status, reason, status: status.summary
  };
}

// Flight status. Records every observation so a delay is a fact with a
// timestamp rather than a screenshot, and opens a disruption when the delay
// crosses the threshold that actually threatens a connection.
const DISRUPT_MINUTES = num(process.env.WATCH_DISRUPT_MINUTES, 45);

async function checkStatus(url, key, w) {
  const ident = (w.flight_numbers || [])[0];
  if (!ident) return { summary: 'no flight number on file', disrupted: false };

  let obs;
  if (!process.env.AEROAPI_KEY) {
    return { summary: 'status not connected', disrupted: false };
  }
  try {
    const r = await fetch(
      'https://aeroapi.flightaware.com/aeroapi/flights/' + encodeURIComponent(ident),
      { headers: { 'x-apikey': process.env.AEROAPI_KEY, Accept: 'application/json' } }
    );
    if (!r.ok) throw new Error('AeroAPI ' + r.status);
    const f = ((await r.json()).flights || [])[0] || {};
    obs = {
      ident, status: String(f.status || 'Unknown'),
      scheduled_out: f.scheduled_out || null,
      estimated_out: f.estimated_out || null,
      delay_minutes: Math.round(Number(f.departure_delay || 0) / 60),
      gate: f.gate_origin || null, terminal: f.terminal_origin || null
    };
  } catch (e) {
    return { summary: 'status unavailable', disrupted: false };
  }

  try {
    await fetch(url + '/rest/v1/flight_observations', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(obs)
    });
  } catch (e) { /* a lost observation must not stop the scan */ }

  const disrupted = obs.delay_minutes >= DISRUPT_MINUTES ||
    /cancel/i.test(obs.status) || /divert/i.test(obs.status);

  if (disrupted) {
    // One open disruption per flight. A delay that keeps growing is the same
    // event, not a new one every two hours.
    try {
      const open = await fetch(
        url + '/rest/v1/disruptions?select=id&ident=eq.' + encodeURIComponent(ident) +
        '&state=neq.RESOLVED&limit=1', { headers: auth(key) });
      const existing = open.ok ? await open.json() : [];
      if (!existing.length) {
        await fetch(url + '/rest/v1/disruptions', {
          method: 'POST',
          headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
          body: JSON.stringify({
            watched_id: w.id, ident,
            kind: /cancel/i.test(obs.status) ? 'CANCELLED' : 'DELAY',
            state: 'DETECTED', delay_minutes: obs.delay_minutes,
            detail: obs.status + ', ' + obs.delay_minutes + ' minutes'
          })
        });
        await audit(url, key, 'flight.delayed', {
          ident, delay_minutes: obs.delay_minutes, status: obs.status
        }, 'watched_order', w.order_id);
      }
    } catch (e) { /* the observation is already recorded */ }
  }

  return {
    summary: obs.status + (obs.delay_minutes ? ', ' + obs.delay_minutes + ' min late' : ', on time'),
    disrupted, delayMinutes: obs.delay_minutes
  };
}

// Re-price the exact same journey. Returns the cheapest offer that is not
// worse than what the traveller already holds.
async function bestComparable(w) {
  if (!process.env.DUFFEL_TOKEN) {
    // Deterministic stand in so the whole pipeline is demonstrable without a
    // supplier. Never used when a token is present.
    const drop = Math.round(w.paid_minor * 0.12);
    return {
      found: true, minor: w.paid_minor - drop, matchQuality: 'SAME_FLIGHT',
      scheduleChanged: false, offerId: 'mock_off_' + w.order_id
    };
  }

  const r = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.DUFFEL_TOKEN,
      'Duffel-Version': process.env.DUFFEL_VERSION || 'v2',
      'Content-Type': 'application/json', Accept: 'application/json'
    },
    body: JSON.stringify({
      data: {
        slices: [{ origin: w.origin, destination: w.destination, departure_date: w.depart_on }],
        passengers: Array.from({ length: w.passengers || 1 }, () => ({ type: 'adult' })),
        cabin_class: w.cabin || 'economy'
      }
    })
  });
  if (!r.ok) throw new Error('Duffel ' + r.status + ' ' + (await r.text()).slice(0, 200));

  const offers = ((await r.json()).data || {}).offers || [];
  let best = null;
  for (const o of offers) {
    const c = describe(o);
    if (c.minor <= 0) continue;
    if (c.stops > (w.stops || 0)) continue;                       // more connections is worse
    if ((w.bag_included === true) && !c.bagIncluded) continue;    // losing a bag is worse
    const quality = sameFlights(w.flight_numbers, c.flightNumbers) ? 'SAME_FLIGHT' : 'SAME_DAY';
    if (!best || c.minor < best.minor ||
        (c.minor === best.minor && quality === 'SAME_FLIGHT')) {
      best = { minor: c.minor, matchQuality: quality, offerId: c.id, scheduleChanged: false };
    }
  }
  return best ? Object.assign({ found: true }, best) : { found: false, matchQuality: null };
}

function describe(o) {
  const slices = o.slices || [];
  const nums = [];
  let stops = 0;
  slices.forEach((s) => {
    stops += Math.max(0, (s.segments || []).length - 1);
    (s.segments || []).forEach((seg) => {
      const code = (seg.marketing_carrier && seg.marketing_carrier.iata_code) || '';
      nums.push(code + String(seg.marketing_carrier_flight_number || ''));
    });
  });
  const fs = (slices[0] && slices[0].segments && slices[0].segments[0]) || {};
  const bags = ((fs.passengers || [])[0] || {}).baggages || [];
  const checked = bags.filter((b) => b.type === 'checked')[0];
  return {
    id: String(o.id), minor: Math.round(Number(o.total_amount) * 100) || 0,
    stops, flightNumbers: nums,
    bagIncluded: Boolean(checked && Number(checked.quantity) > 0)
  };
}

function sameFlights(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return false;
  const norm = (x) => String(x).toUpperCase().replace(/\s+/g, '');
  return a.map(norm).sort().join(',') === b.map(norm).sort().join(',');
}

async function propose(url, key, w, quote, delta, windowType, canAutoAct) {
  // Idempotent on the booking plus the price, so a scan running twice in the
  // same hour cannot create two proposals or two rebookings.
  const idem = 'fw_' + crypto.createHash('sha256')
    .update(w.order_id + '|' + quote.minor + '|' + windowType).digest('hex').slice(0, 24);

  const row = {
    watched_id: w.id,
    kind: canAutoAct ? 'AUTO_REBOOK' : 'PROPOSAL',
    window_type: windowType,
    from_minor: w.paid_minor, to_minor: quote.minor,
    benefit_minor: delta, currency: w.currency,
    status: canAutoAct ? 'READY' : 'PROPOSED',
    idempotency_key: idem
  };

  const r = await fetch(url + '/rest/v1/fare_actions', {
    method: 'POST',
    headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(row)
  });
  if (r.status === 409) return { status: 'ALREADY_KNOWN' };
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 160));

  await audit(url, key, canAutoAct ? 'fare.rebook_ready' : 'fare.drop_detected', {
    order: w.order_id, from_minor: w.paid_minor, to_minor: quote.minor,
    benefit_minor: delta, window: windowType, match: quote.matchQuality
  }, 'watched_order', w.order_id);

  return { status: row.status };
}

async function log(url, key, row) {
  try {
    await fetch(url + '/rest/v1/fare_checks', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(row)
    });
  } catch (e) { /* a lost log line must never stop a scan */ }
}
async function patch(url, key, id, fields) {
  try {
    await fetch(url + '/rest/v1/watched_orders?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(fields)
    });
  } catch (e) { /* same */ }
}
async function audit(url, key, type, payload, st, sid) {
  try {
    await fetch(url + '/rest/v1/rpc/append_audit', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_type: type, p_actor: 'fare-watcher', p_payload: payload, p_subject_type: st, p_subject_id: String(sid) })
    });
  } catch (e) { /* same */ }
}
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : d; }
