import { createHash, randomUUID } from 'crypto';

/**
 * Hash chained audit records. Same shape the demo uses in the browser,
 * but SHA-256 server side. Each record hashes the one before it, so a
 * row edited directly in the database stops the chain recomputing.
 *
 * In production these rows live in Postgres, append only, with the
 * previous hash read inside the same transaction that writes the new row.
 */
export interface AuditRecord {
  id: string;
  seq: number;
  type: string;
  actor: string;
  occurredAt: string;
  payload: unknown;
  previousHash: string;
  eventHash: string;
}

export const GENESIS = '0'.repeat(64);

export function hashRecord(
  previousHash: string,
  type: string,
  occurredAt: string,
  payload: unknown
): string {
  return createHash('sha256')
    .update(`${previousHash}|${type}|${occurredAt}|${JSON.stringify(payload)}`)
    .digest('hex');
}

export function append(
  chain: AuditRecord[],
  type: string,
  payload: unknown,
  actor = 'system'
): AuditRecord {
  const previousHash = chain.length ? chain[chain.length - 1].eventHash : GENESIS;
  const occurredAt = new Date().toISOString();
  const rec: AuditRecord = {
    id: randomUUID(),
    seq: chain.length + 1,
    type,
    actor,
    occurredAt,
    payload,
    previousHash,
    eventHash: hashRecord(previousHash, type, occurredAt, payload)
  };
  chain.push(rec);
  return rec;
}

export function verify(chain: AuditRecord[]): { ok: boolean; brokenAt: number | null } {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (r.previousHash !== prev) return { ok: false, brokenAt: i };
    if (hashRecord(prev, r.type, r.occurredAt, r.payload) !== r.eventHash) {
      return { ok: false, brokenAt: i };
    }
    prev = r.eventHash;
  }
  return { ok: true, brokenAt: null };
}
