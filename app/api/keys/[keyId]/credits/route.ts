import { NextResponse } from 'next/server';
import { ProviderError } from '@/lib/http';
import { FAILOVER_CODES, getKey, recordKeyCredits, recordKeyError, toPublicKey } from '@/lib/keys';
import { providerById } from '@/lib/providers';
import { handle, intParam } from '@/lib/route';

/** Check a saved key's remaining credits and remember the result (shown in Settings, used for key ordering). */
export const POST = handle(async (_req: Request, { params }: { params: Promise<{ keyId: string }> }) => {
  const key = await getKey(intParam((await params).keyId));
  if (!key) return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  const p = providerById[key.provider];
  if (!p?.credits) return NextResponse.json({ error: 'Provider does not support credit checks' }, { status: 404 });
  try {
    const info = await p.credits(key.api_key);
    await recordKeyCredits(key.id, info.credits);
    return NextResponse.json({ ...info, key: toPublicKey((await getKey(key.id))!) });
  } catch (err: any) {
    if (err instanceof ProviderError && FAILOVER_CODES.has(err.code)) await recordKeyError(key.id, err.code);
    return NextResponse.json({ error: err.message, code: err.code, key: toPublicKey((await getKey(key.id))!) }, { status: 400 });
  }
});
