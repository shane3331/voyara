// Shared request hardening. Underscore prefix so Vercel does not route it.
//
// These are the things that are cheap to add and expensive to be missing:
// an origin allowlist so another site cannot drive your API with a visitor's
// cookies, a rate limit so one person cannot run up a supplier bill or brute
// force a code, and security headers so the page cannot be framed or sniffed.

// In-memory, per warm instance. Serverless means several instances and a cold
// start clears the counts, so this is a brake and not a vault: it stops
// somebody hammering a route from a laptop, not a funded botnet. Anything
// stronger needs a shared store, and that is a real dependency to add later.
const HITS = new Map();
const SWEEP_MS = 10 * 60 * 1000;
let lastSweep = Date.now();

function clientKey(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || 'unknown';
}

// Returns true when the caller is over the limit.
function rateLimited(req, res, { name, max, windowMs }) {
  const now = Date.now();
  if (now - lastSweep > SWEEP_MS) {
    for (const [k, v] of HITS) if (now - v.start > v.window) HITS.delete(k);
    lastSweep = now;
  }
  const key = name + '|' + clientKey(req);
  const slot = HITS.get(key);
  if (!slot || now - slot.start > windowMs) {
    HITS.set(key, { start: now, count: 1, window: windowMs });
    return false;
  }
  slot.count++;
  if (slot.count > max) {
    const retry = Math.ceil((slot.start + windowMs - now) / 1000);
    res.setHeader('Retry-After', String(Math.max(1, retry)));
    res.setHeader('content-type', 'application/json');
    res.status(429).end(JSON.stringify({
      error: 'rate_limited',
      detail: 'Too many requests. Try again in ' + Math.max(1, retry) + ' seconds.'
    }));
    return true;
  }
  return false;
}

// Only our own site may call these routes from a browser. Server to server
// callers send no Origin at all and are unaffected, which is what lets Stripe
// and the cron keep working.
function allowedOrigins() {
  const extra = String(process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const site = process.env.SITE_URL || process.env.VERCEL_URL;
  const own = site ? [site.startsWith('http') ? site : 'https://' + site] : [];
  return own.concat(extra);
}

function originBlocked(req, res) {
  const origin = req.headers.origin;
  if (!origin) return false;                 // not a browser cross-site call
  const list = allowedOrigins();
  // With nothing configured we cannot tell our own origin from anyone else's,
  // so allow rather than lock the owner out of their own site by accident.
  if (!list.length) return false;
  const ok = list.some((o) => origin === o) ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    return false;
  }
  res.setHeader('content-type', 'application/json');
  res.status(403).end(JSON.stringify({ error: 'origin_not_allowed' }));
  return true;
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Nothing here should ever be cached by a shared proxy: most of it is one
  // person's data.
  res.setHeader('Cache-Control', 'no-store');
}

// One call at the top of a route. Returns true when the request is finished
// and the handler should stop.
function guard(req, res, opts) {
  securityHeaders(res);
  if (originBlocked(req, res)) return true;
  if (opts && opts.limit && rateLimited(req, res, opts.limit)) return true;
  return false;
}

module.exports = { guard, rateLimited, originBlocked, securityHeaders };
