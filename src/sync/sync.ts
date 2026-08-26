/**
 * Скан -> БД. Здесь появляется то, чего нет в файловой системе: история переходов.
 */

import { eq } from 'drizzle-orm';
import { CONFIG, type Column } from '@/config';
import { getDb, schema } from '@/db';
import { scanAll, type ScannedProject } from '@/scanner/scan';
import { computeStage } from '@/scanner/stage';
import { diffDeliveries, diffScenes } from './diff';
import { recordChange } from './record';

export interface SyncResult {
  projectCount: number;
  durationMs: number;
  transitions: Array<{ key: string; title: string; from: Column | null; to: Column }>;
  /** карточки, с которых пин снялся сам — пришла новая отгрузка */
  released: Array<{ key: string; title: string; to: Column }>;
  /** сколько изменений внутри проектов зафиксировано за скан */
  changeCount: number;
  settling: string[];
}

/**
 * Обложка карточки — самый свежий рендер из 04_JPG.
 *
 * Если 04_JPG пуста, берём самую свежую картинку из отгрузок. На завершённых
 * проектах студия вычищает промежуточные рендеры (04_JPG и 04_EXR), оставляя
 * только 05_Outbox — без этого запасного источника 17 из 29 карточек остаются
 * без превью, хотя отгруженные картинки лежат на диске.
 */
function pickCover(project: ScannedProject): string | null {
  let best: { at: number; path: string } | null = null;
  for (const s of project.scenes) {
    if (!s.coverPath || !s.lastImageAt) continue;
    const at = s.lastImageAt.getTime();
    if (!best || at > best.at) best = { at, path: s.coverPath };
  }
  if (best) return best.path;

  for (const d of project.deliveries) {
    if (d.isJunk || !d.coverPath || !d.coverAt) continue;
    const at = d.coverAt.getTime();
    if (!best || at > best.at) best = { at, path: d.coverPath };
  }
  return best?.path ?? null;
}

/**
 * Скан синхронный и держит транзакцию на запись. Если ручной запуск из UI
 * совпадёт с фоновым тиком, второй должен отступить, а не биться за блокировку.
 */
let scanInProgress = false;

export function isScanInProgress(): boolean {
  return scanInProgress;
}

export function syncOnce(options: { root?: string; withSizes?: boolean } = {}): SyncResult {
  if (scanInProgress) throw new Error('Скан уже идёт');
  scanInProgress = true;
  try {
    return runSync(options);
  } finally {
    scanInProgress = false;
  }
}

