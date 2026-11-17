import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { currentRound } from '@/checklist/round';
import type { Column, DeliveryKind, ScenePhase } from '@/config';
import { getDb, schema } from '@/db';
import { folderWebUrl } from '@/dropbox/webUrl';
import type { Localized } from '@/i18n/types';
import { errorMessage, jsonError } from '@/server/http';
import { deliveryPath, scenePath } from '@/server/paths';

export const dynamic = 'force-dynamic';

/** Разворот карточки. Тип экспортируется — клиент импортирует его, а не переписывает руками. */
export interface ProjectDetail {
  project: {
    key: string;
    title: string;
    folderName: string;
    path: string;
    webUrl: string | null;
    evidence: Localized;
    anomalies: Localized[];
    lastDeliveryAt: number | null;
    lastRenderAt: number | null;
    sizeBytes: number | null;
    /** круг правок, на котором проект сейчас */
    round: number;
  };
  scenes: Array<{
    path: string;
    webUrl: string | null;
    name: string;
    sceneNumber: string | null;
    isService: boolean;
    imageCount: number;
    exrCount: number;
    psdCount: number;
    psdFolder: string | null;
    psdStages: Array<{ name: string; imageCount: number }>;
    phase: ScenePhase;
    plannedTotal: number;
    plannedMissing: string[];
    plannedGroups: string[];
    versions: Array<{ name: string; imageCount: number }>;
    hasUnrecognizedFiles: boolean;
    /** сколько кадров отмечено «правки внесены» в текущем круге */
    checkDone: number;
  }>;
  deliveries: Array<{
    path: string;
    webUrl: string | null;
    folderName: string;
    kind: DeliveryKind | null;
    round: number | null;
    isJunk: boolean;
    fileCount: number;
    sentAt: number | null;
  }>;
  changes: Array<{
    id: number;
    target: string;
    kind: string;
    params?: Record<string, string | number>;
    times: number;
    fileAt: number | null;
    detectedAt: number;
    isSeen: boolean;
  }>;
  events: Array<{
    id: number;
    from: Column | null;
    to: Column;
    reason: string;
    at: number;
  }>;
}

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return jsonError('key обязателен', 400);

  try {
    const detail = buildDetail(key);
    return detail ? NextResponse.json(detail) : jsonError('проект не найден', 404);
  } catch (error) {
    return jsonError(errorMessage(error), 500);
  }
}

function buildDetail(key: string): ProjectDetail | null {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.key, key)).get();
  if (!project) return null;

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

  const round = currentRound(project.round, project.maxRound);
  const doneByScene = new Map<string, number>();
  for (const row of db
    .select()
    .from(schema.sceneChecks)
    .where(and(eq(schema.sceneChecks.projectKey, key), eq(schema.sceneChecks.round, round)))
    .all()) {
    if (row.isDone) doneByScene.set(row.sceneName, (doneByScene.get(row.sceneName) ?? 0) + 1);
  }

  scenes.sort((a, b) => {
    const an = a.sceneNumber ? parseInt(a.sceneNumber, 10) : 999;
    const bn = b.sceneNumber ? parseInt(b.sceneNumber, 10) : 999;
    return an - bn;
  });
  deliveries.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));

  return {
    project: {
      key: project.key,
      title: project.title,
      folderName: project.folderName,
      path: project.path,
      webUrl: folderWebUrl(project.path),
      evidence: { code: project.evidence, params: project.evidenceParams ?? undefined },
      anomalies: project.anomalies ?? [],
      lastDeliveryAt: project.lastDeliveryAt?.getTime() ?? null,
      lastRenderAt: project.lastRenderAt?.getTime() ?? null,
      sizeBytes: project.sizeBytes,
      round,
    },
    // Пути папок выводим из пути проекта — в БД их держать незачем,
    // а интерфейсу они нужны, чтобы открыть папку в проводнике.
    scenes: scenes.map((s) => {
      const p = scenePath(project.path, s.name);
      return {
        path: p,
        webUrl: folderWebUrl(p),
        name: s.name,
        sceneNumber: s.sceneNumber,
        isService: s.isService,
        imageCount: s.imageCount,
        exrCount: s.exrCount,
        psdCount: s.psdCount,
        psdFolder: s.psdFolder,
        psdStages: s.psdStages ?? [],
        phase: s.phase,
        plannedTotal: s.plannedTotal,
        plannedMissing: s.plannedMissing ?? [],
        plannedGroups: s.plannedGroups ?? [],
        versions: s.versions ?? [],
        hasUnrecognizedFiles: s.hasUnrecognizedFiles,
        checkDone: doneByScene.get(s.name) ?? 0,
      };
    }),
    deliveries: deliveries.map((d) => {
      const p = deliveryPath(project.path, d.folderName);
      return {
        path: p,
        webUrl: folderWebUrl(p),
        folderName: d.folderName,
        kind: d.kind,
        round: d.round,
        isJunk: d.isJunk,
        fileCount: d.fileCount,
        sentAt: d.sentAt?.getTime() ?? null,
      };
    }),
    changes: changes.map((c) => ({
      id: c.id,
      target: c.target,
      kind: c.kind,
      params: c.params ?? undefined,
      times: c.times,
      fileAt: c.fileAt?.getTime() ?? null,
      detectedAt: c.detectedAt.getTime(),
      isSeen: c.isSeen,
    })),
    events: events.map((e) => ({
      id: e.id,
      from: e.fromColumn,
      to: e.toColumn,
      reason: e.reason,
      at: e.createdAt.getTime(),
    })),
  };
}
