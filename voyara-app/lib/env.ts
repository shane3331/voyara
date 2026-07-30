/**
 * Central place to read configuration. Nothing else in the codebase
 * touches process.env directly, so it is always obvious what a missing
 * key disables.
 */
export const env = {
  duffelToken: process.env.DUFFEL_TOKEN || '',
  duffelVersion: process.env.DUFFEL_VERSION || 'v2',
  hotelbedsKey: process.env.HOTELBEDS_API_KEY || '',
  hotelbedsSecret: process.env.HOTELBEDS_SECRET || '',
  hotelbedsBase: process.env.HOTELBEDS_BASE || 'https://api.test.hotelbeds.com',
  aeroapiKey: process.env.AEROAPI_KEY || '',
  stripeSecret: process.env.STRIPE_SECRET_KEY || '',
  stripePrice: process.env.STRIPE_PRICE_ID || '',
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
};

export const rates = {
  hotel: {
    commission: num(process.env.RATE_HOTEL_COMMISSION, 0.15),
    keep: num(process.env.RATE_HOTEL_KEEP, 0.04)
  },
  air: {
    commission: num(process.env.RATE_AIR_COMMISSION, 0.01),
    keep: num(process.env.RATE_AIR_KEEP, 0.005)
  },
  ground: {
    commission: num(process.env.RATE_GROUND_COMMISSION, 0.12),
    keep: num(process.env.RATE_GROUND_KEEP, 0.04)
  }
};

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
}

export type Mode = 'live' | 'mock';
export const modes = {
  air: (): Mode => (env.duffelToken ? 'live' : 'mock'),
  stays: (): Mode => (env.hotelbedsKey && env.hotelbedsSecret ? 'live' : 'mock'),
  status: (): Mode => (env.aeroapiKey ? 'live' : 'mock'),
  payments: (): Mode => (env.stripeSecret && env.stripePrice ? 'live' : 'mock')
};
