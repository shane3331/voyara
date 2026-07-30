import { NextResponse } from 'next/server';
import { modes } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'voyara',
    time: new Date().toISOString(),
    providers: {
      air: modes.air(),
      stays: modes.stays(),
      status: modes.status(),
      payments: modes.payments()
    },
    note: 'mock means no credentials are set for that provider yet. The app still works.'
  });
}
