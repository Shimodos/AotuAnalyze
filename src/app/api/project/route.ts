import * as nodePath from 'node:path';
import { folderWebUrl } from '@/dropbox/webUrl';
import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';

export const dynamic = 'force-dynamic';

/** Разворот карточки: сцены, отгрузки, история переходов, аномалии */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key обязателен' }, { status: 400 });

  try {
    return buildDetail(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function buildDetail(key: string) {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.key, key)).get();
  if (!project) return NextResponse.json({ error: 'проект не найден' }, { status: 404 });

  const scenes = db.select().from(schema.scenes).where(eq(schema.scenes.projectKey, key)).all();
  const deliveries = db
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.projectKey, key))
    .all();
  const changes = db
    .select()
    .from(schema.changes)
    .where(eq(schema.changes.projectKey, key))
    .orderBy(desc(schema.changes.id))
    .limit(40)
    .all();

  const events = db
    .select()
    .from(schema.stageEvents)
    .where(eq(schema.stageEvents.projectKey, key))
    .orderBy(desc(schema.stageEvents.id))
    .limit(20)
    .all();

  scenes.sort((a, b) => {
    const an = a.sceneNumber ? parseInt(a.sceneNumber, 10) : 999;
    const bn = b.sceneNumber ? parseInt(b.sceneNumber, 10) : 999;
    return an - bn;
  });
  deliveries.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));

  return NextResponse.json({
    project: {
      key: project.key,
      title: project.title,
      folderName: project.folderName,
      path: project.path,
      webUrl: folderWebUrl(project.path),
      evidence: { code: project.evidence, params: project.evidenceParams ?? undefined },
      anomalies: project.anomalies ?? [],
      missingFolders: project.missingFolders ?? [],
      lastDeliveryAt: project.lastDeliveryAt?.getTime() ?? null,
      lastRenderAt: project.lastRenderAt?.getTime() ?? null,
      sizeBytes: project.sizeBytes,
    },
    // Пути папок выводим из пути проекта — в БД их держать незачем,
    // а интерфейсу они нужны, чтобы открыть папку в проводнике.
    scenes: scenes.map((s) => ({
      path: nodePath.win32.join(project.path, '04_JPG', s.name),
      webUrl: folderWebUrl(nodePath.win32.join(project.path, '04_JPG', s.name)),
      name: s.name,
      sceneNumber: s.sceneNumber,
      skus: s.skus ?? [],
      isService: s.isService,
      imageCount: s.imageCount,
      exrCount: s.exrCount,
      psdCount: s.psdCount,
      psdFolder: s.psdFolder,
      psdStages: s.psdStages ?? [],
      phase: s.phase,
      plannedTotal: s.plannedTotal,
      plannedMatched: s.plannedMatched,
      plannedMissing: s.plannedMissing ?? [],
      plannedGroups: s.plannedGroups ?? [],
      lastExrAt: s.lastExrAt?.getTime() ?? null,
      versions: s.versions ?? [],
      lastImageAt: s.lastImageAt?.getTime() ?? null,
      hasUnrecognizedFiles: s.hasUnrecognizedFiles,
    })),
    deliveries: deliveries.map((d) => ({
      path: nodePath.win32.join(project.path, '05_Outbox', d.folderName),
      webUrl: folderWebUrl(nodePath.win32.join(project.path, '05_Outbox', d.folderName)),
      folderName: d.folderName,
      kind: d.kind,
      round: d.round,
      isJunk: d.isJunk,
      fileCount: d.fileCount,
      sentAt: d.sentAt?.getTime() ?? null,
    })),
    changes: changes.map((c) => ({
      area: c.area,
      target: c.target,
      kind: c.kind,
      params: c.params ?? undefined,
      times: c.times,
      fileAt: c.fileAt?.getTime() ?? null,
      detectedAt: c.detectedAt.getTime(),
      isSeen: c.isSeen,
    })),
    events: events.map((e) => ({
      from: e.fromColumn,
      to: e.toColumn,
      reason: e.reason,
      evidence: e.evidence ? { code: e.evidence, params: e.evidenceParams ?? undefined } : null,
      at: e.createdAt.getTime(),
    })),
  });
}
