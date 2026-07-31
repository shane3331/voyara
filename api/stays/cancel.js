// POST /api/stays/cancel
//
// The half of booking nobody builds. Selling is easy. The first person who
// needs to cancel will teach you more about this product than the first
// hundred who book.
//
// Same guarantees as booking, for the same reasons:
//   1. Read the policy first and tell the traveller what they get back
//      BEFORE cancelling. A refund they did not expect is a complaint.
//   2. Idempotency. Cancelling twice must not double refund or error.
//   3. Verify after write. Retrieve the booking and confirm it is cancelled.
//   4. Ambiguity is never retried blindly.
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const b = await readJson(req);
  const bookingId = String(b.bookingId || '').trim();
  const idem = String(b.idempotencyKey || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const preview = b.preview === true;

  if (!bookingId) return bad(res, 'bookingId is required');
  if (!preview && !idem) return bad(res, 'idempotencyKey is required on a real cancellation');
  if (!preview && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'a valid email is required');

  const apiKey = process.env.LITEAPI_KEY || '';
  const base = process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0';
  const isSandbox = !apiKey || apiKey.indexOf('sand_') === 0;

  if (!isSandbox && process.env.ALLOW_LIVE_BOOKING !== 'true') {
    return res.status(403).end(JSON.stringify({
      error: 'live_cancellation_disabled',
      detail: 'This is a production key but ALLOW_LIVE_BOOKING is not true. Real cancellations are refused until that is set deliberately.'
    }));
  }

  if (!apiKey) {
    const q = quoteRefund({ refundable: true, penaltyMinor: 0, paidMinor: Number(b.paidMinor) || 254134, currency: b.currency || 'USD' });
    if (preview) return res.status(200).end(JSON.stringify({ mode: 'mock', preview: true, quote: q }));
    return res.status(200).end(JSON.stringify({
      mode: 'mock', cancelled: true, quote: q,
      verification: { verified: true, method: 'mock' },
      note: 'No LITEAPI_KEY set. Nothing was cancelled.'
    }));
  }

  const headers = {
    'X-API-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json',
    'Idempotency-Key': idem || ('preview_' + bookingId)
  };

  // 1. Read the booking and its cancellation terms first.
  let booking;
  try {
    const r = await fetch(base + '/bookings/' + encodeURIComponent(bookingId), { headers });
    if (r.status === 404) return res.status(404).end(JSON.stringify({ error: 'booking_not_found' }));
    if (!r.ok) throw new Error('lookup ' + r.status + ' ' + (await r.text()).slice(0, 200));
    booking = (await r.json()).data || {};
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'lookup_failed', detail: String(e.message).slice(0, 250) }));
  }

  const quote = quoteRefund(readPolicy(booking, b));

  // Preview stops here. The traveller sees the number before deciding.
  if (preview) {
    return res.status(200).end(JSON.stringify({
      mode: isSandbox ? 'sandbox:liteapi' : 'live:liteapi',
      preview: true, quote, booking: { id: bookingId, status: booking.status || null }
    }));
  }

  if (String(booking.status || '').toUpperCase() === 'CANCELLED') {
    return res.status(200).end(JSON.stringify({
      mode: 'already', cancelled: true, quote,
      note: 'This booking was already cancelled. Nothing changed.'
    }));
  }

  // 2. Cancel.
  let ambiguous = false, result = null;
  try {
    const r = await fetch(base + '/bookings/' + encodeURIComponent(bookingId), {
      method: 'DELETE', headers
    });
    const text = await r.text();
    if (r.ok) result = safeJson(text);
    else if (r.status >= 500 || r.status === 408 || r.status === 429) ambiguous = true;
    else return res.status(422).end(JSON.stringify({ error: 'cancellation_rejected', status: r.status, detail: text.slice(0, 400) }));
  } catch (e) { ambiguous = true; }

  if (ambiguous) {
    return res.status(202).end(JSON.stringify({
      status: 'AMBIGUOUS',
      detail: 'The cancellation call did not return a clear result. It may have succeeded. Retrying blindly could refund twice or leave the room held, so no second attempt was made.',
      nextStep: 'Retry with the SAME idempotencyKey (' + idem + ') or check the supplier dashboard.',
      idempotencyKey: idem, escalate: true
    }));
  }

  // 3. Verify after write.
  let verification = { verified: false, reason: 'not attempted' };
  try {
    const v = await fetch(base + '/bookings/' + encodeURIComponent(bookingId), { headers });
    if (v.ok) {
      const after = (await v.json()).data || {};
      const st = String(after.status || '').toUpperCase();
      verification = { verified: st === 'CANCELLED', status: st || null, checkedAt: new Date().toISOString() };
    } else verification = { verified: false, reason: 'retrieval returned ' + v.status };
  } catch (e) { verification = { verified: false, reason: String(e.message).slice(0, 180) }; }

  await record(req, {
    booking_id: bookingId, vertical: 'HOTEL', email,
    reason: b.reason ? String(b.reason).slice(0, 400) : null,
    policy_snapshot: quote.policy,
    refund_minor: quote.refundMinor, penalty_minor: quote.penaltyMinor,
    currency: quote.currency,
    status: verification.verified ? 'CANCELLED' : 'UNVERIFIED',
    idempotency_key: idem, verified: verification.verified
  }, email, quote, bookingId);

  res.status(verification.verified ? 200 : 502).end(JSON.stringify({
    mode: isSandbox ? 'sandbox:liteapi' : 'live:liteapi',
    cancelled: verification.verified, quote, verification, supplier: result || null,
    warning: verification.verified ? null
      : 'The cancellation was sent but could not be verified. Do not tell the traveller the room is released. Escalate to an operator.'
  }));
};

