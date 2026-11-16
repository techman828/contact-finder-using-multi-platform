/**
 * API key store: several keys per provider, managed from the Settings page only.
 *
 * Usage order for a search = enabled keys by position, except keys that recently failed with a
 * key-specific error (out of credits, invalid, disabled) or are known to have 0 credits — those go
 * last, so a healthy key is tried first but a "bad" key can still be used once it recovers.
 */
import type { TransactionSql } from 'postgres';
import { db } from './db';
import type { PublicKey } from './types';

/** Errors that mean "this key can't serve the request, but another key might". */
export const FAILOVER_CODES = new Set(['NO_CREDITS', 'INVALID_API_KEY', 'ACCOUNT_DISABLED', 'RATE_LIMITED']);
/** Errors that demote a key to the end of the order for a while. */
const DEMOTE_CODES = ['NO_CREDITS', 'INVALID_API_KEY', 'ACCOUNT_DISABLED'];
const DEMOTE_HOURS = 24;

export interface KeyRow {
  id: number;
  provider: string;
  label: string;
  api_key: string;
  position: number;
  enabled: boolean;
  credits: number | null;
  credits_checked_at: Date | null;
  last_error_code: string | null;
  last_error_at: Date | null;
  last_used_at: Date | null;
}

export const maskKey = (k: string) => (k.length > 8 ? `••••${k.slice(-4)}` : '••••');

export function toPublicKey(k: KeyRow): PublicKey {
  return {
    id: k.id,
    label: k.label,
    preview: maskKey(k.api_key),
    enabled: k.enabled,
    credits: k.credits,
    creditsCheckedAt: k.credits_checked_at ? new Date(k.credits_checked_at).toISOString() : null,
    lastErrorCode: k.last_error_code,
    lastErrorAt: k.last_error_at ? new Date(k.last_error_at).toISOString() : null,
    lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
  };
}

export async function listKeys(): Promise<KeyRow[]> {
  const sql = await db();
  return (await sql`SELECT * FROM api_keys ORDER BY provider, position, id`) as unknown as KeyRow[];
}

export async function getKey(id: number): Promise<KeyRow | null> {
  const sql = await db();
  const [k] = await sql`SELECT * FROM api_keys WHERE id = ${id}`;
  return (k as unknown as KeyRow) ?? null;
}

/** Enabled keys for one provider in the order they should be tried. */
export async function keysForUse(provider: string): Promise<KeyRow[]> {
  const sql = await db();
  return (await sql`
    SELECT * FROM api_keys
    WHERE provider = ${provider} AND enabled
    ORDER BY
      CASE WHEN credits = 0
             OR (last_error_code = ANY(${DEMOTE_CODES}::text[])
                 AND last_error_at > now() - make_interval(hours => ${DEMOTE_HOURS}))
           THEN 1 ELSE 0 END,
      position, id`) as unknown as KeyRow[];
}

/** A request with this key succeeded. */
export async function recordKeySuccess(id: number, creditsLeft?: number | null) {
  const sql = await db();
  const known = creditsLeft ?? null;
  await sql`
    UPDATE api_keys SET
      last_used_at = now(),
      last_error_code = NULL,
      last_error_at = NULL,
      -- a success proves a stale "0 credits" is wrong
      credits = CASE WHEN ${known}::int IS NOT NULL THEN ${known}::int WHEN credits = 0 THEN NULL ELSE credits END,
      credits_checked_at = CASE WHEN ${known}::int IS NOT NULL THEN now() ELSE credits_checked_at END
    WHERE id = ${id}`;
}

/** A request with this key failed with a key-related error. */
export async function recordKeyError(id: number, code: string) {
  const sql = await db();
  await sql`
    UPDATE api_keys SET
      last_used_at = now(), last_error_code = ${code}, last_error_at = now(),
      credits = CASE WHEN ${code}::text = 'NO_CREDITS' THEN 0 ELSE credits END
    WHERE id = ${id}`;
}

/** Result of an explicit "Check credits". */
export async function recordKeyCredits(id: number, credits: number | null) {
  const sql = await db();
  await sql`
    UPDATE api_keys SET credits = ${credits}, credits_checked_at = now(), last_error_code = NULL, last_error_at = NULL
    WHERE id = ${id}`;
}

export interface KeyInput {
  /** Existing key id; omit for a new key. */
  id?: number;
  label?: string;
  enabled?: boolean;
  /** Only for new keys. Saved keys are never sent back to the browser, so they can't be edited — delete and re-add. */
  apiKey?: string;
}

export class KeyError extends Error {
  status = 400;
}

/**
 * Make the provider's key list match `input` (order = position). Keys missing from the list are deleted.
 * Runs inside the settings transaction.
 */
export async function syncProviderKeys(tx: TransactionSql, provider: string, providerName: string, input: KeyInput[]) {
  const existing = (await tx`SELECT id, api_key FROM api_keys WHERE provider = ${provider}`) as unknown as { id: number; api_key: string }[];
  const existingIds = new Set(existing.map((k) => k.id));
  const keep = input.filter((k) => k.id != null && existingIds.has(k.id)).map((k) => k.id as number);

  // Validate new keys first (duplicates within the list or against kept keys).
  const keptValues = new Set(existing.filter((k) => keep.includes(k.id)).map((k) => k.api_key));
  const seen = new Set<string>();
  for (const k of input) {
    if (k.id != null) continue;
    const v = String(k.apiKey ?? '').trim();
    if (!v) continue;
    if (/\s/.test(v)) throw new KeyError(`${providerName}: API keys can't contain spaces`);
    if (keptValues.has(v) || seen.has(v)) throw new KeyError(`${providerName}: the key ${maskKey(v)} is already added`);
    seen.add(v);
  }

  await tx`DELETE FROM api_keys WHERE provider = ${provider} AND NOT (id = ANY(${keep}::int[]))`;

  let position = 0;
  for (const k of input) {
    const label = String(k.label ?? '').trim().slice(0, 60) || `Key ${position + 1}`;
    if (k.id != null) {
      if (!existingIds.has(k.id)) continue;
      await tx`
        UPDATE api_keys SET label = ${label}, enabled = ${k.enabled ?? true}, position = ${position}
        WHERE id = ${k.id} AND provider = ${provider}`;
      position++;
    } else {
      const v = String(k.apiKey ?? '').trim();
      if (!v) continue;
      await tx`
        INSERT INTO api_keys (provider, label, api_key, position, enabled)
        VALUES (${provider}, ${label}, ${v}, ${position}, ${k.enabled ?? true})`;
      position++;
    }
  }
}
