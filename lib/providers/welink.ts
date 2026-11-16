/**
 * We-Link — https://we-link.ai/api/
 *
 * A LinkedIn automation API that works through a LinkedIn account you connect to We-Link. It returns only what
 * that account can see on LinkedIn: the email (and phone, when listed) in a profile's "Contact info", which
 * LinkedIn normally shows to 1st-degree connections only. Each lookup costs 5 credits per call.
 *
 *  Base https://api.we-link.ai   headers x-api-key + x-api-secret   every call takes { accountId } of the LinkedIn account.
 *  Every call is asynchronous: POST -> { requestId }. The result is POSTed to the single webhook URL set in the
 *  We-Link dashboard (served at /api/webhooks/welink, matched to the search by request id).
 *    1. /api/v1/get_profile_details         { accountId, profile_url } -> { profile_id, full_name, is_connected, email, phone, ... }
 *    2. /api/v1/get_profile_contact_details { accountId, profile_id }  -> { emailAddress, twitterHandles, ... }
 *       Only when step 1 gave no email and the profile is a 1st-degree connection (or the "always" option is on).
 *  /api/v1/company_usage {}       -> { data: { availableCredits, ... } }   (free)
 *  /api/v1/get_all_ln_accounts {} -> [ { accountId, email } ]              (free)
 *  Webhook body: { status: 'SUCCESS' | 'FAILED' | <ERROR_CODE>, request_id | requestId, result, error | message, hash }
 *  hash = hex HMAC-SHA256 of JSON.stringify(body without hash), keyed with the webhook's Secret Code.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError, httpJson } from '../http';
import type { CallbackContext, Contact, Options, Person, Provider, ProviderResult, ProviderWaiting } from '../types';

const BASE = 'https://api.we-link.ai/api/v1';
/** We-Link fails a webhook delivery that isn't answered within 30s, and stage 2 is sent from inside one. */
const CALL_TIMEOUT_MS = 15_000;

interface Creds {
  apiKey: string;
  apiSecret: string;
  accountId: string | null;
}

/** Keys are stored as one string: API_KEY:API_SECRET, optionally :ACCOUNT_ID. */
export function parseCredentials(raw: string): Creds {
  const [apiKey, apiSecret, accountId] = String(raw).split(':').map((s) => s.trim());
  if (!apiKey || !apiSecret) {
    throw new ProviderError('INVALID_API_KEY', 'Enter the We-Link key as API_KEY:API_SECRET (optionally :ACCOUNT_ID)');
  }
  return { apiKey, apiSecret, accountId: accountId || null };
}

function apiError(status: number, body: any) {
  const code = String(body?.status || body?.error || '').toUpperCase();
  const msg = body?.message || body?.error || body?._text || code || `HTTP ${status}`;
  if (status === 401 || status === 403) return new ProviderError('INVALID_API_KEY', 'We-Link rejected the API key / secret', { status, body });
  if (status === 429 || code === 'STATUS_429' || code === 'FUSE_LIMIT_EXCEEDED') {
    return new ProviderError('RATE_LIMITED', 'We-Link / LinkedIn rate limit reached — try again later', { status, body });
  }
  if (status === 402 || /CREDIT/.test(code)) return new ProviderError('NO_CREDITS', 'Not enough We-Link credits', { status, body });
  if (status === 404) return new ProviderError('INVALID_ACCOUNT', `Unknown We-Link accountId — check it in Settings (${msg})`, { status, body });
  return new ProviderError('PROVIDER_ERROR', `We-Link error ${status}: ${msg}`, { status, body });
}

async function call(creds: Creds, path: string, body: Record<string, unknown> = {}) {
  const res = await httpJson(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'x-api-key': creds.apiKey, 'x-api-secret': creds.apiSecret },
    body,
    timeoutMs: CALL_TIMEOUT_MS,
    retries: 1,
  });
  if (res.status >= 400) throw apiError(res.status, res.body);
  return res.body;
}

