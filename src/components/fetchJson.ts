/**
 * Один способ ходить в свой API из компонентов.
 *
 * Сервер отдаёт ошибки в одной форме — `{ error, code? }` — и здесь она
 * превращается в исключение с человекочитаемым текстом и машинным кодом,
 * чтобы компонент мог отличить, например, «скан уже идёт» от сбоя.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { json?: unknown },
  fallbackMessage?: (status: number) => string,
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    ...(json !== undefined
      ? {
          method: rest.method ?? 'POST',
          headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
          body: JSON.stringify(json),
        }
      : {}),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (payload && typeof payload.error === 'string' && payload.error) ||
      fallbackMessage?.(res.status) ||
      `HTTP ${res.status}`;
    throw new ApiError(message, res.status, payload?.code, payload);
  }
  return payload as T;
}
