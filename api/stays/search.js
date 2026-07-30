// GET /api/stays/search?destination=Milan&checkIn=2026-09-13&checkOut=2026-09-18&guests=2
// Hotelbeds when credentials are set, deterministic fixtures otherwise.
const crypto = require('crypto');
const HOTEL_COMMISSION = num(process.env.RATE_HOTEL_COMMISSION, 0.15);
const HOTEL_KEEP = num(process.env.RATE_HOTEL_KEEP, 0.04);

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

  const priced = offers.map((o) => {
    const commission = Math.round(o.publicMinor * HOTEL_COMMISSION);
    const keep = Math.round(o.publicMinor * HOTEL_KEEP);
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

// LiteAPI (Nuitee). Self serve, free sandbox, no paperwork, and their
// sandbox is the same surface as production, which makes it the fastest
// way to get real hotel inventory on the page.
//
// VERIFY BEFORE TRUSTING: written to the documented shape but not executed
// against their servers from the build environment. Run
//   curl "$SITE/api/stays/search?destination=Milan&checkIn=...&checkOut=..."
// and confirm mode reads live:liteapi with sane prices.
async function liteapi(destination, checkIn, checkOut, guests) {
  const headers = {
    'X-API-Key': process.env.LITEAPI_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  const base = process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0';

  const r = await fetch(base + '/hotels/rates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      cityName: destination,
      countryCode: process.env.LITEAPI_COUNTRY || 'IT',
      checkin: checkIn,
      checkout: checkOut,
      currency: process.env.LITEAPI_CURRENCY || 'EUR',
      guestNationality: process.env.LITEAPI_NATIONALITY || 'US',
      occupancies: [{ adults: guests }],
      limit: 12
    })
  });
  if (!r.ok) throw new Error('LiteAPI ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const list = (j && j.data) || [];
  const n = nights(checkIn, checkOut);

  return list.slice(0, 12).map((h, i) => {
    const rooms = h.roomTypes || h.rooms || [];
    const rt = rooms[0] || {};
    const offer = (rt.rates || [])[0] || {};
    const retail = (rt.offerRetailRate || offer.retailRate || {});
    const amount = Number(retail.amount != null ? retail.amount : (rt.suggestedSellingPrice || 0));
    const cancel = (offer.cancellationPolicies && offer.cancellationPolicies.refundableTag) || null;
    return {
      id: String(h.hotelId || h.id || i),
      name: String(h.name || (h.hotelInfo && h.hotelInfo.name) || 'Property'),
      location: String((h.hotelInfo && h.hotelInfo.address) || destination),
      roomDescription: String(rt.roomTypeName || offer.name || 'Room'),
      nights: n,
      publicMinor: Math.round(amount * 100),
      currency: String(retail.currency || process.env.LITEAPI_CURRENCY || 'EUR'),
      freeCancellationUntil: cancel === 'RFN' ? 'refundable' : null,
      payAtProperty: false,
      taxesIncluded: true
    };
  }).filter((o) => o.publicMinor > 0);
}

function fixtures(destination, checkIn, checkOut) {
  const n = nights(checkIn, checkOut);
  return [
    { id: 'mock_portrait', name: 'Portrait Milano', location: destination, roomDescription: 'Suite, king bed', nights: n, publicMinor: 318000, currency: 'EUR', freeCancellationUntil: '2026-09-10T23:59:00+02:00', payAtProperty: false, taxesIncluded: true },
    { id: 'mock_grand', name: 'Grand Hotel et de Milan', location: destination, roomDescription: 'Deluxe room', nights: n, publicMinor: 294000, currency: 'EUR', freeCancellationUntil: '2026-09-08T23:59:00+02:00', payAtProperty: true, taxesIncluded: true },
    { id: 'mock_bulgari', name: 'Bulgari Hotel Milano', location: destination, roomDescription: 'Premium, garden view', nights: n, publicMinor: 445000, currency: 'EUR', freeCancellationUntil: null, payAtProperty: false, taxesIncluded: true }
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
