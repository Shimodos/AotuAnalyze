import { NextResponse } from 'next/server';
import { syncOnce } from '@/sync/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Ручной запуск скана. Фоновый идёт по таймеру из instrumentation.ts */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const withSizes = url.searchParams.get('sizes') === '1';
  try {
    const result = syncOnce({ withSizes });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
