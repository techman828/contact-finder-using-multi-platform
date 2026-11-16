import { NextResponse } from 'next/server';
import { handle, intParam } from '@/lib/route';
import { getProviderRaw } from '@/lib/searches';

/** The provider's raw API response for one step (for debugging). */
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string; provider: string }> }) => {
  const { id, provider } = await params;
  return NextResponse.json(await getProviderRaw(intParam(id), provider));
});
