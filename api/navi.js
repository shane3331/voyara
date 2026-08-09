// POST /api/navi   { message, history? }
//
// The real Navi. A frontier model with tools pointed at this product's own
// data, rather than a chat box with a travel system prompt.
//
// The design rule the whole thing hangs on: Navi answers from tool results or
// says it does not know. A travel assistant that invents a cancellation
// deadline is worse than no assistant, because somebody misses a refund
// window and finds out at the desk.
const { verifyCaller, dbConfigured, unauthorized } = require('./_auth');

const MODEL = process.env.NAVI_MODEL || 'claude-sonnet-4-6';
const MAX_ROUNDS = 6;          // tool loops before we stop and answer with what we have
const MAX_HISTORY = 12;        // turns carried back, to bound cost
const TIMEOUT_MS = 55000;

const SYSTEM = `You are Navi, the travel assistant inside Voyara.

WHAT VOYARA IS
Voyara is a membership travel platform. Members pay a yearly fee and get
wholesale hotel rates; anyone with a free account can book flights at the real
price. The brand promise is that the number on the screen is the true number,
and that a human operator stands behind every booking.

HOW YOU ANSWER
You have tools that read this member's actual data and this product's live
inventory. Use them. Never answer a question about prices, availability,
bookings, dates, documents or policy from your own knowledge when a tool can
tell you the truth.

If a tool cannot tell you, say so plainly and say what you would need. Never
estimate a fare, invent a cancellation deadline, guess a confirmation number,
or describe a property you have not looked up. "I do not have that" is a good
answer. A confident wrong answer about a refund window can cost somebody
thousands of pounds and it is the one thing that would end this company.

You may use your own knowledge freely for things no tool covers: what a city
is like in November, how long to allow between terminals at Heathrow, whether
a visa is usually needed, what to do about a missed connection, how to think
about a trip. Be genuinely useful there. That is judgement, not data, and it
is why somebody asks you rather than a search box.

TONE
Write like a very good travel operator who respects the person's time. Warm,
direct, specific. Short paragraphs. No bullet lists unless the answer is
genuinely a list. Never use the words "delve", "elevate", "curated",
"seamless" or "unlock". Do not open by restating the question. Do not use em
dashes.

Prices: always say the currency. When you have both a market rate and a member
rate, give both and the difference, because that comparison is the product.

MEMBERSHIP
If the person is not a member and asks about hotel rates, tell them what
members pay and what they would keep, and let them decide. Do not nag. Never
imply somebody has a booking, a membership or a saving that the tools do not
show.`;

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock',
      reply: 'Navi is not connected yet. Set ANTHROPIC_API_KEY and I can answer for real.',
      tools: []
    }));
  }

  // An account is required. Every message costs money and a tool loop costs
  // several calls, so this is not something a passer by can burn through.
  let caller = null;
  if (dbConfigured()) {
    caller = await verifyCaller(req);
    if (!caller) return unauthorized(res, 'Sign in to talk to Navi.');
  }

  const body = await readJson(req);
  const message = String(body.message || '').trim();
  if (!message) return res.status(400).end(JSON.stringify({ error: 'message is required' }));
  if (message.length > 4000) return res.status(400).end(JSON.stringify({ error: 'message is too long' }));

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = String(req.headers['x-forwarded-proto'] || 'https');
  const origin = host ? proto + '://' + host : '';

  const ctx = { caller, origin, used: [] };

  // Prior turns, trimmed. The model needs the thread; it does not need all of it.
  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];
  const messages = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  messages.push({ role: 'user', content: message });

  try {
    const out = await run(key, messages, ctx);
    return res.status(200).end(JSON.stringify({
      mode: 'live:anthropic',
      model: MODEL,
      reply: out.text,
      // What it actually looked at. The interface shows these, so a member can
      // see the answer came from records rather than from the model's memory.
      tools: ctx.used,
      rounds: out.rounds
    }));
  } catch (e) {
    return res.status(502).end(JSON.stringify({
      error: 'navi_unavailable',
      detail: String(e && e.message ? e.message : e).slice(0, 300)
    }));
  }
};

