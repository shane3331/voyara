// GET /api/stays/hotel?id=lp2f87f&checkIn=...&checkOut=...&guests=2
//
// Everything needed for a property page: photos, description, amenities,
// address, and every bookable room with honest pricing on each.
const MARKUP = num(process.env.VOYARA_MARKUP, 0.04);
const ASSUMED_COMMISSION = num(process.env.RATE_HOTEL_COMMISSION, 0.15);

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const q = req.query || {};
  const id = String(q.id || '').trim();
  const checkIn = String(q.checkIn || '');
  const checkOut = String(q.checkOut || '');
  const guests = Math.max(1, Number(q.guests) || 2);

  if (!id) return res.status(400).end(JSON.stringify({ error: 'id is required' }));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).end(JSON.stringify({ error: 'id is not a valid hotel identifier' }));
  }
  for (const [d, label] of [[checkIn, 'checkIn'], [checkOut, 'checkOut']]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return res.status(400).end(JSON.stringify({ error: label + ' must be YYYY-MM-DD' }));
    }
  }

  if (!process.env.LITEAPI_KEY) {
    return res.status(200).end(JSON.stringify({ mode: 'mock', hotel: mockHotel(id), rooms: mockRooms() }));
  }

  const base = process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0';
  const currency = process.env.LITEAPI_CURRENCY || 'EUR';
  const headers = { 'X-API-Key': process.env.LITEAPI_KEY, Accept: 'application/json' };

  try {
    // Property content: photos, description, amenities.
    const dr = await fetch(base + '/data/hotel?hotelId=' + encodeURIComponent(id), { headers });
    if (!dr.ok) throw new Error('LiteAPI /data/hotel ' + dr.status + ' ' + (await dr.text()).slice(0, 250));
    const dj = await dr.json();
    const h = (dj && (dj.data || dj)) || {};

    const images = []
      .concat(h.hotelImages || h.images || [])
      .map((i) => (typeof i === 'string' ? i : (i.urlHd || i.url || i.hd || '')))
      .filter(Boolean).slice(0, 12);

    const hotel = {
      id,
      name: String(h.name || 'Property'),
      address: String(h.address || ''),
      city: String(h.city || ''),
      country: String(h.country || ''),
      stars: Number(h.stars || h.starRating || 0) || null,
      rating: Number(h.rating || 0) || null,
      description: stripHtml(String(h.hotelDescription || h.description || '')).slice(0, 1400),
      checkinTime: (h.checkinCheckoutTimes && h.checkinCheckoutTimes.checkin) || null,
      checkoutTime: (h.checkinCheckoutTimes && h.checkinCheckoutTimes.checkout) || null,
      images,
      amenities: []
        .concat(h.hotelFacilities || h.facilities || h.amenities || [])
        .map((a) => (typeof a === 'string' ? a : (a.name || ''))).filter(Boolean).slice(0, 18)
    };

    // Every bookable room for these dates.
    let rooms = [];
    if (checkIn && checkOut) {
      const rr = await fetch(base + '/hotels/rates', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({
          hotelIds: [id], checkin: checkIn, checkout: checkOut, currency,
          guestNationality: process.env.LITEAPI_NATIONALITY || 'US',
          occupancies: [{ adults: guests }]
        })
      });
      if (rr.ok) {
        const rj = await rr.json();
        const entry = ((rj && rj.data) || [])[0] || {};
        const n = nights(checkIn, checkOut);
        rooms = (entry.roomTypes || []).map((rt, idx) => {
          const offer = (rt.rates || [])[0] || {};
          const cost = pickAmount(rt.offerRetailRate, offer.retailRate && offer.retailRate.total);
          const market = pickAmount(rt.suggestedSellingPrice, offer.retailRate && offer.retailRate.suggestedSellingPrice);
          const cp = offer.cancellationPolicies || {};
          return price({
            offerId: String(rt.offerId || ''),
            rateId: String(offer.rateId || ''),
            name: String(rt.roomTypeName || offer.name || 'Room'),
            board: String(offer.boardName || offer.boardType || ''),
            maxOccupancy: Number(offer.maxOccupancy || offer.adultCount || 0) || null,
            bedType: bedOf(offer, rt),
            sizeSqm: Number(rt.roomSizeSquareMeters || rt.size || 0) || null,
            description: stripHtml(String(rt.roomTypeDescription || rt.description || '')).slice(0, 320),
            // Room level photography where the supplier has it, otherwise a
            // frame from the property gallery so every card has an image.
            images: roomImages(rt, images, idx),
            inclusions: inclusionsOf(offer, rt, cp),
            nights: n,
            costMinor: cost.minor,
            marketMinor: market.minor,
            currency: cost.currency || market.currency || currency,
            refundable: cp.refundableTag === 'RFN',
            cancellationNote: describeCancellation(cp)
          });
        }).filter((r) => r.pricing.voyaraMinor > 0)
          .sort((a, b) => a.pricing.voyaraMinor - b.pricing.voyaraMinor);
      }
    }

    res.status(200).end(JSON.stringify({ mode: 'live:liteapi', hotel, rooms }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'supplier_unavailable', detail: String(e.message).slice(0, 400) }));
  }
};

