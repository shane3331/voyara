// GET /api/collections            -> every published collection
// GET /api/collections?slug=x     -> one
//
// A collection is editorial framing around a real destination. It carries no
// prices of its own on purpose: opening one runs a live search, so the copy
// can be curated for months while the rates are never more than a second old.
//
// Rows live in Supabase so collections can be written and reordered from the
// Table Editor without a deploy. The seed list below is the fallback.
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'GET') return res.status(405).end(JSON.stringify({ error: 'GET only' }));

  const slug = String((req.query && req.query.slug) || '').trim();
  if (slug && !/^[a-z0-9-]{1,80}$/.test(slug)) {
    return res.status(400).end(JSON.stringify({ error: 'slug is not valid' }));
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) return respond(res, 'seed', SEED, slug);

  try {
    const q = url + '/rest/v1/collections?select=*&status=eq.PUBLISHED&order=sort_order.asc' +
      (slug ? '&slug=eq.' + encodeURIComponent(slug) : '');
    const r = await fetch(q, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (!r.ok) throw new Error('supabase ' + r.status);
    const rows = await r.json();
    if (!rows.length) return respond(res, 'seed', SEED, slug);
    return respond(res, 'live:supabase', rows.map(fromRow), slug);
  } catch (e) {
    // A database blip should not empty the front page.
    return respond(res, 'seed', SEED, slug, String(e.message).slice(0, 160));
  }
};

function respond(res, mode, list, slug, warning) {
  const withDates = list.map(datedCollection);
  if (slug) {
    const one = withDates.filter((c) => c.slug === slug)[0];
    if (!one) return res.status(404).end(JSON.stringify({ error: 'no collection with that slug' }));
    return res.status(200).end(JSON.stringify({ mode, collection: one, warning }));
  }
  res.status(200).end(JSON.stringify({ mode, count: withDates.length, collections: withDates, warning }));
}

// Each collection carries a lead time and a length rather than fixed dates,
// so it never goes stale and never offers dates in the past.
function datedCollection(c) {
  const start = new Date();
  start.setUTCHours(12, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + (Number(c.leadDays) || 45));
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + (Number(c.nights) || 5));
  return Object.assign({}, c, {
    checkIn: start.toISOString().slice(0, 10),
    checkOut: end.toISOString().slice(0, 10)
  });
}

function fromRow(r) {
  return {
    slug: r.slug, title: r.title, subtitle: r.subtitle, destination: r.destination,
    narrative: r.narrative, imageId: r.image_id,
    nights: r.nights, leadDays: r.lead_days
  };
}

const SEED = [
  { slug:'la-dolce-vita', title:'La dolce vita', subtitle:'Amalfi Coast, Italy', destination:'Positano',
    narrative:'Cliffside terraces, lemon groves, and a coastline best seen from a boat. Go in shoulder season and the road is yours.',
    imageId:'photo-1516483638261-f4dbaf036963', nights:5, leadDays:45 },
  { slug:'milano-quietly', title:'Milan, quietly', subtitle:'Lombardy, Italy', destination:'Milan',
    narrative:'Not the fashion week Milan. Courtyards behind heavy doors, aperitivo at six, and the Last Supper booked eight weeks out.',
    imageId:'photo-1520440229-6469a149ac59', nights:4, leadDays:30 },
  { slug:'cyclades', title:'Meet me in the Cyclades', subtitle:'Mykonos, Greece', destination:'Mykonos',
    narrative:'White walls, hard light, and a sea that stays warm into October. Book the ferry before the flight.',
    imageId:'photo-1613395877344-13d4a8e0d49e', nights:6, leadDays:60 },
  { slug:'tokyo-after-dark', title:'Tokyo after dark', subtitle:'Tokyo, Japan', destination:'Tokyo',
    narrative:'The city rearranges itself at night. Stay central, walk more than you plan to, and let the trains close without you.',
    imageId:'photo-1540959733332-eab4deabeeaf', nights:6, leadDays:75 },
  { slug:'long-weekend-paris', title:'The long weekend', subtitle:'Paris, France', destination:'Paris',
    narrative:'Four nights is enough if you stop trying to see everything. One museum, one long lunch, one walk with no destination.',
    imageId:'photo-1502602898657-3e91760cbb34', nights:4, leadDays:21 },
  { slug:'marrakech', title:'Behind the red walls', subtitle:'Marrakech, Morocco', destination:'Marrakech',
    narrative:'The medina is loud until you step through a door, and then it is not. Riads are cool, dark, and entirely silent.',
    imageId:'photo-1539020140153-e479b8c22e70', nights:5, leadDays:50 },
  { slug:'costa-del-sol', title:'The long Spanish summer', subtitle:'Marbella, Spain', destination:'Marbella',
    narrative:'Late lunches that become dinners. The old town is worth the twenty minutes it takes to walk into.',
    imageId:'photo-1566073771259-6a8506099945', nights:7, leadDays:40 },
  { slug:'new-york-december', title:'The city in December', subtitle:'New York, USA', destination:'New York',
    narrative:'Cold enough to justify the coat, bright enough to walk from downtown to the park without noticing.',
    imageId:'photo-1496442226666-8d4d0e62e6e9', nights:4, leadDays:120 }
];