/* ============================================================
   THE TOOLS
   Everything Navi can check. Search routes are called over HTTP because they
   need no session. Anything belonging to one person is read straight from the
   database using the VERIFIED email, never one the model supplies, so a
   prompt injection cannot make it fetch somebody else's passport.
   ============================================================ */
const TOOLS = [
  {
    name: 'search_hotels',
    description: 'Live hotel availability and prices for a destination and dates. Returns the market rate, the member rate and the saving for each property. Use for any question about what is available or what something costs.',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'City, or "City, Country". Any city works.' },
        checkIn: { type: 'string', description: 'YYYY-MM-DD' },
        checkOut: { type: 'string', description: 'YYYY-MM-DD' },
        guests: { type: 'integer', description: 'Number of adults. Default 2.' },
        quality: { type: 'string', enum: ['luxury', 'premium', 'any'], description: 'luxury is five star only, premium is four and above.' }
      },
      required: ['destination', 'checkIn', 'checkOut']
    }
  },
  {
    name: 'search_flights',
    description: 'Live flight fares between two airports on a date. Returns carriers, times, stops, duration and price.',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Three letter airport code' },
        destination: { type: 'string', description: 'Three letter airport code' },
        departOn: { type: 'string', description: 'YYYY-MM-DD' },
        returnOn: { type: 'string', description: 'YYYY-MM-DD. Omit for one way.' },
        passengers: { type: 'integer' }
      },
      required: ['origin', 'destination', 'departOn']
    }
  },
  {
    name: 'fare_calendar',
    description: 'The cheapest fare for every day of a month on a route. Use when somebody asks when is cheapest to fly, or has flexible dates.',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string' },
        destination: { type: 'string' },
        month: { type: 'string', description: 'YYYY-MM' },
        passengers: { type: 'integer' }
      },
      required: ['origin', 'destination', 'month']
    }
  },
  {
    name: 'get_profile',
    description: "This member's own details: name, home airport, passport and expiry, known traveller number, seat and bed preferences, dietary needs, emergency contact. Use before booking anything or when asked what is on file.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_companions',
    description: 'The people this member travels with, and their travel documents. Use when a booking is for more than one person.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_trips',
    description: "This member's booked and monitored trips, with reservations, references, dates and status. Use for any question about an existing booking.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_ledger',
    description: 'What this member spent on travel in a year, against what the same travel would have cost at market, and what they kept.',
    input_schema: {
      type: 'object',
      properties: { year: { type: 'integer' } }
    }
  },
  {
    name: 'get_signature',
    description: "Voyara's hand written list of properties worth being known for, with an operator's note on each. Use when somebody asks for a recommendation in a city Voyara covers, or asks what is actually good.",
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } }
    }
  },
  {
    name: 'get_membership',
    description: 'Whether this person is a visitor, has a free account, or is a paying member, and when it renews. Use before saying anything about what they can book or what they pay.',
    input_schema: { type: 'object', properties: {} }
  }
];

