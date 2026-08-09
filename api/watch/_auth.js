// Shared caller verification. Underscore prefix so Vercel does not route it.
//
// The rule this exists to enforce: a route must never trust an email that
// arrived in the query string or the body. It takes the bearer token the
// browser was issued at sign in, asks Supabase who that token belongs to, and
// uses THAT email. Anything else means anyone who can type an address into a
// URL can read the passport number behind it.
//
// Verification is a round trip rather than a local signature check on purpose:
// it costs one fast call, needs no JWT secret in the environment, and it
// respects a session that has been revoked, which a signature check does not.

async function verifyCaller(req) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;

  const raw = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  if (!m) return null;
  const token = m[1].trim();
  // A short token is never a real JWT; skip the round trip.
  if (token.length < 20) return null;

  try {
    const r = await fetch(url + '/auth/v1/user', {
      headers: { apikey: key, Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !u.email) return null;
    return { email: String(u.email).trim().toLowerCase(), userId: u.id || null };
  } catch (e) {
    // Fail closed. An auth service we cannot reach is not permission to serve.
    return null;
  }
}

// True when a database is actually configured. Without one there is no stored
// data to protect and the routes answer in mock mode.
function dbConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

// Standard shape so every protected route refuses the same way.
function unauthorized(res, detail) {
  res.setHeader('content-type', 'application/json');
  return res.status(401).end(JSON.stringify({
    error: 'unauthorized',
    detail: detail || 'Sign in and try again.'
  }));
}

module.exports = { verifyCaller, dbConfigured, unauthorized };
