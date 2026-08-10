// POST /api/checkout  { source? }  -> client secret for the embedded Payment Element
//
// The membership is the business model. Commission goes back to the traveller,
// so this subscription is what actually funds the platform.
//
// This used to return a Stripe hosted Checkout url and send the traveller to
// stripe.com. It now creates the subscription in an incomplete state and hands
// back a client secret, so the card is collected inside our own sheet and
// nobody ever leaves the site. Stripe still renders the card field itself, in
// an iframe we style, which is what keeps this out of PCI scope.
const { verifyCaller, dbConfigured } = require('./_auth');
const { guard } = require('./_guard');

// Pinned deliberately. The shape of latest_invoice.payment_intent has moved
// between versions, and an account whose default version changes underneath us
// would break the payment step with no deploy and no warning.
const STRIPE_VERSION = '2024-06-20';

module.exports = async (req, res) => {
  if (guard(req, res, { limit: { name: 'checkout', max: 8, windowMs: 60000 } })) return;
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const sk = process.env.STRIPE_SECRET_KEY;
  const pk = process.env.STRIPE_PUBLISHABLE_KEY;
  const price = process.env.STRIPE_PRICE_ID;
  const body = await readJson(req);

  // The membership belongs to whoever is signed in. It is never taken from the
  // request, or somebody can buy a membership onto another person's account.
  const caller = dbConfigured() ? await verifyCaller(req) : null;
  const email = caller ? String(caller.email || '').trim().toLowerCase() : '';

  if (!email) {
    return res.status(401).end(JSON.stringify({
      error: 'sign_in_required',
      detail: 'Sign in before joining, so the membership attaches to your account.'
    }));
  }

  // Fail loudly about the publishable key too. Without it the browser cannot
  // mount the payment form at all, and a missing key here used to look like a
  // silent dead button.
  if (!sk || !price || !pk) {
    const missing = [];
    if (!sk) missing.push('STRIPE_SECRET_KEY');
    if (!pk) missing.push('STRIPE_PUBLISHABLE_KEY');
    if (!price) missing.push('STRIPE_PRICE_ID');
    return res.status(200).end(JSON.stringify({
      mode: 'mock', clientSecret: null, missing: missing,
      message: 'Set ' + missing.join(', ') + ' to take a real payment.'
    }));
  }

  try {
    const customer = await findOrCreateCustomer(sk, email);
    if (customer.error) return fail(res, customer.error);

    // Already paying. Say so rather than opening a second subscription.
    const active = await stripe(sk, 'GET',
      '/v1/subscriptions?customer=' + encodeURIComponent(customer.id) + '&status=active&limit=1');
    const trialing = await stripe(sk, 'GET',
      '/v1/subscriptions?customer=' + encodeURIComponent(customer.id) + '&status=trialing&limit=1');
    if ((active.data && active.data.length) || (trialing.data && trialing.data.length)) {
      return res.status(200).end(JSON.stringify({ mode: 'live', alreadyMember: true }));
    }

    // Reuse an abandoned attempt rather than littering the account with
    // incomplete subscriptions every time somebody opens the sheet.
    let sub = null;
    const incomplete = await stripe(sk, 'GET',
      '/v1/subscriptions?customer=' + encodeURIComponent(customer.id) +
      '&status=incomplete&limit=1&expand[]=data.latest_invoice.payment_intent');
    if (incomplete.data && incomplete.data.length && usableSecret(incomplete.data[0])) {
      sub = incomplete.data[0];
    }

    if (!sub) {
      const form = new URLSearchParams();
      form.set('customer', customer.id);
      form.set('items[0][price]', price);
      form.set('items[0][quantity]', '1');
      // Creates the subscription unpaid and hands us a payment intent to
      // confirm in the browser, instead of charging a card we do not have yet.
      form.set('payment_behavior', 'default_incomplete');
      form.set('payment_settings[save_default_payment_method]', 'on_subscription');
      form.set('expand[]', 'latest_invoice.payment_intent');
      form.set('metadata[tier]', 'founding');
      form.set('metadata[email]', email);
      form.set('metadata[source]', String(body.source || 'site').slice(0, 40));
      // No subscription_data here. That parameter belongs to a Checkout
      // Session, and the Subscriptions API rejects the whole request for it.
      // metadata above is already set on the subscription itself.

      sub = await stripe(sk, 'POST', '/v1/subscriptions', form, {
        // Two taps on a slow connection must not become two subscriptions.
        'Idempotency-Key': 'sub_' + customer.id + '_' + price
      });
      if (sub.error) return fail(res, sub.error);
    }

    const pi = sub.latest_invoice && sub.latest_invoice.payment_intent;
    if (!pi || !pi.client_secret) {
      return res.status(502).end(JSON.stringify({
        error: 'no_client_secret',
        detail: 'Stripe created the subscription but returned no payment to confirm. Check that STRIPE_PRICE_ID is a recurring price, not a one time one.'
      }));
    }

    const inv = sub.latest_invoice || {};
    res.status(200).end(JSON.stringify({
      mode: 'live',
      publishableKey: pk,
      clientSecret: pi.client_secret,
      subscriptionId: sub.id,
      customerId: customer.id,
      amountMinor: typeof inv.amount_due === 'number' ? inv.amount_due : null,
      currency: (inv.currency || 'usd').toUpperCase(),
      email: email
    }));
  } catch (e) {
    res.status(502).end(JSON.stringify({
      error: 'stripe_unreachable',
      detail: String(e && e.message).slice(0, 200)
    }));
  }
};

// A reused incomplete subscription is only useful if its payment intent can
// still be confirmed. A cancelled or missing one means start again.
function usableSecret(sub) {
  const pi = sub && sub.latest_invoice && sub.latest_invoice.payment_intent;
  if (!pi || !pi.client_secret) return false;
  return ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing']
    .indexOf(pi.status) >= 0;
}

async function findOrCreateCustomer(sk, email) {
  const found = await stripe(sk, 'GET', '/v1/customers?limit=1&email=' + encodeURIComponent(email));
  if (found.error) return { error: found.error };
  if (found.data && found.data.length) return found.data[0];

  const form = new URLSearchParams();
  form.set('email', email);
  form.set('metadata[product]', 'voyara-membership');
  const made = await stripe(sk, 'POST', '/v1/customers', form, {
    'Idempotency-Key': 'cus_' + email
  });
  if (made.error) return { error: made.error };
  return made;
}

// One place that talks to Stripe, so the version header and error shape cannot
// drift between calls.
async function stripe(sk, method, path, form, extraHeaders) {
  const headers = {
    Authorization: 'Bearer ' + sk,
    'Stripe-Version': STRIPE_VERSION
  };
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  Object.keys(extraHeaders || {}).forEach((k) => { headers[k] = extraHeaders[k]; });

  const r = await fetch('https://api.stripe.com' + path, {
    method: method,
    headers: headers,
    body: form || undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: (j.error && j.error.message) || ('Stripe returned ' + r.status) };
  return j;
}

function fail(res, detail) {
  return res.status(502).end(JSON.stringify({ error: 'stripe_error', detail: String(detail).slice(0, 300) }));
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
