// GET  /api/villas            -> the curated collection
// POST /api/villas            -> a request to book one
//
// Villas are not an inventory problem. There is no equivalent of Duffel for
// the properties a member actually wants, and the ones in aggregator feeds
// are not those properties. So this is a curated list with a request flow,
// which is also the only part of the supply chain a competitor cannot copy
// by signing up for an API.
//
// Rows live in Supabase so properties can be added from the Table Editor
// without touching code. The seed list below is a fallback.
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const configured = Boolean(url && key);

  if (req.method === 'GET') {
    if (!configured) return res.status(200).end(JSON.stringify({ mode: 'seed', villas: SEED.map(price) }));
    try {
      const r = await fetch(url + '/rest/v1/villas?select=*&status=eq.AVAILABLE&order=sort_order.asc', { headers: auth(key) });
      if (!r.ok) throw new Error('supabase ' + r.status);
      const rows = await r.json();
      const list = rows.length ? rows.map(fromRow) : SEED;
      return res.status(200).end(JSON.stringify({
        mode: rows.length ? 'live:supabase' : 'seed',
        villas: list.map(price)
      }));
    } catch (e) {
      return res.status(200).end(JSON.stringify({ mode: 'seed', villas: SEED.map(price), warning: String(e.message).slice(0, 160) }));
    }
  }

  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'GET or POST only' }));

  const body = await readJson(req);
  const slug = String(body.slug || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase();
  const guests = Number(body.guests) || null;
  const arrive = String(body.arriveOn || '').trim();
  const depart = String(body.departOn || '').trim();

  if (!slug) return res.status(400).end(JSON.stringify({ error: 'slug is required' }));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).end(JSON.stringify({ error: 'a valid email is required' }));
  }
  for (const [d, label] of [[arrive, 'arriveOn'], [depart, 'departOn']]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return res.status(400).end(JSON.stringify({ error: label + ' must be YYYY-MM-DD' }));
    }
  }
  if (arrive && depart && new Date(depart) <= new Date(arrive)) {
    return res.status(400).end(JSON.stringify({ error: 'departOn must be after arriveOn' }));
  }

  if (!configured) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock', saved: false,
      message: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY to actually record this request.'
    }));
  }

  try {
    const r = await fetch(url + '/rest/v1/villa_requests', {
      method: 'POST',
      headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({
        villa_slug: slug, email,
        name: body.name ? String(body.name).slice(0, 120) : null,
        arrive_on: arrive || null, depart_on: depart || null,
        guests: guests && guests > 0 && guests < 40 ? guests : null,
        notes: body.notes ? String(body.notes).slice(0, 1000) : null
      })
    });
    if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const saved = (await r.json())[0] || {};

    try {
      await fetch(url + '/rest/v1/rpc/append_audit', {
        method: 'POST',
        headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          p_type: 'villa.requested', p_actor: 'traveler',
          p_payload: { villa: slug, guests: guests || null },
          p_subject_type: 'villa_request', p_subject_id: String(saved.id || slug)
        })
      });
    } catch (e) { /* never lose the request over an audit failure */ }

    res.status(201).end(JSON.stringify({ mode: 'live:supabase', saved: true, requestId: saved.id || null }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 300) }));
  }
};

// Commission is returned to the traveller here exactly as it is on hotels.
function price(v) {
  const commission = Math.round(v.nightlyMinor * (v.commissionPct != null ? v.commissionPct : 0.15));
  const keep = Math.round(v.nightlyMinor * (v.keepPct != null ? v.keepPct : 0.04));
  const rebate = Math.max(0, commission - keep);
  return Object.assign({}, v, {
    pricing: {
      nightlyMinor: v.nightlyMinor, rebateMinor: rebate,
      netMinor: v.nightlyMinor - rebate, currency: v.currency,
      nightlyDisplay: money(v.nightlyMinor, v.currency),
      netDisplay: money(v.nightlyMinor - rebate, v.currency),
      rebateDisplay: money(rebate, v.currency)
    }
  });
}
function fromRow(r) {
  return {
    slug: r.slug, name: r.name, location: r.location, region: r.region,
    bedrooms: r.bedrooms, sleeps: r.sleeps,
    nightlyMinor: r.nightly_minor, currency: r.currency,
    commissionPct: r.commission_pct != null ? Number(r.commission_pct) : 0.15,
    keepPct: r.keep_pct != null ? Number(r.keep_pct) : 0.04,
    summary: r.summary, imageId: r.image_id
  };
}

const SEED = [
  { slug:'casa-aurelia', name:'Casa Aurelia', location:'Amalfi Coast, Italy', region:'Mediterranean', bedrooms:5, sleeps:10, nightlyMinor:420000, currency:'EUR', summary:'Cliffside terraces above Praiano. Staffed, with a boat on call.', imageId:'photo-1516483638261-f4dbaf036963' },
  { slug:'villa-thalia', name:'Villa Thalia', location:'Mykonos, Greece', region:'Greek Islands', bedrooms:6, sleeps:12, nightlyMinor:510000, currency:'EUR', summary:'Whitewashed and end of the road, with an infinity pool facing the sunset.', imageId:'photo-1613395877344-13d4a8e0d49e' },
  { slug:'lacustre', name:'Lacustre', location:'Lake Como, Italy', region:'Italian Lakes', bedrooms:4, sleeps:8, nightlyMinor:385000, currency:'EUR', summary:'A restored boathouse in Ossuccio. Private jetty, wood fired kitchen.', imageId:'photo-1520250497591-112f2f40a3f4' },
  { slug:'mas-de-lourmarin', name:'Mas de Lourmarin', location:'Luberon, France', region:'Provence', bedrooms:5, sleeps:10, nightlyMinor:295000, currency:'EUR', summary:'A working olive farm with a long table under plane trees.', imageId:'photo-1502602898657-3e91760cbb34' },
  { slug:'finca-benirras', name:'Finca Benirras', location:'Ibiza, Spain', region:'Balearics', bedrooms:6, sleeps:12, nightlyMinor:440000, currency:'EUR', summary:'Above the bay, twenty minutes from anywhere you want to be at 2am.', imageId:'photo-1566073771259-6a8506099945' },
  { slug:'casa-zahra', name:'Casa Zahra', location:'Marrakech, Morocco', region:'North Africa', bedrooms:4, sleeps:8, nightlyMinor:215000, currency:'EUR', summary:'A riad three streets from Jemaa el Fna, silent behind its own door.', imageId:'photo-1539020140153-e479b8c22e70' },
  { slug:'podere-santa-lucia', name:'Podere Santa Lucia', location:"Val d'Orcia, Italy", region:'Tuscany', bedrooms:5, sleeps:10, nightlyMinor:265000, currency:'EUR', summary:'Cypress drive, stone farmhouse, the whole valley to yourself.', imageId:'photo-1523906834658-6e24ef2386f9' },
  { slug:'maison-des-vents', name:'Maison des Vents', location:'St Barths', region:'Caribbean', bedrooms:4, sleeps:8, nightlyMinor:680000, currency:'EUR', summary:'Gustavia harbour below, trade winds through the whole house.', imageId:'photo-1512453979798-5ea266f8880c' }
];

function auth(key) { return { apikey: key, Authorization: 'Bearer ' + key }; }
function money(minor, cur) {
  const sym = cur === 'EUR' ? '\u20AC' : cur === 'GBP' ? '\u00A3' : '$';
  const p = (Math.abs(minor) / 100).toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (minor < 0 ? '-' : '') + sym + p.join('.');
}
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
