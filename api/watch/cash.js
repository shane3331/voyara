const { verifyCaller, dbConfigured, unauthorized } = require('./_auth');

// GET  /api/cash?email=x  -> balance and ledger
// POST /api/cash          -> earn, burn, reverse, expire
//
// EARN ON AIR, BURN ON STAYS.
//
// Airlines pay roughly 1%, so a flight reward cannot fund itself. It is
// funded by hotel margin, which is why Cash is earned on flights and can
// only be spent against stays. That single rule is what makes this
// self funding rather than a giveaway.
//
// Closed loop. Never withdrawable as money, which also keeps it clear of
// money transmitter licensing.
const EARN_AIR = pct(process.env.CASH_EARN_AIR, 0.02);
const EARN_STAY = pct(process.env.CASH_EARN_STAY, 0);
const BURN_CAP = pct(process.env.CASH_BURN_CAP, 0.30);   // share of a stay
const EARN_CAP_MINOR = int(process.env.CASH_EARN_CAP_MINOR, 25000);
const EXPIRY_MONTHS = int(process.env.CASH_EXPIRY_MONTHS, 24);

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  // Identity comes from the verified token. A route that takes an email from
  // the query string is a route that hands one person's data to another.
  let caller = null;
  if (dbConfigured()) {
    caller = await verifyCaller(req);
    if (!caller) return unauthorized(res);
  }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;

  if (req.method === 'GET') {
    const email = (caller ? caller.email : '');
    if (!url || !key) return res.status(200).end(JSON.stringify(emptyWallet('mock')));
    try {
      const r = await fetch(
        url + '/rest/v1/cash_ledger?select=*' + (email ? '&email=eq.' + encodeURIComponent(email) : '') +
        '&order=created_at.desc&limit=60', { headers: auth(key) });
      if (!r.ok) throw new Error('supabase ' + r.status);
      return res.status(200).end(JSON.stringify(wallet(await r.json(), 'live:supabase')));
    } catch (e) {
      return res.status(200).end(JSON.stringify(Object.assign(emptyWallet('mock'), { warning: String(e.message).slice(0, 150) })));
    }
  }

  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'GET or POST only' }));

  const b = await readJson(req);
  const action = String(b.action || '').toLowerCase();
  const email = (caller ? caller.email : '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).end(JSON.stringify({ error: 'a valid email is required' }));
  }
  if (['earn', 'burn', 'reverse', 'quote'].indexOf(action) < 0) {
    return res.status(400).end(JSON.stringify({ error: 'action must be earn, burn, reverse or quote' }));
  }

  const currency = String(b.currency || 'USD').toUpperCase();

  // How much Cash may be applied to a given stay, and what it is worth.
  if (action === 'quote') {
    const stay = int(b.stayMinor, 0);
    if (stay <= 0) return res.status(400).end(JSON.stringify({ error: 'stayMinor must be positive' }));
    const bal = await balanceOf(url, key, email);
    const cap = Math.floor(stay * BURN_CAP);
    const apply = Math.min(bal.availableMinor, cap);
    return res.status(200).end(JSON.stringify({
      availableMinor: bal.availableMinor, capMinor: cap, applyMinor: apply,
      remainingMinor: Math.max(0, stay - apply), currency,
      capPct: BURN_CAP,
      note: 'Voyara Cash covers up to ' + Math.round(BURN_CAP * 100) + '% of a stay. It is earned on flights and spent on rooms.'
    }));
  }

  // Validate before the no database shortcut. Bad input is bad input whether
  // or not there is somewhere to write it.
  const vertical = String(b.vertical || 'air').toLowerCase();
  if (action === 'earn' && int(b.spendMinor, 0) <= 0) {
    return res.status(400).end(JSON.stringify({ error: 'spendMinor must be positive' }));
  }
  if (action === 'burn' && (int(b.stayMinor, 0) <= 0 || int(b.amountMinor, 0) <= 0)) {
    return res.status(400).end(JSON.stringify({ error: 'stayMinor and amountMinor must be positive' }));
  }
  if (action === 'reverse' && !String(b.reference || '').trim()) {
    return res.status(400).end(JSON.stringify({ error: 'reference is required to reverse' }));
  }

  if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'mock', recorded: false }));

  try {
    if (action === 'earn') {
      const spend = int(b.spendMinor, 0);
      const rate = vertical === 'air' ? EARN_AIR : EARN_STAY;
      if (rate <= 0) {
        return res.status(200).end(JSON.stringify({ recorded: false, reason: 'no earn rate on ' + vertical }));
      }
      const earnedThisYear = await earnedSince(url, key, email);
      const raw = Math.round(spend * rate);
      const amount = Math.max(0, Math.min(raw, EARN_CAP_MINOR - earnedThisYear));
      if (amount <= 0) {
        return res.status(200).end(JSON.stringify({ recorded: false, reason: 'annual earn cap reached', capMinor: EARN_CAP_MINOR }));
      }
      const expires = new Date();
      expires.setMonth(expires.getMonth() + EXPIRY_MONTHS);
      const row = await insert(url, key, {
        email, kind: 'EARN', amount_minor: amount, currency,
        state: 'PENDING_TRAVEL', source: vertical,
        reference: b.reference ? String(b.reference) : null,
        expires_at: expires.toISOString()
      });
      await audit(url, key, 'cash.earned', { amount_minor: amount, vertical, rate }, email);
      return res.status(row === 'duplicate' ? 200 : 201).end(JSON.stringify({
        recorded: row !== 'duplicate', duplicate: row === 'duplicate',
        amountMinor: amount, expiresAt: expires.toISOString()
      }));
    }

    if (action === 'burn') {
      const stay = int(b.stayMinor, 0);
      const want = int(b.amountMinor, 0);
      const bal = await balanceOf(url, key, email);
      const cap = Math.floor(stay * BURN_CAP);
      const amount = Math.min(want, cap, bal.availableMinor);
      if (amount <= 0) {
        return res.status(409).end(JSON.stringify({
          error: 'nothing_to_apply', availableMinor: bal.availableMinor, capMinor: cap
        }));
      }
      await insert(url, key, {
        email, kind: 'BURN', amount_minor: -amount, currency,
        state: 'REDEEMED', source: 'stay',
        reference: b.reference ? String(b.reference) : null
      });
      await audit(url, key, 'cash.redeemed', { amount_minor: amount, stay_minor: stay, cap_minor: cap }, email);
      return res.status(201).end(JSON.stringify({ recorded: true, appliedMinor: amount, capMinor: cap }));
    }

    // reverse: a cancelled booking must not leave its reward behind
    const ref = String(b.reference || '').trim();
    const found = await fetch(
      url + '/rest/v1/cash_ledger?select=*&email=eq.' + encodeURIComponent(email) +
      '&reference=eq.' + encodeURIComponent(ref) + '&kind=eq.EARN', { headers: auth(key) });
    const rows = found.ok ? await found.json() : [];
    if (!rows.length) return res.status(200).end(JSON.stringify({ recorded: false, reason: 'nothing earned on that reference' }));
    let total = 0;
    for (const r of rows) {
      total += Number(r.amount_minor) || 0;
      await insert(url, key, {
        email, kind: 'REVERSAL', amount_minor: -(Number(r.amount_minor) || 0),
        currency: r.currency, state: 'REVERSED', source: r.source,
        reference: ref + ':rev:' + r.id
      });
    }
    await audit(url, key, 'cash.reversed', { amount_minor: total, reason: b.reason || 'reversal' }, email);
    return res.status(201).end(JSON.stringify({ recorded: true, reversedMinor: total }));
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 250) }));
  }
};

