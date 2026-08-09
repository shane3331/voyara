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
// Quality tiers. Bedbank feeds skew mid market and, left alone, sort by
// price, which buries the good properties. Every search now asks the
// supplier for a floor and then re-sorts what comes back by quality.
//
// LiteAPI distinguishes starRating (the building and its facilities) from
// rating (what guests scored it). Both matter and they are not the same.
const TIERS = {
  any:     { stars: [],        minRating: 0,   minReviews: 0,   label: 'Everything' },
  premium: { stars: [4, 5],    minRating: 8.0, minReviews: 25,  label: 'Four star and above' },
  luxury:  { stars: [5],       minRating: 8.5, minReviews: 40,  label: 'Five star only' }
};

const SUPPORTED_CCY = ['USD','EUR','GBP','CHF','JPY','AUD','CAD','AED','SGD','MXN'];
const MARKUP = num(process.env.VOYARA_MARKUP, 0.04);
const ASSUMED_COMMISSION = num(process.env.RATE_HOTEL_COMMISSION, 0.15);

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const q = req.query || {};
  const destination = String(q.destination || '').trim();
  const checkIn = String(q.checkIn || '');
  const checkOut = String(q.checkOut || '');
  const guests = Math.max(1, Number(q.guests) || 2);
  const tierKey = TIERS[String(q.quality || 'premium')] ? String(q.quality || 'premium') : 'premium';
  const tier = TIERS[tierKey];
  const wanted = String(q.currency || '').toUpperCase();
  const currencyPref = SUPPORTED_CCY.indexOf(wanted) >= 0
    ? wanted : (process.env.LITEAPI_CURRENCY || 'USD');

  if (!destination || !checkIn || !checkOut) {
    return res.status(400).end(JSON.stringify({ error: 'destination, checkIn and checkOut are required' }));
  }
  for (const [d, label] of [[checkIn, 'checkIn'], [checkOut, 'checkOut']]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return res.status(400).end(JSON.stringify({ error: label + ' must be YYYY-MM-DD' }));
    }
  }
  if (new Date(checkOut) <= new Date(checkIn)) {
    return res.status(400).end(JSON.stringify({ error: 'checkOut must be after checkIn' }));
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
      offers = await liteapi(destination, checkIn, checkOut, guests, currencyPref, tier);
      mode = 'live:liteapi';
    } else {
      offers = fixtures(destination, checkIn, checkOut, currencyPref);
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 500);
    // A place with no inventory is not a supplier outage. Say which it is,
    // because falling back to fixtures and calling it a search is worse
    // than showing nothing.
    if (e && e.noResults) {
      return res.status(200).end(JSON.stringify({
        mode: mode, count: 0, offers: [], noResults: true, message: msg
      }));
    }
    return res.status(502).end(JSON.stringify({ error: 'supplier_unavailable', detail: msg }));
  }

  const priced = offers.map(priceOffer);

  res.status(200).end(JSON.stringify({
    mode, currency: currencyPref, quality: tierKey, qualityLabel: tier.label,
    // These were set as properties on the offers array, which JSON.stringify
    // silently drops, so neither has ever reached the browser.
    resolvedAs: offers.resolvedAs || null,
    relaxed: Boolean(offers.relaxed),
    count: priced.length, offers: priced
  }));
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
  const c = String(cur || 'USD').toUpperCase();
  // Currencies that do not use minor units in the wild. Amounts are still
  // stored as hundredths internally so the arithmetic stays integer, they
  // are just displayed without decimals.
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
function num(v, d) { const x = Number(v); return Number.isFinite(x) && v !== undefined && v !== '' ? x : d; }

