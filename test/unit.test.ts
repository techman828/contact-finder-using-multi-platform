import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeLinkedinUrl } from '@/lib/linkedin';
import prospeo from '@/lib/providers/prospeo';
import signalhire from '@/lib/providers/signalhire';
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
    expect(signalhire.parseCallback!(success).emails[0].value).toBe('jane@acme.com');
  });

  it('maps errors and statuses', async () => {
    mockFetch(() => json(401, { error: 'bad' }));
    await expect(signalhire.lookup({ ...base, linkedinUrl: 'u' })).rejects.toMatchObject({ code: 'INVALID_API_KEY' });
    mockFetch(() => json(200, [{ item: 'u', status: 'failed' }]));
    expect(await signalhire.lookup({ ...base, linkedinUrl: 'u' })).toMatchObject({ found: false });
    expect(() => signalhire.parseCallback!([{ status: 'credits_are_over' }])).toThrow(/credits/);
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
