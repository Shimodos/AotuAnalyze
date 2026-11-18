import { NextResponse } from 'next/server';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import { COLUMNS, CONFIG, type Ball, type Column } from '@/config';
import { getDb, schema } from '@/db';
import { isConnected } from '@/dropbox/tokens';
import { folderWebUrl } from '@/dropbox/webUrl';
import { errorMessage, jsonError } from '@/server/http';
import { scanIfStale } from '@/sync/launch';
import { findRunningScan } from '@/sync/sync';

export const dynamic = 'force-dynamic';

export interface BoardCard {
  key: string;
  jobNumber: number | null;
  title: string;
  /** имя папки проекта — по нему ищет строка поиска на доске */
  folderName: string;
  path: string;
  /** ссылка на эту папку в веб-версии Dropbox */
  webUrl: string | null;
  /** что показывать: закреплённая колонка, если карточка закреплена */
  column: Column;
  /** что насчитал скан на самом деле — расходится с column только под пином */
  actualColumn: Column;
  ball: Ball;
  round: number | null;
  maxRound: number | null;
  scenesTotal: number;
  scenesRendered: number;
  /** сырых EXR — ферма считает прямо сейчас */
  exrTotal: number;
  /** ферма рендерит прямо сейчас, независимо от колонки */
  farmActive: boolean;
  /** разбивка сцен по этапам — проект бывает в нескольких сразу */
  scenesRendering: number;
  scenesConverted: number;
  scenesPost: number;
  /** план из таблицы клиента: сколько кадров нужно и сколько уже есть */
  plannedTotal: number;
  plannedDone: number;
  daysInStage: number | null;
  isSettling: boolean;
  isArchived: boolean;
  isPinned: boolean;
  hasClientFeedback: boolean;
  hasStandardStructure: boolean;
  anomalyCount: number;
  /** сколько изменений внутри проекта ещё не просмотрено */
  unseenChanges: number;
  hasCover: boolean;
}

function days(from: Date | null): number | null {
  if (!from) return null;
  return Math.floor((Date.now() - from.getTime()) / 86_400_000);
}

export interface BoardData {
  cards: BoardCard[];
  thresholds: { warn: number; alert: number };
  lastScan: { at: number | null; durationMs: number | null; projectCount: number | null } | null;
  /** скан идёт прямо сейчас — доска опрашивает чаще, кнопка заблокирована */
  scanning: boolean;
  /**
   * Данные приходят из Dropbox API и обновляются по сигналу об изменениях —
   * доске есть смысл опрашивать сервер часто, чтобы показать их без задержки
   */
  live: boolean;
}

/**
 * Доска отдаёт то, что есть, а если данные устарели — запускает скан в фоне
 * (см. sync/launch.ts). Свежие данные подхватит следующий опрос.
 */
export async function GET() {
  try {
    scanIfStale();
    return NextResponse.json(buildBoard());
  } catch (error) {
    return jsonError(errorMessage(error), 500);
  }
}

function buildBoard(): BoardData {
  const db = getDb();

  // Доска показывает только проекты из списка «Проєкти на дошці». Пока список
  // пуст (настройки ни разу не открывали) — показываем всё, как раньше.
  // Строку в projects не удаляем: история, пины и чеклисты проекта остаются,
  // и карточка вернётся, если галочку поставить обратно.
  const tracked = new Set(
    db.select({ key: schema.trackedProjects.key }).from(schema.trackedProjects).all().map((r) => r.key),
  );
  const rows = db
    .select()
    .from(schema.projects)
    .all()
    .filter((r) => tracked.size === 0 || tracked.has(r.key));

  // Одним запросом на всю доску, а не по проекту на карточку
  const unseen = new Map<string, number>();
  for (const row of db
    .select({ key: schema.changes.projectKey, n: sql<number>`count(*)` })
    .from(schema.changes)
    .where(eq(schema.changes.isSeen, false))
    .groupBy(schema.changes.projectKey)
    .all()) {
    unseen.set(row.key, Number(row.n));
  }
  // Последний завершённый: идущий скан теперь тоже лежит в scan_runs,
  // а подпись «последний скан» должна показывать реальные данные, а не пустоту
  const lastRun = db
    .select()
    .from(schema.scanRuns)
    .where(isNotNull(schema.scanRuns.finishedAt))
    .orderBy(desc(schema.scanRuns.id))
    .limit(1)
    .get();

  const cards: BoardCard[] = rows.map((r) => ({
    key: r.key,
    jobNumber: r.jobNumber,
    title: r.title,
    folderName: r.folderName,
    path: r.path,
    webUrl: folderWebUrl(r.path),
    column: r.isPinned && r.pinnedColumn ? r.pinnedColumn : r.column,
    actualColumn: r.column,
    ball: r.ball,
    round: r.round,
    maxRound: r.maxRound,
    scenesTotal: r.scenesTotal,
    scenesRendered: r.scenesRendered,
    exrTotal: r.exrTotal,
    farmActive: r.farmActive,
    scenesRendering: r.scenesRendering,
    scenesConverted: r.scenesConverted,
    scenesPost: r.scenesPost,
    plannedTotal: r.plannedTotal,
    plannedDone: r.plannedDone,
    daysInStage: days(r.stageSince),
    isSettling: r.isSettling,
    isArchived: r.isArchived,
    isPinned: r.isPinned,
    hasClientFeedback: r.hasClientFeedback,
    hasStandardStructure: r.hasStandardStructure,
    anomalyCount: (r.anomalies ?? []).length,
    unseenChanges: unseen.get(r.key) ?? 0,
    hasCover: Boolean(r.coverPath),
  }));

  cards.sort((a, b) => (b.jobNumber ?? 0) - (a.jobNumber ?? 0));

  return {
    cards,
    thresholds: { warn: CONFIG.staleWarnDays, alert: CONFIG.staleAlertDays },
    lastScan: lastRun
      ? {
          at: lastRun.finishedAt?.getTime() ?? null,
          durationMs: lastRun.durationMs,
          projectCount: lastRun.projectCount,
        }
      : null,
    scanning: findRunningScan() !== null,
    live: CONFIG.source === 'api' && process.env.VIARDE_WATCH !== 'off' && isConnected(),
  };
}
