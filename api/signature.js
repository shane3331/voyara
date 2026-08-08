// GET  /api/signature?destination=Miami  -> the curated list for a place
// POST /api/signature                    -> request a property we cannot yet price
//
// Bedbank inventory skews mid market. These are the properties worth being
// known for, written by hand. The front end matches them against the live
// search: anything found gets pinned with real rates, anything absent is
// offered on request and sourced by an operator.
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (req.method === 'POST') {
    const b = await readJson(req);
    const slug = String(b.slug || '').trim().slice(0, 80);
    const email = String(b.email || '').trim().toLowerCase();
    if (!slug) return res.status(400).end(JSON.stringify({ error: 'slug is required' }));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).end(JSON.stringify({ error: 'a valid email is required' }));
    }
    for (const [d, l] of [[b.arriveOn, 'arriveOn'], [b.departOn, 'departOn']]) {
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
        return res.status(400).end(JSON.stringify({ error: l + ' must be YYYY-MM-DD' }));
      }
    }
    if (b.arriveOn && b.departOn && new Date(b.departOn) <= new Date(b.arriveOn)) {
      return res.status(400).end(JSON.stringify({ error: 'departOn must be after arriveOn' }));
    }
    if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'mock', saved: false }));

    try {
      const r = await fetch(url + '/rest/v1/signature_requests', {
        method: 'POST',
        headers: Object.assign(auth(key), { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify({
          hotel_slug: slug, email,
          arrive_on: b.arriveOn || null, depart_on: b.departOn || null,
          guests: Number(b.guests) > 0 ? Number(b.guests) : null,
          notes: b.notes ? String(b.notes).slice(0, 1000) : null
        })
      });
      if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 160));
      const saved = (await r.json())[0] || {};
      try {
        await fetch(url + '/rest/v1/rpc/append_audit', {
          method: 'POST',
          headers: Object.assign(auth(key), { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            p_type: 'signature.requested', p_actor: 'traveler',
            p_payload: { hotel: slug }, p_subject_type: 'signature_request', p_subject_id: String(saved.id || slug)
          })
        });
      } catch (e) { /* never lose the request over an audit failure */ }
      return res.status(201).end(JSON.stringify({ mode: 'live:supabase', saved: true, requestId: saved.id || null }));
    } catch (e) {
      return res.status(502).end(JSON.stringify({ error: 'db_unavailable', detail: String(e.message).slice(0, 250) }));
    }
  }

  if (req.method !== 'GET') return res.status(405).end(JSON.stringify({ error: 'GET or POST only' }));

  const destination = String((req.query && req.query.destination) || '').trim();
  if (!destination) return res.status(400).end(JSON.stringify({ error: 'destination is required' }));
  const city = destination.split(',')[0].trim().toLowerCase();

  if (!url || !key) return res.status(200).end(JSON.stringify({ mode: 'seed', hotels: forCity(SEED, city) }));

  try {
    const r = await fetch(
      url + '/rest/v1/signature_hotels?select=*&status=eq.PUBLISHED&order=sort_order.asc',
      { headers: auth(key) }
    );
    if (!r.ok) throw new Error('supabase ' + r.status);
    const rows = await r.json();
    const list = rows.length ? rows.map(fromRow) : SEED;
    return res.status(200).end(JSON.stringify({
      mode: rows.length ? 'live:supabase' : 'seed',
      hotels: forCity(list, city)
    }));
  } catch (e) {
    return res.status(200).end(JSON.stringify({ mode: 'seed', hotels: forCity(SEED, city), warning: String(e.message).slice(0, 150) }));
  }
};

function forCity(list, city) {
  if (!city) return [];
  return list.filter((h) => String(h.city).toLowerCase() === city);
}

function fromRow(r) {
  return {
    slug: r.slug, name: r.name, aliases: r.aliases || [], city: r.city,
    countryCode: r.country_code, brand: r.brand, note: r.note, imageUrl: r.image_url
  };
}

