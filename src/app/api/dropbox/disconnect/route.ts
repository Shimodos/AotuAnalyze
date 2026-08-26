import { NextResponse } from 'next/server';
import { disconnect } from '@/dropbox/tokens';

export const dynamic = 'force-dynamic';

export async function POST() {
  disconnect();
  return NextResponse.json({ ok: true });
}
