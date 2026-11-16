import { NextResponse } from 'next/server';
import { providerById } from '@/lib/providers';
import { handle } from '@/lib/route';

/** Check a key that hasn't been saved yet (typed in the Settings form). Saved keys: /api/keys/:keyId/credits */
export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const p = providerById[id];
  if (!p?.credits) return NextResponse.json({ error: 'Provider does not support credit checks' }, { status: 404 });
  const apiKey = String((await req.json().catch(() => ({})))?.apiKey ?? '').trim();
  if (!apiKey) return NextResponse.json({ error: 'Enter an API key first' }, { status: 400 });
  try {
    return NextResponse.json(await p.credits(apiKey));
  } catch (err: any) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
});
