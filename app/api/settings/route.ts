import { NextResponse } from 'next/server';
import { handle } from '@/lib/route';
import { publicSettings, saveSettings } from '@/lib/settings';

export const GET = handle(async () => NextResponse.json(await publicSettings()));

export const PUT = handle(async (req: Request) => NextResponse.json(await saveSettings(await req.json())));
