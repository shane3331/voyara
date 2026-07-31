// POST /api/inbound/email
//
// Where a forwarded confirmation lands. Provider agnostic: it accepts the
// shapes Postmark, Resend, SendGrid, Mailgun and CloudMailin post, because
// every one of them names the same three fields differently.
//
// The content hash is the primary key. The same forward twice cannot create
// two reservations, which is the first failure everyone hits.
//
// Point an inbound address at this URL and it works. Nothing else to wire.
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'POST only' }));

  const secret = process.env.INBOUND_SECRET;
  if (secret) {
    const given = String(req.headers['x-inbound-secret'] || '') ||
      String((req.query && req.query.key) || '');
    if (given !== secret) return res.status(401).end(JSON.stringify({ error: 'unauthorized' }));
  }

  const b = await readJson(req);
  const mail = normalise(b);
  if (!mail.body && !mail.subject) {
    return res.status(400).end(JSON.stringify({ error: 'no recognisable email content in that payload' }));
  }

  const hash = crypto.createHash('sha256')
    .update((mail.from || '') + '|' + (mail.subject || '') + '|' + (mail.body || '')).digest('hex');

  const parsed = parseConfirmation(mail);
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    return res.status(200).end(JSON.stringify({ mode: 'mock', contentHash: hash, parsed, stored: false }));
  }

  // Dedupe at the database, not in code.
  try {
    const ins = await fetch(url + '/rest/v1/inbound_emails', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        content_hash: hash, from_address: mail.from, subject: mail.subject,
        parsed: parsed.confident, parse_result: parsed
      })
    });
    if (ins.status === 409) {
      return res.status(200).end(JSON.stringify({
        mode: 'live:supabase', duplicate: true, contentHash: hash,
        note: 'Already received. No second reservation was created.'
      }));
    }
    if (!ins.ok && ins.status !== 201 && ins.status !== 204) {
      throw new Error('supabase ' + ins.status + ' ' + (await ins.text()).slice(0, 160));
    }
  } catch (e) {
    return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 200) }));
  }

  await appendAudit(url, key, 'trip.import_received', {
    from: mail.from, confident: parsed.confident, kind: parsed.kind
  }, hash);

  // Only file a trip when the parse is confident. A half read confirmation
  // is worse than none, because the traveller will believe it.
  let trip = null;
  if (parsed.confident && parsed.email) {
    trip = await fileTrip(req, parsed);
    await appendAudit(url, key, 'trip.import_parsed', {
      kind: parsed.kind, supplier: parsed.supplier, confidence: parsed.confidence
    }, hash);
  }

  res.status(201).end(JSON.stringify({
    mode: 'live:supabase', contentHash: hash, parsed, trip,
    note: parsed.confident ? 'Filed as a trip.' :
      'Stored but not filed. Confidence was too low to create a reservation from it.'
  }));
};

// Every provider names these differently. Take whichever exists.
function normalise(b) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), b);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  return {
    from: pick('from', 'From', 'sender', 'envelope.from', 'FromFull.Email', 'headers.from'),
    to: pick('to', 'To', 'recipient', 'envelope.to', 'ToFull.0.Email'),
    subject: pick('subject', 'Subject', 'headers.subject'),
    body: pick('text', 'TextBody', 'body-plain', 'plain', 'body', 'html', 'HtmlBody', 'body-html')
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
  };
}

