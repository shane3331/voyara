// GET /api/stays/search?destination=Milan&checkIn=...&checkOut=...&guests=2
//
// PRICING, honestly.
//
// LiteAPI and Hotelbeds are net rate suppliers. They do not pay a commission.
// They sell at wholesale and let you set retail. So the real story is not
// "we rebate a commission", it is:
//
//   cost    what Voyara pays the supplier
//   market  what an OTA would charge for the same room  (supplier's SSP)
//   yours   cost plus a small Voyara markup
//   saving  market minus yours
//
// That is a stronger claim than a rebate because it is arithmetic on real
// supplier numbers rather than an assumed commission rate.
const crypto = require('crypto');
const MARKUP = num(process.env.VOYARA_MARKUP, 0.04);
const ASSUMED_COMMISSION = num(process.env.RATE_HOTEL_COMMISSION, 0.15);

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const q = req.query || {};
  const destination = String(q.destination || '').trim();
  const checkIn = String(q.checkIn || '');
  const checkOut = String(q.checkOut || '');
  const guests = Math.max(1, Number(q.guests) || 2);

  if (!destination || !checkIn || !checkOut) {
    return res.status(400).end(JSON.stringify({ error: 'destination, checkIn and checkOut are required' }));
  }

  let mode = 'mock';
  let offers;
  try {
    // Hotelbeds first when available: net rates with no markup floor mean
    // the retail price is genuinely yours to set, which is a stronger
    // position than rebating a commission after the fact.
    if (process.env.HOTELBEDS_API_KEY && process.env.HOTELBEDS_SECRET) {
      offers = await hotelbeds(destination, checkIn, checkOut, guests);
      mode = 'live:hotelbeds';
    } else if (process.env.LITEAPI_KEY) {
      offers = await liteapi(destination, checkIn, checkOut, guests);
      mode = 'live:liteapi';
    } else {
      offers = fixtures(destination, checkIn, checkOut);
    }
  } catch (e) {
    return res.status(502).end(JSON.stringify({
      error: 'supplier_unavailable',
      detail: String(e && e.message ? e.message : e).slice(0, 500)
    }));
  }

  const priced = offers.map(priceOffer);

  res.status(200).end(JSON.stringify({ mode, count: priced.length, offers: priced }));
};

async function hotelbeds(destination, checkIn, checkOut, guests) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash('sha256')
    .update(process.env.HOTELBEDS_API_KEY + process.env.HOTELBEDS_SECRET + ts).digest('hex');
  const base = process.env.HOTELBEDS_BASE || 'https://api.test.hotelbeds.com';
  const r = await fetch(base + '/hotel-api/1.0/hotels', {
    method: 'POST',
    headers: {
      'Api-key': process.env.HOTELBEDS_API_KEY,
      'X-Signature': sig,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      stay: { checkIn, checkOut },
      occupancies: [{ rooms: 1, adults: guests, children: 0 }],
      destination: { code: destination }
    })
  });
  if (!r.ok) throw new Error('Hotelbeds ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const list = (j && j.hotels && j.hotels.hotels) || [];
  const n = nights(checkIn, checkOut);
  return list.slice(0, 12).map((h, i) => {
    const room = (h.rooms || [])[0] || {};
    const rt = (room.rates || [])[0] || {};
    const cancel = (rt.cancellationPolicies || [])[0];
    return {
      id: String(h.code || i),
      name: String(h.name || 'Property'),
      location: String(h.destinationName || destination),
      roomDescription: String(room.name || 'Room'),
      nights: n,
      publicMinor: Math.round(Number(rt.net || h.minRate || 0) * 100),
      currency: String((j.hotels && j.hotels.currency) || 'EUR'),
      freeCancellationUntil: cancel && cancel.from ? String(cancel.from) : null,
      payAtProperty: String(rt.paymentType || '') === 'AT_HOTEL',
      taxesIncluded: true
    };
  });
}