async function callTool(name, input, ctx) {
  ctx.used.push(name);
  const q = (o) => Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '')
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

  try {
    if (name === 'search_hotels') {
      return await getJson(ctx.origin + '/api/stays/search?' + q({
        destination: input.destination, checkIn: input.checkIn, checkOut: input.checkOut,
        guests: input.guests || 2, quality: input.quality || 'premium'
      }));
    }
    if (name === 'search_flights') {
      return await getJson(ctx.origin + '/api/flights/search?' + q({
        origin: up(input.origin), destination: up(input.destination),
        departOn: input.departOn, returnOn: input.returnOn, passengers: input.passengers || 1
      }));
    }
    if (name === 'fare_calendar') {
      return await getJson(ctx.origin + '/api/flights/calendar?' + q({
        origin: up(input.origin), destination: up(input.destination),
        month: input.month, passengers: input.passengers || 1
      }));
    }
    if (name === 'get_signature') {
      return await getJson(ctx.origin + '/api/signature' + (input.city ? '?city=' + encodeURIComponent(input.city) : ''));
    }

    // Everything below belongs to one person.
    if (!ctx.caller) return { error: 'Not signed in, so there is nothing personal to read.' };
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return { error: 'No database configured.' };
    const email = ctx.caller.email;   // verified, never from the model

    if (name === 'get_profile') {
      const rows = await sb(url, key, 'profiles?select=*&email=eq.' + encodeURIComponent(email) + '&limit=1');
      return rows[0] ? { profile: redact(rows[0]) } : { profile: null, note: 'No profile saved yet.' };
    }
    if (name === 'get_companions') {
      const rows = await sb(url, key, 'companions?select=*&owner_email=eq.' + encodeURIComponent(email));
      return { companions: rows.map(redact) };
    }
    if (name === 'get_trips') {
      const rows = await sb(url, key, 'trips?select=*&email=eq.' + encodeURIComponent(email) + '&order=starts_on.asc&limit=25');
      return { trips: rows };
    }
    if (name === 'get_ledger') {
      const rows = await sb(url, key, 'trips?select=*&email=eq.' + encodeURIComponent(email));
      const year = String(input.year || new Date().getFullYear());
      const mine = rows.filter((t) => String(t.starts_on || t.created_at || '').slice(0, 4) === year);
      return { year: Number(year), trips: mine.length, detail: mine };
    }
    if (name === 'get_membership') {
      const rows = await sb(url, key, 'memberships?select=tier,status,current_period_end&email=eq.' +
        encodeURIComponent(email) + '&order=updated_at.desc&limit=1');
      const m = rows[0];
      const active = Boolean(m && ['active', 'trialing', 'past_due'].indexOf(String(m.status)) >= 0);
      return { state: active ? 'member' : 'account', member: active, tier: active ? m.tier : null,
               renewsOn: active && m.current_period_end ? String(m.current_period_end).slice(0, 10) : null };
    }
    return { error: 'Unknown tool.' };
  } catch (e) {
    // A failed tool is reported to the model as a failure, so it says it could
    // not check rather than filling the gap with something plausible.
    return { error: 'That lookup failed: ' + String(e.message).slice(0, 150) };
  }
}

// A passport number does not need to pass through a model to answer "am I
// ready for international travel". Send whether it exists, not what it is.
function redact(row) {
  const out = Object.assign({}, row);
  ['passport_number', 'known_traveler'].forEach((k) => {
    if (out[k]) out[k] = 'on file';
  });
  return out;
}

/* ============================================================
   THE LOOP
   ============================================================ */
async function run(key, messages, ctx) {
  let rounds = 0;

  while (rounds < MAX_ROUNDS) {
    rounds++;
    const r = await anthropic(key, {
      model: MODEL,
      max_tokens: 1600,
      system: SYSTEM + '\n\nToday is ' + new Date().toISOString().slice(0, 10) + '.',
      tools: TOOLS,
      messages
    });

    const blocks = r.content || [];
    const calls = blocks.filter((b) => b.type === 'tool_use');

    if (!calls.length) {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { text: text || 'I could not put an answer together for that.', rounds };
    }

    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const c of calls) {
      const out = await callTool(c.name, c.input || {}, ctx);
      results.push({
        type: 'tool_result',
        tool_use_id: c.id,
        content: JSON.stringify(out).slice(0, 24000)
      });
    }
    messages.push({ role: 'user', content: results });
  }

  // Out of rounds. Ask for a final answer with tools switched off rather than
  // returning nothing, and never loop indefinitely on somebody's bill.
  const last = await anthropic(key, {
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM + '\n\nAnswer now with what you have. Say plainly what you could not check.',
    messages
  });
  const text = (last.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text: text || 'That took more looking up than I could finish. Ask me a narrower question.', rounds };
}

async function anthropic(key, payload) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 220));
    return await r.json();
  } finally { clearTimeout(t); }
}

async function sb(url, key, path) {
  const r = await fetch(url + '/rest/v1/' + path, {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  if (!r.ok) throw new Error('supabase ' + r.status);
  return await r.json();
}

async function getJson(url) {
  if (!url) throw new Error('no origin to call');
  const r = await fetch(url);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error('that route returned ' + r.status + ', not JSON'); }
}

function up(v) { return String(v || '').toUpperCase().trim(); }

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
