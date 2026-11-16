/**
 * Waterfall engine against a real Postgres. Set TEST_DATABASE_URL to run, e.g.
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55432/contacts_test npm test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const PUBLIC = 'https://cf-test.example.com';

describe.skipIf(!url)('waterfall engine (postgres)', async () => {
  process.env.DATABASE_URL = url;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const { db, closeDb } = await import('@/lib/db');
  const { saveSettings } = await import('@/lib/settings');
  const { advance, createSearch, handleCallback, reconcile } = await import('@/lib/waterfall');
  const { getSearch, listSearches } = await import('@/lib/searches');

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const shSuccess = (contacts: object[]) => [{ item: 'u', status: 'success', candidate: { fullName: 'Jane', contacts } }];
  const EMAIL = { type: 'email', value: 'jane@acme.com', rating: 100 };
  const PHONE = { type: 'phone', value: '+1 555 0100', rating: 100, subType: 'mobile' };

  let calls: { url: string; body: any; key: string }[] = [];
  type Handler = (body: any, key: string) => Response;
  function mockFetch(handlers: { signalhire?: Handler; prospeo?: Handler }) {
    calls = [];
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const h0 = (init.headers || {}) as Record<string, string>;
      const key = h0.apikey || h0['X-KEY'];
      calls.push({ url: u, body, key });
      const h = u.includes('signalhire') ? handlers.signalhire : handlers.prospeo;
      if (!h) throw new Error(`unexpected fetch ${u}`);
      return h(body, key);
    });
  }

  async function configure(
    opts: { publicUrl?: string; stopWhen?: string; prospeoEnabled?: boolean; shKeys?: string[]; prKeys?: string[] } = {}
  ) {
    const sql = await db();
    await sql`DELETE FROM api_keys`; // fresh key health for every test
    await saveSettings({
      general: { stopWhen: (opts.stopWhen as any) ?? 'email_and_phone', publicUrl: opts.publicUrl ?? '' },
      providers: [
        {
          id: 'signalhire',
          enabled: true,
          options: { useWaterfall: true, timeoutSec: 30 },
          keys: (opts.shKeys ?? ['SH-key-0001']).map((k, i) => ({ label: `SH ${i + 1}`, apiKey: k })),
        },
        {
          id: 'prospeo',
          enabled: opts.prospeoEnabled ?? true,
          options: { revealMobile: true },
          keys: (opts.prKeys ?? ['PR-key-0001']).map((k, i) => ({ label: `PR ${i + 1}`, apiKey: k })),
        },
      ],
    });
  }

  beforeAll(async () => {
    const sql = await db();
    await sql`TRUNCATE settings, searches, provider_results, api_keys RESTART IDENTITY CASCADE`;
  });
  beforeEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
  });

  it('stops after the first provider when email + phone are found', async () => {
    await configure();
    mockFetch({ signalhire: () => json(200, shSuccess([EMAIL, PHONE])) });
    const id = await createSearch('https://www.linkedin.com/in/jane');
    await advance(id);
    const s = (await getSearch(id))!;
    expect(calls).toHaveLength(1);
    expect(s.status).toBe('done');
    expect(s.full_name).toBe('Jane');
    expect(s.providers!.map((p) => p.status)).toEqual(['found', 'skipped']);
    expect(s.finished_at).not.toBeNull();
  });

  it('falls through to Prospeo for the missing phone and merges sources', async () => {
    await configure();
    mockFetch({
      signalhire: () => json(200, shSuccess([EMAIL])),
      prospeo: () => json(200, { error: false, person: { email: { email: 'jane@acme.com', status: 'VERIFIED' }, mobile: { mobile: '+14155550100', status: 'VERIFIED' } } }),
    });
    const id = await createSearch('https://www.linkedin.com/in/jane');
    await advance(id);
    const s = (await getSearch(id))!;
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['www.signalhire.com', 'api.prospeo.io']);
    expect(calls[1].body.enrich_mobile).toBe(true);
    expect(s.emails).toEqual([{ value: 'jane@acme.com', type: 'work', verified: true, sources: ['SignalHire', 'Prospeo'] }]);
    expect(s.phones[0].value).toBe('+14155550100');
  });

  it('records provider errors and keeps going', async () => {
    await configure();
    mockFetch({
      signalhire: () => json(401, { error: 'bad key' }),
      prospeo: () => json(400, { error: true, error_code: 'NO_MATCH' }),
    });
    const id = await createSearch('https://www.linkedin.com/in/nobody');
    await advance(id);
    const s = (await getSearch(id))!;
    expect(s.status).toBe('error');
    expect(s.providers!.map((p) => p.status)).toEqual(['error', 'not_found']);
    expect(s.providers![0].message).toMatch(/INVALID_API_KEY/);
  });

  it('waterfall callback: waits, then resumes with the next provider', async () => {
    await configure({ publicUrl: PUBLIC });
    mockFetch({
      signalhire: () => json(201, { requestId: 99 }),
      prospeo: () => json(200, { error: false, person: { mobile: { mobile: '+14155550100', status: 'VERIFIED' } } }),
    });
    const id = await createSearch('https://www.linkedin.com/in/jane');
    await advance(id);

    let s = (await getSearch(id))!;
    expect(s.status).toBe('running');
    expect(s.providers!.map((p) => p.status)).toEqual(['waiting', 'pending']);
    const cb: string = calls[0].body.callbackUrl;
    expect(cb).toMatch(new RegExp(`^${PUBLIC}/api/callbacks/signalhire/[0-9a-f]{36}$`));
    const token = cb.split('/').pop()!;

    expect(await handleCallback('signalhire', 'f'.repeat(36), [])).toEqual({ ok: false });
    expect(await handleCallback('prospeo', token, [])).toEqual({ ok: false });

    const r = await handleCallback('signalhire', token, shSuccess([EMAIL]));
    expect(r).toEqual({ ok: true, resume: id });
    // Duplicate delivery is acknowledged but ignored.
    expect(await handleCallback('signalhire', token, shSuccess([EMAIL]))).toEqual({ ok: true });

    await advance(id);
    s = (await getSearch(id))!;
    expect(s.status).toBe('done');
    expect(s.providers!.map((p) => p.status)).toEqual(['found', 'found']);
    expect(calls.at(-1)!.body.enrich_mobile).toBe(true);
    expect(s.emails[0].value).toBe('jane@acme.com');
    expect(s.phones[0].value).toBe('+14155550100');
  });

  it('callback that arrives before the 201 response is handled', async () => {
    await configure({ publicUrl: PUBLIC, prospeoEnabled: false });
    let early: Promise<unknown> | undefined;
    mockFetch({
      signalhire: (body) => {
        early = handleCallback('signalhire', body.callbackUrl.split('/').pop(), shSuccess([EMAIL, PHONE]));
        return json(201, { requestId: 1 });
      },
    });
    const id = await createSearch('https://www.linkedin.com/in/jane');
    // Make sure the early callback is stored before lookup() returns.
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => {
      const res = await orig(...a);
      await early;
      return res;
    });
    await advance(id);
    const s = (await getSearch(id))!;
    expect(s.status).toBe('done');
    expect(s.providers!.map((p) => p.status)).toEqual(['found']);
  });

  it('times out an overdue callback, moves on, and still saves a late result', async () => {
    await configure({ publicUrl: PUBLIC });
    mockFetch({
      signalhire: () => json(201, { requestId: 5 }),
      prospeo: () => json(400, { error: true, error_code: 'NO_MATCH' }),
    });
    const id = await createSearch('https://www.linkedin.com/in/late');
    await advance(id);
    const token = calls[0].body.callbackUrl.split('/').pop();

    const sql = await db();
    await sql`UPDATE provider_results SET deadline_at = now() - interval '1 second' WHERE search_id = ${id} AND status = 'waiting'`;
    expect(await reconcile(id)).toEqual([id]);
    await advance(id);
    let s = (await getSearch(id))!;
    expect(s.providers!.map((p) => p.status)).toEqual(['timeout', 'not_found']);
    expect(s.status).toBe('error');

    expect(await handleCallback('signalhire', token, shSuccess([EMAIL]))).toEqual({ ok: true });
    s = (await getSearch(id))!;
    expect(s.providers![0].status).toBe('found');
    expect(s.providers![0].message).toMatch(/after the wait time/);
    expect(s.status).toBe('done');
    expect(s.emails[0].value).toBe('jane@acme.com');
  });

  it('concurrent advance() calls run each provider exactly once', async () => {
    await configure();
    mockFetch({
      signalhire: () => json(200, shSuccess([EMAIL])),
      prospeo: () => json(200, { error: false, person: { mobile: { mobile: '+1999', status: 'VERIFIED' } } }),
    });
    const id = await createSearch('https://www.linkedin.com/in/race');
    await Promise.all([advance(id), advance(id), advance(id)]);
    // A losing call returns while another is mid-step; one more pass finishes any remaining work.
    for (const sid of await reconcile(id)) await advance(sid);
    const s = (await getSearch(id))!;
    expect(calls).toHaveLength(2);
    expect(s.status).toBe('done');
  });

  it('reconcile marks long-running (killed) steps as interrupted and resumes', async () => {
    await configure({ prospeoEnabled: true });
    mockFetch({ prospeo: () => json(200, { error: false, person: { email: { email: 'p@x.io' }, mobile: { mobile: '+1888' } } }) });
    const id = await createSearch('https://www.linkedin.com/in/killed');
    const sql = await db();
    await sql`UPDATE provider_results SET status = 'running', started_at = now() - interval '10 minutes' WHERE search_id = ${id} AND provider = 'signalhire'`;
    expect(await reconcile(id)).toEqual([id]);
    await advance(id);
    const s = (await getSearch(id))!;
    expect(s.providers!.map((p) => p.status)).toEqual(['error', 'found']);
    expect(s.status).toBe('done');
  });

  it('history search and paging', async () => {
    const all = await listSearches({ limit: 100 });
    expect(all.total).toBeGreaterThanOrEqual(8);
    const found = await listSearches({ q: 'late' });
    expect(found.rows.map((r) => r.linkedin_url)).toEqual(['https://www.linkedin.com/in/late']);
    expect((await listSearches({ q: '100%' })).total).toBe(0);
    const page = await listSearches({ limit: 2, offset: 1 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0].id).toBe(all.rows[1].id);
  });

  // ---------------------------------------------------------------- multiple API keys

  it('fails over to the next key when one is out of credits, and demotes the empty key', async () => {
    await configure({ shKeys: ['SH-empty-0001', 'SH-good-0002'], prospeoEnabled: false });
    mockFetch({
      signalhire: (_b, key) => (key === 'SH-empty-0001' ? json(402, {}) : json(200, shSuccess([EMAIL, PHONE]))),
    });
    const id = await createSearch('https://www.linkedin.com/in/failover');
    await advance(id);
    const s = (await getSearch(id))!;
    expect(calls.map((c) => c.key)).toEqual(['SH-empty-0001', 'SH-good-0002']);
    expect(s.status).toBe('done');
    expect(s.providers![0]).toMatchObject({ status: 'found', api_key_label: 'SH 2' });
    expect(s.providers![0].message).toMatch(/SH 1: NO_CREDITS → switched key/);

    const { listKeys } = await import('@/lib/keys');
    const keys = await listKeys();
    expect(keys.find((k) => k.api_key === 'SH-empty-0001')).toMatchObject({ credits: 0, last_error_code: 'NO_CREDITS' });
    expect(keys.find((k) => k.api_key === 'SH-good-0002')).toMatchObject({ last_error_code: null });

    // Next search starts with the healthy key — no wasted call on the empty one.
    const id2 = await createSearch('https://www.linkedin.com/in/failover-2');
    await advance(id2);
    expect(calls.slice(2).map((c) => c.key)).toEqual(['SH-good-0002']);
  });

  it('reports when every key fails, and does not fail over on non-key errors', async () => {
    await configure({ shKeys: ['SH-bad-00001', 'SH-bad-00002'], prospeoEnabled: false });
    mockFetch({ signalhire: () => json(401, {}) });
    const id = await createSearch('https://www.linkedin.com/in/allbad');
    await advance(id);
    let s = (await getSearch(id))!;
    expect(calls).toHaveLength(2);
    expect(s.status).toBe('error');
    expect(s.providers![0].message).toMatch(/All 2 keys failed \(SH 1: INVALID_API_KEY, SH 2: INVALID_API_KEY\)/);

    // "Profile not found" is an answer, not a key problem: only the first key is used.
    await configure({ shKeys: ['SH-a-0000001', 'SH-b-0000002'], prospeoEnabled: false });
    mockFetch({ signalhire: () => json(200, [{ item: 'u', status: 'failed' }]) });
    const id2 = await createSearch('https://www.linkedin.com/in/nobody-2');
    await advance(id2);
    s = (await getSearch(id2))!;
    expect(calls.map((c) => c.key)).toEqual(['SH-a-0000001']);
    expect(s.status).toBe('not_found');
  });

  it('skips disabled keys and providers without an enabled key', async () => {
    const { publicSettings } = await import('@/lib/settings');
    await configure({ shKeys: ['SH-off-00001', 'SH-on-000002'] });
    const ps = await publicSettings();
    const sh = ps.providers.find((p) => p.id === 'signalhire')!;
    const pr = ps.providers.find((p) => p.id === 'prospeo')!;
    await saveSettings({
      providers: [
        { id: 'signalhire', enabled: true, keys: [{ id: sh.keys[0].id, label: 'Off', enabled: false }, { id: sh.keys[1].id, label: 'On' }] },
        { id: 'prospeo', enabled: true, keys: [{ id: pr.keys[0].id, label: 'PR', enabled: false }] },
      ],
    });
    mockFetch({ signalhire: () => json(200, shSuccess([EMAIL])) });
    const id = await createSearch('https://www.linkedin.com/in/disabled-keys');
    await advance(id);
    const s = (await getSearch(id))!;
    expect(calls.map((c) => c.key)).toEqual(['SH-on-000002']);
    expect(s.providers!.map((p) => p.provider)).toEqual(['signalhire']); // prospeo had no enabled key
  });

  it('saves the key list: add, rename, reorder, delete, reject duplicates, never expose raw keys', async () => {
    const { publicSettings } = await import('@/lib/settings');
    await configure({ shKeys: ['SH-one-00001', 'SH-two-00002'] });
    let sh = (await publicSettings()).providers.find((p) => p.id === 'signalhire')!;
    expect(sh.keys.map((k) => [k.label, k.preview])).toEqual([['SH 1', '••••0001'], ['SH 2', '••••0002']]);

    // reorder + rename, delete key one, add a new key with a blank label
    await saveSettings({
      providers: [
        { id: 'signalhire', keys: [{ id: sh.keys[1].id, label: 'Team B' }, { label: '', apiKey: '  SH-three-0003 ' }] },
      ],
    });
    const all = await publicSettings();
    sh = all.providers.find((p) => p.id === 'signalhire')!;
    expect(sh.keys.map((k) => [k.label, k.preview, k.enabled])).toEqual([['Team B', '••••0002', true], ['Key 2', '••••0003', true]]);
    // prospeo omitted from the list -> its keys and position are kept
    expect(all.providers.find((p) => p.id === 'prospeo')!.keys).toHaveLength(1);

    await expect(
      saveSettings({ providers: [{ id: 'signalhire', keys: [{ id: sh.keys[0].id }, { apiKey: 'SH-two-00002' }] }] })
    ).rejects.toThrow(/already added/);
    await expect(
      saveSettings({ providers: [{ id: 'signalhire', keys: [{ apiKey: 'dup-key-0001' }, { apiKey: 'dup-key-0001' }] }] })
    ).rejects.toThrow(/already added/);
    // a failed save changes nothing
    expect((await publicSettings()).providers.find((p) => p.id === 'signalhire')!.keys).toHaveLength(2);

    const blob = JSON.stringify(await publicSettings());
    expect(blob).not.toContain('SH-two-00002');
    expect(blob).not.toContain('SH-three-0003');
    expect(blob).not.toContain('PR-key-0001');
  });

  it('migrates a single key saved by the previous version', async () => {
    const sql = await db();
    await sql`DELETE FROM api_keys`;
    await sql`
      INSERT INTO settings (key, value) VALUES ('providers', ${[{ id: 'prospeo', enabled: true, apiKey: 'legacy-key-123', options: {} }] as any}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    await closeDb(); // next db() call re-runs the schema/migration like a cold start
    const { listKeys } = await import('@/lib/keys');
    const keys = await listKeys();
    expect(keys.map((k) => [k.provider, k.label, k.api_key])).toEqual([['prospeo', 'Key 1', 'legacy-key-123']]);
    const [row] = await (await db())`SELECT value FROM settings WHERE key = 'providers'`;
    expect(JSON.stringify(row.value)).not.toContain('legacy-key-123');
  });
});
