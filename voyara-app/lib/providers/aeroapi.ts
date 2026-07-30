import { env } from '../env';
import type { FlightStatus } from './types';
import { ProviderError } from './duffel';

/**
 * FlightAware AeroAPI. Status observations drive the disruption workflow.
 * VERIFY BEFORE GOING LIVE: written to the documented shape, not executed
 * from the build environment.
 */
export async function flightStatus(ident: string): Promise<FlightStatus> {
  const res = await fetch(
    `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}`,
    { headers: { 'x-apikey': env.aeroapiKey, Accept: 'application/json' }, cache: 'no-store' }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(`AeroAPI failed: ${res.status} ${text.slice(0, 300)}`, res.status);
  }
  const json: any = await res.json();
  const f: any = json?.flights?.[0] ?? {};
  const delaySeconds = Number(f.departure_delay ?? 0);
  return {
    ident,
    status: String(f.status ?? 'Unknown'),
    scheduledOut: f.scheduled_out ?? null,
    estimatedOut: f.estimated_out ?? null,
    scheduledIn: f.scheduled_in ?? null,
    estimatedIn: f.estimated_in ?? null,
    delayMinutes: Number.isFinite(delaySeconds) ? Math.round(delaySeconds / 60) : 0,
    gate: f.gate_origin ?? null,
    terminal: f.terminal_origin ?? null,
    observedAt: new Date().toISOString()
  };
}
