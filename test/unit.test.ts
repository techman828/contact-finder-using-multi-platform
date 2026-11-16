import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeLinkedinUrl } from '@/lib/linkedin';
import prospeo from '@/lib/providers/prospeo';
import signalhire from '@/lib/providers/signalhire';
import welink, { parseCredentials } from '@/lib/providers/welink';
import type { CallbackContext, ProviderResult } from '@/lib/types';
import { mergeResults } from '@/lib/waterfall';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function mockFetch(fn: (url: string, init: RequestInit & { json: any }) => Response) {
  const calls: { url: string; body: any; headers: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers: init.headers });
    return fn(url, { ...init, json: body });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const base = { apiKey: 'K', options: {}, need: { email: true, phone: true }, callbackUrl: null };
const cbCtx: CallbackContext = { linkedinUrl: 'u', apiKey: 'K', options: {}, need: { email: true, phone: true }, previous: null, final: false };

describe('normalizeLinkedinUrl', () => {
  it.each([
    ['linkedin.com/in/jane-doe-123/?originalSubdomain=uk', 'https://www.linkedin.com/in/jane-doe-123'],
    ['https://uk.linkedin.com/in/jane-doe/details/experience/', 'https://www.linkedin.com/in/jane-doe'],
    ['  https://www.linkedin.com/in/J%C3%B6rg  ', 'https://www.linkedin.com/in/J%C3%B6rg'],
    ['https://www.linkedin.com/company/acme', null],
    ['https://evil.com/in/jane', null],
    ['notlinkedin.com/in/jane', null],
    ['', null],
  ])('%s', (input, expected) => expect(normalizeLinkedinUrl(input)).toBe(expected));
});

describe('mergeResults', () => {
  it('de-duplicates and records sources', () => {
    const m = mergeResults([
      {
        provider: 'signalhire',
        person: { fullName: 'Jane', headline: null },
        emails: [{ value: 'Jane@Acme.com', type: 'work', verified: false }],
        phones: [{ value: '+1 415-555-0100', type: null, verified: false }],
      },
      {
        provider: 'prospeo',
        person: null,
        emails: [{ value: 'jane@acme.com', type: null, verified: true }, { value: 'j@x.io', type: null, verified: false }],
        phones: [{ value: '+14155550100', type: 'mobile', verified: false }],
      },
    ]);
    expect(m.fullName).toBe('Jane');
    expect(m.emails).toHaveLength(2);
    expect(m.emails[0]).toEqual({ value: 'Jane@Acme.com', type: 'work', verified: true, sources: ['SignalHire', 'Prospeo'] });
    expect(m.phones).toEqual([{ value: '+1 415-555-0100', type: 'mobile', verified: false, sources: ['SignalHire', 'Prospeo'] }]);
  });
});

describe('signalhire', () => {
  const success = [{
    item: 'u',
    status: 'success',
    candidate: {
      fullName: 'Jane Doe',
      headLine: 'CTO',
      contacts: [
        { type: 'email', value: 'jane@acme.com', rating: 100, subType: 'work' },
        { type: 'phone', value: '+1 555', rating: 70, subType: 'work_phone' },
        { type: 'skype', value: 'jane.s' },
      ],
    },
  }];

  it('sync mode when no callback URL', async () => {
    const calls = mockFetch(() => json(200, success, { 'x-credits-left': '41' }));
    const r = await signalhire.lookup({ ...base, linkedinUrl: 'u', options: { useWaterfall: true } });
    expect(calls[0].body).toEqual({ items: ['u'], withoutWaterfall: true });
    expect(calls[0].headers.apikey).toBe('K');
    if ('waiting' in r) throw new Error('unexpected');
    expect(r.creditsLeft).toBe(41);
    expect(r.emails).toEqual([{ value: 'jane@acme.com', type: 'work', verified: true, confidence: 100 }]);
    expect(r.phones).toEqual([{ value: '+1 555', type: 'work', verified: false, confidence: 70 }]);
    expect(r.person?.fullName).toBe('Jane Doe');
    expect(r.message).toMatch(/Sync mode/);
  });

  it('waterfall mode returns waiting and posts callbackUrl', async () => {
    const calls = mockFetch(() => json(201, { requestId: 7 }));
    const r = await signalhire.lookup({ ...base, linkedinUrl: 'u', options: { useWaterfall: true }, callbackUrl: 'https://x.app/cb' });
    expect(calls[0].body).toEqual({ items: ['u'], callbackUrl: 'https://x.app/cb' });
    expect(r).toMatchObject({ waiting: true });
    expect(((await signalhire.parseCallback!(success, cbCtx)) as ProviderResult).emails[0].value).toBe('jane@acme.com');
  });

  it('maps errors and statuses', async () => {
    mockFetch(() => json(401, { error: 'bad' }));
    await expect(signalhire.lookup({ ...base, linkedinUrl: 'u' })).rejects.toMatchObject({ code: 'INVALID_API_KEY' });
    mockFetch(() => json(200, [{ item: 'u', status: 'failed' }]));
    expect(await signalhire.lookup({ ...base, linkedinUrl: 'u' })).toMatchObject({ found: false });
    expect(() => signalhire.parseCallback!([{ status: 'credits_are_over' }], cbCtx)).toThrow(/credits/);
  });
});

