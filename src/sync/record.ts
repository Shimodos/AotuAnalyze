/**
 * Запись изменения в журнал со схлопыванием повторов.
 *
 * Рендер-ферма кладёт файлы по одному в течение часов. Без схлопывания
 * каждый скан порождал бы новую строку «EXR перезаписано», и разворот карточки
 * превращался бы в ленту из десятка одинаковых записей об одном и том же процессе.
 *
 * Схлопываем только непросмотренные: как только человек их увидел, следующее
 * событие — уже новая новость, а не продолжение старой.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@/db';
import type { DetectedChange } from './diff';

type Tx = Parameters<Parameters<ReturnType<typeof import('@/db').getDb>['transaction']>[0]>[0];

/** Суммируем прибавку, итог берём из свежего события */
function mergeParams(
  before: Record<string, string | number> | null,
  now: Record<string, string | number> | undefined,
): Record<string, string | number> | null {
  if (!before) return now ?? null;
  if (!now) return before;

  const merged: Record<string, string | number> = { ...before, ...now };
  if (typeof before.n === 'number' && typeof now.n === 'number') merged.n = before.n + now.n;
  return merged;
}

export function recordChange(
  tx: Tx,
  projectKey: string,
  change: DetectedChange,
  now: Date,
): void {
  const existing = tx
    .select()
    .from(schema.changes)
    .where(
      and(
        eq(schema.changes.projectKey, projectKey),
        eq(schema.changes.target, change.target),
        eq(schema.changes.kind, change.kind),
        eq(schema.changes.isSeen, false),
      ),
    )
    .get();

  if (existing) {
    tx.update(schema.changes)
      .set({
        params: mergeParams(existing.params ?? null, change.params),
        times: existing.times + 1,
        fileAt: change.fileAt ?? existing.fileAt,
        detectedAt: now,
      })
      .where(eq(schema.changes.id, existing.id))
      .run();
    return;
  }

  tx.insert(schema.changes)
    .values({
      projectKey,
      area: change.area,
      target: change.target,
      kind: change.kind,
      params: change.params ?? null,
      times: 1,
      fileAt: change.fileAt,
      detectedAt: now,
      isSeen: false,
    })
    .run();
}