// What the traveller actually gets back, computed before anything is cancelled.
function readPolicy(booking, b) {
  const paid = Number(b.paidMinor) ||
    Math.round(Number((booking.price && booking.price.amount) || booking.totalAmount || 0) * 100);
  const currency = String(b.currency || booking.currency || 'USD').toUpperCase();
  const policies = (booking.cancellationPolicies || {});
  const tag = String(policies.refundableTag || booking.refundableTag || '').toUpperCase();
  const info = (policies.cancelPolicyInfos || [])[0] || {};
  const now = Date.now();
  const deadline = info.cancelTime ? new Date(info.cancelTime).getTime() : null;

  let refundable = tag === 'RFN';
  if (refundable && deadline && now > deadline) refundable = false;

  const penaltyMinor = refundable
    ? 0
    : Math.round(Number(info.amount || 0) * 100) || paid;

  return { refundable, penaltyMinor, paidMinor: paid, currency, deadline: info.cancelTime || null };
}

function quoteRefund(p) {
  const refund = Math.max(0, (p.paidMinor || 0) - (p.penaltyMinor || 0));
  return {
    refundable: Boolean(p.refundable),
    paidMinor: p.paidMinor || 0,
    penaltyMinor: p.penaltyMinor || 0,
    refundMinor: refund,
    currency: p.currency || 'USD',
    deadline: p.deadline || null,
    paidDisplay: money(p.paidMinor || 0, p.currency),
    penaltyDisplay: money(p.penaltyMinor || 0, p.currency),
    refundDisplay: money(refund, p.currency),
    summary: p.refundable
      ? 'Fully refundable. The full amount returns to the original payment method.'
      : refund > 0
        ? 'Past the free cancellation deadline. A penalty applies and the balance is refunded.'
        : 'Non refundable. Cancelling releases the room but returns nothing.',
    policy: { refundable: Boolean(p.refundable), deadline: p.deadline || null, penaltyMinor: p.penaltyMinor || 0 }
  };
}

// Records the cancellation and reverses any Voyara Cash earned on the booking.
async function record(req, row, email, quote, bookingId) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    await fetch(url + '/rest/v1/cancellations', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(row)
    });
  } catch (e) { /* the cancellation already happened at the supplier */ }
  try {
    await fetch(url + '/rest/v1/rpc/append_audit', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        p_type: 'reservation.cancelled', p_actor: 'traveler',
        p_payload: { booking: bookingId, refund_minor: quote.refundMinor, penalty_minor: quote.penaltyMinor, verified: row.verified },
        p_subject_type: 'booking', p_subject_id: bookingId
      })
    });
  } catch (e) { /* same */ }
  // Cash earned on a cancelled booking is reversed. Anything else is a leak.
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) {
      await fetch(String(req.headers['x-forwarded-proto'] || 'https') + '://' + host + '/api/cash', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reverse', email, reference: bookingId, reason: 'booking cancelled' })
      });
    }
  } catch (e) { /* same */ }
}

function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function bad(res, m) { return res.status(400).end(JSON.stringify({ error: m })); }
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function money(minor, cur) {
  const c = String(cur || 'USD').toUpperCase();
  const zero = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF'].indexOf(c) >= 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2 }).format(minor / 100);
  } catch (e) { return c + ' ' + (minor / 100).toFixed(zero ? 0 : 2); }
}
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
