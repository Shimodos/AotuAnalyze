/**
 * Круг правок, на котором проект сейчас.
 *
 * `round` — круг последней отгрузки, `maxRound` — самый большой из виденных.
 * Если отгрузок ещё не было, круг первый. Формула одна на разворот карточки
 * и чеклист — иначе они бы показывали разные круги.
 */
export function currentRound(round: number | null, maxRound: number | null): number {
  return Math.max(1, round ?? maxRound ?? 1);
}