// LiteAPI (Nuitee). Self serve, free sandbox, no paperwork.
// Two steps, which is what their v3.0 REST API actually wants:
//   1. GET /data/hotels  -> hotel ids for a city
//   2. POST /hotels/rates -> live rates for those ids
// Names come from step one and are merged into the rates from step two.
const CITY_COUNTRY = {
  'marrakech':'MA', 'marrakesh':'MA', 'casablanca':'MA', 'fez':'MA', 'fes':'MA', 'rabat':'MA', 'tangier':'MA', 'tanger':'MA', 'agadir':'MA', 'essaouira':'MA', 'chefchaouen':'MA', 'ouarzazate':'MA', 'merzouga':'MA', 'taghazout':'MA', 'asilah':'MA', 'cape town':'ZA', 'johannesburg':'ZA', 'durban':'ZA', 'stellenbosch':'ZA', 'nairobi':'KE', 'mombasa':'KE', 'zanzibar':'TZ', 'arusha':'TZ', 'serengeti':'TZ', 'cairo':'EG', 'luxor':'EG', 'aswan':'EG', 'sharm el sheikh':'EG', 'hurghada':'EG', 'tunis':'TN', 'algiers':'DZ', 'victoria falls':'ZW', 'windhoek':'NA', 'seychelles':'SC', 'mahe':'SC', 'praslin':'SC', 'port louis':'MU', 'mauritius':'MU', 'accra':'GH', 'lagos':'NG', 'dakar':'SN', 'addis ababa':'ET', 'kigali':'RW',

  // Italy
  milan:'IT', milano:'IT', rome:'IT', roma:'IT', florence:'IT', firenze:'IT', venice:'IT',
  venezia:'IT', naples:'IT', napoli:'IT', turin:'IT', bologna:'IT', verona:'IT', capri:'IT',
  positano:'IT', amalfi:'IT', sorrento:'IT', portofino:'IT', como:'IT', siena:'IT', taormina:'IT',
  // France
  paris:'FR', nice:'FR', cannes:'FR', lyon:'FR', marseille:'FR', bordeaux:'FR', 'saint tropez':'FR',
  // Spain
  madrid:'ES', barcelona:'ES', ibiza:'ES', seville:'ES', sevilla:'ES', valencia:'ES', malaga:'ES',
  marbella:'ES', palma:'ES', 'san sebastian':'ES', granada:'ES',
  // Portugal
  lisbon:'PT', lisboa:'PT', porto:'PT', faro:'PT', madeira:'PT',
  // Greece
  athens:'GR', mykonos:'GR', santorini:'GR', crete:'GR', corfu:'GR', rhodes:'GR', paros:'GR',
  // UK and Ireland
  london:'GB', edinburgh:'GB', bath:'GB', oxford:'GB', manchester:'GB', dublin:'IE',
  // Rest of Europe
  amsterdam:'NL', berlin:'DE', munich:'DE', hamburg:'DE', vienna:'AT', salzburg:'AT',
  zurich:'CH', geneva:'CH', zermatt:'CH', copenhagen:'DK', stockholm:'SE', oslo:'NO',
  reykjavik:'IS', prague:'CZ', budapest:'HU', warsaw:'PL', brussels:'BE', dubrovnik:'HR',
  split:'HR', istanbul:'TR', 'st moritz':'CH', courchevel:'FR',
  // Middle East
  dubai:'AE', 'abu dhabi':'AE', doha:'QA', 'tel aviv':'IL', muscat:'OM', riyadh:'SA',
  // Americas
  'new york':'US', 'new york city':'US', nyc:'US', miami:'US', 'los angeles':'US', la:'US',
  chicago:'US', boston:'US', 'san francisco':'US', aspen:'US', 'las vegas':'US', seattle:'US',
  austin:'US', 'new orleans':'US', charleston:'US', nashville:'US', honolulu:'US', maui:'US',
  toronto:'CA', vancouver:'CA', montreal:'CA', 'mexico city':'MX', cancun:'MX', tulum:'MX',
  'cabo san lucas':'MX', 'san jose del cabo':'MX', 'buenos aires':'AR', 'rio de janeiro':'BR',
  'sao paulo':'BR', lima:'PE', cartagena:'CO', bogota:'CO', santiago:'CL',
  // Asia Pacific
  tokyo:'JP', kyoto:'JP', osaka:'JP', singapore:'SG', bangkok:'TH', phuket:'TH', 'koh samui':'TH',
  bali:'ID', denpasar:'ID', jakarta:'ID', 'hong kong':'HK', seoul:'KR', taipei:'TW',
  'kuala lumpur':'MY', hanoi:'VN', 'ho chi minh city':'VN', male:'MV', colombo:'LK',
  mumbai:'IN', delhi:'IN', jaipur:'IN', udaipur:'IN', goa:'IN',
  sydney:'AU', melbourne:'AU', auckland:'NZ', queenstown:'NZ',
  // Africa
  marrakech:'MA', marrakesh:'MA', casablanca:'MA', fez:'MA', 'cape town':'ZA', johannesburg:'ZA',
  cairo:'EG', nairobi:'KE', zanzibar:'TZ', 'port louis':'MU'
};

