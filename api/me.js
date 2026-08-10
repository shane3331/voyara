const { guard } = require('./_guard');

// GET /api/me
//
// Who is asking, and what are they entitled to. There are three states and
// the product now depends on telling them apart:
//
//   visitor   no account. Sees every price including what a member would pay,
//             and what they would keep. Books nothing.
//   account   free. Books flights, keeps a profile and passports, and has
//             their trips monitored. Airlines pay about one percent, so
//             giving this away costs almost nothing and it is the reason
//             somebody makes an account at all.
//   member    paid. Hotel net rates, autorebook, Voyara Cash, sourcing.
//             This is where the margin is, so this is what is sold.
const { verifyCaller, dbConfigured, unauthorized } = require('./_auth');

const ACTIVE = ['active', 'trialing', 'past_due'];

module.exports = async (req, res) => {
  if (guard(req, res, { limit: { name: 'me', max: 60, windowMs: 60000 } })) return;
  res.setHeader('content-type', 'application/json');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  // A visitor is a valid answer, not an error. This route is called on every
  // load, including by people who have never signed in.
  let caller = null;
  if (dbConfigured()) {
    caller = await verifyCaller(req);
    if (!caller) {
      return res.status(200).end(JSON.stringify({ state: 'visitor', email: null, member: false }));
    }
  } else {
    return res.status(200).end(JSON.stringify({ mode: 'mock', state: 'visitor', email: null, member: false }));
  }

  try {
    const r = await fetch(url + '/rest/v1/memberships?select=tier,status,current_period_end' +
      '&email=eq.' + encodeURIComponent(caller.email) +
      '&order=updated_at.desc&limit=1', { headers: auth(key) });
    if (!r.ok) throw new Error('supabase ' + r.status);
    const row = (await r.json())[0];

    // Past due still counts. Cutting somebody off mid trip over a failed card
    // is how you lose a member you were about to keep.
    const active = Boolean(row && ACTIVE.indexOf(String(row.status)) >= 0);

    return res.status(200).end(JSON.stringify({
      state: active ? 'member' : 'account',
      email: caller.email,
      member: active,
      tier: active ? (row.tier || 'founding') : null,
      status: row ? row.status : null,
      renewsOn: active && row.current_period_end ? String(row.current_period_end).slice(0, 10) : null
    }));
  } catch (e) {
    // Fail as an account rather than a member. Guessing generously here would
    // hand out the thing being sold every time the database hiccups.
    return res.status(200).end(JSON.stringify({
      state: 'account', email: caller.email, member: false,
      warning: String(e.message).slice(0, 120)
    }));
  }
};

function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
