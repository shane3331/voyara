import { NextResponse } from 'next/server';
import { flightStatus } from '@/lib/providers';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const ident = (new URL(req.url).searchParams.get('ident') || '').trim();
  if (!ident) return NextResponse.json({ error: 'ident is required' }, { status: 400 });
  if (!/^[A-Za-z0-9]{2,8}$/.test(ident)) {
    return NextResponse.json({ error: 'ident must be alphanumeric, e.g. AZ631' }, { status: 400 });
  }
  try {
    const { mode, status } = await flightStatus(ident.toUpperCase());
    return NextResponse.json({ mode, status });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'status_unavailable', detail: String(e?.message || e).slice(0, 400) },
      { status: 502 }
    );
  }
}
