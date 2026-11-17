import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { COLUMNS, type Column } from '@/config';
import { getDb, schema } from '@/db';
import { jsonError, readJson, requireSameOrigin } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Ручная фиксация карточки. Файловая система остаётся источником истины —
 * пин лишь переопределяет показ и пишется в аудит переходов.
 */
export async function POST(request: Request) {
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  const body = await readJson<{ key?: string; column?: string | null }>(request);
  if (!body) return jsonError('некорректный запрос', 400);
  if (!body.key) return jsonError('key обязателен', 400);

  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.key, body.key)).get();
  if (!project) return jsonError('проект не найден', 404);

  const target = body.column ?? null;
  if (target !== null && !(COLUMNS as readonly string[]).includes(target)) {
    return jsonError('неизвестная колонка', 400);
  }
  const column = target as Column | null;

  const now = new Date();
  db.update(schema.projects)
    .set({
      isPinned: column !== null,
      pinnedColumn: column,
      pinnedAt: column !== null ? now : null,
      stageSince: now,
      updatedAt: now,
    })
    .where(eq(schema.projects.key, body.key))
    .run();

  db.insert(schema.stageEvents)
    .values({
      projectKey: body.key,
      fromColumn: project.isPinned && project.pinnedColumn ? project.pinnedColumn : project.column,
      toColumn: column ?? project.column,
      reason: column !== null ? 'pin' : 'unpin',
      // код перевода, как и у автоматических переходов, а не готовая фраза
      evidence: 'evidence.manual',
      createdAt: now,
    })
    .run();

  return NextResponse.json({ ok: true });
}
