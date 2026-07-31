// GET /api/config -> what the browser is allowed to know
//
// The zero config deploy has no build step, so public keys cannot be baked
// into the HTML. They are served here instead. Only ever the anon key, which
// is designed to be public and is bounded by row level security. The service
// role key must never leave the server.
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=60');
  res.status(200).end(JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    authEnabled: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    currency: process.env.LITEAPI_CURRENCY || 'USD'
  }));
};
