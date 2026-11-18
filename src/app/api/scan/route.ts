import { NextResponse } from 'next/server';
import { jsonError, requireSameOrigin } from '@/server/http';
import { startBackgroundScan } from '@/sync/launch';

export const dynamic = 'force-dynamic';

/**
 * Ручной запуск скана — кнопка «Сканувати».
 *
 * Скан идёт отдельным процессом (см. sync/launch.ts), ответ приходит сразу.
 * Доска видит `scanning: true` в /api/board и опрашивает чаще, пока не закончится.
 * `?sizes=1` — полный обход с весом проектов, он долгий даже на здоровом диске.
 */
export async function POST(request: Request) {
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const withSizes = url.searchParams.get('sizes') === '1';

  const result = startBackgroundScan({ withSizes });
  if (result === 'running') return jsonError('Скан уже идёт', 409, 'running');
  if (result === 'failed') return jsonError('не удалось запустить скан', 500);
  if (result === 'not-connected') return jsonError('Dropbox не подключён', 409, 'not-connected');
  return NextResponse.json({ ok: true, started: true });
}
