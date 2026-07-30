import { createHash } from 'crypto';
import { env } from '../env';
import type { StayQuery, StayOffer } from './types';
import { ProviderError } from './duffel';

/**
 * Hotelbeds adapter. Net rates, which is where the margin actually is,
 * because air pays close to nothing.
 *
 * Hotelbeds signs every request with SHA-256 of apiKey + secret + unix
 * seconds, sent as X-Signature.
 *
 * VERIFY BEFORE GOING LIVE: written to the documented shape, not executed
 * against their servers from the build environment. Their test host is
 * api.test.hotelbeds.com and rate limits on the free tier are strict.
 */
export function signature(): { sig: string; ts: number } {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHash('sha256')
    .update(env.hotelbedsKey + env.hotelbedsSecret + ts)
    .digest('hex');
  return { sig, ts };
}

export async function searchStays(q: StayQuery): Promise<StayOffer[]> {
  const { sig } = signature();
  const body = {
    stay: { checkIn: q.checkIn, checkOut: q.checkOut },
    occupancies: [{ rooms: 1, adults: Math.max(1, q.guests), children: 0 }],
    destination: { code: q.destination }
  };

  const res = await fetch(`${env.hotelbedsBase}/hotel-api/1.0/hotels`, {
    method: 'POST',
    headers: {
      'Api-key': env.hotelbedsKey,
      'X-Signature': sig,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    cache: 'no-store'
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(`Hotelbeds search failed: ${res.status} ${text.slice(0, 400)}`, res.status);
  }

  const json: any = await res.json();
  const hotels: any[] = json?.hotels?.hotels ?? [];
  const nights = nights_between(q.checkIn, q.checkOut);

  return hotels.slice(0, 12).map((h: any): StayOffer => {
    const room = h.rooms?.[0];
    const r = room?.rates?.[0];
    const cancel = r?.cancellationPolicies?.[0];
    return {
      id: String(h.code ?? room?.code ?? crypto.randomUUID?.() ?? Math.random()),
      name: String(h.name ?? 'Property'),
      location: String(h.destinationName ?? q.destination),
      roomDescription: String(room?.name ?? 'Room'),
      nights,
      publicMinor: Math.round(Number(r?.net ?? h.minRate ?? 0) * 100),
      currency: String(json?.hotels?.currency ?? 'EUR'),
      freeCancellationUntil: cancel?.from ? String(cancel.from) : null,
      payAtProperty: String(r?.paymentType ?? '') === 'AT_HOTEL',
      taxesIncluded: true
    };
  });
}

function nights_between(a: string, b: string): number {
  const d1 = new Date(a).getTime();
  const d2 = new Date(b).getTime();
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d2 <= d1) return 1;
  return Math.round((d2 - d1) / 86400000);
}
