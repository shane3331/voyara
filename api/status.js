// GET /api/status?ident=AZ631
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const ident = String((req.query && req.query.ident) || '').trim().toUpperCase();
  if (!ident) return res.status(400).end(JSON.stringify({ error: 'ident is required' }));
  if (!/^[A-Z0-9]{2,8}$/.test(ident)) {
    return res.status(400).end(JSON.stringify({ error: 'ident must be alphanumeric, e.g. AZ631' }));
  }
  if (!process.env.AEROAPI_KEY) {
    return res.status(200).end(JSON.stringify({
      mode: 'mock',
      status: {
        ident, status: 'Delayed',
        scheduledOut: '2026-09-12T22:40:00Z', estimatedOut: '2026-09-13T00:50:00Z',
        scheduledIn: '2026-09-13T06:25:00Z', estimatedIn: '2026-09-13T08:35:00Z',
        delayMinutes: 130, gate: 'B41', terminal: '1',
        observedAt: new Date().toISOString()
      }
    }));
  }
  try {
    const r = await fetch('https://aeroapi.flightaware.com/aeroapi/flights/' + encodeURIComponent(ident), {
      headers: { 'x-apikey': process.env.AEROAPI_KEY, Accept: 'application/json' }
    });
    if (!r.ok) throw new Error('AeroAPI ' + r.status);
    const j = await r.json();
    const f = (j.flights || [])[0] || {};
    res.status(200).end(JSON.stringify({
      mode: 'live:aeroapi',
      status: {
        ident, status: String(f.status || 'Unknown'),
        scheduledOut: f.scheduled_out || null, estimatedOut: f.estimated_out || null,
        scheduledIn: f.scheduled_in || null, estimatedIn: f.estimated_in || null,
        delayMinutes: Math.round(Number(f.departure_delay || 0) / 60),
        gate: f.gate_origin || null, terminal: f.terminal_origin || null,
        observedAt: new Date().toISOString()
      }
    }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'status_unavailable', detail: String(e.message).slice(0, 300) }));
  }
};
