/**
 * Content-эндпоинты Dropbox: те, что отдают сам файл, а не JSON
 * (files/download, files/get_thumbnail_v2).
 *
 * От обычных вызовов (client.ts) они отличаются хостом и тем, что аргументы
 * едут не в теле, а в заголовке Dropbox-API-Arg.
 */

import * as path from 'node:path';
import { CONFIG } from '@/config';
import { getAccessToken, readSetting } from './tokens';

const CONTENT_URL = 'https://content.dropboxapi.com/2';

export async function dropboxContent(route: string, arg: unknown): Promise<Response> {
  const token = await getAccessToken();

  // Заголовок HTTP — только ASCII: всё остальное в JSON экранируем \uXXXX
  const apiArg = JSON.stringify(arg).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );

  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': apiArg };
  const root = readSetting('dropbox.root_namespace_id');
  if (root) headers['Dropbox-API-Path-Root'] = JSON.stringify({ '.tag': 'root', root });

  return fetch(`${CONTENT_URL}/${route}`, { method: 'POST', headers });
}

/**
 * Путь в Dropbox по локальному пути внутри корня: «D:\…\Kraus_1\a.jpg» →
 * «/Kraus_1/a.jpg». Локальная папка повторяет дерево Dropbox один в один.
 * null — путь вне корня.
 */
export function dropboxPathOf(localPath: string): string | null {
  const root = path.resolve(CONFIG.root);
  const resolved = path.resolve(localPath);
  if (resolved.length <= root.length) return null;
  if (resolved.slice(0, root.length).toLowerCase() !== root.toLowerCase()) return null;
  if (resolved[root.length] !== path.sep) return null;
  return '/' + resolved.slice(root.length + 1).split(path.sep).join('/');
}
