// GET    /api/companions        -> the people this member travels with
// POST   /api/companions        -> add or update one
// DELETE /api/companions?id=x   -> remove one
//
// A booking for two needs the second passport as much as the first. Without
// this the product silently assumes everyone travels alone, which is close
// to never true.
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
  if (!url || !key) {
    return res.status(200).end(JSON.stringify({ mode: 'mock', companions: [] }));
  }

  try {
    if (req.method === 'GET') {
      const r = await fetch(url + '/rest/v1/companions?select=*&owner_email=eq.' +
        encodeURIComponent(caller.email) + '&order=created_at.asc', { headers: auth(key) });
      if (!r.ok) throw new Error('supabase ' + r.status);
      return res.status(200).end(JSON.stringify({
        mode: 'live:supabase', companions: (await r.json()).map(shape)
      }));
    }

    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '').trim();
      if (!id) return res.status(400).end(JSON.stringify({ error: 'id is required' }));
      // Scoped to the owner, so an id from somebody else's account deletes nothing.
      const r = await fetch(url + '/rest/v1/companions?id=eq.' + encodeURIComponent(id) +
        '&owner_email=eq.' + encodeURIComponent(caller.email), {
        method: 'DELETE', headers: auth(key)
      });
      if (!r.ok) throw new Error('supabase ' + r.status);
      return res.status(200).end(JSON.stringify({ deleted: true }));
    }

    if (req.method !== 'POST') {
      return res.status(405).end(JSON.stringify({ error: 'GET, POST or DELETE' }));
    }

    const b = await readJson(req);
    const name = str(b.fullName, 120);
    if (!name) return res.status(400).end(JSON.stringify({ error: 'a name is required' }));
    for (const [v, label] of [[b.dateOfBirth, 'dateOfBirth'], [b.passportExpiry, 'passportExpiry']]) {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
        return res.status(400).end(JSON.stringify({ error: label + ' must be YYYY-MM-DD' }));
      }
    }

    const row = {
      owner_email: caller.email,
      full_name: name,
      relationship: str(b.relationship, 40),
      date_of_birth: b.dateOfBirth || null,
      passport_number: str(b.passportNumber, 40),
      passport_expiry: b.passportExpiry || null,
      passport_country: b.passportCountry ? String(b.passportCountry).toUpperCase().slice(0, 3) : null,
      known_traveler: str(b.knownTraveler, 40),
      seat_pref: str(b.seatPref, 30),
      dietary: str(b.dietary, 200),
      updated_at: new Date().toISOString()
    };
    if (b.id) row.id = String(b.id);

    const r = await fetch(url + '/rest/v1/companions', {
      method: 'POST',
      headers: Object.assign(auth(key), {
        'Content-Type': 'application/json',
        Prefer: 'return=representation,resolution=merge-duplicates'
      }),
      body: JSON.stringify(row)
    });
    if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 160));
    return res.status(200).end(JSON.stringify({ saved: true, companion: shape((await r.json())[0] || row) }));
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 200) }));
  }
};

function shape(r) {
  return {
    id: r.id, fullName: r.full_name, relationship: r.relationship,
    dateOfBirth: r.date_of_birth, passportNumber: r.passport_number,
    passportExpiry: r.passport_expiry, passportCountry: r.passport_country,
    knownTraveler: r.known_traveler, seatPref: r.seat_pref, dietary: r.dietary
  };
}
function str(v, max) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
}
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
