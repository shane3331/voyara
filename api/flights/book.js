// POST /api/flights/book
//
// The only route in this codebase that can spend a customer's money.
// It is written defensively on purpose.
//
// Guarantees:
//   1. Idempotency. The same key never creates two orders, so a retry,
//      a double click, or a network timeout cannot buy two tickets.
//   2. Verify after write. The order is retrieved from the supplier and
//      compared to what was intended. A 200 from a supplier is a claim,
//      not proof.
//   3. Ambiguity is never retried. If the create call fails in a way that
//      might have succeeded, the response says so and asks a human to
//      check, rather than trying again and risking a double charge.
//   4. Live bookings are blocked unless ALLOW_LIVE_BOOKING is explicitly
//      set to true, so a live token alone cannot start selling tickets.
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const body = await readJson(req);
  const offerId = String(body.offerId || '').trim();
  const passengers = Array.isArray(body.passengers) ? body.passengers : [];
  const idempotencyKey = String(body.idempotencyKey || '').trim();

  if (!offerId) return bad(res, 'offerId is required');
  if (!idempotencyKey) return bad(res, 'idempotencyKey is required. Generate one per booking attempt and reuse it on retries.');
  if (!passengers.length) return bad(res, 'at least one passenger is required');

  for (let i = 0; i < passengers.length; i++) {
    const missing = REQUIRED.filter((f) => !passengers[i][f]);
    if (missing.length) return bad(res, 'passenger ' + i + ' is missing: ' + missing.join(', '));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(passengers[i].born_on))) {
      return bad(res, 'passenger ' + i + ' born_on must be YYYY-MM-DD');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(passengers[i].email))) {
      return bad(res, 'passenger ' + i + ' email is not valid');
    }
  }

  const token = process.env.DUFFEL_TOKEN || '';
  const isTest = !token || token.indexOf('duffel_test') === 0;

  // Safety gate. A live token is not on its own permission to sell.
  if (!isTest && process.env.ALLOW_LIVE_BOOKING !== 'true') {
    return res.status(403).end(JSON.stringify({
      error: 'live_booking_disabled',
      detail: 'This token is live but ALLOW_LIVE_BOOKING is not set to true. Real money is refused until that is set deliberately.',
      checklist: LAUNCH_CHECKLIST
    }));
  }

  if (!token) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock',
      order: mockOrder(offerId, passengers, idempotencyKey),
      verification: { verified: true, method: 'mock' },
      note: 'No DUFFEL_TOKEN set. Nothing was booked and no money moved.'
    }));
  }

  const headers = {
    Authorization: 'Bearer ' + token,
    'Duffel-Version': process.env.DUFFEL_VERSION || 'v2',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // Duffel honours this so a repeated request returns the original order
    // instead of creating a second one.
    'Idempotency-Key': idempotencyKey
  };

  // Re-price immediately before committing. Fares move.
  let confirmed;
  try {
    const pr = await fetch('https://api.duffel.com/air/offers/' + encodeURIComponent(offerId), { headers });
    if (!pr.ok) throw new Error('offer lookup ' + pr.status);
    confirmed = (await pr.json()).data || {};
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'offer_unavailable', detail: String(e.message).slice(0, 300) }));
  }

  if (confirmed.expires_at && new Date(confirmed.expires_at).getTime() < Date.now()) {
    return res.status(409).end(JSON.stringify({
      error: 'offer_expired',
      detail: 'The supplier quote expired before purchase. Search again. Nothing was charged.'
    }));
  }

  const payload = {
    data: {
      type: 'instant',
      selected_offers: [offerId],
      passengers: confirmed.passengers && confirmed.passengers.length
        ? confirmed.passengers.map((p, i) => Object.assign({ id: p.id }, clean(passengers[i] || passengers[0])))
        : passengers.map(clean),
      payments: [{
        type: body.paymentType || 'balance',
        amount: String(confirmed.total_amount),
        currency: String(confirmed.total_currency)
      }]
    }
  };

  let created = null;
  let ambiguous = false;
  try {
    const cr = await fetch('https://api.duffel.com/air/orders', {
      method: 'POST', headers, body: JSON.stringify(payload)
    });
    const text = await cr.text();
    if (cr.ok) {
      created = JSON.parse(text).data;
    } else if (cr.status >= 500 || cr.status === 408 || cr.status === 429) {
      // Might have landed on their side. Do not retry blindly.
      ambiguous = true;
    } else {
      return res.status(422).end(JSON.stringify({
        error: 'booking_rejected', status: cr.status, detail: text.slice(0, 500)
      }));
    }
  } catch (e) {
    ambiguous = true;
  }

  if (ambiguous) {
    return res.status(202).end(JSON.stringify({
      status: 'AMBIGUOUS',
      detail: 'The create call did not return a clear result. It may have succeeded. A second attempt could double book and double charge, so none was made.',
      nextStep: 'Retry this exact request with the SAME idempotencyKey (' + idempotencyKey + '). If the order exists, Duffel returns it rather than creating another.',
      idempotencyKey,
      escalate: true
    }));
  }

  // Verify after write. A success response is a claim, not proof.
  let verification = { verified: false, reason: 'not attempted' };
  try {
    const vr = await fetch('https://api.duffel.com/air/orders/' + encodeURIComponent(created.id), { headers });
    if (vr.ok) {
      const fetched = (await vr.json()).data || {};
      const amountMatches = String(fetched.total_amount) === String(confirmed.total_amount);
      const hasDocs = Array.isArray(fetched.documents) ? fetched.documents.length > 0 : null;
      verification = {
        verified: Boolean(fetched.id) && amountMatches,
        orderId: fetched.id,
        bookingReference: fetched.booking_reference || null,
        amountMatches,
        ticketed: hasDocs,
        checkedAt: new Date().toISOString()
      };
    } else {
      verification = { verified: false, reason: 'order retrieval returned ' + vr.status };
    }
  } catch (e) {
    verification = { verified: false, reason: String(e.message).slice(0, 200) };
  }

  const audit = {
    type: 'action.execution_succeeded',
    occurredAt: new Date().toISOString(),
    idempotencyKey,
    offerId,
    orderId: created.id,
    amountMinor: Math.round(Number(confirmed.total_amount) * 100),
    currency: confirmed.total_currency,
    verified: verification.verified
  };
  audit.eventHash = crypto.createHash('sha256').update(JSON.stringify(audit)).digest('hex');

  res.status(verification.verified ? 200 : 502).end(JSON.stringify({
    mode: isTest ? 'test:duffel' : 'live:duffel',
    order: {
      id: created.id,
      bookingReference: created.booking_reference || null,
      totalAmount: created.total_amount,
      currency: created.total_currency
    },
    verification,
    audit,
    warning: verification.verified ? null
      : 'The order was created but could not be verified. Do not tell the traveller it is confirmed. Escalate to an operator.'
  }));
};

const REQUIRED = ['given_name', 'family_name', 'born_on', 'gender', 'title', 'email', 'phone_number'];

const LAUNCH_CHECKLIST = [
  'Duffel account verified and switched to live mode',
  'A funded Duffel Balance, or Duffel Payments enabled as merchant of record',
  'Seller of Travel registration where required (California, Florida, Hawaii, Iowa, Washington)',
  'Errors and omissions insurance in force',
  'Terms of service and privacy policy published',
  'A tested refund and cancellation path, not just a booking path'
];

function clean(p) {
  return {
    given_name: String(p.given_name), family_name: String(p.family_name),
    born_on: String(p.born_on), gender: String(p.gender).toLowerCase().slice(0, 1),
    title: String(p.title).toLowerCase(), email: String(p.email),
    phone_number: String(p.phone_number)
  };
}
function mockOrder(offerId, passengers, key) {
  return {
    id: 'ord_mock_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 10),
    bookingReference: 'MOCK' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 3).toUpperCase(),
    totalAmount: '2148.00', currency: 'EUR', offerId,
    passengers: passengers.map((p) => p.given_name + ' ' + p.family_name)
  };
}
function bad(res, msg) { return res.status(400).end(JSON.stringify({ error: msg })); }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
