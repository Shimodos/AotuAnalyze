import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { COLUMNS, type Column } from '@/config';
import { getDb, schema } from '@/db';

export const dynamic = 'force-dynamic';

/**
 * Ручная фиксация карточки. Файловая система остаётся источником истины —
 * пин лишь переопределяет показ и пишется в аудит переходов.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { key?: string; column?: string | null };
  if (!body.key) return NextResponse.json({ error: 'key обязателен' }, { status: 400 });

  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.key, body.key)).get();
  if (!project) return NextResponse.json({ error: 'проект не найден' }, { status: 404 });

  const target = body.column ?? null;
  if (target !== null && !(COLUMNS as readonly string[]).includes(target)) {
    return NextResponse.json({ error: 'неизвестная колонка' }, { status: 400 });
  }

  const now = new Date();
  db.update(schema.projects)
    .set({
      isPinned: target !== null,
      pinnedColumn: target,
      pinnedAt: target !== null ? now : null,
      stageSince: now,
      updatedAt: now,
    })
    .where(eq(schema.projects.key, body.key))
    .run();

  db.insert(schema.stageEvents)
    .values({
      projectKey: body.key,
      fromColumn: project.isPinned && project.pinnedColumn ? project.pinnedColumn : project.column,
      toColumn: (target ?? project.column) as Column,
      reason: target !== null ? 'pin' : 'unpin',
      evidence: 'ручная фиксация в UI',
      createdAt: now,
    })
    .run();

  return NextResponse.json({ ok: true });
}
