/**
 * Вычисление стадии проекта.
 *
 * Отличие от модели PROJECT.md §3: стадия считается по СВЕЖЕСТИ последнего события,
 * а не по максимальному весу за всю историю.
 *
 * Почему: правило «максимум + монотонность вперёд» насыщается на FINAL и больше
 * никогда не отпускает карточку. На реальных данных Kraus_214 отгрузил Fast Preview
 * 31.07, после чего с 19.08 пошли новые рендеры — «максимум» это скрывает.
 *
 * Модель двухосевая:
 *   ось 1 — этап работы (моделинг / визуализация)
 *   ось 2 — у кого мяч (у нас / у клиента)
 * Колонка доски выводится из обеих.
 */

import { CONFIG, type Ball, type Column, type DeliveryKind } from '@/config';
import type { Localized } from '@/i18n/types';
import type { ScannedProject } from './scan';

export interface StageResult {
  column: Column;
  ball: Ball;
  deliveryKind: DeliveryKind | null;
  /** круг правок текущего вида отгрузки */
  round: number | null;
  /** максимальный круг за всю историю проекта */
  maxRound: number | null;
  /** основание стадии: код перевода и подстановки, фраза собирается на клиенте */
  evidence: Localized;
  lastDeliveryAt: Date | null;
  lastRenderAt: Date | null;
  lastActivityAt: Date | null;
  scenesTotal: number;
  /** сцены, где уже есть готовые JPG */
  scenesRendered: number;
  /** сырых EXR по всем сценам — признак того, что ферма считает */
  exrTotal: number;
  /** дата самого свежего EXR, отдельно от JPG */
  lastExrAt: Date | null;
  psdTotal: number;
  lastPsdAt: Date | null;
  /** ферма пишет EXR свежее всего остального — рендер идёт прямо сейчас */
  farmActive: boolean;
  /** разбивка сцен по этапам — проект бывает в нескольких сразу */
  scenesRendering: number;
  scenesConverted: number;
  scenesPost: number;
  /** кадров запланировано таблицей клиента и сколько из них уже есть */
  plannedTotal: number;
  /** сколько картинок лежит в 04_JPG у сцен с планом */
  plannedDone: number;
  /** сколько кадров совпало с планом по именам файлов */
  plannedByName: number;
  /** внутри проекта что-то менялось прямо сейчас — переход ещё не устоялся */
  isSettling: boolean;
  /** Финал, который давно никто не трогал */
  isArchived: boolean;
  /** есть сигналы правок от клиента в 01_Clients */
  hasClientFeedback: boolean;
}

/** Отгрузка считается настоящей, если она непустая, не мусор и вид распознан */
function validDeliveries(project: ScannedProject) {
  return project.deliveries.filter(
    (d): d is typeof d & { kind: DeliveryKind; sentAt: Date } =>
      !d.isJunk && d.kind !== null && d.sentAt !== null,
  );
}

