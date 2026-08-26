/**
 * Фоновый скан. Это и есть «карточки двигаются сами»:
 * никакой очереди и вебхуков не нужно — полный проход занимает около секунды.
 *
 * Модуль грузится только в Node-рантайме, см. instrumentation.ts.
 *
 * ВАЖНО про dev. Таймер создаётся один раз при старте сервера и держит ссылку
 * на модуль, каким тот был на момент запуска. Hot reload на него не действует —
 * пересобираются только роуты, которые вызываются по запросу. В итоге после
 * любой правки логики скана фоновый тик продолжает крутить старый код и
 * затирает базу, куда CLI уже записал правильные данные.
 *
 * Поэтому в разработке автоскан выключен: там есть кнопка «Сканировать»
 * (роут /api/scan пересобирается на каждый запрос, то есть всегда свежий)
 * и `npm run scan`. Включить принудительно: VIARDE_AUTOSCAN=on
 */

import { syncOnce } from '@/sync/sync';

const isProd = process.env.NODE_ENV === 'production';
const flag = process.env.VIARDE_AUTOSCAN;
const enabled = flag === 'on' || (isProd && flag !== 'off');

if (enabled) {
  const intervalMs = Number(process.env.VIARDE_SCAN_INTERVAL_MS ?? 15 * 60_000);

  const tick = () => {
    try {
      const result = syncOnce();
      for (const t of result.transitions) {
        console.log(`[tracker] ${t.title}: ${t.from ?? '—'} → ${t.to}`);
      }
      for (const r of result.released) {
        console.log(`[tracker] ${r.title}: пин снят — пришла новая отгрузка, теперь ${r.to}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // «Скан уже идёт» — нормальная ситуация, не ошибка
      if (message !== 'Скан уже идёт') console.error('[tracker] скан не удался:', message);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  // не держим процесс живым только ради таймера
  timer.unref?.();

  console.log(`[tracker] фоновый скан каждые ${Math.round(intervalMs / 1000)} с`);
} else {
  console.log(
    '[tracker] фоновый скан выключен (dev). Кнопка «Сканировать» в UI или `npm run scan`. ' +
      'Включить: VIARDE_AUTOSCAN=on',
  );
}
