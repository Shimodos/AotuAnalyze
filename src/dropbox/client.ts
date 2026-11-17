/**
 * Обёртка над HTTP API Dropbox.
 *
 * Сама подставляет свежий токен и заголовок командного пространства —
 * без Dropbox-API-Path-Root обычный токен видит только личную папку админа,
 * и проекты просто не находятся.
 */

import { DROPBOX } from './config';
import { getAccessToken, readSetting } from './tokens';

export async function dropboxCall<T = unknown>(route: string, body: unknown): Promise<T> {
  const token = await getAccessToken();

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  // Эндпоинты без аргументов (users/get_current_account) требуют пустого тела
  // И БЕЗ заголовка Content-Type — иначе Dropbox отвечает ошибкой разбора.
  if (body !== null) headers['Content-Type'] = 'application/json';

  const root = readSetting('dropbox.root_namespace_id');
  if (root) headers['Dropbox-API-Path-Root'] = JSON.stringify({ '.tag': 'root', root });

  const res = await fetch(`${DROPBOX.apiUrl}/${route}`, {
    method: 'POST',
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Dropbox ${route}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

// Комментарии к файлам: исследование закрыто (COMMENTS_RESEARCH.md), рабочий
// probe живёт в scripts/probe-file-comments.ts. В приложении вызовов нет.