// Turns whatever a supplier gave us into one honest shape.
// costMinor is what we pay. marketMinor is what the market charges. If a
// supplier only gives one number we derive the other and say so.
function priceOffer(o) {
  let cost = o.costMinor;
  let market = o.marketMinor;
  let basis = 'supplier';

  if (!(cost > 0) && market > 0) {
    // Only a market price. Infer cost from the assumed commission.
    cost = Math.round(market * (1 - ASSUMED_COMMISSION));
    basis = 'derived';
  } else if (cost > 0 && !(market > 0)) {
    market = Math.round(cost / (1 - ASSUMED_COMMISSION));
    basis = 'derived';
  } else if (!(cost > 0) && !(market > 0)) {
    market = o.publicMinor || 0;
    cost = Math.round(market * (1 - ASSUMED_COMMISSION));
    basis = 'derived';
  }

  const yours = Math.round(cost * (1 + MARKUP));
  const saving = Math.max(0, market - yours);

  return Object.assign({}, o, {
    publicMinor: market,
    pricing: {
      basis,
      costMinor: cost,
      marketMinor: market,
      voyaraMinor: yours,
      savingMinor: saving,
      savingPct: market > 0 ? Math.round((saving / market) * 1000) / 10 : 0,
      markupPct: MARKUP,
      currency: o.currency,
      marketDisplay: money(market, o.currency),
      voyaraDisplay: money(yours, o.currency),
      savingDisplay: money(saving, o.currency),
      costDisplay: money(cost, o.currency),
      // Names the existing front end already reads.
      publicDisplay: money(market, o.currency),
      netDisplay: money(yours, o.currency),
      rebateDisplay: money(saving, o.currency),
      publicMinor: market,
      netMinor: yours,
      rebateMinor: saving
    }
  });
}

function money(minor, cur) {
  const sym = cur === 'EUR' ? '\u20AC' : cur === 'GBP' ? '\u00A3' : '$';
  const p = (Math.abs(minor) / 100).toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (minor < 0 ? '-' : '') + sym + p.join('.');
}
function num(v, d) { const x = Number(v); return Number.isFinite(x) && v !== undefined && v !== '' ? x : d; }

// LiteAPI (Nuitee). Self serve, free sandbox, no paperwork.
// Two steps, which is what their v3.0 REST API actually wants:
//   1. GET /data/hotels  -> hotel ids for a city
//   2. POST /hotels/rates -> live rates for those ids
// Names come from step one and are merged into the rates from step two.
const CITY_COUNTRY = {
  milan:'IT', rome:'IT', florence:'IT', venice:'IT', naples:'IT',
  paris:'FR', nice:'FR', lyon:'FR', london:'GB', edinburgh:'GB',
  madrid:'ES', barcelona:'ES', ibiza:'ES', lisbon:'PT', porto:'PT',
  athens:'GR', mykonos:'GR', santorini:'GR', amsterdam:'NL', berlin:'DE',
  munich:'DE', vienna:'AT', zurich:'CH', geneva:'CH', dubai:'AE',
  'new york':'US', miami:'US', 'los angeles':'US', chicago:'US', boston:'US',
  tokyo:'JP', kyoto:'JP', singapore:'SG', bangkok:'TH', bali:'ID',
  sydney:'AU', toronto:'CA', 'mexico city':'MX', cancun:'MX'
};

