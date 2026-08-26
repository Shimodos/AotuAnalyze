'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Options {
  /** Ширина чувствительной зоны у края, px */
  zone?: number;
  /** Максимальная скорость на самом краю, px за кадр */
  maxSpeed?: number;
}

export interface EdgeScrollState {
  /** Есть ли куда прокручивать влево/вправо — по этому показываем подсказку у края */
  canLeft: boolean;
  canRight: boolean;
  /** В какую сторону крутим прямо сейчас */
  active: 'left' | 'right' | null;
}

/**
 * Горизонтальная прокрутка при подведении курсора к краю.
 *
 * Слушаем mousemove на самом контейнере, а не вешаем полосы поверх: накладка
 * у края перехватывала бы клики по крайним карточкам. Подсказки рисуются
 * отдельными элементами с pointer-events: none и ни на что не влияют.
 *
 * Скорость растёт к краю нелинейно — у границы зоны движение едва заметное,
 * у самого края быстрое, поэтому позиция управляется точно.
 */
export function useEdgeScroll<T extends HTMLElement>(options: Options = {}) {
  // 90px — меньше трети колонки: в крайнюю карточку можно спокойно целиться,
  // не запуская прокрутку. Скорость у внешней границы зоны почти нулевая.
  const { zone = 90, maxSpeed = 18 } = options;

  const ref = useRef<T | null>(null);
  const speedRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [state, setState] = useState<EdgeScrollState>({
    canLeft: false,
    canRight: false,
    active: null,
  });

  const syncBounds = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setState((prev) => {
      const canLeft = el.scrollLeft > 1;
      const canRight = el.scrollLeft < max - 1;
      if (prev.canLeft === canLeft && prev.canRight === canRight) return prev;
      return { ...prev, canLeft, canRight };
    });
  }, []);

  const stop = useCallback(() => {
    speedRef.current = 0;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setState((prev) => (prev.active === null ? prev : { ...prev, active: null }));
  }, []);

  const step = useCallback(() => {
    const el = ref.current;
    if (!el || speedRef.current === 0) {
      frameRef.current = null;
      return;
    }
    const before = el.scrollLeft;
    el.scrollLeft = before + speedRef.current;
    syncBounds();
    // упёрлись в край — прекращаем крутить вхолостую
    if (el.scrollLeft === before) {
      stop();
      return;
    }
    frameRef.current = requestAnimationFrame(step);
  }, [stop, syncBounds]);

  const onMouseMove = useCallback(
    (event: React.MouseEvent<T>) => {
      const el = ref.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const fromLeft = x;
      const fromRight = rect.width - x;

      let speed = 0;
      let active: EdgeScrollState['active'] = null;

      if (fromLeft < zone) {
        // нелинейный разгон: у границы зоны почти стоим, у края — полная скорость
        speed = -maxSpeed * Math.pow(1 - fromLeft / zone, 1.6);
        active = 'left';
      } else if (fromRight < zone) {
        speed = maxSpeed * Math.pow(1 - fromRight / zone, 1.6);
        active = 'right';
      }

      speedRef.current = speed;
      setState((prev) => (prev.active === active ? prev : { ...prev, active }));

      if (speed !== 0 && frameRef.current === null) {
        frameRef.current = requestAnimationFrame(step);
      }
      if (speed === 0) stop();
    },
    [maxSpeed, step, stop, zone],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    syncBounds();
    el.addEventListener('scroll', syncBounds, { passive: true });

    const observer = new ResizeObserver(syncBounds);
    observer.observe(el);

    return () => {
      el.removeEventListener('scroll', syncBounds);
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [syncBounds]);

  // refresh нужен снаружи: ResizeObserver следит за размером самого контейнера,
  // а scrollWidth меняется от появления карточек — это надо пересчитать вручную
  return { ref, onMouseMove, onMouseLeave: stop, refresh: syncBounds, ...state };
}
