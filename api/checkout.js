// POST /api/checkout  -> Stripe membership subscription
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock',
      message: 'Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID to take a real payment.',
      url: null
    }));
  }
  const site = process.env.SITE_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host));
  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('line_items[0][price]', process.env.STRIPE_PRICE_ID);
  body.set('line_items[0][quantity]', '1');
  body.set('success_url', site + '/?membership=active');
  body.set('cancel_url', site + '/?membership=cancelled');
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).end(JSON.stringify({ error: 'stripe_error', detail: (j.error || {}).message }));
    res.status(200).end(JSON.stringify({ mode: 'live', url: j.url, id: j.id }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'stripe_unreachable', detail: String(e.message) }));
  }
};
