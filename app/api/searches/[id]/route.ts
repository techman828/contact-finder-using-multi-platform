import { after, NextResponse } from 'next/server';
import { handle, intParam } from '@/lib/route';
import { deleteSearch, getSearch } from '@/lib/searches';
import { advance, reconcile } from '@/lib/waterfall';

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const id = intParam((await params).id);
  const s = await getSearch(id);
  if (!s) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (s.status === 'running') {
    const stalled = await reconcile(id);
    if (stalled.length) after(() => advance(id).catch((err) => console.error(`[search ${id}] advance failed`, err)));
  }
  return NextResponse.json(s);
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  await deleteSearch(intParam((await params).id));
  return new Response(null, { status: 204 });
});