async function insert(url, key, row) {
  const r = await fetch(url + '/rest/v1/cash_ledger', {
    method: 'POST',
    headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(row)
  });
  if (r.status === 409) return 'duplicate';
  if (!r.ok && r.status !== 201 && r.status !== 204) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return 'ok';
}

async function balanceOf(url, key, email) {
  if (!url || !key) return { availableMinor: 0, pendingMinor: 0 };
  const r = await fetch(
    url + '/rest/v1/cash_ledger?select=amount_minor,state,expires_at&email=eq.' + encodeURIComponent(email),
    { headers: auth(key) });
  if (!r.ok) return { availableMinor: 0, pendingMinor: 0 };
  return totals(await r.json());
}

async function earnedSince(url, key, email) {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const r = await fetch(
    url + '/rest/v1/cash_ledger?select=amount_minor&email=eq.' + encodeURIComponent(email) +
    '&kind=eq.EARN&created_at=gte.' + since.toISOString(), { headers: auth(key) });
  if (!r.ok) return 0;
  return (await r.json()).reduce((n, x) => n + (Number(x.amount_minor) || 0), 0);
}

function totals(rows) {
  const now = Date.now();
  let available = 0, pending = 0, lifetime = 0;
  rows.forEach((r) => {
    const amt = Number(r.amount_minor) || 0;
    const expired = r.expires_at && new Date(r.expires_at).getTime() < now;
    if (amt > 0) lifetime += amt;
    if (expired && amt > 0) return;                 // lapsed, not spendable
    if (r.state === 'PENDING_TRAVEL' && amt > 0) { pending += amt; return; }
    available += amt;
  });
  return { availableMinor: Math.max(0, available), pendingMinor: pending, lifetimeMinor: lifetime };
}

function wallet(rows, mode) {
  const t = totals(rows);
  return Object.assign({ mode, rules: rulesText() }, t, {
    entries: rows.slice(0, 20).map((r) => ({
      kind: r.kind, amountMinor: r.amount_minor, currency: r.currency,
      state: r.state, source: r.source, createdAt: r.created_at, expiresAt: r.expires_at
    }))
  });
}
function emptyWallet(mode) {
  return { mode, availableMinor: 0, pendingMinor: 0, lifetimeMinor: 0, entries: [], rules: rulesText() };
}
function rulesText() {
  return {
    earnAirPct: EARN_AIR, earnStayPct: EARN_STAY, burnCapPct: BURN_CAP,
    annualEarnCapMinor: EARN_CAP_MINOR, expiryMonths: EXPIRY_MONTHS,
    summary: 'Earned on flights at ' + Math.round(EARN_AIR * 100) + '%, spendable against stays up to ' +
      Math.round(BURN_CAP * 100) + '% of a booking. Expires after ' + EXPIRY_MONTHS +
      ' months. Never withdrawable as money.'
  };
}

async function audit(url, key, type, payload, subject) {
  try {
    await fetch(url + '/rest/v1/rpc/append_audit', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_type: type, p_actor: 'ledger', p_payload: payload, p_subject_type: 'cash', p_subject_id: subject })
    });
  } catch (e) { /* the ledger row is the record of truth */ }
}
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function pct(v, d) { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d; }
function int(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
