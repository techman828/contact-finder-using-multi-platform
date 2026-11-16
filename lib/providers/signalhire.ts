/**
 * SignalHire Person API — https://docs.signalhire.com/person-api/retrieve-person
 *
 *  POST https://www.signalhire.com/api/v1/candidate/search   header: apikey
 *  - Waterfall (async) mode: body { items, callbackUrl } -> 201 { requestId }; results are POSTed to callbackUrl.
 *    Best coverage (queries external sources in real time). Needs a publicly reachable URL — your Vercel
 *    production domain works out of the box.
 *  - Sync mode: body { items, withoutWaterfall: true } -> 200 [ { item, status, candidate } ].
 *    Immediate, SignalHire's own database only (lower coverage). Used when no public URL is known (local dev).
 *  GET https://www.signalhire.com/api/v1/credits -> { credits }
 */
import { ProviderError, httpJson } from '../http';
import type { Contact, Provider, ProviderResult } from '../types';

const BASE = 'https://www.signalhire.com/api/v1';

function httpError(status: number, body: any) {
  const msg = body?.error || body?.message || body?._text || `HTTP ${status}`;
  const map: Record<number, [string, string]> = {
    401: ['INVALID_API_KEY', 'Authentication failed — check the API key'],
    402: ['NO_CREDITS', 'SignalHire credits exhausted'],
    403: ['ACCOUNT_DISABLED', 'Account disabled or access denied'],
    406: ['INVALID_REQUEST', msg],
    422: ['INVALID_REQUEST', msg],
    429: ['RATE_LIMITED', 'Rate limit exceeded (trial accounts: 5 profiles/min)'],
  };
  const [code, message] = map[status] || ['PROVIDER_ERROR', `SignalHire error ${status}: ${msg}`];
  return new ProviderError(code, message, { status, body });
}

const creditsHeader = (headers: Headers | undefined) => {
  const v = Number(headers?.get('x-credits-left'));
  return headers?.has('x-credits-left') && Number.isFinite(v) ? v : null;
};

/** Turn one result element `{ item, status, candidate }` into the common result shape. */
export function parseItem(item: any, creditsLeft: number | null = null): ProviderResult {
  if (!item) throw new ProviderError('BAD_RESPONSE', 'Empty response from SignalHire');
  switch (item.status) {
    case 'success':
      break;
    case 'failed':
      return { found: false, emails: [], phones: [], creditsLeft, raw: item };
    case 'credits_are_over':
      throw new ProviderError('NO_CREDITS', 'SignalHire credits ran out', { body: item });
    case 'timeout_exceeded':
      throw new ProviderError('TIMEOUT', 'SignalHire processing timed out', { body: item });
    case 'duplicate_query':
      throw new ProviderError('DUPLICATE_QUERY', 'Same profile was just queried — retry in a minute', { body: item });
    default:
      throw new ProviderError('BAD_RESPONSE', `Unexpected status "${item.status}"`, { body: item });
  }

  const c = item.candidate || {};
  const contacts: any[] = Array.isArray(c.contacts) ? c.contacts : [];
  const toContact = (x: any, type: string | null): Contact => ({
    value: String(x.value),
    type,
    verified: Number(x.rating) >= 100,
    confidence: x.rating == null ? null : Number(x.rating),
  });
  const emails = contacts.filter((x) => x.type === 'email' && x.value).map((x) => toContact(x, x.subType || null));
  const phones = contacts
    .filter((x) => x.type === 'phone' && x.value)
    .map((x) => toContact(x, x.subType === 'work_phone' ? 'work' : x.subType || null));
  const exp = Array.isArray(c.experience) ? c.experience[0] : null;
  const loc = Array.isArray(c.locations) ? c.locations[0]?.name : null;

  return {
    found: emails.length + phones.length > 0,
    person: { fullName: c.fullName || null, headline: c.headLine || null, company: exp?.company || null, location: loc || null },
    emails,
    phones,
    creditsLeft,
    raw: item,
  };
}

const signalhire: Provider = {
  id: 'signalhire',
  name: 'SignalHire',
  website: 'https://www.signalhire.com',
  docs: 'https://docs.signalhire.com/person-api/retrieve-person',
  keyHelp: 'SignalHire → Integrations → API',
  options: [
    {
      key: 'useWaterfall',
      label: 'Full waterfall mode (better coverage, results arrive by callback in 5–60s)',
      type: 'boolean',
      default: true,
      help: 'Needs a public URL. Without one (e.g. local dev) the fast sync mode is used automatically.',
    },
    { key: 'timeoutSec', label: 'Callback wait time (seconds)', type: 'number', default: 120, min: 10, max: 900 },
  ],

  callbackTimeoutSec: (options) => Number(options.timeoutSec) || 120,

  async lookup({ linkedinUrl, apiKey, options, callbackUrl }) {
    const headers = { apikey: apiKey };

    if (options.useWaterfall && callbackUrl) {
      const res = await httpJson(`${BASE}/candidate/search`, {
        method: 'POST',
        headers,
        body: { items: [linkedinUrl], callbackUrl },
      });
      if (res.status !== 201 && res.status !== 200) throw httpError(res.status, res.body);
      return {
        waiting: true,
        message: `Waterfall request #${res.body?.requestId ?? '?'} — waiting for SignalHire callback`,
        creditsLeft: creditsHeader(res.headers),
        raw: res.body,
      };
    }

    const res = await httpJson(`${BASE}/candidate/search`, {
      method: 'POST',
      headers,
      body: { items: [linkedinUrl], withoutWaterfall: true },
    });
    if (res.status !== 200) throw httpError(res.status, res.body);
    const result = parseItem(Array.isArray(res.body) ? res.body[0] : null, creditsHeader(res.headers));
    if (options.useWaterfall && !callbackUrl) result.message = 'Sync mode (no public URL for waterfall callbacks)';
    return result;
  },

  parseCallback(body) {
    return parseItem(Array.isArray(body) ? body[0] : body);
  },

  async credits(apiKey) {
    const res = await httpJson(`${BASE}/credits`, { headers: { apikey: apiKey }, retries: 0 });
    if (res.status !== 200) throw httpError(res.status, res.body);
    return { credits: res.body?.credits ?? creditsHeader(res.headers) };
  },
};

export default signalhire;
