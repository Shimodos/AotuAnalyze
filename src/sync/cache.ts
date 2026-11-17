/**
 * Кеш сканера в SQLite (таблица file_cache).
 *
 * Чтения идут сразу, записи копятся и уходят одной транзакцией после обхода:
 * за скан набирается пара сотен записей, и по одной их писать незачем.
 */

import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import type { ScanCache } from '@/scanner/cache';

export class SqliteCache implements ScanCache {
  private readonly pending = new Map<string, { stamp: string; value: string }>();

  get<T>(key: string, stamp: string): T | null {
    const row = getDb()
      .select({ stamp: schema.fileCache.stamp, value: schema.fileCache.value })
      .from(schema.fileCache)
      .where(eq(schema.fileCache.key, key))
      .get();
    if (!row || row.stamp !== stamp) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  set<T>(key: string, stamp: string, value: T): void {
    this.pending.set(key, { stamp, value: JSON.stringify(value) });
  }

  /** Записать накопленное. Вызывается один раз после обхода. */
  flush(): number {
    if (this.pending.size === 0) return 0;
    const db = getDb();
    const now = new Date();
    db.transaction((tx) => {
      for (const [key, { stamp, value }] of this.pending) {
        tx.insert(schema.fileCache)
          .values({ key, stamp, value, updatedAt: now })
          .onConflictDoUpdate({ target: schema.fileCache.key, set: { stamp, value, updatedAt: now } })
          .run();
      }
    });
    const n = this.pending.size;
    this.pending.clear();
    return n;
  }
}
