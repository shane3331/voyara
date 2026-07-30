import { env } from '../env';
import type { FlightQuery, FlightOffer } from './types';

/**
 * Duffel air adapter.
 *
 * Duffel Managed Content means you can sell flights on Duffel's own
 * accreditation rather than holding IATA or ARC yourself, and Duffel
 * Payments can act as merchant of record. That is what makes this the
 * fastest honest path to a real booking.
 *
 * VERIFY BEFORE GOING LIVE: this adapter is written to Duffel's
 * documented request and response shape, but it has not been executed
 * against their servers from the build environment. Run the smoke test
 * in README before trusting it with a real card:
 *   curl "$SITE/api/flights/search?origin=JFK&destination=MIL&departOn=2026-09-12"
 * Confirm the Duffel-Version header value against their current docs.
 */
const API = 'https://api.duffel.com';

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.duffelToken}`,
    'Duffel-Version': env.duffelVersion,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

interface DuffelSlice { origin: string; destination: string; departure_date: string }

export async function searchFlights(q: FlightQuery): Promise<FlightOffer[]> {
  const slices: DuffelSlice[] = [
    { origin: q.origin, destination: q.destination, departure_date: q.departOn }
  ];
  if (q.returnOn) {
    slices.push({ origin: q.destination, destination: q.origin, departure_date: q.returnOn });
  }

  const body = {
    data: {
      slices,
      passengers: Array.from({ length: Math.max(1, q.passengers) }, () => ({ type: 'adult' })),
      cabin_class: q.cabin || 'economy'
    }
  };

  const res = await fetch(`${API}/air/offer_requests?return_offers=true`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    cache: 'no-store'
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(`Duffel offer_requests failed: ${res.status} ${text.slice(0, 400)}`, res.status);
  }

  const json: any = await res.json();
  const offers: any[] = json?.data?.offers ?? [];
  return offers.slice(0, 12).map(normalise).filter(Boolean) as FlightOffer[];
}

function normalise(o: any): FlightOffer | null {
  try {
    const slices: any[] = o.slices ?? [];
    const first = slices[0];
    const last = slices[slices.length - 1];
    const firstSeg = first?.segments?.[0];
    const lastSeg = last?.segments?.[last.segments.length - 1];
    const stops = slices.reduce(
      (n: number, s: any) => n + Math.max(0, (s.segments?.length ?? 1) - 1),
      0
    );
    const bags = firstSeg?.passengers?.[0]?.baggages ?? [];
    const checked = bags.find((b: any) => b.type === 'checked');

    return {
      id: String(o.id),
      carrier: String(o.owner?.iata_code ?? ''),
      carrierName: String(o.owner?.name ?? 'Unknown carrier'),
      segments: slices
        .map((s: any) => `${s.origin?.iata_code} to ${s.destination?.iata_code}`)
        .join(', '),
      departAt: String(firstSeg?.departing_at ?? ''),
      arriveAt: String(lastSeg?.arriving_at ?? ''),
      durationMinutes: parseIso8601Minutes(first?.duration),
      stops,
      // Duffel returns decimal strings. Convert to integer minor units.
      publicMinor: toMinor(o.total_amount),
      currency: String(o.total_currency ?? 'EUR'),
      bagIncluded: Boolean(checked && Number(checked.quantity) > 0),
      changeable: o.conditions?.change_before_departure?.allowed === true,
      refundable: o.conditions?.refund_before_departure?.allowed === true,
      expiresAt: o.expires_at ? String(o.expires_at) : null
    };
  } catch {
    return null;
  }
}

export function toMinor(amount: unknown): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function parseIso8601Minutes(dur: unknown): number {
  if (typeof dur !== 'string') return 0;
  const m = dur.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}
