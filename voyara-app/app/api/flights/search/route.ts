import { NextResponse } from 'next/server';
import { searchFlights } from '@/lib/providers';
import { rate, formatMinor } from '@/lib/rate';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const origin = (p.get('origin') || '').toUpperCase().trim();
  const destination = (p.get('destination') || '').toUpperCase().trim();
  const departOn = p.get('departOn') || '';
  const passengers = Number(p.get('passengers') || 1);

  if (!origin || !destination || !departOn) {
    return NextResponse.json(
      { error: 'origin, destination and departOn are required' },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departOn)) {
    return NextResponse.json({ error: 'departOn must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const { mode, offers } = await searchFlights({
      origin,
      destination,
      departOn,
      returnOn: p.get('returnOn') || undefined,
      passengers: Number.isFinite(passengers) ? passengers : 1
    });

    // Attach the commercial model to every offer, server side, so the
    // rebate can never be computed or tampered with in the browser.
    const priced = offers.map((o) => {
      const r = rate(o.publicMinor, 'air', o.currency);
      return {
        ...o,
        pricing: {
          ...r,
          publicDisplay: formatMinor(r.publicMinor, o.currency),
          netDisplay: formatMinor(r.netMinor, o.currency),
          rebateDisplay: formatMinor(r.rebateMinor, o.currency)
        }
      };
    });

    return NextResponse.json({ mode, count: priced.length, offers: priced });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'supplier_unavailable', detail: String(e?.message || e).slice(0, 500) },
      { status: e?.status && e.status < 600 ? e.status : 502 }
    );
  }
}
