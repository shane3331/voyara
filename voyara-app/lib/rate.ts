import { rates } from './env';

/**
 * The commercial model, in one function.
 *
 * Public rate is what any other site charges. The supplier pays a
 * commission on it. Voyara keeps a slice to run the platform and
 * returns the rest to the traveller. The membership, not the markup,
 * is what funds the business.
 *
 * All amounts are minor units (cents) and integers. Never floats for money.
 */
export type Vertical = 'hotel' | 'air' | 'ground';

export interface Rated {
  publicMinor: number;
  commissionMinor: number;
  keepMinor: number;
  rebateMinor: number;
  netMinor: number;
  commissionPct: number;
  keepPct: number;
  currency: string;
}

export function rate(publicMinor: number, vertical: Vertical, currency = 'EUR'): Rated {
  const cfg = rates[vertical];
  const commissionMinor = Math.round(publicMinor * cfg.commission);
  const keepMinor = Math.round(publicMinor * cfg.keep);
  const rebateMinor = Math.max(0, commissionMinor - keepMinor);
  return {
    publicMinor,
    commissionMinor,
    keepMinor,
    rebateMinor,
    netMinor: publicMinor - rebateMinor,
    commissionPct: cfg.commission,
    keepPct: cfg.keep,
    currency
  };
}

export function formatMinor(minor: number, currency = 'EUR'): string {
  const sym = currency === 'EUR' ? '\u20AC' : currency === 'GBP' ? '\u00A3' : '$';
  const neg = minor < 0;
  const s = (Math.abs(minor) / 100).toFixed(2);
  const parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + sym + parts.join('.');
}