const SEED = [
  { slug:'the-setai', name:'The Setai', aliases:['Setai Miami Beach'], city:'Miami', countryCode:'US', brand:'Independent', note:'Art deco bones, three pools at different temperatures, and the quietest stretch of sand on Collins.' , imageUrl:'https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?w=900&q=72&auto=format&fit=crop' },
  { slug:'faena-miami', name:'Faena Hotel Miami Beach', aliases:['Faena'], city:'Miami', countryCode:'US', brand:'Faena', note:'Theatrical in a way nowhere else in Miami attempts. The gilded mammoth is not a joke.' , imageUrl:'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=900&q=72&auto=format&fit=crop' },
  { slug:'fs-surf-club', name:'Four Seasons Hotel at The Surf Club', aliases:['Surf Club','Four Seasons Surf Club'], city:'Miami', countryCode:'US', brand:'Four Seasons', note:'A 1930s beach club restored by Richard Meier. Le Sirenuse runs the restaurant.' , imageUrl:'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=900&q=72&auto=format&fit=crop' },
  { slug:'1-hotel-south-beach', name:'1 Hotel South Beach', aliases:['1 Hotel'], city:'Miami', countryCode:'US', brand:'1 Hotels', note:'Reclaimed wood and living walls. The rooftop pool is adults only and worth it.' , imageUrl:'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=900&q=72&auto=format&fit=crop' },
  { slug:'ritz-south-beach', name:'The Ritz-Carlton South Beach', aliases:['Ritz Carlton South Beach'], city:'Miami', countryCode:'US', brand:'Ritz-Carlton', note:'Morris Lapidus building, properly restored.' , imageUrl:'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=900&q=72&auto=format&fit=crop' },
  { slug:'mandarin-miami', name:'Mandarin Oriental Miami', aliases:['Mandarin Miami'], city:'Miami', countryCode:'US', brand:'Mandarin Oriental', note:'On Brickell Key, which means water on three sides and no traffic.' , imageUrl:'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=900&q=72&auto=format&fit=crop' },
  { slug:'portrait-milano', name:'Portrait Milano', aliases:['Portrait Hotel Milano'], city:'Milan', countryCode:'IT', brand:'Lungarno', note:'A former seminary with the largest private courtyard in the city.' , imageUrl:'https://images.unsplash.com/photo-1595576508898-0ad5c879a061?w=900&q=72&auto=format&fit=crop' },
  { slug:'bulgari-milano', name:'Bulgari Hotel Milano', aliases:['Bulgari Milan'], city:'Milan', countryCode:'IT', brand:'Bulgari', note:'A private garden bigger than most Milanese parks, hidden behind Via Manzoni.' , imageUrl:'https://images.unsplash.com/photo-1611892440504-42a792e24d32?w=900&q=72&auto=format&fit=crop' },
  { slug:'fs-milano', name:'Four Seasons Hotel Milano', aliases:['Four Seasons Milan'], city:'Milan', countryCode:'IT', brand:'Four Seasons', note:'A fifteenth century convent. The cloister rooms are the ones to ask for.' , imageUrl:'https://images.unsplash.com/photo-1618773928121-c32242e63f39?w=900&q=72&auto=format&fit=crop' },
  { slug:'le-sirenuse', name:'Le Sirenuse', aliases:['Sirenuse'], city:'Positano', countryCode:'IT', brand:'Independent', note:'Still family run. The pool terrace at seven in the evening is the whole point of the coast.' , imageUrl:'https://images.unsplash.com/photo-1516483638261-f4dbaf036963?w=900&q=72&auto=format&fit=crop' },
  { slug:'bill-and-coo', name:'Bill & Coo Mykonos', aliases:['Bill and Coo'], city:'Mykonos', countryCode:'GR', brand:'Independent', note:'Adults only above Megali Ammos, facing the sunset squarely.' , imageUrl:'https://images.unsplash.com/photo-1613395877344-13d4a8e0d49e?w=900&q=72&auto=format&fit=crop' },
  { slug:'aman-tokyo', name:'Aman Tokyo', aliases:['Aman'], city:'Tokyo', countryCode:'JP', brand:'Aman', note:'The top six floors of the Otemachi Tower. The lobby is thirty metres tall.' , imageUrl:'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=900&q=72&auto=format&fit=crop' },
  { slug:'le-bristol', name:'Le Bristol Paris', aliases:['Bristol Paris'], city:'Paris', countryCode:'FR', brand:'Oetker', note:'A courtyard garden in the eighth, and a cat called Fa-Raon.' , imageUrl:'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=900&q=72&auto=format&fit=crop' },
  { slug:'the-carlyle', name:'The Carlyle', aliases:['Carlyle'], city:'New York', countryCode:'US', brand:'Rosewood', note:'Bemelmans Bar. Nothing else needs saying.' , imageUrl:'https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=900&q=72&auto=format&fit=crop' },
  { slug:'la-mamounia', name:'La Mamounia', aliases:['Mamounia'], city:'Marrakech', countryCode:'MA', brand:'Independent', note:'Twenty acres of gardens inside the walls, some of them two centuries old.' , imageUrl:'https://images.unsplash.com/photo-1539020140153-e479b8c22e70?w=900&q=72&auto=format&fit=crop' },
  { slug:'marbella-club', name:'Marbella Club Hotel', aliases:['Marbella Club'], city:'Marbella', countryCode:'ES', brand:'Independent', note:'The one that started the Costa del Sol, and still the best of it.' , imageUrl:'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=900&q=72&auto=format&fit=crop' }
];

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