export function computeStage(project: ScannedProject, now: Date = new Date()): StageResult {
  const realScenes = project.scenes.filter((s) => !s.isService);
  const scenesTotal = realScenes.length;
  const scenesRendered = realScenes.filter((s) => s.imageCount > 0).length;

  const exrTotal = realScenes.reduce((sum, s) => sum + s.exrCount, 0);

  const exrTimes = realScenes.map((s) => s.lastExrAt).filter((d): d is Date => d !== null);
  const lastExrAt = exrTimes.length
    ? new Date(Math.max(...exrTimes.map((d) => d.getTime())))
    : null;

  const psdTotal = realScenes.reduce((sum, s) => sum + s.psdCount, 0);
  const psdTimes = realScenes.map((s) => s.lastPsdAt).filter((d): d is Date => d !== null);
  const lastPsdAt = psdTimes.length
    ? new Date(Math.max(...psdTimes.map((d) => d.getTime())))
    : null;

  const plannedTotal = realScenes.reduce((sum, s) => sum + s.plannedTotal, 0);
  // «Сделано» — это сколько картинок реально лежит в 04_JPG у сцен, где план
  // задан. Сверка по именам файлов остаётся, но отдельно: она отвечает на другой
  // вопрос — каких именно кадров не хватает.
  const plannedDone = realScenes
    .filter((s) => s.plannedTotal > 0)
    .reduce((sum, s) => sum + s.imageCount, 0);
  const plannedByName = realScenes.reduce((sum, s) => sum + s.plannedMatched, 0);

  const scenesRendering = realScenes.filter((s) => s.phase === 'RENDERING').length;
  const scenesConverted = realScenes.filter((s) => s.phase === 'CONVERTED').length;
  const scenesPost = realScenes.filter((s) => s.phase === 'POST').length;

  // Свежий EXR — это работа фермы, то есть активность проекта наравне с JPG.
  // Без этого проект, где ферма считает вторые сутки, числился бы застоявшимся,
  // а карточка не возвращалась бы из колонки клиента в «Визуализацию».
  // ВАЖНО: PSD сюда не входит.
  // Новый EXR — ферма выдала кадры, новый JPG — человек сконвертировал:
  // и то и другое означает, что работа возобновилась. Сохранение PSD куда
  // слабее: файл трогают при открытии в Photoshop и при обновлении метаданных
  // Bridge. Если считать это возобновлением работы, проект, сданный полгода
  // назад, воскресает из-за пересохранённого файла — проверено на 13 проектах.
  const renderTimes = [
    ...realScenes.map((s) => s.lastImageAt),
    ...realScenes.map((s) => s.lastExrAt),
  ].filter((d): d is Date => d !== null);
  const lastRenderAt = renderTimes.length
    ? new Date(Math.max(...renderTimes.map((d) => d.getTime())))
    : null;

  const valid = validDeliveries(project);
  let lastDelivery: (typeof valid)[number] | null = null;
  for (const d of valid) {
    if (!lastDelivery || d.sentAt > lastDelivery.sentAt) lastDelivery = d;
  }
  const lastDeliveryAt = lastDelivery?.sentAt ?? null;

  // В активность PSD входит: проект, где идёт постобработка, не застоявшийся
  const activity = [lastDeliveryAt, lastRenderAt, lastPsdAt].filter((d): d is Date => d !== null);
  const lastActivityAt = activity.length
    ? new Date(Math.max(...activity.map((d) => d.getTime())))
    : null;

  // ── Кто держит мяч.
  // Ничья трактуется в пользу отгрузки: сначала рендерят, потом отправляют,
  // поэтому одинаковая дата означает «собрали и отдали».
  const clientHasBall =
    lastDelivery !== null && (lastRenderAt === null || lastDelivery.sentAt >= lastRenderAt);

  // Работа фермы отслеживается отдельно от колонки: рендер может идти
  // параллельно с постобработкой, и терять этот факт нельзя.
  const freshestWork = Math.max(
    0,
    ...realScenes.map((s) => (s.lastImageAt ? s.lastImageAt.getTime() : 0)),
    ...realScenes.map((s) => (s.lastExrAt ? s.lastExrAt.getTime() : 0)),
    ...realScenes.map((s) => (s.lastPsdAt ? s.lastPsdAt.getTime() : 0)),
  );
  const farmActive = lastExrAt !== null && lastExrAt.getTime() >= freshestWork;

  let column: Column;
  let ball: Ball;
  let evidence: Localized;

  if (clientHasBall && lastDelivery) {
    ball = 'CLIENT';
    column = lastDelivery.kind;
    evidence = { code: 'evidence.outbox', params: { folder: lastDelivery.folderName } };
  } else if (scenesTotal > 0) {
    ball = 'US';
    // Отдельной колонки для постобработки нет: этап видно по отметке PSD
    // у каждой сцены и по разбивке на карточке.
    //
    // Любой из трёх следов работы означает, что моделинг позади: EXR — ферма
    // считала, JPG — сконвертировали, PSD — обрабатывают.
    column =
      scenesRendered > 0 || exrTotal > 0 || psdTotal > 0 ? 'RENDERING' : 'MODELING';

    const exrIsFresher =
      lastExrAt !== null &&
      (realScenes.every((s) => s.lastImageAt === null) ||
        lastExrAt.getTime() >
          Math.max(
            0,
            ...realScenes.map((s) => (s.lastImageAt ? s.lastImageAt.getTime() : 0)),
          ));

    const psdIsFreshest =
      lastPsdAt !== null && lastPsdAt.getTime() >= freshestWork;

    evidence = psdIsFreshest
      ? { code: 'evidence.psd', params: { psd: psdTotal, post: scenesPost, total: scenesTotal } }
      : exrIsFresher
      ? { code: 'evidence.exr', params: { exr: exrTotal, done: scenesRendered, total: scenesTotal } }
      : { code: 'evidence.scenes', params: { done: scenesRendered, total: scenesTotal } };
  } else if (project.missingFolders.includes('03_Models') === false) {
    ball = 'US';
    column = 'MODELING';
    evidence = { code: 'evidence.models' };
  } else {
    ball = 'US';
    column = 'NEW';
    evidence = { code: 'evidence.clients' };
  }

  // ── Круги правок.
  // Считаем по всем отгрузкам текущего вида, а не только по той, что решила стадию:
  // номер круга висит на Preview_08, а стадия может быть уже Prefinal.
  const currentKind = lastDelivery?.kind ?? null;
  const deliveriesOfKind = valid.filter((d) => d.kind === currentKind);
  const explicitRounds = deliveriesOfKind
    .filter((d) => d.round !== null)
    .map((d) => d.round as number);
  // Если номера проставлены — берём максимум. Если нумерации нет вообще
  // (папка называется просто Prefinal), круг равен числу отгрузок этого вида.
  const round = currentKind
    ? explicitRounds.length
      ? Math.max(...explicitRounds)
      : deliveriesOfKind.length || null
    : null;
  const allRounds = valid.filter((d) => d.round !== null).map((d) => d.round as number);

  const minutesSinceActivity = lastActivityAt
    ? (now.getTime() - lastActivityAt.getTime()) / 60_000
    : Number.POSITIVE_INFINITY;
  const daysSinceActivity = minutesSinceActivity / (60 * 24);

  return {
    column,
    ball,
    deliveryKind: currentKind,
    round,
    maxRound: allRounds.length ? Math.max(...allRounds) : null,
    evidence,
    lastDeliveryAt,
    lastRenderAt,
    lastActivityAt,
    scenesTotal,
    scenesRendered,
    exrTotal,
    lastExrAt,
    psdTotal,
    lastPsdAt,
    farmActive,
    scenesRendering,
    scenesConverted,
    scenesPost,
    plannedTotal,
    plannedDone,
    plannedByName,
    isSettling: minutesSinceActivity < CONFIG.debounceMinutes,
    isArchived: column === 'FINAL' && daysSinceActivity > CONFIG.archiveAfterDays,
    hasClientFeedback: project.clientFeedbackFolders.length > 0,
  };
}
