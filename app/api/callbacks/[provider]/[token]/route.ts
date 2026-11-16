import { after, NextResponse } from 'next/server';
import { handle } from '@/lib/route';
import { advance, handleCallback } from '@/lib/waterfall';

export const maxDuration = 300;

/**
 * Webhook endpoint for providers that deliver results asynchronously (SignalHire waterfall mode).
 * Must answer 200 quickly; the rest of the waterfall continues after the response.
 */
export const POST = handle(async (req: Request, { params }: { params: Promise<{ provider: string; token: string }> }) => {
  const { provider, token } = await params;
  const body = await req.json().catch(() => null);
  const r = await handleCallback(provider, token, body);
  if (r.resume != null) {
    const id = r.resume;
    after(() => advance(id).catch((err) => console.error(`[search ${id}] advance failed`, err)));
  }
  return NextResponse.json({ ok: r.ok }, { status: r.ok ? 200 : 404 });
});
