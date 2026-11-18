/**
 * Индекс Dropbox в роли файловой системы для сканера (scanner/fs.ts).
 *
 * Весь индекс читается из базы один раз и раскладывается по каталогам в
 * памяти: скан — это тысячи обращений, и ходить за каждым в SQLite незачем.
 * Диск не трогается.
 *
 * Пути снаружи — локального вида (<корень>/<проект>/…), как у обхода диска:
 * тогда пути обложек и папок в результате скана одинаковы при любом источнике,
 * и «открыть папку» с веб-ссылками продолжают работать.
 */

import * as path from 'node:path';
import { isNotNull } from 'drizzle-orm';
import { CONFIG } from '@/config';
import { getDb, schema } from '@/db';
import type { ScanEntry, ScanFs, ScanStat } from '@/scanner/fs';

type Row = typeof schema.remoteEntries.$inferSelect;

const EPOCH = new Date(0);

export interface IndexFs extends ScanFs {
  /** Путь в Dropbox по локальному пути — нужен, чтобы скачать файл через API */
  dropboxPath(target: string): string | null;
  /** Папки отслеживаемых проектов, дерево которых загружено */
  projectFolders(): string[];
}

export function createIndexFs(root: string = CONFIG.root): IndexFs {
  const db = getDb();
  const rootResolved = path.resolve(root);

  // Только загруженные проекты: у недогруженного дерево неполное, и скан
  // принял бы отсутствие файлов за правду
  const projects = db
    .select()
    .from(schema.trackedProjects)
    .where(isNotNull(schema.trackedProjects.syncedAt))
    .all();

  const byPath = new Map<string, Row>();
  const children = new Map<string, Row[]>();
  for (const row of db.select().from(schema.remoteEntries).all()) {
    byPath.set(row.pathLower, row);
    const parent = row.pathLower.slice(0, row.pathLower.lastIndexOf('/'));
    const list = children.get(parent);
    if (list) list.push(row);
    else children.set(parent, [row]);
  }

  const projectDirs = new Set(projects.map((p) => '/' + p.folderName.toLowerCase()));

  /** Локальный путь → ключ индекса ('' для корня); null — путь вне корня */
  const toKey = (target: string): string | null => {
    const resolved = path.resolve(target);
    if (resolved.length < rootResolved.length) return null;
    if (resolved.slice(0, rootResolved.length).toLowerCase() !== rootResolved.toLowerCase()) return null;
    const rest = resolved.slice(rootResolved.length);
    if (rest === '') return '';
    if (rest[0] !== path.sep) return null;
    return rest.split(path.sep).join('/').toLowerCase();
  };

  const isDir = (key: string): boolean =>
    key === '' || projectDirs.has(key) || byPath.get(key)?.isDir === true;

  const entry = (name: string, dir: boolean): ScanEntry => ({ name, isDirectory: () => dir });

  /**
   * Порядок как у NTFS: по имени в верхнем регистре. Это не косметика. Когда
   * у двух отгрузок или двух кадров одинаковая дата (файл скопировали из
   * Prefinal в Final), сканер берёт первый встреченный — и при другом порядке
   * перебора проект оказывался в другой колонке.
   */
  const ntfsOrder = (a: ScanEntry, b: ScanEntry) => {
    const x = a.name.toUpperCase();
    const y = b.name.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  };

  return {
    readdir(dir) {
      const key = toKey(dir);
      if (key === null || !isDir(key)) throw new Error(`ENOENT: нет каталога в индексе: ${dir}`);
      const list =
        key === ''
          ? projects.map((p) => entry(p.folderName, true))
          : (children.get(key) ?? []).map((row) => entry(row.name, row.isDir));
      return list.sort(ntfsOrder);
    },

    stat(target): ScanStat {
      const key = toKey(target);
      if (key === null) throw new Error(`ENOENT: путь вне корня: ${target}`);
      const row = byPath.get(key);
      if (!row) {
        // У папок в Dropbox нет дат; корень и папка проекта могут быть без строки
        if (isDir(key)) return { size: 0, mtime: EPOCH, mtimeMs: 0 };
        throw new Error(`ENOENT: нет записи в индексе: ${target}`);
      }
      const mtime = row.clientModified ?? EPOCH;
      return { size: row.size ?? 0, mtime, mtimeMs: mtime.getTime() };
    },

    exists(target) {
      const key = toKey(target);
      return key !== null && (isDir(key) || byPath.has(key));
    },

    dropboxPath(target) {
      const key = toKey(target);
      return key ? (byPath.get(key)?.pathDisplay ?? null) : null;
    },

    projectFolders: () => projects.map((p) => p.folderName),
  };
}
