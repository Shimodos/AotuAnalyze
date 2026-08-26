/**
 * Сравнение снапшота проекта с предыдущим сканом.
 *
 * Файловая система не хранит авторства — поэтому здесь появляется «что, где и
 * когда», но не «кто». Автор доступен только в журнале событий команды Dropbox,
 * а он требует прав администратора.
 *
 * Считаем и по счётчику, и по дате: перерендер, заменивший файлы под теми же
 * именами, счётчик не меняет, и без сравнения дат прошёл бы незаметно.
 */

import type { DeliveryRow, SceneRow } from '@/db/schema';
import type { ScannedDelivery, ScannedScene } from '@/scanner/scan';

export interface DetectedChange {
  area: 'SCENE' | 'DELIVERY';
  target: string;
  kind: string;
  params?: Record<string, string | number>;
  fileAt: Date | null;
}

const at = (d: Date | null | undefined) => (d ? d.getTime() : 0);

export function diffScenes(previous: SceneRow[], current: ScannedScene[]): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const before = new Map(previous.map((s) => [s.name, s]));

  for (const scene of current) {
    const old = before.get(scene.name);
    before.delete(scene.name);

    if (!old) {
      changes.push({
        area: 'SCENE',
        target: scene.name,
        kind: scene.imageCount === 0 && scene.exrCount > 0 ? 'change.sceneRendering' : 'change.sceneAdded',
        params: { count: scene.imageCount, exr: scene.exrCount },
        fileAt: scene.lastImageAt,
      });
      continue;
    }

    if (scene.imageCount > old.imageCount) {
      changes.push({
        area: 'SCENE',
        target: scene.name,
        kind: 'change.imagesAdded',
        params: { n: scene.imageCount - old.imageCount, total: scene.imageCount },
        fileAt: scene.lastImageAt,
      });
    } else if (scene.imageCount < old.imageCount) {
      changes.push({
        area: 'SCENE',
        target: scene.name,
        kind: 'change.imagesRemoved',
        params: { n: old.imageCount - scene.imageCount, total: scene.imageCount },
        fileAt: scene.lastImageAt,
      });
    } else if (at(scene.lastImageAt) > at(old.lastImageAt) && scene.imageCount > 0) {
      // Счётчик тот же, но файлы свежее — рендер переписали поверх старых имён
      changes.push({
        area: 'SCENE',
        target: scene.name,
        kind: 'change.imagesReplaced',
        params: { total: scene.imageCount },
        fileAt: scene.lastImageAt,
      });
    }

    // EXR считаем отдельно: он приходит с ферм сам, поэтому означает
    // «рендер идёт», а JPG переносит человек — это уже обработка.
    if (scene.exrCount > old.exrCount) {
      changes.push({
        area: 'SCENE',
        target: scene.name,
        kind: 'change.exrAdded',
        params: { n: scene.exrCount - old.exrCount, total: scene.exrCount },
        fileAt: scene.lastExrAt,
      });
    } else if (scene.exrCount < old.exrCount) {
      changes.push({
        area: 'SCENE',
        target: scene.name,
        kind: 'change.exrRemoved',
        params: { n: old.exrCount - scene.exrCount, total: scene.exrCount },
        fileAt: scene.lastExrAt,
      });
    } else if (at(scene.lastExrAt) > at(old.lastExrAt) && scene.exrCount > 0) {
      changes.push({
        area: 'SCENE',
        target: scene.name,
        kind: 'change.exrReplaced',
        params: { total: scene.exrCount },
        fileAt: scene.lastExrAt,
      });
    }

    // Постобработка — третий поток, независимый от EXR и JPG
    if (scene.psdCount > old.psdCount) {
      changes.push({ area: 'SCENE', target: scene.name, kind: 'change.psdAdded',
        params: { n: scene.psdCount - old.psdCount, total: scene.psdCount }, fileAt: scene.lastPsdAt });
    } else if (scene.psdCount < old.psdCount) {
      changes.push({ area: 'SCENE', target: scene.name, kind: 'change.psdRemoved',
        params: { n: old.psdCount - scene.psdCount, total: scene.psdCount }, fileAt: scene.lastPsdAt });
    } else if (at(scene.lastPsdAt) > at(old.lastPsdAt) && scene.psdCount > 0) {
      changes.push({ area: 'SCENE', target: scene.name, kind: 'change.psdReplaced',
        params: { total: scene.psdCount }, fileAt: scene.lastPsdAt });
    }

    // Новые нумерованные подпапки — этапы рендера
    const oldStages = new Set((old.versions ?? []).map((v) => v.name));
    const newStages = scene.versions.filter((v) => !oldStages.has(v.name));
    for (const stage of newStages) {
      changes.push({
        area: 'SCENE',
        target: scene.name,
        kind: 'change.stageAdded',
        params: { stage: stage.name, count: stage.imageCount },
        fileAt: scene.lastImageAt,
      });
    }
  }

  for (const gone of before.values()) {
    changes.push({
      area: 'SCENE',
      target: gone.name,
      kind: 'change.sceneRemoved',
      fileAt: null,
    });
  }

  return changes;
}

export function diffDeliveries(
  previous: DeliveryRow[],
  current: ScannedDelivery[],
): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const before = new Map(previous.map((d) => [d.folderName, d]));

  for (const delivery of current) {
    const old = before.get(delivery.folderName);
    before.delete(delivery.folderName);

    // Мусорные папки в журнал не тащим — они и на стадию не влияют
    if (delivery.isJunk) continue;

    if (!old) {
      changes.push({
        area: 'DELIVERY',
        target: delivery.folderName,
        kind: delivery.fileCount > 0 ? 'change.deliveryAdded' : 'change.deliveryEmpty',
        params: { count: delivery.fileCount },
        fileAt: delivery.sentAt,
      });
      continue;
    }

    // Пустая папка наполнилась — вот это и есть момент отгрузки
    if (old.fileCount === 0 && delivery.fileCount > 0) {
      changes.push({
        area: 'DELIVERY',
        target: delivery.folderName,
        kind: 'change.deliveryFilled',
        params: { count: delivery.fileCount },
        fileAt: delivery.sentAt,
      });
    } else if (delivery.fileCount > old.fileCount) {
      changes.push({
        area: 'DELIVERY',
        target: delivery.folderName,
        kind: 'change.deliveryGrew',
        params: { n: delivery.fileCount - old.fileCount, total: delivery.fileCount },
        fileAt: delivery.sentAt,
      });
    } else if (at(delivery.sentAt) > at(old.sentAt) && delivery.fileCount > 0) {
      changes.push({
        area: 'DELIVERY',
        target: delivery.folderName,
        kind: 'change.deliveryReplaced',
        params: { total: delivery.fileCount },
        fileAt: delivery.sentAt,
      });
    }
  }

  for (const gone of before.values()) {
    if (gone.isJunk) continue;
    changes.push({
      area: 'DELIVERY',
      target: gone.folderName,
      kind: 'change.deliveryRemoved',
      fileAt: null,
    });
  }

  return changes;
}
