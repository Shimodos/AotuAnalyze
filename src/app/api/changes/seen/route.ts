import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';

export const dynamic = 'force-dynamic';

/** Пометить изменения проекта просмотренными — иначе счётчик будет вечным */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { key?: string } | null;
  if (!body?.key) return NextResponse.json({ error: 'key обязателен' }, { status: 400 });

  const db = getDb();
  db.update(schema.changes)
    .set({ isSeen: true })
    .where(and(eq(schema.changes.projectKey, body.key), eq(schema.changes.isSeen, false)))
    .run();

  return NextResponse.json({ ok: true });
}