const requestIdOf = (b: any): string | null => {
  const id = b?.requestId ?? b?.request_id ?? b?.result?.requestId ?? b?.data?.requestId;
  return id == null || id === '' ? null : String(id);
};

/** An immediate answer (some endpoints may answer synchronously) rather than "accepted, result to follow". */
const isDone = (b: any) => b?.status === 'SUCCESS' && b.result && typeof b.result === 'object' && Object.keys(b.result).length > 0;

// ------------------------------------------------------------------ account id

const accountCache = new Map<string, string>();

async function resolveAccountId(creds: Creds, options: Options): Promise<string> {
  const explicit = creds.accountId || String(options.accountId || '').trim();
  if (explicit) return explicit;
  const cached = accountCache.get(creds.apiKey);
  if (cached) return cached;

  const b = await call(creds, 'get_all_ln_accounts');
  const list: any[] = Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : Array.isArray(b?.result) ? b.result : [];
  const id = list.find((a) => a?.accountId)?.accountId;
  if (!id) throw new ProviderError('NO_ACCOUNT', 'No LinkedIn account is connected to this We-Link key — connect one in We-Link');
  accountCache.set(creds.apiKey, String(id));
  return String(id);
}

// ------------------------------------------------------------------ parsing

/** Saved with the waiting step, so the next delivery knows which stage it answers. */
interface State {
  stage: 'profile' | 'contact';
  accountId: string;
  requestId: string;
  profile?: any;
}

/** Failure code of a webhook payload, or null on success. */
function failureCode(b: any): string | null {
  const status = String(b?.status || '').toUpperCase();
  if (status === 'SUCCESS') return null;
  const detail = String(b?.error || b?.message || '');
  if (status === 'FAILED' || !status) return /^[A-Z0-9_]+$/.test(detail) ? detail : status || 'FAILED';
  return status;
}

const NOT_FOUND = new Set(['PROFILE_NOT_FOUND', '404_PROFILE_ID']);

function failure(code: string, b: any): ProviderError {
  const detail = b?.error || b?.message || code;
  switch (code) {
    case 'SKIPPED_INACTIVE':
    case 'ACCOUNT_RESTRICTED':
    case 'WRONG_PASSWORD':
    case 'BASIC_INFO_NOT_FOUND':
    case 'OWN_PROFILE_ID_NOT_FOUND':
      return new ProviderError('ACCOUNT_DISABLED', `The LinkedIn account connected to We-Link can't be used (${code}) — reconnect it in We-Link`, { body: b });
    case 'STATUS_429':
    case 'FUSE_LIMIT_EXCEEDED':
      return new ProviderError('RATE_LIMITED', `LinkedIn limit reached for the We-Link account (${code})`, { body: b });
    case 'QUEUE_TIMEOUT_THRESHOLD_EXCEEDED':
      return new ProviderError('TIMEOUT', 'We-Link queue timed out — search again', { body: b });
    default:
      return new ProviderError('PROVIDER_ERROR', `We-Link: ${detail}`, { body: b });
  }
}

function phonesFrom(...sources: unknown[]): Contact[] {
  const out: Contact[] = [];
  const add = (value: unknown, type: unknown) => {
    const v = value == null ? '' : String(value).trim();
    if (v && /\d{5}/.test(v.replace(/\D/g, ''))) out.push({ value: v, type: type ? String(type).toLowerCase() : null, verified: false, confidence: null });
  };
  const walk = (x: any) => {
    if (!x) return;
    if (typeof x === 'string' || typeof x === 'number') return add(x, null);
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x === 'object') add(x.number ?? x.phoneNumber ?? x.phone ?? x.value, x.type ?? x.phoneType);
  };
  sources.forEach(walk);
  return out;
}