function price(r) {
  let cost = r.costMinor, market = r.marketMinor, basis = 'supplier';
  if (!(cost > 0) && market > 0) { cost = Math.round(market * (1 - ASSUMED_COMMISSION)); basis = 'derived'; }
  else if (cost > 0 && !(market > 0)) { market = Math.round(cost / (1 - ASSUMED_COMMISSION)); basis = 'derived'; }
  const yours = Math.round(cost * (1 + MARKUP));
  const saving = Math.max(0, market - yours);
  return Object.assign({}, r, {
    pricing: {
      basis, costMinor: cost, marketMinor: market, voyaraMinor: yours, savingMinor: saving,
      savingPct: market > 0 ? Math.round((saving / market) * 1000) / 10 : 0,
      currency: r.currency,
      marketDisplay: money(market, r.currency),
      voyaraDisplay: money(yours, r.currency),
      savingDisplay: money(saving, r.currency),
      perNightDisplay: r.nights ? money(Math.round(yours / r.nights), r.currency) : null
    }
  });
}

function roomImages(rt, hotelImages, idx) {
  const own = []
    .concat(rt.photos || rt.roomTypeImages || rt.images || [])
    .map((i) => (typeof i === 'string' ? i : (i && (i.urlHd || i.url || i.hd))))
    .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  if (own.length) return own.slice(0, 6);
  if (hotelImages && hotelImages.length) {
    const start = idx % hotelImages.length;
    return hotelImages.slice(start).concat(hotelImages.slice(0, start)).slice(0, 3);
  }
  return [];
}

function bedOf(offer, rt) {
  const b = (offer.bedTypes || rt.bedTypes || [])[0];
  if (!b) return null;
  if (typeof b === 'string') return b;
  const qty = Number(b.quantity || 1);
  const name = String(b.bedType || b.name || '').toLowerCase();
  if (!name) return null;
  return (qty > 1 ? qty + ' ' : '') + name.charAt(0).toUpperCase() + name.slice(1) + (qty > 1 ? ' beds' : ' bed');
}

// What the traveller actually gets, phrased the way a hotel would phrase it.
function inclusionsOf(offer, rt, cp) {
  const out = [];
  const board = String(offer.boardName || offer.boardType || '').toLowerCase();
  if (board && board !== 'room only' && board !== 'ro') {
    out.push(board.charAt(0).toUpperCase() + board.slice(1));
  } else if (board) {
    out.push('Room only');
  }
  if (cp && cp.refundableTag === 'RFN') out.push('Free cancellation before the deadline');
  else out.push('Non refundable rate');
  if (offer.maxOccupancy) out.push('Sleeps up to ' + offer.maxOccupancy);
  out.push('Taxes and fees included in the price shown');
  [].concat(offer.rateAmenities || rt.amenities || [])
    .map((a) => (typeof a === 'string' ? a : (a && a.name)))
    .filter(Boolean).slice(0, 4).forEach((a) => out.push(String(a)));
  return out.slice(0, 7);
}

