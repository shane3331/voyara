// Vercel serverless function. No build step, no dependencies.
module.exports = async (req, res) => {
  const mode = (k) => (process.env[k] ? 'live' : 'mock');
  res.setHeader('content-type', 'application/json');
  res.status(200).end(JSON.stringify({
    ok: true,
    service: 'voyara',
    time: new Date().toISOString(),
    providers: {
      air: mode('DUFFEL_TOKEN'),
      stays: process.env.HOTELBEDS_API_KEY && process.env.HOTELBEDS_SECRET ? 'live' : 'mock',
      status: mode('AEROAPI_KEY'),
      payments: process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID ? 'live' : 'mock'
    },
    note: 'mock means no credentials set for that provider yet. The app still works.'
  }, null, 2));
};