function emailsFrom(...sources: unknown[]): Contact[] {
  const seen = new Set<string>();
  const out: Contact[] = [];
  const walk = (x: any) => {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(walk);
    const v = String(typeof x === 'object' ? x.emailAddress ?? x.email ?? x.value ?? '' : x).trim();
    if (v.includes('@') && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push({ value: v, type: null, verified: false, confidence: null });
    }
  };
  sources.forEach(walk);
  return out;
}

function personFrom(p: any): Person {
  return {
    fullName: p?.full_name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || null,
    headline: p?.headline || p?.title || null,
    company: p?.company || null,
    location: p?.location || null,
  };
}

function resultFrom(profile: any, contact: any, message: string | null, raw: unknown): ProviderResult {
  const emails = emailsFrom(profile?.email, contact?.emailAddress, contact?.email, contact?.emails);
  const phones = phonesFrom(profile?.phone, contact?.phoneNumbers, contact?.phone_numbers, contact?.phone, contact?.phones);
  return { found: emails.length + phones.length > 0, person: profile ? personFrom(profile) : null, emails, phones, message, raw };
}

// ------------------------------------------------------------------ stages

interface Ctx {
  creds: Creds;
  accountId: string;
  linkedinUrl: string;
  options: Options;
  need: { email: boolean; phone: boolean };
  /** No more requests may be sent: answer with what we have. */
  final: boolean;
}

const waiting = (state: State, message: string, raw: unknown): ProviderWaiting => ({
  waiting: true,
  requestId: state.requestId,
  message,
  raw: { ...raw as object, _welink: state },
});

async function startProfile(ctx: Ctx): Promise<ProviderResult | ProviderWaiting> {
  const b = await call(ctx.creds, 'get_profile_details', { accountId: ctx.accountId, profile_url: ctx.linkedinUrl });
  if (isDone(b)) return afterProfile(b, ctx);
  const requestId = requestIdOf(b);
  if (!requestId) throw new ProviderError('BAD_RESPONSE', 'We-Link returned no request id', { body: b });
  return waiting({ stage: 'profile', accountId: ctx.accountId, requestId }, 'Waiting for We-Link to read the profile (it paces requests, so this can take minutes)', { profileRequest: b });
}

async function afterProfile(b: any, ctx: Ctx): Promise<ProviderResult | ProviderWaiting> {
  const code = failureCode(b);
  if (code && NOT_FOUND.has(code)) return { found: false, emails: [], phones: [], message: `Profile not found (${code})`, raw: { profile: b } };
  if (code) throw failure(code, b);

  const p = b.result || {};
  const base = resultFrom(p, null, null, { profile: b });
  const missing = (ctx.need.email && !base.emails.length) || (ctx.need.phone && !base.phones.length);
  const connected = Boolean(p.is_connected);
  const tryContact = missing && p.profile_id && (connected || Boolean(ctx.options.alwaysContactInfo));

  if (!tryContact || ctx.final) {
    if (!base.found && !connected) base.message = 'Not a 1st-degree connection of the We-Link account — LinkedIn hides contact info';
    else if (tryContact) base.message = 'Contact info was not requested (the wait time was over)';
    return base;
  }

  const c = await call(ctx.creds, 'get_profile_contact_details', { accountId: ctx.accountId, profile_id: p.profile_id });
  if (isDone(c)) return afterContact(c, p, b);
  const requestId = requestIdOf(c);
  if (!requestId) throw new ProviderError('BAD_RESPONSE', 'We-Link returned no request id for contact details', { body: c });
  return waiting(
    { stage: 'contact', accountId: ctx.accountId, requestId, profile: p },
    connected ? '1st-degree connection — waiting for We-Link to read the contact info' : 'Waiting for We-Link to read the contact info',
    { profile: b },
  );
}

function afterContact(c: any, profile: any, profileBody: unknown): ProviderResult {
  const raw = { profile: profileBody, contact: c };
  const code = failureCode(c);
  if (code === 'CONTACT_INFO_FETCH_FAILED' || (code && NOT_FOUND.has(code))) {
    return resultFrom(profile, null, `Contact info not visible (${code})`, raw);
  }
  if (code) throw failure(code, c);
  return resultFrom(profile, c.result || {}, null, raw);
}

