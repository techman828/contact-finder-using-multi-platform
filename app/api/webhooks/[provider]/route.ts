import { after, NextResponse } from 'next/server';
import { handle } from '@/lib/route';
import { advance, handleWebhook } from '@/lib/waterfall';

export const maxDuration = 300;

/**
 * Shared webhook for providers whose webhook URL is configured once in their own dashboard (We-Link).
 * Paste https://<your-app>/api/webhooks/<provider id> there; results are matched to searches by request id.
 */
export const POST = handle(async (req: Request, { params }: { params: Promise<{ provider: string }> }) => {
  const { provider } = await params;
  const body = await req.json().catch(() => null);
  const r = await handleWebhook(provider, body);
  if (r.resume != null) {
    const id = r.resume;
    after(() => advance(id).catch((err) => console.error(`[search ${id}] advance failed`, err)));
  }
  return NextResponse.json({ ok: r.http === 200 }, { status: r.http });
});
