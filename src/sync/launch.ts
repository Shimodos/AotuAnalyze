/**
 * Запуск скана отдельным процессом — единственный способ, которым сервер
 * сканирует диск.
 *
 * Именно отдельный процесс, а не вызов в этом: обход и better-sqlite3
 * синхронные, и пока скан идёт, сервер не отвечает вообще ни на что. На
 * здоровом диске это полсекунды, на спотыкающемся USB мы видели 38 минут.
 * Отдельный процесс заодно всегда несёт свежий код — в dev ничего не
 * «залипает» с момента старта сервера.
 *
 * Запись в scan_runs создаёт РОДИТЕЛЬ, до spawn, и передаёт её id ребёнку.
 * Так «скан идёт» видно сразу всем — доске, кнопке, второму процессу, —
 * без общего состояния в памяти, которое между роутами Next не делится.
 * Если ребёнок не стартовал или упал, запись закрывается с ошибкой по
 * событию exit, чтобы не висеть «идущей» до таймаута.
 *
 * Дочерний процесс — тот же `npm run scan`, что запускают руками: база
 * рассчитана на двух писателей (см. busy_timeout в db/index.ts).
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { CONFIG } from '@/config';
import { getDb, schema } from '@/db';
import { isConnected } from '@/dropbox/tokens';
import { findRunningScan } from './sync';

export type LaunchResult = 'started' | 'running' | 'fresh' | 'failed' | 'not-connected';

/**
 * Скан, если данные устарели. Возвращает, что произошло, — вызывающему
 * обычно всё равно, но кнопке в UI полезно отличать «уже идёт» от «запущен».
 *
 * Медленный или упавший скан — признак, что диску плохо. Следующий не
 * раньше чем через час: иначе мы сами не даём Dropbox доиндексировать папку,
 * а он — нам досканировать, и оба крутятся на одном USB-диске до бесконечности.
 */
export function scanIfStale(): LaunchResult {
  if (findRunningScan()) return 'running';

  const last = getDb()
    .select({
      finishedAt: schema.scanRuns.finishedAt,
      durationMs: schema.scanRuns.durationMs,
      error: schema.scanRuns.error,
    })
    .from(schema.scanRuns)
    .orderBy(desc(schema.scanRuns.id))
    .limit(1)
    .get();

  const troubled = Boolean(last?.error) || (last?.durationMs ?? 0) > CONFIG.slowScanMs;
  const interval = troubled ? CONFIG.boardRefreshSlowMs : CONFIG.boardRefreshMs;
  const age = last?.finishedAt ? Date.now() - last.finishedAt.getTime() : Number.POSITIVE_INFINITY;
  if (age < interval) return 'fresh';

  return startBackgroundScan();
}

/** Закрыть запись с ошибкой, если ребёнок так и не закрыл её сам */
function closeRunIfOpen(runId: number, error: string) {
  getDb()
    .update(schema.scanRuns)
    .set({ finishedAt: new Date(), error })
    .where(and(eq(schema.scanRuns.id, runId), isNull(schema.scanRuns.finishedAt)))
    .run();
}

/**
 * Скан прямо сейчас, без проверки свежести — кнопка «Сканувати».
 * Параллельный второй обход того же диска ничего не ускорит, поэтому
 * идущий скан не дублируем.
 */
export function startBackgroundScan(options: { withSizes?: boolean } = {}): LaunchResult {
  if (findRunningScan()) return 'running';

  // Пока Dropbox не подключён, сканировать нечем: данные идут из API. Раньше
  // скан в этом случае молча шёл по диску — ровно та нагрузка, от которой
  // уходили, причём на свежей установке, где её никто не ждёт. Обход диска
  // остался только явным: VIARDE_SOURCE=disk или подсчёт веса проектов.
  if (CONFIG.source === 'api' && !options.withSizes && !isConnected()) return 'not-connected';

  const db = getDb();
  const [run] = db
    .insert(schema.scanRuns)
    .values({ startedAt: new Date(), withSizes: options.withSizes ?? false })
    .returning({ id: schema.scanRuns.id })
    .all();

  // tsx подключаем загрузчиком (--import), а не запускаем его CLI. CLI сам
  // порождает ещё один процесс node, а наш дочерний процесс отвязан от консоли
  // (detached) — и Windows выдаёт внуку новое консольное окно: на экране при
  // каждом скане всплывал терминал. С загрузчиком процесс один, окна нет.
  // «tsx» резолвится от cwd, то есть из node_modules проекта.
  //
  // В собранной программе (scripts/pack.mjs) исходников и tsx нет: скан собран
  // в один файл, путь к нему передаёт запускающий скрипт в VIARDE_SCAN_SCRIPT.
  const cwd = process.cwd();
  const packed = process.env.VIARDE_SCAN_SCRIPT;
  const args = packed
    ? [packed, '--quiet', `--run=${run.id}`]
    : ['--import', 'tsx', path.join('scripts', 'scan.ts'), '--quiet', `--run=${run.id}`];
  if (options.withSizes) args.push('--sizes');

  try {
    const child = spawn(process.execPath, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => closeRunIfOpen(run.id, `не удалось запустить: ${error.message}`));
    child.on('exit', (code) => {
      if (code !== 0) closeRunIfOpen(run.id, `процесс завершился с кодом ${code ?? '?'}`);
    });
    child.unref();
    return 'started';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    closeRunIfOpen(run.id, message);
    console.error('[tracker] не удалось запустить фоновый скан:', message);
    return 'failed';
  }
}
