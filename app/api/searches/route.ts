import { after, NextResponse } from 'next/server';
import { normalizeLinkedinUrl } from '@/lib/linkedin';
import { handle } from '@/lib/route';
import { clearSearches, listSearches } from '@/lib/searches';
import { advance, createSearch, reconcile } from '@/lib/waterfall';

export const maxDuration = 300;

/** Start a search. Returns immediately; the waterfall runs after the response and the UI polls for progress. */
export const POST = handle(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const url = normalizeLinkedinUrl(body?.url);
  if (!url) {
    return NextResponse.json({ error: 'Enter a LinkedIn profile URL like https://www.linkedin.com/in/username' }, { status: 400 });
  }
  const id = await createSearch(url);
  after(() => advance(id).catch((err) => console.error(`[search ${id}] advance failed`, err)));
  return NextResponse.json({ id, url }, { status: 201 });
});

export const GET = handle(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const limit = Math.min(200, Math.max(1, Number(sp.get('limit')) || 50));
  const offset = Math.max(0, Number(sp.get('offset')) || 0);

  // Unstick any search left running (closed tab, missed callback, killed function).
  const stalled = await reconcile();
  if (stalled.length) after(() => Promise.allSettled(stalled.map((id) => advance(id))));

  return NextResponse.json(await listSearches({ q: (sp.get('q') || '').trim().slice(0, 200), limit, offset }));
});

export const DELETE = handle(async () => {
  await clearSearches();
  return new Response(null, { status: 204 });
});