async function liteapi(destination, checkIn, checkOut, guests) {
  const apiKey = process.env.LITEAPI_KEY;
  const base = process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0';
  const currency = process.env.LITEAPI_CURRENCY || 'EUR';
  const nationality = process.env.LITEAPI_NATIONALITY || 'US';
  const city = String(destination).trim();
  const country = CITY_COUNTRY[city.toLowerCase()] || process.env.LITEAPI_COUNTRY || 'IT';
  const headers = { 'X-API-Key': apiKey, Accept: 'application/json' };

  // Step 1. Hotel ids and names for the city.
  const listUrl = base + '/data/hotels?countryCode=' + encodeURIComponent(country) +
    '&cityName=' + encodeURIComponent(city) + '&limit=20';
  const lr = await fetch(listUrl, { headers });
  if (!lr.ok) throw new Error('LiteAPI /data/hotels ' + lr.status + ' ' + (await lr.text()).slice(0, 300));
  const lj = await lr.json();
  const hotels = (lj && (lj.data || lj.hotels)) || [];
  if (!hotels.length) throw new Error('LiteAPI returned no hotels for ' + city + ' (' + country + ')');

  const nameById = {};
  const ids = [];
  hotels.slice(0, 20).forEach((h) => {
    const id = String(h.id || h.hotelId || '');
    if (!id) return;
    ids.push(id);
    nameById[id] = { name: String(h.name || 'Property'), address: String(h.address || h.city || city) };
  });

  // Step 2. Live rates for those ids.
  const rr = await fetch(base + '/hotels/rates', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify({
      hotelIds: ids,
      checkin: checkIn,
      checkout: checkOut,
      currency,
      guestNationality: nationality,
      occupancies: [{ adults: Math.max(1, guests) }]
    })
  });
  if (!rr.ok) throw new Error('LiteAPI /hotels/rates ' + rr.status + ' ' + (await rr.text()).slice(0, 300));
  const rj = await rr.json();
  const rates = (rj && rj.data) || [];
  const n = nights(checkIn, checkOut);

  const out = rates.map((h) => {
    const id = String(h.hotelId || h.id || '');
    const meta = nameById[id] || {};
    const rt = (h.roomTypes || [])[0] || {};
    const offer = (rt.rates || [])[0] || {};
    // offerRetailRate is what we pay. suggestedSellingPrice is what the
    // market charges. Both come straight from the supplier.
    const cost = pickAmount(rt.offerRetailRate, offer.retailRate && offer.retailRate.total);
    const market = pickAmount(rt.suggestedSellingPrice, offer.retailRate && offer.retailRate.suggestedSellingPrice);
    const cancelTag = (offer.cancellationPolicies && offer.cancellationPolicies.refundableTag) || null;
    return {
      id: id || String(Math.random()),
      offerId: String(rt.offerId || offer.rateId || ''),
      name: meta.name || String(h.name || 'Property'),
      location: meta.address || city,
      roomDescription: String(rt.roomTypeName || offer.name || 'Room'),
      nights: n,
      costMinor: cost.minor,
      marketMinor: market.minor || 0,
      publicMinor: market.minor || cost.minor,
      currency: cost.currency || market.currency || currency,
      refundable: cancelTag === 'RFN',
      freeCancellationUntil: cancelTag === 'RFN' ? 'refundable' : null,
      payAtProperty: false,
      taxesIncluded: true
    };
  }).filter((o) => o.costMinor > 0 || o.marketMinor > 0);

  if (!out.length) throw new Error('LiteAPI returned hotels but no bookable rates for those dates');
  return out.slice(0, 12);
}

// Supplier price fields arrive as either an object or an array of objects.
function pickAmount(a, b) {
  for (const src of [a, b]) {
    if (!src) continue;
    const o = Array.isArray(src) ? src[0] : src;
    if (!o) continue;
    const amt = Number(o.amount != null ? o.amount : o);
    if (Number.isFinite(amt) && amt > 0) {
      return { minor: Math.round(amt * 100), currency: o.currency || null };
    }
  }
  return { minor: 0, currency: null };
}

function fixtures(destination, checkIn, checkOut) {
  const n = nights(checkIn, checkOut);
  const mk = (id, name, room, marketMinor, refundable) => ({
    id, offerId: 'offer_' + id, name, location: destination,
    roomDescription: room, nights: n,
    costMinor: Math.round(marketMinor * 0.82),
    marketMinor, publicMinor: marketMinor, currency: 'EUR',
    refundable, freeCancellationUntil: refundable ? 'refundable' : null,
    payAtProperty: false, taxesIncluded: true
  });
  return [
    mk('mock_portrait', 'Portrait Milano', 'Suite, king bed', 318000, true),
    mk('mock_grand', 'Grand Hotel et de Milan', 'Deluxe room', 294000, true),
    mk('mock_bulgari', 'Bulgari Hotel Milano', 'Premium, garden view', 445000, false)
  ];
}

function nights(a, b) {
  const d1 = new Date(a).getTime(), d2 = new Date(b).getTime();
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d2 <= d1) return 5;
  return Math.round((d2 - d1) / 86400000);
}
function num(v, d) { const x = Number(v); return Number.isFinite(x) && v !== undefined && v !== '' ? x : d; }
function money(minor, cur) {
  const sym = cur === 'EUR' ? '\u20AC' : cur === 'GBP' ? '\u00A3' : '$';
  const p = (Math.abs(minor) / 100).toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (minor < 0 ? '-' : '') + sym + p.join('.');
}