// Country names, so someone typing "spain" gets Spain rather than nothing.
const COUNTRY_NAMES = {
  italy:'IT', italia:'IT', france:'FR', spain:'ES', espana:'ES', portugal:'PT', greece:'GR',
  'united kingdom':'GB', uk:'GB', england:'GB', scotland:'GB', britain:'GB', ireland:'IE',
  netherlands:'NL', holland:'NL', germany:'DE', austria:'AT', switzerland:'CH', denmark:'DK',
  sweden:'SE', norway:'NO', iceland:'IS', 'czech republic':'CZ', czechia:'CZ', hungary:'HU',
  poland:'PL', belgium:'BE', croatia:'HR', turkey:'TR', morocco:'MA',
  'united arab emirates':'AE', uae:'AE', qatar:'QA', israel:'IL', oman:'OM', 'saudi arabia':'SA',
  'united states':'US', usa:'US', us:'US', america:'US', canada:'CA', mexico:'MX',
  argentina:'AR', brazil:'BR', peru:'PE', colombia:'CO', chile:'CL',
  japan:'JP', singapore:'SG', thailand:'TH', indonesia:'ID', 'hong kong':'HK',
  'south korea':'KR', korea:'KR', taiwan:'TW', malaysia:'MY', vietnam:'VN', maldives:'MV',
  'sri lanka':'LK', india:'IN', australia:'AU', 'new zealand':'NZ',
  'south africa':'ZA', egypt:'EG', kenya:'KE', tanzania:'TZ', mauritius:'MU'
};

// A sensible city per country, used when someone names a country. Better to
// show a real city's inventory than to show nothing.
const COUNTRY_DEFAULT_CITY = {
  IT:'Rome', FR:'Paris', ES:'Barcelona', PT:'Lisbon', GR:'Athens', GB:'London', IE:'Dublin',
  NL:'Amsterdam', DE:'Berlin', AT:'Vienna', CH:'Zurich', DK:'Copenhagen', SE:'Stockholm',
  NO:'Oslo', IS:'Reykjavik', CZ:'Prague', HU:'Budapest', PL:'Warsaw', BE:'Brussels',
  HR:'Dubrovnik', TR:'Istanbul', MA:'Marrakech', AE:'Dubai', QA:'Doha', IL:'Tel Aviv',
  OM:'Muscat', SA:'Riyadh', US:'New York', CA:'Toronto', MX:'Cancun', AR:'Buenos Aires',
  BR:'Rio de Janeiro', PE:'Lima', CO:'Cartagena', CL:'Santiago', JP:'Tokyo', SG:'Singapore',
  TH:'Bangkok', ID:'Bali', HK:'Hong Kong', KR:'Seoul', TW:'Taipei', MY:'Kuala Lumpur',
  VN:'Hanoi', MV:'Male', LK:'Colombo', IN:'Mumbai', AU:'Sydney', NZ:'Auckland',
  ZA:'Cape Town', EG:'Cairo', KE:'Nairobi', TZ:'Zanzibar', MU:'Port Louis'
};

