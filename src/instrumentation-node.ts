/**
 * Фоновый скан по таймеру. Это и есть «карточки двигаются сами», когда на
 * доску никто не смотрит: иначе переход, случившийся ночью, попал бы в
 * историю только утром, с открытием доски.
 *
 * Модуль грузится только в Node-рантайме, см. instrumentation.ts.
 *
 * Сам таймер ничего не сканирует — он дёргает scanIfStale() из sync/launch.ts,
 * тот же вход, что и у /api/board: скан идёт отдельным процессом со свежим
 * кодом, с той же проверкой «уже идёт» и тем же отступом после медленного
 * скана. Поэтому старая проблема dev-режима — таймер держит модуль с момента
 * старта и крутит устаревшую логику — больше не существует, и в dev он тоже
 * безвреден. Выключен там по-прежнему только чтобы не плодить процессов,
 * пока правят код. Включить принудительно: VIARDE_AUTOSCAN=on
 */

import { CONFIG } from '@/config';
import { startWatcher } from '@/remote/watch';
import { scanIfStale } from '@/sync/launch';

/**
 * Когда данные идут из Dropbox API, главный источник сканов — не таймер, а
 * наблюдатель: он ждёт сигнала об изменении от самого Dropbox и запускает скан
 * сразу (remote/watch.ts). Работает и в dev: он ничего не сканирует в процессе
 * сервера и не держит устаревший код — скан идёт отдельным процессом.
 * Выключить: VIARDE_WATCH=off. Таймер ниже остаётся для дискового режима.
 */
if (CONFIG.source === 'api' && process.env.VIARDE_WATCH !== 'off') {
  if (startWatcher()) console.log('[tracker] наблюдатель Dropbox запущен: скан по сигналу об изменениях');
}

const isProd = process.env.NODE_ENV === 'production';
const flag = process.env.VIARDE_AUTOSCAN;
const enabled = flag === 'on' || (isProd && flag !== 'off');

if (enabled) {
  // Тик — только проверка свежести; интервал скана задаёт VIARDE_BOARD_REFRESH_MS
  const tickMs = Number(process.env.VIARDE_SCAN_TICK_MS ?? 5 * 60_000);

  const tick = () => {
    try {
      const result = scanIfStale();
      if (result === 'started') console.log('[tracker] фоновый скан запущен');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[tracker] фоновый скан не запустился:', message);
    }
  };

  tick();
  const timer = setInterval(tick, tickMs);
  // не держим процесс живым только ради таймера
  timer.unref?.();

  console.log(`[tracker] фоновый скан: проверка каждые ${Math.round(tickMs / 1000)} с`);
} else {
  console.log(
    '[tracker] фоновый таймер выключен (dev): скан запускает сама доска, ' +
      'кнопка «Сканувати» или `npm run scan`. Включить: VIARDE_AUTOSCAN=on',
  );
}