// ------------------------------------------------------------------ provider

function verifySignature(body: any, secret: string): boolean {
  if (!body || typeof body !== 'object' || typeof body.hash !== 'string') return false;
  const { hash, ...data } = body;
  const computed = createHmac('sha256', secret).update(JSON.stringify(data)).digest('hex');
  const a = Buffer.from(computed);
  const b = Buffer.from(String(hash).toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

const welink: Provider = {
  id: 'welink',
  name: 'We-Link',
  website: 'https://we-link.ai',
  docs: 'https://we-link.ai/api/reference/connections-networking/get-contact-details-of-a-linkedin-profile',
  keyHelp: 'We-Link → Settings → Security. Enter as API_KEY:API_SECRET',
  options: [
    {
      key: 'accountId',
      label: 'We-Link accountId of the connected LinkedIn account',
      type: 'text',
      default: '',
      placeholder: 'Empty = first connected account',
      help: 'Lookups run as this LinkedIn account and only see contact info of its 1st-degree connections. A key entered as KEY:SECRET:ACCOUNT_ID overrides this.',
    },
    {
      key: 'webhookSecret',
      label: 'Webhook Secret Code',
      type: 'text',
      default: '',
      help: 'The Secret Code of the We-Link webhook. When set, deliveries with a wrong signature are rejected.',
    },
    {
      key: 'alwaysContactInfo',
      label: 'Also request contact info for profiles that are not 1st-degree connections (+5 credits, usually empty)',
      type: 'boolean',
      default: false,
    },
    {
      key: 'timeoutSec',
      label: 'Webhook wait time per request (seconds)',
      type: 'number',
      default: 600,
      min: 60,
      max: 3600,
      help: 'We-Link paces LinkedIn actions like a human, so a result can take several minutes.',
    },
  ],

  callbackTimeoutSec: (options) => Number(options.timeoutSec) || 600,

  sharedWebhook: {
    requestId: (body) => requestIdOf(body),
    verify(body, options) {
      const secret = String(options.webhookSecret || '').trim();
      return !secret || verifySignature(body, secret);
    },
    help: 'In We-Link → Webhooks, create a webhook with this URL and enable the triggers "Get Profile Details" and "Get Profile Contact Details". Copy its Secret Code into the field below.',
  },

  async lookup({ linkedinUrl, apiKey, options, need, callbackUrl }) {
    const creds = parseCredentials(apiKey);
    if (!callbackUrl) {
      throw new ProviderError('NO_PUBLIC_URL', 'We-Link delivers results by webhook — set a public app URL in Settings');
    }
    const accountId = await resolveAccountId(creds, options);
    return startProfile({ creds, accountId, linkedinUrl, options, need, final: false });
  },

  async parseCallback(body: any, ctx: CallbackContext) {
    const state: State | undefined = (ctx.previous as any)?._welink;
    if (!state) throw new ProviderError('BAD_RESPONSE', 'We-Link delivery for an unknown request');
    if (state.stage === 'contact') return afterContact(body, state.profile, (ctx.previous as any).profile);

    // The key may have been deleted meanwhile: then answer with the profile data only.
    let creds: Creds | null = null;
    try {
      creds = parseCredentials(ctx.apiKey);
    } catch {}
    const final = ctx.final || !creds;
    return afterProfile(body, { creds: creds!, accountId: state.accountId, linkedinUrl: ctx.linkedinUrl, options: ctx.options, need: ctx.need, final });
  },

  async credits(apiKey) {
    const b = await call(parseCredentials(apiKey), 'company_usage');
    const d = b?.data || b?.result || {};
    const credits = d.availableCredits ?? null;
    return { credits: credits == null ? null : Number(credits), plan: null };
  },
};

export default welink;