describe('prospeo', () => {
  it('parses email + mobile', async () => {
    const calls = mockFetch(() =>
      json(200, {
        error: false,
        person: {
          full_name: 'Jane Doe',
          email: { status: 'VERIFIED', revealed: true, email: 'jane@acme.com' },
          mobile: { status: 'VERIFIED', revealed: true, mobile: '+1 415-555-0100', mobile_international: '+1 415-555-0100' },
        },
        company: { name: 'Acme' },
      })
    );
    const r = await prospeo.lookup({ ...base, linkedinUrl: 'u', options: { revealMobile: true } });
    expect(calls[0].headers['X-KEY']).toBe('K');
    expect(calls[0].body).toMatchObject({ enrich_mobile: true, data: { linkedin_url: 'u' } });
    if ('waiting' in r) throw new Error('unexpected');
    expect(r.emails[0]).toMatchObject({ value: 'jane@acme.com', verified: true });
    expect(r.phones[0]).toMatchObject({ value: '+1 415-555-0100', type: 'mobile' });
    expect(r.person?.company).toBe('Acme');
  });

  it('does not pay for a mobile when a phone is already known, ignores masked values', async () => {
    const calls = mockFetch(() =>
      json(200, { error: false, person: { email: { email: 'j***@acme.com', revealed: false }, mobile: { mobile: '+1 4**', revealed: false } } })
    );
    const r = await prospeo.lookup({ ...base, linkedinUrl: 'u', options: { revealMobile: true }, need: { email: true, phone: false } });
    expect(calls[0].body.enrich_mobile).toBe(false);
    expect(r).toMatchObject({ found: false, emails: [], phones: [] });
  });

  it('NO_MATCH is a miss, INSUFFICIENT_CREDITS is an error', async () => {
    mockFetch(() => json(400, { error: true, error_code: 'NO_MATCH' }));
    expect(await prospeo.lookup({ ...base, linkedinUrl: 'u' })).toMatchObject({ found: false });
    mockFetch(() => json(400, { error: true, error_code: 'INSUFFICIENT_CREDITS' }));
    await expect(prospeo.lookup({ ...base, linkedinUrl: 'u' })).rejects.toMatchObject({ code: 'NO_CREDITS' });
  });
});

