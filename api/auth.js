const { guard } = require('./_guard');

// POST /api/auth  { action: 'send' | 'verify', email, token? }
//
// Passwordless sign in through Supabase Auth, proxied rather than called
// from the browser so the anon key is never required client side and the
// flow works identically on any surface.
//
//   send    emails a six digit code
//   verify  exchanges the code for a session
module.exports = async (req, res) => {
  if (guard(req, res, { limit: { name: 'auth', max: 8, windowMs: 60000 } })) return;
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const b = await readJson(req);
  const action = String(b.action || '').toLowerCase();
  const email = String(b.email || '').trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).end(JSON.stringify({ error: 'a valid email is required' }));
  }
  if (['send', 'verify'].indexOf(action) < 0) {
    return res.status(400).end(JSON.stringify({ error: "action must be 'send' or 'verify'" }));
  }
  if (!url || !anon) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock', sent: action === 'send', session: null,
      note: 'Set SUPABASE_URL and SUPABASE_ANON_KEY, and enable Email auth in Supabase, to sign people in.'
    }));
  }

  try {
    if (action === 'send') {
      const r = await fetch(url + '/auth/v1/otp', {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: true })
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(502).end(JSON.stringify({ error: 'auth_send_failed', detail: t.slice(0, 250) }));
      }
      return res.status(200).end(JSON.stringify({ mode: 'live:supabase', sent: true }));
    }

    const token = String(b.token || '').trim();
    if (!/^[0-9]{6}$/.test(token)) {
      return res.status(400).end(JSON.stringify({ error: 'the code is six digits' }));
    }
    const r = await fetch(url + '/auth/v1/verify', {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', email, token })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(401).end(JSON.stringify({
        error: 'invalid_code',
        detail: (j && (j.error_description || j.msg)) || 'That code did not work. Codes expire quickly.'
      }));
    }
    return res.status(200).end(JSON.stringify({
      mode: 'live:supabase',
      session: {
        email: (j.user && j.user.email) || email,
        userId: (j.user && j.user.id) || null,
        // Handed to the browser so it can prove who it is on later requests.
        // Without this every protected route would be back to trusting an
        // email typed into a URL.
        accessToken: j.access_token || null,
        expiresIn: j.expires_in || 3600
      }
    }));
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'auth_unavailable', detail: String(e.message).slice(0, 200) }));
  }
};

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
