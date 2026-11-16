/**
 * Prospeo Enrich Person API — https://prospeo.io/api-docs/enrich-person
 *
 *  POST https://api.prospeo.io/enrich-person   header: X-KEY
 *  body { only_verified_email, enrich_mobile, data: { linkedin_url } }
 *  Cost: email = 1 credit, mobile = 10 credits (email included), no match = free,
 *        same record again within 90 days = free.
 *  GET https://api.prospeo.io/account-information -> { response: { remaining_credits, ... } }
 */
import { ProviderError, httpJson } from '../http';
import type { Contact, Provider } from '../types';

const BASE = 'https://api.prospeo.io';

function apiError(status: number, body: any) {
  const code: string = body?.error_code || (status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR');
  const messages: Record<string, string> = {
    INVALID_API_KEY: 'Invalid API key — check it in Settings',
    INSUFFICIENT_CREDITS: 'Not enough Prospeo credits',
    INVALID_DATAPOINTS: 'Prospeo rejected the LinkedIn URL',
    INVALID_REQUEST: 'Malformed request',
    INTERNAL_ERROR: 'Prospeo internal error',
    RATE_LIMITED: 'Rate limit exceeded',
  };
  return new ProviderError(
    code === 'INSUFFICIENT_CREDITS' ? 'NO_CREDITS' : code,
    messages[code] || `Prospeo error ${status}: ${body?.message || code}`,
    { status, body }
  );
}

const isMasked = (v: unknown) => !v || String(v).includes('*');

const prospeo: Provider = {
  id: 'prospeo',
  name: 'Prospeo',
  website: 'https://prospeo.io',
  docs: 'https://prospeo.io/api-docs/enrich-person',
  keyHelp: 'Prospeo dashboard → API',
  options: [
    { key: 'revealMobile', label: 'Reveal mobile number when still missing (10 credits)', type: 'boolean', default: true },
    { key: 'onlyVerifiedEmail', label: 'Only return verified emails', type: 'boolean', default: false },
  ],

  async lookup({ linkedinUrl, apiKey, options, need }) {
    const enrichMobile = Boolean(options.revealMobile && need.phone);
    const res = await httpJson(`${BASE}/enrich-person`, {
      method: 'POST',
      headers: { 'X-KEY': apiKey },
      body: {
        only_verified_email: Boolean(options.onlyVerifiedEmail),
        enrich_mobile: enrichMobile,
        data: { linkedin_url: linkedinUrl },
      },
    });

    const body = res.body || {};
    if (res.status !== 200 || body.error) {
      if (body.error_code === 'NO_MATCH') return { found: false, emails: [], phones: [], raw: body };
      throw apiError(res.status, body);
    }

    const p = body.person || {};
    const emails: Contact[] = [];
    const e = p.email;
    if (e && e.revealed !== false && !isMasked(e.email)) {
      emails.push({ value: e.email, type: 'work', verified: e.status === 'VERIFIED', confidence: null });
    }

    const phones: Contact[] = [];
    const m = p.mobile;
    const mobile = m && (m.mobile_international || m.mobile);
    if (m && m.revealed !== false && !isMasked(mobile)) {
      phones.push({ value: mobile, type: 'mobile', verified: m.status === 'VERIFIED', confidence: null });
    }

    const fullName = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
    return {
      found: emails.length + phones.length > 0,
      person: {
        fullName,
        headline: p.headline || p.current_job_title || p.job_title || null,
        company: body.company?.name || null,
        location: p.location?.country || p.location?.name || null,
      },
      emails,
      phones,
      message: body.free_enrichment ? 'Free re-enrichment (cached ≤ 90 days)' : enrichMobile ? null : 'Mobile not requested',
      raw: body,
    };
  },

  async credits(apiKey) {
    const res = await httpJson(`${BASE}/account-information`, { headers: { 'X-KEY': apiKey }, retries: 0 });
    if (res.status !== 200 || res.body?.error) throw apiError(res.status, res.body);
    const r = res.body.response || {};
    return { credits: r.remaining_credits ?? null, plan: r.current_plan || null };
  },
};

export default prospeo;
