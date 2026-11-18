/**
 * Наблюдатель за изменениями в Dropbox (docs/PLAN-DROPBOX-API.md, этап 4).
 *
 * Вместо «сканировать раз в полчаса» — ждать, пока Dropbox сам скажет, что
 * что-то изменилось (files/list_folder/longpoll), и только тогда обновлять
 * индекс и запускать скан. Диск не участвует; пока изменений нет, вся
 * нагрузка — один висящий HTTP-запрос.
 *
 * Курсор у нас на весь корень командного пространства, поэтому longpoll
 * срабатывает и на чужие проекты. Отсев дешёвый: дельта применяется к индексу
 * здесь же, и скан запускается, только если затронут отслеживаемый проект.
 *
 * Сам скан по-прежнему идёт отдельным процессом (sync/launch.ts): там запись
 * в базу, история переходов и журнал изменений.
 */

import { CONFIG } from '@/config';
import { isConnected, readSetting } from '@/dropbox/tokens';
import { scanIfStale, startBackgroundScan } from '@/sync/launch';
import { syncRemoteShared } from './index';

const LONGPOLL_URL = 'https://notify.dropboxapi.com/2/files/list_folder/longpoll';

/** Сколько ждать изменений за один запрос, с. Допустимо 30–480. */
const LONGPOLL_TIMEOUT_S = 300;
/**
 * Dropbox отвечает позже заданного таймаута: к нему добавляется случайная
 * задержка (живой замер — 46 с при таймауте 30). Запас на неё и на сеть.
 */
const LONGPOLL_SLACK_MS = 120_000;
/**
 * Пауза после сигнала об изменении. Файлы приходят пачками — ферма кладёт
 * кадры по одному, отгрузку копируют папкой, — и без паузы каждая пачка
 * превращалась бы в десяток сканов подряд.
 */
const SETTLE_MS = 10_000;
/** Пауза после сбоя (нет сети, Dropbox недоступен), чтобы не крутиться вхолостую */
const ERROR_PAUSE_MS = 60_000;
/** Как часто проверять, не подключили ли Dropbox */
const IDLE_PAUSE_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function longpoll(cursor: string): Promise<{ changes: boolean; backoff?: number }> {
  // Без заголовка Authorization: эндпоинту достаточно курсора (проверено вживую)
  const res = await fetch(LONGPOLL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor, timeout: LONGPOLL_TIMEOUT_S }),
    signal: AbortSignal.timeout(LONGPOLL_TIMEOUT_S * 1000 + LONGPOLL_SLACK_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`longpoll: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as { changes: boolean; backoff?: number };
}

/** Запустить скан; если один уже идёт — дождаться и запустить ещё раз, чтобы не потерять изменение */
async function scanNow(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = startBackgroundScan();
    if (result !== 'running') return;
    await sleep(5_000);
  }
}

/**
 * Обновить индекс и, если затронут отслеживаемый проект, запустить скан.
 * Возвращает, сколько записей дельты пришло и сколько из них наши.
 */
async function catchUp(): Promise<{ entries: number; touched: number }> {
  const sync = await syncRemoteShared();
  const relevant = sync.touched.length > 0 || sync.loaded.length > 0;
  if (relevant) await scanNow();
  return { entries: sync.deltaEntries, touched: sync.touched.length + sync.loaded.length };
}

async function loop(): Promise<void> {
  // При старте догоняем то, что изменилось, пока сервер был выключен
  let needCatchUp = true;

  for (;;) {
    try {
      if (!isConnected()) {
        needCatchUp = true;
        await sleep(IDLE_PAUSE_MS);
        continue;
      }

      if (needCatchUp) {
        const { entries, touched } = await catchUp();
        if (entries > 0) {
          console.log(`[tracker] Dropbox: изменений ${entries}, в отслеживаемых проектах ${touched}`);
        }
        needCatchUp = false;
      }

      // Страховка вместо таймера: переход, который ждал, пока файлы «улягутся»
      // (CONFIG.debounceMinutes), фиксируется сканом и без новых изменений
      scanIfStale();

      const cursor = readSetting('remote.cursor');
      if (!cursor) {
        needCatchUp = true;
        continue;
      }

      const signal = await longpoll(cursor);
      if (signal.backoff) await sleep(signal.backoff * 1000);
      if (!signal.changes) continue;

      await sleep(SETTLE_MS);
      needCatchUp = true;
    } catch (error) {
      console.error('[tracker] наблюдатель Dropbox:', error instanceof Error ? error.message : error);
      needCatchUp = true;
      await sleep(ERROR_PAUSE_MS);
    }
  }
}

/**
 * Запустить наблюдатель один раз на процесс. Повторный вызов (горячая
 * перезагрузка модулей в dev) ничего не делает — иначе висело бы несколько
 * longpoll-запросов и каждый запускал бы свой скан.
 */
export function startWatcher(): boolean {
  if (CONFIG.source !== 'api') return false;
  const g = globalThis as typeof globalThis & { __viardeWatcher?: boolean };
  if (g.__viardeWatcher) return false;
  g.__viardeWatcher = true;
  void loop();
  return true;
}
