/**
 * Общее для API-роутов: единая форма ошибки, разбор тела, защита от CSRF.
 *
 * Форма ошибки одна на все роуты: `{ error: string, code?: string }`.
 * `error` — текст для человека, `code` — машинный признак, если клиенту
 * нужно отличить одну ситуацию от другой (например, «доска открыта по сети»).
 */

import { NextResponse } from 'next/server';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function jsonError(error: string, status: number, code?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(code ? { code } : {}), ...(extra ?? {}) }, { status });
}

/** Тело POST-запроса. Битый JSON — 400, а не необработанный 500 со стеком. */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Защита мутирующих роутов от CSRF.
 *
 * Доска ходит на сервер только с той же страницы. Любой другой сайт, открытый
 * в браузере на этой машине, мог бы отправить POST на localhost — `fetch` с
 * `mode: 'no-cors'` уходит без preflight и без Content-Type. Браузеры при этом
 * ставят `Sec-Fetch-Site`, а старые — хотя бы `Origin`; по ним и отсекаем.
 *
 * Запрос без обоих заголовков — не браузер (curl, скрипт), его пропускаем:
 * CSRF — атака через чужой браузер, а не через консоль.
 */
export function requireSameOrigin(request: Request): NextResponse | null {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) {
    if (site === 'same-origin' || site === 'none') return null;
    return jsonError('запрос с другого сайта отклонён', 403, 'cross-site');
  }

  const origin = request.headers.get('origin');
  if (origin !== null) {
    const host = request.headers.get('host') ?? '';
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* мусор в Origin — считаем чужим */
    }
    if (originHost && originHost === host) return null;
    return jsonError('запрос с другого сайта отклонён', 403, 'cross-site');
  }

  return null;
}
