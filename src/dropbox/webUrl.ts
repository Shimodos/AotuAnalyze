/**
 * Ссылка на веб-версию Dropbox по локальному пути.
 *
 * API для этого не нужен: путь внутри синхронизированной папки один в один
 * повторяет путь в веб-интерфейсе. Достаточно отрезать корень, заменить
 * разделители и закодировать сегменты.
 *
 *   D:\Viarde Studio Dropbox\Kraus_211_...\05_Outbox\Interior
 *   -> https://www.dropbox.com/home/Kraus_211_.../05_Outbox/Interior
 */

import * as path from 'node:path';
import { CONFIG } from '@/config';
import { isInsideRoot } from '@/server/paths';

const WEB_ROOT = 'https://www.dropbox.com/home';

/** Путь относительно корня Dropbox, с прямыми слэшами и без ведущего */
function relativeToRoot(localPath: string): string | null {
  const resolved = path.resolve(localPath);
  if (!isInsideRoot(resolved)) return null;
  const root = path.resolve(CONFIG.root);
  if (resolved === root) return '';
  return resolved.slice(root.length + 1).split(path.sep).join('/');
}

/**
 * Ссылка на папку. Возвращает null, если путь вне корня Dropbox —
 * лучше не показать кнопку, чем дать ссылку в никуда.
 */
export function folderWebUrl(localPath: string): string | null {
  const relative = relativeToRoot(localPath);
  if (relative === null) return null;
  if (relative === '') return WEB_ROOT;
  return `${WEB_ROOT}/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Ссылка на файл. В вебе Dropbox файл открывается как предпросмотр
 * внутри своей папки, поэтому путь ведёт на папку, а имя уходит в preview.
 */
export function fileWebUrl(localFilePath: string): string | null {
  const folder = folderWebUrl(path.dirname(localFilePath));
  if (folder === null) return null;
  return `${folder}?preview=${encodeURIComponent(path.basename(localFilePath))}`;
}
