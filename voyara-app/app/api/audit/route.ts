import { NextResponse } from 'next/server';
import { append, verify, type AuditRecord } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Demonstrates the server side chain. In production these records are rows
 * in Postgres written inside the same transaction as the action they
 * describe, never an in memory array.
 */
export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const events: Array<{ type: string; payload?: unknown; actor?: string }> =
    Array.isArray(body?.events) ? body.events : [];
  if (!events.length) {
    return NextResponse.json({ error: 'events array is required' }, { status: 400 });
  }
  const chain: AuditRecord[] = [];
  for (const e of events.slice(0, 200)) {
    if (typeof e?.type !== 'string' || !e.type) continue;
    append(chain, e.type, e.payload ?? {}, typeof e.actor === 'string' ? e.actor : 'system');
  }
  return NextResponse.json({ chain, verification: verify(chain) });
}
