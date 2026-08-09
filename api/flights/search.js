// GET /api/flights/search?origin=JFK&destination=MIL&departOn=2026-09-12&returnOn=2026-09-18
//
// A return date adds a second slice. Without one this route only ever searched
// one way, which meant the returning field in the form was decorative.
// Duffel when DUFFEL_TOKEN is set, deterministic fixtures otherwise.
const AIR_COMMISSION = num(process.env.RATE_AIR_COMMISSION, 0.01);
const AIR_KEEP = num(process.env.RATE_AIR_KEEP, 0.005);

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const q = req.query || {};
  const origin = String(q.origin || '').toUpperCase().trim();
  const destination = String(q.destination || '').toUpperCase().trim();
  const departOn = String(q.departOn || '');
  const returnOn = String(q.returnOn || '');
  const passengers = Math.max(1, Number(q.passengers) || 1);

  if (!origin || !destination || !departOn) {
    return res.status(400).end(JSON.stringify({ error: 'origin, destination and departOn are required' }));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departOn)) {
    return res.status(400).end(JSON.stringify({ error: 'departOn must be YYYY-MM-DD' }));
  }
  if (returnOn && !/^\d{4}-\d{2}-\d{2}$/.test(returnOn)) {
    return res.status(400).end(JSON.stringify({ error: 'returnOn must be YYYY-MM-DD' }));
  }
  if (returnOn && returnOn < departOn) {
    return res.status(400).end(JSON.stringify({ error: 'returnOn cannot be before departOn' }));
  }

  let mode = 'mock';
  let offers;
  try {
    if (process.env.DUFFEL_TOKEN) {
      offers = await duffel(origin, destination, departOn, passengers, returnOn);
      mode = 'live:duffel';
    } else {
      offers = fixtures(origin, destination, departOn, returnOn);
    }
  } catch (e) {
    return res.status(502).end(JSON.stringify({
      error: 'supplier_unavailable',
      detail: String(e && e.message ? e.message : e).slice(0, 500)
    }));
  }

  const priced = offers.map((o) => {
    const commission = Math.round(o.publicMinor * AIR_COMMISSION);
    const keep = Math.round(o.publicMinor * AIR_KEEP);
    const rebate = Math.max(0, commission - keep);
    return Object.assign({}, o, {
      pricing: {
        publicMinor: o.publicMinor,
        commissionMinor: commission,
        keepMinor: keep,
        rebateMinor: rebate,
        netMinor: o.publicMinor - rebate,
        currency: o.currency,
        publicDisplay: money(o.publicMinor, o.currency),
        netDisplay: money(o.publicMinor - rebate, o.currency),
        rebateDisplay: money(rebate, o.currency)
      }
    });
  });

  res.status(200).end(JSON.stringify({ mode, count: priced.length, offers: priced }));
};

async function duffel(origin, destination, departOn, passengers, returnOn) {
  const r = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.DUFFEL_TOKEN,
      'Duffel-Version': process.env.DUFFEL_VERSION || 'v2',
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      data: {
        slices: returnOn
          ? [{ origin, destination, departure_date: departOn },
             { origin: destination, destination: origin, departure_date: returnOn }]
          : [{ origin, destination, departure_date: departOn }],
        passengers: Array.from({ length: passengers }, () => ({ type: 'adult' })),
        cabin_class: 'economy'
      }
    })
  });
  if (!r.ok) throw new Error('Duffel ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const list = (j && j.data && j.data.offers) || [];
  return list.slice(0, 12).map((o) => {
    const slices = o.slices || [];
    const first = slices[0] || {};
    const last = slices[slices.length - 1] || {};
    const fs = (first.segments || [])[0] || {};
    const ls = (last.segments || [])[(last.segments || []).length - 1] || {};
    const bags = ((fs.passengers || [])[0] || {}).baggages || [];
    const checked = bags.filter((b) => b.type === 'checked')[0];
    return {
      id: String(o.id),
      carrier: String((o.owner && o.owner.iata_code) || ''),
      carrierName: String((o.owner && o.owner.name) || 'Carrier'),
      // Duffel ships the airline mark with the offer, so there is no reason to
      // fetch it from anywhere else or to guess at a logo CDN.
      carrierLogo: String((o.owner && (o.owner.logo_symbol_url || o.owner.logo_lockup_url)) || ''),
      segments: slices.map((s) => (s.origin || {}).iata_code + ' to ' + (s.destination || {}).iata_code).join(', '),
      departAt: String(fs.departing_at || ''),
      arriveAt: String(ls.arriving_at || ''),
      stops: slices.reduce((n, s) => n + Math.max(0, (s.segments || []).length - 1), 0),
      publicMinor: Math.round(Number(o.total_amount) * 100) || 0,
      currency: String(o.total_currency || 'EUR'),
      bagIncluded: Boolean(checked && Number(checked.quantity) > 0),
      changeable: Boolean(o.conditions && o.conditions.change_before_departure && o.conditions.change_before_departure.allowed),
      refundable: Boolean(o.conditions && o.conditions.refund_before_departure && o.conditions.refund_before_departure.allowed),
      expiresAt: o.expires_at ? String(o.expires_at) : null
    };
  });
}

function fixtures(origin, destination, departOn, returnOn) {
  // A return trip costs more than a single leg, so the fixture says so rather
  // than quietly showing one way prices under a round trip heading.
  const legs = returnOn ? 2 : 1;
  const leg = (v) => Math.round(v * (legs === 2 ? 1.78 : 1));
  return [
    { id: 'mock_az631', carrier: 'AZ', carrierName: 'ITA Airways', carrierLogo: 'https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/AZ.svg', segments: origin + ' to ' + destination + (returnOn ? ' and back' : ''), departAt: departOn + 'T18:40:00Z', arriveAt: departOn + 'T15:20:00Z', stops: 1, publicMinor: leg(214800), currency: 'EUR', bagIncluded: true, changeable: true, refundable: false, expiresAt: new Date(Date.now() + 240000).toISOString() },
    { id: 'mock_az605', carrier: 'AZ', carrierName: 'ITA Airways', carrierLogo: 'https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/AZ.svg', segments: origin + ' to ' + destination + (returnOn ? ' and back' : ''), departAt: departOn + 'T22:10:00Z', arriveAt: departOn + 'T12:05:00Z', stops: 0, publicMinor: leg(239000), currency: 'EUR', bagIncluded: true, changeable: true, refundable: false, expiresAt: new Date(Date.now() + 240000).toISOString() },
    { id: 'mock_lh401', carrier: 'LH', carrierLogo: 'https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/LH.svg', carrierName: 'Lufthansa', segments: origin + ' to ' + destination + (returnOn ? ' and back' : ''), departAt: departOn + 'T16:05:00Z', arriveAt: departOn + 'T13:40:00Z', stops: 1, publicMinor: leg(190500), currency: 'EUR', bagIncluded: false, changeable: false, refundable: false, expiresAt: new Date(Date.now() + 240000).toISOString() }
  ];
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