function runSync(options: { root?: string; withSizes?: boolean }): SyncResult {
  const db = getDb();
  const startedAt = new Date();
  const scanned = scanAll(options.root ?? CONFIG.root, options.withSizes ?? false);

  const [run] = db
    .insert(schema.scanRuns)
    .values({ startedAt, withSizes: options.withSizes ?? false })
    .returning({ id: schema.scanRuns.id })
    .all();

  const transitions: SyncResult['transitions'] = [];
  const released: SyncResult['released'] = [];
  let changeCount = 0;
  const settling: string[] = [];
  const now = new Date();

  db.transaction((tx) => {
    for (const project of scanned) {
      const stage = computeStage(project, now);
      const existing = tx
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.key, project.key))
        .get();

      let stageSince = existing?.stageSince ?? stage.lastActivityAt ?? now;
      const previousColumn = (existing?.column ?? null) as Column | null;

      if (stage.isSettling) settling.push(project.folderName);

      // ── Ручное закрепление
      let isPinned = existing?.isPinned ?? false;
      let pinnedColumn = existing?.pinnedColumn ?? null;
      let pinnedAt = existing?.pinnedAt ?? null;

      // Новая отгрузка после закрепления — реальность ушла вперёд однозначно:
      // папка собрана в Outbox, значит ссылка у клиента. Пин снимаем сами,
      // иначе карточка будет врать до тех пор, пока кто-то о ней не вспомнит.
      if (isPinned && pinnedAt && stage.lastDeliveryAt && stage.lastDeliveryAt > pinnedAt) {
        tx.insert(schema.stageEvents)
          .values({
            projectKey: project.key,
            fromColumn: pinnedColumn,
            toColumn: stage.column,
            reason: 'auto-unpin',
            evidence: 'evidence.newDelivery',
            evidenceParams: { source: stage.evidence.code },
            createdAt: now,
          })
          .run();
        isPinned = false;
        pinnedColumn = null;
        pinnedAt = null;
        stageSince = stage.lastDeliveryAt;
        released.push({ key: project.key, title: project.title, to: stage.column });
      }

      // Переход фиксируем только когда он устоялся: пока рендер пишет файлы,
      // карточка показывается, но история не засоряется промежуточными состояниями.
      const changed = previousColumn !== null && previousColumn !== stage.column;
      const isNew = existing === undefined;

      if ((changed || isNew) && !stage.isSettling) {
        // У закреплённой карточки счётчик идёт от момента закрепления:
        // переход случился «под пином», показывать его дни было бы враньём.
        if (!isPinned) stageSince = stage.lastActivityAt ?? now;
        tx.insert(schema.stageEvents)
          .values({
            projectKey: project.key,
            fromColumn: previousColumn,
            toColumn: stage.column,
            reason: 'auto',
            evidence: stage.evidence.code,
            evidenceParams: stage.evidence.params ?? null,
            createdAt: now,
          })
          .run();
        if (changed) {
          transitions.push({
            key: project.key,
            title: project.title,
            from: previousColumn,
            to: stage.column,
          });
        }
      }

      const values = {
        key: project.key,
        folderName: project.folderName,
        path: project.path,
        jobNumber: project.jobNumber,
        title: project.title,
        column: stage.column,
        ball: stage.ball,
        deliveryKind: stage.deliveryKind,
        round: stage.round,
        maxRound: stage.maxRound,
        evidence: stage.evidence.code,
        evidenceParams: stage.evidence.params ?? null,
        stageSince,
        lastActivityAt: stage.lastActivityAt,
        lastDeliveryAt: stage.lastDeliveryAt,
        lastRenderAt: stage.lastRenderAt,
        scenesTotal: stage.scenesTotal,
        scenesRendered: stage.scenesRendered,
        exrTotal: stage.exrTotal,
        lastExrAt: stage.lastExrAt,
        farmActive: stage.farmActive,
        psdTotal: stage.psdTotal,
        lastPsdAt: stage.lastPsdAt,
        scenesRendering: stage.scenesRendering,
        scenesConverted: stage.scenesConverted,
        scenesPost: stage.scenesPost,
        isSettling: stage.isSettling,
        isArchived: stage.isArchived,
        hasClientFeedback: stage.hasClientFeedback,
        hasStandardStructure: project.hasStandardStructure,
        isPinned,
        pinnedColumn,
        pinnedAt,
        coverPath: pickCover(project),
        missingFolders: project.missingFolders,
        anomalies: project.anomalies,
        // размер обновляем только когда его реально считали
        ...(project.sizeBytes !== null ? { sizeBytes: project.sizeBytes } : {}),
        updatedAt: now,
      };

      tx.insert(schema.projects)
        .values(values)
        .onConflictDoUpdate({ target: schema.projects.key, set: values })
        .run();

      // Разницу считаем до удаления строк. Для нового проекта журнал не пишем:
      // иначе первый скан выдал бы «изменение» на каждую существующую папку.
      if (!isNew) {
        const previousScenes = tx
          .select()
          .from(schema.scenes)
          .where(eq(schema.scenes.projectKey, project.key))
          .all();
        const previousDeliveries = tx
          .select()
          .from(schema.deliveries)
          .where(eq(schema.deliveries.projectKey, project.key))
          .all();

        const detected = [
          ...diffScenes(previousScenes, project.scenes),
          ...diffDeliveries(previousDeliveries, project.deliveries),
        ];

        for (const change of detected) recordChange(tx, project.key, change, now);
        changeCount += detected.length;
      }

      // сцены и отгрузки — полная замена, они дёшевы и всегда отражают диск
      tx.delete(schema.scenes).where(eq(schema.scenes.projectKey, project.key)).run();
      for (const s of project.scenes) {
        tx.insert(schema.scenes)
          .values({
            id: `${project.key}::${s.name}`,
            projectKey: project.key,
            name: s.name,
            skus: s.skus,
            sceneNumber: s.sceneNumber,
            isService: s.isService,
            imageCount: s.imageCount,
            exrCount: s.exrCount,
            lastExrAt: s.lastExrAt,
            psdCount: s.psdCount,
            lastPsdAt: s.lastPsdAt,
            psdFolder: s.psdFolder,
            phase: s.phase,
            versions: s.versions,
            maxVersion: s.maxVersion,
            lastImageAt: s.lastImageAt,
            coverPath: s.coverPath,
            hasUnrecognizedFiles: s.hasUnrecognizedFiles,
          })
          .run();
      }

      tx.delete(schema.deliveries).where(eq(schema.deliveries.projectKey, project.key)).run();
      for (const d of project.deliveries) {
        tx.insert(schema.deliveries)
          .values({
            id: `${project.key}::${d.folderName}`,
            projectKey: project.key,
            folderName: d.folderName,
            kind: d.kind,
            round: d.round,
            isJunk: d.isJunk,
            fileCount: d.fileCount,
            sentAt: d.sentAt,
          })
          .run();
      }
    }
  });

  const durationMs = Date.now() - startedAt.getTime();

  db.update(schema.scanRuns)
    .set({
      finishedAt: new Date(),
      projectCount: scanned.length,
      transitionCount: transitions.length,
      durationMs,
    })
    .where(eq(schema.scanRuns.id, run.id))
    .run();

  return { projectCount: scanned.length, durationMs, transitions, released, changeCount, settling };
}
