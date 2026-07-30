import { NextResponse } from 'next/server';
import { searchStays } from '@/lib/providers';
import { rate, formatMinor } from '@/lib/rate';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const destination = (p.get('destination') || '').trim();
  const checkIn = p.get('checkIn') || '';
  const checkOut = p.get('checkOut') || '';
  const guests = Number(p.get('guests') || 2);

  if (!destination || !checkIn || !checkOut) {
    return NextResponse.json(
      { error: 'destination, checkIn and checkOut are required' },
      { status: 400 }
    );
  }

  try {
    const { mode, offers } = await searchStays({
      destination,
      checkIn,
      checkOut,
      guests: Number.isFinite(guests) ? guests : 2
    });

    const priced = offers.map((o) => {
      const r = rate(o.publicMinor, 'hotel', o.currency);
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
