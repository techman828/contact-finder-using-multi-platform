/**
 * The waterfall engine, built for serverless.
 *
 * All state lives in Postgres, so any function invocation can pick the work up:
 *
 *   POST /api/searches          createSearch() + after(advance)
 *   advance(searchId)           claims the next 'pending' step (row-locked), calls the provider, repeats.
 *                               If a provider answers via webhook the step becomes 'waiting' and advance stops.
 *   POST /api/callbacks/...     handleCallback() stores the result, then after(advance) continues the chain.
 *   POST /api/webhooks/<id>     handleWebhook(): same, for providers with one dashboard-configured webhook URL;
 *                               the delivery is matched to the step by the provider's request id (external_id).
 *   GET  /api/searches/:id      reconcile() times out overdue 'waiting' steps / interrupted 'running' steps
 *                               and resumes searches that stalled, so nothing hangs forever.
 */
import { randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { db, jsonb } from './db';
import { ProviderError, phoneKey } from './http';
import { FAILOVER_CODES, getKey, keysForUse, recordKeyError, recordKeySuccess } from './keys';
import { providerById } from './providers';
import { getGeneralSettings, getProviderConfigs, resolvePublicUrl } from './settings';
import type { CallbackContext, MergedContact, Provider, ProviderResult, ProviderStep, StopRule } from './types';

type Q = Sql | TransactionSql;

/** A step 'running' longer than this was killed with its function (Vercel max duration is 300s). */
const STALE_RUNNING_SEC = 330;

// ------------------------------------------------------------------ merging

type StepLike = Pick<ProviderStep, 'provider' | 'emails' | 'phones' | 'person'>;

/** Merge provider results into one de-duplicated list, remembering which providers found each contact. */
export function mergeResults(steps: StepLike[]) {
  const emails = new Map<string, MergedContact>();
  const phones = new Map<string, MergedContact>();
  let fullName: string | null = null;
  let headline: string | null = null;

  for (const s of steps) {
    const source = providerById[s.provider]?.name || s.provider;
    fullName ||= s.person?.fullName || null;
    headline ||= s.person?.headline || null;
    const lists: [typeof s.emails, Map<string, MergedContact>, (v: string) => string][] = [
      [s.emails, emails, (v) => v.toLowerCase()],
      [s.phones, phones, phoneKey],
    ];
    for (const [list, map, keyOf] of lists) {
      for (const c of list || []) {
        const k = keyOf(c.value);
        const existing = map.get(k);
        if (existing) {
          if (!existing.sources.includes(source)) existing.sources.push(source);
          existing.verified ||= Boolean(c.verified);
          existing.type ||= c.type || null;
        } else {
          map.set(k, { value: c.value, type: c.type || null, verified: Boolean(c.verified), sources: [source] });
        }
      }
    }
  }
  // Verified first, otherwise waterfall order (Array.sort is stable).
  const sort = (arr: MergedContact[]) => arr.sort((a, b) => Number(b.verified) - Number(a.verified));
  return { fullName, headline, emails: sort([...emails.values()]), phones: sort([...phones.values()]) };
}

function isSatisfied(stopWhen: StopRule, merged: ReturnType<typeof mergeResults>) {
  if (stopWhen === 'never') return false;
  if (stopWhen === 'email') return merged.emails.length > 0;
  return merged.emails.length > 0 && merged.phones.length > 0;
}

/** Recompute the search row's merged contacts/status from its steps. */
async function writeSearch(q: Q, searchId: number, final: boolean) {
  const steps = (await q`
    SELECT provider, status, emails, phones, person FROM provider_results
    WHERE search_id = ${searchId} ORDER BY position`) as unknown as (StepLike & { status: string })[];
  const merged = mergeResults(steps);
  const has = merged.emails.length + merged.phones.length > 0;
  const anyError = steps.some((s) => s.status === 'error' || s.status === 'timeout');
  const status = !final ? 'running' : has ? 'done' : anyError ? 'error' : 'not_found';
  await q`
    UPDATE searches SET
      status = ${status},
      full_name = ${merged.fullName},
      headline = ${merged.headline},
      emails = ${jsonb(merged.emails)}::jsonb,
      phones = ${jsonb(merged.phones)}::jsonb,
      finished_at = CASE WHEN ${status}::text = 'running' THEN NULL ELSE COALESCE(finished_at, now()) END
    WHERE id = ${searchId}`;
}

const resultColumns = (r: ProviderResult) => ({
  status: r.found ? 'found' : 'not_found',
  message: r.message ?? null,
  emails: jsonb(r.emails ?? []),
  phones: jsonb(r.phones ?? []),
  person: jsonb(r.person ?? null),
  raw: jsonb(r.raw ?? null),
});

// ------------------------------------------------------------------ create

export class UserError extends Error {
  status = 400;
}

/** Insert a search plus one 'pending' step per active provider. Call advance() afterwards. */
export async function createSearch(linkedinUrl: string): Promise<number> {
  const [configs, general] = await Promise.all([getProviderConfigs(), getGeneralSettings()]);
  const active = configs.filter((c) => c.enabled && c.activeKeys > 0);
  if (!active.length) throw new UserError('No provider is enabled with an API key. Add one in Settings.');

  const sql = await db();
  return sql.begin(async (tx) => {
    const [s] = await tx`
      INSERT INTO searches (linkedin_url, status, stop_when)
      VALUES (${linkedinUrl}, 'running', ${general.stopWhen}) RETURNING id`;
    for (const [i, c] of active.entries()) {
      await tx`INSERT INTO provider_results (search_id, provider, position, status) VALUES (${s.id}, ${c.id}, ${i}, 'pending')`;
    }
    return s.id as number;
  });
}

// ------------------------------------------------------------------ advance

interface Claim {
  stepId: number;
  provider: string;
  linkedinUrl: string;
  need: { email: boolean; phone: boolean };
  token: string | null;
}

/**
 * Run pending steps in order until the search finishes or a step is waiting for a callback.
 * Safe to call concurrently / repeatedly: each step is claimed under a row lock on the search.
 */
export async function advance(searchId: number): Promise<void> {
  const sql = await db();
  const [configs, general] = await Promise.all([getProviderConfigs(), getGeneralSettings()]);
  const publicUrl = resolvePublicUrl(general);

  for (;;) {
    const claim: Claim | 'again' | null = await sql.begin(async (tx) => {
      const [s] = await tx`SELECT id, status, stop_when, linkedin_url FROM searches WHERE id = ${searchId} FOR UPDATE`;
      if (!s || s.status !== 'running') return null;

      const steps = (await tx`
        SELECT id, provider, status, emails, phones, person FROM provider_results
        WHERE search_id = ${searchId} ORDER BY position`) as unknown as (StepLike & { id: number; status: string })[];
      if (steps.some((r) => r.status === 'running' || r.status === 'waiting')) return null; // someone else is on it

      const merged = mergeResults(steps);
      const next = steps.find((r) => r.status === 'pending');

      if (!next || isSatisfied(s.stop_when, merged)) {
        await tx`
          UPDATE provider_results SET status = 'skipped', message = 'Not needed — contacts already found'
          WHERE search_id = ${searchId} AND status = 'pending'`;
        await writeSearch(tx, searchId, true);
        return null;
      }

      const cfg = configs.find((c) => c.id === next.provider);
      const provider = providerById[next.provider];
      if (!cfg || !provider || !cfg.enabled || !cfg.activeKeys) {
        await tx`UPDATE provider_results SET status = 'skipped', message = 'Disabled or no enabled API key' WHERE id = ${next.id}`;
        return 'again';
      }

      const token = provider.parseCallback && publicUrl ? randomBytes(18).toString('hex') : null;
      await tx`
        UPDATE provider_results SET status = 'running', started_at = now(), callback_token = ${token}
        WHERE id = ${next.id}`;
      return {
        stepId: next.id,
        provider: next.provider,
        linkedinUrl: s.linkedin_url,
        need: { email: merged.emails.length === 0, phone: merged.phones.length === 0 },
        token,
      };
    });

    if (claim === null) return;
    if (claim === 'again') continue;

    const waiting = await runStep(sql, claim, configs.find((c) => c.id === claim.provider)!, publicUrl);
    if (waiting) return; // the callback will resume the chain
    await writeSearch(sql, searchId, false); // let the UI show contacts as each provider answers
  }
}

const errorMessage = (err: any) => `${err?.code ? `[${err.code}] ` : ''}${err?.message ?? err}`;

/**
 * Execute one claimed step, trying the provider's API keys in order. A key-specific failure
 * (out of credits, invalid, disabled, rate limited) fails over to the next key.
 * Returns true if the step is now waiting for a callback.
 */
async function runStep(sql: Sql, claim: Claim, cfg: { options: Record<string, any> }, publicUrl: string | null): Promise<boolean> {
  const provider = providerById[claim.provider];
  const started = Date.now();
  const callbackUrl = claim.token && publicUrl ? `${publicUrl}/api/callbacks/${provider.id}/${claim.token}` : null;
  const keys = await keysForUse(provider.id);
  const notes: string[] = []; // failover trail, e.g. "Key 1: NO_CREDITS"
  const withNotes = (msg: string | null | undefined) => [notes.length ? `${notes.join(', ')} → switched key` : null, msg].filter(Boolean).join(' · ') || null;

  const fail = async (message: string, status: 'error' | 'timeout', key: { id: number; label: string } | null, raw: unknown) => {
    await sql`
      UPDATE provider_results SET
        status = ${status}, message = ${message}, raw = ${jsonb(raw)}::jsonb, duration_ms = ${Date.now() - started},
        api_key_id = ${key?.id ?? null}, api_key_label = ${key?.label ?? null}
      WHERE id = ${claim.stepId} AND status = 'running'`;
  };

  if (!keys.length) {
    await fail('No enabled API key', 'error', null, null);
    return false;
  }

  for (const [i, key] of keys.entries()) {
    try {
      const r = await provider.lookup({
        linkedinUrl: claim.linkedinUrl,
        apiKey: key.api_key,
        options: cfg.options,
        need: claim.need,
        callbackUrl,
      });
      await recordKeySuccess(key.id, r.creditsLeft);

      if ('waiting' in r) {
        if (!callbackUrl) throw new Error(`${provider.name} wants a callback but none was offered`);
        if (provider.sharedWebhook && !r.requestId) throw new Error(`${provider.name} returned no request id to match its webhook to`);
        const timeoutSec = provider.callbackTimeoutSec?.(cfg.options) ?? 120;
        const updated = await sql`
          UPDATE provider_results SET
            status = 'waiting', message = ${withNotes(r.message)}, raw = ${jsonb(r.raw)}::jsonb,
            credits_left = ${r.creditsLeft ?? null}, api_key_id = ${key.id}, api_key_label = ${key.label},
            external_id = ${r.requestId ?? null},
            deadline_at = now() + make_interval(secs => ${timeoutSec})
          WHERE id = ${claim.stepId} AND status = 'running' RETURNING id`;
        if (!updated.length) {
          // The callback beat us to it and already stored the result; just attach the key used.
          await sql`UPDATE provider_results SET api_key_id = ${key.id}, api_key_label = ${key.label} WHERE id = ${claim.stepId}`;
        }
        return updated.length > 0;
      }

      const c = resultColumns(r);
      await sql`
        UPDATE provider_results SET
          status = ${c.status}, message = ${withNotes(c.message)}, emails = ${c.emails}::jsonb, phones = ${c.phones}::jsonb,
          person = ${c.person}::jsonb, raw = ${c.raw}::jsonb, credits_left = ${r.creditsLeft ?? null},
          duration_ms = ${Date.now() - started}, api_key_id = ${key.id}, api_key_label = ${key.label}
        WHERE id = ${claim.stepId} AND status = 'running'`;
      return false;
    } catch (err: any) {
      const keyProblem = err instanceof ProviderError && FAILOVER_CODES.has(err.code);
      if (keyProblem) await recordKeyError(key.id, err.code);
      if (keyProblem && i < keys.length - 1) {
        notes.push(`${key.label}: ${err.code}`);
        continue;
      }
      const prefix = keyProblem && keys.length > 1 ? `All ${keys.length} keys failed (${[...notes, `${key.label}: ${err.code}`].join(', ')}) — ` : '';
      await fail(prefix ? prefix + err.message : withNotes(errorMessage(err))!, err?.code === 'TIMEOUT' ? 'timeout' : 'error', key, err?.extra?.body ?? null);
      return false;
    }
  }
  return false;
}

// ------------------------------------------------------------------ callbacks

interface CallbackStep {
  id: number;
  search_id: number;
  status: string;
  started_at: Date | null;
  api_key_id: number | null;
  raw: unknown;
}

/**
 * Store a provider's webhook payload (per-step URL /api/callbacks/<provider>/<token>). Returns:
 *   { ok: false }                     unknown token (respond 404)
 *   { ok: true, resume: searchId }    the chain was waiting on this — call advance(searchId)
 *   { ok: true }                      stored (late result), still waiting for a later stage, or already handled
 */
export async function handleCallback(providerId: string, token: string, body: unknown): Promise<{ ok: boolean; resume?: number }> {
  const provider = providerById[providerId];
  if (!provider?.parseCallback || !/^[0-9a-f]{36}$/.test(token)) return { ok: false };

  const sql = await db();
  const [step] = (await sql`
    SELECT id, search_id, status, started_at, api_key_id, raw FROM provider_results
    WHERE callback_token = ${token} AND provider = ${providerId}`) as unknown as CallbackStep[];
  if (!step) return { ok: false };
  return applyCallback(sql, provider, step, body);
}

/**
 * Delivery to a provider's shared webhook URL (/api/webhooks/<provider>). `http` is the status to answer with.
 * Deliveries that match no step (other event types, test pings, duplicates of an earlier stage) get 200 so the
 * provider doesn't keep retrying them.
 */
export async function handleWebhook(providerId: string, body: unknown): Promise<{ http: number; resume?: number }> {
  const provider = providerById[providerId];
  const hook = provider?.sharedWebhook;
  if (!hook || !provider.parseCallback) return { http: 404 };

  if (hook.verify) {
    const cfg = (await getProviderConfigs()).find((c) => c.id === providerId);
    if (!hook.verify(body, cfg?.options ?? {})) {
      console.warn(`[webhook ${providerId}] rejected a delivery with an invalid signature — check the webhook secret in Settings`);
      return { http: 401 };
    }
  }

  const requestId = hook.requestId(body);
  if (!requestId) return { http: 200 };
  const sql = await db();
  const [step] = (await sql`
    SELECT id, search_id, status, started_at, api_key_id, raw FROM provider_results
    WHERE provider = ${providerId} AND external_id = ${requestId}`) as unknown as CallbackStep[];
  if (!step) return { http: 200 };
  const r = await applyCallback(sql, provider, step, body);
  return { http: 200, resume: r.resume };
}

async function callbackContext(sql: Sql, provider: Provider, step: CallbackStep): Promise<CallbackContext> {
  const [s] = await sql`SELECT linkedin_url, emails, phones FROM searches WHERE id = ${step.search_id}`;
  const key = step.api_key_id ? await getKey(step.api_key_id) : null;
  const cfg = (await getProviderConfigs()).find((c) => c.id === provider.id);
  return {
    linkedinUrl: s?.linkedin_url ?? '',
    apiKey: key?.api_key ?? '',
    options: cfg?.options ?? {},
    need: { email: !s?.emails?.length, phone: !s?.phones?.length },
    previous: step.raw,
    final: step.status !== 'waiting',
  };
}

async function applyCallback(sql: Sql, provider: Provider, step: CallbackStep, body: unknown): Promise<{ ok: boolean; resume?: number }> {
  if (!['running', 'waiting', 'timeout'].includes(step.status)) return { ok: true };

  const durationMs = step.started_at ? Date.now() - new Date(step.started_at).getTime() : null;
  let updated;
  try {
    const ctx = await callbackContext(sql, provider, step);
    const r = await provider.parseCallback!(body, ctx);
    if (step.api_key_id) await recordKeySuccess(step.api_key_id, r.creditsLeft);

    if ('waiting' in r) {
      // Another stage is in flight: keep waiting for it, with a fresh deadline.
      if (ctx.final) throw new Error(`${provider.name} asked to keep waiting after the wait time was over`);
      const timeoutSec = provider.callbackTimeoutSec?.(ctx.options) ?? 120;
      await sql`
        UPDATE provider_results SET
          message = ${r.message ?? null}, raw = ${jsonb(r.raw)}::jsonb, external_id = ${r.requestId ?? null},
          credits_left = COALESCE(${r.creditsLeft ?? null}::int, credits_left),
          deadline_at = now() + make_interval(secs => ${timeoutSec})
        WHERE id = ${step.id} AND status = 'waiting'`;
      return { ok: true };
    }

    const c = resultColumns(r);
    const message = step.status === 'timeout' ? 'Result arrived after the wait time — saved anyway' : c.message;
    updated = await sql`
      UPDATE provider_results SET
        status = ${c.status}, message = ${message}, emails = ${c.emails}::jsonb, phones = ${c.phones}::jsonb,
        person = ${c.person}::jsonb, raw = ${c.raw}::jsonb, duration_ms = ${durationMs}
      WHERE id = ${step.id} AND status = ${step.status} RETURNING id`;
  } catch (err: any) {
    if (step.api_key_id && err instanceof ProviderError && FAILOVER_CODES.has(err.code)) {
      await recordKeyError(step.api_key_id, err.code);
    }
    updated = await sql`
      UPDATE provider_results SET
        status = ${err?.code === 'TIMEOUT' ? 'timeout' : 'error'}, message = ${errorMessage(err)},
        raw = ${jsonb(body)}::jsonb, duration_ms = ${durationMs}
      WHERE id = ${step.id} AND status = ${step.status} RETURNING id`;
  }
  if (!updated.length) return { ok: true }; // raced with a timeout/another delivery

  if (step.status === 'waiting') return { ok: true, resume: step.search_id };
  if (step.status === 'timeout') {
    // Late result: fold it into the (possibly finished) search.
    const [s] = await sql`SELECT status FROM searches WHERE id = ${step.search_id}`;
    if (s) await writeSearch(sql, step.search_id, s.status !== 'running');
  }
  // 'running': advance() is still in flight for this step and will continue on its own.
  return { ok: true };
}

// ------------------------------------------------------------------ reconcile

/**
 * Time out overdue callbacks and interrupted steps. Returns ids of running searches that have
 * nothing in flight and should be resumed with advance().
 */
export async function reconcile(searchId?: number): Promise<number[]> {
  const sql = await db();
  const ids: number[] = searchId != null
    ? [searchId]
    : (await sql`SELECT id FROM searches WHERE status = 'running'`).map((r) => r.id as number);
  if (!ids.length) return [];

  await sql`
    UPDATE provider_results SET status = 'timeout',
      message = 'No callback within the wait time — a late result will still be saved'
    WHERE status = 'waiting' AND deadline_at < now() AND search_id = ANY(${ids}::int[])`;
  await sql`
    UPDATE provider_results SET status = 'error', message = 'Interrupted (function was stopped) — search again'
    WHERE status = 'running' AND started_at < now() - make_interval(secs => ${STALE_RUNNING_SEC})
      AND search_id = ANY(${ids}::int[])`;

  const stalled = await sql`
    SELECT s.id FROM searches s
    WHERE s.status = 'running' AND s.id = ANY(${ids}::int[])
      AND NOT EXISTS (
        SELECT 1 FROM provider_results p WHERE p.search_id = s.id AND p.status IN ('running', 'waiting'))`;
  return stalled.map((r) => r.id as number);
}