describe('welink', () => {
  const KEY = 'AK:SECRET';
  const wl = { ...base, apiKey: KEY, linkedinUrl: 'https://www.linkedin.com/in/jane', callbackUrl: 'https://x.app/cb' };
  const profile = (extra: object = {}) => ({
    status: 'SUCCESS',
    request_id: 'r1',
    result: { first_name: 'Jane', last_name: 'Doe', headline: 'CTO', company: 'Acme', profile_id: 'ACo1', is_connected: true, email: '', phone: null, ...extra },
  });
  const ctxFor = (previous: unknown, extra: Partial<CallbackContext> = {}): CallbackContext => ({
    ...cbCtx, apiKey: KEY, previous, ...extra,
  });

  it('parses KEY:SECRET[:ACCOUNT]', () => {
    expect(parseCredentials('a:b')).toEqual({ apiKey: 'a', apiSecret: 'b', accountId: null });
    expect(parseCredentials('a:b:acc')).toEqual({ apiKey: 'a', apiSecret: 'b', accountId: 'acc' });
    expect(() => parseCredentials('only-key')).toThrow(/API_KEY:API_SECRET/);
  });

  it('needs a public URL', async () => {
    await expect(welink.lookup({ ...wl, callbackUrl: null })).rejects.toMatchObject({ code: 'NO_PUBLIC_URL' });
  });

  it('two stages: profile details, then contact details for a 1st-degree connection', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/get_all_ln_accounts') ? json(200, [{ accountId: 'ACC', email: 'me@x.io' }])
      : url.endsWith('/get_profile_details') ? json(200, { requestId: 'r1' })
      : json(200, { requestId: 'r2' })
    );
    const w = await welink.lookup(wl);
    expect(w).toMatchObject({ waiting: true, requestId: 'r1' });
    expect(calls[1].body).toEqual({ accountId: 'ACC', profile_url: wl.linkedinUrl });
    expect((calls[1].headers as any)['x-api-key']).toBe('AK');
    expect((calls[1].headers as any)['x-api-secret']).toBe('SECRET');

    const w2 = await welink.parseCallback!(profile(), ctxFor((w as any).raw));
    expect(w2).toMatchObject({ waiting: true, requestId: 'r2' });
    expect(calls.at(-1)!.body).toEqual({ accountId: 'ACC', profile_id: 'ACo1' });

    const contact = { status: 'SUCCESS', requestId: 'r2', result: { emailAddress: 'jane@gmail.com', phoneNumbers: [{ number: '+1 415 555 0100', type: 'MOBILE' }] } };
    const r = (await welink.parseCallback!(contact, ctxFor((w2 as any).raw))) as ProviderResult;
    expect(r.found).toBe(true);
    expect(r.person).toMatchObject({ fullName: 'Jane Doe', headline: 'CTO', company: 'Acme' });
    expect(r.emails.map((e) => e.value)).toEqual(['jane@gmail.com']);
    expect(r.phones).toEqual([{ value: '+1 415 555 0100', type: 'mobile', verified: false, confidence: null }]);
  });

  it('skips contact details for non-connections and when the email is already in the profile', async () => {
    const calls = mockFetch(() => json(200, { requestId: 'x' }));
    const prev = { _welink: { stage: 'profile', accountId: 'ACC', requestId: 'r1' } };
    const r = (await welink.parseCallback!(profile({ is_connected: false }), ctxFor(prev))) as ProviderResult;
    expect(r).toMatchObject({ found: false, message: expect.stringMatching(/1st-degree/) });

    const r2 = (await welink.parseCallback!(profile({ email: 'jane@acme.com' }), ctxFor(prev, { need: { email: true, phone: false } }))) as ProviderResult;
    expect(r2.emails[0].value).toBe('jane@acme.com');
    expect(calls).toHaveLength(0);

    // Past the wait time: no follow-up request, answer with what we have.
    const r3 = await welink.parseCallback!(profile(), ctxFor(prev, { final: true }));
    expect(r3).toMatchObject({ found: false });
    expect(calls).toHaveLength(0);
  });

  it('maps failures', async () => {
    const prev = { _welink: { stage: 'profile', accountId: 'ACC', requestId: 'r1' } };
    expect(await welink.parseCallback!({ status: 'PROFILE_NOT_FOUND', request_id: 'r1' }, ctxFor(prev))).toMatchObject({ found: false });
    await expect(welink.parseCallback!({ status: 'FAILED', error: 'SKIPPED_INACTIVE' }, ctxFor(prev))).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    const contactPrev = { profile: profile(), _welink: { stage: 'contact', accountId: 'ACC', requestId: 'r2', profile: profile().result } };
    expect(await welink.parseCallback!({ status: 'CONTACT_INFO_FETCH_FAILED' }, ctxFor(contactPrev))).toMatchObject({ found: false, person: { fullName: 'Jane Doe' } });

    mockFetch(() => json(401, { status: 'UNAUTHORIZED' }));
    await expect(welink.lookup({ ...wl, apiKey: 'AK:SECRET:ACC' })).rejects.toMatchObject({ code: 'INVALID_API_KEY' });
  });

  it('verifies the webhook signature', async () => {
    const { createHmac } = await import('node:crypto');
    const data = { status: 'SUCCESS', request_id: 'r1', result: { a: 1 } };
    const hash = createHmac('sha256', 's3cret').update(JSON.stringify(data)).digest('hex');
    const hook = welink.sharedWebhook!;
    expect(hook.requestId({ ...data, hash })).toBe('r1');
    expect(hook.verify!({ ...data, hash }, { webhookSecret: 's3cret' })).toBe(true);
    expect(hook.verify!({ ...data, hash }, { webhookSecret: 'wrong' })).toBe(false);
    expect(hook.verify!(data, { webhookSecret: 's3cret' })).toBe(false);
    expect(hook.verify!(data, { webhookSecret: '' })).toBe(true);
  });

  it('reads credits', async () => {
    mockFetch(() => json(200, { success: true, data: { availableCredits: 95, totalCredits: 100 } }));
    expect(await welink.credits!(KEY)).toEqual({ credits: 95, plan: null });
  });
});
