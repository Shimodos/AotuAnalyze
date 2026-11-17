/**
 * Пути внутри корня Dropbox — единственное место, где они собираются
 * и проверяются.
 *
 * Проверка «путь внутри корня» — предохранитель перед запуском процесса,
 * чтением файла и записью в Dropbox. Раньше она была скопирована в пять
 * мест с разночтениями; security-check обязан быть один.
 */

import * as path from 'node:path';
import { CONFIG } from '@/config';

/** Папка проекта, в которой лежат сцены; та же, из которой сканер считает кадры */
export const SCENES_FOLDER = '04_JPG';
export const OUTBOX_FOLDER = '05_Outbox';

/** Путь лежит в корне Dropbox или внутри него. `..` не проходит: сравниваем resolve'нутые пути. */
export function isInsideRoot(p: string): boolean {
  const resolved = path.resolve(p);
  const root = path.resolve(CONFIG.root);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Имя папки или файла, пришедшее из запроса, не должно содержать разделителей
 * и `..` — иначе `path.join` уведёт нас за пределы проекта.
 */
export function isSafeSegment(name: string | null | undefined): name is string {
  return Boolean(name) && !name!.includes('/') && !name!.includes('\\') && !name!.includes('..');
}

export function scenePath(projectPath: string, sceneName: string): string {
  return path.join(projectPath, SCENES_FOLDER, sceneName);
}

export function deliveryPath(projectPath: string, folderName: string): string {
  return path.join(projectPath, OUTBOX_FOLDER, folderName);
}
