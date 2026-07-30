// POST /api/waitlist  { email, name? }   -> saves a lead
// GET  /api/waitlist                     -> public count
//
// This is the one route that produces business value before a single
// flight can be sold. It writes to Supabase over plain HTTP, so there
// are no dependencies and no build step.
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const configured = Boolean(url && key);

  if (req.method === 'GET') {
    if (!configured) return res.status(200).end(JSON.stringify({ mode: 'mock', count: 0 }));
    try {
      const r = await fetch(url + '/rest/v1/waitlist?select=id', {
        headers: Object.assign(auth(key), { Prefer: 'count=exact', Range: '0-0' })
      });
      const cr = r.headers.get('content-range') || '';
      const total = Number(String(cr).split('/')[1]);
      return res.status(200).end(JSON.stringify({
        mode: 'live:supabase',
        count: Number.isFinite(total) ? total : 0
      }));
    } catch (e) {
      return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 200) }));
    }
  }

  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'GET or POST only' }));

  const body = await readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  const name = body.name ? String(body.name).trim().slice(0, 120) : null;

  if (!email) return res.status(400).end(JSON.stringify({ error: 'email is required' }));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return res.status(400).end(JSON.stringify({ error: 'that does not look like an email address' }));
  }

  if (!configured) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock', saved: false,
      message: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY to actually store this.'
    }));
  }

  try {
    const r = await fetch(url + '/rest/v1/waitlist', {
      method: 'POST',
      headers: Object.assign(auth(key), {
        'Content-Type': 'application/json',
        Prefer: 'return=representation,resolution=merge-duplicates'
      }),
      body: JSON.stringify({
        email, name,
        source: String(body.source || 'site').slice(0, 40),
        referrer: String(req.headers.referer || '').slice(0, 300) || null
      })
    });

    // A duplicate signup is a success from the person's point of view.
    if (r.status === 409) {
      return res.status(200).end(JSON.stringify({ mode: 'live:supabase', saved: true, duplicate: true }));
    }
    if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));

    // Record it in the audit chain too. Failure here must never lose the lead.
    let audited = false;
    try {
      const a = await fetch(url + '/rest/v1/rpc/append_audit', {
        method: 'POST',
        headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          p_type: 'waitlist.joined', p_actor: 'traveler',
          p_payload: { source: body.source || 'site' },
          p_subject_type: 'waitlist', p_subject_id: email
        })
      });
      audited = a.ok;
    } catch (e) { audited = false; }

    res.status(201).end(JSON.stringify({ mode: 'live:supabase', saved: true, duplicate: false, audited }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 300) }));
  }
};

function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