// Heuristic extraction. Deliberately conservative: it would rather return
// low confidence than invent a booking reference.
function parseConfirmation(mail) {
  const text = (mail.subject + ' ' + mail.body);
  const low = text.toLowerCase();

  const air = /\b(flight|boarding|departure|airline|pnr|e-?ticket|passenger|gate|seat)\b/.test(low);
  const dining = /\b(table|covers|restaurant|dinner|lunch|party of)\b/.test(low);
  const ground = /\b(pickup|chauffeur|driver|transfer|vehicle)\b/.test(low);
  const stay = /\b(hotel|check.?in|check.?out|room|suite|nights?|stay|guest|property|resort|riad|villa)\b/.test(low);

  const kind = air ? 'AIR'
    : ground ? 'GROUND'
      : dining ? 'DINING'
        : stay ? 'HOTEL'
          // A bare "reservation" with no air, dining or ground signal is
          // almost always a stay. Weak, but better than UNKNOWN.
          : /\breservation\b/.test(low) ? 'HOTEL' : 'UNKNOWN';

  const dates = [];
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/g) || [];
  iso.forEach((d) => dates.push(d));
  const written = text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(20\d{2})\b/gi) || [];
  written.forEach((m) => {
    const p = m.match(/(\d{1,2})\s+(\w{3})[a-z]*\s+(20\d{2})/i);
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const mm = months[p[2].toLowerCase()];
    if (mm) dates.push(p[3] + '-' + mm + '-' + ('0' + p[1]).slice(-2));
  });
  dates.sort();

  // A reference is only taken when the text says it is one, AND the token
  // looks like a reference rather than an English word. The case insensitive
  // flag makes [A-Z0-9] match lowercase too, which happily captured the word
  // "confirmed" out of "Reservation confirmed". Requiring a digit and
  // rejecting known words fixes that. A missing reference is recoverable.
  // A wrong one is not.
  const reference = findReference(text);

  const emailMatch = (mail.from || '').match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  const forwardedFor = text.match(/\b(?:for|guest|passenger|traveller|traveler)[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/);

  const nameMatch = mail.subject.match(/(?:at|for)\s+([A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){0,4})/);
  const supplier = nameMatch ? nameMatch[1].trim() : (emailMatch ? emailMatch[0].split('@')[1] : null);

  let confidence = 0;
  if (kind !== 'UNKNOWN') confidence += 0.35;
  if (reference) confidence += 0.3;
  if (dates.length >= 1) confidence += 0.2;
  if (dates.length >= 2) confidence += 0.1;
  if (supplier) confidence += 0.05;

  return {
    kind, supplier, reference,
    startsOn: dates[0] || null,
    endsOn: dates.length > 1 ? dates[dates.length - 1] : null,
    guestName: forwardedFor ? forwardedFor[1] : null,
    email: emailMatch ? null : null,   // set by the caller from the envelope
    confidence: Math.round(confidence * 100) / 100,
    confident: confidence >= 0.65
  };
}

const REF_WORDS = ['confirmed','confirm','booking','bookings','reservation','reservations','reference',
  'number','numbers','code','details','detail','itinerary','received','pending','cancelled','canceled',
  'updated','changed','complete','completed','locator','record','information','below','above','follows'];

const REF_KEYWORDS = ['confirmation','booking','reservation','reference','locator','pnr','conf'];

// Token based rather than one regex. A single expression kept swallowing
// "Booking reference" as a whole match and stepping past the actual code
// that followed it. Walking tokens after each keyword is easier to reason
// about and easier to fix when a supplier writes something new.
function findReference(text) {
  const tokens = String(text).split(/[\s,;:()\[\]<>"']+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i].toLowerCase().replace(/[^a-z]/g, '');
    if (REF_KEYWORDS.indexOf(word) < 0) continue;
    // Look at the next few tokens. Qualifiers like "number" or "reference"
    // sit between the keyword and the value more often than not.
    for (let j = i + 1; j <= Math.min(i + 4, tokens.length - 1); j++) {
      const cand = looksLikeReference(tokens[j]);
      if (cand) return cand;
    }
  }
  return null;
}

function looksLikeReference(raw) {
  const t = String(raw).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  if (t.length < 5 || t.length > 14) return null;
  if (!/^[A-Za-z0-9-]+$/.test(t)) return null;
  if (REF_WORDS.indexOf(t.toLowerCase()) >= 0) return null;   // an English word
  if (!/[0-9]/.test(t)) return null;                          // references carry digits
  if (/^(19|20)\d{2}$/.test(t)) return null;                  // a year
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(t)) return null;          // a date
  if (/^\d{1,2}[:.]\d{2}$/.test(t)) return null;              // a time
  return t.toUpperCase();
}

async function fileTrip(req, parsed) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) return null;
    const r = await fetch(String(req.headers['x-forwarded-proto'] || 'https') + '://' + host + '/api/trips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: parsed.email,
        title: parsed.supplier || 'Forwarded booking',
        startsOn: parsed.startsOn, endsOn: parsed.endsOn,
        source: 'email_import',
        reservation: {
          type: parsed.kind, supplier: parsed.supplier, name: parsed.supplier,
          reference: parsed.reference, checkIn: parsed.startsOn, checkOut: parsed.endsOn,
          status: 'CONFIRMED', importConfidence: parsed.confidence
        }
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.trip ? j.trip : null;
  } catch (e) { return null; }
}

async function appendAudit(url, key, type, payload, subject) {
  try {
    await fetch(url + '/rest/v1/rpc/append_audit', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_type: type, p_actor: 'import-worker', p_payload: payload, p_subject_type: 'inbound_email', p_subject_id: subject })
    });
  } catch (e) { /* the email row is already stored */ }
}
function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(d || '{}')); }
      catch { // some providers post form encoded
        try {
          const o = {}; new URLSearchParams(d).forEach((v, k) => { o[k] = v; }); resolve(o);
        } catch { resolve({}); }
      }
    });
    req.on('error', () => resolve({}));
  });
}