// Turns whatever someone typed into a city and a country code.
// Handles "Milan", "milan, italy", "Spain", and "Amalfi Coast".
function resolvePlace(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const parts = raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

  // "City, Country"
  if (parts.length > 1) {
    const cc = COUNTRY_NAMES[parts[parts.length - 1]] || String(parts[parts.length - 1]).toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) {
      return { ok: true, cityName: titleCase(parts[0]), countryCode: cc, label: titleCase(parts[0]) };
    }
  }

  const one = parts[0];
  if (CITY_COUNTRY[one]) {
    return { ok: true, cityName: titleCase(one), countryCode: CITY_COUNTRY[one], label: titleCase(one) };
  }
  if (COUNTRY_NAMES[one]) {
    const cc = COUNTRY_NAMES[one];
    return {
      ok: true, cityName: COUNTRY_DEFAULT_CITY[cc] || '', countryCode: cc,
      label: titleCase(one), wasCountry: true
    };
  }
  // Unknown word. Do NOT guess a country: defaulting to Italy meant a search
  // for Agadir quietly queried Milan and came back empty, which reads as
  // "we have no hotels in Morocco" rather than "we do not know that place".
  // Passing the name with no country lets the supplier do the matching, and
  // the flag lets the caller say what happened if nothing comes back.
  return {
    ok: true, cityName: titleCase(one), countryCode: null,
    unknown: true, label: titleCase(one)
  };
}

function titleCase(s) {
  return String(s).split(' ').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
}

