import { NextResponse } from 'next/server';
import { desc, eq, sql } from 'drizzle-orm';
import { COLUMNS, CONFIG, type Column } from '@/config';
import { getDb, schema } from '@/db';
import type { Localized } from '@/i18n/types';
import { syncOnce } from '@/sync/sync';

export const dynamic = 'force-dynamic';

export interface BoardCard {
  key: string;
  jobNumber: number | null;
  title: string;
  folderName: string;
  path: string;
  /** что показывать: закреплённая колонка, если карточка закреплена */
  column: Column;
  /** что насчитал скан на самом деле — расходится с column только под пином */
  actualColumn: Column;
  ball: string;
  deliveryKind: string | null;
  round: number | null;
  maxRound: number | null;
  evidence: Localized;
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
  daysInStage: number | null;
  daysSinceActivity: number | null;
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

export async function GET() {
  try {
    refreshIfStale();
    return NextResponse.json(buildBoard());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Скан по запросу доски, если данные устарели.
 *
 * Надёжнее фонового таймера: роут пересобирается на каждый запрос, поэтому здесь
 * всегда свежий код — таймер же держит модуль с момента старта сервера и в dev
 * молча крутит устаревшую логику. Плюс скан идёт только когда на доску кто-то
 * смотрит, а не круглосуточно.
 */
function refreshIfStale() {
  const db = getDb();
  const last = db
    .select({ startedAt: schema.scanRuns.startedAt, finishedAt: schema.scanRuns.finishedAt })
    .from(schema.scanRuns)
    .orderBy(desc(schema.scanRuns.id))
    .limit(1)
    .get();

  // У идущего скана finishedAt ещё null — считаем возраст от начала,
  // иначе каждый параллельный запрос впустую пытается запустить свой скан.
  const stamp = last?.finishedAt ?? last?.startedAt ?? null;
  const age = stamp ? Date.now() - stamp.getTime() : Number.POSITIVE_INFINITY;
  if (age < CONFIG.boardRefreshMs) return;

  try {
    syncOnce();
  } catch (error) {
    // «Скан уже идёт» — параллельный запрос успел раньше, отдаём что есть
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'Скан уже идёт') console.error('[tracker] скан при загрузке доски:', message);
  }
}

function buildBoard() {
  const db = getDb();
  const rows = db.select().from(schema.projects).all();

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
  const lastRun = db
    .select()
    .from(schema.scanRuns)
    .orderBy(desc(schema.scanRuns.id))
    .limit(1)
    .get();

  const cards: BoardCard[] = rows.map((r) => ({
    key: r.key,
    jobNumber: r.jobNumber,
    title: r.title,
    folderName: r.folderName,
    path: r.path,
    column: (r.isPinned && r.pinnedColumn ? r.pinnedColumn : r.column) as Column,
    actualColumn: r.column as Column,
    ball: r.ball,
    deliveryKind: r.deliveryKind,
    round: r.round,
    maxRound: r.maxRound,
    evidence: { code: r.evidence, params: r.evidenceParams ?? undefined },
    scenesTotal: r.scenesTotal,
    scenesRendered: r.scenesRendered,
    exrTotal: r.exrTotal,
    farmActive: r.farmActive,
    scenesRendering: r.scenesRendering,
    scenesConverted: r.scenesConverted,
    scenesPost: r.scenesPost,
    daysInStage: days(r.stageSince),
    daysSinceActivity: days(r.lastActivityAt),
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
    columns: COLUMNS,
    cards,
    thresholds: { warn: CONFIG.staleWarnDays, alert: CONFIG.staleAlertDays },
    lastScan: lastRun
      ? {
          at: lastRun.finishedAt?.getTime() ?? null,
          durationMs: lastRun.durationMs,
          projectCount: lastRun.projectCount,
        }
      : null,
  };
}
