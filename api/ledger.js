// GET /api/ledger?year=2026
//
// What a year of travel actually cost, against what it would have cost.
// This is the renewal conversation, and it is the one number no other travel
// company will show you, because for them it would be an indictment.
//
// It only ever counts what is recorded. A year with two stays says two
// stays. Inventing a plausible figure here would poison the one thing the
// brand is for.
const { verifyCaller, dbConfigured, unauthorized } = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  let caller = null;
  if (dbConfigured()) {
    caller = await verifyCaller(req);
    if (!caller) return unauthorized(res);
  }
  const year = Number((req.query && req.query.year) || new Date().getFullYear());
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    return res.status(400).end(JSON.stringify({ error: 'year is out of range' }));
  }
  if (!url || !key) {
    return res.status(200).end(JSON.stringify({ mode: 'mock', year, empty: true }));
  }

  try {
    const from = year + '-01-01', to = year + '-12-31';
    const r = await fetch(url + '/rest/v1/trips?select=*&email=eq.' +
      encodeURIComponent(caller.email) + '&order=starts_on.asc', { headers: auth(key) });
    if (!r.ok) throw new Error('supabase ' + r.status);
    const trips = (await r.json()).filter((t) => {
      const d = t.starts_on || (t.created_at || '').slice(0, 10);
      return d >= from && d <= to;
    });

    let market = 0, paid = 0, stays = 0, flights = 0, watched = 0, rebooks = 0, rebooked = 0;
    const lines = [];

    trips.forEach((t) => {
      const rs = (t.data && t.data.reservations) || [];
      const bookedElsewhere = t.watched_only || (t.source && t.source !== 'voyara');
      if (bookedElsewhere) watched++;
      rs.forEach((x) => {
        const m = money(x.marketMinor != null ? x.marketMinor : x.market);
        const p = money(x.paidMinor != null ? x.paidMinor : x.paid);
        if ((x.type || '').toUpperCase() === 'FLIGHT') flights++; else stays++;
        if (m && p) {
          market += m; paid += p;
          lines.push({
            title: x.name || x.supplier || t.title, on: x.checkIn || t.starts_on,
            type: x.type || 'STAY', market: m, paid: p, saved: m - p,
            bookedElsewhere: Boolean(bookedElsewhere)
          });
        }
        if (x.rebookedFromMinor) { rebooks++; rebooked += money(x.rebookedFromMinor) - money(x.paidMinor); }
      });
    });

    // Cash earned and burned in the year, which is part of what a membership
    // returned even though it never appears on a hotel bill.
    let cashEarned = 0, cashBurned = 0;
    const cr = await fetch(url + '/rest/v1/cash_ledger?select=kind,amount_minor,created_at&email=eq.' +
      encodeURIComponent(caller.email), { headers: auth(key) });
    if (cr.ok) {
      (await cr.json()).forEach((e) => {
        if (String(e.created_at || '').slice(0, 4) !== String(year)) return;
        const v = Number(e.amount_minor) || 0;
        if (v > 0) cashEarned += v; else cashBurned += Math.abs(v);
      });
    }

    const fee = Number(process.env.MEMBERSHIP_FEE_MINOR || 49900);
    const kept = market - paid;

    return res.status(200).end(JSON.stringify({
      mode: 'live:supabase', year,
      empty: lines.length === 0 && trips.length === 0,
      trips: trips.length, stays, flights, watched,
      marketMinor: market, paidMinor: paid, keptMinor: kept,
      rebooks, rebookedMinor: rebooked,
      cashEarnedMinor: cashEarned, cashBurnedMinor: cashBurned,
      membershipMinor: fee,
      netMinor: kept - fee,
      multiple: fee > 0 ? Math.round((kept / fee) * 10) / 10 : null,
      lines: lines.sort((a, b) => String(a.on).localeCompare(String(b.on)))
    }));
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 200) }));
  }
};

// Accepts minor units or a decimal figure, and refuses anything else rather
// than coercing a string into a number that looks convincing.
function money(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v > 100000 ? v : v * 100) : 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