async function liteapi(destination, checkIn, checkOut, guests, currencyPref, tier) {
  const apiKey = process.env.LITEAPI_KEY;
  const base = process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0';
  const currency = currencyPref || process.env.LITEAPI_CURRENCY || 'USD';
  const nationality = process.env.LITEAPI_NATIONALITY || 'US';
  const headers = { 'X-API-Key': apiKey, Accept: 'application/json' };

  // Ask the supplier where the place is rather than consulting a list we
  // maintain by hand. A hardcoded table of a couple of hundred cities will
  // never cover the world, and every city missing from it looked to a
  // traveller like a city with no hotels. Detroit was the one that caught it.
  async function resolveWithSupplier(text) {
    try {
      const r = await fetch(base + '/data/places?textQuery=' + encodeURIComponent(text), { headers });
      if (!r.ok) return null;
      const j = await r.json();
      const hit = ((j && j.data) || [])[0];
      if (!hit || !hit.placeId) return null;
      return {
        placeId: hit.placeId,
        label: hit.displayName || text,
        formatted: hit.formattedAddress || ''
      };
    } catch (e) { return null; }
  }

  const supplierPlace = await resolveWithSupplier(destination);

  // The hand written table is now only a fallback for when the supplier's own
  // lookup is unavailable, not the primary way places are understood.
  const place = resolvePlace(destination);
  const city = place.cityName || '';
  const country = place.countryCode;

  async function lookup(cityName, cc) {
    const useCountry = cc || country;
    // The supplier requires a country. Without one there is nothing to ask, so
    // say that rather than sending the literal string "null" and getting an
    // empty list that looks like "no hotels here".
    if (!useCountry) return [];
    const u = base + '/data/hotels?countryCode=' + encodeURIComponent(useCountry) +
      (cityName ? '&cityName=' + encodeURIComponent(cityName) : '') +
      (tier.stars.length ? '&starRating=' + tier.stars.join(',') : '') +
      (tier.minRating ? '&minRating=' + tier.minRating : '') +
      (tier.minReviews ? '&minReviewsCount=' + tier.minReviews : '') +
      '&limit=40';
    const res = await fetch(u, { headers });
    if (!res.ok) throw new Error('LiteAPI /data/hotels ' + res.status + ' ' + (await res.text()).slice(0, 250));
    const jj = await res.json();
    return (jj && (jj.data || jj.hotels)) || [];
  }

  let hotels = [];
  let resolvedAs = '';
  let placeId = null;

  if (supplierPlace) {
    // A place the supplier recognises is passed straight through, which is
    // what makes any city on earth work rather than only the listed ones.
    placeId = supplierPlace.placeId;
    resolvedAs = supplierPlace.formatted
      ? supplierPlace.label + ', ' + supplierPlace.formatted
      : supplierPlace.label;
  } else {
    hotels = await lookup(city);
    resolvedAs = city ? city + ', ' + country : country;
  }

  if (!placeId && !hotels.length && city) {
    // The city did not match. Fall back to the country.
    hotels = await lookup('');
    resolvedAs = country;
  }
  if (!hotels.length && COUNTRY_DEFAULT_CITY[country]) {
    hotels = await lookup(COUNTRY_DEFAULT_CITY[country]);
    resolvedAs = COUNTRY_DEFAULT_CITY[country] + ', ' + country;
  }
  if (!placeId && !hotels.length) {
    // An unknown place and a known place with no inventory are different
    // problems and deserve different sentences.
    const e = new Error(place.unknown
      ? 'We do not recognise "' + destination + '" yet. Try the city, or add the country, ' +
        'for example "Essaouira, Morocco".'
      : 'No properties available in ' + (place.label || destination) +
        ' for those dates. Try different dates, or a lower standard.');
    e.noResults = true;
    throw e;
  }

  const nameById = {};
  const ids = [];
  hotels.slice(0, 20).forEach((h) => {
    const id = String(h.id || h.hotelId || '');
    if (!id) return;
    ids.push(id);
    nameById[id] = {
      name: String(h.name || 'Property'),
      address: String(h.address || h.city || city),
      // The property's own lead photo. /hotels/rates does not return imagery,
      // so this is the only place in the flow it is available.
      image: firstImage(h),
      stars: Number(h.stars || h.starRating || 0) || null,
      rating: Number(h.rating || 0) || null
    };
  });

  // Step 2. Live rates for those ids.
  const rr = await fetch(base + '/hotels/rates', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(Object.assign({
      // A placeId covers everywhere the supplier knows about. A list of ids is
      // the fallback for when its place lookup was unavailable.
      ...(placeId ? { placeId, includeHotelData: true, limit: 40 } : { hotelIds: ids }),
      checkin: checkIn,
      checkout: checkOut,
      currency,
      guestNationality: nationality,
      occupancies: [{ adults: Math.max(1, guests) }]
    }, tier.stars.length ? {
      starRating: tier.stars,
      minRating: tier.minRating,
      minReviewsCount: tier.minReviews
    } : {}))
  });
  if (!rr.ok) throw new Error('LiteAPI /hotels/rates ' + rr.status + ' ' + (await rr.text()).slice(0, 300));
  const rj = await rr.json();
  const rates = (rj && rj.data) || [];

  // With includeHotelData the names, photos and ratings arrive alongside the
  // rates, so the separate lookup is not needed on the placeId path.
  ((rj && rj.hotels) || []).forEach((h) => {
    const id = String(h.id || h.hotelId || '');
    if (!id) return;
    nameById[id] = {
      name: String(h.name || 'Property'),
      address: String(h.address || h.city || ''),
      image: firstImage(h),
      stars: Number(h.stars || h.starRating || 0) || null,
      rating: Number(h.rating || 0) || null
    };
  });
  const n = nights(checkIn, checkOut);

  if (!rates.length) {
    const e = new Error('No properties available in ' + (resolvedAs || destination) +
      ' for those dates. Try different dates, or a lower standard.');
    e.noResults = true;
    throw e;
  }

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
      location: meta.address || place.label || city,
      image: meta.image || firstImage(h) || '',
      stars: meta.stars || null,
      rating: meta.rating || null,
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

  // Backstop. If the supplier ignores a filter, enforce it here rather than
  // showing a two star motel in a luxury search.
  let kept = out;
  if (tier.stars.length) {
    const strict = out.filter((o) =>
      (!o.stars || tier.stars.indexOf(o.stars) >= 0) &&
      (!o.rating || o.rating >= tier.minRating));
    // Only apply the floor if it leaves a usable set. An empty page is worse
    // than a slightly looser one, so long as we say which happened.
    if (strict.length >= 3) kept = strict;
    else if (strict.length) { kept = strict; kept.relaxed = false; }
    else { kept = out; kept.relaxed = true; }
  }

  // Sort by quality, not price. A five star at 8.0 outranks a four star at
  // 9.4, but not by much, so a strong boutique still surfaces.
  kept.sort((a, b) => qualityScore(b) - qualityScore(a));

  if (!kept.length) {
    const e = new Error('Properties exist in ' + resolvedAs + ' but none are bookable for those dates. Try different dates.');
    e.noResults = true;
    throw e;
  }
  const result = kept.slice(0, 12);
  result.resolvedAs = resolvedAs;
  result.relaxed = Boolean(kept.relaxed);
  return result;
}

