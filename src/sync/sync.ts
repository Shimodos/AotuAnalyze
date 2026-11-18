/**
 * Скан -> БД. Здесь появляется то, чего нет в файловой системе: история переходов.
 */

import { desc, eq, lt, sql } from 'drizzle-orm';
import { CONFIG, type Column } from '@/config';
import { getDb, schema } from '@/db';
import { syncRemote } from '@/remote';
import { scanFromIndex } from '@/remote/scan';
import { scanAll, type ScannedProject } from '@/scanner/scan';
import { computeStage } from '@/scanner/stage';
import { SqliteCache } from './cache';
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
function pickCover(project: ScannedProject): { path: string; at: Date } | null {
  let best: { at: Date; path: string } | null = null;
  for (const s of project.scenes) {
    if (!s.coverPath || !s.lastImageAt) continue;
    if (!best || s.lastImageAt > best.at) best = { at: s.lastImageAt, path: s.coverPath };
  }
  if (best) return best;

  for (const d of project.deliveries) {
    if (d.isJunk || !d.coverPath || !d.coverAt) continue;
    if (!best || d.coverAt > best.at) best = { at: d.coverAt, path: d.coverPath };
  }
  return best;
}

/**
 * Скан синхронный и держит транзакцию на запись. Второй вызов в том же
 * процессе должен отступить, а не биться за блокировку; про другие процессы
 * знает findRunningScan().
 */
let scanInProgress = false;

/**
 * Скан, который идёт прямо сейчас — в любом процессе, не только в этом.
 *
 * Флаг выше видит только свой процесс, а доска запускает скан отдельным
 * процессом, и CLI тоже пишет в ту же базу. Общий признак один: запись
 * в scan_runs без finishedAt. Слишком старую такую запись считаем мёртвой
 * (процесс убили), иначе она навсегда запретила бы новые сканы.
 */
export function findRunningScan(): { id: number; startedAt: Date } | null {
  const last = getDb()
    .select({
      id: schema.scanRuns.id,
      startedAt: schema.scanRuns.startedAt,
      finishedAt: schema.scanRuns.finishedAt,
    })
    .from(schema.scanRuns)
    .orderBy(desc(schema.scanRuns.id))
    .limit(1)
    .get();
  if (!last || last.finishedAt) return null;
  if (Date.now() - last.startedAt.getTime() > CONFIG.scanRunTimeoutMs) return null;
  return { id: last.id, startedAt: last.startedAt };
}

export interface SyncOptions {
  root?: string;
  withSizes?: boolean;
  /** запись в scan_runs уже создал тот, кто нас запустил (sync/launch.ts) */
  runId?: number;
  /** проекты уже просканированы снаружи (скан по индексу Dropbox) — диск не обходим */
  scanned?: ScannedProject[];
  /** когда на самом деле начался скан, если часть работы сделана до вызова */
  startedAt?: Date;
}

/**
 * Скан по индексу Dropbox: обновить индекс, просканировать его и записать
 * результат тем же путём, что и дисковый скан. Асинхронная часть — только
 * сеть; запись в базу остаётся синхронной и общей с обходом диска.
 */
export async function syncOnceFromIndex(options: SyncOptions = {}): Promise<SyncResult> {
  const db = getDb();
  const startedAt = new Date();
  const runId =
    options.runId ??
    db
      .insert(schema.scanRuns)
      .values({ startedAt, withSizes: false })
      .returning({ id: schema.scanRuns.id })
      .get().id;

  let scanned: ScannedProject[];
  try {
    await syncRemote();
    scanned = (await scanFromIndex(options.root ?? CONFIG.root)).projects;
  } catch (error) {
    // Сеть недоступна или Dropbox отказал. На диск молча не откатываемся:
    // это вернуло бы ту нагрузку, от которой уходили. Доска покажет прежние
    // данные, а запись о скане — причину.
    db.update(schema.scanRuns)
      .set({
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        error: error instanceof Error ? error.message : String(error),
      })
      .where(eq(schema.scanRuns.id, runId))
      .run();
    throw error;
  }

  return syncOnce({ ...options, runId, scanned, startedAt });
}

export function syncOnce(options: SyncOptions = {}): SyncResult {
  if (scanInProgress) throw new Error('Скан уже идёт');
  scanInProgress = true;
  try {
    return runSync(options);
  } finally {
    scanInProgress = false;
  }
}

