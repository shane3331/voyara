// GET  /api/profile?email=x   -> one profile
// POST /api/profile           -> create or update it
//
// Keyed on email because that is what the session carries. Everything is
// optional: a member should be able to save a name and nothing else, come
// back later, and add a passport when they need one.
const { verifyCaller, dbConfigured, unauthorized } = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  // This row holds a passport number and a date of birth. The email is taken
  // from the verified token and never from the request, so asking for someone
  // else's profile is not a thing this route can do.
  let caller = null;
  if (dbConfigured()) {
    caller = await verifyCaller(req);
    if (!caller) return unauthorized(res);
  }

  if (req.method === 'GET') {
    if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'mock', profile: null }));
    const email = caller.email;
    try {
      const r = await fetch(
        url + '/rest/v1/profiles?select=*&email=eq.' + encodeURIComponent(email) + '&limit=1',
        { headers: auth(key) });
      if (!r.ok) throw new Error('supabase ' + r.status);
      const rows = await r.json();
      return res.status(200).end(JSON.stringify({ mode: 'live:supabase', profile: rows[0] ? shape(rows[0]) : null }));
    } catch (e) {
      return res.status(200).end(JSON.stringify({ mode: 'mock', profile: null, warning: String(e.message).slice(0, 160) }));
    }
  }

  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'GET or POST only' }));

  const b = await readJson(req);
  // Whatever email the body claims is ignored.
  const email = caller ? caller.email : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).end(JSON.stringify({ error: 'a valid session is required' }));
  }
  for (const [v, label] of [[b.dateOfBirth, 'dateOfBirth'], [b.passportExpiry, 'passportExpiry']]) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
      return res.status(400).end(JSON.stringify({ error: label + ' must be YYYY-MM-DD' }));
    }
  }
  // The browser resizes to 256px square before sending. This is the backstop,
  // so a crafted request cannot fill the row with a multi megabyte string.
  const avatar = b.avatar ? String(b.avatar) : null;
  if (avatar && avatar.length > 400000) {
    return res.status(413).end(JSON.stringify({ error: 'avatar too large' }));
  }
  if (avatar && !/^data:image\/(png|jpe?g|webp);base64,/.test(avatar)) {
    return res.status(400).end(JSON.stringify({ error: 'avatar must be a png, jpeg or webp data url' }));
  }

  if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'mock', saved: false }));

  const row = {
    email,
    full_name: str(b.fullName, 120),
    avatar: avatar,
    phone: str(b.phone, 40),
    home_airport: b.homeAirport ? String(b.homeAirport).toUpperCase().slice(0, 4) : null,
    date_of_birth: b.dateOfBirth || null,
    passport_number: str(b.passportNumber, 40),
    passport_expiry: b.passportExpiry || null,
    passport_country: b.passportCountry ? String(b.passportCountry).toUpperCase().slice(0, 3) : null,
    known_traveler: str(b.knownTraveler, 40),
    seat_pref: str(b.seatPref, 30),
    bed_pref: str(b.bedPref, 30),
    dietary: str(b.dietary, 200),
    notes: str(b.notes, 1000),
    emergency_name: str(b.emergencyName, 120),
    emergency_phone: str(b.emergencyPhone, 40),
    updated_at: new Date().toISOString()
  };
  // Never overwrite a stored value with null just because this request left
  // the field out. A partial save is a save of that part only.
  Object.keys(row).forEach((k) => { if (row[k] === null && k !== 'avatar') delete row[k]; });
  if (avatar === null && !('avatar' in b)) delete row.avatar;

  try {
    const r = await fetch(url + '/rest/v1/profiles', {
      method: 'POST',
      headers: Object.assign(auth(key), {
        'Content-Type': 'application/json',
        Prefer: 'return=representation,resolution=merge-duplicates'
      }),
      body: JSON.stringify(row)
    });
    if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const saved = (await r.json())[0] || row;
    return res.status(200).end(JSON.stringify({ mode: 'live:supabase', saved: true, profile: shape(saved) }));
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 250) }));
  }
};

function shape(r) {
  return {
    email: r.email, fullName: r.full_name, avatar: r.avatar, phone: r.phone,
    homeAirport: r.home_airport, dateOfBirth: r.date_of_birth,
    passportNumber: r.passport_number, passportExpiry: r.passport_expiry,
    passportCountry: r.passport_country, knownTraveler: r.known_traveler,
    seatPref: r.seat_pref, bedPref: r.bed_pref, dietary: r.dietary, notes: r.notes,
    emergencyName: r.emergency_name, emergencyPhone: r.emergency_phone,
    updatedAt: r.updated_at
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