function describeCancellation(cp) {
  if (!cp) return 'Cancellation terms confirmed at the next step.';
  if (cp.refundableTag !== 'RFN') return 'Non refundable. This rate cannot be cancelled or repriced.';
  const info = (cp.cancelPolicyInfos || [])[0];
  if (info && info.cancelTime) return 'Free cancellation until ' + String(info.cancelTime).slice(0, 16).replace('T', ' ');
  return 'Free cancellation. Repricing watcher will keep shopping this rate.';
}
function stripHtml(s) { return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function pickAmount(a, b) {
  for (const src of [a, b]) {
    if (!src) continue;
    const o = Array.isArray(src) ? src[0] : src;
    if (!o) continue;
    const amt = Number(o.amount != null ? o.amount : o);
    if (Number.isFinite(amt) && amt > 0) return { minor: Math.round(amt * 100), currency: o.currency || null };
  }
  return { minor: 0, currency: null };
}
function nights(a, b) {
  const d1 = new Date(a).getTime(), d2 = new Date(b).getTime();
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d2 <= d1) return 1;
  return Math.round((d2 - d1) / 86400000);
}
function num(v, d) { const x = Number(v); return Number.isFinite(x) && v !== undefined && v !== '' ? x : d; }
function money(minor, cur) {
  const sym = cur === 'EUR' ? '\u20AC' : cur === 'GBP' ? '\u00A3' : '$';
  const p = (Math.abs(minor) / 100).toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (minor < 0 ? '-' : '') + sym + p.join('.');
}
function mockHotel(id) {
  return {
    id, name: 'Portrait Milano', address: 'Corso Venezia 11', city: 'Milan', country: 'IT',
    stars: 5, rating: 9.2,
    description: 'A former seminary on Corso Venezia, reopened as a hotel around the largest private courtyard in the city. Rooms face the cloister rather than the street.',
    checkinTime: '14:00', checkoutTime: '11:00',
    images: [
      'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=1400&q=70&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1400&q=70&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=1400&q=70&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=1400&q=70&auto=format&fit=crop'
    ],
    amenities: ['Spa', 'Restaurant', 'Bar', 'Room service', 'Concierge', 'Air conditioning', 'Free wifi', 'Fitness centre']
  };
}
function mockRooms() {
  const shots = [
    'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=1200&q=70&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1590490360182-c33d57733427?w=1200&q=70&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1611892440504-42a792e24d32?w=1200&q=70&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1618773928121-c32242e63f39?w=1200&q=70&auto=format&fit=crop'
  ];
  let k = -1;
  const mk = (offerId, name, board, marketMinor, refundable, desc, bed, sqm) => price({
    offerId, rateId: 'rate_' + offerId, name, board, maxOccupancy: 2, nights: 5,
    bedType: bed, sizeSqm: sqm, description: desc,
    images: [shots[++k % shots.length], shots[(k + 1) % shots.length], shots[(k + 2) % shots.length]],
    inclusions: [board, refundable ? 'Free cancellation before the deadline' : 'Non refundable rate',
      'Sleeps up to 2', 'Taxes and fees included in the price shown'],
    costMinor: Math.round(marketMinor * 0.82), marketMinor, currency: 'EUR',
    refundable,
    cancellationNote: refundable ? 'Free cancellation until 10 Sep 2026' : 'Non refundable. This rate cannot be cancelled or repriced.'
  });
  return [
    mk('offer_deluxe', 'Deluxe Room, courtyard view', 'Breakfast included', 298000, true,
       'First floor rooms facing the cloister, away from the street, with a marble bath and a writing desk under the window.', 'King bed', 34),
    mk('offer_junior', 'Junior Suite', 'Breakfast included', 356000, true,
       'A separate sitting area and double aspect windows over the courtyard. Quietest rooms in the building.', 'King bed', 48),
    mk('offer_suite', 'Suite, king bed', 'Room only', 318000, false,
       'Corner suite on the third floor with the original vaulted ceiling retained during the restoration.', 'King bed', 55),
    mk('offer_grand', 'Grand Suite, terrace', 'Breakfast included', 512000, true,
       'The only room with a private terrace over the courtyard. Sleeps four with the sofa bed made up.', '2 King beds', 78)
  ];
}
