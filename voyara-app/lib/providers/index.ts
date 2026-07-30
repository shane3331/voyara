import { modes } from '../env';
import * as mock from './mock';
import * as duffel from './duffel';
import * as hotelbeds from './hotelbeds';
import * as aeroapi from './aeroapi';
import type { FlightQuery, FlightOffer, StayQuery, StayOffer, FlightStatus } from './types';

/**
 * The only place that decides live or mock. Routes call these and never
 * know which supplier answered. Adding a second air supplier means adding
 * a branch here, not touching any route.
 */
export async function searchFlights(q: FlightQuery): Promise<{ mode: string; offers: FlightOffer[] }> {
  if (modes.air() === 'live') {
    return { mode: 'live:duffel', offers: await duffel.searchFlights(q) };
  }
  return { mode: 'mock', offers: mock.searchFlights(q) };
}

export async function searchStays(q: StayQuery): Promise<{ mode: string; offers: StayOffer[] }> {
  if (modes.stays() === 'live') {
    return { mode: 'live:hotelbeds', offers: await hotelbeds.searchStays(q) };
  }
  return { mode: 'mock', offers: mock.searchStays(q) };
}

export async function flightStatus(ident: string): Promise<{ mode: string; status: FlightStatus }> {
  if (modes.status() === 'live') {
    return { mode: 'live:aeroapi', status: await aeroapi.flightStatus(ident) };
  }
  return { mode: 'mock', status: mock.flightStatus(ident) };
}

export * from './types';