// Suppliers name the lead photo half a dozen different ways. Take the first
// usable one rather than assuming a single field exists.
function firstImage(h) {
  if (!h) return '';
  // Check every candidate in order. Do not let one bad field discard a good
  // one: some suppliers put a placeholder in main_photo but a real thumbnail.
  const candidates = [h.main_photo, h.mainPhoto, h.thumbnail, h.image, h.photo]
    .concat([].concat(h.hotelImages || h.images || [])
      .map((i) => (typeof i === 'string' ? i : (i && (i.urlHd || i.url || i.hd || i.thumbnail)))));
  for (const c of candidates) {
    const u = normaliseUrl(c);
    if (u) return u;
  }
  return '';
}

function normaliseUrl(u) {
  if (typeof u !== 'string') return '';
  const t = u.trim();
  if (/^https?:\/\//i.test(t)) return t;
  // Protocol relative, which several image CDNs still return.
  if (/^\/\/[^/]/.test(t)) return 'https:' + t;
  return '';
}

// Supplier price fields arrive as either an object or an array of objects.
// Ranking. Stars lead, because a five star property is a different category
// of building. But a property guests actively dislike is a worn out property
// whatever its plaque says, so anything under 7.5 takes a steep penalty and
// drops below a well run four star.
function qualityScore(o) {
  const stars = Number(o.stars) || 0;
  const rating = Number(o.rating) || 0;
  const penalty = rating > 0 && rating < 7.5 ? (7.5 - rating) * 3 : 0;
  return (stars * 1.6) + (rating / 2) - penalty;
}

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

function fixtures(destination, checkIn, checkOut, cur) {
  const n = nights(checkIn, checkOut);
  const shots = [
    'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=600&q=70&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=600&q=70&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=600&q=70&auto=format&fit=crop'
  ];
  let shot = -1;
  const mk = (id, name, room, marketMinor, refundable, stars, rating) => ({
    id, offerId: 'offer_' + id, name, location: destination,
    image: shots[++shot % shots.length], stars: stars || 5, rating: rating || 9.1,
    roomDescription: room, nights: n,
    costMinor: Math.round(marketMinor * 0.82),
    marketMinor, publicMinor: marketMinor, currency: cur || 'USD',
    refundable, freeCancellationUntil: refundable ? 'refundable' : null,
    payAtProperty: false, taxesIncluded: true
  });
  return [
    mk('mock_bulgari', 'Bulgari Hotel Milano', 'Premium, garden view', 445000, false, 5, 9.4),
    mk('mock_portrait', 'Portrait Milano', 'Suite, king bed', 318000, true, 5, 9.2),
    mk('mock_grand', 'Grand Hotel et de Milan', 'Deluxe room', 294000, true, 5, 8.9)
  ];
}

function nights(a, b) {
  const d1 = new Date(a).getTime(), d2 = new Date(b).getTime();
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d2 <= d1) return 5;
  return Math.round((d2 - d1) / 86400000);
}
function num(v, d) { const x = Number(v); return Number.isFinite(x) && v !== undefined && v !== '' ? x : d; }
