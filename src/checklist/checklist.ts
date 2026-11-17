/**
 * Чеклист правок по сцене.
 *
 * Список кадров НЕ хранится в базе — он читается с диска при каждом открытии.
 * Так он всегда совпадает с тем, что реально лежит в папке: пришёл новый
 * рендер — кадр появился, кадр переименовали — видно сразу.
 * В базе живут только отметки человека.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from '@/config';
import { isImage, isNoiseFile } from '@/scanner/parse';
import { scenePath } from '@/server/paths';

export interface ChecklistItem {
  fileName: string;
  isDone: boolean;
  note: string | null;
  updatedAt: number | null;
  /** отметка есть, а файла на диске уже нет — кадр переименовали или убрали */
  isOrphan: boolean;
  /** ссылка на превью этого кадра в веб-версии Dropbox */
  webUrl: string | null;
}

/**
 * Кадры в КОРНЕ папки сцены — ровно те же правила, что у сканера:
 * подпапки этапов (001, 002) не считаются, мелочь ниже порога отсекается.
 * Иначе чеклист и счётчик сцены расходились бы в числах.
 */
export function listSceneFrames(projectPath: string, sceneName: string): string[] {
  const dir = scenePath(projectPath, sceneName);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (isNoiseFile(e.name) || !isImage(e.name)) continue;
    try {
      if (fs.statSync(path.join(dir, e.name)).size < CONFIG.minFileSize) continue;
    } catch {
      continue;
    }
    names.push(e.name);
  }

  // Естественная сортировка: Angle2 должен идти до Angle10
  return names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
}

export interface StoredMark {
  fileName: string;
  isDone: boolean;
  note: string | null;
  updatedAt: number | null;
}

/**
 * Склейка «что на диске» и «что отметил человек».
 *
 * Порядок задаёт диск. Отметки, для которых файла больше нет, не выбрасываем,
 * а показываем в конце с пометкой: молча потерять чужую работу нельзя.
 */
export function mergeChecklist(
  frames: string[],
  marks: StoredMark[],
  webUrlFor: (fileName: string) => string | null,
): ChecklistItem[] {
  const byName = new Map(marks.map((m) => [m.fileName, m]));

  const items: ChecklistItem[] = frames.map((fileName) => {
    const mark = byName.get(fileName);
    byName.delete(fileName);
    return {
      fileName,
      isDone: mark?.isDone ?? false,
      note: mark?.note ?? null,
      updatedAt: mark?.updatedAt ?? null,
      isOrphan: false,
      webUrl: webUrlFor(fileName),
    };
  });

  for (const mark of byName.values()) {
    items.push({
      fileName: mark.fileName,
      isDone: mark.isDone,
      note: mark.note,
      updatedAt: mark.updatedAt,
      isOrphan: true,
      webUrl: null,
    });
  }

  return items;
}
