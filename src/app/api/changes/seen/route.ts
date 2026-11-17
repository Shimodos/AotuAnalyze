import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { jsonError, readJson, requireSameOrigin } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Пометить изменения проекта просмотренными — иначе счётчик будет вечным */
export async function POST(request: Request) {
  const denied = requireSameOrigin(request);
  if (denied) return denied;

  const body = await readJson<{ key?: string }>(request);
  if (!body?.key) return jsonError('key обязателен', 400);

  const db = getDb();
  db.update(schema.changes)
    .set({ isSeen: true })
    .where(and(eq(schema.changes.projectKey, body.key), eq(schema.changes.isSeen, false)))
    .run();

  return NextResponse.json({ ok: true });
}
