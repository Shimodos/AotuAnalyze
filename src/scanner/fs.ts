/**
 * Откуда сканер берёт дерево файлов.
 *
 * Правила сканера (scan.ts, plan.ts) одни, а источников два: локальная папка
 * Dropbox и индекс из Dropbox API (remote/fs.ts). Сканеру нужно ровно два
 * действия — список каталога и метаданные записи, — поэтому интерфейс такой
 * узкий. Пути в обоих случаях локального вида (<корень>/<проект>/…): так
 * результат скана не зависит от источника.
 */

import * as fs from 'node:fs';

export interface ScanEntry {
  name: string;
  isDirectory(): boolean;
}

export interface ScanStat {
  size: number;
  mtime: Date;
  mtimeMs: number;
}

export interface ScanFs {
  /** Содержимое каталога. Бросает, если каталога нет. */
  readdir(dir: string): ScanEntry[];
  /** Метаданные файла или каталога. Бросает, если записи нет. */
  stat(target: string): ScanStat;
  exists(target: string): boolean;
}

export const DISK_FS: ScanFs = {
  readdir: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
  stat: (target) => fs.statSync(target),
  exists: (target) => fs.existsSync(target),
};

/**
 * Текущий источник. Скан синхронный и идёт в один поток, поэтому источник —
 * состояние модуля, а не параметр, протянутый через полтора десятка функций.
 * Менять только через withScanFs: он гарантированно вернёт прежний.
 */
let current: ScanFs = DISK_FS;

export function scanFs(): ScanFs {
  return current;
}

export function withScanFs<T>(source: ScanFs, run: () => T): T {
  const previous = current;
  current = source;
  try {
    return run();
  } finally {
    current = previous;
  }
}
