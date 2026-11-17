import { NextResponse } from 'next/server';
import { disconnect } from '@/dropbox/tokens';
import { requireSameOrigin } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Стирает токены. Без same-origin любой сайт мог бы отключить Dropbox одним запросом. */
export async function POST(request: Request) {
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  disconnect();
  return NextResponse.json({ ok: true });
}
