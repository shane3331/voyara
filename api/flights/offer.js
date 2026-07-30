// GET /api/flights/offer?id=off_xxx
//
// Step 2 of booking. Fares move between search and purchase, so the offer
// is re-fetched and re-priced immediately before anyone is asked to commit.
// Never book from a price that came out of a search result.
const AIR_COMMISSION = num(process.env.RATE_AIR_COMMISSION, 0.01);
const AIR_KEEP = num(process.env.RATE_AIR_KEEP, 0.005);

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const id = String((req.query && req.query.id) || '').trim();
  if (!id) return res.status(400).end(JSON.stringify({ error: 'id is required' }));

  if (!process.env.DUFFEL_TOKEN) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock',
      offer: mockOffer(id),
      passengerRequirements: REQUIRED_FIELDS,
      note: 'Set DUFFEL_TOKEN to price a real offer.'
    }));
  }

  try {
    const r = await fetch('https://api.duffel.com/air/offers/' + encodeURIComponent(id), {
      headers: {
        Authorization: 'Bearer ' + process.env.DUFFEL_TOKEN,
        'Duffel-Version': process.env.DUFFEL_VERSION || 'v2',
        Accept: 'application/json'
      }
    });
    if (!r.ok) throw new Error('Duffel ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    const o = j.data || {};
    const publicMinor = Math.round(Number(o.total_amount) * 100) || 0;
    const currency = String(o.total_currency || 'EUR');
    const commission = Math.round(publicMinor * AIR_COMMISSION);
    const keep = Math.round(publicMinor * AIR_KEEP);
    const rebate = Math.max(0, commission - keep);

    const expired = o.expires_at ? new Date(o.expires_at).getTime() < Date.now() : false;

    res.status(200).end(JSON.stringify({
      mode: 'live:duffel',
      expired,
      offer: {
        id: String(o.id),
        carrierName: String((o.owner && o.owner.name) || ''),
        publicMinor,
        currency,
        expiresAt: o.expires_at || null,
        passengerIds: (o.passengers || []).map((p) => p.id)
      },
      pricing: {
        publicMinor, rebateMinor: rebate, netMinor: publicMinor - rebate, currency,
        publicDisplay: money(publicMinor, currency),
        netDisplay: money(publicMinor - rebate, currency),
        rebateDisplay: money(rebate, currency)
      },
      passengerRequirements: REQUIRED_FIELDS,
      note: expired
        ? 'This offer has expired. Search again before booking. Do not attempt to book it.'
        : 'Price confirmed with the supplier just now.'
    }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'supplier_unavailable', detail: String(e.message).slice(0, 400) }));
  }
};

const REQUIRED_FIELDS = ['given_name', 'family_name', 'born_on', 'gender', 'title', 'email', 'phone_number'];

function mockOffer(id) {
  return {
    id, carrierName: 'ITA Airways', publicMinor: 214800, currency: 'EUR',
    expiresAt: new Date(Date.now() + 240000).toISOString(), passengerIds: ['pas_mock_1']
  };
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : d; }
function money(minor, cur) {
  const c = String(cur || 'USD').toUpperCase();
  const zeroDecimal = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF'].indexOf(c) >= 0;
  const amount = minor / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: c,
      minimumFractionDigits: zeroDecimal ? 0 : 2,
      maximumFractionDigits: zeroDecimal ? 0 : 2
    }).format(amount);
  } catch (e) {
    return c + ' ' + amount.toFixed(zeroDecimal ? 0 : 2);
  }
}
