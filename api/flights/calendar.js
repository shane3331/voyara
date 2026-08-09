// GET /api/flights/calendar?origin=TVC&destination=CUN&month=2026-11&passengers=1
//
// The cheapest fare for each day of a month, so somebody can see where the
// good days are instead of guessing one date at a time.
//
// No supplier offers this as a single call, so it is one search per day. That
// is slow and expensive, which is why this route:
//   * caps how many days it will price in one request
//   * runs them a few at a time rather than all at once
//   * caches the answer per route and month
//   * returns what it actually got, and marks the rest unknown rather than
//     inventing a number. A made up fare on a calendar is worse than a gap,
//     because somebody will plan around it.

const CACHE = new Map();
const TTL_MS = 10 * 60 * 1000;
const CONCURRENCY = 6;
const MAX_DAYS = 31;

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const q = req.query || {};
  const origin = String(q.origin || '').toUpperCase().trim();
  const destination = String(q.destination || '').toUpperCase().trim();
  const month = String(q.month || '').trim();
  const passengers = Math.max(1, Math.min(9, Number(q.passengers) || 1));

  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) {
    return res.status(400).end(JSON.stringify({ error: 'origin and destination must be three letter codes' }));
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).end(JSON.stringify({ error: 'month must be YYYY-MM' }));
  }

  const key = [origin, destination, month, passengers].join('|');
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return res.status(200).end(JSON.stringify(Object.assign({ cached: true }, hit.payload)));
  }

  const days = daysOf(month);
  const today = new Date().toISOString().slice(0, 10);
  // Nothing to price in the past, and no reason to spend a supplier call on it.
  const askable = days.filter((d) => d >= today).slice(0, MAX_DAYS);

  const token = process.env.DUFFEL_TOKEN;
  let prices = {};
  let mode = 'mock';

  if (token) {
    mode = 'live:duffel';
    prices = await priceDays(askable, origin, destination, passengers, token);
  } else {
    prices = mockCurve(askable, origin, destination);
  }

  const known = Object.keys(prices).filter((d) => prices[d] && prices[d].minor > 0);
  const cheapest = known.length
    ? known.reduce((a, b) => (prices[a].minor <= prices[b].minor ? a : b))
    : null;
  const values = known.map((d) => prices[d].minor).sort((a, b) => a - b);
  // A "good" day is in the cheapest third of the days we actually priced,
  // which is a comparison rather than a claim about the market.
  const goodBelow = values.length ? values[Math.floor(values.length / 3)] : 0;

  const payload = {
    mode, month, origin, destination, passengers,
    currency: (known.length && prices[known[0]].currency) || 'USD',
    cheapestOn: cheapest,
    cheapestMinor: cheapest ? prices[cheapest].minor : null,
    days: days.map((d) => ({
      date: d,
      past: d < today,
      minor: prices[d] ? prices[d].minor : null,
      display: prices[d] ? prices[d].display : null,
      good: Boolean(prices[d] && goodBelow && prices[d].minor <= goodBelow),
      cheapest: d === cheapest
    }))
  };

  CACHE.set(key, { at: Date.now(), payload });
  return res.status(200).end(JSON.stringify(payload));
};

// A few at a time. Thirty parallel searches will be rate limited, and one at a
// time takes a minute.
async function priceDays(dates, origin, destination, passengers, token) {
  const out = {};
  let i = 0;
  async function worker() {
    while (i < dates.length) {
      const d = dates[i++];
      try {
        const p = await cheapestFor(d, origin, destination, passengers, token);
        if (p) out[d] = p;
      } catch (e) { /* a day we could not price stays unknown */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dates.length) }, worker));
  return out;
}

async function cheapestFor(date, origin, destination, passengers, token) {
  const r = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Duffel-Version': 'v2',
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      data: {
        slices: [{ origin, destination, departure_date: date }],
        passengers: Array.from({ length: passengers }, () => ({ type: 'adult' })),
        cabin_class: 'economy'
      }
    })
  });
  if (!r.ok) return null;
  const j = await r.json();
  const offers = (j && j.data && j.data.offers) || [];
  if (!offers.length) return null;
  let best = null;
  offers.forEach((o) => {
    const minor = Math.round(Number(o.total_amount) * 100);
    if (!Number.isFinite(minor) || minor <= 0) return;
    if (!best || minor < best.minor) best = { minor, currency: o.total_currency || 'USD' };
  });
  if (!best) return null;
  return { minor: best.minor, currency: best.currency, display: money(best.minor, best.currency) };
}

// Without a supplier token there is nothing real to show. This is clearly
// labelled mode:'mock' so the interface can say so rather than pass it off.
function mockCurve(dates, origin, destination) {
  const out = {};
  const seed = (origin + destination).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  dates.forEach((d, i) => {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay();
    const weekend = dow === 5 || dow === 6 || dow === 0 ? 1.18 : 1;
    const wave = 1 + Math.sin((i + seed) / 3.1) * 0.13;
    const base = 38000 + ((seed * 37) % 9000);
    out[d] = { minor: Math.round(base * weekend * wave), currency: 'USD' };
    out[d].display = money(out[d].minor, 'USD');
  });
  return out;
}

function daysOf(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= last; d++) out.push(month + '-' + ('0' + d).slice(-2));
  return out;
}

function money(minor, currency) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: currency || 'USD',
      minimumFractionDigits: 0, maximumFractionDigits: 0
    }).format(minor / 100);
  } catch (e) { return '$' + Math.round(minor / 100); }
}
