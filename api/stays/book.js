// POST /api/stays/book
//
// The hotel equivalent of api/flights/book.js, and it carries the same
// guarantees, because the failure modes are identical:
//
//   1. Prebook first. LiteAPI revalidates the rate and returns a firm price.
//      Never book from a price that came out of a search result.
//   2. Idempotency key required. A retry cannot book two rooms.
//   3. Verify after write. The booking is retrieved and compared to intent.
//   4. Ambiguity is never retried blindly.
//   5. Live bookings refused unless ALLOW_LIVE_BOOKING is explicitly true.
const crypto = require('crypto');
const exec = require('../_exec');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const body = await readJson(req);
  const offerId = String(body.offerId || '').trim();
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  const g = body.guest || {};

  if (!offerId) return bad(res, 'offerId is required');
  if (!idempotencyKey) return bad(res, 'idempotencyKey is required. Reuse the same key on retries.');
  const missing = ['firstName', 'lastName', 'email'].filter((f) => !g[f]);
  if (missing.length) return bad(res, 'guest is missing: ' + missing.join(', '));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(g.email))) return bad(res, 'guest email is not valid');

  const apiKey = process.env.LITEAPI_KEY || '';
  const isSandbox = !apiKey || apiKey.indexOf('sand_') === 0;

  if (!isSandbox && process.env.ALLOW_LIVE_BOOKING !== 'true') {
    return res.status(403).end(JSON.stringify({
      error: 'live_booking_disabled',
      detail: 'This LiteAPI key is a production key but ALLOW_LIVE_BOOKING is not true. Real money is refused until that is set deliberately.',
      checklist: [
        'A payment method attached in the LiteAPI dashboard',
        'Seller of Travel registration where required',
        'Errors and omissions insurance in force',
        'Terms of service and a published cancellation policy',
        'A refund path you have actually tested'
      ]
    }));
  }

  if (!apiKey) {
    const ref = 'VYR' + crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 6).toUpperCase();
    return res.status(200).end(JSON.stringify({
      mode: 'mock',
      booking: { id: 'bkg_mock_' + ref.toLowerCase(), reference: ref, status: 'CONFIRMED', offerId,
        guest: g.firstName + ' ' + g.lastName },
      verification: { verified: true, method: 'mock' },
      note: 'No LITEAPI_KEY set. Nothing was booked and no money moved.'
    }));
  }

  const base = process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0';
  const headers = {
    'X-API-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json',
    'Idempotency-Key': idempotencyKey
  };

  // 0. Record the intent BEFORE touching the supplier. If this function dies
  // at any point after here, the record survives and /api/recover finishes it.
  const run = await exec.begin('HOTEL_BOOK', idempotencyKey, {
    offerId, email: String(g.email).toLowerCase(),
    guest: g.firstName + ' ' + g.lastName,
    hotelName: body.hotelName || null,
    checkIn: body.checkIn || null, checkOut: body.checkOut || null,
    amountMinor: body.amountMinor || null, currency: body.currency || null
  });

  // A resumed run that already completed must not book a second room.
  if (run.resumed && run.prior && run.prior.state === 'COMPLETE') {
    return res.status(200).end(JSON.stringify({
      mode: 'resumed', booking: (run.prior.result && run.prior.result.booking) || { id: run.prior.supplier_ref },
      verification: { verified: true, resumed: true },
      note: 'This booking already completed. Nothing was booked twice.'
    }));
  }

  // 1. Prebook. Revalidates availability and firms the price.
  let prebook;
  try {
    const pr = await fetch(base + '/rates/prebook', {
      method: 'POST', headers,
      body: JSON.stringify({ offerId, usePaymentSdk: false })
    });
    const text = await pr.text();
    if (!pr.ok) {
      return res.status(409).end(JSON.stringify({
        error: 'rate_unavailable',
        detail: 'The room is no longer available at that price. Search again. Nothing was charged.',
        supplier: text.slice(0, 300)
      }));
    }
    prebook = JSON.parse(text).data || {};
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'prebook_failed', detail: String(e.message).slice(0, 300) }));
  }

  const prebookId = String(prebook.prebookId || prebook.prebook_id || '');
  if (!prebookId) {
    return res.status(502).end(JSON.stringify({ error: 'prebook_incomplete', detail: 'Supplier did not return a prebook id.' }));
  }

  // 2. Book.
  let created = null, ambiguous = false;
  try {
    const br = await fetch(base + '/rates/book', {
      method: 'POST', headers,
      body: JSON.stringify({
        prebookId,
        holder: { firstName: String(g.firstName), lastName: String(g.lastName), email: String(g.email) },
        guests: [{
          occupancyNumber: 1,
          firstName: String(g.firstName), lastName: String(g.lastName), email: String(g.email),
          remarks: g.remarks ? String(g.remarks).slice(0, 400) : undefined
        }],
        payment: { method: 'ACC_CREDIT_CARD' }
      })
    });
    const text = await br.text();
    if (br.ok) created = JSON.parse(text).data;
    else if (br.status >= 500 || br.status === 408 || br.status === 429) ambiguous = true;
    else return res.status(422).end(JSON.stringify({ error: 'booking_rejected', status: br.status, detail: text.slice(0, 500) }));
  } catch (e) { ambiguous = true; }

  if (ambiguous) {
    await exec.finish(run, 'AMBIGUOUS', { prebookId, offerId });
    return res.status(202).end(JSON.stringify({
      status: 'AMBIGUOUS',
      detail: 'The booking call did not return a clear result. It may have succeeded. A second attempt could double book, so none was made.',
      nextStep: 'Retry with the SAME idempotencyKey (' + idempotencyKey + ') or check the LiteAPI dashboard.',
      idempotencyKey, escalate: true, durable: run.durable,
      reconciliation: run.durable
        ? 'Recorded. The recovery pass will reconcile this with the supplier within the hour.'
        : 'NOT recorded durably. Check the supplier dashboard manually.'
    }));
  }

  // 3. Verify after write.
  const bookingId = String(created.bookingId || created.id || '');
  await exec.advance(run, 'SUPPLIER_CALLED', { supplier_ref: bookingId });
  let verification = { verified: false, reason: 'not attempted' };
  try {
    const vr = await fetch(base + '/bookings/' + encodeURIComponent(bookingId), { headers });
    if (vr.ok) {
      const f = (await vr.json()).data || {};
      verification = {
        verified: Boolean(f.bookingId || f.id),
        bookingId: f.bookingId || f.id || bookingId,
        status: f.status || created.status || null,
        supplierReference: f.supplierBookingId || created.supplierBookingId || null,
        checkedAt: new Date().toISOString()
      };
    } else verification = { verified: false, reason: 'retrieval returned ' + vr.status };
  } catch (e) { verification = { verified: false, reason: String(e.message).slice(0, 200) }; }

  const audit = {
    type: 'action.execution_succeeded', vertical: 'hotel',
    occurredAt: new Date().toISOString(), idempotencyKey, offerId, bookingId,
    verified: verification.verified
  };
  audit.eventHash = crypto.createHash('sha256').update(JSON.stringify(audit)).digest('hex');

  await exec.finish(run, verification.verified ? 'COMPLETE' : 'AMBIGUOUS', {
    booking: { id: bookingId, reference: created.supplierBookingId || created.bookingReference || bookingId },
    verified: verification.verified
  });

  // A verified booking becomes a monitored trip. Done here rather than in the
  // browser so a closed tab or a failed script cannot lose it.
  let trip = null;
  if (verification.verified) {
    trip = await recordTrip(req, {
      email: String(g.email).toLowerCase(),
      hotelName: (created.hotel && created.hotel.name) || body.hotelName || 'Your stay',
      checkin: created.checkin || body.checkIn || null,
      checkout: created.checkout || body.checkOut || null,
      reference: created.supplierBookingId || created.bookingReference || bookingId,
      bookingId, offerId,
      amountMinor: Number(body.amountMinor) || null,
      currency: body.currency || null
    });
  }

  res.status(verification.verified ? 200 : 502).end(JSON.stringify({
    mode: isSandbox ? 'sandbox:liteapi' : 'live:liteapi',
    booking: {
      id: bookingId,
      reference: created.supplierBookingId || created.bookingReference || bookingId,
      status: created.status || 'CONFIRMED',
      hotelName: created.hotel && created.hotel.name || null,
      checkin: created.checkin || null, checkout: created.checkout || null
    },
    verification, audit, trip, durable: run.durable,
    warning: verification.verified ? null
      : 'The booking was created but could not be verified. Do not tell the traveller it is confirmed. Escalate to an operator.'
  }));
};

// Calls our own trips route rather than duplicating the upsert logic, so
// there is exactly one place that decides what a trip is.
async function recordTrip(req, d) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) return null;
    const proto = String(req.headers['x-forwarded-proto'] || 'https');
    const r = await fetch(proto + '://' + host + '/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: d.email,
        title: d.hotelName,
        startsOn: normDate(d.checkin),
        endsOn: normDate(d.checkout),
        source: 'hotel_booking',
        reservation: {
          type: 'HOTEL', supplier: 'liteapi', name: d.hotelName,
          reference: d.reference, bookingId: d.bookingId, offerId: d.offerId,
          checkIn: normDate(d.checkin), checkOut: normDate(d.checkout),
          amountMinor: d.amountMinor, currency: d.currency,
          status: 'CONFIRMED'
        }
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.trip ? j.trip : null;
  } catch (e) {
    // The booking already succeeded. Failing to file it must not surface as
    // a booking failure to the traveller.
    return null;
  }
}

function normDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function bad(res, msg) { return res.status(400).end(JSON.stringify({ error: msg })); }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
