// POST /api/checkout  { email }  -> Stripe Checkout session for membership
//
// The membership is the business model. Commission goes back to the traveller,
// so this subscription is what actually funds the platform.
const { verifyCaller, dbConfigured } = require('./_auth');
const { guard } = require('./_guard');

module.exports = async (req, res) => {
  if (guard(req, res, { limit: { name: 'checkout', max: 8, windowMs: 60000 } })) return;
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const sk = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_PRICE_ID;
  const body = await readJson(req);
  // The membership belongs to whoever is signed in, not to whatever address
  // the request supplies, or somebody can buy a membership onto another
  // person's account.
  const caller = dbConfigured() ? await verifyCaller(req) : null;
  const email = caller ? caller.email : String(body.email || '').trim().toLowerCase();

  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).end(JSON.stringify({ error: 'that does not look like an email address' }));
  }

  if (!sk || !price) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock', url: null,
      message: 'Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID to take a real payment.'
    }));
  }

  const site = process.env.SITE_URL ||
    ('https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'localhost'));

  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', price);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', site + '/?membership=active&session={CHECKOUT_SESSION_ID}');
  form.set('cancel_url', site + '/?membership=cancelled');
  form.set('allow_promotion_codes', 'true');
  form.set('billing_address_collection', 'auto');
  if (email) form.set('customer_email', email);
  // Carried through to the webhook so the membership can be attributed.
  form.set('metadata[tier]', 'founding');
  form.set('metadata[source]', String(body.source || 'site').slice(0, 40));
  form.set('subscription_data[metadata][tier]', 'founding');

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + sk,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form
    });
    const j = await r.json();
    if (!r.ok) {
      return res.status(502).end(JSON.stringify({
        error: 'stripe_error',
        detail: (j.error && j.error.message) || 'unknown'
      }));
    }
    res.status(200).end(JSON.stringify({ mode: 'live', url: j.url, id: j.id }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'stripe_unreachable', detail: String(e.message).slice(0, 200) }));
  }
};

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
