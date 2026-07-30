import type { FlightQuery, FlightOffer, StayQuery, StayOffer, FlightStatus } from './types';

/**
 * Deterministic fixtures. These run when no supplier credentials are set,
 * so the app is fully demonstrable with zero accounts. The shapes are
 * identical to the live adapters, which is the point: swapping in real
 * credentials changes no code above this layer.
 */
const iso = (d: string) => new Date(d).toISOString();

export function searchFlights(q: FlightQuery): FlightOffer[] {
  const base = q.departOn || '2026-09-12';
  return [
    {
      id: 'mock_off_az631',
      carrier: 'AZ',
      carrierName: 'ITA Airways',
      segments: `${q.origin} to FCO, FCO to ${q.destination}`,
      departAt: iso(`${base}T18:40:00Z`),
      arriveAt: iso(`${base}T15:20:00Z`),
      durationMinutes: 640,
      stops: 1,
      publicMinor: 214800,
      currency: 'EUR',
      bagIncluded: true,
      changeable: true,
      refundable: false,
      expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString()
    },
    {
      id: 'mock_off_az605',
      carrier: 'AZ',
      carrierName: 'ITA Airways',
      segments: `${q.origin} to MXP nonstop`,
      departAt: iso(`${base}T22:10:00Z`),
      arriveAt: iso(`${base}T12:05:00Z`),
      durationMinutes: 475,
      stops: 0,
      publicMinor: 239000,
      currency: 'EUR',
      bagIncluded: true,
      changeable: true,
      refundable: false,
      expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString()
    },
    {
      id: 'mock_off_lh401',
      carrier: 'LH',
      carrierName: 'Lufthansa',
      segments: `${q.origin} to FRA, FRA to ${q.destination}`,
      departAt: iso(`${base}T16:05:00Z`),
      arriveAt: iso(`${base}T13:40:00Z`),
      durationMinutes: 695,
      stops: 1,
      publicMinor: 190500,
      currency: 'EUR',
      bagIncluded: false,
      changeable: false,
      refundable: false,
      expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString()
    }
  ];
}

export function searchStays(q: StayQuery): StayOffer[] {
  const nights = nightsBetween(q.checkIn, q.checkOut);
  return [
    {
      id: 'mock_stay_portrait',
      name: 'Portrait Milano',
      location: q.destination || 'Milan, Italy',
      roomDescription: 'Suite, king bed',
      nights,
      publicMinor: 318000,
      currency: 'EUR',
      freeCancellationUntil: '2026-09-10T23:59:00+02:00',
      payAtProperty: false,
      taxesIncluded: true
    },
    {
      id: 'mock_stay_grand',
      name: 'Grand Hotel et de Milan',
      location: q.destination || 'Milan, Italy',
      roomDescription: 'Deluxe room',
      nights,
      publicMinor: 294000,
      currency: 'EUR',
      freeCancellationUntil: '2026-09-08T23:59:00+02:00',
      payAtProperty: true,
      taxesIncluded: true
    },
    {
      id: 'mock_stay_bulgari',
      name: 'Bulgari Hotel Milano',
      location: q.destination || 'Milan, Italy',
      roomDescription: 'Premium room, garden view',
      nights,
      publicMinor: 445000,
      currency: 'EUR',
      freeCancellationUntil: null,
      payAtProperty: false,
      taxesIncluded: true
    }
  ];
}

export function flightStatus(ident: string): FlightStatus {
  return {
    ident,
    status: 'Delayed',
    scheduledOut: '2026-09-12T22:40:00Z',
    estimatedOut: '2026-09-13T00:50:00Z',
    scheduledIn: '2026-09-13T06:25:00Z',
    estimatedIn: '2026-09-13T08:35:00Z',
    delayMinutes: 130,
    gate: 'B41',
    terminal: '1',
    observedAt: new Date().toISOString()
  };
}

function nightsBetween(a: string, b: string): number {
  const d1 = new Date(a).getTime();
  const d2 = new Date(b).getTime();
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d2 <= d1) return 5;
  return Math.round((d2 - d1) / 86400000);
}