function runSync(options: SyncOptions): SyncResult {
  const db = getDb();
  const startedAt = options.startedAt ?? new Date();

  // Запись создаём ДО обхода: пока он идёт, доска и второй процесс видят
  // startedAt без finishedAt и не запускают свой скан параллельно.
  // Фоновый запуск создаёт её ещё раньше — в родительском процессе.
  const run =
    options.runId !== undefined
      ? { id: options.runId }
      : db
          .insert(schema.scanRuns)
          .values({ startedAt, withSizes: options.withSizes ?? false })
          .returning({ id: schema.scanRuns.id })
          .get();

  // Кеш переживает процесс скана: сводки отгрузок и разобранные xlsx-планы
  // лежат в SQLite и считаются заново только когда источник изменился
  const cache = new SqliteCache();

  let scanned: ScannedProject[];
  try {
    scanned = options.scanned ?? scanAll(options.root ?? CONFIG.root, options.withSizes ?? false, cache);
  } catch (error) {
    // Упавший скан тоже закрываем: иначе запись висит «идущей», а доска
    // после диска, который отвалился, не сможет ни отступить, ни повторить.
    db.update(schema.scanRuns)
      .set({
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        error: error instanceof Error ? error.message : String(error),
      })
      .where(eq(schema.scanRuns.id, run.id))
      .run();
    throw error;
  }

  cache.flush();

  const transitions: SyncResult['transitions'] = [];
  const released: SyncResult['released'] = [];
  let changeCount = 0;
  const settling: string[] = [];
  const now = new Date();

  db.transaction((tx) => {
    // Все проекты одним запросом, а не по одному на каждый
    const existingByKey = new Map(
      tx.select().from(schema.projects).all().map((row) => [row.key, row] as const),
    );

    for (const project of scanned) {
      const stage = computeStage(project, now);
      const existing = existingByKey.get(project.key);

      let stageSince = existing?.stageSince ?? stage.lastActivityAt ?? now;
      const previousColumn: Column | null = existing?.column ?? null;

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

      const cover = pickCover(project);
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
        plannedTotal: stage.plannedTotal,
        plannedDone: stage.plannedDone,
        isSettling: stage.isSettling,
        isArchived: stage.isArchived,
        hasClientFeedback: stage.hasClientFeedback,
        hasStandardStructure: project.hasStandardStructure,
        isPinned,
        pinnedColumn,
        pinnedAt,
        coverPath: cover?.path ?? null,
        coverAt: cover?.at ?? null,
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

      // сцены и отгрузки — полная замена, они дёшевы и всегда отражают диск.
      // Вставляем пачкой: drizzle готовит statement на каждый вызов, и
      // по одной строке это в три раза дольше.
      tx.delete(schema.scenes).where(eq(schema.scenes.projectKey, project.key)).run();
      if (project.scenes.length > 0) {
        tx.insert(schema.scenes)
          .values(
            project.scenes.map((s) => ({
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
              psdStages: s.psdStages,
              phase: s.phase,
              plannedTotal: s.plannedTotal,
              plannedMatched: s.plannedMatched,
              plannedMissing: s.plannedMissing,
              plannedGroups: s.plannedGroups,
              versions: s.versions,
              lastImageAt: s.lastImageAt,
              coverPath: s.coverPath,
              hasUnrecognizedFiles: s.hasUnrecognizedFiles,
            })),
          )
          .run();
      }

      tx.delete(schema.deliveries).where(eq(schema.deliveries.projectKey, project.key)).run();
      if (project.deliveries.length > 0) {
        tx.insert(schema.deliveries)
          .values(
            project.deliveries.map((d) => ({
              id: `${project.key}::${d.folderName}`,
              projectKey: project.key,
              folderName: d.folderName,
              kind: d.kind,
              round: d.round,
              isJunk: d.isJunk,
              fileCount: d.fileCount,
              sentAt: d.sentAt,
            })),
          )
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

  // Старые записи о сканах убираем здесь же: отдельного планировщика нет,
  // а скан и так только что писал в эту таблицу
  db.delete(schema.scanRuns)
    .where(lt(schema.scanRuns.startedAt, new Date(Date.now() - CONFIG.scanRunKeepDays * 86_400_000)))
    .run();

  // Скан — главный писатель: полная замена сцен и отгрузок каждый раз.
  // Без чекпойнта WAL-файл только растёт (наблюдали 4 МБ при базе в 300 КБ).
  db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);

  return { projectCount: scanned.length, durationMs, transitions, released, changeCount, settling };
}
